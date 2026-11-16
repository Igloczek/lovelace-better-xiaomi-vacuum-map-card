#!/usr/bin/env node
/**
 * Bootstraps the Home Assistant end-to-end instance.
 *
 * Runs the onboarding API, then uses the websocket API to register the card resource and create the
 * dashboards the Playwright specs open. Idempotent: re-running against an onboarded instance only
 * refreshes the dashboards.
 *
 * Usage: node test/e2e/setup.cjs [--reset]
 */
const fs = require("node:fs");
const path = require("node:path");

const { ARTIFACTS, ensureSession, removeToken, connectWebSocket, describeInstance } = require("./support/harness.cjs");

const CARD_ENTITIES = path.join(ARTIFACTS, "entities.json");

function card(overrides = {}) {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: process.env.E2E_VACUUM || "vacuum.demo_vacuum_0_ground_floor",
        vacuum_platform: "Xiaomi Miio",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: {
            calibration_points: [
                { map: { x: 0, y: 0 }, vacuum: { x: 0, y: 0 } },
                { map: { x: 200, y: 0 }, vacuum: { x: 2000, y: 0 } },
                { map: { x: 0, y: 150 }, vacuum: { x: 0, y: 1500 } },
            ],
        },
        map_modes: [
            {
                // A ROOM mode first so the card renders rooms from the camera metadata and the map
                // colours; this is the fork's main path and the one the room badges and hit test use.
                name: "Rooms",
                icon: "mdi:floor-plan",
                selection_type: "ROOM",
                service_call_schema: {
                    service: "vacuum.send_command",
                    service_data: { command: "app_segment_clean", params: "[[selection]]" },
                },
                predefined_selections: [
                    {
                        id: "0",
                        label: { text: "Kitchen", x: 500, y: 450 },
                        outline: [
                            [200, 200],
                            [800, 200],
                            [800, 700],
                            [200, 700],
                        ],
                    },
                    {
                        id: "1",
                        label: { text: "Living room", x: 1350, y: 450 },
                        outline: [
                            [1000, 200],
                            [1700, 200],
                            [1700, 700],
                            [1000, 700],
                        ],
                    },
                    {
                        id: "2",
                        label: { text: "Bedroom", x: 500, y: 1100 },
                        outline: [
                            [200, 900],
                            [800, 900],
                            [800, 1300],
                            [200, 1300],
                        ],
                    },
                ],
            },
            { template: "vacuum_clean_zone" },
        ],
        ...overrides,
    };
}

/**
 * The shared ROOM mode sends `send_command` without a target, which Home Assistant accepts and
 * applies to no entity. The run spec needs the call to reach the fake vacuum.
 */
function runCard() {
    const base = card({ entity: "vacuum.fake_vacuum" });
    const [rooms, ...others] = base.map_modes;
    const schema = rooms.service_call_schema;
    return {
        ...base,
        map_modes: [
            {
                ...rooms,
                service_call_schema: {
                    ...schema,
                    service_data: { ...schema.service_data, entity_id: "[[entity_id]]" },
                },
            },
            ...others,
        ],
    };
}

/**
 * A template-only ROOM mode: no `predefined_selections`, so every room and its id comes from the
 * camera metadata. The selected room has no configured id for the stale-id audit, which is the
 * empty-selection case `empty-room-selection.spec.ts` covers.
 */
function metadataRoomsCard() {
    return {
        ...card({ entity: "vacuum.fake_vacuum" }),
        map_modes: [
            {
                name: "Rooms",
                icon: "mdi:floor-plan",
                selection_type: "ROOM",
                service_call_schema: {
                    service: "vacuum.send_command",
                    service_data: {
                        entity_id: "[[entity_id]]",
                        command: "app_segment_clean",
                        params: "[[selection]]",
                    },
                },
            },
        ],
    };
}

/**
 * Two same-coloured L-shaped rooms around a hallway, served by the interlock fixture camera. The
 * metadata carries bounds only, as Xiaomi Cloud Map Extractor and Dreame publish it, so the rooms
 * are drawn and hit-tested from the colour detection (interlock-rooms.spec.ts).
 */
function interlockCard() {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.demo_vacuum_0_ground_floor",
        vacuum_platform: "Xiaomi Miio",
        map_source: { camera: "camera.interlocking_map" },
        calibration_source: {
            calibration_points: [
                { map: { x: 0, y: 0 }, vacuum: { x: 0, y: 0 } },
                { map: { x: 200, y: 0 }, vacuum: { x: 2000, y: 0 } },
                { map: { x: 0, y: 120 }, vacuum: { x: 0, y: 1200 } },
            ],
        },
        map_modes: [
            {
                // No predefined selections: the rooms come from the camera's `rooms` attribute, and
                // their shapes from the map colours.
                name: "Rooms",
                icon: "mdi:floor-plan",
                selection_type: "ROOM",
                service_call_schema: {
                    service: "vacuum.send_command",
                    service_data: { command: "app_segment_clean", params: "[[selection]]" },
                },
            },
        ],
    };
}

/**
 * A realistic floor plan (test/fixtures/apartment/): rooms sharing walls, irregular shapes, long and
 * Polish names, a room the camera does not name. Rooms come from the camera metadata and the map
 * colours, as on a real Viomi/xiaomi_miot map (apartment-rooms.spec.ts).
 */
function apartmentCard() {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.fake_vacuum",
        vacuum_platform: "Xiaomi Miio",
        map_source: { camera: "camera.apartment_map" },
        calibration_source: {
            calibration_points: [
                { map: { x: 0, y: 216 }, vacuum: { x: 0, y: 0 } },
                { map: { x: 200, y: 216 }, vacuum: { x: 10, y: 0 } },
                { map: { x: 0, y: 16 }, vacuum: { x: 0, y: 10 } },
            ],
        },
        map_modes: [
            {
                name: "Rooms",
                icon: "mdi:floor-plan",
                selection_type: "ROOM",
                max_selections: 10,
                cleaning_order: true,
                service_call_schema: {
                    service: "vacuum.send_command",
                    service_data: { entity_id: "[[entity_id]]", command: "app_segment_clean", params: "[[selection]]" },
                },
            },
        ],
    };
}

/**
 * The run card with a second preset for the same vacuum on another map, as a card with one preset
 * per floor has. The second map is the fixture image by URL, with the same room ids: multi-floor
 * Xiaomi, Roborock and Dreame vacuums number every map's segments the same way.
 */
function floorsCard() {
    const base = runCard();
    return {
        ...base,
        preset_name: "Ground floor",
        additional_presets: [
            {
                ...base,
                preset_name: "First floor",
                map_source: { image: "/api/map_fixture/image" },
            },
        ],
    };
}

/**
 * The registry spec's card: a configured tile without a label (its title is the display name Home
 * Assistant composes from the registries) next to the generated sensor tiles, whose icon comes from
 * the sensor's registry entry.
 */
function renamesCard() {
    return card({
        entity: "vacuum.fake_vacuum",
        tiles: [{ tile_id: "renamed", entity: "vacuum.fake_vacuum" }],
        append_tiles: true,
    });
}

async function main() {
    console.log(describeInstance());
    if (process.argv.includes("--reset")) {
        removeToken();
    }
    const token = await ensureSession();
    const ws = await connectWebSocket(token);

    // The card resource is registered by the Marketplace install (`marketplace-install.cjs`), so the
    // suite runs against the artifact a user actually gets. Only the older manual path registers a
    // resource here; keep that out of the way when one exists.

    // Storage dashboards used by the specs.
    const dashboards = [
        {
            url_path: "e2e-map",
            title: "E2E map",
            config: {
                title: "E2E map",
                views: [
                    {
                        title: "Map",
                        path: "map",
                        cards: [card({ map_view: { scale: 2.5, x: 40, y: -20, rotation: 90 } })],
                    },
                ],
            },
        },
        {
            // live-path.spec.ts: the robot and its path from a position entity the spec publishes
            // through the REST API (`sensor.e2e_live_position`), fed by the frontend's own updates.
            url_path: "e2e-live-path",
            title: "E2E live path",
            config: {
                title: "E2E live path",
                views: [
                    {
                        title: "Live",
                        path: "live",
                        cards: [
                            card({
                                entity: "vacuum.fake_vacuum",
                                map_modes: [{ template: "vacuum_clean_zone" }],
                                tiles: [],
                                icons: [],
                                persist_map_view: false,
                                live_path: { entity: "sensor.e2e_live_position" },
                            }),
                        ],
                    },
                ],
            },
        },
        {
            // rotated-zone.spec.ts: xiaomi_miot's turnable zone on the fake vacuum, which takes the
            // Viomi zone protocol (set_uploadmap, set_zone, set_mode) the way the robot parses it.
            url_path: "e2e-rotated-zone",
            title: "E2E rotated zone",
            config: {
                title: "E2E rotated zone",
                views: [
                    {
                        title: "Zone",
                        path: "zone",
                        cards: [
                            card({
                                entity: "vacuum.fake_vacuum",
                                vacuum_platform: "al-one/hass-xiaomi-miot",
                                map_modes: [{ template: "vacuum_clean_zone_rotatable" }],
                                tiles: [],
                                icons: [],
                                persist_map_view: false,
                            }),
                        ],
                    },
                ],
            },
        },
        {
            // The fake vacuum (map_fixture/vacuum.py) reports late, plans its own route, ignores
            // commands while returning, and can fail or go unavailable: run-lifecycle.spec.ts.
            url_path: "e2e-run",
            title: "E2E run",
            config: {
                title: "E2E run",
                views: [{ title: "Run", path: "run", cards: [runCard()] }],
            },
        },
        {
            // run-lifecycle.spec.ts: a run on one preset's map is neither shown nor locking on another.
            url_path: "e2e-run-floors",
            title: "E2E run floors",
            config: {
                title: "E2E run floors",
                views: [{ title: "Floors", path: "floors", cards: [floorsCard()] }],
            },
        },
        {
            // element-names.spec.ts: the fork's own type, the upstream type through the alias, and
            // both on one page when the upstream bundle is installed as a second resource.
            url_path: "e2e-element-names",
            title: "E2E element names",
            config: {
                title: "E2E element names",
                views: [
                    {
                        title: "New type",
                        path: "new",
                        cards: [card({ map_modes: [{ template: "vacuum_clean_zone" }] })],
                    },
                    {
                        title: "Legacy type",
                        path: "legacy",
                        cards: [
                            card({
                                type: "custom:xiaomi-vacuum-map-card",
                                map_modes: [{ template: "vacuum_clean_zone" }],
                            }),
                        ],
                    },
                    {
                        title: "Mixed",
                        path: "mixed",
                        cards: [
                            card({ map_modes: [{ template: "vacuum_clean_zone" }] }),
                            card({
                                type: "custom:xiaomi-vacuum-map-card",
                                map_modes: [{ template: "vacuum_clean_zone" }],
                            }),
                        ],
                    },
                ],
            },
        },
        {
            url_path: "e2e-stale",
            title: "E2E stale rooms",
            config: {
                title: "E2E stale rooms",
                views: [
                    { title: "Rooms", path: "rooms", cards: [card()] },
                    {
                        // A sections cell a few columns wide, as a phone-sized dashboard column:
                        // stale-rooms.spec.ts checks that the warning still names every stale id
                        // there.
                        title: "Narrow",
                        path: "narrow",
                        type: "sections",
                        sections: [{ type: "grid", cards: [card({ grid_options: { columns: 4 } })] }],
                    },
                ],
            },
        },
        {
            // apartment-rooms.spec.ts: a realistic floor plan with rooms sharing walls.
            url_path: "e2e-apartment",
            title: "E2E apartment",
            config: {
                title: "E2E apartment",
                views: [{ title: "Rooms", path: "rooms", cards: [apartmentCard()] }],
            },
        },
        {
            // interlock-rooms.spec.ts: two same-coloured L-shaped rooms with interlocking bounds.
            url_path: "e2e-interlock",
            title: "E2E interlock rooms",
            config: {
                title: "E2E interlock rooms",
                views: [{ title: "Rooms", path: "rooms", cards: [interlockCard()] }],
            },
        },
        {
            // empty-room-selection.spec.ts: a selection that would send no room ids.
            url_path: "e2e-empty-rooms",
            title: "E2E empty room selection",
            config: {
                title: "E2E empty room selection",
                views: [{ title: "Rooms", path: "rooms", cards: [metadataRoomsCard()] }],
            },
        },
        {
            url_path: "e2e-selection",
            title: "E2E selection",
            config: {
                title: "E2E selection",
                views: [
                    {
                        title: "Rooms",
                        path: "rooms",
                        cards: [
                            card({
                                map_modes: [
                                    {
                                        // Room 1 follows an input_boolean, so a change made outside
                                        // the card rebuilds the rooms while the user holds a selection.
                                        // The spec asserts the order numbers, which a custom service
                                        // call shows only with `cleaning_order: true`.
                                        name: "Rooms",
                                        icon: "mdi:floor-plan",
                                        selection_type: "ROOM",
                                        cleaning_order: true,
                                        service_call_schema: {
                                            service: "vacuum.send_command",
                                            service_data: { command: "app_segment_clean", params: "[[selection]]" },
                                        },
                                        predefined_selections: [
                                            {
                                                id: "0",
                                                label: { text: "Kitchen", x: 500, y: 450 },
                                                outline: [
                                                    [200, 200],
                                                    [800, 200],
                                                    [800, 700],
                                                    [200, 700],
                                                ],
                                            },
                                            {
                                                id: "1",
                                                label: { text: "Living room", x: 1350, y: 450 },
                                                outline: [
                                                    [1000, 200],
                                                    [1700, 200],
                                                    [1700, 700],
                                                    [1000, 700],
                                                ],
                                                state_entity: "input_boolean.e2e_clean_living_room",
                                            },
                                            {
                                                id: "2",
                                                label: { text: "Bedroom", x: 500, y: 1100 },
                                                outline: [
                                                    [200, 900],
                                                    [800, 900],
                                                    [800, 1300],
                                                    [200, 1300],
                                                ],
                                            },
                                        ],
                                    },
                                ],
                            }),
                        ],
                    },
                ],
            },
        },
        {
            url_path: "e2e-editor",
            title: "E2E editor",
            config: {
                title: "E2E editor",
                views: [
                    {
                        title: "Editor",
                        path: "editor",
                        cards: [
                            card({
                                map_modes: [
                                    {
                                        // A ROOM mode with no rooms yet: the editor's "Generate rooms
                                        // config" is the only thing that can fill it, so the test can
                                        // prove the button did the work.
                                        name: "Rooms",
                                        icon: "mdi:floor-plan",
                                        selection_type: "ROOM",
                                        service_call_schema: {
                                            service: "vacuum.send_command",
                                            service_data: { command: "app_segment_clean", params: "[[selection]]" },
                                        },
                                        predefined_selections: [],
                                    },
                                ],
                            }),
                        ],
                    },
                ],
            },
        },
        {
            // rename-registry.spec.ts: every rename and registry change happens through the websocket
            // API while this card is on screen, and the dashboard is never reloaded.
            url_path: "e2e-renames",
            title: "E2E registry renames",
            config: {
                title: "E2E registry renames",
                views: [{ title: "Renames", path: "renames", cards: [renamesCard()] }],
            },
        },
        {
            url_path: "e2e-layout",
            title: "E2E layout",
            config: {
                title: "E2E layout",
                views: [
                    {
                        title: "Sections",
                        path: "sections",
                        type: "sections",
                        sections: [
                            {
                                type: "grid",
                                cards: [
                                    card({
                                        layout: "horizontal",
                                        map_modes: [
                                            {
                                                name: "Clean selected rooms with the longest possible name",
                                                icon: "mdi:broom",
                                                selection_type: "ROOM",
                                                service_call_schema: {
                                                    service: "vacuum.send_command",
                                                    service_data: {
                                                        command: "app_segment_clean",
                                                        params: "[[selection]]",
                                                    },
                                                },
                                            },
                                            { template: "vacuum_clean_zone" },
                                        ],
                                    }),
                                ],
                            },
                        ],
                    },
                    {
                        title: "Vertical",
                        path: "vertical",
                        cards: [card()],
                    },
                ],
            },
        },
    ];

    for (const dashboard of dashboards) {
        try {
            await ws.send("lovelace/dashboards/create", {
                url_path: dashboard.url_path,
                title: dashboard.title,
                icon: "mdi:test-tube",
                show_in_sidebar: true,
                require_admin: false,
                mode: "storage",
            });
        } catch (error) {
            if (!String(error.message).includes("already_exists")) throw error;
        }
        await ws.send("lovelace/config/save", { url_path: dashboard.url_path, config: dashboard.config });
    }

    const entities = await ws.send("get_states");
    const summary = entities
        .filter(entity => /^(vacuum|camera)\./.test(entity.entity_id))
        .map(entity => ({
            entity_id: entity.entity_id,
            state: entity.state,
            attributes: Object.keys(entity.attributes),
        }));
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(CARD_ENTITIES, JSON.stringify(summary, null, 2));
    console.log(`dashboards ready: ${dashboards.map(d => d.url_path).join(", ")}`);
    console.log(`entities: ${summary.map(entity => entity.entity_id).join(", ")}`);
    ws.close();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
