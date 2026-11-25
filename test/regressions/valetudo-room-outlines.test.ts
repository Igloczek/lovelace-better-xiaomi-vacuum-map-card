import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HassEntity } from "home-assistant-js-websocket";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomColorDetector } from "../../src/model/room-color-detector";
import type { MapModeConfig, RoomConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import {
    fixtureConfig,
    fixtureStates,
    loadSyntheticFixture,
    mockHass,
    mountCard,
    settle,
    useHarnessClock,
} from "../harness";

/**
 * Issue #77: on a Valetudo map camera the card drew each room's published outline as it was. sca075's
 * MQTT Vacuum Camera publishes only a convex hull per room (no bounds), so an L-shaped or notched
 * room's outline covered its neighbour's floor, and its label sat on the hull's bounding-box centre.
 * The card now traces those rooms from the map colours like rooms published with bounds.
 *
 * The suite missed it because every detection fixture published bounds; the only outline tests used
 * exact rectangles, where the published outline happens to be right. The apartment fixture now has a
 * Valetudo camera (`test/fixtures/apartment/camera-valetudo.json`) that publishes the hulls.
 */

const APARTMENT = join(__dirname, "..", "fixtures", "apartment");
const VALETUDO = JSON.parse(readFileSync(join(APARTMENT, "camera-valetudo.json"), "utf8")) as HassEntity;
const png = PNG.sync.read(readFileSync(join(APARTMENT, "map.png")));
const MAP = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
const FLOOR = JSON.parse(readFileSync(join(APARTMENT, "floor.json"), "utf8")) as Record<
    string,
    Array<[number, number]>
>;

function config(): XiaomiVacuumMapCardConfig {
    const bundle = loadSyntheticFixture();
    return {
        ...fixtureConfig(bundle),
        map_source: { camera: VALETUDO.entity_id },
        vacuum_platform: "Hypfer/Valetudo",
        internal_variables: { topic: "valetudo/robot" },
        map_modes: [{ template: "vacuum_clean_segment", max_selections: 10 } as MapModeConfig],
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

async function mount() {
    useHarnessClock();
    // happy-dom has no canvas pixels: the detection runs on the fixture PNG instead of the <img>.
    vi.spyOn(RoomColorDetector, "detect").mockImplementation((_image, rooms, converter) =>
        RoomColorDetector.detectFromImageData(MAP, rooms, converter),
    );
    const bundle = loadSyntheticFixture();
    const hass = mockHass({
        states: { ...fixtureStates(bundle), [VALETUDO.entity_id]: VALETUDO },
        entities: bundle.registry,
    });
    const card = await mountCard(config(), hass);
    await card.fireMapLoad({ width: MAP.width, height: MAP.height });
    await settle(card.element);
    return card;
}

function inside(points: Array<[number, number]>, x: number, y: number): boolean {
    let result = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
        const [xi, yi] = points[index];
        const [xj, yj] = points[previous];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
    }
    return result;
}

describe("Valetudo room outlines (#77)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("draws every room from the map, not from the published convex hull", async () => {
        const card = await mount();
        const rooms = card.element.selectableRooms;
        expect(rooms.map(room => String(room.toVacuum())).sort()).toEqual(Object.keys(FLOOR).sort());
        for (const room of rooms) expect(room.hasImageOutline, `room ${room.toVacuum()}`).toBe(true);
        // Korytarz's hull covers Schowek and WC; the drawn outline must not.
        const korytarz = rooms.find(room => String(room.toVacuum()) === "13")!;
        const outline = (korytarz as unknown as { _imageOutline: Array<[number, number]> })._imageOutline;
        expect(outline).toBeDefined();
        expect(inside(outline, 180.5, 108.5)).toBe(false);
        expect(inside(outline, 180.5, 130.5)).toBe(false);
    });

    it("puts each label on its traced room, not on the hull's bounding-box centre", async () => {
        const card = await mount();
        const converter = card.element.coordinatesConverter!;
        for (const room of card.element.selectableRooms) {
            const id = String(room.toVacuum());
            const label = (room as unknown as { _config: RoomConfig })._config.label!;
            const region = card.element.roomColorDetection!.regions.find(candidate => candidate.id === id)!;
            const [x, y] = converter.vacuumToMap(label.x, label.y);
            expect([x, y], `room ${id}`).toEqual([
                expect.closeTo(region.center[0], 0),
                expect.closeTo(region.center[1], 0),
            ]);
            expect(inside(FLOOR[id], x, y), `room ${id} label at ${x},${y}`).toBe(true);
        }
    });
});
