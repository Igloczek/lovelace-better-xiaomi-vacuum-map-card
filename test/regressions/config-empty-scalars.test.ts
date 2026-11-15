import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeConfig } from "../../src/config-normalization";
import { validateConfig } from "../../src/config-validators";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard } from "../harness";

/**
 * An empty YAML key (`id:`, `map:`, `icons:`) parses as `null`, and an editor field cleared to
 * nothing is `""`. To a user both mean "I did not set this value", so the card treats them exactly
 * like a key that was never written: no crash, no misleading "invalid value" message, and where the
 * field is required the message names it. Before the normalisation pass, `icons:` crashed the first
 * render (`null.flatMap`), `map:`/`id:` skipped the coordinate and id checks, `layout:` and
 * `map_view:` were reported as invalid values, and an empty `activate:` was accepted silently.
 */

const BASE = fixtureConfig(loadSyntheticFixture());

function config(patch: Record<string, unknown>): XiaomiVacuumMapCardConfig {
    return { ...BASE, ...patch } as unknown as XiaomiVacuumMapCardConfig;
}

function pointsMode(selections: unknown[]): Record<string, unknown> {
    return {
        name: "Points",
        icon: "mdi:map-marker",
        selection_type: "PREDEFINED_POINT",
        service_call_schema: { service: "vacuum.send_command" },
        predefined_selections: selections,
    };
}

function roomsMode(selections: unknown[]): Record<string, unknown> {
    return {
        name: "Rooms",
        icon: "mdi:floor-plan",
        selection_type: "ROOM",
        service_call_schema: { service: "vacuum.send_command" },
        predefined_selections: selections,
    };
}

function zonesMode(selections: unknown[]): Record<string, unknown> {
    return {
        name: "Zones",
        icon: "mdi:shape",
        selection_type: "PREDEFINED_RECTANGLE",
        service_call_schema: { service: "vacuum.send_command" },
        predefined_selections: selections,
    };
}

/** A complete second preset, so a test can patch a field inside `additional_presets`. */
const OTHER_PRESET = {
    preset_name: "Upstairs",
    entity: "vacuum.other",
    map_source: { camera: "camera.vacuum_map" },
    calibration_source: { camera: true },
    vacuum_platform: "Xiaomi Miio",
};

/** Three valid calibration points with one entry replaced. */
function calibrationWith(first: unknown): unknown[] {
    return [
        first,
        { map: { x: 10, y: 0 }, vacuum: { x: 100, y: 0 } },
        { map: { x: 0, y: 10 }, vacuum: { x: 0, y: 100 } },
    ];
}

/** Optional keys: an empty key is absent, so a valid configuration stays valid. */
const EMPTY_OPTIONAL_KEYS: [string, Record<string, unknown>][] = [
    ["title", { title: null }],
    ["layout", { layout: null }],
    ["language", { language: null }],
    ["debug", { debug: null }],
    ["action_handler_id", { action_handler_id: null }],
    ["persist_map_view", { persist_map_view: null }],
    ["persist_map_lock", { persist_map_lock: null }],
    ["map_view_storage_key", { map_view_storage_key: null }],
    ["map_view", { map_view: null }],
    ["map_view.scale", { map_view: { scale: null } }],
    ["map_view.x", { map_view: { x: null } }],
    ["map_view.y", { map_view: { y: null } }],
    ["map_view.rotation", { map_view: { rotation: null } }],
    ["preset_name", { preset_name: null }],
    ["vacuum_platform", { vacuum_platform: null }],
    ["map_locked", { map_locked: null }],
    ["two_finger_pan", { two_finger_pan: null }],
    ["map_rotation", { map_rotation: null }],
    ["map_rotation_gesture", { map_rotation_gesture: null }],
    ["icons", { icons: null }],
    ["append_icons", { append_icons: null }],
    ["tiles", { tiles: null }],
    ["append_tiles", { append_tiles: null }],
    ["map_modes", { map_modes: null }],
    ["activate", { activate: null }],
    ["activate_on_switch", { activate_on_switch: null }],
    ["clean_selection_on_start", { clean_selection_on_start: null }],
    ["internal_variables", { internal_variables: null }],
    ["conditions", { conditions: null }],
    ["additional_presets", { additional_presets: null }],
    ["map_source.crop", { map_source: { camera: "camera.vacuum_map", crop: null } }],
    ["map_source.crop.top", { map_source: { camera: "camera.vacuum_map", crop: { top: null, bottom: 4 } } }],
    [
        "map_source.transparent_background",
        { map_source: { camera: "camera.vacuum_map", transparent_background: null } },
    ],
    ["map_source.image", { map_source: { camera: "camera.vacuum_map", image: null } }],
    ["calibration_source.camera", { calibration_source: { camera: null } }],
    ["calibration_source.identity", { calibration_source: { camera: true, identity: null } }],
    ["calibration_source.platform", { calibration_source: { camera: true, platform: null } }],
    ["calibration_source.entity", { calibration_source: { camera: true, entity: null } }],
    ["calibration_source.attribute", { calibration_source: { camera: true, attribute: null } }],
    ["calibration_source.calibration_points", { calibration_source: { camera: true, calibration_points: null } }],
    [
        "a second preset's optional keys",
        {
            preset_name: "Ground floor",
            additional_presets: [
                {
                    ...OTHER_PRESET,
                    map_locked: null,
                    icons: null,
                    tiles: null,
                    map_modes: null,
                    conditions: null,
                    map_source: { camera: "camera.vacuum_map", crop: null },
                },
            ],
        },
    ],
    ["map_modes[0].name", { map_modes: [{ template: "vacuum_clean_zone", name: null }] }],
    ["map_modes[0].icon", { map_modes: [{ template: "vacuum_clean_zone", icon: null }] }],
    ["map_modes[0].service_call_schema", { map_modes: [{ template: "vacuum_clean_zone", service_call_schema: null }] }],
    ["map_modes[0].id_type", { map_modes: [{ template: "vacuum_clean_zone", id_type: null }] }],
    ["map_modes[0].selection_type", { map_modes: [{ template: "vacuum_clean_zone", selection_type: null }] }],
    ["map_modes[0].repeats_type", { map_modes: [{ template: "vacuum_clean_zone", repeats_type: null }] }],
    ["map_modes[0].cleaning_order", { map_modes: [{ template: "vacuum_clean_segment", cleaning_order: null }] }],
    ["map_modes[0].max_selections", { map_modes: [{ template: "vacuum_clean_segment", max_selections: null }] }],
    ["map_modes[0].max_repeats", { map_modes: [{ template: "vacuum_clean_zone", max_repeats: null }] }],
    ["map_modes[0].run_immediately", { map_modes: [{ template: "vacuum_clean_zone", run_immediately: null }] }],
    [
        "map_modes[0].coordinates_rounding",
        { map_modes: [{ template: "vacuum_clean_zone", coordinates_rounding: null }] },
    ],
    [
        "map_modes[0].coordinates_to_meters_divider",
        { map_modes: [{ template: "vacuum_clean_zone", coordinates_to_meters_divider: null }] },
    ],
    [
        "map_modes[0].predefined_selections",
        { map_modes: [{ template: "vacuum_clean_segment", predefined_selections: null }] },
    ],
    ["room outline", { map_modes: [roomsMode([{ id: 1, outline: null }])] }],
    ["room state_entity", { map_modes: [roomsMode([{ id: 1, state_entity: null }])] }],
    ["room default_state", { map_modes: [roomsMode([{ id: 1, default_state: null }])] }],
    ["room label", { map_modes: [roomsMode([{ id: 1, label: null }])] }],
    ["room icon", { map_modes: [roomsMode([{ id: 1, icon: null }])] }],
    ["tile icon", { tiles: [{ entity: "sensor.roborock_s7_status", label: "Status", icon: null }] }],
    ["tile attribute", { tiles: [{ entity: "sensor.roborock_s7_status", label: "Status", attribute: null }] }],
    ["tile unit", { tiles: [{ entity: "sensor.roborock_s7_status", label: "Status", unit: null }] }],
    ["icon tooltip", { icons: [{ icon: "mdi:play", tooltip: null }] }],
    ["icon conditions", { icons: [{ icon: "mdi:play", conditions: null }] }],
    ["a condition's attribute", { conditions: [{ entity: "vacuum.fake", attribute: null, value: "on" }] }],
];

/** Required keys and inner fields: an empty key reports the field it belongs to. */
const EMPTY_REQUIRED_KEYS: [string, Record<string, unknown>, string][] = [
    ["entity", { entity: null }, "Missing property: entity"],
    ["map_source", { map_source: null }, "Missing property: map_source"],
    ["map_source camera and image", { map_source: { camera: null, image: null } }, "No camera neither image provided"],
    ["calibration_source", { calibration_source: null }, "Missing property: calibration_source"],
    [
        "preset_name on the main card",
        { preset_name: null, additional_presets: [OTHER_PRESET] },
        "Missing property: preset_name",
    ],
    [
        "preset_name in a second preset",
        { preset_name: "Ground floor", additional_presets: [{ ...OTHER_PRESET, preset_name: null }] },
        "Missing property: preset_name",
    ],
    [
        "a second preset's entity",
        { preset_name: "Ground floor", additional_presets: [{ ...OTHER_PRESET, entity: null }] },
        "Missing property: entity",
    ],
    ["room id", { map_modes: [roomsMode([{ id: null }])] }, "Missing room id"],
    ["zone list", { map_modes: [zonesMode([{ zones: null }])] }, "Missing zones configuration"],
    ["point position", { map_modes: [pointsMode([{ position: null }])] }, "Missing points configuration"],
    [
        "calibration point map",
        { calibration_source: { calibration_points: calibrationWith({ map: null, vacuum: { x: 0, y: 0 } }) } },
        "Each calibration point must contain map coordinates",
    ],
    [
        "calibration point vacuum",
        { calibration_source: { calibration_points: calibrationWith({ map: { x: 0, y: 0 }, vacuum: null }) } },
        "Each calibration point must contain vacuum coordinates",
    ],
    [
        "calibration point map.x",
        {
            calibration_source: {
                calibration_points: calibrationWith({ map: { x: null, y: 0 }, vacuum: { x: 0, y: 0 } }),
            },
        },
        "Map and vacuum calibration points must contain both x and y coordinate",
    ],
    [
        "calibration point vacuum.y",
        {
            calibration_source: {
                calibration_points: calibrationWith({ map: { x: 0, y: 0 }, vacuum: { x: 0, y: null } }),
            },
        },
        "Map and vacuum calibration points must contain both x and y coordinate",
    ],
    [
        "room icon name",
        { map_modes: [roomsMode([{ id: 1, icon: { name: null, x: 1, y: 1 } }])] },
        "Icon must have name property",
    ],
    [
        "room icon x",
        { map_modes: [roomsMode([{ id: 1, icon: { name: "mdi:broom", x: null, y: 1 } }])] },
        "Icon must have x property",
    ],
    [
        "room label text",
        { map_modes: [roomsMode([{ id: 1, label: { text: null, x: 1, y: 1 } }])] },
        "Label must have text property",
    ],
    [
        "room label y",
        { map_modes: [roomsMode([{ id: 1, label: { text: "Kitchen", x: 1, y: null } }])] },
        "Label must have y property",
    ],
    [
        "map mode service_call_schema.service",
        {
            map_modes: [
                {
                    name: "Zones",
                    icon: "mdi:shape",
                    selection_type: "MANUAL_RECTANGLE",
                    service_call_schema: { service: null },
                },
            ],
        },
        "Service call schema must contain service",
    ],
    ["activate.service", { activate: { service: null } }, "Service call schema must contain service"],
    [
        "tile entity",
        { tiles: [{ entity: null, label: "Status" }] },
        "Each entry of tiles list must contain entity or internal variable",
    ],
    ["icon icon", { icons: [{ icon: null }] }, "Each entry of icons list must contain icon property"],
];

describe("empty YAML keys are absent", () => {
    it.each(EMPTY_OPTIONAL_KEYS)("%s: no validation message", (_name, patch) => {
        expect(() => validateConfig(config(patch))).not.toThrow();
        expect(validateConfig(config(patch))).toEqual([]);
    });

    it.each(EMPTY_REQUIRED_KEYS)("%s: the message names the field", (_name, patch, message) => {
        let errors: string[] = [];
        expect(() => {
            errors = validateConfig(config(patch));
        }).not.toThrow();
        expect(errors).toContain(message);
    });

    it.each([[""], [null] as const])("an empty value is an empty key too (%j)", empty => {
        expect(validateConfig(config({ icons: empty, tiles: empty }))).toEqual([]);
        expect(validateConfig(config({ entity: empty }))).toEqual(["Missing property: entity"]);
        expect(validateConfig(config({ map_modes: [roomsMode([{ id: empty }])] }))).toEqual(["Missing room id"]);
    });
});

describe("normalising a configuration", () => {
    it("keeps a user data entry that happens to be null", () => {
        // `variables`, `service_data`, `target`, `translations` and the icon maps are handed to
        // Home Assistant as data, not read as card fields, so their entries are not config keys.
        const source = config({
            map_modes: [{ template: "vacuum_clean_zone", variables: { "[[custom]]": null } }],
            activate: { service: "vacuum.start", service_data: { note: null } },
        });
        const normalized = normalizeConfig(source);
        expect(normalized.map_modes?.[0].variables).toEqual({ "[[custom]]": null });
        expect(normalized.activate?.service_data).toEqual({ note: null });
    });

    it("does not change the object Home Assistant handed to setConfig", () => {
        const source = { ...BASE, title: null, icons: null } as unknown as XiaomiVacuumMapCardConfig;
        const frozen = Object.freeze({ ...source });
        expect(() => normalizeConfig(frozen)).not.toThrow();
        expect(frozen.title).toBeNull();
        expect(frozen.icons).toBeNull();
    });

    it("keeps an empty value inside a perform-action or fire-dom-event data payload", () => {
        const action = {
            action: "perform-action",
            perform_action: "input_text.set_value",
            data: { entity_id: "input_text.x", value: "", extra: null },
        };
        const normalized = normalizeConfig(config({ tiles: [{ entity: "sensor.x", tap_action: action }] }));
        expect((normalized.tiles?.[0] as unknown as { tap_action: unknown }).tap_action).toEqual(action);
    });

    it("keeps an explicit empty label or icon: it means none, as before", () => {
        const tile = { entity: "sensor.x", label: "", icon: "" };
        const normalized = normalizeConfig(config({ tiles: [tile] }));
        expect(normalized.tiles?.[0]).toEqual(tile);
    });

    it("names activate when it is not a mapping", () => {
        expect(validateConfig(config({ activate: "vacuum.start" }))).toEqual(
            expect.arrayContaining([expect.stringContaining("activate must be a mapping")]),
        );
    });

    it("keeps a list item that is empty: a null entry is a broken entry, not an empty key", () => {
        // `map_modes:\n  -` is not an empty key; the validation reports the broken entry.
        expect(validateConfig(config({ map_modes: [null] }))).toEqual(["Error in configuration: map_modes"]);
        expect(validateConfig(config({ icons: [null] }))).toEqual(["Error in configuration: icons"]);
    });
});

describe("the card renders instead of throwing", () => {
    let uncaught: unknown[];
    const onError = (event: ErrorEvent): void => {
        uncaught.push(event.error);
    };
    // A render crash in Lit's async update surfaces as an unhandled rejection, not a window error.
    const onRejection = (reason: unknown): void => {
        uncaught.push(reason);
    };
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        uncaught = [];
        window.addEventListener("error", onError);
        process.on("unhandledRejection", onRejection);
        consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => {
        window.removeEventListener("error", onError);
        process.off("unhandledRejection", onRejection);
        consoleError.mockRestore();
    });

    /** The cases that are valid once the empty keys are absent: the card must render normally. */
    it.each([
        ["icons", { icons: null }],
        ["tiles", { tiles: null }],
        ["map_modes", { map_modes: null }],
        ["conditions", { conditions: null }],
        ["additional_presets", { additional_presets: null }],
        ["layout", { layout: null }],
        ["map_view", { map_view: null }],
        ["map_source.crop", { map_source: { camera: "camera.vacuum_map", crop: null } }],
        ["calibration_source.calibration_points", { calibration_source: { camera: true, calibration_points: null } }],
    ])("%s: the card renders", async (_name, patch) => {
        const hass = fixtureHass(loadSyntheticFixture());
        const card = await mountCard(config(patch), hass);
        await card.updateHass(hass);
        await card.element.updateComplete;
        // Let a rejected update reach the unhandledRejection handler before asserting.
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(card.shadowRoot.querySelector("ha-card")).not.toBeNull();
        expect(card.shadowRoot.querySelector("hui-error-card, hui-warning")).toBeNull();
        expect(uncaught).toEqual([]);
        expect(consoleError.mock.calls.filter(args => args.some(a => a instanceof TypeError))).toEqual([]);
        await card.cleanup();
    });

    it.each([
        ["entity", { entity: null }, "Missing property: entity"],
        ["room id", { map_modes: [roomsMode([{ id: null }])] }, "Missing room id"],
        [
            "calibration point map",
            { calibration_source: { calibration_points: calibrationWith({ map: null, vacuum: { x: 0, y: 0 } }) } },
            "Each calibration point must contain map coordinates",
        ],
        ["activate.service", { activate: { service: null } }, "Service call schema must contain service"],
    ])("%s: the error card names the field", async (_name, patch, message) => {
        const card = await mountCard(config(patch), fixtureHass(loadSyntheticFixture()));
        const shown = card.shadowRoot.querySelector("hui-error-card, pre");
        expect(shown).not.toBeNull();
        expect(card.element.configErrors.join(" ")).toContain(message);
        expect(uncaught).toEqual([]);
        expect(consoleError.mock.calls.filter(args => args.some(a => a instanceof TypeError))).toEqual([]);
        await card.cleanup();
    });

    it("setConfig stores the normalised config the rest of the card reads", async () => {
        const hass = fixtureHass(loadSyntheticFixture());
        const card = await mountCard(config({ icons: null, map_locked: null }), hass);
        expect(card.element.config.icons).toBeUndefined();
        expect(card.element.config.map_locked).toBeUndefined();
        await card.cleanup();
    });
});
