import { describe, expect, it } from "vitest";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle, useHarnessClock } from "../harness";

/**
 * The card has one label style: the room pill. Predefined points and predefined rectangles use it
 * too, with a checkmark badge while selected, and `map_source.room_labels: false` hides the card's
 * own room names for a map image that already names its rooms.
 */

function config(mode: Partial<MapModeConfig>, mapSource: Record<string, unknown> = {}): XiaomiVacuumMapCardConfig {
    const base = fixtureConfig(loadSyntheticFixture());
    return {
        ...base,
        map_source: { ...base.map_source, ...mapSource },
        map_modes: [mode as MapModeConfig],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

async function mount(mode: Partial<MapModeConfig>, mapSource: Record<string, unknown> = {}): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(config(mode, mapSource), fixtureHass(loadSyntheticFixture()));
    await card.fireMapLoad();
    return card;
}

async function click(card: CardHandle, selector: string): Promise<void> {
    const target = card.shadowRoot.querySelector(selector);
    if (!target) throw new Error(`${selector} is not rendered`);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

describe("one label style", () => {
    it("draws a predefined point's label as the pill, with a checkmark while selected", async () => {
        const card = await mount({
            selection_type: "PREDEFINED_POINT",
            name: "Labels",
            icon: "mdi:broom",
            repeats_type: "NONE",
            service_call_schema: { service: "vacuum.send_command", service_data: { entity_id: "[[entity_id]]" } },
            predefined_selections: [
                {
                    position: [500, 450],
                    icon: { name: "mdi:sofa", x: 500, y: 450 },
                    label: { text: "Sofa", x: 500, y: 450, offset_y: 30 },
                },
            ],
        } as never);
        expect(card.shadowRoot.querySelectorAll("text.predefined-point-label")).toHaveLength(0);
        const pill = (): Element | null => card.shadowRoot.querySelector(".room-pill.predefined-point-label");
        expect(pill()?.classList.contains("no-badge")).toBe(true);
        expect(pill()?.querySelector(".room-pill-name")?.textContent?.trim()).toBe("Sofa");

        await click(card, ".predefined-point-icon-wrapper");
        expect(pill()?.querySelector(".room-pill-badge.room-check")).not.toBeNull();
        expect(pill()?.querySelector(".room-pill-name")?.textContent?.trim()).toBe("Sofa");
    });

    it("draws a predefined rectangle's label as the pill, with a checkmark while selected", async () => {
        const card = await mount({
            selection_type: "PREDEFINED_RECTANGLE",
            name: "Labels",
            icon: "mdi:broom",
            repeats_type: "NONE",
            service_call_schema: { service: "vacuum.send_command", service_data: { entity_id: "[[entity_id]]" } },
            predefined_selections: [
                {
                    zones: [[200, 200, 800, 700]],
                    label: { text: "Carpet", x: 500, y: 450 },
                },
            ],
        } as never);
        expect(card.shadowRoot.querySelectorAll("text.predefined-rectangle-label")).toHaveLength(0);
        const pill = (): Element | null => card.shadowRoot.querySelector(".room-pill.predefined-rectangle-label");
        expect(pill()?.classList.contains("no-badge")).toBe(true);

        await click(card, ".predefined-rectangle");
        expect(pill()?.querySelector(".room-pill-badge.room-check")).not.toBeNull();
        expect(pill()?.querySelector(".room-pill-name")?.textContent?.trim()).toBe("Carpet");
    });

    it("hides the card's room names with room_labels: false, keeping a selected room's badge", async () => {
        const card = await mount({ template: "vacuum_clean_segment", cleaning_order: true }, { room_labels: false });
        expect(card.shadowRoot.querySelectorAll(".room-pill")).toHaveLength(0);
        await click(card, ".room-2-wrapper .room-outline");
        const pills = card.shadowRoot.querySelectorAll(".room-pill");
        expect(pills).toHaveLength(1);
        expect(pills[0].querySelector(".room-pill-name")).toBeNull();
        expect(pills[0].querySelector(".room-order")?.textContent?.trim()).toBe("1");
    });
});
