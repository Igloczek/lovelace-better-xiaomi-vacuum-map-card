import {
    ACTIVE_ROOM_RUN_STORE_KEY,
    LEGACY_ACTIVE_ROOM_RUN_STORE_KEY,
    LEGACY_MAP_VIEW_STORE_KEY,
    MAP_VIEW_STORE_KEY,
    STORAGE_MIGRATED_KEY,
} from "../const";

/** The browser storage the card writes to. */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function copyIfMissing(storage: StorageLike, from: string, to: string): void {
    if (storage.getItem(to) !== null) return;
    const value = storage.getItem(from);
    if (value !== null) storage.setItem(to, value);
}

/**
 * Copies the upstream-named storage keys (also this fork's keys before the rename) to the fork's own
 * keys, once.
 *
 * The map view and the active run were stored under the upstream names, so an instance with both
 * cards installed would share them: a view panned in one card would move the other's, and the
 * upstream card's run would appear on this one. The keys are therefore namespaced; this migration
 * keeps the state of a fork that had no upstream card installed.
 *
 * `canMigrate` must be false when a competing (upstream) bundle is loaded: then the old keys belong
 * to that card, and copying them would hand its state to this one. The old keys are never removed,
 * so they keep working for the other card.
 */
export function migrateLegacyStorage(storage: StorageLike, canMigrate: boolean): boolean {
    if (!canMigrate) return false;
    try {
        if (storage.getItem(STORAGE_MIGRATED_KEY)) return false;
        copyIfMissing(storage, LEGACY_MAP_VIEW_STORE_KEY, MAP_VIEW_STORE_KEY);
        copyIfMissing(storage, LEGACY_ACTIVE_ROOM_RUN_STORE_KEY, ACTIVE_ROOM_RUN_STORE_KEY);
        storage.setItem(STORAGE_MIGRATED_KEY, "1");
        return true;
    } catch {
        // Private windows and blocked storage: the card works, it only starts without stored state.
        return false;
    }
}
