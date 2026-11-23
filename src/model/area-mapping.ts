/**
 * Home Assistant's area mapping joined to the map camera's rooms (issue #120, "option 5").
 *
 * `vacuum.clean_area` takes area ids and turns them into the vacuum's segments through the vacuum's
 * entity registry options, `options.vacuum.area_mapping` (`{area_id: [segment_id, ...]}`). The same
 * options keep `last_seen_segments` (`[{id, name, group}]`), the segments the vacuum reported when
 * the user last mapped areas. Neither carries any geometry: the outlines come from the map camera's
 * `rooms`, which every camera integration keys its own way. The join from a vacuum segment id to a
 * camera room id is therefore a rule per vacuum integration, and only confirmed rules are listed
 * here. Every other integration keeps the configured rooms as they are (icons, no outline).
 *
 * The join decides only what the card draws and which outline a tap selects. The run still sends
 * the area ids, and Home Assistant resolves them to segments itself, so a wrong or missing join can
 * never change which areas are cleaned.
 */

/** One segment as Home Assistant's vacuum entity reports it (`vacuum.Segment`). */
export interface VacuumSegment {
    readonly id: string;
    readonly name?: string | null;
    /** The floor or map the segment is on, where the integration has several (Roborock: map name). */
    readonly group?: string | null;
}

/** The vacuum's registry options under `options.vacuum`, as `config/entity_registry/get` returns them. */
export interface VacuumAreaOptions {
    /** `{area_id: [segment_id, ...]}`; undefined until the user maps areas in the vacuum's settings. */
    readonly areaMapping?: Readonly<Record<string, readonly string[]>>;
    readonly lastSeenSegments?: readonly VacuumSegment[];
}

/** A segment id taken apart by an integration's rule: the camera room id and the map it is on. */
interface JoinedSegment {
    readonly roomId: string;
    /** The map (floor) prefix, for integrations that number every map's segments from the same start. */
    readonly map?: string;
}

/** How one vacuum integration's segment ids relate to its map camera's room ids. */
export interface AreaJoinRule {
    /** The camera room id a segment id names, with its map prefix; undefined when the id is malformed. */
    readonly join: (segmentId: string) => JoinedSegment | undefined;
    /**
     * The `translation_key` of a `select` entity on the vacuum's device whose state is the name of
     * the map the vacuum is on now, which is the map its camera shows (Roborock: `selected_map`).
     * The segments' `group` is that name, so it tells which map prefix is the shown floor.
     */
    readonly currentMapSelect?: string;
}

/** `{map}_{segment}`: the segment number after the first `_`, the map before it. */
const mapPrefixed = (segmentId: string): JoinedSegment | undefined => {
    const separator = segmentId.indexOf("_");
    if (separator <= 0 || separator === segmentId.length - 1) return undefined;
    return { map: segmentId.slice(0, separator), roomId: segmentId.slice(separator + 1) };
};

/**
 * The confirmed rules, keyed by the vacuum entity's integration (its registry `platform`).
 *
 * - `roborock` (core): `Segment(id=f"{map_flag}_{room.segment_id}", group=map_info.name)`, for the
 *   V1 and the Q7 models alike; `roborock_custom_map` keys `rooms` by the bare segment id (`16` in
 *   issue #120's data, where Home Assistant's id is `0_16`). The `selected_map` select names the
 *   current map.
 * - `dreame_vacuum` (Tasshack): `"{map_index}_{segment_id}"`, and its camera keys `rooms` by the
 *   segment id.
 * - `mqtt` (core, Valetudo's autodiscovery): the segment ids are Valetudo's own, unprefixed, and the
 *   Valetudo map cameras key `rooms` by them.
 *
 * Ecovacs (no map camera with `rooms` for the core integration), Matter (no map at all) and the
 * template vacuum (ids are whatever the user wrote) have no rule.
 */
export const AREA_JOIN_RULES: Readonly<Record<string, AreaJoinRule>> = {
    roborock: { join: mapPrefixed, currentMapSelect: "selected_map" },
    dreame_vacuum: { join: mapPrefixed },
    mqtt: { join: segmentId => (segmentId ? { roomId: segmentId } : undefined) },
};

export interface AreaOutlineInput {
    /** The vacuum entity's integration (`platform` in its registry entry). */
    readonly platform: string | undefined;
    readonly options: VacuumAreaOptions;
    /** The room ids the camera reports now (keys of its `rooms`). */
    readonly cameraRoomIds: ReadonlySet<string>;
    /** The state of the integration's current-map select, when it has one and it is known. */
    readonly currentMapName?: string;
}

export interface AreaOutlines {
    /** Each area's camera rooms, in the order its segments are mapped. Only areas with at least one. */
    readonly roomsByArea: ReadonlyMap<string, readonly string[]>;
    /** The area a camera room belongs to; the inverse of `roomsByArea`. */
    readonly areaByRoom: ReadonlyMap<string, string>;
}

/**
 * The camera rooms each mapped area covers on the map the camera shows, or undefined when the
 * vacuum's integration has no confirmed rule.
 *
 * A segment is drawn for its area only when the join leaves no doubt:
 * - Integrations that number each map's segments from the same start (Roborock, Dreame) give the
 *   same bare id on two floors. The current-map select, when the segments carry map names, names
 *   the floors that may be shown: a name no segment has means a floor Home Assistant has no
 *   segments for, so nothing is drawn. Among the floors left, a bare id that two map prefixes
 *   produce is dropped rather than guessed. Without `last_seen_segments` the card cannot know the
 *   unmapped rooms of each floor, so a mapping on several floors draws nothing.
 * - A segment the camera does not report draws nothing.
 * - A camera room that two areas claim (the same segment mapped twice) belongs to neither, so a tap
 *   on it cannot pick one of them at random.
 */
export function resolveAreaOutlines(input: AreaOutlineInput): AreaOutlines | undefined {
    const rule = input.platform ? AREA_JOIN_RULES[input.platform] : undefined;
    const mapping = input.options.areaMapping;
    if (!rule || !mapping) return undefined;
    const none: AreaOutlines = { roomsByArea: new Map(), areaByRoom: new Map() };

    const segments = input.options.lastSeenSegments ?? [];
    const joinedMapping = Object.values(mapping)
        .flat()
        .map(segmentId => rule.join(segmentId))
        .filter((joined): joined is JoinedSegment => joined !== undefined);
    const shownMaps = shownMapPrefixes(rule, segments, input.currentMapName);
    if (!shownMaps && segments.length === 0 && new Set(joinedMapping.map(joined => joined.map)).size > 1) return none;
    const mayBeShown = (map: string | undefined): boolean => !shownMaps || shownMaps.has(map ?? "");

    // Every map prefix that may be shown and produces a bare id, from the mapping and from every
    // segment the vacuum reported: a floor nobody mapped yet still makes its bare ids ambiguous.
    const mapsByRoom = new Map<string, Set<string | undefined>>();
    const allJoined = [
        ...joinedMapping,
        ...segments.map(segment => rule.join(segment.id)).filter(joined => joined !== undefined),
    ];
    for (const joined of allJoined) {
        if (!mayBeShown(joined.map)) continue;
        const maps = mapsByRoom.get(joined.roomId) ?? new Set();
        maps.add(joined.map);
        mapsByRoom.set(joined.roomId, maps);
    }

    const claims = new Map<string, Set<string>>();
    const roomsByArea = new Map<string, string[]>();
    for (const [areaId, segmentIds] of Object.entries(mapping)) {
        if (!Array.isArray(segmentIds)) continue;
        for (const segmentId of segmentIds) {
            const joined = typeof segmentId === "string" ? rule.join(segmentId) : undefined;
            if (!joined || !input.cameraRoomIds.has(joined.roomId) || !mayBeShown(joined.map)) continue;
            if ((mapsByRoom.get(joined.roomId)?.size ?? 0) > 1) continue;
            const rooms = roomsByArea.get(areaId) ?? [];
            if (!rooms.includes(joined.roomId)) rooms.push(joined.roomId);
            roomsByArea.set(areaId, rooms);
            const claimants = claims.get(joined.roomId) ?? new Set();
            claimants.add(areaId);
            claims.set(joined.roomId, claimants);
        }
    }

    const areaByRoom = new Map<string, string>();
    for (const [roomId, claimants] of claims) {
        if (claimants.size === 1) areaByRoom.set(roomId, [...claimants][0]);
    }
    const result = new Map<string, readonly string[]>();
    for (const [areaId, rooms] of roomsByArea) {
        const own = rooms.filter(roomId => areaByRoom.get(roomId) === areaId);
        if (own.length > 0) result.set(areaId, own);
    }
    return { roomsByArea: result, areaByRoom };
}

/**
 * The map prefixes the current-map select's state names, matched against the segments' `group`:
 * one map, several maps sharing a name, or none at all when the vacuum is on a map Home Assistant
 * has no segments for. Undefined (no floor signal) when the integration has no such select, its
 * state is unknown, or no segment carries a map name to compare with.
 */
function shownMapPrefixes(
    rule: AreaJoinRule,
    segments: readonly VacuumSegment[],
    currentMapName: string | undefined,
): ReadonlySet<string> | undefined {
    if (!rule.currentMapSelect || !currentMapName) return undefined;
    if (!segments.some(segment => segment.group)) return undefined;
    const prefixes = new Set<string>();
    for (const segment of segments) {
        if (segment.group !== currentMapName) continue;
        const map = rule.join(segment.id)?.map;
        if (map !== undefined) prefixes.add(map);
    }
    return prefixes;
}

/** Reads `options.vacuum` of an entity registry entry, ignoring anything malformed. */
export function readVacuumAreaOptions(entry: unknown): VacuumAreaOptions {
    const options = (entry as { options?: { vacuum?: Record<string, unknown> } } | undefined)?.options?.vacuum;
    if (!options || typeof options !== "object") return {};
    const rawMapping = options.area_mapping;
    const areaMapping =
        rawMapping && typeof rawMapping === "object" && !Array.isArray(rawMapping)
            ? Object.fromEntries(
                  Object.entries(rawMapping as Record<string, unknown>)
                      .filter(([, ids]) => Array.isArray(ids))
                      .map(([areaId, ids]) => [areaId, (ids as unknown[]).filter(isSegmentId).map(id => String(id))]),
              )
            : undefined;
    const rawSegments = options.last_seen_segments;
    const lastSeenSegments = Array.isArray(rawSegments)
        ? rawSegments
              .filter(
                  (segment): segment is Record<string, unknown> =>
                      !!segment && typeof segment === "object" && isSegmentId((segment as { id?: unknown }).id),
              )
              .map(segment => ({
                  id: String(segment.id),
                  name: typeof segment.name === "string" ? segment.name : undefined,
                  group: typeof segment.group === "string" ? segment.group : undefined,
              }))
        : undefined;
    return { areaMapping, lastSeenSegments };
}

/** A segment id as Home Assistant stores it: a non-empty string, or a number from an older entry. */
function isSegmentId(id: unknown): id is string | number {
    return (typeof id === "string" && id !== "") || (typeof id === "number" && Number.isFinite(id));
}

/**
 * The area ids among `areaIds` that Home Assistant has no segments for, so `vacuum.clean_area` would
 * refuse them with `areas_not_mapped` (or, without any mapping, `area_mapping_not_configured`).
 */
export function findUnmappedAreas(areaIds: readonly string[], options: VacuumAreaOptions): string[] {
    const mapping = options.areaMapping;
    return areaIds.filter(areaId => !mapping || !(mapping[areaId]?.length > 0));
}
