import { describe, expect, it } from "vitest";

import {
    ACTIVE_ROOM_RUN_STORE_KEY,
    LEGACY_ACTIVE_ROOM_RUN_STORE_KEY,
    LEGACY_MAP_VIEW_STORE_KEY,
    MAP_VIEW_STORE_KEY,
    STORAGE_MIGRATED_KEY,
} from "../../src/const";
import { migrateLegacyStorage } from "../../src/model/storage-migration";

/**
 * The map view and the active run moved from the upstream-named storage keys to fork-namespaced
 * ones, so an instance with both cards installed does not share state between them. A fork that had
 * no upstream card keeps its state through a one-time copy.
 */

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
    };
}

describe("legacy storage migration", () => {
    it("copies the map view and the active run to the fork's keys", () => {
        const view = JSON.stringify({ "card|camera.map|": { s: 2, x: 10, y: 20, r: 0, ts: 1 } });
        const run = JSON.stringify({ "vacuum.robot": { entity: "vacuum.robot", roomIds: ["1"] } });
        const storage = memoryStorage({
            [LEGACY_MAP_VIEW_STORE_KEY]: view,
            [LEGACY_ACTIVE_ROOM_RUN_STORE_KEY]: run,
        });

        expect(migrateLegacyStorage(storage, true)).toBe(true);
        expect(storage.values.get(MAP_VIEW_STORE_KEY)).toBe(view);
        expect(storage.values.get(ACTIVE_ROOM_RUN_STORE_KEY)).toBe(run);
        expect(storage.values.get(STORAGE_MIGRATED_KEY)).toBe("1");
    });

    it("keeps the old keys, so the upstream card still finds its state", () => {
        const storage = memoryStorage({ [LEGACY_MAP_VIEW_STORE_KEY]: "{}" });

        migrateLegacyStorage(storage, true);
        expect(storage.values.get(LEGACY_MAP_VIEW_STORE_KEY)).toBe("{}");
    });

    it("does not overwrite state the fork has already stored", () => {
        const storage = memoryStorage({
            [LEGACY_MAP_VIEW_STORE_KEY]: "legacy",
            [MAP_VIEW_STORE_KEY]: "current",
        });

        migrateLegacyStorage(storage, true);
        expect(storage.values.get(MAP_VIEW_STORE_KEY)).toBe("current");
    });

    it("does not read the old keys when the upstream bundle is loaded", () => {
        const storage = memoryStorage({ [LEGACY_MAP_VIEW_STORE_KEY]: "upstream" });

        expect(migrateLegacyStorage(storage, false)).toBe(false);
        expect(storage.values.has(MAP_VIEW_STORE_KEY)).toBe(false);
        expect(storage.values.has(STORAGE_MIGRATED_KEY)).toBe(false);
    });

    it("migrates only once, so deleting the fork's state does not bring it back", () => {
        const storage = memoryStorage({ [LEGACY_MAP_VIEW_STORE_KEY]: "legacy" });
        migrateLegacyStorage(storage, true);
        storage.values.delete(MAP_VIEW_STORE_KEY);

        expect(migrateLegacyStorage(storage, true)).toBe(false);
        expect(storage.values.has(MAP_VIEW_STORE_KEY)).toBe(false);
    });

    it("tolerates storage that rejects reads or writes", () => {
        const broken = {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
        };
        expect(migrateLegacyStorage(broken, true)).toBe(false);
    });
});
