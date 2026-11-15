import type { HomeAssistantFixed } from "../types/fixes";
import type { CardPresetConfig, EntityRegistryEntry } from "../types/types";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
import { lookupEntityRegistry } from "../entity-registry";
import { getWatchedEntities } from "../utils";
import { getAllPresets, setPreset } from "./presets";

/**
 * The `hass` fields that carry entity names. Each is a new object (or a new formatter) when Home
 * Assistant's registries change or when the frontend swaps the real `formatEntityName` in after its
 * translations load, and none of them produces an entity state change the card's watched-entity
 * check could see.
 *
 * The comparison is four/five reference checks, so it costs nothing on an ordinary state update:
 * Home Assistant rebuilds `hass` on every update but keeps these objects when nothing changed.
 */
export function entityNamesChanged(
    previous: HomeAssistantFixed | undefined,
    current: HomeAssistantFixed | undefined,
): boolean {
    if (!previous || !current || previous === current) return false;
    return !sameRegistryState(previous, current);
}

/**
 * True when both `hass` values carry the same registry objects and name formatter. A state-only
 * update keeps them, so the identity of these objects is a cheap registry snapshot.
 */
function sameRegistryState(previous: HomeAssistantFixed | undefined, current: HomeAssistantFixed | undefined): boolean {
    if (!previous || !current) return previous === current;
    if (previous === current) return true;
    return (
        previous.formatEntityName === current.formatEntityName &&
        previous.entities === current.entities &&
        previous.devices === current.devices &&
        previous.areas === current.areas &&
        previous.floors === current.floors
    );
}

interface RegistrySnapshot {
    index: number;
    config: CardPresetConfig;
    formatEntityName: HomeAssistantFixed["formatEntityName"];
    signature: string;
}

/** The registry state the current preset's generated tiles and icons were built from. */
const registrySnapshots = new WeakMap<XiaomiVacuumMapCard, RegistrySnapshot>();

/**
 * The newest refresh, per card. Two registry updates close together start two generations, and
 * their lookups can settle in either order; only the newest may write its result.
 */
const registryGenerations = new WeakMap<XiaomiVacuumMapCard, number>();

function nextRegistryGeneration(card: XiaomiVacuumMapCard): number {
    const generation = (registryGenerations.get(card) ?? 0) + 1;
    registryGenerations.set(card, generation);
    return generation;
}

/**
 * A cheap, stable description of the registry entries the preset's generated config depends on:
 * the vacuum's own device entries (labels, icons and unique ids of the generated sensors), the
 * watched entities, and the devices, areas and floors those entities resolve names through.
 *
 * A registry update replaces `hass.entities` for any entity on the page. Comparing the whole maps
 * would regenerate the preset for a rename on another device; comparing only these entries keeps
 * the generated labels and icons current without that work.
 */
function registrySignature(hass: HomeAssistantFixed, config: CardPresetConfig, entries: EntityRegistryEntry[]): string {
    const display = hass.entities ?? {};
    const fetched = new Map(entries.map(entry => [entry.entity_id, entry]));
    const entityIds = new Set<string>();
    const addEntity = (entityId: string | undefined): void => {
        if (entityId) entityIds.add(entityId);
    };
    addEntity(config.entity);
    entries.forEach(entry => addEntity(entry.entity_id));
    getWatchedEntities({ type: "", ...config }).forEach(addEntity);

    const deviceIds = new Set<string>();
    const areaIds = new Set<string>();
    entityIds.forEach(entityId => {
        const entry = fetched.get(entityId) ?? display[entityId];
        // The fetched registry entry carries the assignment at runtime even though the local type
        // only names the fields the generators read.
        const deviceId = (entry as { device_id?: string } | undefined)?.device_id;
        const areaId = (entry as { area_id?: string } | undefined)?.area_id;
        if (deviceId) deviceIds.add(deviceId);
        if (areaId) areaIds.add(areaId);
    });
    deviceIds.forEach(deviceId => {
        const device = hass.devices?.[deviceId];
        if (device?.area_id) areaIds.add(device.area_id);
    });

    const floorIds = new Set<string>();
    areaIds.forEach(areaId => {
        const area = hass.areas?.[areaId];
        if (area?.floor_id) floorIds.add(area.floor_id);
    });

    return JSON.stringify({
        entities: [...entityIds]
            .sort()
            .map(entityId => [entityId, display[entityId] ?? null, fetched.get(entityId) ?? null]),
        devices: [...deviceIds].sort().map(deviceId => [deviceId, hass.devices?.[deviceId] ?? null]),
        areas: [...areaIds].sort().map(areaId => [areaId, hass.areas?.[areaId] ?? null]),
        floors: [...floorIds].sort().map(floorId => [floorId, hass.floors?.[floorId] ?? null]),
    });
}

function snapshotMatches(
    snapshot: RegistrySnapshot | undefined,
    hass: HomeAssistantFixed,
    index: number,
    config: CardPresetConfig,
    signature: string,
): boolean {
    return (
        snapshot !== undefined &&
        snapshot.index === index &&
        snapshot.config === config &&
        snapshot.formatEntityName === hass.formatEntityName &&
        snapshot.signature === signature
    );
}

/**
 * Records the registry state the preset was generated from, so the next registry update can tell
 * whether it changed anything this preset reads. Called when the configuration is (re)set; the
 * lookup is the same memoized one the generators made.
 */
export function rememberRegistrySnapshot(card: XiaomiVacuumMapCard): void {
    if (!card.config || card.oldConfig || card.configErrors.length > 0) return;
    const hass = card.hass;
    if (!hass) return;
    const index = card.presetIndex ?? 0;
    const config = getAllPresets(card)[index];
    if (!config) return;
    void lookupEntityRegistry(hass, config.entity)
        .then(lookup => {
            if (lookup.failed) return;
            if (card.presetIndex !== index || getAllPresets(card)[index] !== config) return;
            if (!sameRegistryState(hass, card.hass)) return;
            registrySnapshots.set(card, {
                index,
                config,
                formatEntityName: hass.formatEntityName,
                signature: registrySignature(hass, config, lookup.entries),
            });
        })
        .catch(() => undefined);
}

/**
 * Rebuilds the current preset's generated icons and tiles after a registry change.
 *
 * The generators store the resolved label and icon in the tile/icon config, so a re-render alone
 * cannot bring a renamed entity or a registry icon to the UI: the config has to be generated again.
 * The registry lookup is memoized per display-registry object (`src/entity-registry.ts`), so the
 * regenerated config reads the new entries instead of the cached ones.
 *
 * Only the generated config is replaced: the mode, the selection and the map view stay as they are,
 * and a preset switch or a `setConfig` that happens while the generators run wins. A change that
 * only touches registry entries this preset does not read is skipped, and a lookup that fails on
 * both websocket paths keeps the tiles and icons already on screen; the next registry change tries
 * again.
 */
export function refreshGeneratedIconsAndTiles(card: XiaomiVacuumMapCard): void {
    if (!card.config || card.oldConfig || card.configErrors.length > 0) return;
    const hass = card.hass;
    if (!hass) return;
    const index = card.presetIndex ?? 0;
    const config = getAllPresets(card)[index];
    if (!config) return;
    const variables = card.internalVariables;
    const generation = nextRegistryGeneration(card);

    void lookupEntityRegistry(hass, config.entity)
        .then(async lookup => {
            // Both registry paths rejected: the generator would answer with only the common tiles,
            // stripping the generated ones. Keep the previous answer; a later registry change
            // retries because the failed lookup was not cached.
            if (lookup.failed) return;
            const signature = registrySignature(hass, config, lookup.entries);
            if (snapshotMatches(registrySnapshots.get(card), hass, index, config, signature)) return;

            const [icons, tiles] = await card._getIconsAndTiles(config, variables);
            // A newer registry snapshot or preset switch won while the generators ran: its answer
            // supersedes this one, which may describe an older registry.
            if (registryGenerations.get(card) !== generation) return;
            if (card.presetIndex !== index) return;
            // `setConfig` (the editor, a dashboard update) replaces the preset object; writing the
            // old one back would overwrite the new config's currentPreset and watchedEntities.
            if (getAllPresets(card)[index] !== config) return;
            if (!sameRegistryState(hass, card.hass)) return;

            setPreset(card, { ...config, tiles, icons });
            registrySnapshots.set(card, {
                index,
                config,
                formatEntityName: hass.formatEntityName,
                signature,
            });
            card.requestUpdate();
        })
        // The generators never reject on their own (a failing registry lookup resolves to the tiles
        // that could be built); a rejection here must not leave an unhandled promise behind.
        .catch(() => undefined);
}
