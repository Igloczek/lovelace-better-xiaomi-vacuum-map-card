import { expect, test, type Page } from "@playwright/test";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * `room_label_offsets` (#126) on the realistic floor plan, in Chromium and WebKit.
 *
 * The apartment's corridor (Korytarz, 13) wraps around the storage room (Schowek, 14), and the
 * colour-detected label points of the two put their pills on top of each other: the case the issue
 * reports (an L-shaped hallway around a kitchen). Nudging the corridor's pill must move it on
 * screen by exactly the configured pixels, at any zoom and rotation (the offset is applied after the
 * counter-rotation), and it must be *painted* there: WebKit paints foreignObject HTML away from its
 * layout box when it is placed the wrong way, so the proof is pixels - hiding the pill changes the
 * pixels at its new box and no longer changes them at its old one. No baselines are taken.
 */

const CARD = "better-xiaomi-vacuum-map-card";
const CORRIDOR = "13";
const STORAGE = "14";
/** Up and a little left: clear of the storage room's pill, by more than a pill's height. */
const NUDGE = { offset_x: -10, offset_y: -30 };

interface HarnessWindow {
    visualHarness: {
        ready: boolean;
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
        setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<unknown>;
        roomAnchor: (roomId: string) => { x: number; y: number };
        roomPoint: (roomId: string, fractionX?: number, fractionY?: number) => { x: number; y: number };
        selectedRoomIds: () => string[];
    };
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

function config(rotation: number, offsets?: MapModeConfig["room_label_offsets"]): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.apartment_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [
            {
                template: "vacuum_clean_segment",
                cleaning_order: true,
                max_selections: 10,
                ...(offsets ? { room_label_offsets: offsets } : {}),
            } as MapModeConfig,
        ],
        map_rotation: rotation,
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

async function mount(page: Page, cardConfig: XiaomiVacuumMapCardConfig, zoom: number): Promise<void> {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as HarnessWindow).visualHarness?.ready);
    await page.evaluate(input => (window as unknown as HarnessWindow).visualHarness.mount(input), cardConfig);
    await expect(page.locator(CARD)).toBeVisible();
    await expect.poll(() => page.locator(CARD).locator(".room-wrapper").count(), { message: "rooms detected" }).toBe(9);
    if (zoom !== 1) {
        const anchor = await page.evaluate(
            id => (window as unknown as HarnessWindow).visualHarness.roomAnchor(id),
            CORRIDOR,
        );
        await page.evaluate(
            input => (window as unknown as HarnessWindow).visualHarness.setZoom(input.zoom, input.anchor),
            { zoom, anchor },
        );
    }
    await page.waitForTimeout(400);
}

const pillSelector = (id: string): string => `.room-${id}-wrapper .room-pill`;

function pillBox(page: Page, id: string): Promise<Box> {
    return page.locator(CARD).evaluate((card: Element, selector: string) => {
        const pill = card.shadowRoot!.querySelector(selector);
        if (!pill) throw new Error(`${selector} is not rendered`);
        const r = pill.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, pillSelector(id));
}

function overlaps(a: Box, b: Box): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** A pill box without its rounded ends and the band its shadow and edge antialiasing reach. */
function core(box: Box): Box {
    return {
        x: box.x + box.height / 2,
        y: box.y + box.height * 0.3,
        width: box.width - box.height,
        height: box.height * 0.4,
    };
}

/** Whether hiding the pill of room `id` changes the pixels inside `box`. */
async function hidingChanges(page: Page, id: string, box: Box): Promise<boolean> {
    const viewport = page.viewportSize()!;
    const clip = {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
    };
    expect(clip.x + clip.width <= viewport.width && clip.y + clip.height <= viewport.height, "on screen").toBe(true);
    const toggle = (hidden: boolean) =>
        page.locator(CARD).evaluate(
            (card: Element, input: { selector: string; hidden: boolean }) => {
                (card.shadowRoot!.querySelector(input.selector) as HTMLElement).style.visibility = input.hidden
                    ? "hidden"
                    : "";
            },
            { selector: pillSelector(id), hidden },
        );
    const shown = await page.screenshot({ clip, animations: "disabled" });
    await toggle(true);
    const hidden = await page.screenshot({ clip, animations: "disabled" });
    await toggle(false);
    return !shown.equals(hidden);
}

for (const zoom of [1, 2.5] as const) {
    for (const rotation of [0, 90] as const) {
        test(`a nudged room pill moves clear of its neighbour and is painted there at zoom ${zoom} and rotation ${rotation}`, async ({
            page,
        }) => {
            await mount(page, config(rotation), zoom);
            const corridorBefore = await pillBox(page, CORRIDOR);
            const storageBefore = await pillBox(page, STORAGE);
            // The fixture's own collision, on the whole plan: without the key the two pills overlap.
            // Zoomed in or turned, the rooms spread apart while the pills keep their size.
            const collides = zoom === 1 && rotation === 0;
            if (collides)
                expect(overlaps(corridorBefore, storageBefore), "the pills collide without the key").toBe(true);

            await mount(page, config(rotation, { [CORRIDOR]: NUDGE }), zoom);
            const corridor = await pillBox(page, CORRIDOR);
            const storage = await pillBox(page, STORAGE);
            // Moved by the configured screen pixels, whatever the zoom and rotation; the neighbour stays.
            expect(corridor.x - corridorBefore.x).toBeCloseTo(NUDGE.offset_x, 0);
            expect(corridor.y - corridorBefore.y).toBeCloseTo(NUDGE.offset_y, 0);
            expect(storage).toEqual(storageBefore);
            if (collides) expect(overlaps(corridor, storage), "the nudge separates the pills").toBe(false);

            // Painted at the new box, and no longer at the old one.
            expect(await hidingChanges(page, CORRIDOR, corridor), "painted where it moved to").toBe(true);
            // The old box's solid middle: the moved pill's soft shadow may still reach its edge.
            expect(await hidingChanges(page, CORRIDOR, core(corridorBefore)), "gone from where it was").toBe(false);

            // Selected, the badged pill keeps the nudge.
            const point = await page.evaluate(
                id => (window as unknown as HarnessWindow).visualHarness.roomPoint(id, 0.5, 0.15),
                CORRIDOR,
            );
            await page.mouse.click(point.x, point.y);
            await expect
                .poll(() => page.evaluate(() => (window as unknown as HarnessWindow).visualHarness.selectedRoomIds()))
                .toContain(CORRIDOR);
            await page.waitForTimeout(200);
            const selected = await pillBox(page, CORRIDOR);
            if (collides) expect(overlaps(selected, storage), "the selected pill stays clear").toBe(false);
            expect(await hidingChanges(page, CORRIDOR, selected), "the selected pill is painted there").toBe(true);
        });
    }
}
