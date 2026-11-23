import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomConfig, ServiceCallSchemaConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { handleRoomColorClick } from "../../src/card/rooms";
import { RoomColorDetector, type RoomColorDetection } from "../../src/model/room-color-detector";
import type { CardHandle, MockHass } from "../harness";
import {
    areaRegistry,
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    settle,
    useHarnessClock,
    withRegistryEntries,
    withState,
} from "../harness";

/**
 * Areas drawn from Home Assistant's area mapping (issue #120, option 5).
 *
 * #121 made a ROOM mode whose ids are Home Assistant areas work again, but drew those rooms as the
 * hand-placed icons of the configuration: the camera's rooms are keyed by segment ids, and nothing
 * told the card which segment an area covers. Home Assistant knows: `vacuum.clean_area` resolves
 * areas through the vacuum's registry options (`options.vacuum.area_mapping`). The card now reads
 * them and, for an integration whose segment ids it can join to the camera's room ids, draws each
 * area with its rooms' outlines and lets a tap on a room select its area.
 *
 * The synthetic camera publishes rooms `0`, `1` and `2`. The vacuum is core Roborock, whose segment
 * ids carry the map flag (`1_0` is room `0` on map 1), exactly as in the #120 report (`0_16` → 16).
 *
 * The suite missed this because its mock registry entries had no `options` at all, while a real
 * Home Assistant returns them from `config/entity_registry/get`.
 */

const FIXTURE = loadSyntheticFixture();
const VACUUM = "vacuum.roborock_s7";

const AREAS = areaRegistry([
    ["flur", "Flur"],
    ["esszimmer", "Esszimmer"],
    ["arbeitszimmer", "Arbeitszimmer"],
    ["wohnbereich", "Wohnbereich"],
    ["terrasse", "Terrasse"],
]);

const CLEAN_AREA: ServiceCallSchemaConfig = {
    service: "vacuum.clean_area",
    service_data: { entity_id: "[[entity_id]]", cleaning_area_id: "[[selection]]" },
};

const SEGMENTS = [
    { id: "1_0", name: "Kitchen", group: "Map 1" },
    { id: "1_1", name: "Living room", group: "Map 1" },
    { id: "1_2", name: "Bedroom", group: "Map 1" },
];

const MAPPING = { flur: ["1_0"], esszimmer: ["1_1"], arbeitszimmer: ["1_2"] };

function areaRoom(id: string, x: number, y: number): RoomConfig {
    return { id, icon: { name: "mdi:broom", x, y } };
}

const CONFIGURED = [areaRoom("flur", 300, 300), areaRoom("esszimmer", 1100, 300), areaRoom("arbeitszimmer", 300, 1000)];

function config(selections: RoomConfig[] | undefined, schema: ServiceCallSchemaConfig = CLEAN_AREA) {
    return {
        ...fixtureConfig(FIXTURE),
        vacuum_platform: "Roborock",
        map_modes: [
            {
                name: "Räume",
                icon: "mdi:broom",
                selection_type: "ROOM",
                max_selections: 10,
                service_call_schema: schema,
                ...(selections ? { predefined_selections: selections } : {}),
            },
        ],
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

/** The vacuum's registry entry with the integration and the options Home Assistant keeps. */
function vacuumEntry(platform: string, mapping: Record<string, string[]> | undefined) {
    return {
        entity_id: VACUUM,
        unique_id: "roborock_s7",
        device_id: "device-roborock-s7",
        platform,
        name: null,
        original_name: "Roborock S7",
        options: mapping ? { vacuum: { area_mapping: mapping, last_seen_segments: SEGMENTS } } : {},
    };
}

function hassWith(platform = "roborock", mapping: Record<string, string[]> | undefined = MAPPING): MockHass {
    return withRegistryEntries(fixtureHass(FIXTURE, { areas: AREAS }), [vacuumEntry(platform, mapping)]);
}

async function mount(cardConfig: XiaomiVacuumMapCardConfig, hass: MockHass = hassWith()): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(cardConfig, hass);
    await card.fireMapLoad();
    await settle(card.element);
    return card;
}

/** The outline polygons drawn for one room, as their points in scaled map pixels. */
function polygons(card: CardHandle, id: string): string[] {
    return [...card.shadowRoot.querySelectorAll(`.room-wrapper.room-${id}-wrapper polygon`)].map(
        polygon => polygon.getAttribute("points") ?? "",
    );
}

/** A camera room's bounding box as the card draws it (1 image pixel = 10 vacuum units, scale 1). */
const BOX = {
    "0": "20, 20 80, 20 80, 70 20, 70",
    "1": "100, 20 170, 20 170, 70 100, 70",
    "2": "20, 90 80, 90 80, 130 20, 130",
};

async function clickPolygon(card: CardHandle, id: string, index = 0): Promise<void> {
    const polygon = card.shadowRoot.querySelectorAll(`.room-wrapper.room-${id}-wrapper polygon.clickable`)[index];
    if (!polygon) throw new Error(`room ${id} has no clickable outline ${index}`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

function selection(card: CardHandle): unknown[] {
    return card.element._getSelection(card.element._getCurrentMode()).selection;
}

function selectableIds(card: CardHandle): string[] {
    return card.element.selectableRooms.map(room => String(room.toVacuum()));
}

function pillText(card: CardHandle, id: string): string | undefined {
    return card.shadowRoot.querySelector(`.room-label-layer.room-${id}-wrapper .room-pill`)?.textContent?.trim();
}

function warnings(card: CardHandle): string[] {
    return [...card.shadowRoot.querySelectorAll(".room-config-warning")].map(
        warning => warning.textContent?.trim() ?? "",
    );
}

async function runSelection(card: CardHandle): Promise<void> {
    const button = card.shadowRoot.querySelector(".map-actions-item.main");
    if (!button) throw new Error("the card has no run button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

function lastAreaCall(hass: MockHass): unknown {
    const calls = vi.mocked(hass.callService).mock.calls;
    expect(calls.length, "expected a service call").toBeGreaterThan(0);
    const [domain, service, data] = calls[calls.length - 1];
    expect(`${domain}.${service}`).toBe("vacuum.clean_area");
    return (data as Record<string, unknown>).cleaning_area_id;
}

describe("areas drawn from Home Assistant's area mapping (#120)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("draws each configured area with its mapped room's outline and the area's name", async () => {
        const card = await mount(config(CONFIGURED));

        expect(polygons(card, "flur")).toEqual([BOX["0"]]);
        expect(polygons(card, "esszimmer")).toEqual([BOX["1"]]);
        expect(polygons(card, "arbeitszimmer")).toEqual([BOX["2"]]);
        expect(pillText(card, "esszimmer")).toBe("Esszimmer");
        // The segment rooms themselves are never offered: their ids are no areas.
        expect(selectableIds(card)).toEqual(["flur", "esszimmer", "arbeitszimmer"]);
    });

    it("selects the area with a tap on its outline and sends the area id", async () => {
        const card = await mount(config(CONFIGURED));

        await clickPolygon(card, "esszimmer");
        await clickPolygon(card, "flur");
        expect(selection(card)).toEqual(["esszimmer", "flur"]);
        await runSelection(card);
        expect(lastAreaCall(card.hass)).toEqual(["esszimmer", "flur"]);
    });

    it("draws every room of an area that spans several, and a tap on any selects the whole area", async () => {
        const mapping = { flur: ["1_0"], wohnbereich: ["1_1", "1_2"] };
        const card = await mount(
            config([areaRoom("flur", 300, 300), areaRoom("wohnbereich", 1100, 300)]),
            hassWith("roborock", mapping),
        );

        expect(polygons(card, "wohnbereich")).toEqual([BOX["1"], BOX["2"]]);
        await clickPolygon(card, "wohnbereich", 1);
        expect(selection(card)).toEqual(["wohnbereich"]);
        const group = card.shadowRoot.querySelector(".room-wrapper.room-wohnbereich-wrapper");
        expect(group?.classList.contains("selected"), "both outlines are drawn selected").toBe(true);
        await runSelection(card);
        expect(lastAreaCall(card.hass)).toEqual(["wohnbereich"]);
    });

    it("resolves a tap through the colour detection to the area that owns the room", async () => {
        vi.spyOn(RoomColorDetector, "detect").mockReturnValue(detectionOfRoom1());
        const card = await mount(config(CONFIGURED));
        card.element.realScale = 1;

        vi.spyOn(card.element, "_getMousePosition").mockReturnValue({ x: 130.5, y: 40.5 } as never);
        handleRoomColorClick(card.element, new MouseEvent("click"));
        expect(selection(card)).toEqual(["esszimmer"]);
        // Room 0 was not detected: its metadata outline is the target, for the area that owns it.
        vi.spyOn(card.element, "_getMousePosition").mockReturnValue({ x: 50.5, y: 40.5 } as never);
        handleRoomColorClick(card.element, new MouseEvent("click"));
        expect(selection(card)).toEqual(["esszimmer", "flur"]);
    });

    it("leaves a segment that is in no area unselectable", async () => {
        vi.spyOn(RoomColorDetector, "detect").mockReturnValue(detectionOfRoom1());
        const card = await mount(config(CONFIGURED.slice(0, 2)), hassWith("roborock", { flur: ["1_0"] }));
        card.element.realScale = 1;

        // Room 1 is mapped to no area; room 2's area is not in this mode.
        for (const point of [
            { x: 130.5, y: 40.5 },
            { x: 50.5, y: 110.5 },
        ]) {
            vi.spyOn(card.element, "_getMousePosition").mockReturnValue(point as never);
            handleRoomColorClick(card.element, new MouseEvent("click"));
        }
        expect(selection(card)).toEqual([]);
        expect(polygons(card, "esszimmer"), "an unmapped area keeps its icon only").toEqual([""]);
    });

    it("keeps #121's icons for an integration without a confirmed join", async () => {
        const card = await mount(config(CONFIGURED), hassWith("ecovacs"));

        expect(polygons(card, "flur")).toEqual([""]);
        expect(selectableIds(card)).toEqual(["flur", "esszimmer", "arbeitszimmer"]);
        expect(card.shadowRoot.querySelector(".room-label-layer.room-flur-wrapper .map-icon-wrapper")).not.toBeNull();
    });

    it("keeps a room's configured outline over the mapping", async () => {
        const own: RoomConfig = {
            ...areaRoom("flur", 300, 300),
            outline: [
                [300, 300],
                [500, 300],
                [500, 500],
            ],
        };
        const card = await mount(config([own, ...CONFIGURED.slice(1)]));

        expect(polygons(card, "flur")).toEqual(["30, 30 50, 30 50, 50"]);
        expect(polygons(card, "esszimmer")).toEqual([BOX["1"]]);
    });

    it("builds the rooms from the mapping when a clean_area mode lists none", async () => {
        const card = await mount(config(undefined));

        expect(selectableIds(card)).toEqual(["flur", "esszimmer", "arbeitszimmer"]);
        expect(polygons(card, "arbeitszimmer")).toEqual([BOX["2"]]);
        expect(pillText(card, "flur")).toBe("Flur");
        expect(card.shadowRoot.querySelector(".room-0-wrapper"), "never the camera's segment rooms").toBeNull();
        await clickPolygon(card, "arbeitszimmer");
        await runSelection(card);
        expect(lastAreaCall(card.hass)).toEqual(["arbeitszimmer"]);
    });

    it("warns before a run that Home Assistant has no segments for a selected area, and still sends it", async () => {
        const card = await mount(config([...CONFIGURED, areaRoom("terrasse", 1300, 1000)]));

        expect(warnings(card)).toEqual([]);
        await clickIcon(card, "terrasse");
        await clickPolygon(card, "flur");
        expect(warnings(card).join(" ")).toMatch(/no segments mapped .*: terrasse\./i);
        await runSelection(card);
        // Home Assistant cleans the mapped area and reports the other; the card does not decide.
        expect(lastAreaCall(card.hass)).toEqual(["terrasse", "flur"]);
    });

    it("reads the mapping again when Home Assistant reports a change of the vacuum's registry entry", async () => {
        // Re-mapping areas changes only the entry's options. The real frontend keeps `hass.entities`
        // for that (the e2e suite showed it), so the card listens to `entity_registry_updated`, which
        // Home Assistant lets every user subscribe to.
        const hass = hassWith();
        const unsubscribe = vi.fn();
        const subscribeEvents = vi.fn(async () => unsubscribe);
        hass.connection = { ...hass.connection, subscribeEvents } as never;
        const card = await mount(config(CONFIGURED), hass);
        expect(polygons(card, "flur")).toEqual([BOX["0"]]);

        const call = subscribeEvents.mock.calls.find(args => (args as unknown[])[1] === "entity_registry_updated");
        expect(call, "the card subscribes to registry updates").toBeDefined();
        const entities = card.element.hass.entities;
        card.hass.setWSHandler("config/entity_registry/get", () =>
            vacuumEntry("roborock", { flur: ["1_2"], esszimmer: ["1_1"], arbeitszimmer: ["1_0"] }),
        );
        (call as unknown as [(event: unknown) => void])[0]({
            data: { action: "update", entity_id: "vacuum.other", changes: { options: {} } },
        });
        await settle(card.element);
        expect(polygons(card, "flur"), "another entity's update reads nothing").toEqual([BOX["0"]]);

        (call as unknown as [(event: unknown) => void])[0]({
            data: { action: "update", entity_id: VACUUM, changes: { options: {} } },
        });
        await settle(card.element);
        expect(card.element.hass.entities).toBe(entities);
        expect(polygons(card, "flur")).toEqual([BOX["2"]]);

        await card.cleanup();
        expect(unsubscribe, "a detached card ends the subscription").toHaveBeenCalled();
    });

    it("reads the mapping again when the frontend replaces the entity registry", async () => {
        const card = await mount(config(CONFIGURED));
        expect(polygons(card, "flur")).toEqual([BOX["0"]]);

        // Any entity registry change (a rename, a new entity) gives the frontend a new
        // `hass.entities`; the vacuum's entry may have changed with it.
        const remapped = withRegistryEntries(card.hass, [
            vacuumEntry("roborock", { flur: ["1_2"], esszimmer: ["1_1"], arbeitszimmer: ["1_0"] }),
        ]);
        await card.updateHass(remapped);
        await settle(card.element);
        expect(polygons(card, "flur")).toEqual([BOX["2"]]);
        expect(polygons(card, "arbeitszimmer")).toEqual([BOX["0"]]);
    });

    it("does not fetch the registry entry for a mode that does not clean areas", async () => {
        const segmentSchema: ServiceCallSchemaConfig = {
            service: "vacuum.send_command",
            service_data: { entity_id: "[[entity_id]]", command: "app_segment_clean", params: "[[selection]]" },
        };
        const hass = hassWith();
        const card = await mount(config([{ id: 0, icon: { name: "mdi:broom", x: 300, y: 300 } }], segmentSchema), hass);
        expect(card.element.areaMapping, "no area mapping is read for it").toBeUndefined();
        expect(selectableIds(card)).toContain("0");
    });

    it("draws a room only when its floor is certain", async () => {
        // Map 2 numbers its rooms from the same start; nothing says which floor the camera shows.
        const segments = [...SEGMENTS, { id: "2_1", name: "Upstairs", group: "Map 2" }];
        const hass = withRegistryEntries(fixtureHass(FIXTURE, { areas: AREAS }), [
            {
                ...vacuumEntry("roborock", MAPPING),
                options: { vacuum: { area_mapping: MAPPING, last_seen_segments: segments } },
            },
        ]);
        const card = await mount(config(CONFIGURED), hass);
        expect(polygons(card, "esszimmer"), "room 1 is on two floors").toEqual([""]);
        expect(polygons(card, "flur")).toEqual([BOX["0"]]);

        // Roborock's current-map select names the floor.
        const withSelect = withState(
            withRegistryEntries(card.hass, [
                {
                    entity_id: "select.roborock_s7_selected_map",
                    device_id: "device-roborock-s7",
                    platform: "roborock",
                    translation_key: "selected_map",
                },
            ]),
            "select.roborock_s7_selected_map",
            { state: "Map 1" },
        ).hass;
        await card.updateHass(withSelect);
        await settle(card.element);
        expect(polygons(card, "esszimmer")).toEqual([BOX["1"]]);
    });
});

async function clickIcon(card: CardHandle, id: string): Promise<void> {
    const icon = card.shadowRoot.querySelector(`.room-label-layer.room-${id}-wrapper .map-icon-wrapper.clickable`);
    if (!icon) throw new Error(`room ${id} has no clickable icon`);
    icon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

/** Room 1 (image 100..170 x 20..70) is detected; nothing else is. */
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
    };
}
