import type { Page } from "@playwright/test";
import { expect, card, openDashboard, shot, serviceCall, test, waitForCard, type CardHandle } from "./helpers";

/**
 * B8 on a real instance: a re-map that keeps the geometry but renumbers the segments.
 *
 * The fixture camera can swap its `rooms` metadata for a shifted set. The card must mark the
 * configured rooms that no longer exist, warn about them, and refuse to select or send them - while
 * the map looks identical, which is exactly why this bug is dangerous.
 *
 * The two follow-up tests cover how that warning reads in a narrow card: the ids must all stay
 * visible (Home Assistant's warning clips its slot to one line), and a selected room's pill must
 * not land on the stale marker above the same geometry.
 */

/** The room ids the card renders and how many of them it marks stale, plus its warning text. */
function roomsOf(target: CardHandle) {
    return target.evaluate(element => {
        const wrappers = [...element.shadowRoot.querySelectorAll(".room-wrapper")];
        return {
            ids: wrappers.map(
                wrapper => (wrapper.getAttribute("class") ?? "").match(/room-([\w-]+)-wrapper/)?.[1] ?? "",
            ),
            stale: wrappers.filter(wrapper => wrapper.classList.contains("room-stale")).length,
            warning: (element.shadowRoot.querySelector(".room-config-warning")?.textContent ?? "").trim(),
        };
    });
}

/** Scrolls the fixture camera through the original metadata and the re-mapped one. */
async function setRoomMetadata(mode: "reset" | "shift"): Promise<void> {
    await serviceCall("map_fixture", "set_rooms", { mode });
}

/** The re-mapped ids the fixture publishes for the configured 0/1/2: same geometry, new numbers. */
const LIVE_KITCHEN_ID = "7";

/** A point inside a room's outline on screen, off its centre so the label cannot take the click. */
function roomClickPoint(target: CardHandle, id: string) {
    return target.evaluate((element, roomId) => {
        const polygon = element.shadowRoot.querySelector(
            `.room-${roomId}-wrapper .room-outline`,
        ) as SVGPolygonElement | null;
        if (!polygon) return null;
        const points = polygon.points;
        const matrix = polygon.getScreenCTM();
        if (!matrix || points.numberOfItems === 0) return null;
        const svg = polygon.ownerSVGElement!;
        const screen: Array<{ x: number; y: number }> = [];
        for (let index = 0; index < points.numberOfItems; index++) {
            const point = svg.createSVGPoint();
            point.x = points.getItem(index).x;
            point.y = points.getItem(index).y;
            screen.push(point.matrixTransform(matrix));
        }
        const centre = screen.reduce((acc, p) => ({ x: acc.x + p.x / screen.length, y: acc.y + p.y / screen.length }), {
            x: 0,
            y: 0,
        });
        const vertex = screen[0];
        return { x: centre.x + (vertex.x - centre.x) * 0.6, y: centre.y + (vertex.y - centre.y) * 0.6 };
    }, id);
}

/** The stale warning's rendered layout: every line its message occupies and whether it is clipped. */
function warningLayout(target: CardHandle) {
    return target.evaluate(element => {
        const warning = element.shadowRoot.querySelector(".room-config-warning") as HTMLElement | null;
        const message = warning?.querySelector(".room-config-warning-text") as HTMLElement | null;
        if (!warning || !message) return null;
        const range = document.createRange();
        range.selectNodeContents(message);
        const lines = [...range.getClientRects()].filter(rect => rect.width > 1 && rect.height > 1);
        const cardBox = element.getBoundingClientRect();
        const messageBox = message.getBoundingClientRect();
        return {
            text: (message.textContent ?? "").trim(),
            lineCount: lines.length,
            linesInsideCard: lines.every(rect => rect.left >= cardBox.left - 1 && rect.right <= cardBox.right + 1),
            clippedHorizontally: message.scrollWidth > message.clientWidth + 1,
            clippedVertically: message.scrollHeight > message.clientHeight + 1,
            warningHeight: warning.getBoundingClientRect().height,
            messageHeight: messageBox.height,
        };
    });
}

/** The screen boxes of the stale marker, the pill, its badge and its name text. */
function markerAndPill(target: CardHandle, staleId: string, liveId: string) {
    return target.evaluate(
        (element, ids) => {
            const box = (selector: string): { top: number; bottom: number; left: number; right: number } | null => {
                const node = element.shadowRoot.querySelector(selector);
                if (!node) return null;
                const rect = node.getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
            };
            const stale = element.shadowRoot.querySelector(`.room-${ids.staleId}-wrapper`);
            const live = element.shadowRoot.querySelector(`.room-${ids.liveId}-wrapper`);
            return {
                marker: box(`.room-${ids.staleId}-wrapper .room-stale-marker`),
                markerRoom: box(`.room-${ids.staleId}-wrapper .room-outline`),
                pill: box(`.room-${ids.liveId}-wrapper .room-pill`),
                badge: box(`.room-${ids.liveId}-wrapper .room-pill-badge`),
                name: box(`.room-${ids.liveId}-wrapper .room-pill-name`),
                // Stale rooms are appended after the live ones, so their marker paints above a pill.
                staleAfterLive: !!(
                    stale &&
                    live &&
                    live.compareDocumentPosition(stale) & Node.DOCUMENT_POSITION_FOLLOWING
                ),
            };
        },
        { staleId, liveId },
    );
}

/**
 * The marker never covers the pill's name, whatever the theme font does to the pill's height, and it
 * is either clear of the pill and its badge or painted above the pill it overlaps. A room shorter
 * than the pill cannot hold the marker at a large font - the pill alone is taller than the room - so
 * `stale-marker.spec.ts` is where the room's outline is checked, with the room's own space measured.
 */
function expectMarkerVisible(geometry: Awaited<ReturnType<typeof markerAndPill>>, where: string): void {
    const { marker, pill, badge, name, staleAfterLive } = geometry;
    expect(marker, `the stale marker must be drawn (${where})`).not.toBeNull();
    expect(pill, `the pill must be drawn (${where})`).not.toBeNull();
    expect(badge, `the badge must be drawn (${where})`).not.toBeNull();
    expect(name, `the pill's name must be drawn (${where})`).not.toBeNull();
    const coversName =
        marker!.right > name!.left &&
        name!.right > marker!.left &&
        marker!.bottom > name!.top &&
        name!.bottom > marker!.top;
    expect(coversName, `the marker must not cover the pill's name (${where})`).toBe(false);
    const clear = marker!.bottom <= pill!.top - 2 && marker!.bottom <= badge!.top - 2;
    if (clear) return;
    expect(staleAfterLive, `a marker overlapping the pill must paint above it (${where})`).toBe(true);
}

/**
 * Wheel-zooms the map over its centre until the card reports the requested scale.
 *
 * The wheel step is computed from the remaining factor (capped like a real wheel event), so the
 * reached scale is the requested one instead of "somewhere above 0.8 × the target".
 */
async function zoomTo(page: Page, target: CardHandle, scale: number): Promise<void> {
    const zoomer = await target.locator.locator("better-pinch-zoom").boundingBox();
    if (!zoomer) throw new Error("the map is not on screen");
    await page.mouse.move(zoomer.x + zoomer.width / 2, zoomer.y + zoomer.height / 2);
    // `min-scale` is 0.5 and the pinch-zoom refuses a computed scale below it, which a floating
    // point step can produce; aim just above the floor.
    const requested = scale <= 0.5 ? 0.51 : scale;
    for (let step = 0; step < 12; step++) {
        const current = await target.evaluate(element => element.mapScale as number);
        if (Math.abs(current - requested) <= 0.01) break;
        const deltaY = Math.max(-120, Math.min(120, -(requested / current - 1) * 300));
        await page.mouse.wheel(0, deltaY);
        await page.waitForTimeout(250);
    }
    const reached = await target.evaluate(element => element.mapScale as number);
    expect(Math.abs(reached - scale), `the map must really reach zoom ${scale}`).toBeLessThanOrEqual(0.02);
}

test("a re-mapped camera marks stale rooms and refuses them", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-stale/rooms");
    await waitForCard(page);
    const target = await card(page);

    // Start from the original metadata even if an earlier run aborted before restoring it.
    await setRoomMetadata("reset");
    await expect.poll(async () => (await roomsOf(target)).ids.sort()).toEqual(["0", "1", "2"]);
    expect((await roomsOf(target)).warning).toBe("");

    try {
        await setRoomMetadata("shift");

        // The configured ids 0/1/2 no longer exist in the camera metadata: they are drawn from their
        // stored outlines, marked stale, and named in the warning.
        await expect.poll(async () => (await roomsOf(target)).stale, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
        const afterRemap = await roomsOf(target);
        expect(afterRemap.warning).toMatch(/0[\s,]+1[\s,]+2/);

        // The stale room is drawn from its configured outline but is not a hit target, so a click
        // there falls through to the live, colour-detected room that now covers the same pixels. It
        // must never select the stale id 0: the wrong room must not be cleanable.
        const stalePoint = await roomClickPoint(target, "0");
        expect(stalePoint).not.toBeNull();
        await page.mouse.click(stalePoint!.x, stalePoint!.y);
        await expect
            .poll(
                async () =>
                    (await target.evaluate(element =>
                        element.selectedRooms.map((room: any) => String(room.toVacuum())),
                    )) as string[],
            )
            .not.toContain("0");
        await shot(page, "15-stale-rooms");

        // Clear whatever the fall-through click selected, then pick the live room on purpose.
        while ((await target.evaluate(element => element.selectedRooms.length)) > 0) {
            await page.mouse.click(stalePoint!.x, stalePoint!.y);
            await page.waitForTimeout(150);
        }

        // The live rooms of the new metadata are selectable again.
        const livePoint = await roomClickPoint(target, "7");
        expect(livePoint, "the re-mapped room 7 must be live").not.toBeNull();
        await page.mouse.click(livePoint!.x, livePoint!.y);
        await expect
            .poll(
                async () =>
                    (await target.evaluate(element =>
                        element.selectedRooms.map((room: any) => String(room.toVacuum())),
                    )) as string[],
            )
            .toEqual(["7"]);
    } finally {
        // Always restore the fixture: a failure above must not renumber the camera for later specs.
        // The room selected above came from the re-mapped metadata, so the reset takes its id away
        // again and the card keeps it on the map as a stale warning (see `empty-room-selection.spec`):
        // the original ids are what proves the fixture is back.
        await setRoomMetadata("reset");
        await expect
            .poll(async () => (await roomsOf(target)).ids, { timeout: 15_000 })
            .toEqual(expect.arrayContaining(["0", "1", "2"]));
        // The configured ids are live again, so the stale configured-id warning is gone. The
        // selected room 7 is the one the reset removed, and it stays as its own warning.
        expect((await roomsOf(target)).warning).toBe("");
    }
});

test("a phone-width card shows every stale id and keeps the marker clear of the pill", async ({ loggedIn: page }) => {
    // A phone-sized dashboard: the card is about 370 px wide, the width a user reported the ids being
    // cut at. Home Assistant's warning lays its slot on one line, so the message needs to wrap.
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, "/e2e-stale/rooms");
    await waitForCard(page);
    const target = await card(page);

    await setRoomMetadata("reset");
    await expect.poll(async () => (await roomsOf(target)).ids.sort()).toEqual(["0", "1", "2"]);

    try {
        await setRoomMetadata("shift");
        await expect.poll(async () => (await roomsOf(target)).stale, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

        // Every stale id, not only the first one: the message occupies several lines, stays inside
        // the card and is clipped in neither direction, and the alert grew to hold it.
        const warning = await warningLayout(target);
        expect(warning, "the stale warning must render a message element").not.toBeNull();
        expect(warning!.text).toContain("0, 1, 2");
        expect(warning!.lineCount).toBeGreaterThanOrEqual(3);
        expect(warning!.clippedHorizontally).toBe(false);
        expect(warning!.clippedVertically).toBe(false);
        expect(warning!.linesInsideCard).toBe(true);
        expect(warning!.warningHeight).toBeGreaterThanOrEqual(warning!.messageHeight);

        // The pill of the live room with the stale room's geometry is centred on the room's label.
        // Its badge and its body must stay below the stale marker at every zoom level and theme font,
        // or the marker must stay in the room and paint above them (a room too small to clear).
        const point = await roomClickPoint(target, LIVE_KITCHEN_ID);
        expect(point, `the re-mapped room ${LIVE_KITCHEN_ID} must be live`).not.toBeNull();
        await page.mouse.click(point!.x, point!.y);
        await expect.poll(async () => (await markerAndPill(target, "0", LIVE_KITCHEN_ID)).pill !== null).toBe(true);

        for (const font of [12, 32, 40]) {
            // The marker and the pill are sized by the stylesheet: a theme font needs no render.
            await target.evaluate((element, value) => {
                element.style.setProperty("--map-card-room-label-font-size", `${value}px`);
            }, font);
            await page.waitForTimeout(200);
            for (const scale of [1, 0.5, 2.5]) {
                await zoomTo(page, target, scale);
                const geometry = await markerAndPill(target, "0", LIVE_KITCHEN_ID);
                expectMarkerVisible(geometry, `label font ${font}, zoom ${scale}`);
            }
        }
        await shot(page, "16-stale-rooms-phone");
    } finally {
        await setRoomMetadata("reset");
        await expect
            .poll(async () => (await roomsOf(target)).ids, { timeout: 15_000 })
            .toEqual(expect.arrayContaining(["0", "1", "2"]));
    }
});

test("a narrow sections-view column wraps the stale warning instead of truncating it", async ({ loggedIn: page }) => {
    // A sections cell a few columns wide: the same message in a much narrower box.
    await openDashboard(page, "/e2e-stale/narrow");
    await waitForCard(page);
    const target = await card(page);

    await setRoomMetadata("reset");
    await expect.poll(async () => (await roomsOf(target)).ids.sort()).toEqual(["0", "1", "2"]);

    try {
        await setRoomMetadata("shift");
        await expect.poll(async () => (await roomsOf(target)).stale, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

        const warning = await warningLayout(target);
        const cardWidth = await target.evaluate(element => element.getBoundingClientRect().width);
        expect(cardWidth, "the sections cell must really be narrow").toBeLessThan(400);
        expect(warning, "the stale warning must render a message element").not.toBeNull();
        expect(warning!.text).toContain("0, 1, 2");
        expect(warning!.lineCount).toBeGreaterThanOrEqual(4);
        expect(warning!.clippedHorizontally).toBe(false);
        expect(warning!.clippedVertically).toBe(false);
        expect(warning!.linesInsideCard).toBe(true);
        await shot(page, "16-stale-rooms-sections-cell");
    } finally {
        await setRoomMetadata("reset");
        await expect
            .poll(async () => (await roomsOf(target)).ids, { timeout: 15_000 })
            .toEqual(expect.arrayContaining(["0", "1", "2"]));
    }
});
