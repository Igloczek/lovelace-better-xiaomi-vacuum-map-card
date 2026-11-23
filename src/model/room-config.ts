/**
 * Stale-room detection for configured ROOM selections (issue #928).
 *
 * Room ids come from the camera's `rooms` metadata. Integrations may re-number segments after a
 * map edit (Dreame documents that deleted segment ids are not reused and new segments get the next
 * highest id), so a `predefined_selections` list copied from an earlier map can point at rooms that
 * no longer exist - or, worse, at different rooms once an old id is reused by another map.
 *
 * The card deliberately does not remap by name: a room that was both renamed and re-numbered would
 * then be cleaned silently under the wrong id. It warns instead and leaves the corrected
 * selection to the user. Keeping the comparison pure makes it testable without a card, a camera
 * or a canvas.
 */

/** The live camera `rooms` attribute. `undefined` means the camera exposes no metadata at all. */
export type LiveRoomMetadata = Record<string, unknown> | undefined | null;

/**
 * Home Assistant's area registry (`hass.areas`), keyed by area id. A configured ROOM id that is a key
 * of it is an area id (issue #120): Home Assistant's `vacuum.clean_area` takes area ids and maps
 * them to the robot's segments itself, so the camera's segment ids say nothing about it.
 */
export type AreaRegistry = Record<string, unknown> | undefined | null;

/** Whether a configured ROOM id is a Home Assistant area id. */
export function isAreaId(id: string | number, areas: AreaRegistry): boolean {
    return !!areas && Object.prototype.hasOwnProperty.call(areas, String(id));
}

/**
 * Whether a ROOM id may be sent: a Home Assistant area id, or a segment id the camera reports.
 * Without camera metadata every segment id is usable, since the configured rooms are the fallback.
 */
export function isRoomIdLive(id: string | number, liveRooms: LiveRoomMetadata, areas: AreaRegistry): boolean {
    if (isAreaId(id, areas)) return true;
    const liveRoomIds = liveRooms ? Object.keys(liveRooms) : [];
    return liveRoomIds.length === 0 || liveRoomIds.includes(String(id));
}

/**
 * Configured ROOM ids that are no Home Assistant area and that the live camera metadata no longer
 * contains, in configured order, once each.
 *
 * - Each id is decided on its own (issue #120). An id that is a key of Home Assistant's area
 *   registry is an area id and is never audited against the camera: it is live while the area
 *   exists. Every other id is a segment id and is audited against the camera's `rooms`, so a re-map
 *   that renumbered every configured segment still reports all of them (issue #928). A deleted area
 *   is no area any more and, being no segment either, lands here as stale.
 * - An area whose id is also a live segment id is an area. That is accepted: Home Assistant creates
 *   area ids from names (`flur`, `living_room`), and a numeric one needs an area named after a
 *   number.
 * - Missing, `null` or empty metadata is "unknown", not "all stale": the card still falls back to
 *   the configured rooms when the integration exposes no metadata, so warning there would be noise.
 *   The result is empty in that case.
 * - Duplicate configured ids are reported once.
 * - Ids are compared in their string form because camera metadata is keyed by strings while a
 *   configuration may spell the same id as a number. Comparing by name is intentionally impossible
 *   here.
 */
export function findStaleRoomIds(
    configuredIds: readonly (string | number)[],
    liveRooms: LiveRoomMetadata,
    areas?: AreaRegistry,
): string[] {
    const liveRoomIds = liveRooms ? Object.keys(liveRooms) : [];
    if (liveRoomIds.length === 0) return [];
    const liveRoomIdSet = new Set(liveRoomIds);

    const staleIds: string[] = [];
    for (const configuredId of configuredIds) {
        const id = String(configuredId);
        if (isAreaId(id, areas)) continue;
        if (!liveRoomIdSet.has(id) && !staleIds.includes(id)) staleIds.push(id);
    }
    return staleIds;
}
