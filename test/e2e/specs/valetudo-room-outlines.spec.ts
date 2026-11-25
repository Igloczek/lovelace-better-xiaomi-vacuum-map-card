import type { Page } from "@playwright/test";

import { card, expect, nextFrames, openDashboard, test, waitForCard, type CardHandle } from "./helpers";

/**
 * Issue #77 on a real instance: the apartment floor plan from a camera that publishes rooms the way
 * Valetudo's map camera (sca075's MQTT Vacuum Camera) does, each room's own convex-hull outline in
 * Valetudo units and no bounds. The card traces every room from the map colours instead of drawing
 * the hulls, so a tap inside a neighbour's hull selects the room drawn there and a selected room's
 * outline stays on its own floor. Runs in Chromium and WebKit (playwright.config.ts).
 */
const DASHBOARD = "/e2e-apartment/valetudo";

const ROOM_IDS = ["10", "11", "12", "13", "14", "15", "16", "17", "18"];

/** Image points 3 px either side of a wall, the first inside the other room's hull or next to it. */
const WALL_PAIRS: Array<[[number, number], string, [number, number], string]> = [
    [[157, 110], "13", [166, 110], "14"],
    [[157, 130], "13", [166, 130], "15"],
    [[265, 98], "17", [265, 106], "18"],
    [[236, 112], "17", [246, 112], "18"],
];

const selectedIds = (target: CardHandle): Promise<string[]> =>
    target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum()))) as Promise<string[]>;

async function screenPoint(target: CardHandle, [x, y]: [number, number]): Promise<{ x: number; y: number }> {
    const point = await target.evaluate(
        (element, p: { x: number; y: number }) => {
            const svg = element.shadowRoot.getElementById("svg-wrapper") as SVGSVGElement;
            const matrix = svg.getScreenCTM();
            if (!matrix) return null;
            const local = svg.createSVGPoint();
            local.x = (p.x + 0.5) * element.realScale;
            local.y = (p.y + 0.5) * element.realScale;
            const screen = local.matrixTransform(matrix);
            return { x: screen.x, y: screen.y };
        },
        { x, y },
    );
    if (!point) throw new Error(`no screen position for ${x},${y}`);
    return point;
}

async function roomAt(page: Page, target: CardHandle, point: [number, number]): Promise<string[]> {
    const { x, y } = await screenPoint(target, point);
    await page.mouse.click(x, y);
    await nextFrames(page);
    const ids = await selectedIds(target);
    if (ids.length) {
        await page.mouse.click(x, y);
        await nextFrames(page);
    }
    return ids;
}

test("Valetudo hull outlines: every room traced from the map, taps inside a neighbour's hull", async ({
    loggedIn: page,
}) => {
    test.setTimeout(120_000);
    await openDashboard(page, DASHBOARD);
    await waitForCard(page);
    const target = await card(page);
    await expect
        .poll(() => target.locator.locator(".room-wrapper").count(), { timeout: 30_000, message: "rooms drawn" })
        .toBe(ROOM_IDS.length);
    await expect
        .poll(
            () =>
                target.evaluate(element =>
                    (element.roomColorDetection?.regions ?? []).map((region: any) => region.id).sort(),
                ),
            { timeout: 30_000, message: "rooms traced from the map" },
        )
        .toEqual(ROOM_IDS);
    await nextFrames(page);

    for (const [a, aId, b, bId] of WALL_PAIRS) {
        expect(await roomAt(page, target, a), `${aId} side of the wall with ${bId}`).toEqual([aId]);
        expect(await roomAt(page, target, b), `${bId} side of the wall with ${aId}`).toEqual([bId]);
    }
});
