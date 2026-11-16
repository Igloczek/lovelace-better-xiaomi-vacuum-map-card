import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * The live path overlay (#47), proven by the pixels the browser paints, in Chromium and WebKit
 * (the Home Assistant macOS app). WebKit has painted map overlays away from their layout boxes
 * before, so nothing here reads an overlay's DOM box: the expected screen point is computed from
 * the map image's own rectangle and the fixture's calibration (10 vacuum units per image pixel),
 * and the screenshot must show the path's and the robot's colours there.
 */

const LINE = { r: 255, g: 0, b: 255 };
const ROBOT = { r: 0, g: 160, b: 0 };

/** Image-pixel points of the drive, over the fixture's background below the rooms. */
const DRIVE: [number, number][] = [
    [60, 130],
    [100, 130],
    [125, 130],
];

interface VisualWindow {
    visualHarness: {
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
        setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<{ mapScale: number }>;
        card: HTMLElement & Record<string, unknown>;
        hass: Record<string, unknown>;
    };
}

function cardConfig(rotation: number): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [{ template: "vacuum_clean_segment" }],
        tiles: [],
        icons: [],
        persist_map_view: false,
        map_rotation: rotation,
        live_path: true,
    };
}

async function drive(page: Page, state: string, point: [number, number], heading: number): Promise<void> {
    await page.evaluate(
        async ({ state, point, heading }) => {
            const harness = (window as unknown as VisualWindow).visualHarness;
            const card = harness.card as unknown as {
                hass: { states: Record<string, any> };
                updateComplete: Promise<unknown>;
            };
            const states = { ...card.hass.states };
            states["vacuum.roborock_s7"] = { ...states["vacuum.roborock_s7"], state };
            const camera = states["camera.vacuum_map"];
            states["camera.vacuum_map"] = {
                ...camera,
                attributes: {
                    ...camera.attributes,
                    vacuum_position: { x: point[0] * 10, y: point[1] * 10, a: heading },
                },
            };
            card.hass = { ...card.hass, states };
            await card.updateComplete;
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        },
        { state, point, heading },
    );
}

/** Where an image pixel lands on screen, from the map image's painted rectangle. */
async function screenPoint(page: Page, [px, py]: [number, number], rotation: number): Promise<[number, number]> {
    return page.evaluate(
        ({ px, py, rotation }) => {
            const card = (window as unknown as VisualWindow).visualHarness.card;
            const image = card.shadowRoot!.getElementById("map-image") as HTMLCanvasElement;
            const rect = image.getBoundingClientRect();
            const source = card.shadowRoot!.getElementById("map-image-source") as HTMLImageElement;
            const u = px / source.naturalWidth;
            const v = py / source.naturalHeight;
            if (rotation === 90) return [rect.left + (1 - v) * rect.width, rect.top + u * rect.height];
            return [rect.left + u * rect.width, rect.top + v * rect.height];
        },
        { px, py, rotation },
    ) as Promise<[number, number]>;
}

function closeTo(png: PNG, [x, y]: [number, number], colour: { r: number; g: number; b: number }): boolean {
    // Any pixel within 2 px: the line is antialiased at its edges.
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            const i = (Math.round(y + dy) * png.width + Math.round(x + dx)) * 4;
            const d =
                Math.abs(png.data[i] - colour.r) +
                Math.abs(png.data[i + 1] - colour.g) +
                Math.abs(png.data[i + 2] - colour.b);
            if (d < 40) return true;
        }
    }
    return false;
}

async function screenshot(page: Page): Promise<PNG> {
    return PNG.sync.read(await page.screenshot());
}

for (const zoom of [1, 2.5]) {
    for (const rotation of [0, 90]) {
        test(`the path and robot are painted where the calibration puts them at zoom ${zoom}, rotation ${rotation}`, async ({
            page,
        }) => {
            await page.goto("/");
            await page.addStyleTag({
                content: `better-xiaomi-vacuum-map-card {
                    --map-card-live-path-color: rgb(${LINE.r}, ${LINE.g}, ${LINE.b});
                    --map-card-live-path-opacity: 1;
                    --map-card-live-path-width: 6px;
                    --map-card-live-path-robot-color: rgb(${ROBOT.r}, ${ROBOT.g}, ${ROBOT.b});
                }`,
            });
            await page.evaluate(
                config => (window as unknown as VisualWindow).visualHarness.mount(config),
                cardConfig(rotation),
            );
            await page.evaluate(
                z => (window as unknown as VisualWindow).visualHarness.setZoom(z, { x: 0.5, y: 130 / 150 }),
                zoom,
            );

            const lineMid: [number, number] = [85, 130];
            const before = await screenshot(page);
            expect(closeTo(before, await screenPoint(page, lineMid, rotation), LINE)).toBe(false);

            for (const point of DRIVE) await drive(page, "cleaning", point, 0);
            const after = await screenshot(page);
            expect(closeTo(after, await screenPoint(page, lineMid, rotation), LINE)).toBe(true);
            expect(closeTo(after, await screenPoint(page, [115, 130], rotation), LINE)).toBe(true);
            expect(closeTo(after, await screenPoint(page, DRIVE[2], rotation), ROBOT)).toBe(true);
            // Off the path, nothing is painted in its colour.
            expect(closeTo(after, await screenPoint(page, [85, 110], rotation), LINE)).toBe(false);

            // After docking the path stays; the next run starts a new one.
            await drive(page, "docked", DRIVE[2], 0);
            expect(closeTo(await screenshot(page), await screenPoint(page, lineMid, rotation), LINE)).toBe(true);
            await drive(page, "cleaning", DRIVE[2], 0);
            expect(closeTo(await screenshot(page), await screenPoint(page, lineMid, rotation), LINE)).toBe(false);
        });
    }
}
