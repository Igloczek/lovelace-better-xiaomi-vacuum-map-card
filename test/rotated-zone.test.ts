import { describe, expect, it } from "vitest";

import {
    orderedZone,
    resizeRotatedZone,
    rotatedZoneCorners,
    rotatePoint,
    snapAngle,
    zoneCentre,
} from "../src/model/rotated-zone";
import type { PointType, ZoneType } from "../src/types/types";

const DEG = Math.PI / 180;

/**
 * What a Viomi V8 receives for a zone, ported line for line from
 * tykarol/home-assistant-viomi-vacuum-v8 vacuum.py `async_clean_zone` (L480-495, commit 0a59cff):
 * `x1, y2, x2, y1 = z` and `[i, 0, x1, y1, x1, y2, x2, y2, x2, y1]`.
 */
function viomiCleanZoneSetZone(zone: number[]): number[] {
    const [x1, y2, x2, y1] = zone;
    return [0, 0, x1, y1, x1, y2, x2, y2, x2, y1];
}

/** The same file's `async_clean_area` (L497-512): `x1, y1, ..., x4, y4 = a` sent as given. */
function viomiCleanAreaSetZone(area: number[]): number[] {
    return [0, 0, ...area];
}

function close(actual: number[], expected: number[]): void {
    expect(actual.length).toBe(expected.length);
    actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
}

describe("rotated zone geometry", () => {
    const zone: ZoneType = [1.8, -0.8, 4.2, -0.3];

    it("at 0° sends the robot exactly what clean_zone sends for the same box", () => {
        const area = rotatedZoneCorners(zone, 0).flat();
        expect(viomiCleanAreaSetZone(area)).toEqual(viomiCleanZoneSetZone(orderedZone(zone)));
    });

    it("turns every corner around the centre and keeps a rectangle of the same size", () => {
        const corners = rotatedZoneCorners(zone, 30 * DEG);
        const centre = zoneCentre(zone);
        const distance = (a: PointType, b: PointType): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
        corners.forEach((p, i) => close(p, rotatePoint(rotatedZoneCorners(zone, 0)[i], centre, 30 * DEG)));
        // Opposite sides equal, diagonals equal: a rectangle.
        expect(distance(corners[0], corners[1])).toBeCloseTo(0.5, 9);
        expect(distance(corners[1], corners[2])).toBeCloseTo(2.4, 9);
        expect(distance(corners[2], corners[3])).toBeCloseTo(0.5, 9);
        expect(distance(corners[3], corners[0])).toBeCloseTo(2.4, 9);
        expect(distance(corners[0], corners[2])).toBeCloseTo(distance(corners[1], corners[3]), 9);
    });

    it("keeps the winding clean_zone uses at any angle", () => {
        const signedArea = (c: PointType[]): number =>
            c.reduce((sum, p, i) => sum + p[0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * p[1], 0) / 2;
        const atZero = signedArea(rotatedZoneCorners(zone, 0));
        for (const angle of [15, 45, 90, 135, -60]) {
            expect(Math.sign(signedArea(rotatedZoneCorners(zone, angle * DEG)))).toBe(Math.sign(atZero));
        }
    });

    it("does not depend on the order the box was drawn in", () => {
        close(rotatedZoneCorners([4.2, -0.3, 1.8, -0.8], 20 * DEG).flat(), rotatedZoneCorners(zone, 20 * DEG).flat());
    });

    it("snaps to whole degrees and onto multiples of 45° within 3°", () => {
        expect(snapAngle(0.4 * DEG)).toBe(0);
        expect(snapAngle(43 * DEG)).toBeCloseTo(45 * DEG, 12);
        expect(snapAngle(48.6 * DEG)).toBeCloseTo(49 * DEG, 12);
        expect(snapAngle(-88 * DEG)).toBeCloseTo(-90 * DEG, 12);
        expect(snapAngle(200 * DEG)).toBeCloseTo(-160 * DEG, 12);
        expect(snapAngle(-179 * DEG)).toBeCloseTo(180 * DEG, 12);
    });

    it("resizes a turned zone along its own sides, keeping the opposite corner in place", () => {
        const angle = 30 * DEG;
        const before = rotatedZoneCorners(zone, angle);
        // Corner 2 is opposite corner 0. Move it 0.5 m further along the zone's long side.
        const along: PointType = rotatePoint([0.5, 0], [0, 0], angle);
        const moved: PointType = [before[2][0] + along[0], before[2][1] + along[1]];
        const unrotated = rotatedZoneCorners(zone, 0);
        const diagonal: PointType = [unrotated[2][0] - unrotated[0][0], unrotated[2][1] - unrotated[0][1]];
        const resized = resizeRotatedZone(before[0], moved, diagonal, angle)!;
        const after = rotatedZoneCorners(resized, angle);
        close(after[0], before[0]);
        close(after[2], moved);
        const [x1, y1, x2, y2] = resized;
        expect(x2 - x1).toBeCloseTo(2.9, 9);
        expect(y2 - y1).toBeCloseTo(0.5, 9);
    });

    it("refuses a resize that turns the zone inside out", () => {
        const angle = 30 * DEG;
        const before = rotatedZoneCorners(zone, angle);
        const unrotated = rotatedZoneCorners(zone, 0);
        const diagonal: PointType = [unrotated[2][0] - unrotated[0][0], unrotated[2][1] - unrotated[0][1]];
        const back: PointType = rotatePoint([-3, 0], [0, 0], angle);
        expect(resizeRotatedZone(before[0], [before[2][0] + back[0], before[2][1] + back[1]], diagonal, angle)).toBe(
            undefined,
        );
    });
});
