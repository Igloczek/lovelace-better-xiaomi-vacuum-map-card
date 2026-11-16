import { PointType, ZoneType } from "../types/types";

/**
 * Geometry of a rotatable zone (`MANUAL_ROTATABLE_RECTANGLE`), in vacuum coordinates.
 *
 * A zone is an axis-aligned box `[x1, y1, x2, y2]` plus an angle in radians, turned around the box's
 * centre. The box keeps its width and height through a rotation, so the robot always gets a true
 * rectangle: tykarol's `clean_area` forwards any four points, and a shape that is not a rectangle is
 * shown wrongly in the vendor app (upstream #134).
 */

/** Snaps an angle within this many degrees of a multiple of 45° onto it, for walls at 45°. */
const SNAP_DEGREES = 3;

export function zoneCentre([x1, y1, x2, y2]: ZoneType): PointType {
    return [(x1 + x2) / 2, (y1 + y2) / 2];
}

export function rotatePoint([x, y]: PointType, [cx, cy]: PointType, angle: number): PointType {
    if (angle === 0) return [x, y];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/** `[min x, min y, max x, max y]`. */
export function orderedZone([x1, y1, x2, y2]: ZoneType): ZoneType {
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/**
 * The four corners in the order the Viomi V8 robot gets them for a zone. `viomi_vacuum_v8.clean_zone`
 * unpacks `[x1, y1, x2, y2]` as `x1, y2, x2, y1` and sends `(x1, y1) (x1, y2) (x2, y2) (x2, y1)` of
 * that unpacking to `set_zone`: `(minX, maxY) (minX, minY) (maxX, minY) (maxX, maxY)` of the zone the
 * card sends. Each corner is then turned around the centre by `angle`. At angle 0, `clean_area` with
 * these points sends the robot exactly what `clean_zone` sends for the same box.
 */
export function rotatedZoneCorners(zone: ZoneType, angle: number): [PointType, PointType, PointType, PointType] {
    const [minX, minY, maxX, maxY] = orderedZone(zone);
    const centre = zoneCentre(zone);
    const corners: PointType[] = [
        [minX, maxY],
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
    ];
    return corners.map(p => rotatePoint(p, centre, angle)) as [PointType, PointType, PointType, PointType];
}

/** An angle in (-π, π], whole degrees, snapped onto a multiple of 45° when it is close to one. */
export function snapAngle(angle: number): number {
    let degrees = Math.round((angle * 180) / Math.PI);
    degrees = ((((degrees + 180) % 360) + 360) % 360) - 180;
    if (degrees === -180) degrees = 180;
    const nearest45 = Math.round(degrees / 45) * 45;
    if (Math.abs(degrees - nearest45) <= SNAP_DEGREES) degrees = nearest45 === -180 ? 180 : nearest45;
    return degrees === 0 ? 0 : (degrees * Math.PI) / 180;
}

/** The angle in whole degrees, for display. */
export function angleDegrees(angle: number): number {
    return Math.round((angle * 180) / Math.PI);
}

/**
 * Resizes a rotated zone by moving one corner while the opposite corner stays where it is.
 * `fixed` and `moved` are the two opposite corners in vacuum coordinates (`moved` already at its new
 * position) and `previousDiagonal` is the unrotated `moved - fixed` before the drag. A drag that
 * would turn the zone inside out returns `undefined`, the same rule the axis-aligned resize keeps.
 */
export function resizeRotatedZone(
    fixed: PointType,
    moved: PointType,
    previousDiagonal: PointType,
    angle: number,
): ZoneType | undefined {
    const centre: PointType = [(fixed[0] + moved[0]) / 2, (fixed[1] + moved[1]) / 2];
    const [dx, dy] = rotatePoint([moved[0] - fixed[0], moved[1] - fixed[1]], [0, 0], -angle);
    if (
        Math.sign(dx) !== Math.sign(previousDiagonal[0]) ||
        Math.sign(dy) !== Math.sign(previousDiagonal[1]) ||
        dx === 0 ||
        dy === 0
    ) {
        return undefined;
    }
    const halfWidth = Math.abs(dx) / 2;
    const halfHeight = Math.abs(dy) / 2;
    return [centre[0] - halfWidth, centre[1] - halfHeight, centre[0] + halfWidth, centre[1] + halfHeight];
}
