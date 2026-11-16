import type { Page } from "@playwright/test";
import { PNG } from "pngjs";

import { freshAccessToken } from "../support/ha-websocket";
import { expect, openDashboard, serviceCall, shot, test, waitForCard } from "./helpers";

/**
 * The live path overlay (#47) in the real frontend: the fake vacuum's real state and a position
 * entity Home Assistant publishes, followed through the frontend's own `hass` updates. The card is
 * created in the page (no dashboard is changed) and proven by the pixels in a screenshot, located
 * from the map image's rectangle and the calibration, never from the overlay's DOM boxes.
 */

const VACUUM = "vacuum.fake_vacuum";
const POSITION = "sensor.e2e_live_position";
const LINE = { r: 255, g: 0, b: 255 };
const ROBOT = { r: 0, g: 160, b: 0 };
/** 10 vacuum units per image pixel on the 200 x 150 fixture map. */
const CALIBRATION = [
    { map: { x: 0, y: 0 }, vacuum: { x: 0, y: 0 } },
    { map: { x: 200, y: 0 }, vacuum: { x: 2000, y: 0 } },
    { map: { x: 0, y: 150 }, vacuum: { x: 0, y: 1500 } },
];

async function setPosition(page: Page, x: number, y: number): Promise<void> {
    const token = await freshAccessToken();
    const response = await page.request.post(`/api/states/${POSITION}`, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        data: { state: "ok", attributes: { vacuum_position: { x: x * 10, y: y * 10, a: 0 } } },
    });
    if (!response.ok()) throw new Error(`position update failed: ${response.status()}`);
}

async function mountCard(page: Page): Promise<void> {
    await page.evaluate(
        async ({ calibration, vacuum, position, line, robot }) => {
            const root = document.querySelector("home-assistant") as any;
            const element = document.createElement("better-xiaomi-vacuum-map-card") as any;
            element.id = "e2e-live-path";
            element.style.cssText = `position: fixed; left: 0; top: 0; width: 600px; z-index: 10000;
                --map-card-live-path-color: rgb(${line.r}, ${line.g}, ${line.b});
                --map-card-live-path-opacity: 1;
                --map-card-live-path-width: 6px;
                --map-card-live-path-robot-color: rgb(${robot.r}, ${robot.g}, ${robot.b});`;
            element.setConfig({
                type: "custom:better-xiaomi-vacuum-map-card",
                entity: vacuum,
                vacuum_platform: "Xiaomi Miio",
                map_source: { camera: "camera.vacuum_map" },
                calibration_source: { calibration_points: calibration },
                map_modes: [{ template: "vacuum_clean_zone" }],
                tiles: [],
                icons: [],
                persist_map_view: false,
                live_path: { entity: position },
            });
            element.hass = root.hass;
            document.body.appendChild(element);
            // Follow the frontend's hass object exactly as a dashboard card receives it.
            (window as any).__livePathTimer = setInterval(() => {
                if (element.hass !== root.hass) element.hass = root.hass;
            }, 100);
            await new Promise(resolve => setTimeout(resolve, 1000));
        },
        { calibration: CALIBRATION, vacuum: VACUUM, position: POSITION, line: LINE, robot: ROBOT },
    );
}

async function screenPoint(page: Page, px: number, py: number): Promise<[number, number]> {
    return page.evaluate(
        ({ px, py }) => {
            const card = document.getElementById("e2e-live-path") as any;
            const rect = card.shadowRoot.getElementById("map-image").getBoundingClientRect();
            const source = card.shadowRoot.getElementById("map-image-source") as HTMLImageElement;
            return [
                rect.left + (px / source.naturalWidth) * rect.width,
                rect.top + (py / source.naturalHeight) * rect.height,
            ];
        },
        { px, py },
    ) as Promise<[number, number]>;
}

function painted(png: PNG, [x, y]: [number, number], colour: { r: number; g: number; b: number }): boolean {
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

async function waitForPaint(page: Page, px: number, py: number, colour: typeof LINE, expected: boolean): Promise<void> {
    await expect
        .poll(async () => painted(PNG.sync.read(await page.screenshot()), await screenPoint(page, px, py), colour), {
            timeout: 15_000,
        })
        .toBe(expected);
}

test.afterEach(async ({ loggedIn: page }) => {
    await page.evaluate(() => {
        clearInterval((window as any).__livePathTimer);
        document.getElementById("e2e-live-path")?.remove();
        window.localStorage.removeItem("better-xiaomi-vacuum-map-card-live-path");
    });
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
});

test("the path follows the vacuum's real position updates, stays after docking and restarts", async ({
    loggedIn: page,
}) => {
    await openDashboard(page, "/e2e-map/map");
    await waitForCard(page);
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
    await setPosition(page, 60, 130);
    await mountCard(page);

    await waitForPaint(page, 60, 130, ROBOT, true);
    await waitForPaint(page, 80, 130, LINE, false);

    await serviceCall("map_fixture", "vacuum_reset", { activity: "cleaning" });
    await expect
        .poll(() => page.evaluate(v => (document.querySelector("home-assistant") as any).hass.states[v].state, VACUUM))
        .toBe("cleaning");
    await setPosition(page, 60, 130);
    await setPosition(page, 100, 130);
    await waitForPaint(page, 80, 130, LINE, true);
    await setPosition(page, 140, 130);
    await waitForPaint(page, 120, 130, LINE, true);
    await waitForPaint(page, 140, 130, ROBOT, true);
    await shot(page, "live-path-cleaning");

    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
    await setPosition(page, 60, 130);
    await waitForPaint(page, 60, 130, ROBOT, true);
    await waitForPaint(page, 80, 130, LINE, true);

    await serviceCall("map_fixture", "vacuum_reset", { activity: "cleaning" });
    await waitForPaint(page, 80, 130, LINE, false);
});
