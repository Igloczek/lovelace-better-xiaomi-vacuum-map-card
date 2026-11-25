/**
 * Room outlines a camera publishes itself, as Valetudo's map camera does (issue #77).
 *
 * sca075's MQTT Vacuum Camera, the camera the Valetudo platform recommends, publishes no room
 * bounds, only each room's own `outline`, and that outline is the convex hull of the segment: an
 * L-shaped or notched room's outline spills across the wall into its neighbours, and neighbours'
 * outlines overlap. The card used to draw those hulls as they are, because it traced only rooms
 * described by bounds. The fixture (`test/fixtures/apartment/camera-valetudo.json`) publishes the
 * apartment floor plan the way that integration does; `floor.json` is the floor each room paints.
 *
 * Every result is scored against that ground truth the way the shared-floor differential suite
 * scores a detection: per room, the Jaccard index of the shape the card draws (the traced region, or
 * the metadata outline when the room is not traced) against the painted floor. The card must be at
 * least as good for every room and clearly better overall.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import { RoomColorDetection, RoomColorDetector } from "../src/model/room-color-detector";
import { readCameraRooms } from "../src/model/camera-rooms";
import type { CalibrationPoint, MapExtractorRoom } from "../src/types/types";
import { SyntheticMap, roomBounds, syntheticMapCalibration, VACUUM_UNITS_PER_PIXEL } from "./harness/synthetic-map";

type Points = Array<[number, number]>;

const FIXTURE = join(__dirname, "fixtures", "apartment");
const png = PNG.sync.read(readFileSync(join(FIXTURE, "map.png")));
const MAP = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
const FLOOR = JSON.parse(readFileSync(join(FIXTURE, "floor.json"), "utf8")) as Record<string, Points>;

function camera(file: string): { rooms: Record<string, MapExtractorRoom>; converter: CoordinatesConverter } {
    const attributes = JSON.parse(readFileSync(join(FIXTURE, file), "utf8")).attributes;
    return {
        rooms: attributes.rooms,
        converter: new CoordinatesConverter(attributes.calibration_points as CalibrationPoint[]),
    };
}

const VALETUDO = camera("camera-valetudo.json");
const XIAOMI = camera("camera.json");

/** The polygon fill the fixture generator paints, as a mask. */
function paintMask(width: number, height: number, points: ReadonlyArray<readonly [number, number]>): Uint8Array {
    const mask = new Uint8Array(width * height);
    const top = Math.max(0, Math.floor(Math.min(...points.map(point => point[1]))));
    const bottom = Math.min(height - 1, Math.ceil(Math.max(...points.map(point => point[1]))));
    for (let y = top; y <= bottom; y++) {
        const centreY = y + 0.5;
        const crossings: number[] = [];
        points.forEach((point, index) => {
            const next = points[(index + 1) % points.length];
            if (point[1] <= centreY !== next[1] <= centreY) {
                crossings.push(point[0] + ((centreY - point[1]) / (next[1] - point[1])) * (next[0] - point[0]));
            }
        });
        crossings.sort((left, right) => left - right);
        for (let index = 0; index + 1 < crossings.length; index += 2) {
            for (let x = Math.max(0, Math.ceil(crossings[index] - 0.5)); x + 0.5 <= crossings[index + 1]; x++) {
                if (x < width) mask[y * width + x] = 1;
            }
        }
    }
    return mask;
}

/** The shape the card draws for each room, in image pixels: its traced region, or its metadata outline. */
function drawnShapes(
    detection: RoomColorDetection | undefined,
    rooms: Record<string, MapExtractorRoom>,
    converter: CoordinatesConverter,
): Record<string, Points> {
    const shapes: Record<string, Points> = {};
    for (const room of readCameraRooms(rooms)) {
        const region = detection?.regions.find(candidate => candidate.id === room.id);
        shapes[room.id] = region
            ? (region.outline as Points)
            : (room.outline.map(([x, y]) => converter.vacuumToMap(x, y)) as Points);
    }
    return shapes;
}

/** Per room, the Jaccard index of the drawn shape against the painted floor. */
function scores(shapes: Record<string, Points>, truth: Record<string, Points>): Record<string, number> {
    const { width, height } = MAP;
    return Object.fromEntries(
        Object.keys(truth).map(id => {
            const floor = paintMask(width, height, truth[id]);
            const drawn = shapes[id] ? paintMask(width, height, shapes[id]) : new Uint8Array(width * height);
            let intersection = 0;
            let union = 0;
            for (let index = 0; index < floor.length; index++) {
                if (floor[index] || drawn[index]) union++;
                if (floor[index] && drawn[index]) intersection++;
            }
            return [id, union === 0 ? 1 : intersection / union];
        }),
    );
}

/** Per room, how many pixels of the drawn shape lie on another room's floor. */
function spill(shapes: Record<string, Points>, truth: Record<string, Points>): Record<string, number> {
    const { width, height } = MAP;
    const floors = Object.fromEntries(Object.keys(truth).map(id => [id, paintMask(width, height, truth[id])]));
    return Object.fromEntries(
        Object.keys(truth).map(id => {
            const drawn = shapes[id] ? paintMask(width, height, shapes[id]) : new Uint8Array(width * height);
            let count = 0;
            drawn.forEach((inside, index) => {
                if (inside && Object.keys(floors).some(other => other !== id && floors[other][index])) count++;
            });
            return [id, count];
        }),
    );
}

const total = (perRoom: Record<string, number>): number => Object.values(perRoom).reduce((sum, v) => sum + v, 0);

/** Points clear of furniture and path, well inside each room. */
const INSIDE: Record<string, [number, number]> = {
    "10": [60, 30],
    "11": [40, 140],
    "12": [160, 30],
    "13": [130, 120],
    "14": [180, 108],
    "15": [180, 130],
    "16": [150, 190],
    "17": [220, 80],
    "18": [235, 175],
};

/** Points 3 px either side of a shared wall, each inside the other room's convex hull or next to it. */
const WALL_PAIRS: Array<[[number, number], string, [number, number], string]> = [
    [[60, 54], "10", [60, 61], "11"],
    [[180, 116], "14", [180, 123], "15"],
    [[157, 110], "13", [166, 110], "14"],
    [[157, 130], "13", [166, 130], "15"],
    [[265, 98], "17", [265, 106], "18"],
    [[236, 112], "17", [246, 112], "18"],
    [[196, 190], "16", [203, 190], "18"],
];

describe("Valetudo map camera: rooms that publish their own (convex-hull) outline", () => {
    const detection = RoomColorDetector.detectFromImageData(MAP, VALETUDO.rooms, VALETUDO.converter);

    it("traces every room from the map colours", () => {
        expect((detection?.regions ?? []).map(region => region.id).sort()).toEqual(Object.keys(FLOOR).sort());
        expect(detection?.complete).toBe(true);
    });

    it("draws each room closer to its floor than the published hull, and never worse", () => {
        const hulls = scores(drawnShapes(undefined, VALETUDO.rooms, VALETUDO.converter), FLOOR);
        const drawn = scores(drawnShapes(detection, VALETUDO.rooms, VALETUDO.converter), FLOOR);
        for (const id of Object.keys(FLOOR)) {
            expect(drawn[id], `room ${id}: ${drawn[id]} vs hull ${hulls[id]}`).toBeGreaterThanOrEqual(hulls[id] - 0.01);
        }
        expect(total(drawn)).toBeGreaterThan(total(hulls) + 0.3);
        // The hulls of the L-shaped and notched rooms cover a neighbour's floor; the drawn rooms do not.
        const hullSpill = spill(drawnShapes(undefined, VALETUDO.rooms, VALETUDO.converter), FLOOR);
        const drawnSpill = spill(drawnShapes(detection, VALETUDO.rooms, VALETUDO.converter), FLOOR);
        if (process.env.SCORE_LOG) console.log(JSON.stringify({ hulls, drawn, hullSpill, drawnSpill }));
        for (const id of ["13", "17", "18"]) expect(hullSpill[id], `hull of room ${id}`).toBeGreaterThan(100);
        for (const id of Object.keys(FLOOR)) expect(drawnSpill[id], `room ${id}`).toBe(0);
    });

    it("is as good as the same flat published with bounds (Xiaomi)", () => {
        const xiaomi = RoomColorDetector.detectFromImageData(MAP, XIAOMI.rooms, XIAOMI.converter);
        const fromBounds = scores(drawnShapes(xiaomi, XIAOMI.rooms, XIAOMI.converter), FLOOR);
        const fromOutlines = scores(drawnShapes(detection, VALETUDO.rooms, VALETUDO.converter), FLOOR);
        for (const id of Object.keys(FLOOR))
            expect(fromOutlines[id], `room ${id}`).toBeGreaterThan(fromBounds[id] - 0.02);
    });

    it("selects the room drawn under a tap, also inside a neighbour's hull", () => {
        for (const [id, [x, y]] of Object.entries(INSIDE)) {
            expect(detection && RoomColorDetector.roomIdAt(detection, x, y), `room ${id}`).toBe(id);
        }
        for (const [first, firstId, second, secondId] of WALL_PAIRS) {
            expect(detection && RoomColorDetector.roomIdAt(detection, ...first), `${first}`).toBe(firstId);
            expect(detection && RoomColorDetector.roomIdAt(detection, ...second), `${second}`).toBe(secondId);
        }
    });

    it("keeps the published outline for a room the colours cannot reveal", () => {
        // Room 18 publishes a hull but its floor is drawn in no room colour (an unexplored grey area):
        // nothing can be traced, so the card keeps the published outline and the other rooms are
        // still traced around it.
        const grey = { ...MAP, data: new Uint8ClampedArray(MAP.data) };
        const floor = paintMask(MAP.width, MAP.height, FLOOR["18"]);
        floor.forEach((inside, index) => inside && grey.data.set([200, 200, 200, 255], index * 4));
        const found = RoomColorDetector.detectFromImageData(grey, VALETUDO.rooms, VALETUDO.converter);
        const ids = (found?.regions ?? []).map(region => region.id).sort();
        expect(ids).toEqual(Object.keys(FLOOR).filter(id => id !== "18"));
        // Room 18 stays a tap target through its outline: no traced neighbour takes its floor.
        expect(found && RoomColorDetector.roomIdAt(found, 235, 175)).toBeUndefined();
    });
});

describe("a room's own outline wins where the trace disagrees with it", () => {
    const scale = VACUUM_UNITS_PER_PIXEL;
    const outlineOf = ([left, top, right, bottom]: [number, number, number, number]) => [
        [left * scale, top * scale],
        [(right + 1) * scale, top * scale],
        [(right + 1) * scale, (bottom + 1) * scale],
        [left * scale, (bottom + 1) * scale],
    ];
    const detect = (map: SyntheticMap, rooms: Record<string, MapExtractorRoom>) =>
        RoomColorDetector.detectFromImageData(
            map,
            rooms,
            new CoordinatesConverter(syntheticMapCalibration(map.width, map.height)),
        );

    it("traces a room whose drawn floor matches its outline", () => {
        const map = new SyntheticMap(120, 60)
            .rect([10, 10, 59, 49], [230, 25, 75])
            .rect([62, 10, 109, 49], [60, 180, 75]);
        const detection = detect(map, {
            "1": { outline: outlineOf([10, 10, 59, 49]) } as unknown as MapExtractorRoom,
            "2": roomBounds([62, 10, 109, 49]),
        });
        expect(detection?.regions.map(region => region.id).sort()).toEqual(["1", "2"]);
    });

    it("keeps the outline when only part of it is drawn in the room's colour", () => {
        // Only the top third of room 1 is drawn in a room colour; the rest is grey. The trace is far
        // smaller than what the camera says the room is, so the camera's outline is kept.
        const map = new SyntheticMap(120, 60)
            .rect([10, 10, 59, 49], [200, 200, 200])
            .rect([10, 10, 59, 22], [230, 25, 75])
            .rect([62, 10, 109, 49], [60, 180, 75]);
        const detection = detect(map, {
            "1": { outline: outlineOf([10, 10, 59, 49]) } as unknown as MapExtractorRoom,
            "2": roomBounds([62, 10, 109, 49]),
        });
        expect(detection?.regions.map(region => region.id)).toEqual(["2"]);
        expect(detection?.complete).toBe(true);
    });

    it("keeps the outline when the room's colour runs on into an open-plan neighbour", () => {
        // Rooms 1 and 2 share one fill with no wall, and room 2 is not in the metadata at all: the
        // colour patch is twice the room, so the published outline is the better shape.
        const map = new SyntheticMap(120, 60).rect([10, 10, 109, 49], [230, 25, 75]);
        const detection = detect(map, { "1": { outline: outlineOf([10, 10, 59, 49]) } as unknown as MapExtractorRoom });
        expect(detection?.regions ?? []).toEqual([]);
    });
});
