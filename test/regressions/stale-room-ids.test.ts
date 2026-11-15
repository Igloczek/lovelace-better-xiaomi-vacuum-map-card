import { describe, expect, it, vi } from "vitest";
import type { CSSResult } from "lit";

import { cardStyles } from "../../src/card/styles";
import { Room } from "../../src/model/map_objects/room";
import type { RoomConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { SelectionState } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import {
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    loadSyntheticShiftedRoomIdsCamera,
    mountCard,
    settle,
    useHarnessClock,
    withState,
} from "../harness";

/**
 * Stale ROOM selections (issue #928).
 *
 * After a re-map, the camera's `rooms` metadata can carry different ids for the same physical
 * rooms (Dreame never reuses a deleted segment id). A ROOM mode whose `predefined_selections` were
 * generated against the old map must not clean by an id that no longer exists, and it must not
 * guess which new id belongs to which configured room: a rename plus an id shift would silently
 * clean the wrong room. The card warns instead, marks the stale room and keeps the id out of the
 * service call.
 */

const BEFORE_FIXTURE = loadSyntheticFixture();
const SHIFTED_CAMERA = loadSyntheticShiftedRoomIdsCamera();

/** A configured ROOM selection in vacuum coordinates, matching the synthetic fixture's geometry. */
function configuredRoom(id: string, text: string, selectedByDefault = false): RoomConfig {
    const [x0, y0, x1, y1] = id === "0" || id === "3" ? [200, 200, 800, 700] : [1000, 200, 1700, 700];
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    return {
        id,
        label: { text, x, y, offset_y: 35 },
        icon: { name: "mdi:broom", x, y },
        outline: [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
        ],
        ...(selectedByDefault ? { default_state: SelectionState.SELECTED } : {}),
    };
}

function roomsConfig(selections: RoomConfig[]): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(BEFORE_FIXTURE),
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: selections }],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

/**
 * A configured stale room larger than the fixture map (the map is 200 × 150 image px), so a
 * marker placed above its centre stays far from every outline edge and the clamp cannot move it.
 */
function hugeRoom(id: string): RoomConfig {
    return {
        id,
        label: { text: "Old hall", x: 1000, y: 1000, offset_y: 35 },
        outline: [
            [-1000, -1000],
            [3000, -1000],
            [3000, 3000],
            [-1000, 3000],
        ],
    };
}

/** A stale marker's label offset on one axis, in map units (the harness runs at a scale of 1). */
function markerStyleOffset(marker: Element, axis: "x" | "y"): number {
    const match = marker.getAttribute("style")?.match(new RegExp(`--label-offset-${axis}:\\s*(-?[\\d.]+)px`));
    expect(match, `the marker has no --label-offset-${axis}`).not.toBeNull();
    return Number(match![1]);
}

/** Mounts with the camera metadata a re-map would leave behind (`3,4,5` instead of `0,1,2`). */
async function mountAfterRemap(selections: RoomConfig[]): Promise<{ card: CardHandle; hass: MockHass }> {
    useHarnessClock();
    const hass = withState(fixtureHass(BEFORE_FIXTURE), SHIFTED_CAMERA.entity_id, {
        attributes: SHIFTED_CAMERA.attributes,
        last_updated: SHIFTED_CAMERA.last_updated,
        last_changed: SHIFTED_CAMERA.last_changed,
    }).hass;
    const card = await mountCard(roomsConfig(selections), hass);
    await card.fireMapLoad();
    return { card, hass };
}

function roomElement(card: CardHandle, id: string): Element | null {
    return card.shadowRoot.querySelector(`.room-${id}-wrapper`);
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const element = roomElement(card, id);
    if (!element) throw new Error(`room ${id} is not rendered`);
    const polygon = element.querySelector(".room-outline");
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

/** Presses the card's own run control and lets its action handler fire. */
async function runSelection(card: CardHandle): Promise<void> {
    const button = card.shadowRoot.querySelector(".map-actions-item.main");
    if (!button) throw new Error("the card has no run button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

/** The room ids the card passed to the last service call, in payload order. */
function calledSegments(hass: MockHass): unknown[] {
    const calls = vi.mocked(hass.callService).mock.calls;
    expect(calls.length, "expected at least one service call").toBeGreaterThan(0);
    const [, service, serviceData] = calls[calls.length - 1];
    expect(service).toBe("vacuum_clean_segment");
    return (serviceData as unknown as { segments: unknown[] }).segments;
}

function roomConfigWarning(card: CardHandle): string | undefined {
    return card.shadowRoot.querySelector(".room-config-warning")?.textContent?.trim() || undefined;
}

/**
 * The stale ids the warning names, parsed from its `camera map: <ids>.` sentence. A `toContain("0")`
 * would also pass on a message naming `10` or an unrelated `0` elsewhere, so the tests assert the
 * exact list instead.
 */
function warnedStaleIds(card: CardHandle): string[] | undefined {
    const warning = roomConfigWarning(card);
    if (warning === undefined) return undefined;
    const match = /no longer exist on the camera map: ([^.]+)\./.exec(warning);
    if (!match) throw new Error(`the stale-room warning does not name ids: ${warning}`);
    return match[1].split(", ");
}

describe("stale ROOM selections (#928)", () => {
    it("marks a stale room, warns with its id and never sends it", async () => {
        // The old Kitchen id (0) no longer exists; the shifted metadata calls the same room id 3.
        const { card, hass } = await mountAfterRemap([configuredRoom("0", "Kitchen", true)]);

        expect(roomElement(card, "0")?.classList.contains("room-stale")).toBe(true);
        expect(roomElement(card, "0")?.querySelector(".room-stale-marker")?.textContent?.trim()).toBe("!");
        expect(warnedStaleIds(card)).toEqual(["0"]);

        // `default_state: selected` on the stale room is ignored; the live rooms stay selectable.
        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([]);
        expect(roomElement(card, "0")?.classList.contains("selected")).toBe(false);

        await clickRoom(card, "5");
        await clickRoom(card, "4");
        await runSelection(card);

        expect(calledSegments(hass)).toEqual([5, 4]);
        expect(calledSegments(hass)).not.toContain(0);
    });

    it("keeps live rooms in click order while excluding a stale selection", async () => {
        const { card, hass } = await mountAfterRemap([
            configuredRoom("3", "Kitchen", true),
            configuredRoom("0", "Old kitchen", true),
        ]);

        // The live configured room is still selected by the configuration and clickable.
        expect(roomElement(card, "3")?.classList.contains("room-stale")).toBe(false);
        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([3]);

        await clickRoom(card, "5");
        await runSelection(card);

        expect(calledSegments(hass)).toEqual([3, 5]);
        expect(warnedStaleIds(card)).toEqual(["0"]);
    });

    it("names every stale id once, in configured order", async () => {
        const { card } = await mountAfterRemap([
            configuredRoom("3", "Kitchen"),
            configuredRoom("0", "Old kitchen"),
            configuredRoom("9", "Old office"),
        ]);

        expect(warnedStaleIds(card)).toEqual(["0", "9"]);
    });

    /**
     * Home Assistant's warning lays its slot out on one line (`white-space: nowrap` with
     * `text-overflow: ellipsis`), so a bare text node is cut after the first id in a narrow card:
     * "These configured room IDs no longer exist on th…". The message therefore has to be an
     * element of its own that the card's stylesheet makes wrap. The rendered result is proven at
     * phone width against the real frontend in `test/e2e/specs/stale-rooms.spec.ts`.
     */
    it("wraps its message in an element of its own, so a narrow card can show every id", async () => {
        const { card } = await mountAfterRemap([
            configuredRoom("3", "Kitchen"),
            configuredRoom("0", "Old kitchen"),
            configuredRoom("9", "Old office"),
        ]);

        const warning = card.shadowRoot.querySelector(".room-config-warning");
        const message = warning?.querySelector(".room-config-warning-text");
        expect(message, "the warning must not leave its text as a bare text node").not.toBeNull();
        // The sentence lives inside the wrapping element and nowhere else: a duplicated text node
        // beside it would be the one the alert clips.
        const directText = [...warning!.childNodes]
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent ?? "")
            .join("")
            .trim();
        expect(directText, "the message must not also sit beside the wrapping element").toBe("");
        expect(message!.textContent).toContain("no longer exist on the camera map");
        for (const id of ["0", "9"]) expect(message?.textContent).toContain(id);
        expect(warnedStaleIds(card)).toEqual(["0", "9"]);

        // The stylesheet is what makes the element wrap: Home Assistant's alert header is
        // `white-space: nowrap` with an ellipsis, so the message has to be a block of its own.
        const styles = String((cardStyles as CSSResult).cssText);
        expect(styles).toMatch(/\.room-config-warning \.room-config-warning-text\s*\{[^}]*display:\s*block/);
        expect(styles).toMatch(/\.room-config-warning \.room-config-warning-text\s*\{[^}]*white-space:\s*normal/);
    });

    /**
     * A selected room's pill is centred on the room's label point and is twice the label font size
     * tall, so the stale marker is lifted above that point by the pill's own half height plus the
     * marker's glyph and a gap. The marker is positioned in map coordinates (it has to respect the
     * room's outline and the map edge), so the lift reaches the DOM as the label offset.
     *
     * A large outline keeps the room's edge out of the way: the fixture map is 200 × 150 image px,
     * and this room spans 400 × 400 map px, so the clamp cannot move the marker.
     */
    it("lifts the stale marker above the label point by the label font", async () => {
        const { card } = await mountAfterRemap([hugeRoom("0")]);
        const marker = roomElement(card, "0")?.querySelector(".room-stale-marker");
        expect(marker).not.toBeNull();

        // Default 12 px label font: one label font (the pill's half height) + the marker's lower
        // half (0.55 of its 1.4-font glyph box) + the 6 px gap.
        expect(markerStyleOffset(marker!, "y")).toBeCloseTo(-(12 + 16.8 * 0.55 + 6), 1);

        // A theme font scales the clearance, and the icon wrapper size does not enter it at all.
        vi.spyOn(card.element, "_getCssProperty").mockReturnValue("40px");
        card.element.requestUpdate();
        await settle(card.element);
        const larger = roomElement(card, "0")?.querySelector(".room-stale-marker");
        expect(markerStyleOffset(larger!, "y")).toBeCloseTo(-(40 + 56 * 0.55 + 6), 1);
        expect(markerStyleOffset(larger!, "x")).toBeCloseTo(0, 5);
    });

    it("does not repeat the label transform for the stale marker", async () => {
        const { card } = await mountAfterRemap([configuredRoom("0", "Old kitchen")]);
        const marker = roomElement(card, "0")?.querySelector(".room-stale-marker");
        expect(marker).not.toBeNull();
        // It is a `.label-text`, so it takes the shared counter-rotation and offset rule...
        expect(marker!.classList.contains("label-text")).toBe(true);
        // ...and adds no transform of its own, neither inline nor in a second rule.
        expect(marker!.getAttribute("transform")).toBeNull();
        expect(marker!.getAttribute("style")).not.toMatch(/transform\s*:/);
        const blocks = [
            ...String((Room.styles as CSSResult).cssText).matchAll(/text\.room-stale-marker\s*\{([^}]*)\}/g),
        ];
        expect(blocks).toHaveLength(1);
        expect(blocks[0][1], "the shared .label-text transform must not be copied").not.toMatch(
            /(^|;|\s)transform\s*:/,
        );
    });

    it("paints a stale marker after the live rooms' pills", async () => {
        // A room too small for the marker to clear the pill keeps the marker inside the room and
        // relies on SVG paint order; stale rooms are appended last, so their markers are on top.
        const { card } = await mountAfterRemap([configuredRoom("0", "Old kitchen")]);
        const wrappers = [...card.shadowRoot.querySelectorAll(".room-wrapper")];
        const staleIndex = wrappers.indexOf(roomElement(card, "0")!);
        const liveIndexes = ["3", "4", "5"].map(id => wrappers.indexOf(roomElement(card, id)!));
        expect(staleIndex).toBeGreaterThan(Math.max(...liveIndexes));
    });

    it("does not warn when every configured id is still live", async () => {
        const { card, hass } = await mountAfterRemap([
            configuredRoom("3", "Kitchen"),
            configuredRoom("4", "Living room"),
        ]);

        expect(roomConfigWarning(card)).toBeUndefined();
        expect(roomElement(card, "3")?.classList.contains("room-stale")).toBe(false);

        await clickRoom(card, "4");
        await runSelection(card);
        expect(calledSegments(hass)).toEqual([4]);
    });

    it("does not warn or exclude when the camera exposes no rooms metadata", async () => {
        useHarnessClock();
        const attributes = { ...BEFORE_FIXTURE.camera.attributes };
        delete (attributes as Record<string, unknown>).rooms;
        const hass = withState(fixtureHass(BEFORE_FIXTURE), BEFORE_FIXTURE.camera.entity_id, {
            attributes,
        }).hass;
        const card = await mountCard(roomsConfig([configuredRoom("0", "Kitchen")]), hass);
        await card.fireMapLoad();

        // Without metadata the card keeps its documented fallback to the configured rooms, so the
        // configured id is usable and there is nothing to warn about.
        expect(roomConfigWarning(card)).toBeUndefined();
        expect(roomElement(card, "0")?.classList.contains("room-stale")).toBe(false);

        await clickRoom(card, "0");
        await runSelection(card);
        expect(calledSegments(hass)).toEqual([0]);
    });

    it("excludes a room selected before the ids shifted from the next service call", async () => {
        useHarnessClock();
        const hassBefore = fixtureHass(BEFORE_FIXTURE);
        const card = await mountCard(roomsConfig([configuredRoom("0", "Kitchen", true)]), hassBefore);
        await card.fireMapLoad();

        // Room 0 is live in the old metadata, so it is selected by the configuration and sent.
        expect(roomConfigWarning(card)).toBeUndefined();
        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([0]);

        // A re-map shifts the metadata; the card's selection has not been rebuilt yet, so the
        // stale id is still in `selectedRooms`. The payload and the warning must not trust it.
        const hassAfter = withState(hassBefore, SHIFTED_CAMERA.entity_id, {
            attributes: SHIFTED_CAMERA.attributes,
            last_updated: SHIFTED_CAMERA.last_updated,
            last_changed: SHIFTED_CAMERA.last_changed,
        }).hass;
        await card.updateHass(hassAfter);

        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([]);
        await runSelection(card);
        // No call at all is correct: the only selected room was stale, so the card reports "no
        // selection" instead of cleaning an id that now belongs to nothing (or another room).
        expect(vi.mocked(hassAfter.callService)).not.toHaveBeenCalled();
        expect(warnedStaleIds(card)).toEqual(["0"]);
    });

    it("drops a room picked from the metadata when a template-only mode's ids shift", async () => {
        useHarnessClock();
        const hassBefore = fixtureHass(BEFORE_FIXTURE);
        // A template-only mode has no `predefined_selections`, so the audit has no configured id to
        // check. Room 0 was live when it was clicked, but the id shift is only visible in the live
        // metadata: without that check the stale id survives in `selectedRooms` and is sent.
        const card = await mountCard(
            {
                ...fixtureConfig(BEFORE_FIXTURE),
                map_modes: [{ template: "vacuum_clean_segment" }],
                tiles: [],
                icons: [],
                persist_map_view: false,
            },
            hassBefore,
        );
        await card.fireMapLoad();

        await clickRoom(card, "0");
        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([0]);

        const hassAfter = withState(hassBefore, SHIFTED_CAMERA.entity_id, {
            attributes: SHIFTED_CAMERA.attributes,
            last_updated: SHIFTED_CAMERA.last_updated,
            last_changed: SHIFTED_CAMERA.last_changed,
        }).hass;
        await card.updateHass(hassAfter);

        // The rooms were never rebuilt for this camera: without colour detection (there is no
        // canvas in happy-dom) only `_getSelection`'s live-metadata guard can catch the shift, and
        // the configured-id audit has no entry to compare.
        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([]);
        await card.fireMapLoad();
        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([]);

        await runSelection(card);
        expect(vi.mocked(hassAfter.callService)).not.toHaveBeenCalled();
    });
});
