import { describe, expect, it, vi } from "vitest";

import { addRectangle } from "../../src/card/selection";
import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle, useHarnessClock } from "../harness";

/**
 * A zone mode opens with one zone on the map.
 *
 * Upstream starts a zone mode with an empty map: nothing to drag until the user finds the `+`
 * control, and the maintainer, picking "Wybrany obszar" on his own dashboard, took that for a
 * broken mode. The card now places one zone whenever a zone selection starts fresh (opening the
 * mode, the clear action, a run with `clean_selection_on_start`); `+` adds further zones. A rebuild
 * keeps the user's zones, and a deleted zone stays deleted until the next fresh selection.
 */

const SERVICE_CALL = {
    service: "vacuum.send_command",
    service_data: { entity_id: "[[entity_id]]", command: "zone", params: "[[selection]]" },
};

function mode(selectionType: string, extra: Partial<MapModeConfig> = {}): MapModeConfig {
    return {
        name: selectionType,
        icon: "mdi:select-drag",
        selection_type: selectionType,
        repeats_type: "NONE",
        max_selections: 5,
        service_call_schema: SERVICE_CALL,
        ...extra,
    } as MapModeConfig;
}

const ZONE = mode("MANUAL_RECTANGLE");
const ROTATABLE_ZONE = mode("MANUAL_ROTATABLE_RECTANGLE");
const ROOM = mode("ROOM", { cleaning_order: true });
const POINT = mode("MANUAL_POINT");
const PATH = mode("MANUAL_PATH");

interface Internals {
    _getSelection(mode: unknown): { selection: number[][] };
    _getCurrentMode(): unknown;
    _handleLovelaceDomEvent(event: Event): Promise<void>;
    selectedManualRectangles: Array<{ toVacuum(): number[] }>;
    realScale: number;
    realImageWidth: number;
    realImageHeight: number;
}

const internals = (card: CardHandle): Internals => card.element as unknown as Internals;

function cardConfig(modes: MapModeConfig[], extra: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: modes,
        tiles: [],
        icons: [],
        persist_map_view: false,
        ...extra,
    };
}

async function mount(
    modes: MapModeConfig[],
    extra: Partial<XiaomiVacuumMapCardConfig> = {},
    loadMap = true,
): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(cardConfig(modes, extra), fixtureHass(loadSyntheticFixture()) as MockHass);
    if (loadMap) await card.fireMapLoad();
    return card;
}

function zones(card: CardHandle): number[][] {
    const element = internals(card);
    return element._getSelection(element._getCurrentMode()).selection;
}

function drawnZones(card: CardHandle): Element[] {
    return Array.from(card.shadowRoot.querySelectorAll(".manual-rectangle-wrapper"));
}

function zoneLabels(card: CardHandle): string[] {
    return Array.from(card.shadowRoot.querySelectorAll(".manual-rectangle-description text")).map(
        text => text.textContent?.trim().split(/\s+/)[0] ?? "",
    );
}

async function action(card: CardHandle, name: string, data: Record<string, unknown> = {}): Promise<void> {
    const event = new CustomEvent("ll-custom", {
        detail: { xiaomi_vacuum_map_card: { action_handler_id: "this", action: name, data } },
    });
    await internals(card)._handleLovelaceDomEvent(event);
    await settle(card.element);
}

async function deleteZone(card: CardHandle, index = 0): Promise<void> {
    card.shadowRoot
        .querySelectorAll(".manual-rectangle-delete-circle")
        [index]?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
    await settle(card.element);
}

async function run(card: CardHandle): Promise<void> {
    const button = card.shadowRoot.querySelector(".map-actions-item.main");
    if (!button) throw new Error("the card has no run button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

async function unrelatedUpdate(card: CardHandle): Promise<void> {
    const vacuum = Object.keys(card.hass.states).find(id => id.startsWith("vacuum."))!;
    const state = card.hass.states[vacuum];
    await card.updateHass({
        ...card.hass,
        states: { ...card.hass.states, [vacuum]: { ...state, attributes: { ...state.attributes, battery_level: 42 } } },
    });
    await settle(card.element);
}

describe("a zone mode opens with one zone on the map", () => {
    it.each([
        ["MANUAL_RECTANGLE", ZONE],
        ["MANUAL_ROTATABLE_RECTANGLE", ROTATABLE_ZONE],
    ])("%s: one zone is drawn inside the map before any + press", async (_name, zoneMode) => {
        const card = await mount([zoneMode]);
        expect(drawnZones(card)).toHaveLength(1);
        expect(zoneLabels(card)).toEqual(["1"]);
        const [zone] = zones(card);
        expect(zone.every(Number.isFinite)).toBe(true);

        // Drawn inside the rendered image, a third of it in size, so it is on screen and easy to grab.
        const element = internals(card);
        const mapWidth = element.realImageWidth * element.realScale;
        const mapHeight = element.realImageHeight * element.realScale;
        const points = card.shadowRoot
            .querySelector("polygon.manual-rectangle")!
            .getAttribute("points")!
            .trim()
            .split(/[\s,]+/)
            .map(Number);
        expect(points).toHaveLength(8);
        const xs = points.filter((_, i) => i % 2 === 0);
        const ys = points.filter((_, i) => i % 2 === 1);
        expect(Math.min(...xs)).toBeGreaterThan(0);
        expect(Math.max(...xs)).toBeLessThan(mapWidth);
        expect(Math.min(...ys)).toBeGreaterThan(0);
        expect(Math.max(...ys)).toBeLessThan(mapHeight);
        expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(mapWidth / 3, 0);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(mapHeight / 3, 0);
    });

    it("waits for the map image: no zone before it loads, one after", async () => {
        const card = await mount([ZONE], {}, false);
        expect(internals(card).selectedManualRectangles).toHaveLength(0);
        expect(drawnZones(card)).toHaveLength(0);
        await card.fireMapLoad();
        expect(internals(card).selectedManualRectangles).toHaveLength(1);
        expect(drawnZones(card)).toHaveLength(1);
        // A second image load (a camera refresh) does not add another one.
        await card.fireMapLoad();
        expect(drawnZones(card)).toHaveLength(1);
    });

    it("sends the default zone when the user runs straight away", async () => {
        const card = await mount([ZONE]);
        const [zone] = zones(card);
        await run(card);
        const calls = vi.mocked(card.hass.callService).mock.calls;
        expect(calls).toHaveLength(1);
        expect((calls[0][2] as Record<string, unknown>).params).toEqual([zone]);
    });

    it("+ adds further zones up to max_selections", async () => {
        const card = await mount([mode("MANUAL_RECTANGLE", { max_selections: 2 })]);
        addRectangle(card.element);
        await settle(card.element);
        expect(zoneLabels(card)).toEqual(["1", "2"]);
        addRectangle(card.element);
        await settle(card.element);
        expect(drawnZones(card)).toHaveLength(2);
    });

    it("fills a single-zone mode with its one zone, so + adds nothing", async () => {
        const card = await mount([mode("MANUAL_RECTANGLE", { max_selections: 1 })]);
        expect(drawnZones(card)).toHaveLength(1);
        addRectangle(card.element);
        await settle(card.element);
        expect(drawnZones(card)).toHaveLength(1);
    });

    it("is not placed in the other selection modes", async () => {
        for (const other of [ROOM, POINT, PATH]) {
            const card = await mount([other]);
            expect(internals(card).selectedManualRectangles, other.selection_type).toHaveLength(0);
            expect(drawnZones(card), other.selection_type).toHaveLength(0);
            await card.cleanup();
        }
    });
});

describe("the default zone and the user's own zones", () => {
    it("a deleted zone stays deleted through rebuilds and image loads", async () => {
        const config = cardConfig([ZONE]);
        const card = await mount([ZONE]);
        await deleteZone(card);
        expect(drawnZones(card)).toHaveLength(0);

        await unrelatedUpdate(card);
        await card.fireMapLoad();
        card.element.setConfig({ ...config });
        await settle(card.element, 300);
        expect(drawnZones(card)).toHaveLength(0);
        expect(zones(card)).toEqual([]);
    });

    it("keeps the user's zones through rebuilds instead of resetting them to the default", async () => {
        const config = cardConfig([ZONE]);
        const card = await mount([ZONE]);
        addRectangle(card.element);
        await settle(card.element);
        const drawn = zones(card);
        expect(drawn).toHaveLength(2);

        await unrelatedUpdate(card);
        await card.fireMapLoad();
        card.element.setConfig({ ...config });
        await settle(card.element, 300);
        expect(zones(card)).toEqual(drawn);
    });

    it("the clear action starts again from one default zone", async () => {
        const card = await mount([ZONE]);
        addRectangle(card.element);
        await deleteZone(card, 0);
        await settle(card.element);
        await action(card, "selection.clear");
        expect(drawnZones(card)).toHaveLength(1);
        expect(zoneLabels(card)).toEqual(["1"]);
    });

    it("switching modes: a zone mode gets a fresh default zone, a room mode none", async () => {
        const card = await mount([ROOM, ZONE]);
        expect(drawnZones(card)).toHaveLength(0);

        await action(card, "map_mode.set", { index: 1 });
        expect(drawnZones(card)).toHaveLength(1);
        addRectangle(card.element);
        await settle(card.element);
        expect(drawnZones(card)).toHaveLength(2);

        await action(card, "map_mode.set", { index: 0 });
        expect(internals(card).selectedManualRectangles).toHaveLength(0);
        expect(drawnZones(card)).toHaveLength(0);

        await action(card, "map_mode.set", { index: 1 });
        expect(drawnZones(card)).toHaveLength(1);
    });

    it("after a run that cleans the selection, the next run starts from one default zone", async () => {
        const card = await mount([ZONE]);
        addRectangle(card.element);
        await settle(card.element);
        await run(card);
        expect(drawnZones(card)).toHaveLength(1);
    });

    it("with clean_selection_on_start off, a run keeps the user's zones", async () => {
        const card = await mount([ZONE], { clean_selection_on_start: false });
        addRectangle(card.element);
        await settle(card.element);
        const drawn = zones(card);
        await run(card);
        expect(zones(card)).toEqual(drawn);
    });
});
