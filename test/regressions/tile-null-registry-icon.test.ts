import { describe, expect, it } from "vitest";

import { TilesGenerator } from "../../src/model/generators/tiles-generator";
import { fixtureHass, loadSyntheticFixture, type MockEntityRegistryEntry } from "../harness";

/**
 * A generated sensor tile copies the registry icon and label into a config that is then run through
 * the template replacer. The entity registry stores `null` for "no icon of its own", so the replacer
 * receives a `null` value; it used to recurse into it (`Object.entries(null)`) and reject the whole
 * generation, which left a card with a device sensor without any tiles at all.
 */

const VACUUM = "vacuum.roborock_s7";
const DEVICE = "device-roborock-s7";

function filterSensor(icon: string | null, originalIcon: string | null = null): MockEntityRegistryEntry {
    return {
        entity_id: "sensor.roborock_s7_filter",
        unique_id: "consumable_filter_left_test",
        device_id: DEVICE,
        platform: "xiaomi_miio",
        icon,
        original_icon: originalIcon,
    };
}

async function generatedTiles(entry: MockEntityRegistryEntry) {
    const bundle = loadSyntheticFixture();
    const hass = fixtureHass({ ...bundle, registry: [...bundle.registry, entry] });
    return TilesGenerator.generate(hass, VACUUM, "Xiaomi Miio", "en", [], {});
}

describe("a generated sensor tile with a null registry icon", () => {
    it("is generated instead of rejecting the whole tile list", async () => {
        const tiles = await generatedTiles(filterSensor(null));
        expect(tiles.map(tile => tile.tile_id)).toContain("filter_left");
    });

    it("takes the registry icon when the entity has one", async () => {
        const tiles = await generatedTiles(filterSensor("mdi:air-filter"));
        expect(tiles.find(tile => tile.tile_id === "filter_left")?.icon).toBe("mdi:air-filter");
    });

    it("falls back to the registry's original icon", async () => {
        const tiles = await generatedTiles(filterSensor(null, "mdi:filter-outline"));
        expect(tiles.find(tile => tile.tile_id === "filter_left")?.icon).toBe("mdi:filter-outline");
    });
});
