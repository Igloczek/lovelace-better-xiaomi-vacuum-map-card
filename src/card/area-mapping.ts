import type { RoomConfig } from "../types/types";
import { readCameraRooms, type CameraRoom } from "../model/camera-rooms";
import {
    AREA_JOIN_RULES,
    findUnmappedAreas,
    readVacuumAreaOptions,
    resolveAreaOutlines,
    type AreaOutlines,
    type VacuumAreaOptions,
} from "../model/area-mapping";
import { isAreaId } from "../model/room-config";
import type { RoomSegment } from "../model/map_objects/room";
import { SelectionType } from "../model/map_mode/selection-type";
import type { MapMode } from "../model/map_mode/map-mode";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
import { getAreas, getLiveRooms, modeTargetsAreas } from "./rooms";
import { rebuildSelection, getUsableSelectedRooms } from "./selection";

/**
 * The vacuum's area mapping as the card last read it from Home Assistant's entity registry
 * (`config/entity_registry/get`, open to every user). `entities` is the `hass.entities` object the
 * read was started for: Home Assistant's frontend replaces it whenever the entity registry changes,
 * which is also when the user re-maps areas in the vacuum's settings, so a new object reads again.
 * `options` stays undefined until the answer arrives and when the read fails; the card then draws
 * the configured rooms as #121 did.
 */
export interface CardAreaMapping {
    readonly entityId: string;
    readonly entities: unknown;
    options?: VacuumAreaOptions;
}

/**
 * The card's subscription to `entity_registry_updated`, which Home Assistant lets every user subscribe
 * to (`SUBSCRIBE_ALLOWLIST`). Re-mapping areas changes only the vacuum entry's options, and the
 * frontend does not replace `hass.entities` for that, so without the event the card would draw the
 * old mapping until the page is reloaded.
 */
export interface AreaMappingSubscription {
    readonly connection: unknown;
    readonly entityId: string;
    readonly unsubscribe: Promise<(() => unknown) | undefined>;
}

/**
 * Reads the vacuum's area mapping when a mode of the current preset cleans areas and the registry may
 * have changed since the last read. Nothing is read for any other card.
 */
export function refreshAreaMapping(card: XiaomiVacuumMapCard, force = false): void {
    const entityId = card._getCurrentPreset()?.entity;
    if (!entityId || !card.hass?.callWS || !card.modes.some(mode => modeTargetsAreas(card, mode))) {
        card.areaMapping = undefined;
        unsubscribeAreaMapping(card);
        return;
    }
    subscribeAreaMapping(card, entityId);
    const entities = card.hass.entities;
    const previous = card.areaMapping;
    if (!force && previous?.entityId === entityId && previous.entities === entities) return;

    const request: CardAreaMapping = {
        entityId,
        entities,
        // Keep drawing the last mapping of the same vacuum while the new one is read.
        options: previous?.entityId === entityId ? previous.options : undefined,
    };
    card.areaMapping = request;
    card.hass
        .callWS({ type: "config/entity_registry/get", entity_id: entityId })
        .then(entry => {
            if (card.areaMapping !== request) return;
            const options = readVacuumAreaOptions(entry);
            const changed = JSON.stringify(options) !== JSON.stringify(request.options);
            request.options = options;
            if (changed && modeTargetsAreas(card, card._getCurrentMode())) rebuildSelection(card);
            card.requestUpdate();
        })
        .catch(() => {
            // No registry entry (a YAML vacuum without a unique id) or no connection: the configured
            // rooms stay as they are.
        });
}

/** Reads the mapping again whenever Home Assistant reports a change of the vacuum's registry entry. */
function subscribeAreaMapping(card: XiaomiVacuumMapCard, entityId: string): void {
    const connection = card.hass?.connection;
    const current = card.areaMappingSubscription;
    if (!card.connected || !connection?.subscribeEvents) return;
    if (current && current.connection === connection && current.entityId === entityId) return;
    unsubscribeAreaMapping(card);
    const unsubscribe = connection
        .subscribeEvents((event: { data?: { entity_id?: string; old_entity_id?: string } }) => {
            const data = event?.data;
            if (data?.entity_id !== entityId && data?.old_entity_id !== entityId) return;
            refreshAreaMapping(card, true);
        }, "entity_registry_updated")
        .then(
            unsub => unsub as () => unknown,
            () => undefined,
        );
    card.areaMappingSubscription = { connection, entityId, unsubscribe };
}

/** Ends the registry subscription; the card calls it when it is detached. */
export function unsubscribeAreaMapping(card: XiaomiVacuumMapCard): void {
    const subscription = card.areaMappingSubscription;
    if (!subscription) return;
    card.areaMappingSubscription = undefined;
    void subscription.unsubscribe.then(unsub => unsub?.()).catch(() => undefined);
}

/** The vacuum's area options once read, for the preset's vacuum. */
function currentAreaOptions(card: XiaomiVacuumMapCard): VacuumAreaOptions | undefined {
    const mapping = card.areaMapping;
    return mapping && mapping.entityId === card._getCurrentPreset()?.entity ? mapping.options : undefined;
}

/**
 * The state of the integration's current-map select on the vacuum's device (Roborock's
 * `selected_map`), which names the map the camera shows. Undefined when there is none.
 */
function currentMapName(card: XiaomiVacuumMapCard, platform: string | undefined): string | undefined {
    const translationKey = platform ? AREA_JOIN_RULES[platform]?.currentMapSelect : undefined;
    const vacuum = card.hass?.entities?.[card._getCurrentPreset()?.entity ?? ""];
    if (!translationKey || !vacuum?.device_id) return undefined;
    const select = Object.values(card.hass.entities).find(
        entry =>
            entry.entity_id.startsWith("select.") &&
            entry.device_id === vacuum.device_id &&
            entry.platform === platform &&
            entry.translation_key === translationKey,
    );
    const state = select ? card.hass.states[select.entity_id]?.state : undefined;
    return state && state !== "unknown" && state !== "unavailable" ? state : undefined;
}

/**
 * Each area's camera rooms on the map the camera shows, or undefined while the mapping is unknown
 * or the vacuum's integration has no confirmed join (see `resolveAreaOutlines`).
 */
export function getAreaOutlines(card: XiaomiVacuumMapCard): AreaOutlines | undefined {
    const options = currentAreaOptions(card);
    if (!options) return undefined;
    const platform = card.hass?.entities?.[card._getCurrentPreset()?.entity ?? ""]?.platform;
    return resolveAreaOutlines({
        platform,
        options,
        cameraRoomIds: new Set(Object.keys(getLiveRooms(card) ?? {})),
        currentMapName: currentMapName(card, platform),
    });
}

/** One comparable value for the outlines the rooms were built from; undefined without any. */
export function areaOutlinesKey(card: XiaomiVacuumMapCard): string | undefined {
    const outlines = getAreaOutlines(card);
    return outlines ? JSON.stringify([...outlines.roomsByArea]) : undefined;
}

/** A room of an area mode, with the camera rooms it is drawn from. */
export interface AreaRoom {
    readonly config: RoomConfig;
    readonly segments: RoomSegment[];
    /** The image outline of the room the label sits in, when the colour detection found it. */
    readonly imageOutline?: Array<[number, number]>;
}

/**
 * The rooms of a mode that cleans areas, in configured order, each area drawn with the outlines of
 * the camera rooms Home Assistant maps it to. A mode without `predefined_selections` gets one room
 * per mapped area that Home Assistant still has, in the mapping's order.
 *
 * An area keeps its configuration as it is, icon only, when the mapping gives it no room on this map
 * (no segments, another floor, an integration without a confirmed join) or when it has its own
 * `outline`. The label is the configured one, else the area's name in Home Assistant, and sits in
 * the largest of the area's rooms, where the configured icon moves too.
 */
export function buildAreaRooms(card: XiaomiVacuumMapCard, mode: MapMode): AreaRoom[] {
    const configured = (mode.predefinedSelections as RoomConfig[]).filter(room => room && room.id !== undefined);
    const outlines = getAreaOutlines(card);
    const areas = getAreas(card);
    const areaIds = configured.length
        ? configured.map(room => String(room.id))
        : [...(outlines?.roomsByArea.keys() ?? [])].filter(id => isAreaId(id, areas));
    const configuredById = new Map(configured.map(room => [String(room.id), room]));
    const cameraRooms = new Map(
        readCameraRooms(card.hass?.states[card._getCurrentPreset()?.map_source?.camera ?? ""]?.attributes["rooms"]).map(
            room => [room.id, room],
        ),
    );
    const regions = new Map((card.roomColorDetection?.regions ?? []).map(region => [region.id, region]));

    return areaIds.map(areaId => {
        const own = configuredById.get(areaId);
        const parts = (own?.outline ? [] : (outlines?.roomsByArea.get(areaId) ?? []))
            .map(roomId => ({ room: cameraRooms.get(roomId), region: regions.get(roomId) }))
            .filter((part): part is { room: CameraRoom; region: (typeof part)["region"] } => part.room !== undefined);
        if (parts.length === 0) return { config: own ?? { id: areaId }, segments: [] };

        const main = parts.reduce((largest, part) =>
            polygonArea(part.room.outline) > polygonArea(largest.room.outline) ? part : largest,
        );
        const [x, y] = roomCentre(card, main.room, main.region?.center);
        const name = (areas?.[areaId] as { name?: string } | undefined)?.name;
        const config: RoomConfig = {
            ...own,
            id: own?.id ?? areaId,
            icon: own?.icon ? { ...own.icon, x, y } : undefined,
            // The name sits under the area's icon, as a configured room's label does; without an icon
            // it is centred in a detected room, as a camera room's is.
            label: own?.label ?? { text: name ?? areaId, x, y, offset_y: own?.icon || !main.region ? 35 : 0 },
            outline: main.room.outline,
        };
        return {
            config,
            imageOutline: main.region?.outline,
            segments: parts.map(part => ({
                id: part.room.id,
                outline: part.room.outline,
                imageOutline: part.region?.outline,
            })),
        };
    });
}

/** Where a camera room's label goes, in vacuum coordinates, as `getRoomsConfig` places it. */
function roomCentre(
    card: XiaomiVacuumMapCard,
    room: CameraRoom,
    detectedCentre: [number, number] | undefined,
): [number, number] {
    const detected =
        detectedCentre && card.coordinatesConverter
            ? card.coordinatesConverter.mapToVacuum(detectedCentre[0], detectedCentre[1])
            : undefined;
    const average = (axis: 0 | 1): number =>
        room.outline.reduce((sum, point) => sum + point[axis], 0) / room.outline.length;
    return [room.x ?? detected?.[0] ?? average(0), room.y ?? detected?.[1] ?? average(1)];
}

function polygonArea(outline: ReadonlyArray<readonly [number, number]>): number {
    let area = 0;
    outline.forEach((point, index) => {
        const next = outline[(index + 1) % outline.length];
        area += point[0] * next[1] - next[0] * point[1];
    });
    return Math.abs(area / 2);
}

/**
 * The selected areas Home Assistant has no segments for, so `vacuum.clean_area` would not clean them
 * (`areas_not_mapped`). Empty until the mapping has been read, and in any mode that cleans no areas.
 * The card still sends them: Home Assistant cleans the mapped areas and reports the rest.
 */
export function getUnmappedSelectedAreas(card: XiaomiVacuumMapCard, mode: MapMode | undefined): string[] {
    if (mode?.selectionType !== SelectionType.ROOM || !modeTargetsAreas(card, mode)) return [];
    const options = currentAreaOptions(card);
    if (!options) return [];
    const areas = getAreas(card);
    const selectedAreas = getUsableSelectedRooms(card, mode)
        .map(room => String(room.toVacuum()))
        .filter(id => isAreaId(id, areas));
    return findUnmappedAreas([...new Set(selectedAreas)], options);
}
