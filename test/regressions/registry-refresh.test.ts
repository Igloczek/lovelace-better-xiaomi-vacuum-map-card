import { describe, expect, it, vi } from "vitest";
import type { HassEntity } from "home-assistant-js-websocket";

import type { HomeAssistantFixed } from "../../src/types/fixes";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import {
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    withRegistryEntries,
    withState,
    type CardHandle,
    type MockEntityRegistryEntry,
    type MockHass,
} from "../harness";

/**
 * Registry-only updates (ROADMAP known limitations: renamed entities in tiles and in icons).
 *
 * A rename in Home Assistant's registries does not necessarily change a watched entity state, and
 * the icons and tiles the generators build are stored in the preset config, so without a re-render
 * and a regeneration the label and the icon stay stale until the card is reloaded.
 */

const VACUUM = "vacuum.roborock_s7";
const DEVICE = "device-roborock-s7";
const FILTER = "sensor.roborock_s7_filter";

const FILTER_ENTRY: MockEntityRegistryEntry = {
    entity_id: FILTER,
    unique_id: "consumable_filter_left_test",
    device_id: DEVICE,
    platform: "xiaomi_miio",
    name: null,
    icon: "mdi:air-filter",
};

const DEVICES = {
    [DEVICE]: {
        id: DEVICE,
        name: "Roborock S7",
        name_by_user: null as string | null,
        area_id: null as string | null,
    },
};

/**
 * A formatter that composes the display name from the registries, the way Home Assistant's
 * `formatEntityName` does: the device name (the user's name wins), the area name, then the entity's
 * own name. It reads `this` because the card calls it with its `hass`.
 */
const composedName = vi.fn(function (this: HomeAssistantFixed, stateObj: HassEntity): string {
    const entry = this.entities?.[stateObj.entity_id] as
        | { device_id?: string; area_id?: string; name?: string }
        | undefined;
    const device = entry?.device_id
        ? (this.devices?.[entry.device_id] as { name?: string | null; name_by_user?: string | null } | undefined)
        : undefined;
    const area = entry?.area_id ? (this.areas?.[entry.area_id] as { name?: string } | undefined) : undefined;
    const own = entry?.name ?? stateObj.attributes?.friendly_name;
    return [device?.name_by_user ?? device?.name, area?.name, own].filter(Boolean).join(" ");
});

type Registries = { devices?: unknown; areas?: unknown; floors?: unknown };

/** The mock hass with a registry-aware formatter and the given device/area/floor registries. */
function withRegistries(hass: MockHass, registries: Registries = {}): MockHass {
    return { ...hass, formatEntityName: composedName, ...registries } as MockHass;
}

const FILTER_STATE = {
    entity_id: FILTER,
    state: "100",
    attributes: { friendly_name: "Roborock S7 Filter", unit_of_measurement: "h" },
    last_changed: "2026-11-01T10:00:00.000Z",
    last_updated: "2026-11-01T10:00:00.000Z",
    context: { id: "fixture-filter", parent_id: null, user_id: null },
} as unknown as HassEntity;

/** A mock hass with the fixture's states, the filter sensor and the extra registry entry. */
function baseHass(): MockHass {
    const bundle = loadSyntheticFixture();
    return fixtureHass({
        ...bundle,
        states: { ...bundle.states, [FILTER]: FILTER_STATE },
        registry: [...bundle.registry, FILTER_ENTRY],
    });
}

function baseConfig(): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        vacuum_platform: "Xiaomi Miio",
        map_modes: [{ template: "vacuum_clean_segment" }],
        icons: [],
        persist_map_view: false,
    };
}

/** A card whose tile title is resolved from the registry, because it has no configured label. */
function labelledTileConfig(): XiaomiVacuumMapCardConfig {
    return { ...baseConfig(), tiles: [{ entity: VACUUM }] };
}

/** A card whose tiles come from the vacuum's registry entries (the Xiaomi Miio sensor templates). */
function generatedTileConfig(): XiaomiVacuumMapCardConfig {
    return baseConfig();
}

function tileTitles(card: CardHandle): string[] {
    return Array.from(card.shadowRoot.querySelectorAll(".tile-title")).map(node => node.textContent?.trim() ?? "");
}

function generatedFilterIcon(card: CardHandle): string | undefined {
    return (card.shadowRoot.querySelector(".tile-filter_left-wrapper ha-state-icon") as HTMLElement & { icon?: string })
        ?.icon;
}

function registryCalls(hass: MockHass, type = "config/entity_registry/get_entries"): number {
    return hass.wsCalls.filter(call => call.type === type).length;
}

describe("registry-only renames (ROADMAP known limitations)", () => {
    it("updates a tile label when the entity is renamed", async () => {
        const hass = baseHass();
        const card = await mountCard(labelledTileConfig(), withRegistries(hass, { devices: DEVICES }));
        expect(tileTitles(card)).toEqual(["Roborock S7 Roborock S7"]);

        const entry = hass.entities[VACUUM] as MockEntityRegistryEntry;
        await card.updateHass(
            withRegistries(withRegistryEntries(hass, [{ ...entry, name: "Kitchen robot" }]), { devices: DEVICES }),
        );

        expect(tileTitles(card)).toEqual(["Roborock S7 Kitchen robot"]);
        await card.cleanup();
    });

    it("updates a tile label when the device is renamed", async () => {
        const hass = baseHass();
        const card = await mountCard(labelledTileConfig(), withRegistries(hass, { devices: DEVICES }));
        expect(tileTitles(card)).toEqual(["Roborock S7 Roborock S7"]);

        const devices = { ...DEVICES, [DEVICE]: { ...DEVICES[DEVICE], name_by_user: "Hallway robot" } };
        await card.updateHass(withRegistries({ ...hass }, { devices }));

        expect(tileTitles(card)).toEqual(["Hallway robot Roborock S7"]);
        await card.cleanup();
    });

    it("re-renders the tiles when an area or a floor is renamed", async () => {
        const hass = baseHass();
        const card = await mountCard(labelledTileConfig(), withRegistries(hass, { devices: DEVICES }));

        composedName.mockClear();
        const areas = { kitchen: { area_id: "kitchen", name: "Kitchen", floor_id: null } };
        await card.updateHass(withRegistries({ ...hass }, { devices: DEVICES, areas }));
        // Renaming an area or a floor changes neither a state nor the formatter's identity, so only
        // the registry check can bring the new name to the tiles.
        expect(composedName.mock.calls.length).toBeGreaterThan(0);

        composedName.mockClear();
        const floors = { ground: { floor_id: "ground", name: "Ground floor", level: 0 } };
        await card.updateHass(withRegistries({ ...hass }, { devices: DEVICES, areas, floors }));
        expect(composedName.mock.calls.length).toBeGreaterThan(0);
        await card.cleanup();
    });

    it("refreshes a generated tile icon after the registry icon changes", async () => {
        const hass = baseHass();
        const card = await mountCard(generatedTileConfig(), withRegistries(hass, { devices: DEVICES }));
        expect(generatedFilterIcon(card)).toBe("mdi:air-filter");
        const callsBefore = registryCalls(hass);

        const changed = withRegistries(withRegistryEntries(hass, [{ ...FILTER_ENTRY, icon: "mdi:water" }]), {
            devices: DEVICES,
        });
        await card.updateHass(changed);

        // One lookup, on the new display registry: the memoized answer for the old one is not used.
        expect(registryCalls(changed)).toBe(1);
        expect(generatedFilterIcon(card)).toBe("mdi:water");
        await card.cleanup();
    });

    it("does not re-render or refetch the registry for an unrelated state update", async () => {
        const hass = baseHass();
        const card = await mountCard(generatedTileConfig(), withRegistries(hass, { devices: DEVICES }));
        const callsBefore = registryCalls(hass);
        composedName.mockClear();

        const { hass: next } = withState(hass, VACUUM, {
            attributes: { ...hass.states[VACUUM].attributes, battery_level: 42 },
        });
        await card.updateHass(withRegistries(next, { devices: DEVICES }));

        expect(registryCalls(next)).toBe(callsBefore);
        expect(composedName).not.toHaveBeenCalled();
        await card.cleanup();
    });
});
