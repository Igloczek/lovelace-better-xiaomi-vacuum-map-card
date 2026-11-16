import { describe, expect, it, vi } from "vitest";

import { setPresetIndex } from "../../src/card/presets";
import { SelectionType } from "../../src/model/map_mode/selection-type";
import type { IconActionConfig, TileConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import {
    cameraEntity,
    extractorRoom,
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    settle,
    syntheticCalibrationPoints,
    useHarnessClock,
    withState,
} from "../harness";

/**
 * A room selection held while one floor's camera stopped publishing rooms names that floor's ids.
 * Multi-floor maps reuse room ids, so a user switch to another floor must drop it: a rebuild while
 * the new preset's icons and tiles load must not select (and send) the other floor's room.
 */
const FIXTURE = loadSyntheticFixture();
const SECOND_CAMERA = "camera.vacuum_upstairs";

function twoPresetConfig(): XiaomiVacuumMapCardConfig {
    const base = fixtureConfig(FIXTURE);
    return {
        ...base,
        preset_name: "Downstairs",
        map_modes: [{ template: "vacuum_clean_segment" }],
        tiles: [],
        icons: [],
        persist_map_view: false,
        additional_presets: [
            {
                ...base,
                preset_name: "Upstairs",
                map_source: { camera: SECOND_CAMERA },
                calibration_source: { camera: true },
                map_modes: [{ template: "vacuum_clean_segment" }],
                tiles: [],
                icons: [],
            },
        ],
    };
}

function twoCameraHass(): MockHass {
    const upstairs = cameraEntity({
        entity_id: SECOND_CAMERA,
        rooms: {
            "0": extractorRoom(300, 300, 900, 800, "Attic"),
            "1": extractorRoom(1100, 300, 1800, 800, "Landing"),
            "2": extractorRoom(300, 1000, 900, 1400, "Guest"),
        },
        calibration_points: syntheticCalibrationPoints(),
    });
    return withState(fixtureHass(FIXTURE), SECOND_CAMERA, {
        attributes: upstairs.attributes,
        last_updated: upstairs.last_updated,
        last_changed: upstairs.last_changed,
    }).hass;
}

function selectedIds(card: CardHandle): string[] {
    return card.element.selectedRooms.map(room => String(room.toVacuum()));
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = card.shadowRoot.querySelector(`.room-${id}-wrapper .room-outline`);
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

describe("a held room selection across a preset switch", () => {
    it("does not come back on another camera that numbers its rooms the same way", async () => {
        useHarnessClock();
        const hass = twoCameraHass();
        const card = await mountCard(twoPresetConfig(), hass);
        await card.fireMapLoad();

        await clickRoom(card, "1");
        expect(selectedIds(card)).toEqual(["1"]);

        const camera = FIXTURE.camera;
        const blipped = withState(hass, camera.entity_id, {
            attributes: { ...camera.attributes, rooms: {} },
            last_updated: "2026-11-02T10:00:00.000Z",
            last_changed: "2026-11-02T10:00:00.000Z",
        }).hass;
        await card.updateHass(blipped);
        await settle(card.element);
        expect(card.element.heldSelection?.selectionType).toBe(SelectionType.ROOM);

        let finish!: () => void;
        const loading = new Promise<[IconActionConfig[], TileConfig[]]>(resolve => {
            finish = () => resolve([[], []]);
        });
        vi.spyOn(card.element, "_getIconsAndTiles").mockReturnValue(loading);
        setPresetIndex(card.element, 1, true);

        await card.fireMapLoad();
        await card.element.updateComplete;

        const during = selectedIds(card);
        const payload = card.element._getSelection(card.element._getCurrentMode()).selection;
        finish();
        await settle(card.element, 300);

        expect({ during, payload, after: selectedIds(card) }).toEqual({ during: [], payload: [], after: [] });
    });
});
