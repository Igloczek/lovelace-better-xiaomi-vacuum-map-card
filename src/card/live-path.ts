import { css, svg, SVGTemplateResult } from "lit";
import type { CardPresetConfig, LivePathConfig } from "../types/types";
import {
    advanceLivePath,
    isRunState,
    loadLivePath,
    LivePathTrack,
    readVacuumPosition,
    saveLivePath,
    VacuumPosition,
} from "../model/live-path";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";

export const DEFAULT_LIVE_PATH_ATTRIBUTE = "vacuum_position";

/** The robot marker's radius in screen pixels, at any zoom. */
const ROBOT_RADIUS = 9;

/** The preset's `live_path` as a mapping; `true` takes every default, `false`/absent is off. */
export function getLivePathConfig(preset: CardPresetConfig | undefined): LivePathConfig | undefined {
    const config = preset?.live_path;
    if (config === true) return {};
    if (!config || typeof config !== "object") return undefined;
    return config;
}

/** The entity whose attribute carries the robot's position: `live_path.entity`, else the map camera. */
export function getLivePathEntity(preset: CardPresetConfig | undefined): string | undefined {
    const config = getLivePathConfig(preset);
    if (!config || !preset) return undefined;
    return config.entity ?? preset.map_source?.camera;
}

function storeKey(preset: CardPresetConfig, entity: string): string {
    return `${preset.entity}|${entity}`;
}

function currentPosition(card: XiaomiVacuumMapCard, preset: CardPresetConfig): VacuumPosition | undefined {
    const entity = getLivePathEntity(preset);
    if (!entity) return undefined;
    const attribute = getLivePathConfig(preset)?.attribute ?? DEFAULT_LIVE_PATH_ATTRIBUTE;
    return readVacuumPosition(card._hass?.states[entity]?.attributes?.[attribute]);
}

/**
 * Records the current position into the preset's track. Called on every Home Assistant update;
 * stores the track only when it changed and re-renders only then.
 */
export function advanceCardLivePath(card: XiaomiVacuumMapCard): void {
    const preset = card._getCurrentPreset?.();
    const entity = getLivePathEntity(preset);
    if (!preset || !entity) {
        if (card.livePath || card.livePosition) {
            card.livePath = undefined;
            card.livePosition = undefined;
            card.requestUpdate();
        }
        return;
    }
    const key = storeKey(preset, entity);
    const stored = loadLivePath(key);
    const position = currentPosition(card, preset);
    const next = advanceLivePath(stored, position, card._hass?.states[preset.entity]?.state);
    if (next !== stored) saveLivePath(key, next);
    const changed =
        next !== card.livePath ||
        position?.x !== card.livePosition?.x ||
        position?.y !== card.livePosition?.y ||
        position?.a !== card.livePosition?.a;
    card.livePath = next;
    card.livePosition = position;
    if (changed) card.requestUpdate();
}

function toLayout(card: XiaomiVacuumMapCard, x: number, y: number): [number, number] | undefined {
    const converter = card.coordinatesConverter;
    if (!converter?.calibrated) return undefined;
    try {
        const [mx, my] = converter.vacuumToMap(x, y) as unknown as [number, number];
        const scale = card.realScale;
        if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(scale)) return undefined;
        return [mx * scale, my * scale];
    } catch {
        return undefined;
    }
}

/** The robot's heading on screen, in degrees clockwise from the layout's +x axis. */
function layoutHeading(card: XiaomiVacuumMapCard, position: VacuumPosition): number | undefined {
    if (position.a === undefined) return undefined;
    // The heading is a direction in vacuum coordinates; a calibration can mirror or rotate it, so
    // it is converted by mapping a point one step ahead of the robot.
    const radians = (position.a * Math.PI) / 180;
    const step = 100;
    const from = toLayout(card, position.x, position.y);
    const to = toLayout(card, position.x + Math.cos(radians) * step, position.y + Math.sin(radians) * step);
    if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return undefined;
    return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

/**
 * The path and the robot marker, drawn in the map's layout pixels inside `#svg-wrapper`, so they
 * share the map's zoom and rotation. The line width is divided by `--map-scale` and the marker is
 * scaled by `1 / mapScale`, so both stay the same on screen at any zoom. Nothing is drawn without a calibration.
 */
export function renderLivePath(card: XiaomiVacuumMapCard): SVGTemplateResult | null {
    if (!getLivePathEntity(card._getCurrentPreset?.())) return null;
    const track: LivePathTrack | undefined = card.livePath;
    const position = card.livePosition;
    const points = (track?.points ?? []).map(([x, y]) => toLayout(card, x, y)).filter(p => p !== undefined);
    const head = position ? toLayout(card, position.x, position.y) : undefined;
    // While the run goes on, the line reaches the robot. After it, the stored track ends where the
    // last run did; a later position (the robot carried elsewhere) is not part of that run.
    if (head && track && track.points.length > 0 && isRunState(track.vacuumState)) {
        const last = points[points.length - 1];
        if (!last || last[0] !== head[0] || last[1] !== head[1]) points.push(head);
    }
    const heading = position && head ? layoutHeading(card, position) : undefined;
    return svg`
        <g class="live-path" pointer-events="none">
            ${
                points.length > 1
                    ? svg`<polyline class="live-path-line" points="${points.map(p => `${p[0]},${p[1]}`).join(" ")}"></polyline>`
                    : null
            }
            ${
                head
                    ? svg`<g class="live-path-robot"
                          transform="translate(${head[0]} ${head[1]}) scale(${1 / (card.mapScale || 1)})">
                        <circle class="live-path-robot-body" cx="0" cy="0" r="${ROBOT_RADIUS}"></circle>
                        ${
                            heading !== undefined
                                ? svg`<path class="live-path-robot-heading" transform="rotate(${heading})"
                                          d="M 4 -4.5 L 9.5 0 L 4 4.5"></path>`
                                : null
                        }
                    </g>`
                    : null
            }
        </g>
    `;
}

export const livePathStyles = css`
    .live-path-line {
        fill: none;
        stroke: var(--map-card-internal-live-path-color);
        stroke-opacity: var(--map-card-internal-live-path-opacity);
        stroke-width: calc(var(--map-card-internal-live-path-width) / var(--map-scale));
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    .live-path-robot-body {
        fill: var(--map-card-internal-live-path-robot-color);
        stroke: var(--map-card-internal-live-path-robot-outline-color);
        stroke-width: 2px;
    }

    .live-path-robot-heading {
        fill: none;
        stroke: var(--map-card-internal-live-path-robot-outline-color);
        stroke-width: 2px;
        stroke-linecap: round;
        stroke-linejoin: round;
    }
`;
