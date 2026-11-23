import { cameraRoomsById, readCameraRooms } from "../model/camera-rooms";
import type { RoomConfig, RoomConfigEventData, ServiceCallSchemaConfig } from "../types/types";
import { MapExtractorRoom } from "../types/types";
import { cameraRefreshKey } from "../model/map-refresh-policy";
import { RoomColorDetector } from "../model/room-color-detector";
import { AreaRegistry, findStaleRoomIds, isAreaId, isRoomIdLive } from "../model/room-config";
import { roomIdAtImagePoint } from "../model/room-hit-test";
import { MapMode } from "../model/map_mode/map-mode";
import { SelectionType } from "../model/map_mode/selection-type";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
import { getUsableSelectedRooms, rebuildSelection } from "./selection";

/** The live `rooms` attribute of the preset's camera, or undefined when it exposes none. */
export function getLiveRooms(card: XiaomiVacuumMapCard): Record<string, MapExtractorRoom> | undefined {
    const camera = card._getCurrentPreset()?.map_source?.camera;
    return camera
        ? (cameraRoomsById(card.hass?.states[camera]?.attributes["rooms"]) as
              | Record<string, MapExtractorRoom>
              | undefined)
        : undefined;
}

/**
 * The live room ids of the preset's camera, or `undefined` when it reports no rooms metadata.
 * Used as the second, mode-independent guard in `_getSelection`.
 */
export function getLiveRoomIds(card: XiaomiVacuumMapCard): Set<string> | undefined {
    const rooms = getLiveRooms(card);
    const ids = rooms ? Object.keys(rooms) : [];
    return ids.length > 0 ? new Set(ids) : undefined;
}

/** A ROOM mode's configured ids, in configured order. */
export function configuredRoomIds(mode: MapMode): Array<string | number> {
    return (mode.predefinedSelections as RoomConfig[])
        .filter(room => room && room.id !== undefined)
        .map(room => room.id);
}

/** Home Assistant's area registry, as the frontend exposes it. */
export function getAreas(card: XiaomiVacuumMapCard): AreaRegistry {
    return card.hass?.areas as AreaRegistry;
}

/**
 * Whether a ROOM id may be sent: a Home Assistant area id, or a segment id the camera reports (or
 * any segment id while the camera reports no metadata). Used as the second, mode-independent guard
 * in `_getSelection` and for a room's own availability.
 */
export function isRoomIdSendable(card: XiaomiVacuumMapCard, id: string): boolean {
    return isRoomIdLive(id, getLiveRooms(card), getAreas(card));
}

/**
 * A ROOM mode that cleans Home Assistant areas instead of the camera's segments (issue #120). The
 * camera's own rooms are named by segment ids that such a service would not take, so the card never
 * offers them.
 *
 * - An id the camera publishes is never evidence of an area mode, even when it is an area id too: a
 *   Roomba+ camera names its rooms by slugs (`kitchen`, `living_room`) that Home Assistant also uses
 *   for areas, and an area `0` must not hide a segment mode's camera rooms. Such a mode keeps the
 *   camera's rooms, outlines and colour taps. For the same reason a mode without configured rooms
 *   keeps them when the camera names a room by an area id.
 * - Otherwise a mode that calls `vacuum.clean_area` cleans areas, even when every configured area is
 *   gone or none is configured (its rooms then come from the vacuum's area mapping).
 * - Otherwise a mode cleans areas when one of its configured ids is an area (a script or another
 *   service that takes areas).
 */
export function modeTargetsAreas(card: XiaomiVacuumMapCard, mode: MapMode | undefined): boolean {
    if (mode?.selectionType !== SelectionType.ROOM) return false;
    const areas = getAreas(card);
    const liveRoomIds = getLiveRoomIds(card);
    const ids = configuredRoomIds(mode).map(String);
    if (liveRoomIds && ids.some(id => liveRoomIds.has(id))) return false;
    if (ids.length === 0 && liveRoomIds && [...liveRoomIds].some(id => isAreaId(id, areas))) return false;
    if (callsCleanArea(mode)) return true;
    return ids.some(id => isAreaId(id, areas));
}

/**
 * Whether the stale-room warning of a ROOM mode names areas as well as camera rooms: the mode has a
 * configured area id, or it calls `vacuum.clean_area`, whose ids are areas even when none of them
 * exists (a display name typed instead of the area id, or every configured area deleted). Only the
 * wording depends on the service; the audit itself is decided per id.
 */
export function staleWarningNamesAreas(card: XiaomiVacuumMapCard, mode: MapMode | undefined): boolean {
    if (mode?.selectionType !== SelectionType.ROOM) return false;
    const areas = getAreas(card);
    return configuredRoomIds(mode).some(id => isAreaId(id, areas)) || callsCleanArea(mode);
}

/**
 * A mode one of whose service calls is Home Assistant's `vacuum.clean_area`, configured or from the
 * platform template. It takes area ids only, even when every configured one is gone, and its
 * rooms without configured ones come from the vacuum's area mapping.
 */
export function callsCleanArea(mode: MapMode): boolean {
    return mode.serviceCallSchema.steps.some(step => step.service === "vacuum.clean_area");
}

/**
 * The current ROOM mode's configured ids that are no Home Assistant area and that the live camera
 * metadata no longer contains. Each id is decided on its own (issue #120): an area id is never
 * audited against the camera, so a mode that sends area ids keeps working while the camera publishes
 * segment ids, and a deleted area is stale like a renumbered segment. An empty list when the mode is
 * not a ROOM mode or the camera exposes no metadata.
 *
 * The audit is deliberately recomputed from the current `hass` instead of trusting the room
 * objects: camera metadata can shift while a selection made against the old metadata is still
 * held, and that stale id must not reach the service call (issue #928).
 */
export function getStaleRoomIds(card: XiaomiVacuumMapCard, mode: MapMode | undefined): string[] {
    if (mode?.selectionType !== SelectionType.ROOM) return [];
    return findStaleRoomIds(configuredRoomIds(mode), getLiveRooms(card), getAreas(card));
}

/**
 * The ids of the rooms the user has selected that a ROOM service call would leave out, when that
 * leaves the call with no room ids at all. Empty when nothing is selected, when at least one
 * selected room is usable (the run cleans what it can), or when every one of them is a configured
 * id the stale-id warning already names.
 *
 * A room picked from the camera metadata has no configured id for `getStaleRoomIds` to audit, so
 * `getUsableSelectedRooms` is the only place its id is checked. Without colour-detected rooms
 * nothing else reports the mismatch, and the card used to look ready while the run button sent an
 * empty room list.
 */
export function getUnsendableRoomIds(card: XiaomiVacuumMapCard, mode: MapMode | undefined): string[] {
    if (mode?.selectionType !== SelectionType.ROOM) return [];
    const selectedRooms = [...card.selectableRooms, ...card.unavailableRooms].filter(room => room.selected);
    if (selectedRooms.length === 0) return [];
    if (getUsableSelectedRooms(card, mode).length > 0) return [];
    const namedElsewhere = new Set(getStaleRoomIds(card, mode));
    return [...new Set(selectedRooms.map(room => String(room.toVacuum())))].filter(id => !namedElsewhere.has(id));
}

export function getRoomsConfig(card: XiaomiVacuumMapCard, requestId?: string): RoomConfigEventData | undefined {
    const config = card._getCurrentPreset();
    const rawRooms = card.hass.states[config.map_source?.camera ?? ""]?.attributes["rooms"];
    const roomsConfig = new Array<RoomConfig>();
    if (rawRooms) {
        const mode = card.modes.filter(m => m.selectionType === SelectionType.ROOM).reverse()[0];
        const modeIndex = mode ? card.modes.indexOf(mode) : -1;
        for (const room of readCameraRooms(rawRooms)) {
            const outline = room.outline;
            const keepFloat = outline.toString().includes(".");
            const formatCoord = (v: number, divide = 1): number => (keepFloat ? v / divide : Math.round(v / divide));
            const x = outline.reduce((a, v) => a + v[0], 0);
            const y = outline.reduce((a, v) => a + v[1], 0);
            const region = card.roomColorDetection?.regions.find(candidate => candidate.id === room.id);
            const detectedCenter =
                region && card.coordinatesConverter
                    ? card.coordinatesConverter.mapToVacuum(region.center[0], region.center[1])
                    : undefined;
            const centerX = room.x ?? detectedCenter?.[0] ?? formatCoord(x, outline.length);
            const centerY = room.y ?? detectedCenter?.[1] ?? formatCoord(y, outline.length);

            roomsConfig.push({
                id: room.id,
                icon: {
                    name: room.icon ?? "mdi:broom",
                    x: centerX,
                    y: centerY,
                },
                label: {
                    text: room.name ?? `Room ${room.id}`,
                    x: centerX,
                    y: centerY,
                    offset_y: 35,
                },
                outline: outline,
            } as RoomConfig);
        }
        return {
            modeIndex: modeIndex,
            rooms: roomsConfig,
            entity: config.entity,
            camera: config.map_source?.camera,
            requestId: requestId,
        };
    }
    return undefined;
}

export function adjustRoomId(roomId: string | number, config: MapMode): string | number {
    return config.toServiceRoomId(roomId);
}

/** How long a complete room detection is reused for newer snapshots of the same room geometry. */
const ROOM_DETECTION_REUSE_MS = 10 * 60 * 1000;

/**
 * How long a detection that missed a room is reused. A room drawn without colour is never found, so
 * without reuse such a map is traced on every snapshot; a short limit still picks up a room that
 * only appears once the map finishes drawing.
 */
const INCOMPLETE_ROOM_DETECTION_REUSE_MS = 60 * 1000;

export function detectRoomColors(card: XiaomiVacuumMapCard): void {
    const preset = card._getCurrentPreset();
    const camera = preset?.map_source?.camera;
    const entity = camera ? card.hass.states[camera] : undefined;
    const rooms = getLiveRooms(card);
    const image = card._getMapCanvas();
    if (!camera || !entity || !rooms || !image?.width || !image.height) {
        const hadDetection = card.roomColorDetection !== undefined;
        card.roomColorDetection = undefined;
        card.lastRoomColorDetectionKey = undefined;
        if (hadDetection) card._refreshRoomsAfterColorDetection();
        return;
    }

    const detectionKey = cameraRefreshKey({
        cameraId: camera,
        lastUpdated: entity.last_updated ?? entity.last_changed,
        entityPicture: entity.attributes.entity_picture as string | undefined,
    });
    if (detectionKey === card.lastRoomColorDetectionKey) return;
    // The canvas shows the snapshot the refresh policy last fetched, which lags the live entity
    // while a camera change is held for a loading snapshot or frozen in a hidden tab. Pairing the
    // live `rooms` with older pixels would record this state as detected and skip the real one;
    // the load of the newest snapshot runs detection instead.
    if (card.mapRefreshState && card.mapRefreshState.cameraKey !== detectionKey) return;
    card.lastRoomColorDetectionKey = detectionKey;

    const previousDetection = card.roomColorDetection;
    const converter = card.coordinatesConverter;
    // While the vacuum cleans the camera publishes a snapshot every few seconds in which only the
    // robot and the path moved. Tracing every room again each time costs hundreds of milliseconds
    // on a large map, so a complete detection of the same room geometry is kept; its label map
    // still covers the old robot spot as floor, and tap reach covers the new one. The rooms are
    // rebuilt below either way, so a renamed room shows its new name. A changed shape, size or
    // calibration traces the rooms again, and so does age: ten minutes for a complete detection,
    // one for a detection that missed a room.
    const reuseLimit = previousDetection?.complete ? ROOM_DETECTION_REUSE_MS : INCOMPLETE_ROOM_DETECTION_REUSE_MS;
    const reusable =
        previousDetection?.geometryKey !== undefined &&
        converter !== undefined &&
        card.roomColorDetectionAt !== undefined &&
        Date.now() - card.roomColorDetectionAt < reuseLimit &&
        previousDetection.geometryKey === RoomColorDetector.geometryKey(image.width, image.height, rooms, converter);
    if (!reusable) {
        card.roomColorDetection = converter ? RoomColorDetector.detect(image, rooms, converter) : undefined;
        card.roomColorDetectionAt = card.roomColorDetection ? Date.now() : undefined;
    }
    if (!card.roomColorDetection && !previousDetection) return;

    card._refreshRoomsAfterColorDetection();
}

export function refreshRoomsAfterColorDetection(card: XiaomiVacuumMapCard): void {
    if (card._getCurrentMode()?.selectionType === SelectionType.ROOM) {
        rebuildSelection(card);
    }
}

export function handleRoomColorClick(card: XiaomiVacuumMapCard, event: MouseEvent): void {
    if (card._getCurrentMode()?.selectionType !== SelectionType.ROOM || !card.roomColorDetection || !card.realScale) {
        return;
    }
    if (event.target instanceof Element && event.target.closest(".clickable")) return;
    // The detection names camera rooms. A mode that cleans areas offers none of them: a tap on a room
    // selects the area Home Assistant maps it to (issue #120), and a room in no area selects nothing.
    if (modeTargetsAreas(card, card._getCurrentMode())) {
        handleAreaRoomClick(card, event);
        return;
    }

    const point = card._getMousePosition(event);
    const x = Math.floor(point.x / card.realScale);
    const y = Math.floor(point.y / card.realScale);
    // The label map, not the pixel's colour: a tap on a cleaning path or the robot drawn over a
    // room still selects that room. While a detection exists, rooms it did not find are hit-tested
    // here too, after it, so their (often bounding-box) outlines cannot take a tap from a detected
    // room they overlap. Stale rooms are never targets.
    const fallbacks = card.selectableRooms
        .filter(room => !room.stale && !room.hasImageOutline)
        .map(room => ({ id: String(room.toVacuum()), outline: room.outline }));
    const roomId = roomIdAtImagePoint(card.roomColorDetection, fallbacks, card.coordinatesConverter, x, y);
    if (roomId === undefined) return;
    const room = card.selectableRooms.find(candidate => String(candidate.toVacuum()) === roomId);
    if (room) void room.click();
}

/** A tap in a mode that cleans areas: the camera room under it, then the area drawn from that room. */
function handleAreaRoomClick(card: XiaomiVacuumMapCard, event: MouseEvent): void {
    const areaRooms = card.selectableRooms.filter(room => !room.stale && room.segments.length > 0);
    if (areaRooms.length === 0) return;
    const point = card._getMousePosition(event);
    const x = Math.floor(point.x / card.realScale);
    const y = Math.floor(point.y / card.realScale);
    // A room the detection did not find keeps its metadata outline as the target, as in a segment mode.
    const fallbacks = areaRooms.flatMap(room =>
        room.segments
            .filter(segment => !segment.imageOutline)
            .map(segment => ({ id: segment.id, outline: segment.outline })),
    );
    const roomId = roomIdAtImagePoint(card.roomColorDetection, fallbacks, card.coordinatesConverter, x, y);
    if (roomId === undefined) return;
    const room = areaRooms.find(candidate => candidate.segments.some(segment => segment.id === roomId));
    if (room) void room.click();
}
