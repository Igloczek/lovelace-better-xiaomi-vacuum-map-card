import type { Page } from "@playwright/test";
import { PNG } from "pngjs";

import { card, expect, nextFrames, openDashboard, test, waitForCard, type CardHandle } from "./helpers";

/**
 * The card on a realistic floor plan, on a real instance (test/fixtures/apartment/): rooms that share
 * walls, L-, T- and stepped shapes, two rooms smaller than their names, Polish names, a room the
 * camera does not name, same-coloured neighbours, furniture and a robot path over the floor. Runs in
 * Chromium and WebKit (playwright.config.ts).
 *
 * Every room is found from the map colours and the camera metadata, a tap inside it (also right next
 * to a shared wall) selects it, and no room's border is painted over any label, whatever is
 * selected: a label reaching across a wall used to be cut by the next room's outline.
 */
const DASHBOARD = "/e2e-apartment/rooms";

const ROOMS: Array<{ id: string; inside: [number, number] }> = [
    { id: "10", inside: [60, 30] },
    { id: "11", inside: [40, 140] },
    { id: "12", inside: [160, 30] },
    { id: "13", inside: [130, 120] },
    { id: "14", inside: [180, 108] },
    { id: "15", inside: [180, 130] },
    { id: "16", inside: [150, 190] },
    { id: "17", inside: [220, 80] },
    { id: "18", inside: [235, 175] },
];

/** Image points 3 px either side of a shared wall; Kuchnia and Salon are the same colour. */
const WALL_PAIRS: Array<[[number, number], string, [number, number], string]> = [
    [[60, 54], "10", [60, 61], "11"],
    [[180, 116], "14", [180, 123], "15"],
    [[195, 80], "13", [204, 80], "17"],
    [[265, 98], "17", [265, 106], "18"],
];

const selectedIds = (target: CardHandle): Promise<string[]> =>
    target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum()))) as Promise<string[]>;

/** The page point of an image pixel: the overlay shares the image's scale and transform. */
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

/** Taps an image point, returns what it selected, and taps again to clear it. */
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

/** The solid middle of every pill inside the map viewport, by room. */
function pillBands(target: CardHandle) {
    return target.evaluate(element => {
        const zoomer = (element.shadowRoot.getElementById("map-zoomer") as HTMLElement).getBoundingClientRect();
        const bands: Array<{ id: string; clip: { x: number; y: number; width: number; height: number } }> = [];
        // By the pill and the room class around it, not by how the card groups its overlays.
        element.shadowRoot.querySelectorAll(".room-pill").forEach((pill: Element) => {
            const layer = pill.closest("[class*='-wrapper']") ?? pill;
            const r = pill.getBoundingClientRect();
            const clip = {
                x: Math.ceil(r.x + r.height / 2),
                y: Math.ceil(r.y + r.height * 0.3),
                width: Math.floor(r.width - r.height),
                height: Math.floor(r.height * 0.4),
            };
            const inside =
                clip.width > 2 &&
                clip.x >= zoomer.left &&
                clip.y >= zoomer.top &&
                clip.x + clip.width <= zoomer.right &&
                clip.y + clip.height <= zoomer.bottom;
            const id = /room-(\w+)-wrapper/.exec(layer.getAttribute("class") ?? "")?.[1] ?? "?";
            if (inside) bands.push({ id, clip });
        });
        return bands;
    });
}

/** Every room outline solid magenta, a colour nothing else on the map or in a label uses. */
async function setOutlinesMarked(target: CardHandle, marked: boolean): Promise<void> {
    await target.evaluate((element, value: boolean) => {
        const root = element.shadowRoot as ShadowRoot;
        root.getElementById("outline-marked")?.remove();
        if (!value) return;
        const style = document.createElement("style");
        style.id = "outline-marked";
        style.textContent = `.room-outline { stroke: rgb(255, 0, 255) !important; stroke-dasharray: none !important;
            stroke-width: calc(3px / var(--map-scale)) !important; transition: none !important; }`;
        root.appendChild(style);
    }, marked);
}

function magentaPixels(png: Buffer): number {
    const image = PNG.sync.read(png);
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i] > 180 && image.data[i + 2] > 180 && image.data[i + 1] < 110) count++;
    }
    return count;
}

/**
 * No room border is painted over any label. The outlines are drawn solid magenta for the check, so
 * a border crossing a label shows as magenta inside the label's box; nothing is toggled between two
 * screenshots, which text and edge antialiasing made flaky. The map must show magenta, or the check
 * would prove nothing.
 */
async function expectLabelsOnTop(page: Page, target: CardHandle, label: string): Promise<void> {
    const bands = await pillBands(target);
    expect(bands.length, `${label}: labels on screen`).toBe(ROOMS.length);
    await setOutlinesMarked(target, true);
    try {
        const zoomer = (await target.locator.locator("#map-zoomer").boundingBox())!;
        expect(magentaPixels(await page.screenshot({ clip: zoomer })), `${label}: outlines drawn`).toBeGreaterThan(100);
        for (const { id, clip } of bands) {
            const pixels = magentaPixels(await page.screenshot({ clip, animations: "disabled" }));
            expect(pixels, `${label}: no room border is painted over room ${id}'s label`).toBe(0);
        }
    } finally {
        await setOutlinesMarked(target, false);
    }
}

test("a real floor plan: every room found and tappable, labels above every border", async ({ loggedIn: page }) => {
    test.setTimeout(120_000);
    await openDashboard(page, DASHBOARD);
    await waitForCard(page);
    const target = await card(page);
    await expect
        .poll(() => target.locator.locator(".room-wrapper").count(), { timeout: 30_000, message: "rooms detected" })
        .toBe(ROOMS.length);
    await nextFrames(page);

    for (const room of ROOMS) {
        expect(await roomAt(page, target, room.inside), `inside room ${room.id}`).toEqual([room.id]);
    }
    for (const [a, aId, b, bId] of WALL_PAIRS) {
        expect(await roomAt(page, target, a), `${aId} side of the wall with ${bId}`).toEqual([aId]);
        expect(await roomAt(page, target, b), `${bId} side of the wall with ${aId}`).toEqual([bId]);
    }

    await expectLabelsOnTop(page, target, "unselected");
    for (const room of ROOMS) {
        const { x, y } = await screenPoint(target, room.inside);
        await page.mouse.click(x, y);
        await nextFrames(page);
    }
    expect((await selectedIds(target)).sort()).toEqual(ROOMS.map(room => room.id).sort());
    await expectLabelsOnTop(page, target, "every room selected");
});
