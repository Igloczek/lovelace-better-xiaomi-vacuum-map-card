import type { Page } from "@playwright/test";

import { expect, openDashboard, card, serviceCall, shot, test, waitForCard, CardHandle } from "./helpers";

/**
 * Two same-coloured L-shaped rooms whose bounding boxes interlock, on a real instance.
 *
 * The fixture map (test/fixtures/synthetic/interlock.png) draws the kitchen as a top bar and a left
 * column and the hall as a right column with an arm that reaches under the kitchen's bar. Both are
 * painted the same colour and the camera publishes bounds only, so every point in the hall's arm
 * also lies inside the kitchen's bounds. A tap there must select the hall: giving that floor to the
 * kitchen would clean the wrong room.
 */
const KITCHEN = "kitchen";
const HALL = "hall";

/** Points in image pixels, chosen against the fixture: two per room, both inside the other's box. */
const POINTS: Record<string, Array<[number, number]>> = {
    [KITCHEN]: [
        [80, 20], // the top bar, inside the hall's bounds as well
        [20, 80], // the left column, outside the hall's bounds
    ],
    [HALL]: [
        [80, 80], // the arm under the kitchen's bar, inside the kitchen's bounds
        [150, 30], // the right column, outside the kitchen's bounds
    ],
};

async function selectedIds(target: CardHandle): Promise<string[]> {
    return (await target.evaluate(element =>
        element.selectedRooms.map((room: any) => String(room.toVacuum())),
    )) as string[];
}

function viewport(target: CardHandle) {
    return target.evaluate(element => {
        const rect = (element.shadowRoot.getElementById("map-zoomer") as HTMLElement).getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
        };
    });
}

/** The page point of an image pixel: the overlay shares the image's scale and transform. */
function screenPoint(target: CardHandle, x: number, y: number) {
    return target.evaluate(
        (element, point: { x: number; y: number }) => {
            const svg = element.shadowRoot.getElementById("svg-wrapper") as SVGSVGElement;
            const matrix = svg.getScreenCTM();
            if (!matrix) return null;
            const local = svg.createSVGPoint();
            local.x = point.x * element.realScale;
            local.y = point.y * element.realScale;
            const screen = local.matrixTransform(matrix);
            return { x: screen.x, y: screen.y };
        },
        { x, y },
    );
}

/**
 * Pans a zoomed map until the image pixel is well inside the viewport. The zoomer translation
 * is in the map's own frame, so one step does not land exactly at the centre under rotation;
 * repeat until it does.
 */
async function bringIntoView(page: Page, target: CardHandle, x: number, y: number): Promise<{ x: number; y: number }> {
    for (let attempt = 0; attempt < 6; attempt++) {
        const screen = await screenPoint(target, x, y);
        expect(screen, `image point ${x},${y} must have a screen position`).not.toBeNull();
        const box = await viewport(target);
        const inside =
            screen!.x > box.left + 60 &&
            screen!.x < box.right - 60 &&
            screen!.y > box.top + 60 &&
            screen!.y < box.bottom - 60;
        if (inside) return screen!;
        await target.evaluate(
            (element, delta) => {
                const zoomer = element.shadowRoot.getElementById("map-zoomer");
                zoomer.setTransform({
                    scale: zoomer.scale,
                    x: zoomer.x + delta.dx,
                    y: zoomer.y + delta.dy,
                    allowChangeEvent: true,
                });
            },
            { dx: box.cx - screen!.x, dy: box.cy - screen!.y },
        );
        await page.waitForTimeout(250);
    }
    throw new Error(`could not bring ${x},${y} into view`);
}

async function clearSelection(page: Page, target: CardHandle): Promise<void> {
    while ((await selectedIds(target)).length > 0) {
        await target.evaluate(element => element.selectedRooms.forEach((room: any) => room.click()));
        await page.waitForTimeout(150);
    }
}

test("interlocking same-coloured rooms keep their own floor at every zoom and rotation", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-interlock/rooms");
    await waitForCard(page);
    const target = await card(page);

    // The card traces both rooms from the map colours and gets their ids from the camera metadata.
    await expect
        .poll(
            async () =>
                target.evaluate(element =>
                    (element.roomColorDetection?.regions ?? []).map((region: { id: string }) => region.id).sort(),
                ),
            { timeout: 30_000 },
        )
        .toEqual([HALL, KITCHEN]);
    await expect(target.locator.locator(`.room-${KITCHEN}-wrapper`)).toHaveCount(1);
    await expect(target.locator.locator(`.room-${HALL}-wrapper`)).toHaveCount(1);

    const views: Array<{ scale: number; rotation: number }> = [
        { scale: 1, rotation: 0 },
        { scale: 2.5, rotation: 0 },
        { scale: 1, rotation: 90 },
        { scale: 2.5, rotation: 90 },
    ];
    for (const view of views) {
        await target.evaluate(async (element, state: { scale: number; rotation: number }) => {
            const zoomer = element.shadowRoot.getElementById("map-zoomer");
            zoomer.setTransform({ scale: state.scale, x: 0, y: 0, allowChangeEvent: true });
            element._setRotation(state.rotation);
            await element.updateComplete;
        }, view);
        await expect.poll(async () => target.evaluate(element => element.mapRotation)).toBe(view.rotation);
        await page.waitForTimeout(400);

        for (const [roomId, points] of Object.entries(POINTS)) {
            for (const [x, y] of points) {
                await clearSelection(page, target);
                const point = await bringIntoView(page, target, x, y);
                await page.mouse.click(point.x, point.y);
                await expect
                    .poll(() => selectedIds(target), {
                        message: `a tap at image ${x},${y} at zoom ${view.scale}, rotation ${view.rotation}`,
                    })
                    .toEqual([roomId]);
            }
        }
    }

    // Evidence at the neutral view: both rooms traced as their own L shape, and a tap on the
    // kitchen selected only the kitchen. The reset control clears the panned view the hit test
    // left behind, so the whole map is in the screenshot.
    await clearSelection(page, target);
    const kitchenPoint = await bringIntoView(page, target, 80, 20);
    await page.mouse.click(kitchenPoint.x, kitchenPoint.y);
    await expect.poll(() => selectedIds(target)).toEqual([KITCHEN]);
    await target.evaluate(async element => {
        element._resetMapView();
        await element.updateComplete;
    });
    await page.waitForTimeout(800);
    await target.evaluate(async element => {
        const zoomer = element.shadowRoot.getElementById("map-zoomer");
        zoomer.setTransform({ scale: 1, x: 0, y: 0, allowChangeEvent: true });
        await element.updateComplete;
    });
    await page.waitForTimeout(500);
    await shot(page, "18-interlock-rooms");
});

test("a piece a cleaning path cuts off stays with the room it is drawn on", async ({ loggedIn: page }) => {
    // The fixture camera serves the same plan with a 2 px cleaning path down the kitchen's bar
    // (test/e2e/ha/config/map_interlock_path.png). The path runs wall to wall, so the bar's right
    // end comes off as a piece that lies wholly inside both rooms' bounds: the metadata shapes
    // contain 100% of it each, and only what separates it from each room's floor says whose it is.
    // A card opened now traces the pathed image (a detection is reused for the same room geometry,
    // so the image has to change before the card loads it).
    await serviceCall("map_fixture", "interlock_path", { on: true });
    try {
        await openDashboard(page, "/e2e-interlock/rooms");
        await waitForCard(page);
        const target = await card(page);
        await expect
            .poll(
                async () =>
                    target.evaluate(element =>
                        (element.roomColorDetection?.regions ?? []).map((region: { id: string }) => region.id).sort(),
                    ),
                { timeout: 30_000 },
            )
            .toEqual([HALL, KITCHEN]);

        // The cut-off piece, the path over the kitchen, the rest of the kitchen's bar and the hall's
        // arm under that bar.
        const taps: Array<[number, number, string]> = [
            [96, 20, KITCHEN],
            [90, 20, KITCHEN],
            [20, 80, KITCHEN],
            [60, 70, HALL],
            [150, 30, HALL],
        ];
        for (const [x, y, roomId] of taps) {
            await clearSelection(page, target);
            const point = await bringIntoView(page, target, x, y);
            await page.mouse.click(point.x, point.y);
            await expect.poll(() => selectedIds(target), { message: `a tap at image ${x},${y}` }).toEqual([roomId]);
        }
    } finally {
        await serviceCall("map_fixture", "interlock_path", { on: false });
    }
});
