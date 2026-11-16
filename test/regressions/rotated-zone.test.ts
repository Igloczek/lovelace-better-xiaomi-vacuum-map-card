import { describe, expect, it, vi } from "vitest";

import { addRectangle } from "../../src/card/selection";
import { validateConfig } from "../../src/config-validators";
import { rotatedZoneCorners } from "../../src/model/rotated-zone";
import type { MapModeConfig, XiaomiVacuumMapCardConfig, ZoneType } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle, useHarnessClock } from "../harness";

/**
 * Rotatable zones (#49, upstream #134) in the mounted card: the rotate handle, the four-corner
 * payload, and a mode whose `service_call_schema` is a list of calls (the Viomi protocol needs three).
 */

const DEG = Math.PI / 180;

const ROTATABLE_MODE = {
    name: "Turned zone",
    icon: "mdi:rotate-right",
    selection_type: "MANUAL_ROTATABLE_RECTANGLE",
    repeats_type: "NONE",
    service_call_schema: {
        service: "vacuum.send_command",
        service_data: { entity_id: "[[entity_id]]", command: "zone", params: "[[selection]]" },
    },
} as MapModeConfig;

/** The Viomi protocol without the Jinja step: three calls in order. */
const SEQUENCE_MODE = {
    ...ROTATABLE_MODE,
    service_call_schema: [
        { service: "vacuum.send_command", service_data: { entity_id: "[[entity_id]]", command: "first", params: [1] } },
        {
            service: "vacuum.send_command",
            service_data: { entity_id: "[[entity_id]]", command: "zone", params: "[[selection]]" },
        },
        { service: "vacuum.send_command", service_data: { entity_id: "[[entity_id]]", command: "go", params: [3, 1] } },
    ],
} as MapModeConfig;

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

async function mount(modes: MapModeConfig[], extra: Partial<XiaomiVacuumMapCardConfig> = {}): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(cardConfig(modes, extra), fixtureHass(loadSyntheticFixture()) as MockHass);
    await card.fireMapLoad();
    return card;
}

function selection(card: CardHandle): number[][] {
    const element = card.element as any;
    return element._getSelection(element._getCurrentMode()).selection;
}

async function run(card: CardHandle): Promise<void> {
    const button = card.shadowRoot.querySelector(".map-actions-item.main");
    if (!button) throw new Error("the card has no run button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

describe("rotatable zones", () => {
    it("draws a rotate handle and sends four corners, turned with the zone", async () => {
        const card = await mount([ROTATABLE_MODE]);
        addRectangle(card.element as any);
        await settle(card.element);
        expect(card.shadowRoot.querySelectorAll(".manual-rectangle-rotate-circle")).toHaveLength(1);

        const [atZero] = selection(card);
        expect(atZero).toHaveLength(8);
        // At 0° the corners are the box's, in clean_zone's order: (minX, maxY) (minX, minY) ...
        const box: ZoneType = [atZero[2], atZero[3], atZero[6], atZero[7]] as ZoneType;
        expect(atZero).toEqual(rotatedZoneCorners([box[0], box[1], box[2], box[3]], 0).flat());

        const rectangle = (card.element as any).selectedManualRectangles[0];
        rectangle.setAngle(30 * DEG);
        await settle(card.element);
        const [turned] = selection(card);
        // This fixture rounds coordinates (`coordinates_rounding` defaults to on): so does each corner.
        const expected = rotatedZoneCorners(box, 30 * DEG)
            .flat()
            .map(v => Math.round(v));
        expect(turned).toEqual(expected);
        expect(card.shadowRoot.querySelector(".manual-rectangle-description text")?.textContent).toMatch(/30°/);
    });

    it("keeps the plain rectangle a four-number box without a rotate handle", async () => {
        const card = await mount([{ ...ROTATABLE_MODE, selection_type: "MANUAL_RECTANGLE" } as MapModeConfig]);
        addRectangle(card.element as any);
        await settle(card.element);
        expect(card.shadowRoot.querySelectorAll(".manual-rectangle-rotate-circle")).toHaveLength(0);
        expect(selection(card)[0]).toHaveLength(4);
        const rectangle = (card.element as any).selectedManualRectangles[0];
        rectangle.setAngle(30 * DEG);
        expect(rectangle.angle).toBe(0);
    });

    it("turns with the rotate handle", async () => {
        const card = await mount([ROTATABLE_MODE]);
        addRectangle(card.element as any);
        await settle(card.element);
        const rectangle = (card.element as any).selectedManualRectangles[0];
        // The handle is dragged a quarter turn around the zone's centre, in vacuum coordinates.
        const [, vacuum] = rectangle._corners();
        const centre = [(vacuum[0][0] + vacuum[2][0]) / 2, (vacuum[0][1] + vacuum[2][1]) / 2];
        const handle = vacuum[1];
        const quarter = [centre[0] - (handle[1] - centre[1]), centre[1] + (handle[0] - centre[0])];
        rectangle.getMousePosition = () => ({ x: 0, y: 0 });
        let next = handle;
        rectangle.scaledMapToVacuum = () => next;
        const circle = card.shadowRoot.querySelector(".manual-rectangle-rotate-circle")!;
        circle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
        next = quarter;
        circle.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, composed: true }));
        circle.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
        expect(Math.abs(rectangle.angle)).toBeCloseTo(90 * DEG, 9);
    });
});

describe("a service_call_schema list", () => {
    it("sends every call in order with the same selection", async () => {
        const card = await mount([SEQUENCE_MODE]);
        addRectangle(card.element as any);
        await settle(card.element);
        await run(card);
        const calls = vi.mocked(card.hass.callService).mock.calls.map(call => call[2] as Record<string, unknown>);
        expect(calls.map(call => call.command)).toEqual(["first", "zone", "go"]);
        expect((calls[1].params as number[][])[0]).toHaveLength(8);
        expect(calls[0].params).toEqual([1]);
        expect(calls[2].params).toEqual([3, 1]);
    });

    it("stops at the first call Home Assistant refuses", async () => {
        const card = await mount([SEQUENCE_MODE]);
        addRectangle(card.element as any);
        await settle(card.element);
        vi.mocked(card.hass.callService).mockImplementation(async (_domain, _service, data) => {
            if ((data as Record<string, unknown>).command === "zone") throw new Error("refused");
            return undefined;
        });
        await run(card);
        const commands = vi.mocked(card.hass.callService).mock.calls.map(call => (call[2] as any).command);
        expect(commands).toEqual(["first", "zone"]);
    });

    it("is valid configuration, and an empty list or a broken step is reported", () => {
        const base = cardConfig([SEQUENCE_MODE]);
        expect(validateConfig(base)).toEqual([]);
        const broken = cardConfig([{ ...SEQUENCE_MODE, service_call_schema: [{ service: "nodot" }] } as never]);
        expect(validateConfig(broken).join(" ")).toMatch(/nodot/);
        const empty = cardConfig([{ ...SEQUENCE_MODE, service_call_schema: [] } as never]);
        expect(validateConfig(empty).length).toBeGreaterThan(0);
    });
});
