import { describe, expect, it } from "vitest";

import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import { RoomColorDetector } from "../src/model/room-color-detector";
import type { MapExtractorRoom } from "../src/types/types";
import { Rect, Rgb, SyntheticMap, roomBounds, syntheticMapCalibration } from "./harness/synthetic-map";

/**
 * A budget for tracing a large map, so a slow change to the detector fails here rather than as a
 * frozen wall tablet. The map is 1024 x 1024 with 20 walled rooms covered in cleaning lanes: once
 * with a six-colour palette that repeats, and once in a single colour whose room bounds overlap, so
 * every room contests the colour and the shared-floor attribution runs over the whole map.
 *
 * Wall-clock budgets flake: test files run in parallel workers and CI runners are shared. The
 * detection is timed against a fixed reference workload measured in between, which slows down
 * with the machine the same way; the best of several runs of each is compared. Detection measured
 * about 18 to 19 times the reference (around 250-330 ms, alone and in the full parallel suite), so
 * the budget is about three times that. The card also reuses a detection for newer snapshots of
 * the same rooms (see room-detection-reuse.test.ts).
 */
const BUDGET_RATIO = 55;
const RUNS = 5;

/**
 * Every room of the grid drawn the same colour, with metadata bounds that reach past their walls
 * into their neighbours': every room then contests the colour, so the attribution pass labels the
 * colour's patches over the whole map and attributes each one. That is the slowest path the
 * detector has: it measured about 7% over the plain grid on the same machine (roughly 218 ms
 * against 204 ms), so the same budget covers it with the plain grid's headroom.
 */
const CONTESTED_BUDGET_RATIO = 55;

function largeMap(contested = false): { map: SyntheticMap; rooms: Record<string, MapExtractorRoom> } {
    const size = 1024;
    const map = new SyntheticMap(size, size, [19, 87, 148, 255]);
    const palette: Rgb[] = [
        [240, 178, 122],
        [133, 193, 233],
        [217, 136, 128],
        [88, 214, 141],
        [187, 143, 206],
        [247, 220, 111],
    ];
    const rooms: Record<string, MapExtractorRoom> = {};
    const columns = 5;
    const rows = 4;
    const cellWidth = Math.floor((size - 40) / columns);
    const cellHeight = Math.floor((size - 40) / rows);
    let index = 0;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++, index++) {
            const rect: Rect = [
                20 + column * cellWidth + 3,
                20 + row * cellHeight + 3,
                20 + (column + 1) * cellWidth - 3,
                20 + (row + 1) * cellHeight - 3,
            ];
            map.frame([rect[0] - 3, rect[1] - 3, rect[2] + 3, rect[3] + 3], [93, 109, 126], 3);
            map.rect(rect, palette[contested ? 1 : index % palette.length]);
            map.lanes([rect[0] + 4, rect[1] + 4, rect[2] - 4, rect[3] - 4], 6, [147, 194, 238], 1);
            rooms[String(index + 1)] = roomBounds(
                contested ? [rect[0] - 4, rect[1] - 4, rect[2] + 4, rect[3] + 4] : rect,
            );
        }
    }
    return { map, rooms };
}

/**
 * A fixed amount of plain pixel work: one 3 x 3 box blur over the map. Timed between detection
 * runs, it slows down with the machine (other test workers, a loaded CI runner) the way detection
 * does, so the budget is a ratio to it rather than a wall-clock time.
 */
function referenceWork(map: SyntheticMap): number {
    const { width, height, data } = map;
    const out = new Uint32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const row = (y + dy) * width;
                for (let dx = -1; dx <= 1; dx++) sum += data[(row + x + dx) * 4];
            }
            out[y * width + x] = sum;
        }
    }
    return out[width + 1];
}

describe("room detection performance", () => {
    it.each([
        { label: "a palette of six colours", contested: false, budget: BUDGET_RATIO },
        { label: "one colour on every room", contested: true, budget: CONTESTED_BUDGET_RATIO },
    ])(
        "traces 20 rooms on a 1024 x 1024 map ($label)",
        ({ contested, budget }) => {
            const { map, rooms } = largeMap(contested);
            const converter = new CoordinatesConverter(syntheticMapCalibration(map.width, map.height));
            let detection = RoomColorDetector.detectFromImageData(map, rooms, converter);
            referenceWork(map);
            let detectMs = Number.POSITIVE_INFINITY;
            let referenceMs = Number.POSITIVE_INFINITY;
            for (let run = 0; run < RUNS; run++) {
                let start = performance.now();
                referenceWork(map);
                referenceMs = Math.min(referenceMs, performance.now() - start);
                start = performance.now();
                detection = RoomColorDetector.detectFromImageData(map, rooms, converter);
                detectMs = Math.min(detectMs, performance.now() - start);
            }
            expect(detection?.regions).toHaveLength(20);
            expect(detection?.complete).toBe(true);
            expect(
                detectMs / referenceMs,
                `detection ${detectMs.toFixed(0)} ms against a ${referenceMs.toFixed(1)} ms reference`,
            ).toBeLessThan(budget);
        },
        60_000,
    );
});
