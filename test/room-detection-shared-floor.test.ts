/**
 * Room detection when two rooms share a fill colour and their bounding boxes interlock.
 *
 * The plain per-room trace (kept callable through `RoomColorDetector.detectFromImageData` with
 * `roomColorAttribution: false`, and frozen in `test/harness/master-room-detector.ts`) bridges the
 * wall between two interlocking same-coloured rooms, so one room's region takes the other's arm.
 * The attribution pass corrects that, but the requirement is "never worse": every scene here is run
 * through both traces and scored against a synthetic ground truth, and the attributed result must
 * be at least as good for every room while being clearly better where the plain trace is wrong.
 *
 * The ground truth of each scene is the floor the fixture paints, so it is exact: a rectangle or a
 * polygon known at construction. Pixels a path, the robot or furniture covers are excluded from
 * scoring, because both traces may legitimately label them and the fixture does not say which room
 * draws them.
 */
import { readFileSync } from "node:fs";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import { ImageDataLike, RoomColorDetection, RoomColorDetector } from "../src/model/room-color-detector";
import type { MapExtractorRoom } from "../src/types/types";
import { MasterRoomColorDetector } from "./harness/master-room-detector";
import {
    Rect,
    Rgb,
    SyntheticMap,
    roomBounds,
    syntheticMapCalibration,
    VACUUM_UNITS_PER_PIXEL,
} from "./harness/synthetic-map";

type Points = Array<[number, number]>;

const WALL: Rgb = [93, 109, 126];
const OUTSIDE: [number, number, number, number] = [19, 87, 148, 255];
const BLUE: Rgb = [133, 193, 233];
const PATH: Rgb = [147, 194, 238];
const FURNITURE: Rgb = [120, 120, 120];

const rectPoints = ([left, top, right, bottom]: Rect): Points => [
    [left, top],
    [right + 1, top],
    [right + 1, bottom + 1],
    [left, bottom + 1],
];

/** `outer` without `inner`, as the four bands around the inner rectangle. */
function ringAround(outer: Rect, inner: Rect): Points[] {
    const [left, top, right, bottom] = outer;
    const [innerLeft, innerTop, innerRight, innerBottom] = inner;
    return [
        rectPoints([left, top, right, innerTop - 1]),
        rectPoints([left, innerBottom + 1, right, bottom]),
        rectPoints([left, innerTop, innerLeft - 1, innerBottom]),
        rectPoints([innerRight + 1, innerTop, right, innerBottom]),
    ];
}

interface Scene {
    readonly name: string;
    readonly map: ImageDataLike;
    readonly rooms: Record<string, MapExtractorRoom>;
    /** The floor each room paints, as polygons. */
    readonly truth: Record<string, Points[]>;
    /** Every room that must be detected. */
    readonly detected: string[];
    /** The room a tap must select, or nothing. */
    readonly taps: Array<[number, number, string | undefined]>;
    /** Fill colour keys of the rooms, so pixels drawn over a floor can be left out of scoring. */
    readonly fills: Set<number>;
    /** The plain trace gets a room's floor wrong here, so the attributed result must be better. */
    readonly improves: boolean;
}

/** The polygon fill `SyntheticMap.polygon` paints, as a mask. */
function paintMask(width: number, height: number, shapes: Points[]): Uint8Array {
    const mask = new Uint8Array(width * height);
    for (const points of shapes) {
        const top = Math.floor(Math.min(...points.map(point => point[1])));
        const bottom = Math.ceil(Math.max(...points.map(point => point[1])));
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
                for (let x = Math.ceil(crossings[index] - 0.5); x + 0.5 <= crossings[index + 1]; x++) {
                    mask[y * width + x] = 1;
                }
            }
        }
    }
    return mask;
}

function boundsOf(points: Points): Rect {
    return [
        Math.min(...points.map(point => point[0])),
        Math.min(...points.map(point => point[1])),
        Math.max(...points.map(point => point[0])) - 1,
        Math.max(...points.map(point => point[1])) - 1,
    ];
}

function metadata(shape: Points, outline = false): MapExtractorRoom {
    if (!outline) return roomBounds(boundsOf(shape));
    return {
        ...roomBounds(boundsOf(shape)),
        outline: shape.map(([x, y]) => [x * VACUUM_UNITS_PER_PIXEL, y * VACUUM_UNITS_PER_PIXEL]),
    } as MapExtractorRoom;
}

function detect(map: ImageDataLike, rooms: Record<string, MapExtractorRoom>, attribution: boolean) {
    const converter = new CoordinatesConverter(syntheticMapCalibration(map.width, map.height));
    return RoomColorDetector.detectFromImageData(map, rooms, converter, { roomColorAttribution: attribution });
}

function masterDetect(map: ImageDataLike, rooms: Record<string, MapExtractorRoom>) {
    const converter = new CoordinatesConverter(syntheticMapCalibration(map.width, map.height));
    return MasterRoomColorDetector.detectFromImageData(map, rooms, converter);
}

/** Each room's label pixels, as masks over the image. */
function labelMasks(
    detection: RoomColorDetection | undefined,
    width: number,
    height: number,
): Record<string, Uint8Array> {
    const masks: Record<string, Uint8Array> = {};
    if (!detection) return masks;
    detection.labelRoomIds.forEach(id => (masks[id] = new Uint8Array(width * height)));
    detection.labels.forEach((label, index) => {
        if (label < 0) return;
        masks[detection.labelRoomIds[label]][index] = 1;
    });
    return masks;
}

/**
 * How much of a room's floor its label covers, and how much of its label is that floor: the Jaccard
 * index over the pixels of every room's painted floor, so claiming a neighbour's floor is a false
 * positive and losing one's own is a false negative. Pixels something is drawn over are left out:
 * both traces may label them and the fixture does not say which room owns them.
 */
function scores(
    detection: RoomColorDetection | undefined,
    scene: Scene,
): { total: number; perRoom: Record<string, number> } {
    const { width, height, data } = scene.map;
    const masks = labelMasks(detection, width, height);
    const perRoom: Record<string, number> = {};
    let total = 0;
    for (const id of Object.keys(scene.truth)) {
        const truth = paintMask(width, height, scene.truth[id]);
        const labels = masks[id] ?? new Uint8Array(width * height);
        let intersection = 0;
        let union = 0;
        for (let index = 0; index < truth.length; index++) {
            if (!labels[index] && !truth[index]) continue;
            const offset = index * 4;
            const floor =
                data[offset + 3] >= 128 &&
                scene.fills.has(RoomColorDetector.getColorKey(data[offset], data[offset + 1], data[offset + 2]));
            if (!labels[index] && !floor) continue;
            union++;
            if (labels[index] && truth[index]) intersection++;
        }
        const score = union === 0 ? 1 : intersection / union;
        perRoom[id] = score;
        total += score;
    }
    return { total, perRoom };
}

interface SceneOptions {
    readonly wall?: Rect;
    readonly draw?: (map: SyntheticMap) => void;
    readonly offset?: [number, number];
    readonly size?: [number, number];
}

/** The two same-coloured L-shaped rooms the feature is for. */
const A_SHAPE: Points = [
    [10, 10],
    [109, 10],
    [109, 39],
    [39, 39],
    [39, 109],
    [10, 109],
];
const B_SHAPE: Points = [
    [112, 10],
    [189, 10],
    [189, 109],
    [42, 109],
    [42, 42],
    [112, 42],
];

function interlockScene(
    name: string,
    { wall = [8, 8, 191, 111], draw, offset = [0, 0], size = [200, 120] as [number, number] }: SceneOptions = {},
    improves = true,
): Scene {
    const map = new SyntheticMap(size[0], size[1], OUTSIDE);
    const shift = (points: Points): Points => points.map(([x, y]) => [x + offset[0], y + offset[1]]);
    const shiftRect = (rect: Rect): Rect => [
        rect[0] + offset[0],
        rect[1] + offset[1],
        rect[2] + offset[0],
        rect[3] + offset[1],
    ];
    map.rect(shiftRect(wall), WALL);
    map.polygon(shift(A_SHAPE), BLUE);
    map.polygon(shift(B_SHAPE), BLUE);
    draw?.(map);
    return {
        name,
        map,
        rooms: { A: metadata(shift(A_SHAPE)), B: metadata(shift(B_SHAPE)) },
        truth: { A: [shift(A_SHAPE)], B: [shift(B_SHAPE)] },
        detected: ["A", "B"],
        taps: [
            [20 + offset[0], 80 + offset[1], "A"],
            [80 + offset[0], 20 + offset[1], "A"],
            [80 + offset[0], 80 + offset[1], "B"],
            [150 + offset[0], 30 + offset[1], "B"],
            [60 + offset[0], 70 + offset[1], "B"],
        ],
        fills: new Set([RoomColorDetector.getColorKey(...BLUE)]),
        improves,
    };
}

interface RectRoom {
    readonly id: string;
    readonly rect: Rect;
    readonly color?: Rgb;
    /** The painted floor, when it is not simply the rectangle (a nested closet, a ring). */
    readonly truth?: Points[];
}

function rectScene(
    name: string,
    width: number,
    height: number,
    background: [number, number, number, number],
    rooms: RectRoom[],
    options: { draw?: (map: SyntheticMap) => void; detected: string[]; taps: Scene["taps"]; improves?: boolean },
): Scene {
    const map = new SyntheticMap(width, height, background);
    const fills = new Set<number>();
    rooms.forEach(room => {
        const color = room.color ?? BLUE;
        map.rect(room.rect, color);
        fills.add(RoomColorDetector.getColorKey(...color));
    });
    options.draw?.(map);
    return {
        name,
        map,
        rooms: Object.fromEntries(rooms.map(room => [room.id, metadata(rectPoints(room.rect))])),
        truth: Object.fromEntries(rooms.map(room => [room.id, room.truth ?? [rectPoints(room.rect)]])),
        detected: options.detected,
        taps: options.taps,
        fills,
        improves: options.improves ?? false,
    };
}

function lKitchenScene(): Scene {
    const kitchen: Points = [
        [10, 10],
        [109, 10],
        [109, 29],
        [29, 29],
        [29, 109],
        [10, 109],
    ];
    const hall: Points = [
        [111, 10],
        [189, 10],
        [189, 109],
        [31, 109],
        [31, 31],
        [111, 31],
    ];
    const map = new SyntheticMap(200, 120, OUTSIDE);
    map.rect([8, 8, 191, 111], WALL);
    map.polygon(kitchen, BLUE);
    map.polygon(hall, BLUE);
    return {
        name: "L-shaped kitchen, 32% of its box, next to a hall arm filling 65%",
        map,
        rooms: { kitchen: metadata(kitchen), hall: metadata(hall) },
        truth: { kitchen: [kitchen], hall: [hall] },
        detected: ["kitchen", "hall"],
        taps: [
            [20, 20, "kitchen"],
            [20, 80, "kitchen"],
            [60, 60, "hall"],
            [100, 80, "hall"],
            [150, 60, "hall"],
        ],
        fills: new Set([RoomColorDetector.getColorKey(...BLUE)]),
        improves: true,
    };
}

function pngScene(
    relative: string,
    name: string,
    options: {
        rooms: Record<string, Rect>;
        truth?: Record<string, Points[]>;
        fills: Array<[number, number, number]>;
        taps: Scene["taps"];
        improves?: boolean;
    },
): Scene {
    const png = PNG.sync.read(readFileSync(`${__dirname}/fixtures/${relative}`));
    return {
        name,
        map: { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) },
        rooms: Object.fromEntries(Object.entries(options.rooms).map(([id, rect]) => [id, roomBounds(rect)])),
        truth:
            options.truth ??
            Object.fromEntries(Object.entries(options.rooms).map(([id, rect]) => [id, [rectPoints(rect)]])),
        detected: Object.keys(options.rooms),
        taps: options.taps,
        fills: new Set(options.fills.map(([red, green, blue]) => RoomColorDetector.getColorKey(red, green, blue))),
        improves: options.improves ?? false,
    };
}

/** The scenes every run covers: the committed fixtures and the cases this feature exists for. */
function scenes(): Scene[] {
    const atUnion: Rect = [10, 10, 189, 109];
    return [
        // The committed PNG fixtures.
        pngScene("synthetic/map.png", "committed map.png: three rooms", {
            rooms: { "0": [20, 20, 79, 69], "1": [100, 20, 169, 69], "2": [20, 90, 79, 129] },
            fills: [
                [230, 25, 75],
                [60, 180, 75],
                [67, 99, 216],
            ],
            taps: [
                [50, 45, "0"],
                [135, 45, "1"],
                [50, 110, "2"],
            ],
        }),
        pngScene("synthetic/interlock.png", "committed interlock.png", {
            rooms: { kitchen: boundsOf(A_SHAPE), hall: boundsOf(B_SHAPE) },
            truth: { kitchen: [A_SHAPE], hall: [B_SHAPE] },
            fills: [[...BLUE]],
            taps: [
                [80, 20, "kitchen"],
                [20, 80, "kitchen"],
                [80, 80, "hall"],
                [150, 30, "hall"],
            ],
            improves: true,
        }),

        // The original interlocking pair, the wall band protruding past the bounds and exactly on
        // their union: the trace must not depend on the band.
        interlockScene("interlock, wall band 8 px outside the bounds"),
        interlockScene("interlock, wall band on the bounds union", { wall: atUnion }),

        // A path cut through one room, both rooms and both wall bands.
        interlockScene("interlock, path cut through A", {
            draw: map => map.line(90, 10, 90, 39, PATH, 2),
        }),
        interlockScene("interlock, path cut through B", {
            draw: map => map.line(100, 42, 100, 109, PATH, 2),
        }),
        interlockScene("interlock, path cut through A, band on the union", {
            wall: atUnion,
            draw: map => map.line(90, 10, 90, 39, PATH, 2),
        }),
        interlockScene("interlock, path cut through B, band on the union", {
            wall: atUnion,
            draw: map => map.line(100, 42, 100, 109, PATH, 2),
        }),
        interlockScene("interlock, furniture cut through A", {
            draw: map => map.rect([88, 10, 92, 38], FURNITURE),
        }),
        interlockScene("interlock, furniture cut through B", {
            draw: map => map.rect([98, 42, 102, 108], FURNITURE),
        }),
        interlockScene("interlock, furniture cut through B, band on the union", {
            wall: atUnion,
            draw: map => map.rect([98, 42, 102, 108], FURNITURE),
        }),

        // A map with no margin: the plan is cropped to its wall band, so no pixel of the image lies
        // outside every room's bounds.
        interlockScene("interlock, no margin", { offset: [-8, -8], size: [184, 104] }),

        // A path drawn outside every room, along the map edge.
        interlockScene("interlock, path outside every room", {
            draw: map => {
                map.line(4, 4, 4, 115, PATH, 2);
                map.line(4, 4, 195, 4, PATH, 2);
            },
        }),

        // The reported regression: an L-shaped kitchen whose floor is 32% of its bounding box next
        // to a same-coloured hall whose arm fills 65% of that box.
        lKitchenScene(),

        // Same-coloured rooms whose fills touch with no wall between them.
        rectScene(
            "open plan, fills touching",
            200,
            80,
            OUTSIDE,
            [
                { id: "A", rect: [10, 10, 99, 69] },
                { id: "B", rect: [100, 10, 189, 69] },
            ],
            {
                detected: ["A", "B"],
                taps: [
                    [50, 40, "A"],
                    [150, 40, "B"],
                ],
            },
        ),

        // A closet without a frame: its fill touches the big room's floor, and the big room's floor
        // is its rectangle minus the closet.
        rectScene(
            "closet without a frame",
            160,
            120,
            OUTSIDE,
            [
                { id: "A", rect: [10, 10, 149, 109], truth: ringAround([10, 10, 149, 109], [60, 40, 91, 71]) },
                { id: "B", rect: [60, 40, 91, 71] },
            ],
            {
                detected: ["A", "B"],
                taps: [
                    [30, 30, "A"],
                    [75, 55, "B"],
                ],
            },
        ),

        // The map styles the existing detection tests paint, kept in the differential run too.
        ...styleScenes(),
    ];
}

/** A scene whose plan is drawn by hand, with the metadata and ground truth given explicitly. */
function mapScene(
    name: string,
    map: SyntheticMap,
    rooms: Record<string, MapExtractorRoom>,
    truth: Record<string, Points[]>,
    taps: Scene["taps"],
    fills: Rgb[],
    improves = false,
): Scene {
    return {
        name,
        map,
        rooms,
        truth,
        detected: Object.keys(rooms),
        taps,
        fills: new Set(fills.map(color => RoomColorDetector.getColorKey(...color))),
        improves,
    };
}

/** The map styles the existing detection tests cover, kept in the differential run too. */
function styleScenes(): Scene[] {
    // Xiaomi Cloud Map Extractor: walls, a repeated palette colour, lanes, a long path, a no-go
    // zone, a virtual wall, the robot and the charger.
    const extractorRooms: Record<string, { rect: Rect; color: Rgb }> = {
        "16": { rect: [12, 12, 101, 81], color: [240, 178, 122] },
        "17": { rect: [108, 12, 187, 81], color: [133, 193, 233] },
        "18": { rect: [12, 88, 101, 147], color: [217, 136, 128] },
        "19": { rect: [108, 88, 187, 147], color: [88, 214, 141] },
        "20": { rect: [194, 88, 247, 147], color: [133, 193, 233] },
    };
    const extractor = new SyntheticMap(260, 160, [19, 87, 148, 255]);
    Object.values(extractorRooms).forEach(room => {
        extractor.rect([room.rect[0] - 3, room.rect[1] - 3, room.rect[2] + 3, room.rect[3] + 3], WALL);
        extractor.rect(room.rect, room.color);
    });
    extractor.lanes([16, 16, 97, 77], 6, PATH, 1);
    extractor.lanes([112, 92, 183, 143], 5, PATH, 2);
    extractor.line(20, 40, 240, 120, PATH, 1);
    extractor.blendRect([30, 100, 60, 130], [255, 33, 55], 0.5).frame([30, 100, 60, 130], [255, 33, 55], 1);
    extractor.line(150, 20, 150, 75, [255, 0, 0], 2);
    extractor.disc(148, 46, 7, [75, 235, 149]);
    extractor.disc(148, 46, 3, [255, 255, 255]);
    extractor.disc(56, 14, 5, [102, 254, 218]);

    // Valetudo: a transparent outside, four colours on seven rooms, white lanes and a robot.
    const valetudoPalette: Rgb[] = [
        [25, 161, 161],
        [122, 192, 55],
        [223, 86, 24],
        [247, 200, 65],
    ];
    const valetudoRooms: Record<string, { rect: Rect; color: Rgb }> = {
        "1": { rect: [10, 10, 69, 59], color: valetudoPalette[0] },
        "2": { rect: [72, 10, 131, 59], color: valetudoPalette[1] },
        "3": { rect: [134, 10, 193, 59], color: valetudoPalette[0] },
        "4": { rect: [10, 62, 69, 111], color: valetudoPalette[2] },
        "5": { rect: [72, 62, 131, 111], color: valetudoPalette[3] },
        "6": { rect: [134, 62, 193, 111], color: valetudoPalette[2] },
        "7": { rect: [196, 10, 239, 111], color: valetudoPalette[3] },
    };
    const valetudo = new SyntheticMap(250, 122, [0, 0, 0, 0]);
    Object.values(valetudoRooms).forEach(room => {
        valetudo.rect([room.rect[0] - 2, room.rect[1] - 2, room.rect[2] + 2, room.rect[3] + 2], [0, 0, 0]);
        valetudo.rect(room.rect, room.color);
    });
    valetudo.lanes([12, 12, 128, 108], 4, [255, 255, 255], 2);
    valetudo.disc(101, 86, 8, [255, 255, 255], true);
    valetudo.disc(101, 86, 5, [60, 60, 60], true);

    // Dreame: smoothed edges and an icon and a name inside every room.
    const dreamePalette: Rgb[] = [
        [171, 199, 248],
        [249, 224, 125],
        [184, 227, 255],
        [255, 194, 135],
    ];
    const dreameRooms: Record<string, { rect: Rect; color: Rgb }> = {
        "1": { rect: [10, 10, 99, 79], color: dreamePalette[0] },
        "2": { rect: [103, 10, 179, 79], color: dreamePalette[1] },
        "3": { rect: [10, 83, 99, 149], color: dreamePalette[3] },
        "4": { rect: [103, 83, 179, 149], color: dreamePalette[0] },
    };
    const dreame = new SyntheticMap(190, 160, [0, 0, 0, 0]);
    Object.values(dreameRooms).forEach(room => {
        dreame.rect([room.rect[0] - 2, room.rect[1] - 2, room.rect[2] + 2, room.rect[3] + 2], [80, 80, 80]);
        dreame.rect(room.rect, room.color);
    });
    Object.values(dreameRooms).forEach(room => {
        const [x, y] = [(room.rect[0] + room.rect[2]) >> 1, (room.rect[1] + room.rect[3]) >> 1];
        dreame.disc(x, y, 11, [255, 255, 255], true);
        dreame.rect([x - 4, y - 5, x + 4, y + 3], [90, 90, 90]);
        dreame.rect([x - 16, y + 14, x + 16, y + 19], [60, 60, 60]);
    });
    dreame.disc(140, 30, 8, [255, 255, 255], true);
    dreame.antialiasEdges();

    const truthOf = (rooms: Record<string, { rect: Rect }>): Record<string, Points[]> =>
        Object.fromEntries(Object.entries(rooms).map(([id, room]) => [id, [rectPoints(room.rect)]]));
    const metadataOf = (rooms: Record<string, { rect: Rect }>): Record<string, MapExtractorRoom> =>
        Object.fromEntries(Object.entries(rooms).map(([id, room]) => [id, roomBounds(room.rect)]));

    return [
        mapScene(
            "Xiaomi Cloud Map Extractor style",
            extractor,
            metadataOf(extractorRooms),
            truthOf(extractorRooms),
            [
                [148, 46, "17"],
                [56, 15, "16"],
                [150, 30, "17"],
                [45, 115, "18"],
                [140, 100, "19"],
                [220, 100, "20"],
            ],
            Object.values(extractorRooms).map(room => room.color),
        ),
        mapScene(
            "Valetudo style",
            valetudo,
            metadataOf(valetudoRooms),
            truthOf(valetudoRooms),
            [
                [40, 35, "1"],
                [101, 35, "2"],
                [163, 35, "3"],
                [40, 86, "4"],
                [101, 86, "5"],
                [163, 86, "6"],
                [218, 60, "7"],
            ],
            Object.values(valetudoRooms).map(room => room.color),
        ),
        mapScene(
            "Dreame style, smoothed edges",
            dreame,
            metadataOf(dreameRooms),
            truthOf(dreameRooms),
            [
                [55, 45, "1"],
                [141, 45, "2"],
                [55, 116, "3"],
                [141, 116, "4"],
            ],
            Object.values(dreameRooms).map(room => room.color),
        ),
    ];
}

function tapOf(detection: RoomColorDetection | undefined, x: number, y: number): string | undefined {
    return detection ? RoomColorDetector.roomIdAt(detection, x, y) : undefined;
}

describe("shared-floor attribution is never worse than the plain trace", () => {
    it.each(scenes().map(scene => [scene.name, scene] as const))("%s", (_name, scene) => {
        const plain = masterDetect(scene.map, scene.rooms);
        const attributed = detect(scene.map, scene.rooms, true);
        const reference = detect(scene.map, scene.rooms, false);

        // The reference path is the plain trace, byte for byte: the guard compares against it.
        expect(reference?.labels).toEqual(plain?.labels);
        expect(reference?.regions.map(region => region.id)).toEqual(plain?.regions.map(region => region.id));

        expect((attributed?.regions ?? []).map(region => region.id).sort()).toEqual([...scene.detected].sort());
        for (const [x, y, expected] of scene.taps) {
            expect(tapOf(attributed, x, y), `tap at ${x},${y}`).toBe(expected);
        }

        const plainScores = scores(plain, scene);
        const attributedScores = scores(attributed, scene);
        for (const id of Object.keys(scene.truth)) {
            expect(attributedScores.perRoom[id], `room ${id} got worse`).toBeGreaterThanOrEqual(
                plainScores.perRoom[id] - 0.01,
            );
        }
        expect(attributedScores.total).toBeGreaterThanOrEqual(plainScores.total - 1e-9);
        if (scene.improves) expect(attributedScores.total).toBeGreaterThan(plainScores.total + 0.01);
        if (process.env.SCORE_LOG)
            console.log(
                `${scene.name} | plain ${JSON.stringify(plainScores.perRoom)} ${plainScores.total.toFixed(3)} | attributed ${JSON.stringify(attributedScores.perRoom)} ${attributedScores.total.toFixed(3)}`,
            );
    });
});

describe("interlocking same-coloured rooms keep their own floor", () => {
    it("gives each room the area of its own L shape", () => {
        const scene = interlockScene("interlock");
        const detection = detect(scene.map, scene.rooms, true);
        const area = (points: Points): number =>
            Math.abs(
                points.reduce((sum, point, index) => {
                    const next = points[(index + 1) % points.length];
                    return sum + point[0] * next[1] - next[0] * point[1];
                }, 0) / 2,
            );
        for (const [id, shape] of [
            ["A", A_SHAPE],
            ["B", B_SHAPE],
        ] as const) {
            const region = detection?.regions.find(candidate => candidate.id === id);
            expect(region, `room ${id} was not detected`).toBeDefined();
            const found = area(region!.outline as Points);
            expect(Math.abs(found - area(shape)), `room ${id} area ${found} vs ${area(shape)}`).toBeLessThan(
                area(shape) * 0.1,
            );
        }
    });

    it("leaves a room that publishes its own outline to that outline", () => {
        // A camera that publishes B's own outline leaves B to it: only A is traced, and the pixels
        // of B's shape are reserved. The attribution must not take them either time: this is the
        // plain trace's result, kept because a reserved shape cannot be given a floor patch.
        const scene = interlockScene("outlined");
        const rooms = { A: roomBounds(boundsOf(A_SHAPE)), B: metadata(B_SHAPE, true) };
        const traced = detect(scene.map, rooms, true);
        expect((traced?.regions ?? []).map(region => region.id)).toEqual(["A"]);
        expect(tapOf(traced, 80, 20)).toBe("A");
    });
});
