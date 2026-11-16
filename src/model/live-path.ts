/**
 * The robot's live position and the path it drove, accumulated from a position attribute.
 *
 * Integrations such as Tasshack/dreame-vacuum and the Xiaomi Cloud Map Extractor publish only the
 * robot's current position (`vacuum_position: {x, y, a}`, in vacuum coordinates); the path exists
 * only as pixels painted into their own camera image. To draw the path over any map, a static
 * floorplan included, the card records the positions it sees. The track is kept in vacuum
 * coordinates, never in map pixels: a camera's pixel calibration moves between frames when its
 * image grows, while the vacuum coordinates of a point stay put, so the track is converted with
 * the calibration of the frame being drawn.
 */

export interface VacuumPosition {
    readonly x: number;
    readonly y: number;
    /** Heading in degrees, counter-clockwise from the vacuum's +x axis, when the integration reports one. */
    readonly a?: number;
}

export interface LivePathTrack {
    /** Visited positions, oldest first, as `[x, y]` in vacuum coordinates. */
    readonly points: [number, number][];
    /** The vacuum state when the track last advanced; a change into a run starts a new track. */
    readonly vacuumState?: string;
}

/** Vacuum states in which the robot is on a run: the track grows. */
const RUN_STATES = new Set(["cleaning", "returning", "paused"]);

/** True for the vacuum states of a run in progress. */
export function isRunState(state: string | undefined): boolean {
    return state !== undefined && RUN_STATES.has(state);
}

/** Above this many points the track is thinned to every second point, keeping both ends. */
export const LIVE_PATH_MAX_POINTS = 2000;

function finite(value: unknown): number | undefined {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/**
 * Reads a position attribute: a mapping `{x, y, a?}` (Dreame, Xiaomi Cloud Map Extractor, Valetudo
 * camera) or a list `[x, y, a?]`. Anything else, including missing or non-numeric coordinates, is
 * no position.
 */
export function readVacuumPosition(value: unknown): VacuumPosition | undefined {
    let x: number | undefined;
    let y: number | undefined;
    let a: number | undefined;
    if (Array.isArray(value)) {
        [x, y, a] = [finite(value[0]), finite(value[1]), finite(value[2])];
    } else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        [x, y, a] = [finite(record.x), finite(record.y), finite(record.a ?? record.angle)];
    }
    if (x === undefined || y === undefined) return undefined;
    return a === undefined ? { x, y } : { x, y, a };
}

function thin(points: [number, number][]): [number, number][] {
    if (points.length <= LIVE_PATH_MAX_POINTS) return points;
    const last = points[points.length - 1];
    const thinned = points.filter((_, i) => i % 2 === 0);
    if (thinned[thinned.length - 1] !== last) thinned.push(last);
    return thinned;
}

/**
 * The next track for a new position and vacuum state.
 *
 * - A change of the vacuum state into a run (`cleaning`, or `returning`/`paused` seen without the
 *   cleaning before it) from any other state starts a new track at the current position; so does
 *   the first look at a vacuum that is already on a run and has no track.
 * - While the vacuum is on a run, every new position is appended; a repeat of the last position is
 *   not.
 * - Outside a run the track is kept unchanged, so the last run's path stays on the map until the
 *   next run starts, as in the vendor apps; no track is started.
 *
 * Returns the same object when nothing changed, so callers can skip storing it.
 */
export function advanceLivePath(
    track: LivePathTrack | undefined,
    position: VacuumPosition | undefined,
    vacuumState: string | undefined,
): LivePathTrack | undefined {
    const onRun = isRunState(vacuumState);
    const wasOnRun = isRunState(track?.vacuumState);
    // `unavailable`/`unknown` say nothing about the run: a polling integration drops out mid-clean.
    const stateKnown = vacuumState !== undefined && vacuumState !== "unavailable" && vacuumState !== "unknown";
    if (!stateKnown) return track;
    if (onRun && (!track || !wasOnRun)) {
        return { points: position ? [[position.x, position.y]] : [], vacuumState };
    }
    if (!track) return undefined;
    let points = track.points;
    if (onRun && position) {
        const last = points[points.length - 1];
        if (!last || last[0] !== position.x || last[1] !== position.y) {
            points = thin([...points, [position.x, position.y]]);
        }
    }
    if (points === track.points && track.vacuumState === vacuumState) return track;
    return { points, vacuumState };
}

const LIVE_PATH_STORE_KEY = "better-xiaomi-vacuum-map-card-live-path";

type LivePathStorage = Record<string, LivePathTrack>;

let cachedRaw: string | null | undefined;
let cachedStorage: LivePathStorage = {};

function read(): LivePathStorage {
    try {
        const raw = window.localStorage.getItem(LIVE_PATH_STORE_KEY);
        if (raw === cachedRaw) return cachedStorage;
        const parsed = raw ? JSON.parse(raw) : {};
        cachedStorage = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        cachedRaw = raw;
        return cachedStorage;
    } catch {
        return {};
    }
}

function isTrack(value: unknown): value is LivePathTrack {
    const track = value as LivePathTrack | undefined;
    return (
        !!track &&
        Array.isArray(track.points) &&
        track.points.every(p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) &&
        (track.vacuumState === undefined || typeof track.vacuumState === "string")
    );
}

/** The stored track for a vacuum and position source, kept per browser so a reload keeps the path. */
export function loadLivePath(key: string): LivePathTrack | undefined {
    const track = read()[key];
    return isTrack(track) ? track : undefined;
}

/** Stores or, with `undefined`, removes a track. Storage failures only lose the path across a reload. */
export function saveLivePath(key: string, track: LivePathTrack | undefined): void {
    try {
        const storage = { ...read() };
        if (track) storage[key] = track;
        else delete storage[key];
        if (Object.keys(storage).length === 0) window.localStorage.removeItem(LIVE_PATH_STORE_KEY);
        else window.localStorage.setItem(LIVE_PATH_STORE_KEY, JSON.stringify(storage));
    } catch {
        return;
    }
}
