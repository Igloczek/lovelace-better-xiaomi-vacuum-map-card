import { describe, expect, it, vi } from "vitest";

import type { RoomConfig, ServiceCallSchemaConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import {
    areaRegistry,
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
 * ROOM modes whose ids are Home Assistant area ids (issue #120).
 *
 * Home Assistant's `vacuum.clean_area` takes area ids and maps them to the robot's segments itself,
 * which is how its documentation recommends targeting rooms. The fork's stale-room audit (#928, FORK.md
 * `b8-stale-room-selections`) compared every configured ROOM id with the camera's segment ids, so a
 * mode configured with `flur`, `esszimmer`, ... had every room marked stale and sent nothing whenever
 * the camera published `rooms` metadata. Upstream sends them.
 *
 * The suite missed it because every ROOM test configured camera segment ids and the mock hass had no
 * area registry at all, while a real Home Assistant always exposes `hass.areas`. The harness now has
 * one by default, and these tests cover the other namespace a ROOM id can live in.
 *
 * The synthetic camera publishes rooms `0`, `1` and `2`; the shifted camera, after a re-map, `3`, `4`
 * and `5`.
 */

const FIXTURE = loadSyntheticFixture();
const SHIFTED_CAMERA = loadSyntheticShiftedRoomIdsCamera();

/** The areas of the reporter's home that the configured rooms point at. */
const AREAS = areaRegistry([
    ["flur", "Flur"],
    ["esszimmer", "Esszimmer"],
    ["arbeitszimmer", "Arbeitszimmer"],
    ["schlafzimmer", "Schlafzimmer"],
]);

/** The reporter's service call: Home Assistant resolves each area to the robot's segment. */
const CLEAN_AREA: ServiceCallSchemaConfig = {
    service: "vacuum.clean_area",
    service_data: { entity_id: "[[entity_id]]", cleaning_area_id: "[[selection]]" },
};

/** An icon-only room at a fixed vacuum position, the way the reporter configured them. */
function areaRoom(id: string, x: number, y: number): RoomConfig {
    return { id, icon: { name: "mdi:broom", x, y } };
}

const REPORTED_ROOMS = [
    areaRoom("flur", 500, 450),
    areaRoom("esszimmer", 1350, 450),
    areaRoom("arbeitszimmer", 500, 900),
    areaRoom("schlafzimmer", 1350, 900),
];

function roomModeConfig(
    selections: RoomConfig[],
    schema: ServiceCallSchemaConfig = CLEAN_AREA,
): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(FIXTURE),
        map_modes: [
            {
                name: "Räume",
                icon: "mdi:broom",
                selection_type: "ROOM",
                max_selections: 10,
                service_call_schema: schema,
                predefined_selections: selections,
            },
        ],
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

async function mount(
    config: XiaomiVacuumMapCardConfig,
    options: { areas?: ReturnType<typeof areaRegistry>; shifted?: boolean } = {},
): Promise<{ card: CardHandle; hass: MockHass }> {
    useHarnessClock();
    let hass = fixtureHass(FIXTURE, { areas: options.areas ?? AREAS });
    if (options.shifted) {
        hass = withState(hass, SHIFTED_CAMERA.entity_id, {
            attributes: SHIFTED_CAMERA.attributes,
            last_updated: SHIFTED_CAMERA.last_updated,
            last_changed: SHIFTED_CAMERA.last_changed,
        }).hass;
    }
    const card = await mountCard(config, hass);
    await card.fireMapLoad();
    return { card, hass };
}

function roomWrapper(card: CardHandle, id: string): Element | null {
    return card.shadowRoot.querySelector(`.room-label-layer.room-${id}-wrapper`);
}

async function clickRoomIcon(card: CardHandle, id: string): Promise<void> {
    const icon = roomWrapper(card, id)?.querySelector(".map-icon-wrapper.clickable");
    if (!icon) throw new Error(`room ${id} has no clickable icon`);
    icon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

async function runSelection(card: CardHandle): Promise<void> {
    const button = card.shadowRoot.querySelector(".map-actions-item.main");
    if (!button) throw new Error("the card has no run button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

function lastCall(hass: MockHass): { domain: string; service: string; data: Record<string, unknown> } {
    const calls = vi.mocked(hass.callService).mock.calls;
    expect(calls.length, "expected a service call").toBeGreaterThan(0);
    const [domain, service, data] = calls[calls.length - 1];
    return { domain, service, data: data as Record<string, unknown> };
}

function warningText(card: CardHandle): string | undefined {
    return card.shadowRoot.querySelector(".room-config-warning")?.textContent?.trim() || undefined;
}

function selection(card: CardHandle): unknown[] {
    return card.element._getSelection(card.element._getCurrentMode()).selection;
}

describe("ROOM modes that send Home Assistant area ids (#120)", () => {
    it("sends the configured area ids through vacuum.clean_area while the camera publishes segment ids", async () => {
        const { card, hass } = await mount(roomModeConfig(REPORTED_ROOMS));

        expect(warningText(card), "area ids are not camera segment ids, so none of them is stale").toBeUndefined();
        for (const room of REPORTED_ROOMS) {
            expect(roomWrapper(card, String(room.id))?.classList.contains("room-stale")).toBe(false);
        }

        await clickRoomIcon(card, "esszimmer");
        await clickRoomIcon(card, "flur");
        expect(selection(card)).toEqual(["esszimmer", "flur"]);
        await runSelection(card);

        const call = lastCall(hass);
        expect(`${call.domain}.${call.service}`).toBe("vacuum.clean_area");
        expect(call.data.cleaning_area_id).toEqual(["esszimmer", "flur"]);
    });

    it("does not offer the camera's segment rooms, whose ids clean_area would reject", async () => {
        const { card } = await mount(roomModeConfig(REPORTED_ROOMS));

        // Selecting camera room 0 would send `cleaning_area_id: [0]`, which is no area.
        for (const segmentId of ["0", "1", "2"]) {
            expect(card.shadowRoot.querySelector(`.room-${segmentId}-wrapper`)).toBeNull();
        }
        expect(card.element.selectableRooms.map(room => String(room.toVacuum()))).toEqual([
            "flur",
            "esszimmer",
            "arbeitszimmer",
            "schlafzimmer",
        ]);
    });

    it("audits area ids against Home Assistant's areas: a deleted area is stale and never sent", async () => {
        const { card, hass } = await mount(
            roomModeConfig([...REPORTED_ROOMS, { ...areaRoom("gaestezimmer", 900, 900) }]),
        );

        expect(roomWrapper(card, "gaestezimmer")?.classList.contains("room-stale")).toBe(true);
        const warning = warningText(card);
        expect(warning).toMatch(/neither Home Assistant areas nor rooms on the camera map: gaestezimmer\./);
        for (const live of ["flur", "esszimmer", "arbeitszimmer", "schlafzimmer"]) expect(warning).not.toMatch(live);

        await clickRoomIcon(card, "flur");
        await runSelection(card);
        expect(lastCall(hass).data.cleaning_area_id).toEqual(["flur"]);
    });

    it("keeps the area ids when the camera re-numbers its segments", async () => {
        const { card, hass } = await mount(roomModeConfig(REPORTED_ROOMS), { shifted: true });

        expect(warningText(card)).toBeUndefined();
        await clickRoomIcon(card, "schlafzimmer");
        await runSelection(card);
        expect(lastCall(hass).data.cleaning_area_id).toEqual(["schlafzimmer"]);
    });

    it("decides by the id, not the service: area ids sent to a script are areas too", async () => {
        const script: ServiceCallSchemaConfig = {
            service: "script.clean_rooms",
            service_data: { areas: "[[selection]]" },
        };
        const { card, hass } = await mount(roomModeConfig(REPORTED_ROOMS, script));

        expect(warningText(card)).toBeUndefined();
        await clickRoomIcon(card, "arbeitszimmer");
        await runSelection(card);
        const call = lastCall(hass);
        expect(`${call.domain}.${call.service}`).toBe("script.clean_rooms");
        expect(call.data.areas).toEqual(["arbeitszimmer"]);
    });
});

describe("segment-id ROOM modes keep the #928 protection beside Home Assistant's areas", () => {
    /** Configured against the old map: camera ids `0`, `1`, `2`. */
    const SEGMENT_ROOMS: RoomConfig[] = [
        { id: 0, icon: { name: "mdi:broom", x: 500, y: 450 } },
        { id: 1, icon: { name: "mdi:broom", x: 1350, y: 450 } },
        { id: 2, icon: { name: "mdi:broom", x: 900, y: 900 } },
    ];
    const SEGMENT_SCHEMA: ServiceCallSchemaConfig = {
        service: "vacuum.send_command",
        service_data: { entity_id: "[[entity_id]]", command: "app_segment_clean", params: "[[selection]]" },
    };

    it("still marks every id stale when a re-map re-numbered all of them", async () => {
        // No configured id matches the camera any more, the case a "do any ids match?" rule cannot
        // tell apart from area ids. Segment ids are not areas, so the camera audit still applies.
        const { card } = await mount(roomModeConfig(SEGMENT_ROOMS, SEGMENT_SCHEMA), { shifted: true });

        const warning = warningText(card);
        expect(warning).toMatch(/no longer exist on the camera map: 0, 1, 2\./);
        expect(selection(card)).toEqual([]);
    });

    it("audits only the ids that are no area: a renumbered segment beside an area is still stale", async () => {
        const { card } = await mount(
            roomModeConfig([areaRoom("flur", 500, 450), ...SEGMENT_ROOMS.slice(0, 1)], SEGMENT_SCHEMA),
            { shifted: true },
        );
        expect(warningText(card)).toMatch(/: 0\./);
        expect(roomWrapper(card, "0")?.classList.contains("room-stale")).toBe(true);
        expect(roomWrapper(card, "flur")?.classList.contains("room-stale")).toBe(false);
    });

    it("treats an area whose id is also a segment id as an area (the accepted edge case)", async () => {
        // An area named after a number gets that number as its id. Such an id is an area, so a
        // re-map that drops segment 0 does not report it: documented in FORK.md and the docs.
        const areas = areaRegistry([["0", "0"]]);
        const { card } = await mount(roomModeConfig(SEGMENT_ROOMS, SEGMENT_SCHEMA), { areas, shifted: true });
        expect(warningText(card)).toMatch(/: 1, 2\./);
    });
});

describe("which modes count as area modes (#120 council review)", () => {
    /** The synthetic camera's rooms re-keyed by slugs, the way a Roomba+ camera names its rooms. */
    function slugCamera(hass: MockHass): MockHass {
        const camera = hass.states[FIXTURE.camera.entity_id];
        const rooms = camera.attributes.rooms as Record<string, unknown>;
        const slugs = ["living_room", "hallway", "bedroom"];
        const bySlug = Object.fromEntries(Object.values(rooms).map((room, index) => [slugs[index], room]));
        return withState(hass, FIXTURE.camera.entity_id, { attributes: { ...camera.attributes, rooms: bySlug } }).hass;
    }

    it("keeps the camera's rooms when a configured id is a camera room that is also an area (Roomba+ slugs)", async () => {
        useHarnessClock();
        const areas = areaRegistry([
            ["living_room", "Living room"],
            ["hallway", "Hallway"],
            ["bedroom", "Bedroom"],
        ]);
        const hass = slugCamera(fixtureHass(FIXTURE, { areas }));
        const schema: ServiceCallSchemaConfig = {
            service: "vacuum.send_command",
            service_data: { entity_id: "[[entity_id]]", command: "clean_room", params: "[[selection]]" },
        };
        const card = await mountCard(roomModeConfig([areaRoom("living_room", 500, 450)], schema), hass);
        await card.fireMapLoad();

        expect(card.element.selectableRooms.map(room => String(room.toVacuum())).sort()).toEqual([
            "bedroom",
            "hallway",
            "living_room",
        ]);
        expect(warningText(card)).toBeUndefined();
    });

    it("keeps a segment mode's camera rooms when an area happens to share a configured segment id", async () => {
        const SEGMENT_SCHEMA: ServiceCallSchemaConfig = {
            service: "vacuum.send_command",
            service_data: { entity_id: "[[entity_id]]", command: "app_segment_clean", params: "[[selection]]" },
        };
        const config = roomModeConfig(
            [
                { id: 0, icon: { name: "mdi:broom", x: 500, y: 450 } },
                { id: 1, icon: { name: "mdi:broom", x: 1350, y: 450 } },
            ],
            SEGMENT_SCHEMA,
        );
        const { card } = await mount(config, { areas: areaRegistry([["0", "0"]]) });
        // Camera room 2 is not configured but the camera publishes it: it stays selectable.
        expect(card.element.selectableRooms.map(room => String(room.toVacuum())).sort()).toEqual(["0", "1", "2"]);
    });

    it("names areas in the warning of a clean_area mode whose ids match no area at all", async () => {
        // Display names typed instead of area ids: no id is an area, but the service takes areas.
        const { card } = await mount(roomModeConfig([areaRoom("Flur", 500, 450)]));
        expect(warningText(card)).toMatch(/neither Home Assistant areas nor rooms on the camera map: Flur\./);
    });

    it("rebuilds the rooms when Home Assistant's areas load late or an area is deleted", async () => {
        const { card, hass } = await mount(roomModeConfig(REPORTED_ROOMS), { areas: areaRegistry([]) });
        expect(warningText(card)).toMatch(/flur/);

        await card.updateHass({ ...hass, areas: AREAS } as MockHass);
        await settle(card.element);
        expect(warningText(card)).toBeUndefined();
        expect(roomWrapper(card, "flur")?.classList.contains("room-stale")).toBe(false);

        const withoutFlur = areaRegistry([
            ["esszimmer", "Esszimmer"],
            ["arbeitszimmer", "Arbeitszimmer"],
            ["schlafzimmer", "Schlafzimmer"],
        ]);
        await card.updateHass({ ...hass, areas: withoutFlur } as MockHass);
        await settle(card.element);
        expect(warningText(card)).toMatch(/: flur\./);
        expect(roomWrapper(card, "flur")?.classList.contains("room-stale")).toBe(true);
    });

    it("selects a default_state room once Home Assistant's areas load after the camera's rooms", async () => {
        // Before the areas arrive, `flur` is stale and cannot be selected. Its default must apply
        // once it is an area, not the "not selected" it was forced into while stale.
        const config = roomModeConfig([{ ...areaRoom("flur", 500, 450), default_state: "selected" } as RoomConfig]);
        const { card, hass } = await mount(config, { areas: areaRegistry([]) });
        expect(selection(card)).toEqual([]);

        await card.updateHass({ ...hass, areas: AREAS } as MockHass);
        await settle(card.element);
        expect(selection(card)).toEqual(["flur"]);
    });
});
