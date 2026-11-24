import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_ROOM_RUN_STORE_KEY } from "../../src/const";
import { validateConfig } from "../../src/config-validators";
import { normalizeConfig } from "../../src/config-normalization";
import { MapMode } from "../../src/model/map_mode/map-mode";
import { RoomColorDetector, type RoomColorDetection } from "../../src/model/room-color-detector";
import type { MapModeConfig, RoomConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import {
    areaRegistry,
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    roomQuery,
    settle,
    useHarnessClock,
    withRegistryEntries,
} from "../harness";

/**
 * `room_label_offsets` (#126): a ROOM mode nudges a room's name pill without configuring the room.
 *
 * A room whose label point comes from the card itself - the camera's `rooms` metadata with colour
 * detection, or an area drawn from Home Assistant's area mapping - had no way to move its pill. An
 * L-shaped hallway wrapped around a kitchen puts both centroids on almost the same point, and one
 * pill hides the other. A configured `label.offset_x/offset_y` is dropped for a detected room (its
 * configured point belongs to the configured outline), and configuring an area restricts an area
 * mode to the configured areas. The new key adds a screen-pixel nudge to whatever offset the card
 * gives the label, for every room source, and moves nothing else.
 *
 * The suite missed this because no test ever asked to move a label the card placed itself: every
 * offset test configured the room in full.
 *
 * The synthetic fixture's camera rooms are Kitchen (0), Living room (1) and Bedroom (2), each a
 * distinct fill colour, so colour detection finds all three.
 */

const VACUUM = "vacuum.roborock_s7";

function segmentConfig(mode: Partial<MapModeConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [{ template: "vacuum_clean_segment", ...mode } as MapModeConfig],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

async function mount(config: XiaomiVacuumMapCardConfig, hass?: MockHass): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(config, hass ?? fixtureHass(loadSyntheticFixture()));
    await card.fireMapLoad();
    await settle(card.element);
    return card;
}

/** The screen offset the card gives a room's pill, in px, as `[x, y]`. */
function pillOffset(card: CardHandle, id: string): [string, string] {
    const pill = roomQuery(card.shadowRoot, id, ".room-pill-anchor") as SVGGElement | null;
    if (!pill) throw new Error(`room ${id} has no pill`);
    return [pill.style.getPropertyValue("--room-pill-offset-x"), pill.style.getPropertyValue("--room-pill-offset-y")];
}

/** Everything about a room's pill except its offset: its anchor point and name. */
function pillAnchor(card: CardHandle, id: string): [string, string, string] {
    const pill = roomQuery(card.shadowRoot, id, ".room-pill-anchor") as SVGGElement;
    return [
        pill.style.getPropertyValue("--room-pill-x"),
        pill.style.getPropertyValue("--room-pill-y"),
        pill.querySelector(".room-pill-name")?.textContent?.trim() ?? "",
    ];
}

/** A pill offset moved by `dx`, `dy` screen pixels. */
function shifted([x, y]: [string, string], dx: number, dy: number): [string, string] {
    return [`${parseFloat(x) + dx}px`, `${parseFloat(y) + dy}px`];
}

function roomConfig(card: CardHandle, id: string): RoomConfig {
    const room = card.element.selectableRooms.find(candidate => String(candidate.toVacuum()) === id);
    if (!room) throw new Error(`room ${id} is not selectable`);
    return (room as unknown as { _config: RoomConfig })._config;
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = roomQuery(card.shadowRoot, id, ".room-outline");
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

describe("room_label_offsets (#126)", () => {
    afterEach(() => {
        window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY);
        vi.restoreAllMocks();
    });

    it("moves a colour-detected room's pill, which a configured label offset cannot (the #126 report)", async () => {
        vi.spyOn(RoomColorDetector, "detect").mockReturnValue(detectionOfRoom1());
        // The reporter's attempt: a configured label offset. On a detected room it is dropped with
        // the configured point, as before, so the pill sits on the detected centre with no offset.
        const configuredOnly = await mount(
            segmentConfig({ predefined_selections: [{ id: 1, label: { text: "Flur", x: 0, y: 0, offset_y: -40 } }] }),
        );
        expect(configuredOnly.element.roomColorDetection?.regions.map(region => region.id)).toEqual(["1"]);
        expect(pillOffset(configuredOnly, "1")).toEqual(["0px", "0px"]);

        const card = await mount(segmentConfig({ room_label_offsets: { "1": { offset_x: -45, offset_y: -100 } } }));
        expect(pillOffset(card, "1")).toEqual(["-45px", "-100px"]);
        const plain = await mount(segmentConfig());
        expect(pillAnchor(card, "1")).toEqual(pillAnchor(plain, "1"));
        expect(pillOffset(card, "0")).toEqual(pillOffset(plain, "0"));
    });

    it("moves a detected camera room's pill in a segment mode without predefined_selections", async () => {
        const plain = await mount(segmentConfig());
        const before = { "0": pillOffset(plain, "0"), "1": pillOffset(plain, "1"), "2": pillOffset(plain, "2") };
        const anchorBefore = pillAnchor(plain, "0");

        const card = await mount(segmentConfig({ room_label_offsets: { "0": { offset_x: -45, offset_y: -100 } } }));
        expect(pillOffset(card, "0")).toEqual(shifted(before["0"], -45, -100));
        // Only the offset moves: the anchor point and the name stay, and the other rooms do not move.
        expect(pillAnchor(card, "0")).toEqual(anchorBefore);
        expect(pillOffset(card, "1")).toEqual(before["1"]);
        expect(pillOffset(card, "2")).toEqual(before["2"]);
        // The outline is the detected one, as without the key; the room is still selectable.
        expect(card.element.selectableRooms.map(room => String(room.toVacuum()))).toEqual(["0", "1", "2"]);
    });

    it("keeps the nudge on the selected (badged) pill", async () => {
        const before = pillOffset(await mount(segmentConfig()), "1");
        const card = await mount(segmentConfig({ room_label_offsets: { "1": { offset_y: 40 } } }));
        await clickRoom(card, "1");
        expect(roomQuery(card.shadowRoot, "1", ".room-pill:not(.no-badge)")).not.toBeNull();
        expect(pillOffset(card, "1")).toEqual(shifted(before, 0, 40));
    });

    it("adds the nudge to the offset under a configured icon, and leaves the icon where it is", async () => {
        const icon = { name: "mdi:silverware-fork-knife", x: 500, y: 450 };
        const outline: [number, number][] = [
            [200, 200],
            [800, 200],
            [800, 700],
            [200, 700],
        ];
        const configured = { id: 0, icon, label: { text: "Kitchen", x: 500, y: 450, offset_y: 30 }, outline };
        const plain = await mount(segmentConfig({ predefined_selections: [configured] }));
        const plainOffset = pillOffset(plain, "0");
        const plainIcon = roomConfig(plain, "0").icon;

        const card = await mount(
            segmentConfig({
                predefined_selections: [configured],
                room_label_offsets: { "0": { offset_x: 12, offset_y: -20 } },
            }),
        );
        expect(pillOffset(card, "0")).toEqual(shifted(plainOffset, 12, -20));
        expect(roomConfig(card, "0").icon).toEqual(plainIcon);
    });

    it("ignores an id the mode does not draw", async () => {
        const plain = await mount(segmentConfig());
        const before = ["0", "1", "2"].map(id => pillOffset(plain, id));
        const card = await mount(segmentConfig({ room_label_offsets: { "99": { offset_x: 30 } } }));
        expect(["0", "1", "2"].map(id => pillOffset(card, id))).toEqual(before);
        expect(card.shadowRoot.querySelector(".room-config-warning")).toBeNull();
    });

    describe("in an area mode built from the area mapping", () => {
        const AREAS = areaRegistry([
            ["flur", "Flur"],
            ["kueche", "Küche"],
            ["schlafzimmer", "Schlafzimmer"],
        ]);
        const SEGMENTS = [
            { id: "1_0", name: "Kitchen", group: "Map 1" },
            { id: "1_1", name: "Living room", group: "Map 1" },
            { id: "1_2", name: "Bedroom", group: "Map 1" },
        ];
        const hass = (): MockHass =>
            withRegistryEntries(fixtureHass(loadSyntheticFixture(), { areas: AREAS }), [
                {
                    entity_id: VACUUM,
                    unique_id: "roborock_s7",
                    device_id: "device-roborock-s7",
                    platform: "roborock",
                    name: null,
                    original_name: "Roborock S7",
                    options: {
                        vacuum: {
                            area_mapping: { kueche: ["1_0"], flur: ["1_1"], schlafzimmer: ["1_2"] },
                            last_seen_segments: SEGMENTS,
                        },
                    },
                },
            ]);
        const areaConfig = (extra: Partial<MapModeConfig> = {}): XiaomiVacuumMapCardConfig => ({
            ...fixtureConfig(loadSyntheticFixture()),
            vacuum_platform: "Roborock",
            map_modes: [
                {
                    name: "Räume",
                    icon: "mdi:broom",
                    selection_type: "ROOM",
                    max_selections: 10,
                    service_call_schema: {
                        service: "vacuum.clean_area",
                        service_data: { entity_id: "[[entity_id]]", cleaning_area_id: "[[selection]]" },
                    },
                    ...extra,
                } as MapModeConfig,
            ],
            tiles: [],
            icons: [],
            persist_map_view: false,
        });

        it("moves an area's pill without restricting the mode to configured areas", async () => {
            const plain = await mount(areaConfig(), hass());
            const before = pillOffset(plain, "flur");
            const otherBefore = pillOffset(plain, "kueche");
            const offered = plain.element.selectableRooms.map(room => String(room.toVacuum()));
            expect(offered.sort()).toEqual(["flur", "kueche", "schlafzimmer"]);

            const card = await mount(areaConfig({ room_label_offsets: { flur: { offset_y: -40 } } }), hass());
            // Every mapped area is still offered: the key configures no room.
            expect(card.element.selectableRooms.map(room => String(room.toVacuum()))).toEqual(
                plain.element.selectableRooms.map(room => String(room.toVacuum())),
            );
            expect(pillOffset(card, "flur")).toEqual(shifted(before, 0, -40));
            expect(pillOffset(card, "kueche")).toEqual(otherBefore);
        });
    });
});

describe("room_label_offsets configuration", () => {
    const withRoomMode = (extra: Record<string, unknown>): XiaomiVacuumMapCardConfig => ({
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [{ template: "vacuum_clean_segment", ...extra } as MapModeConfig],
    });

    it("accepts a mapping of room ids to numeric offsets, negative ones too", () => {
        expect(
            validateConfig(
                withRoomMode({
                    room_label_offsets: { "17": { offset_x: -45, offset_y: -100 }, hallway: { offset_y: 4.5 } },
                }),
            ),
        ).toEqual([]);
    });

    it("treats an empty key as absent", () => {
        const config = normalizeConfig(withRoomMode({ room_label_offsets: null }));
        expect(validateConfig(config)).toEqual([]);
        const entry = normalizeConfig(withRoomMode({ room_label_offsets: { "17": null, "18": { offset_x: null } } }));
        expect(validateConfig(entry)).toEqual([]);
    });

    it("reports a value that is not a number, by field", () => {
        const errors = validateConfig(withRoomMode({ room_label_offsets: { "17": { offset_y: "-40" } } })).join(" ");
        expect(errors).toContain("room_label_offsets.17.offset_y");
    });

    it("reports an entry or a whole value that is not a mapping, and an unknown key", () => {
        expect(validateConfig(withRoomMode({ room_label_offsets: [1, 2] })).join(" ")).toContain("room_label_offsets");
        expect(validateConfig(withRoomMode({ room_label_offsets: { "17": 40 } })).join(" ")).toContain(
            "room_label_offsets.17",
        );
        expect(validateConfig(withRoomMode({ room_label_offsets: { "17": { y: 40 } } })).join(" ")).toContain(
            "room_label_offsets.17.y",
        );
    });

    it("is kept in an exported mode config and left out when absent", () => {
        const offsets = { "17": { offset_x: -45 } };
        const mode = new MapMode("Roborock", { template: "vacuum_clean_segment", room_label_offsets: offsets }, "en");
        expect(mode.toMapModeConfig().room_label_offsets).toEqual(offsets);
        const bare = new MapMode("Roborock", { template: "vacuum_clean_segment" }, "en");
        expect("room_label_offsets" in bare.toMapModeConfig()).toBe(false);
    });
});

/** Colour detection that found camera room 1 (Living room) only. */
function detectionOfRoom1(): RoomColorDetection {
    const width = 200;
    const height = 150;
    const labels = new Int16Array(width * height).fill(-1);
    for (let y = 20; y < 70; y++) for (let x = 100; x < 170; x++) labels[y * width + x] = 0;
    return {
        imageData: { width, height, data: new Uint8ClampedArray(width * height * 4) },
        regions: [
            {
                id: "1",
                colorKey: 1,
                center: [135, 45],
                outline: [
                    [100, 20],
                    [170, 20],
                    [170, 70],
                    [100, 70],
                ],
            },
        ],
        roomIdByColor: new Map([[1, "1"]]),
        labels,
        labelRoomIds: ["1"],
    } as RoomColorDetection;
}
