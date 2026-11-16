import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * The card on a realistic floor plan (test/fixtures/apartment/): rooms that share walls, L-, T- and
 * stepped shapes, a chamfered corner, two rooms far smaller than their names, Polish names, a room
 * the camera does not name, same-coloured neighbours, furniture and a robot path over the floor.
 * The synthetic three-room map has none of that, and that is where real maps break the card: a
 * label reaching over the next room's border, a tap next to a wall landing in the wrong room.
 *
 * Runs in Chromium and WebKit (playwright.config.ts). Every check reads pixels or real input; no
 * baselines are taken.
 */

const CARD = "better-xiaomi-vacuum-map-card";

interface HarnessWindow {
    visualHarness: {
        ready: boolean;
        card: any;
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
        setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<unknown>;
        selectedRoomIds: () => string[];
    };
}

/** Each room of the plan with a point well inside it, in image pixels, clear of furniture and path. */
const ROOMS: Array<{ id: string; name?: string; inside: [number, number] }> = [
    { id: "10", name: "Kuchnia", inside: [60, 30] },
    { id: "11", name: "Salon", inside: [40, 140] },
    { id: "12", name: "Garderoba i pralnia", inside: [160, 30] },
    { id: "13", name: "Korytarz", inside: [130, 120] },
    { id: "14", name: "Schowek", inside: [180, 108] },
    { id: "15", name: "WC", inside: [180, 130] },
    { id: "16", name: "Łazienka", inside: [150, 190] },
    { id: "17", name: "Sypialnia", inside: [220, 80] },
    { id: "18", inside: [235, 175] },
];

/**
 * Points 3 px either side of a shared wall: each must select its own room. Kuchnia and Salon, and
 * Łazienka and room 18, are the same colour, so only the wall separates them.
 */
const WALL_PAIRS: Array<[[number, number], string, [number, number], string]> = [
    [[60, 54], "10", [60, 61], "11"],
    [[160, 54], "12", [160, 61], "13"],
    [[180, 116], "14", [180, 123], "15"],
    [[195, 80], "13", [204, 80], "17"],
    [[265, 98], "17", [265, 106], "18"],
    [[196, 190], "16", [203, 190], "18"],
    [[115, 80], "11", [124, 80], "13"],
];

function config(rotation: number): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.apartment_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [{ template: "vacuum_clean_segment", cleaning_order: true, max_selections: 10 } as MapModeConfig],
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
    await expect
        .poll(() => page.locator(CARD).locator(".room-wrapper").count(), { message: "rooms detected" })
        .toBe(ROOMS.length);
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

/** Taps an image point and returns the room it selected, then taps again to clear it. */
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

interface Clip {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The solid middle of every pill on screen (rounded ends and shadow left out), by room. */
function pillBands(page: Page): Promise<Array<{ id: string; clip: Clip }>> {
    return page.locator(CARD).evaluate((card: Element) => {
        const zoomer = card.shadowRoot!.getElementById("map-zoomer")!.getBoundingClientRect();
        const out: Array<{ id: string; clip: Clip }> = [];
        // By the pill and the room class around it, not by the group layout: the check must mean the
        // same thing whichever way the card groups its overlays.
        card.shadowRoot!.querySelectorAll(".room-pill").forEach(pill => {
            const owner = pill.closest("[class*='-wrapper']");
            const r = pill.getBoundingClientRect();
            const id = /room-(\w+)-wrapper/.exec(owner?.getAttribute("class") ?? "")?.[1] ?? "?";
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
            if (inside) out.push({ id, clip });
        });
        return out;
    });
}

const setHidden = (page: Page, selector: string, hidden: boolean): Promise<void> =>
    page.locator(CARD).evaluate(
        (card: Element, input: { selector: string; hidden: boolean }) => {
            card.shadowRoot!.querySelectorAll(input.selector).forEach(element => {
                (element as SVGElement).style.visibility = input.hidden ? "hidden" : "";
            });
        },
        { selector, hidden },
    );

/** Every room outline solid magenta, a colour nothing else on the map or in a label uses. */
const setOutlinesMarked = (page: Page, marked: boolean): Promise<void> =>
    page.locator(CARD).evaluate((card: Element, value: boolean) => {
        const root = card.shadowRoot!;
        root.getElementById("outline-marked")?.remove();
        if (!value) return;
        const style = document.createElement("style");
        style.id = "outline-marked";
        style.textContent = `.room-outline { stroke: rgb(255, 0, 255) !important; stroke-dasharray: none !important;
            stroke-width: calc(3px / var(--map-scale)) !important; transition: none !important; }`;
        root.appendChild(style);
    }, marked);

/** Pixels in a screenshot that are the marked outline's magenta (or a blend that is mostly it). */
function magentaPixels(png: Buffer): number {
    const image = PNG.sync.read(png);
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4) {
        const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
        if (r > 180 && b > 180 && g < 110) count++;
    }
    return count;
}

/**
 * No room outline is painted over any pill, and every pill paints where it is laid out.
 *
 * The outlines are drawn solid magenta for the check, so a border crossing a label shows as magenta
 * pixels inside the label's box. Nothing is toggled between two screenshots: text and antialiased
 * edges can land a subpixel apart from one paint to the next, which made a before/after comparison
 * flaky. The map itself must show magenta, or the check would be vacuous.
 */
async function expectPillsOnTop(page: Page, label: string): Promise<number> {
    const bands = await pillBands(page);
    expect(bands.length, `${label}: pills on screen`).toBeGreaterThan(0);
    await setOutlinesMarked(page, true);
    try {
        const zoomer = (await page.locator(CARD).locator("#map-zoomer").boundingBox())!;
        expect(magentaPixels(await page.screenshot({ clip: zoomer })), `${label}: outlines drawn`).toBeGreaterThan(100);
        for (const { id, clip } of bands) {
            const pixels = magentaPixels(await page.screenshot({ clip, animations: "disabled" }));
            expect(pixels, `${label}: no room border is painted over room ${id}'s label`).toBe(0);
        }
    } finally {
        await setOutlinesMarked(page, false);
    }
    for (const { id, clip } of bands) {
        const shown = await page.screenshot({ clip, animations: "disabled" });
        await setHidden(page, `.room-${id}-wrapper .room-pill-anchor`, true);
        const withoutPill = await page.screenshot({ clip, animations: "disabled" });
        await setHidden(page, `.room-${id}-wrapper .room-pill-anchor`, false);
        expect(shown.equals(withoutPill), `${label}: room ${id}'s label is painted where it is laid out`).toBe(false);
    }
    return bands.length;
}

for (const rotation of [0, 90] as const) {
    test(`every room of a real floor plan is found and a tap selects the room under it, rotation ${rotation}`, async ({
        page,
    }) => {
        await mount(page, rotation);
        // Turned a quarter, the flat is taller than the map area: zoom out until all of it shows.
        if (rotation === 90)
            await page.evaluate(() => (window as unknown as HarnessWindow).visualHarness.setZoom(0.68));
        for (const room of ROOMS) {
            expect(await roomAt(page, room.inside, rotation), `inside ${room.name ?? room.id}`).toEqual([room.id]);
        }
        for (const [a, aId, b, bId] of WALL_PAIRS) {
            expect(await roomAt(page, a, rotation), `${aId} side of the wall with ${bId}`).toEqual([aId]);
            expect(await roomAt(page, b, rotation), `${bId} side of the wall with ${aId}`).toEqual([bId]);
        }
    });

    // The whole flat (1 upright, 0.68 turned a quarter), and the middle of it zoomed in.
    for (const zoom of rotation === 0 ? ([1, 2.5] as const) : ([0.68, 2.5] as const)) {
        test(`labels sit above every room border, unselected and selected, zoom ${zoom} rotation ${rotation}`, async ({
            page,
        }) => {
            await mount(page, rotation);
            if (zoom === 0.68)
                await page.evaluate(() => (window as unknown as HarnessWindow).visualHarness.setZoom(0.68));
            if (zoom === 2.5) {
                // Frame the middle of the flat, where the small rooms and the most borders are.
                await page.evaluate(
                    z => (window as unknown as HarnessWindow).visualHarness.setZoom(z, { x: 0.55, y: 0.5 }),
                    zoom,
                );
            }
            const label = `zoom ${zoom} rotation ${rotation}`;
            // Unselected: every room shows its name pill (the card names the room the camera does not).
            const unselected = await expectPillsOnTop(page, `${label}, unselected`);
            if (zoom !== 2.5) expect(unselected).toBe(ROOMS.length);

            // Selected: every room, so every pill carries its badge (the unnamed room a badge alone).
            await page.locator(CARD).evaluate(async (card: any) => {
                for (const room of card.selectableRooms) if (!room._selected) await room.click();
                await card.updateComplete;
            });
            await page.waitForTimeout(300);
            expect((await selected(page)).length).toBe(ROOMS.length);
            const selectedCount = await expectPillsOnTop(page, `${label}, selected`);
            if (zoom !== 2.5) expect(selectedCount).toBe(ROOMS.length);
        });
    }
}
