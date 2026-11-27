import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_ROOM_RUN_STORE_KEY } from "../../src/const";
import { validateConfig } from "../../src/config-validators";
import { normalizeConfig } from "../../src/config-normalization";
import { MapMode } from "../../src/model/map_mode/map-mode";
import { readCameraRooms } from "../../src/model/camera-rooms";
import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
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
    withState,
} from "../harness";

/**
 * `room_names` (#133): a ROOM mode renames or hides the name of any room it draws.
 *
 * A room read from the camera's `rooms` metadata took its name only from the camera: the extracted
 * room overrode a configured `label.text`, so a room could not be renamed, and the only way to hide
 * a name was `map_source.room_labels: false`, which hides all of them. Xiaomi Cloud Map Extractor
 * names every unnamed segment `房间23` ("Room 23"), and a map with many of them is covered in
 * those pills. The new key changes only the displayed name, for every room source.
 *
 * The suite missed it because no test ever asked to change a name the camera supplies: every name
 * test configured the room in full, and a configured name only shows on a room the camera does not
 * report.
 *
 * The synthetic fixture's camera rooms are Kitchen (0), Living room (1) and Bedroom (2).
 */

const VACUUM = "vacuum.roborock_s7";

function segmentConfig(mode: Partial<MapModeConfig> = {}, extra: Partial<XiaomiVacuumMapCardConfig> = {}) {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [{ template: "vacuum_clean_segment", ...mode } as MapModeConfig],
        tiles: [],
        icons: [],
        persist_map_view: false,
        ...extra,
    } as XiaomiVacuumMapCardConfig;
}

async function mount(config: XiaomiVacuumMapCardConfig, hass?: MockHass): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(config, hass ?? fixtureHass(loadSyntheticFixture()));
    await card.fireMapLoad();
    await settle(card.element);
    return card;
}

/** The name a room's pill shows; undefined when it shows no pill or a pill without a name. */
function pillName(card: CardHandle, id: string): string | undefined {
    return roomQuery(card.shadowRoot, id, ".room-pill-name")?.textContent ?? undefined;
}

/** A room's label layer (icon, pill, badge), for comparing two renders of the same room. */
function labelLayer(card: CardHandle, id: string): string {
    const layer = [...card.shadowRoot.querySelectorAll(".room-label-layer")].find(element =>
        element.classList.contains(`room-${id}-wrapper`),
    );
    if (!layer) throw new Error(`room ${id} has no label layer`);
    return layer.outerHTML;
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = roomQuery(card.shadowRoot, id, ".room-outline");
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

const offered = (card: CardHandle): string[] => card.element.selectableRooms.map(room => String(room.toVacuum()));

/** The synthetic fixture with the camera's room names replaced. */
function hassWithCameraNames(names: Record<string, unknown>): MockHass {
    const bundle = loadSyntheticFixture();
    const rooms = bundle.camera.attributes["rooms"] as Record<string, Record<string, unknown>>;
    bundle.camera = {
        ...bundle.camera,
        attributes: {
            ...bundle.camera.attributes,
            rooms: Object.fromEntries(
                Object.entries(rooms).map(([id, room]) => [id, id in names ? { ...room, name: names[id] } : room]),
            ),
        },
    };
    return fixtureHass(bundle);
}

describe("room_names (#133)", () => {
    afterEach(() => {
        window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY);
        vi.restoreAllMocks();
    });

    it("renames a camera room, which a configured label cannot (the #133 report)", async () => {
        // The reporter's attempt: a configured label text. A camera room keeps the camera's name, as
        // before: a generated config carries old names and must not override a rename in the app.
        const configuredOnly = await mount(
            segmentConfig({ predefined_selections: [{ id: 1, label: { text: "Гостиная", x: 0, y: 0 } }] }),
        );
        expect(pillName(configuredOnly, "1")).toBe("Living room");

        const card = await mount(segmentConfig({ room_names: { "1": "Гостиная" } }));
        expect(pillName(card, "1")).toBe("Гостиная");
        expect(pillName(card, "0")).toBe("Kitchen");
        expect(pillName(card, "2")).toBe("Bedroom");
        // Only the name changes: the same rooms are offered, with the same ids and outlines.
        const plain = await mount(segmentConfig());
        expect(offered(card)).toEqual(offered(plain));
        const outline = (target: CardHandle) => roomQuery(target.shadowRoot, "1", ".room-outline")?.outerHTML;
        expect(outline(card)).toBe(outline(plain));
        expect(labelLayer(card, "1").replace("Гостиная", "Living room")).toBe(labelLayer(plain, "1"));
    });

    it("keeps the new name on the selected (badged) pill", async () => {
        const card = await mount(segmentConfig({ room_names: { "1": "Гостиная" } }));
        await clickRoom(card, "1");
        expect(roomQuery(card.shadowRoot, "1", ".room-pill:not(.no-badge)")).not.toBeNull();
        expect(pillName(card, "1")).toBe("Гостиная");
    });

    it("hides a camera room's name with false, exactly like a room shown without names", async () => {
        const card = await mount(segmentConfig({ room_names: { "1": false } }));
        expect(pillName(card, "1")).toBeUndefined();
        expect(roomQuery(card.shadowRoot, "1", ".room-pill")).toBeNull();
        expect(pillName(card, "0")).toBe("Kitchen");
        const unnamed = await mount(
            segmentConfig({}, { map_source: { ...segmentConfig().map_source!, room_labels: false } }),
        );
        expect(labelLayer(card, "1")).toBe(labelLayer(unnamed, "1"));

        // Still drawn and selectable, and sent like any room.
        expect(offered(card)).toEqual(["0", "1", "2"]);
        await clickRoom(card, "1");
        expect(card.element.selectedRooms.map(room => String(room.toVacuum()))).toEqual(["1"]);
        await clickRoom(unnamed, "1");
        expect(labelLayer(card, "1")).toBe(labelLayer(unnamed, "1"));
    });

    it("shows only the order badge on a hidden name when it is selected with cleaning_order", async () => {
        const card = await mount(segmentConfig({ cleaning_order: true, room_names: { "1": false } }));
        await clickRoom(card, "0");
        await clickRoom(card, "1");
        const badge = roomQuery(card.shadowRoot, "1", ".room-pill:not(.no-badge)");
        expect(badge).not.toBeNull();
        expect(badge?.textContent?.trim()).toBe("2");
        expect(pillName(card, "1")).toBeUndefined();
    });

    it("renames and hides a configured room's name", async () => {
        const outline: [number, number][] = [
            [200, 200],
            [800, 200],
            [800, 700],
            [200, 700],
        ];
        const configured = [
            { id: 7, label: { text: "Pantry", x: 500, y: 450 }, outline },
            { id: 8, label: { text: "Hall", x: 1300, y: 450 }, outline },
        ];
        // Without camera rooms the configured rooms are the mode's rooms.
        const bundle = loadSyntheticFixture();
        bundle.camera = { ...bundle.camera, attributes: { ...bundle.camera.attributes, rooms: undefined } };
        const card = await mount(
            segmentConfig({ predefined_selections: configured, room_names: { "7": "Кладовка", "8": false } }),
            fixtureHass(bundle),
        );
        expect(offered(card)).toEqual(["7", "8"]);
        expect(pillName(card, "7")).toBe("Кладовка");
        expect(pillName(card, "8")).toBeUndefined();
    });

    it("ignores an id the mode does not draw", async () => {
        const plain = await mount(segmentConfig());
        const card = await mount(segmentConfig({ room_names: { "99": "Nowhere", "98": false } }));
        expect(["0", "1", "2"].map(id => labelLayer(card, id))).toEqual(
            ["0", "1", "2"].map(id => labelLayer(plain, id)),
        );
        expect(offered(card)).toEqual(offered(plain));
        expect(card.shadowRoot.querySelector(".room-config-warning")).toBeNull();
    });

    it("leaves every name hidden under map_source.room_labels: false", async () => {
        const card = await mount(
            segmentConfig(
                { room_names: { "1": "Гостиная" } },
                { map_source: { ...segmentConfig().map_source!, room_labels: false } },
            ),
        );
        expect(card.shadowRoot.querySelector(".room-pill-name")).toBeNull();
    });

    describe("in an area mode built from the area mapping", () => {
        const AREAS = areaRegistry([
            ["flur", "Flur"],
            ["kueche", "Küche"],
            ["schlafzimmer", "Schlafzimmer"],
        ]);
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
                            last_seen_segments: [
                                { id: "1_0", name: "Kitchen", group: "Map 1" },
                                { id: "1_1", name: "Living room", group: "Map 1" },
                                { id: "1_2", name: "Bedroom", group: "Map 1" },
                            ],
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

        it("renames and hides areas by area id without restricting the mode to configured areas", async () => {
            const plain = await mount(areaConfig(), hass());
            expect(pillName(plain, "flur")).toBe("Flur");
            const card = await mount(areaConfig({ room_names: { flur: "Diele", kueche: false } }), hass());
            expect(offered(card)).toEqual(offered(plain));
            expect(pillName(card, "flur")).toBe("Diele");
            expect(pillName(card, "kueche")).toBeUndefined();
            expect(pillName(card, "schlafzimmer")).toBe("Schlafzimmer");
        });
    });
});

/**
 * The #133 screenshot showed a room drawn with an empty white pill. A camera name made only of
 * invisible characters (a zero-width space, a word joiner, a Hangul filler) passed the blank-name
 * check, so the pill was drawn around nothing. Such a name is no name: the camera room falls back to
 * `Room N` like a blank one, and no pill is ever drawn around invisible text.
 */
describe("a name without visible characters (#133)", () => {
    afterEach(() => vi.restoreAllMocks());

    const INVISIBLE = ["​", "⁠", " ​‌‍ ", "﻿", "ㅤ", "⠀", " "];

    it("is no name in the camera metadata", () => {
        for (const name of INVISIBLE) {
            const [room] = readCameraRooms({ "5": { x0: 0, y0: 0, x1: 10, y1: 10, name } });
            expect(room.name, JSON.stringify(name)).toBeUndefined();
        }
        const [named] = readCameraRooms({ "5": { x0: 0, y0: 0, x1: 10, y1: 10, name: "​Küche" } });
        expect(named.name).toBe("​Küche");
    });

    it("draws a camera room as Room N instead of an empty pill", async () => {
        const card = await mount(segmentConfig(), hassWithCameraNames({ "1": "​" }));
        expect(pillName(card, "1")).toBe("Room 1");
    });

    it("ignores a rename made of invisible characters instead of drawing an empty pill", async () => {
        const card = await mount(segmentConfig({ room_names: { "1": "​⁠" } }));
        expect(pillName(card, "1")).toBe("Living room");
    });
});

describe("room_names configuration", () => {
    const withRoomMode = (extra: Record<string, unknown>): XiaomiVacuumMapCardConfig => ({
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [{ template: "vacuum_clean_segment", ...extra } as MapModeConfig],
    });

    it("accepts a mapping of room ids to names or false", () => {
        expect(
            validateConfig(withRoomMode({ room_names: { "16": "Кладовка", "23": false, hallway: "Flur" } })),
        ).toEqual([]);
    });

    it('treats an empty value, null or "", as a key never written and keeps false', () => {
        expect(validateConfig(normalizeConfig(withRoomMode({ room_names: null })))).toEqual([]);
        const normalized = normalizeConfig(withRoomMode({ room_names: { "16": null, "23": "", "24": false } }));
        expect(validateConfig(normalized)).toEqual([]);
        expect((normalized.map_modes![0] as MapModeConfig).room_names).toEqual({ "24": false });
    });

    it("reports a whole value that is not a mapping and a name that is not text, by field", () => {
        expect(validateConfig(withRoomMode({ room_names: ["Kitchen"] })).join(" ")).toContain("room_names");
        // A number is a name (`16: 2`) and `false` hides; `true` means nothing and is reported.
        for (const name of [true, { text: "Kitchen" }, ["Kitchen"]]) {
            const errors = validateConfig(withRoomMode({ room_names: { "16": name } })).join(" ");
            expect(errors, JSON.stringify(name)).toContain("room_names.16");
        }
    });

    it("is kept in an exported mode config and left out when absent", () => {
        const names = { "16": "Кладовка", "23": false as const };
        const mode = new MapMode("Roborock", { template: "vacuum_clean_segment", room_names: names }, "en");
        expect(mode.toMapModeConfig().room_names).toEqual(names);
        const bare = new MapMode("Roborock", { template: "vacuum_clean_segment" }, "en");
        expect("room_names" in bare.toMapModeConfig()).toBe(false);
    });
});

/**
 * `false` in `room_names` (#133 follow-up): hiding a name is `false`, the per-room form of
 * `map_source.room_labels: false`. A blank name has no special meaning: like any empty value in the
 * card's configuration it is a key never written, so the room keeps its own name.
 */
describe("room_names: false (#133)", () => {
    afterEach(() => {
        window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY);
        vi.restoreAllMocks();
    });

    it('ignores a blank name ("", spaces) like an empty key: the room keeps its own name', async () => {
        const plain = await mount(segmentConfig());
        const card = await mount(segmentConfig({ room_names: { "1": "", "2": "   " } }));
        for (const id of ["0", "1", "2"]) expect(labelLayer(card, id)).toBe(labelLayer(plain, id));
        expect(pillName(card, "1")).toBe("Living room");
    });

    it("hides several names, each room still selectable", async () => {
        const card = await mount(segmentConfig({ room_names: { "1": false, "2": false } }));
        expect(pillName(card, "0")).toBe("Kitchen");
        expect(pillName(card, "1")).toBeUndefined();
        expect(pillName(card, "2")).toBeUndefined();
        expect(offered(card)).toEqual(["0", "1", "2"]);
        await clickRoom(card, "2");
        expect(card.element.selectedRooms.map(room => String(room.toVacuum()))).toEqual(["2"]);
    });

    it("ignores an id the mode does not draw", async () => {
        const plain = await mount(segmentConfig());
        const card = await mount(segmentConfig({ room_names: { "99": false, hallway: false } }));
        expect(["0", "1", "2"].map(id => labelLayer(card, id))).toEqual(
            ["0", "1", "2"].map(id => labelLayer(plain, id)),
        );
    });

    it("keeps renamed and hidden names on the rooms of a started run", async () => {
        const card = await mount(segmentConfig({ cleaning_order: true, room_names: { "2": "Спальня", "0": false } }));
        await clickRoom(card, "2");
        await clickRoom(card, "0");
        card.shadowRoot
            .querySelector(".map-actions-item.main")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element, 400);
        await card.updateHass(
            withState(card.hass, VACUUM, { state: "cleaning", last_changed: "2026-11-01T10:00:30.000Z" }).hass,
        );
        await settle(card.element);
        expect(card.element.selectedRooms).toHaveLength(0);
        expect(roomQuery(card.shadowRoot, "2", ".room-pill")?.textContent?.replace(/\s+/g, "")).toBe("1Спальня");
        expect(roomQuery(card.shadowRoot, "0", ".room-pill")?.textContent?.trim()).toBe("2");
        expect(pillName(card, "0")).toBeUndefined();
    });

    it("hides an area's name by area id", async () => {
        const AREAS = areaRegistry([
            ["flur", "Flur"],
            ["kueche", "Küche"],
        ]);
        const hass = withRegistryEntries(fixtureHass(loadSyntheticFixture(), { areas: AREAS }), [
            {
                entity_id: VACUUM,
                unique_id: "roborock_s7",
                device_id: "device-roborock-s7",
                platform: "roborock",
                name: null,
                original_name: "Roborock S7",
                options: {
                    vacuum: {
                        area_mapping: { kueche: ["1_0"], flur: ["1_1"] },
                        last_seen_segments: [
                            { id: "1_0", name: "Kitchen", group: "Map 1" },
                            { id: "1_1", name: "Living room", group: "Map 1" },
                        ],
                    },
                },
            },
        ]);
        const card = await mount(
            {
                ...fixtureConfig(loadSyntheticFixture()),
                vacuum_platform: "Roborock",
                map_modes: [
                    {
                        name: "Räume",
                        icon: "mdi:broom",
                        selection_type: "ROOM",
                        max_selections: 10,
                        room_names: { kueche: false },
                        service_call_schema: {
                            service: "vacuum.clean_area",
                            service_data: { entity_id: "[[entity_id]]", cleaning_area_id: "[[selection]]" },
                        },
                    } as MapModeConfig,
                ],
                tiles: [],
                icons: [],
                persist_map_view: false,
            },
            hass,
        );
        expect(offered(card).sort()).toEqual(["flur", "kueche"]);
        expect(pillName(card, "flur")).toBe("Flur");
        expect(pillName(card, "kueche")).toBeUndefined();
    });
});

/**
 * A configured room without a `label` had no name for `room_names` to replace, so a rename did
 * nothing. It now gets a label where the card would put one.
 */
describe("room_names on a room without a label (#133)", () => {
    afterEach(() => vi.restoreAllMocks());

    const outline: [number, number][] = [
        [200, 200],
        [800, 200],
        [800, 700],
        [200, 700],
    ];
    const withoutCameraRooms = (): MockHass => {
        const bundle = loadSyntheticFixture();
        bundle.camera = { ...bundle.camera, attributes: { ...bundle.camera.attributes, rooms: undefined } };
        return fixtureHass(bundle);
    };
    const roomLabel = (card: CardHandle, id: string) =>
        (
            card.element.selectableRooms.find(room => String(room.toVacuum()) === id) as unknown as {
                _config: { label?: unknown };
            }
        )._config.label;

    it("names a room under its icon, as the card places a camera room's name", async () => {
        const icon = { name: "mdi:fridge", x: 500, y: 450 };
        const card = await mount(
            segmentConfig({ predefined_selections: [{ id: 7, icon, outline }], room_names: { "7": "Кладовка" } }),
            withoutCameraRooms(),
        );
        expect(pillName(card, "7")).toBe("Кладовка");
        expect(roomLabel(card, "7")).toEqual({ text: "Кладовка", x: 500, y: 450, offset_y: 35 });
    });

    it("names a room without an icon in the middle of its outline", async () => {
        const card = await mount(
            segmentConfig({ predefined_selections: [{ id: 7, outline }], room_names: { "7": "Кладовка" } }),
            withoutCameraRooms(),
        );
        expect(pillName(card, "7")).toBe("Кладовка");
        expect(roomLabel(card, "7")).toEqual({ text: "Кладовка", x: 500, y: 450 });
    });
});

describe("room_names: false configuration", () => {
    const withRoomMode = (extra: Record<string, unknown>): XiaomiVacuumMapCardConfig => ({
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [{ template: "vacuum_clean_segment", ...extra } as MapModeConfig],
    });

    it("accepts false and a number as a name", () => {
        expect(validateConfig(withRoomMode({ room_names: { "9": false, "16": 2, hallway: "Flur" } }))).toEqual([]);
        const mode = new MapMode(
            "Roborock",
            { template: "vacuum_clean_segment", room_names: { "9": false, "16": 2, "17": "" } },
            "en",
        );
        expect(mode.roomNameOverride(9)).toBeNull();
        expect(mode.roomNameOverride(16)).toBe("2");
        expect(mode.roomNameOverride("17")).toBeUndefined();
        expect(mode.roomNameOverride(18)).toBeUndefined();
        // Zero is a name, not "no name".
        expect(
            new MapMode(
                "Roborock",
                { template: "vacuum_clean_segment", room_names: { "5": 0 } },
                "en",
            ).roomNameOverride(5),
        ).toBe("0");
    });

    it("keeps false through normalisation", () => {
        const normalized = normalizeConfig(withRoomMode({ room_names: { "9": false, "16": null } }));
        expect((normalized.map_modes![0] as MapModeConfig).room_names).toEqual({ "9": false });
    });

    it("tells how to hide when a name is true", () => {
        const errors = validateConfig(withRoomMode({ room_names: { "23": true } })).join(" ");
        expect(errors).toContain("room_names.23");
        expect(errors).toContain("false to hide");
    });

    it("keeps false in an exported mode config", () => {
        const names = { "9": false as const, "16": "Кладовка" };
        const mode = new MapMode("Roborock", { template: "vacuum_clean_segment", room_names: names }, "en");
        expect(mode.toMapModeConfig().room_names).toEqual(names);
    });
});
