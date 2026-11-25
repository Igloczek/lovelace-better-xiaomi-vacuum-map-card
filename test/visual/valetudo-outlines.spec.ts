import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * Issue #77: the apartment floor plan from a Valetudo map camera (sca075's MQTT Vacuum Camera),
 * which publishes each room's own outline as a convex hull and no bounds. The card used to draw the
 * hulls: Korytarz's covered Schowek and WC, and Sypialnia's and room 18's covered each other. The
 * card now traces those rooms from the map's colours.
 *
 * Runs in Chromium and WebKit (playwright.config.ts) and reads pixels: the selected room's fill is
 * painted lime, and no lime may land on a neighbour's floor that the published hull covers.
 */

const CARD = "better-xiaomi-vacuum-map-card";
const CAMERA = "camera.apartment_valetudo_map";

interface HarnessWindow {
    visualHarness: {
        ready: boolean;
        card: any;
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
        setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<unknown>;
        selectedRoomIds: () => string[];
    };
}

/** A room, a point inside it, and points of neighbours' floors its published hull covers. */
const HULL_SPILLS: Array<{ id: string; inside: [number, number]; neighbours: Array<[number, number]> }> = [
    {
        id: "13",
        inside: [130, 120],
        neighbours: [
            [170, 106],
            [166, 125],
            [168, 103],
        ],
    },
    {
        id: "17",
        inside: [220, 80],
        neighbours: [
            [246, 106],
            [250, 104],
        ],
    },
    {
        id: "18",
        inside: [235, 175],
        neighbours: [
            [208, 115],
            [215, 112],
        ],
    },
];

/** Points 3 px either side of a wall, the first inside the other room's hull or next to it. */
const WALL_PAIRS: Array<[[number, number], string, [number, number], string]> = [
    [[157, 110], "13", [166, 110], "14"],
    [[157, 130], "13", [166, 130], "15"],
    [[265, 98], "17", [265, 106], "18"],
    [[236, 112], "17", [246, 112], "18"],
];

function config(rotation: number): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: CAMERA },
        calibration_source: { camera: true },
        vacuum_platform: "Hypfer/Valetudo",
        internal_variables: { topic: "valetudo/robot" },
        map_modes: [{ template: "vacuum_clean_segment", max_selections: 10 } as MapModeConfig],
        map_rotation: rotation,
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

async function mount(page: Page, rotation: number): Promise<void> {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as HarnessWindow).visualHarness?.ready);
    await page.evaluate(input => (window as unknown as HarnessWindow).visualHarness.mount(input), config(rotation));
    await expect(page.locator(CARD)).toBeVisible();
    await expect.poll(() => page.locator(CARD).locator(".room-wrapper").count(), { message: "rooms drawn" }).toBe(9);
    // Every room traced from the map, none left to its published hull.
    await expect
        .poll(() => page.locator(CARD).evaluate((card: any) => card.roomColorDetection?.regions.length ?? 0))
        .toBe(9);
    if (rotation === 90) await page.evaluate(() => (window as unknown as HarnessWindow).visualHarness.setZoom(0.68));
    await page.addStyleTag({
        content: `${CARD} {
            --map-card-room-outline-line-color: transparent;
            --map-card-room-outline-line-color-selected: transparent;
            --map-card-room-outline-fill-color-selected: rgb(0, 255, 0);
            --map-card-transitions-duration: 0ms;
        }`,
    });
    await page.waitForTimeout(400);
}

/** Where an image pixel lands on screen, from the map image's painted rectangle. */
function screenPoint(page: Page, [px, py]: [number, number], rotation: number): Promise<[number, number]> {
    return page.evaluate(
        ({ px, py, rotation }) => {
            const card = (window as unknown as HarnessWindow).visualHarness.card;
            const rect = (card.shadowRoot.getElementById("map-image") as HTMLElement).getBoundingClientRect();
            const source = card.shadowRoot.getElementById("map-image-source") as HTMLImageElement;
            const u = (px + 0.5) / source.naturalWidth;
            const v = (py + 0.5) / source.naturalHeight;
            if (rotation === 90) return [rect.left + (1 - v) * rect.width, rect.top + u * rect.height];
            return [rect.left + u * rect.width, rect.top + v * rect.height];
        },
        { px, py, rotation },
    ) as Promise<[number, number]>;
}

const selected = (page: Page): Promise<string[]> =>
    page.evaluate(() => (window as unknown as HarnessWindow).visualHarness.selectedRoomIds());

async function roomAt(page: Page, point: [number, number], rotation: number): Promise<string[]> {
    const [x, y] = await screenPoint(page, point, rotation);
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    const ids = await selected(page);
    if (ids.length) {
        await page.mouse.click(x, y);
        await page.waitForTimeout(150);
    }
    return ids;
}

/** Lime pixels in a small square around an image point. */
async function limeAround(page: Page, point: [number, number], rotation: number): Promise<number> {
    const [x, y] = await screenPoint(page, point, rotation);
    const shot = await page.screenshot({
        clip: { x: Math.round(x) - 3, y: Math.round(y) - 3, width: 6, height: 6 },
        animations: "disabled",
    });
    const image = PNG.sync.read(shot);
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4) {
        const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
        if (g > 200 && r < 120 && b < 120) count++;
    }
    return count;
}

for (const rotation of [0, 90] as const) {
    test(`a selected room paints its own floor, not its published hull's, rotation ${rotation}`, async ({ page }) => {
        await mount(page, rotation);
        for (const room of HULL_SPILLS) {
            const [x, y] = await screenPoint(page, room.inside, rotation);
            await page.mouse.click(x, y);
            await page.waitForTimeout(150);
            expect(await selected(page)).toEqual([room.id]);
            await page.mouse.move(1, 1);
            await page.waitForTimeout(150);
            expect(await limeAround(page, room.inside, rotation), `room ${room.id} paints its fill`).toBeGreaterThan(0);
            for (const point of room.neighbours) {
                expect(await limeAround(page, point, rotation), `room ${room.id}'s fill at ${point}`).toBe(0);
            }
            await page.mouse.click(x, y);
            await page.waitForTimeout(150);
            expect(await selected(page)).toEqual([]);
        }
    });

    test(`a tap next to a wall selects the room drawn there, also inside a neighbour's hull, rotation ${rotation}`, async ({
        page,
    }) => {
        await mount(page, rotation);
        for (const [a, aId, b, bId] of WALL_PAIRS) {
            expect(await roomAt(page, a, rotation), `${aId} side of the wall with ${bId}`).toEqual([aId]);
            expect(await roomAt(page, b, rotation), `${bId} side of the wall with ${aId}`).toEqual([bId]);
        }
    });
}
