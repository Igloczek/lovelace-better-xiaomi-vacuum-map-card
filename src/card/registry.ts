import type { HomeAssistantFixed } from "../types/fixes";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
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
    return (
        previous.formatEntityName !== current.formatEntityName ||
        previous.entities !== current.entities ||
        previous.devices !== current.devices ||
        previous.areas !== current.areas ||
        previous.floors !== current.floors
    );
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
 * and a preset switch that happens while the generators run wins (`presetIndex` guard).
 */
export function refreshGeneratedIconsAndTiles(card: XiaomiVacuumMapCard): void {
    if (!card.config || card.oldConfig || card.configErrors.length > 0) return;
    const index = card.presetIndex ?? 0;
    const config = getAllPresets(card)[index];
    if (!config) return;
    const variables = card.internalVariables;
    void card
        ._getIconsAndTiles(config, variables)
        .then(([icons, tiles]) => {
            if (card.presetIndex !== index) return;
            setPreset(card, { ...config, tiles, icons });
            card.requestUpdate();
        })
        // The generators never reject on their own (a failing registry lookup resolves to the tiles
        // that could be built); a rejection here must not leave an unhandled promise behind.
        .catch(() => undefined);
}
