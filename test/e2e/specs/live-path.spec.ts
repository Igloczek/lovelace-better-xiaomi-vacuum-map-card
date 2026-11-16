import type { Page } from "@playwright/test";
import { PNG } from "pngjs";

import { freshAccessToken } from "../support/ha-websocket";
import {
    card,
    expect,
    openDashboard,
    serviceCall,
    shot,
    test,
    waitForCard,
    waitForMapImage,
    type CardHandle,
} from "./helpers";

/**
 * The live path overlay (#47) on a real dashboard (`e2e-live-path`): the fake vacuum's real states
 * and a position entity Home Assistant publishes, delivered to the card by the frontend itself.
 * Proven by the pixels in a screenshot, located from the map image's rectangle and the
 * calibration (10 vacuum units per image pixel), never from the overlay's DOM boxes.
 */

const VACUUM = "vacuum.fake_vacuum";
const POSITION = "sensor.e2e_live_position";
const LINE = { r: 255, g: 0, b: 255 };
const ROBOT = { r: 0, g: 160, b: 0 };
type Colour = typeof LINE;

async function setPosition(page: Page, x: number, y: number): Promise<void> {
    const token = await freshAccessToken();
    const response = await page.request.post(`/api/states/${POSITION}`, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        data: { state: "ok", attributes: { vacuum_position: { x: x * 10, y: y * 10, a: 0 } } },
    });
    if (!response.ok()) throw new Error(`position update failed: ${response.status()}`);
}

async function setVacuum(page: Page, activity: string): Promise<void> {
    await serviceCall("map_fixture", "vacuum_reset", { activity });
    await expect
        .poll(() => page.evaluate(v => (document.querySelector("home-assistant") as any).hass.states[v]?.state, VACUUM))
        .toBe(activity);
}

/** Opens the live-path dashboard and gives its card colours the screenshot can tell apart. */
async function openLivePathCard(page: Page): Promise<CardHandle> {
    await openDashboard(page, "/e2e-live-path/live");
    await waitForCard(page);
    const target = await card(page);
    await target.evaluate(
        (element, { line, robot }) => {
            const style = (element as HTMLElement).style;
            style.setProperty("--map-card-live-path-color", `rgb(${line.r}, ${line.g}, ${line.b})`);
            style.setProperty("--map-card-live-path-opacity", "1");
            style.setProperty("--map-card-live-path-width", "6px");
            style.setProperty("--map-card-live-path-robot-color", `rgb(${robot.r}, ${robot.g}, ${robot.b})`);
        },
        { line: LINE, robot: ROBOT },
    );
    await waitForMapImage(target);
    return target;
}

function screenPoint(target: CardHandle, px: number, py: number): Promise<[number, number]> {
    return target.evaluate(
        (element, { px, py }) => {
            const rect = element.shadowRoot.getElementById("map-image").getBoundingClientRect();
            const source = element.shadowRoot.getElementById("map-image-source") as HTMLImageElement;
            return [
                rect.left + (px / source.naturalWidth) * rect.width,
                rect.top + (py / source.naturalHeight) * rect.height,
            ] as [number, number];
        },
        { px, py },
    );
}

function painted(png: PNG, [x, y]: [number, number], colour: Colour): boolean {
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

async function expectPaint(
    page: Page,
    target: CardHandle,
    point: [number, number],
    colour: Colour,
    expected: boolean,
): Promise<void> {
    await expect
        .poll(
            async () => painted(PNG.sync.read(await page.screenshot()), await screenPoint(target, ...point), colour),
            { timeout: 15_000, message: `image pixel ${point} ${expected ? "shows" : "does not show"} the colour` },
        )
        .toBe(expected);
}

test.afterEach(async ({ loggedIn: page }) => {
    await page.evaluate(() => window.localStorage.removeItem("better-xiaomi-vacuum-map-card-live-path"));
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
});

test("the path follows the vacuum's real position updates, stays after docking and restarts", async ({
    loggedIn: page,
}) => {
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
    await setPosition(page, 60, 130);
    const target = await openLivePathCard(page);

    // Docked: the robot, no path.
    await expectPaint(page, target, [60, 130], ROBOT, true);
    await expectPaint(page, target, [80, 130], LINE, false);

    // Cleaning: every new position extends the path, the robot at its head.
    await setVacuum(page, "cleaning");
    await setPosition(page, 100, 130);
    await expectPaint(page, target, [80, 130], LINE, true);
    await setPosition(page, 140, 130);
    await expectPaint(page, target, [120, 130], LINE, true);
    await expectPaint(page, target, [140, 130], ROBOT, true);
    await expectPaint(page, target, [80, 110], LINE, false);
    await shot(page, "live-path-cleaning");

    // Docked again: the run's path stays.
    await setVacuum(page, "docked");
    await setPosition(page, 60, 130);
    await expectPaint(page, target, [60, 130], ROBOT, true);
    await expectPaint(page, target, [120, 130], LINE, true);

    // The next run starts a new path.
    await setVacuum(page, "cleaning");
    await expectPaint(page, target, [120, 130], LINE, false);
});
