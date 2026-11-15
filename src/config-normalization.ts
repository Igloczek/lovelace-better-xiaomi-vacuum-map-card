import type { XiaomiVacuumMapCardConfig } from "./types/types";

/*
 * Empty YAML keys and cleared editor fields.
 *
 * `icons:` / `id:` / `map:` in YAML parse as `null`, and a field a user clears in the editor is
 * `""`. Both mean "I did not set this value", exactly like a key that was never written, so the
 * card normalises them away before anything reads the configuration. Left in place, `null` reaches
 * code that expects a list or a number (`null.flatMap`, `null.toString()`, `null.x`) and the card
 * shows a crash instead of a validation message naming the field.
 *
 * A `null` that is a *list item* is not an empty key: `map_modes:\n  -` is a broken entry and stays
 * for the validation to report. The same goes for entries of user data that Home Assistant receives
 * as-is (`variables`, `service_data`, `target`, translations and the icon maps): a null there is a
 * value the configuration is sending, not a card field someone left empty.
 */

/** Mappings whose entries are data for Home Assistant, not fields of the card's configuration. */
const DATA_MAPPINGS = new Set([
    "variables",
    "internal_variables",
    "service_data",
    "target",
    "translations",
    "icon_mapping",
    "value_translation_keys",
]);

function isMapping(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyScalar(value: unknown): boolean {
    return value === null || value === "";
}

function normalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        let changed = false;
        const normalized = value.map(item => {
            const next = normalizeValue(item);
            changed = changed || next !== item;
            return next;
        });
        return changed ? normalized : value;
    }
    if (!isMapping(value)) {
        return value;
    }
    let changed = false;
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (isEmptyScalar(entry)) {
            changed = true;
            continue;
        }
        const next = DATA_MAPPINGS.has(key) ? entry : normalizeValue(entry);
        changed = changed || next !== entry;
        normalized[key] = next;
    }
    // Unchanged mappings keep their identity, so an editor edit that copies the configuration still
    // hands the untouched entries (a map mode, a tile) to Home Assistant as the same objects.
    return changed ? normalized : value;
}

/**
 * A copy of the configuration with every empty field (an empty YAML key or a cleared editor field)
 * removed. The input is never changed: Home Assistant hands the card a frozen configuration.
 */
export function normalizeConfig(config: XiaomiVacuumMapCardConfig): XiaomiVacuumMapCardConfig {
    return normalizeValue(config) as XiaomiVacuumMapCardConfig;
}
