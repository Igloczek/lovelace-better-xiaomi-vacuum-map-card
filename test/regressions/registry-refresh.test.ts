import { describe, expect, it, vi } from "vitest";
import type { HassEntity } from "home-assistant-js-websocket";

import type { HomeAssistantFixed } from "../../src/types/fixes";
import type { IconActionConfig, TileConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import {
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    settle,
    withRegistryEntries,
    withState,
    type CardHandle,
    type MockEntityRegistryEntry,
    type MockHass,
} from "../harness";

/**
 * Registry-only updates: a rename in the entity, device, area or floor registry, or an icon
 * changed in the registry, used to reach the card only after a reload.
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
    const area = entry?.area_id
        ? (this.areas?.[entry.area_id] as { name?: string; floor_id?: string | null } | undefined)
        : undefined;
    const floor = area?.floor_id ? (this.floors?.[area.floor_id] as { name?: string } | undefined) : undefined;
    const own = entry?.name ?? stateObj.attributes?.friendly_name;
    return [device?.name_by_user ?? device?.name, floor?.name, area?.name, own].filter(Boolean).join(" ");
});

type Registries = { devices?: unknown; areas?: unknown; floors?: unknown };

/** A promise a test resolves by hand, to make two refreshes overlap. */
interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => {
        resolve = res;
    });
    return { promise, resolve };
}

/** A generated tile the stubbed generator can hand back, identifiable by its title. */
function probeTile(label: string, icon: string): TileConfig {
    return { tile_id: "filter_left", entity: FILTER, label, icon } as TileConfig;
}

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

describe("registry-only renames", () => {
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

    it("updates a tile label when an area or a floor is renamed", async () => {
        const hass = baseHass();
        const vacuumEntry = hass.entities[VACUUM] as MockEntityRegistryEntry;
        const hassInKitchen = withRegistryEntries(hass, [{ ...vacuumEntry, area_id: "kitchen" }]);
        const areas = { kitchen: { area_id: "kitchen", name: "Kitchen", floor_id: "ground" } };
        const floors = { ground: { floor_id: "ground", name: "Ground floor", level: 0 } };

        const card = await mountCard(
            labelledTileConfig(),
            withRegistries(hassInKitchen, { devices: DEVICES, areas, floors }),
        );
        expect(tileTitles(card)).toEqual(["Roborock S7 Ground floor Kitchen Roborock S7"]);

        // The area rename changes the name Home Assistant composes, not any entity state.
        const renamedAreas = { kitchen: { ...areas.kitchen, name: "Dining room" } };
        await card.updateHass(withRegistries({ ...hassInKitchen }, { devices: DEVICES, areas: renamedAreas, floors }));
        expect(tileTitles(card)).toEqual(["Roborock S7 Ground floor Dining room Roborock S7"]);

        // The floor rename reaches the label through the area's floor assignment.
        const renamedFloors = { ground: { ...floors.ground, name: "First floor" } };
        await card.updateHass(
            withRegistries({ ...hassInKitchen }, { devices: DEVICES, areas: renamedAreas, floors: renamedFloors }),
        );
        expect(tileTitles(card)).toEqual(["Roborock S7 First floor Dining room Roborock S7"]);
        await card.cleanup();
    });

    it("refreshes a generated tile icon after the registry icon changes", async () => {
        const hass = baseHass();
        const card = await mountCard(generatedTileConfig(), withRegistries(hass, { devices: DEVICES }));
        expect(generatedFilterIcon(card)).toBe("mdi:air-filter");

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

    it("keeps the newer registry snapshot when two refreshes overlap", async () => {
        const hass = baseHass();
        const card = await mountCard(generatedTileConfig(), withRegistries(hass, { devices: DEVICES }));

        const pending: Deferred<[IconActionConfig[], TileConfig[]]>[] = [];
        const generator = vi.spyOn(card.element, "_getIconsAndTiles").mockImplementation(() => {
            const next = deferred<[IconActionConfig[], TileConfig[]]>();
            pending.push(next);
            return next.promise;
        });

        // Two registry updates in quick succession start two refreshes. The second one lands first;
        // the first, older answer must not overwrite it when it arrives last.
        const first = withRegistries(withRegistryEntries(hass, [{ ...FILTER_ENTRY, icon: "mdi:water" }]), {
            devices: DEVICES,
        });
        await card.updateHass(first);
        const second = withRegistries(withRegistryEntries(hass, [{ ...FILTER_ENTRY, icon: "mdi:fire" }]), {
            devices: DEVICES,
        });
        await card.updateHass(second);
        expect(pending).toHaveLength(2);

        pending[1].resolve([[], [probeTile("newer", "mdi:fire")]]);
        await settle(card.element);
        expect(generatedFilterIcon(card)).toBe("mdi:fire");

        pending[0].resolve([[], [probeTile("older", "mdi:water")]]);
        await settle(card.element);
        expect(generatedFilterIcon(card)).toBe("mdi:fire");
        expect(tileTitles(card)).toEqual(["newer"]);

        generator.mockRestore();
        await card.cleanup();
    });

    it("discards a refresh whose preset config was replaced by setConfig", async () => {
        const hass = baseHass();
        const card = await mountCard(labelledTileConfig(), withRegistries(hass, { devices: DEVICES }));

        const pending: Deferred<[IconActionConfig[], TileConfig[]]>[] = [];
        const generator = vi.spyOn(card.element, "_getIconsAndTiles").mockImplementation(() => {
            const next = deferred<[IconActionConfig[], TileConfig[]]>();
            pending.push(next);
            return next.promise;
        });

        const changed = withRegistries(withRegistryEntries(hass, [{ ...FILTER_ENTRY, icon: "mdi:water" }]), {
            devices: DEVICES,
        });
        await card.updateHass(changed);
        // The registry refresh captured the config it read before the generator ran.
        expect(pending).toHaveLength(1);

        // The editor replaces the whole config while that refresh is in flight; its own generation
        // runs on the new config.
        card.element.setConfig({
            ...labelledTileConfig(),
            tiles: [{ entity: VACUUM, tile_id: "renamed", label: "fresh" }],
        });
        expect(pending).toHaveLength(2);
        pending[1].resolve([[], [{ entity: VACUUM, tile_id: "renamed", label: "fresh" }]]);
        await settle(card.element);
        expect(tileTitles(card)).toEqual(["fresh"]);

        // The old refresh must not bring the replaced config back.
        pending[0].resolve([[], [{ entity: VACUUM, tile_id: "renamed", label: "stale" }]]);
        await settle(card.element);
        expect(tileTitles(card)).toEqual(["fresh"]);

        generator.mockRestore();
        await card.cleanup();
    });

    it("keeps the generated icons and tiles when a refresh lookup fails", async () => {
        const hass = baseHass();
        const card = await mountCard(generatedTileConfig(), withRegistries(hass, { devices: DEVICES }));
        expect(generatedFilterIcon(card)).toBe("mdi:air-filter");

        // A socket gap makes both registry paths reject. The generator would answer with only the
        // common tiles, so a runtime refresh must keep the tiles and icons it already has.
        const changed = withRegistries(withRegistryEntries(hass, [{ ...FILTER_ENTRY, icon: "mdi:water" }]), {
            devices: DEVICES,
        });
        const fail = (): never => {
            throw new Error("mockHass: websocket unavailable");
        };
        changed.setWSHandler("config/entity_registry/get_entries", fail);
        changed.setWSHandler("config/entity_registry/list", fail);
        await card.updateHass(changed);

        expect(generatedFilterIcon(card)).toBe("mdi:air-filter");

        // The failure is not cached for that registry snapshot: the next one reads it and updates.
        const recovered = withRegistries(withRegistryEntries(hass, [{ ...FILTER_ENTRY, icon: "mdi:fire" }]), {
            devices: DEVICES,
        });
        await card.updateHass(recovered);
        expect(generatedFilterIcon(card)).toBe("mdi:fire");

        await card.cleanup();
    });

    it("skips regeneration for a registry change that cannot affect the preset", async () => {
        const hass = baseHass();
        const card = await mountCard(generatedTileConfig(), withRegistries(hass, { devices: DEVICES }));
        // The baseline snapshot is recorded on the config update; give it its lookup.
        await settle(card.element);

        const generator = vi.spyOn(card.element, "_getIconsAndTiles");
        const OTHER_DEVICE = "device-other";
        // A new entity on an unrelated device changes `hass.entities` identity and nothing this
        // preset's generated tiles or icons read.
        const unrelated = withRegistryEntries(hass, [
            { entity_id: "sensor.unrelated", device_id: OTHER_DEVICE, original_name: "Unrelated" },
        ]);
        await card.updateHass(
            withRegistries(unrelated, {
                devices: {
                    ...DEVICES,
                    [OTHER_DEVICE]: {
                        id: OTHER_DEVICE,
                        name: "Other device",
                        name_by_user: null,
                        area_id: null,
                    },
                },
            }),
        );

        expect(generator).not.toHaveBeenCalled();
        expect(generatedFilterIcon(card)).toBe("mdi:air-filter");

        generator.mockRestore();
        await card.cleanup();
    });
});
