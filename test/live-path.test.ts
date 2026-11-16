import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    advanceLivePath,
    LIVE_PATH_MAX_POINTS,
    LivePathTrack,
    loadLivePath,
    readVacuumPosition,
    saveLivePath,
} from "../src/model/live-path";
import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import type { CalibrationPoint } from "../src/types/types";

/**
 * Live path (#47): the card records the robot's `vacuum_position` while it cleans and draws the
 * track. The fixture is a real Dreame capture (Tasshack/dreame-vacuum 2.0.3), see its README.
 */

const FIXTURE = join(__dirname, "fixtures", "dreame-live-path");

interface TrackSample {
    x: number;
    y: number;
    a: number;
    status: string;
}

interface CameraSample {
    moment: string;
    attributes: { vacuum_position: unknown; calibration_points: CalibrationPoint[] };
}

const track: TrackSample[] = JSON.parse(readFileSync(join(FIXTURE, "position-track.json"), "utf8"));
const samples: CameraSample[] = JSON.parse(readFileSync(join(FIXTURE, "camera-samples.json"), "utf8"));

/** The vacuum entity state Tasshack/dreame-vacuum reports for each status in the capture. */
const VACUUM_STATE: Record<string, string> = { room_cleaning: "cleaning", returning: "returning", charging: "docked" };

function replay(samplesToReplay: TrackSample[], start?: LivePathTrack): LivePathTrack | undefined {
    let current = start;
    for (const sample of samplesToReplay) {
        current = advanceLivePath(current, readVacuumPosition(sample), VACUUM_STATE[sample.status]);
    }
    return current;
}

describe("reading a position attribute", () => {
    it("reads the Dreame camera's vacuum_position mapping", () => {
        expect(readVacuumPosition(samples[0].attributes.vacuum_position)).toEqual({ x: 9496, y: 4999, a: 359 });
    });

    it("reads lists, numeric strings and an `angle` key", () => {
        expect(readVacuumPosition([1, 2, 90])).toEqual({ x: 1, y: 2, a: 90 });
        expect(readVacuumPosition({ x: "1", y: "2" })).toEqual({ x: 1, y: 2 });
        expect(readVacuumPosition({ x: 1, y: 2, angle: 45 })).toEqual({ x: 1, y: 2, a: 45 });
    });

    it("is no position without two finite coordinates", () => {
        for (const value of [undefined, null, "1,2", [1], { x: 1 }, { x: "", y: 2 }, { x: NaN, y: 1 }]) {
            expect(readVacuumPosition(value)).toBeUndefined();
        }
    });
});

describe("accumulating the track", () => {
    it("records the captured run from the dock and back, keeping it after docking", () => {
        const docked = advanceLivePath(undefined, readVacuumPosition(samples[0].attributes.vacuum_position), "docked");
        expect(docked).toBeUndefined();

        const result = replay(track);
        const moving = track.filter(s => s.status !== "charging");
        expect(result?.points).toEqual(moving.map(s => [s.x, s.y]));
        expect(result?.vacuumState).toBe("docked");
    });

    it("starts a new track on the next run", () => {
        const first = replay(track);
        const next = advanceLivePath(first, { x: 9481, y: 5000 }, "cleaning");
        expect(next?.points).toEqual([[9481, 5000]]);
    });

    it("does not repeat a position the robot has not left (the mop pre-wash in the dock)", () => {
        let current = advanceLivePath(undefined, { x: 9496, y: 4999, a: 359 }, "cleaning");
        for (let i = 0; i < 5; i++) current = advanceLivePath(current, { x: 9496, y: 4999, a: 359 }, "cleaning");
        expect(current?.points).toEqual([[9496, 4999]]);
    });

    it("keeps the track through an unavailable or unknown vacuum state", () => {
        const running = replay(track.slice(0, 4));
        expect(advanceLivePath(running, { x: 1, y: 1 }, "unavailable")).toBe(running);
        expect(advanceLivePath(running, { x: 1, y: 1 }, "unknown")).toBe(running);
        const resumed = advanceLivePath(running, { x: 1, y: 1 }, "cleaning");
        expect(resumed?.points.length).toBe((running?.points.length ?? 0) + 1);
    });

    it("starts the track when the card first sees a vacuum already returning", () => {
        expect(advanceLivePath(undefined, { x: 5, y: 6 }, "returning")?.points).toEqual([[5, 6]]);
    });

    it("thins a long track to stay under the cap, keeping both ends", () => {
        let current = advanceLivePath(undefined, { x: 0, y: 0 }, "cleaning");
        for (let i = 1; i <= LIVE_PATH_MAX_POINTS + 10; i++)
            current = advanceLivePath(current, { x: i, y: 0 }, "cleaning");
        const points = current?.points ?? [];
        expect(points.length).toBeLessThanOrEqual(LIVE_PATH_MAX_POINTS);
        expect(points[0]).toEqual([0, 0]);
        expect(points[points.length - 1]).toEqual([LIVE_PATH_MAX_POINTS + 10, 0]);
    });
});

describe("converting the track", () => {
    it("follows the camera's calibration when the image grows between frames", () => {
        const before = new CoordinatesConverter(samples[0].attributes.calibration_points);
        const after = new CoordinatesConverter(samples[2].attributes.calibration_points);
        const dock = readVacuumPosition(samples[2].attributes.vacuum_position)!;
        const [, yBefore] = before.vacuumToMap(dock.x, dock.y) as unknown as number[];
        const [, yAfter] = after.vacuumToMap(dock.x, dock.y) as unknown as number[];
        // The same vacuum point moves 184 px down the larger image: the pixel side of the
        // calibration moved (553 -> 737), so a track stored in pixels would detach from the map.
        expect(yAfter - yBefore).toBeCloseTo(184, 6);
    });
});

describe("storing the track", () => {
    afterEach(() => window.localStorage.clear());

    it("survives a reload and ignores a malformed entry", () => {
        const result = replay(track)!;
        saveLivePath("vacuum.a|camera.a", result);
        expect(loadLivePath("vacuum.a|camera.a")).toEqual(result);
        window.localStorage.setItem(
            "better-xiaomi-vacuum-map-card-live-path",
            JSON.stringify({ "vacuum.a|camera.a": { points: [["x", 1]] } }),
        );
        expect(loadLivePath("vacuum.a|camera.a")).toBeUndefined();
        saveLivePath("vacuum.a|camera.a", undefined);
        expect(window.localStorage.getItem("better-xiaomi-vacuum-map-card-live-path")).toBeNull();
    });
});
