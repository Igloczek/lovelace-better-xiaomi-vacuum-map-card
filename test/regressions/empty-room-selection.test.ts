import { describe, expect, it, vi } from "vitest";
import { clearRoomSelection } from "../../src/card/selection";

import { PlatformGenerator } from "../../src/model/generators/platform-generator";
import { MapMode } from "../../src/model/map_mode/map-mode";
import { SelectionType } from "../../src/model/map_mode/selection-type";
import { setPresetIndex } from "../../src/card/presets";
import type {
    IconActionConfig,
    MapModeConfig,
    RoomConfig,
    TileConfig,
    XiaomiVacuumMapCardConfig,
} from "../../src/types/types";
import { SelectionState } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import {
    cameraEntity,
    extractorRoom,
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    loadSyntheticShiftedRoomIdsCamera,
    mountCard,
    settle,
    syntheticCalibrationPoints,
    useHarnessClock,
    withState,
} from "../harness";

/**
 * An empty ROOM selection must be reported, not look ready (ROADMAP "Known limitations"):
 * "Without colour-detected rooms, a predefined selection can look selected while the template sends
 * nothing, and the warning only covers stale configured ids."
 *
 * A room selected from the camera's `rooms` metadata has no configured id to audit, so after a
 * re-map the selection silently left `_getSelection` and the card looked ready while the run button
 * sent nothing. The card now keeps that selection on the map as an unavailable room (drawn stale,
 * named in a warning) and refuses the run with a toast instead of sending an empty room list.
 *
 * The matrix runs every platform template with a ROOM selection, because the guard lives in the
 * card, not in a template.
 */

const BEFORE = loadSyntheticFixture();
const SHIFTED = loadSyntheticShiftedRoomIdsCamera();
const VACUUM = Object.keys(BEFORE.states).find(entity => entity.startsWith("vacuum."))!;

interface RoomTemplate {
    platform: string;
    template: string;
}

const ROOM_TEMPLATES: RoomTemplate[] = PlatformGenerator.getPlatforms().flatMap(platform =>
    PlatformGenerator.getModeTemplateNames(platform)
        .filter(
            template => new MapMode(platform, { template } as MapModeConfig, "en").selectionType === SelectionType.ROOM,
        )
        .map(template => ({ platform, template })),
);

function configFor(platform: string, template: string, selections?: RoomConfig[]): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(BEFORE),
        vacuum_platform: platform,
        map_modes: [
            {
                template,
                ...(selections ? { predefined_selections: selections } : {}),
            } as unknown as MapModeConfig,
        ],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

function configuredRoom(id: string, text: string, selectedByDefault = false): RoomConfig {
    const [x0, y0, x1, y1] = id === "0" ? [200, 200, 800, 700] : [1000, 200, 1700, 700];
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

async function mountCardWith(config: XiaomiVacuumMapCardConfig, hass: MockHass): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(config, hass);
    await card.fireMapLoad();
    return card;
}

/** The card after a re-map that renumbered every segment (`0,1,2` -> `3,4,5`). */
async function shiftRoomIds(card: CardHandle, hass: MockHass): Promise<MockHass> {
    const shifted = withState(hass, SHIFTED.entity_id, {
        attributes: SHIFTED.attributes,
        last_updated: SHIFTED.last_updated,
        last_changed: SHIFTED.last_changed,
    }).hass;
    await card.updateHass(shifted);
    await settle(card.element);
    return shifted;
}

/** The card after a re-map that replaces only some ids: `0` -> `9`, while `1` keeps its id. */
async function shiftOneRoomId(card: CardHandle, hass: MockHass): Promise<MockHass> {
    const rooms = BEFORE.camera.attributes.rooms as Record<string, unknown>;
    const shifted = withState(hass, BEFORE.camera.entity_id, {
        attributes: { ...BEFORE.camera.attributes, rooms: { "1": rooms["1"], "9": rooms["0"] } },
        last_updated: SHIFTED.last_updated,
        last_changed: SHIFTED.last_changed,
    }).hass;
    await card.updateHass(shifted);
    await settle(card.element);
    return shifted;
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = card.shadowRoot.querySelector(`.room-${id}-wrapper .room-outline`);
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

async function runSelection(card: CardHandle): Promise<void> {
    const button = card.shadowRoot.querySelector(".map-actions-item.main");
    if (!button) throw new Error("the card has no run button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

function selectedIds(card: CardHandle): string[] {
    return (card.element as unknown as { selectedRooms: Array<{ toVacuum(): unknown }> }).selectedRooms.map(room =>
        String(room.toVacuum()),
    );
}

function roomElement(card: CardHandle, id: string): Element | null {
    return card.shadowRoot.querySelector(`.room-${id}-wrapper`);
}

function emptySelectionWarning(card: CardHandle): string | undefined {
    return card.shadowRoot.querySelector(".room-selection-warning")?.textContent?.trim() || undefined;
}

function staleWarning(card: CardHandle): string | undefined {
    return card.shadowRoot.querySelector(".room-config-warning")?.textContent?.trim() || undefined;
}

describe("a ROOM selection that would send no room ids", () => {
    it.each(ROOM_TEMPLATES)("is reported and refused for $platform · $template", async ({ platform, template }) => {
        const hass = fixtureHass(BEFORE);
        const card = await mountCardWith(configFor(platform, template), hass);
        const toast = vi.spyOn(card.element as unknown as { _showToast: (...a: unknown[]) => void }, "_showToast");

        await clickRoom(card, "0");
        expect(selectedIds(card)).toEqual(["0"]);
        expect(emptySelectionWarning(card)).toBeUndefined();

        const shifted = await shiftRoomIds(card, hass);

        // The room the camera no longer reports is kept on the map as unavailable: it is not
        // drawn as selected and cannot be cleaned, and the warning names its id.
        expect(roomElement(card, "0")).not.toBeNull();
        expect(roomElement(card, "0")?.classList.contains("room-stale")).toBe(true);
        expect(roomElement(card, "0")?.classList.contains("selected")).toBe(false);
        expect(emptySelectionWarning(card)).toContain("0");
        // The configured-id audit has no configured id to name here, so this warning is the
        // only report; the stale configured warning must not fire.
        expect(staleWarning(card)).toBeUndefined();
        expect(card.element._getSelection(card.element._getCurrentMode()).selection).toEqual([]);

        await runSelection(card);

        expect(vi.mocked(shifted.callService)).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith("popups.rooms_unavailable", "mdi:close", false);
    });

    it("sends nothing when every configured id went stale, and shows only the stale warning", async () => {
        useHarnessClock();
        const hass = fixtureHass(BEFORE);
        const card = await mountCardWith(
            configFor("Xiaomi Miio", "vacuum_clean_segment", [configuredRoom("0", "Kitchen", true)]),
            hass,
        );
        const toast = vi.spyOn(card.element as unknown as { _showToast: (...a: unknown[]) => void }, "_showToast");
        expect(selectedIds(card)).toEqual(["0"]);

        const shifted = await shiftRoomIds(card, hass);

        // The existing stale-id warning keeps covering a configured selection, unchanged.
        expect(staleWarning(card)).toContain("0");
        expect(emptySelectionWarning(card)).toBeUndefined();
        expect(roomElement(card, "0")?.classList.contains("room-stale")).toBe(true);
        expect(selectedIds(card)).toEqual([]);

        await runSelection(card);

        expect(vi.mocked(shifted.callService)).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith("popups.no_selection", "mdi:close", false);
    });

    it("still cleans the rooms that are available when only part of the selection went stale", async () => {
        useHarnessClock();
        const hass = fixtureHass(BEFORE);
        const card = await mountCardWith(
            configFor("Xiaomi Miio", "vacuum_clean_segment", [
                configuredRoom("1", "Living room", true),
                configuredRoom("0", "Kitchen", true),
            ]),
            hass,
        );
        const toast = vi.spyOn(card.element as unknown as { _showToast: (...a: unknown[]) => void }, "_showToast");
        expect(selectedIds(card)).toEqual(["0", "1"]);

        const shifted = await shiftOneRoomId(card, hass);

        // Room 1 survives the re-map; the run cleans it and reports nothing about an empty list.
        expect(selectedIds(card)).toEqual(["1"]);
        expect(emptySelectionWarning(card)).toBeUndefined();

        await runSelection(card);

        const calls = vi.mocked(shifted.callService).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 2)).toEqual(["xiaomi_miio", "vacuum_clean_segment"]);
        expect((calls[0][2] as unknown as { segments: unknown[] }).segments).toEqual([1]);
        expect((card.element as unknown as { runFeedback?: string }).runFeedback).toBe("success");
    });

    it("keeps the configured-room fallback when the camera reports no rooms at all", async () => {
        useHarnessClock();
        const attributes = { ...BEFORE.camera.attributes };
        delete (attributes as Record<string, unknown>).rooms;
        const hass = withState(fixtureHass(BEFORE), BEFORE.camera.entity_id, { attributes }).hass;
        const card = await mountCardWith(
            configFor("Xiaomi Miio", "vacuum_clean_segment", [configuredRoom("0", "Kitchen", true)]),
            hass,
        );

        expect(emptySelectionWarning(card)).toBeUndefined();
        expect(staleWarning(card)).toBeUndefined();
        expect(selectedIds(card)).toEqual(["0"]);

        await runSelection(card);

        const calls = vi.mocked(hass.callService).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 2)).toEqual(["xiaomi_miio", "vacuum_clean_segment"]);
        expect((calls[0][2] as unknown as { segments: unknown[] }).segments).toEqual([0]);
    });

    it("clears the warning once a live room is selected again", async () => {
        useHarnessClock();
        const hass = fixtureHass(BEFORE);
        const card = await mountCardWith(configFor("Xiaomi Miio", "vacuum_clean_segment"), hass);

        await clickRoom(card, "0");
        await shiftRoomIds(card, hass);
        expect(emptySelectionWarning(card)).toContain("0");

        await clickRoom(card, "5");
        expect(selectedIds(card)).toEqual(["5"]);
        expect(emptySelectionWarning(card)).toBeUndefined();
        // The kept room was only the report of an empty selection: once a run has a usable room,
        // its stale marker goes too instead of staying red for the life of the card.
        expect(card.shadowRoot.querySelectorAll(".room-stale")).toHaveLength(0);
        expect(roomElement(card, "0")).toBeNull();

        vi.mocked(hass.callService).mockClear();
        await runSelection(card);
        const calls = vi.mocked(hass.callService).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 2)).toEqual(["xiaomi_miio", "vacuum_clean_segment"]);
        expect((calls[0][2] as unknown as { segments: unknown[] }).segments).toEqual([5]);
    });

    it("does not treat a vacuum without a room selection as an empty room list", async () => {
        useHarnessClock();
        const hass = fixtureHass(BEFORE);
        const card = await mountCardWith(
            {
                ...fixtureConfig(BEFORE),
                map_modes: [{ template: "vacuum_clean_zone" }],
                tiles: [],
                icons: [],
                persist_map_view: false,
            },
            hass,
        );
        const toast = vi.spyOn(card.element as unknown as { _showToast: (...a: unknown[]) => void }, "_showToast");
        // The zone mode opens with a zone on the map; the user deletes it, leaving nothing selected.
        card.shadowRoot
            .querySelector(".manual-rectangle-delete-circle")
            ?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
        await settle(card.element);
        expect(card.shadowRoot.querySelectorAll(".manual-rectangle-wrapper")).toHaveLength(0);

        await runSelection(card);

        expect(emptySelectionWarning(card)).toBeUndefined();
        expect(vi.mocked(hass.callService)).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith("popups.no_selection", "mdi:close", false);
        // Keep VACUUM referenced: the fixture's vacuum is the card's entity in every case above.
        expect(VACUUM).toMatch(/^vacuum\./);
    });

    it("restores a kept room to its place when its id comes back in the next camera update", async () => {
        useHarnessClock();
        const hass = fixtureHass(BEFORE);
        const card = await mountCardWith(configFor("Xiaomi Miio", "vacuum_clean_segment"), hass);

        // Click order 1 then 0: the cleaning order is what a restore has to keep.
        await clickRoom(card, "1");
        await clickRoom(card, "0");
        expect(selectedIds(card)).toEqual(["1", "0"]);

        // One update reports only room 2, so the whole selection would send nothing.
        const rooms = BEFORE.camera.attributes.rooms as Record<string, unknown>;
        const blipped = withState(hass, BEFORE.camera.entity_id, {
            attributes: { ...BEFORE.camera.attributes, rooms: { "2": rooms["2"] } },
            last_updated: SHIFTED.last_updated,
            last_changed: SHIFTED.last_changed,
        }).hass;
        await card.updateHass(blipped);
        await settle(card.element);
        expect(selectedIds(card)).toEqual([]);
        expect(emptySelectionWarning(card)).toContain("0");
        expect(emptySelectionWarning(card)).toContain("1");

        // The next update reports them again: the kept selection comes back, in its click order,
        // instead of vanishing silently with the warning.
        const restored = withState(blipped, BEFORE.camera.entity_id, {
            attributes: BEFORE.camera.attributes,
            last_updated: BEFORE.camera.last_updated,
            last_changed: BEFORE.camera.last_changed,
        }).hass;
        await card.updateHass(restored);
        await settle(card.element);

        expect(selectedIds(card)).toEqual(["1", "0"]);
        expect(emptySelectionWarning(card)).toBeUndefined();
        expect(card.shadowRoot.querySelectorAll(".room-stale")).toHaveLength(0);
        expect(roomElement(card, "0")?.classList.contains("selected")).toBe(true);
        expect(roomElement(card, "1")?.classList.contains("selected")).toBe(true);
    });
});

/**
 * A preset switch swaps the preset, its camera and its modes synchronously but rebuilds the
 * selectable rooms after the icons and tiles have loaded. The render in between must not read the
 * old preset's rooms against the new preset's camera: that drew them all stale and warned that a
 * run would send nothing, on a map they do not belong to. If loading fails, the rebuild still has
 * to happen.
 */
const SECOND_CAMERA = "camera.vacuum_upstairs";

function upstairsRooms(): Record<string, ReturnType<typeof extractorRoom>> {
    return {
        "7": extractorRoom(200, 200, 800, 700, "Office"),
        "8": extractorRoom(1000, 200, 1700, 700, "Loft"),
        "9": extractorRoom(200, 900, 800, 1300, "Bathroom"),
    };
}

function twoPresetConfig(): XiaomiVacuumMapCardConfig {
    const base = fixtureConfig(BEFORE);
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
        rooms: upstairsRooms(),
        calibration_points: syntheticCalibrationPoints(),
    });
    return withState(fixtureHass(BEFORE), SECOND_CAMERA, {
        attributes: upstairs.attributes,
        last_updated: upstairs.last_updated,
        last_changed: upstairs.last_changed,
    }).hass;
}

function roomIds(card: CardHandle): string[] {
    return Array.from(card.shadowRoot.querySelectorAll(".room-wrapper"))
        .map(element => element.getAttribute("class") ?? "")
        .map(className => /room-([^\s]+)-wrapper/.exec(className)?.[1])
        .filter((id): id is string => id !== undefined);
}

/** A `_getIconsAndTiles` that stays pending until the test resolves it, so the gap is inspectable. */
function heldPresetLoad(): { promise: Promise<[IconActionConfig[], TileConfig[]]>; finish: () => void } {
    let finish!: () => void;
    const promise = new Promise<[IconActionConfig[], TileConfig[]]>(resolve => {
        finish = (): void => resolve([[], []]);
    });
    return { promise, finish };
}

describe("a preset switch and the rooms of the preset it leaves", () => {
    it("never reads the old preset's rooms against the new preset's camera", async () => {
        useHarnessClock();
        const card = await mountCardWith(twoPresetConfig(), twoCameraHass());
        await clickRoom(card, "0");
        expect(selectedIds(card)).toEqual(["0"]);

        const held = heldPresetLoad();
        vi.spyOn(card.element, "_getIconsAndTiles").mockReturnValue(held.promise);
        setPresetIndex(card.element, 1, true);
        // The render in the gap: the new preset's camera is shown, the old preset's rooms are gone
        // until the rebuild. Nothing may be evaluated across the two cameras.
        await card.element.updateComplete;
        expect(card.element._getCurrentPreset().map_source.camera).toBe(SECOND_CAMERA);
        expect(card.shadowRoot.querySelectorAll(".room-stale")).toHaveLength(0);
        expect(emptySelectionWarning(card)).toBeUndefined();

        held.finish();
        await settle(card.element, 200);
        expect(roomIds(card)).toEqual(["7", "8", "9"]);
        expect(selectedIds(card)).toEqual([]);
        expect(card.shadowRoot.querySelectorAll(".room-stale")).toHaveLength(0);
        expect(emptySelectionWarning(card)).toBeUndefined();
    });

    it("still builds the new preset's mode when loading its icons and tiles fails", async () => {
        useHarnessClock();
        const base = fixtureConfig(BEFORE);
        const card = await mountCard(
            {
                ...base,
                preset_name: "Downstairs",
                map_modes: [{ template: "vacuum_clean_segment" }],
                tiles: [],
                icons: [],
                persist_map_view: false,
                additional_presets: [
                    {
                        ...base,
                        preset_name: "Zones",
                        map_modes: [
                            {
                                template: "vacuum_clean_zone",
                                selection_type: "PREDEFINED_RECTANGLE",
                                predefined_selections: [{ zones: [[200, 200, 800, 700]] }],
                            } as unknown as MapModeConfig,
                        ],
                        tiles: [],
                        icons: [],
                    },
                ],
            },
            twoCameraHass(),
        );
        await card.fireMapLoad();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const toast = vi.spyOn(card.element, "_showToast");
        vi.spyOn(card.element, "_getIconsAndTiles").mockRejectedValue(new Error("generator failed"));

        setPresetIndex(card.element, 1, true);
        await settle(card.element, 300);

        // The mode the card switched to was built even though the generator failed: its zone is on
        // the map and the previous preset's rooms are gone, instead of the card staying half-switched.
        expect(card.element._getCurrentMode()?.selectionType).toBe(SelectionType.PREDEFINED_RECTANGLE);
        expect(card.shadowRoot.querySelectorAll(".predefined-rectangle-wrapper")).toHaveLength(1);
        expect(card.shadowRoot.querySelectorAll(".room-wrapper")).toHaveLength(0);
        // The missing generated controls are explained, not silently absent.
        expect(toast).toHaveBeenCalledWith("popups.generation_failed", "mdi:alert", false);
        consoleError.mockRestore();
    });

    it("never restores a room selection held for another camera", async () => {
        useHarnessClock();
        const card = await mountCardWith(twoPresetConfig(), twoCameraHass());
        // A room selection held while the old camera was unavailable names that camera's ids.
        card.element.heldSelection = { selectionType: SelectionType.ROOM, selectedKeys: ["0"], known: new Map() };
        clearRoomSelection(card.element);
        expect(card.element.heldSelection).toBeUndefined();

        // A held selection of another kind does not refer to the camera and stays.
        const zones = { selectionType: SelectionType.PREDEFINED_RECTANGLE, selectedKeys: ["z"], known: new Map() };
        card.element.heldSelection = zones;
        clearRoomSelection(card.element);
        expect(card.element.heldSelection).toBe(zones);
    });
});
