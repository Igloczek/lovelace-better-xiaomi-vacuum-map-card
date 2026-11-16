import { afterEach, describe, expect, it } from "vitest";

import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle } from "../harness";
import {
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    settle,
    syntheticCalibrationPoints,
    useHarnessClock,
    withState,
} from "../harness";
import { validateConfig } from "../../src/config-validators";

/**
 * Live path overlay (#47): with `live_path`, the card draws the robot and the path it drove from a
 * position attribute, over the camera map or a static floorplan image.
 */

const VACUUM = "vacuum.roborock_s7";
const CAMERA = "camera.vacuum_map";
const POSITION_SENSOR = "sensor.vacuum_position";

function config(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        tiles: [],
        icons: [],
        persist_map_view: false,
        live_path: true,
        ...overrides,
    };
}

async function mount(overrides: Partial<XiaomiVacuumMapCardConfig> = {}, vacuumState?: string): Promise<CardHandle> {
    useHarnessClock();
    let hass = withState(fixtureHass(loadSyntheticFixture()), POSITION_SENSOR, { state: "ok", attributes: {} }).hass;
    if (vacuumState) hass = withState(hass, VACUUM, { state: vacuumState }).hass;
    const card = await mountCard(config(overrides), hass);
    await card.fireMapLoad();
    return card;
}

async function drive(card: CardHandle, entity: string, state: string, position: unknown): Promise<void> {
    const withVacuum = withState(card.hass, VACUUM, { state }).hass;
    const previous = withVacuum.states[entity];
    const next = withState(withVacuum, entity, {
        attributes: { ...(previous?.attributes ?? {}), vacuum_position: position },
    }).hass;
    await card.updateHass(next);
    await settle(card.element);
}

/** The polyline's points as numbers, in the map's layout pixels. */
function linePoints(card: CardHandle): number[][] {
    const line = card.shadowRoot.querySelector("#svg-wrapper .live-path-line");
    if (!line) return [];
    return (line.getAttribute("points") ?? "")
        .trim()
        .split(/\s+/)
        .map(p => p.split(",").map(Number));
}

/** The synthetic calibration maps vacuum millimetres to pixels by dividing by ten. */
function layout(card: CardHandle, x: number, y: number): number[] {
    const scale = card.element.realScale;
    return [(x / 10) * scale, (y / 10) * scale];
}

describe("live path overlay", () => {
    afterEach(() => window.localStorage.clear());

    it("draws nothing without live_path", async () => {
        const card = await mount({ live_path: undefined });
        await drive(card, CAMERA, "cleaning", { x: 100, y: 100, a: 0 });
        expect(card.shadowRoot.querySelector(".live-path")).toBeNull();
    });

    it("draws the robot while docked and the path once it cleans, in map layout pixels", async () => {
        const card = await mount();
        await drive(card, CAMERA, "docked", { x: 100, y: 100, a: 0 });
        expect(card.shadowRoot.querySelector(".live-path-robot")).not.toBeNull();
        expect(linePoints(card)).toEqual([]);

        await drive(card, CAMERA, "cleaning", { x: 100, y: 100, a: 0 });
        await drive(card, CAMERA, "cleaning", { x: 800, y: 100, a: 0 });
        await drive(card, CAMERA, "cleaning", { x: 800, y: 900, a: 90 });

        const expected = [layout(card, 100, 100), layout(card, 800, 100), layout(card, 800, 900)];
        const points = linePoints(card);
        expect(points.length).toBe(3);
        points.forEach((p, i) => {
            expect(p[0]).toBeCloseTo(expected[i][0], 6);
            expect(p[1]).toBeCloseTo(expected[i][1], 6);
        });

        const robot = card.shadowRoot.querySelector(".live-path-robot");
        const [hx, hy] = expected[2];
        expect(robot?.getAttribute("transform")).toContain(`translate(${hx} ${hy})`);
        // `a` is counter-clockwise from the vacuum's +x axis; with this calibration (+y down on
        // both sides) 90° points down the screen.
        expect(robot?.querySelector(".live-path-robot-heading")?.getAttribute("transform")).toBe("rotate(90)");
        expect(card.shadowRoot.querySelector(".live-path")?.getAttribute("pointer-events")).toBe("none");
    });

    it("keeps the path after docking and starts afresh on the next run", async () => {
        const card = await mount();
        await drive(card, CAMERA, "cleaning", { x: 100, y: 100 });
        await drive(card, CAMERA, "cleaning", { x: 500, y: 100 });
        await drive(card, CAMERA, "docked", { x: 100, y: 100 });
        // The run's own line stays; the robot's later position is not joined to it.
        expect(linePoints(card)).toEqual([layout(card, 100, 100), layout(card, 500, 100)]);

        await drive(card, CAMERA, "cleaning", { x: 100, y: 100 });
        expect(linePoints(card)).toEqual([]);
    });

    it("redraws the stored track with the camera's new calibration when the image grows", async () => {
        const card = await mount();
        await drive(card, CAMERA, "cleaning", { x: 100, y: 100 });
        await drive(card, CAMERA, "cleaning", { x: 500, y: 100 });
        const before = linePoints(card);
        // Dreame: the pixel side of the calibration moves when the rendered image grows.
        const shifted = syntheticCalibrationPoints().map(p => ({ ...p, map: { x: p.map.x, y: p.map.y + 20 } }));
        const camera = card.hass.states[CAMERA];
        await card.updateHass(
            withState(card.hass, CAMERA, { attributes: { ...camera.attributes, calibration_points: shifted } }).hass,
        );
        await settle(card.element);
        const after = linePoints(card);
        expect(after.length).toBe(before.length);
        after.forEach((p, i) => expect(p[1] - before[i][1]).toBeCloseTo(20 * card.element.realScale, 6));
    });

    it("keeps the path across a reload", async () => {
        const card = await mount();
        await drive(card, CAMERA, "cleaning", { x: 100, y: 100 });
        await drive(card, CAMERA, "cleaning", { x: 500, y: 100 });
        await card.cleanup();

        // The page reloads mid-run: Home Assistant still reports the vacuum cleaning.
        const reloaded = await mount({}, "cleaning");
        await drive(reloaded, CAMERA, "cleaning", { x: 500, y: 600 });
        expect(linePoints(reloaded).length).toBe(3);
    });

    it("reads the position from another entity over a static floorplan", async () => {
        const card = await mount({
            map_source: { image: "/local/floorplan.png" },
            calibration_source: { calibration_points: syntheticCalibrationPoints() },
            live_path: { entity: POSITION_SENSOR, attribute: "vacuum_position" },
        });
        await drive(card, POSITION_SENSOR, "cleaning", [100, 100]);
        await drive(card, POSITION_SENSOR, "cleaning", [300, 400]);
        const points = linePoints(card);
        expect(points.length).toBe(2);
        expect(points[1][0]).toBeCloseTo(layout(card, 300, 400)[0], 6);
    });
});

describe("live_path validation", () => {
    function errors(overrides: Partial<XiaomiVacuumMapCardConfig>): string[] {
        return validateConfig(config(overrides)).map(e => JSON.stringify(e));
    }

    it("accepts true, false and a mapping", () => {
        expect(errors({ live_path: true })).toEqual([]);
        expect(errors({ live_path: false })).toEqual([]);
        expect(errors({ live_path: { entity: POSITION_SENSOR, attribute: "pos" } })).toEqual([]);
    });

    it("needs an entity when the map is an image", () => {
        const result = errors({
            map_source: { image: "/local/floorplan.png" },
            calibration_source: { calibration_points: syntheticCalibrationPoints() },
            live_path: true,
        });
        expect(result.join()).toContain("live_path");
    });

    it("rejects other shapes", () => {
        expect(errors({ live_path: "yes" as unknown as boolean }).join()).toContain("live_path");
        expect(errors({ live_path: { entity: 3 } as unknown as { entity: string } }).join()).toContain("live_path");
    });
});
