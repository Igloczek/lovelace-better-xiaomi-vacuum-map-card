import { expect, test, type Page } from "@playwright/test";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { inkGaps } from "../support/ink-centre";

/**
 * Every HTML overlay on the map (label pills, room and point icons) is painted where its layout box
 * is. This spec runs in Chromium **and WebKit** (playwright.config.ts): WebKit, the engine of Safari
 * and of the Home Assistant iOS and macOS apps, paints HTML inside an SVG foreignObject away from its
 * layout box when that HTML is positioned, transformed or filtered, while `getBoundingClientRect`
 * still reports the right place. 1.5.0 shipped that way: every geometry check passed in Chromium and
 * the Home Assistant app showed a map without labels.
 *
 * A layout box therefore proves nothing; the pixels do. For each overlay the spec screenshots the
 * area of its box, hides the overlay, and screenshots the same area again: the two must differ,
 * which they only do when the overlay is painted there. No baselines are involved, so the check runs
 * in any engine.
 */

const CARD = "better-xiaomi-vacuum-map-card";

interface PaintWindow {
    visualHarness: {
        ready: boolean;
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
        setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<{ mapScale: number }>;
        roomAnchor: (roomId: string) => { x: number; y: number };
        roomPoint: (roomId: string, fractionX?: number, fractionY?: number) => { x: number; y: number };
        selectedRoomIds: () => string[];
    };
}

function config(mode: Partial<MapModeConfig>, rotation: number): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [mode as MapModeConfig],
        map_rotation: rotation,
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

/** Kitchen with an icon and its label below it; Living room and Bedroom as the camera names them. */
const ROOM_MODE: Partial<MapModeConfig> = {
    template: "vacuum_clean_segment",
    cleaning_order: true,
    predefined_selections: [
        {
            id: 0,
            icon: { name: "mdi:silverware-fork-knife", x: 500, y: 350 },
            label: { text: "Kitchen", x: 500, y: 350, offset_y: 30 },
            outline: [
                [200, 200],
                [800, 200],
                [800, 700],
                [200, 700],
            ],
        },
    ],
} as Partial<MapModeConfig>;

const POINT_MODE: Partial<MapModeConfig> = {
    name: "Points",
    icon: "mdi:map-marker",
    selection_type: "PREDEFINED_POINT",
    repeats_type: "NONE",
    service_call_schema: { service: "vacuum.send_command", service_data: { entity_id: "[[entity_id]]" } },
    predefined_selections: [
        {
            position: [1350, 450],
            icon: { name: "mdi:sofa", x: 1350, y: 450 },
            label: { text: "Sofa", x: 1350, y: 450, offset_y: 30 },
        },
    ],
} as Partial<MapModeConfig>;

async function mount(page: Page, cardConfig: XiaomiVacuumMapCardConfig): Promise<void> {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as PaintWindow).visualHarness?.ready);
    await page.evaluate(input => (window as unknown as PaintWindow).visualHarness.mount(input), cardConfig);
    await expect(page.locator(CARD)).toBeVisible();
    // Icons are ha-icon elements the harness resolves asynchronously; let them and the pills settle.
    await page.waitForTimeout(500);
}

/**
 * Proves the overlay matched by `selector` (inside the card's shadow root) is painted inside its
 * own layout box: hiding it must change the pixels there.
 */
async function expectPaintedInPlace(page: Page, selector: string, label: string): Promise<void> {
    const box = await page.locator(CARD).evaluate((card: Element, sel: string) => {
        const element = card.shadowRoot!.querySelector(sel);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, selector);
    expect(box, `${label}: ${selector} is rendered`).not.toBeNull();
    const viewport = page.viewportSize()!;
    const clip = {
        x: Math.max(0, Math.floor(box!.x)),
        y: Math.max(0, Math.floor(box!.y)),
        width: Math.ceil(box!.width),
        height: Math.ceil(box!.height),
    };
    expect(clip.width * clip.height, `${label}: ${selector} has a size`).toBeGreaterThan(0);
    expect(
        clip.x + clip.width <= viewport.width && clip.y + clip.height <= viewport.height,
        `${label}: on screen`,
    ).toBe(true);

    const shown = await page.screenshot({ clip, animations: "disabled" });
    await page.locator(CARD).evaluate((card: Element, sel: string) => {
        (card.shadowRoot!.querySelector(sel) as HTMLElement).style.visibility = "hidden";
    }, selector);
    const hidden = await page.screenshot({ clip, animations: "disabled" });
    await page.locator(CARD).evaluate((card: Element, sel: string) => {
        (card.shadowRoot!.querySelector(sel) as HTMLElement).style.visibility = "";
    }, selector);
    expect(shown.equals(hidden), `${label}: ${selector} is painted where its layout box is`).toBe(false);
}

async function tapRoom(page: Page, id: string): Promise<void> {
    const point = await page.evaluate(
        roomId => (window as unknown as PaintWindow).visualHarness.roomPoint(roomId, 0.75, 0.75),
        id,
    );
    await page.mouse.click(point.x, point.y);
    await expect
        .poll(() => page.evaluate(() => (window as unknown as PaintWindow).visualHarness.selectedRoomIds()))
        .toContain(id);
}

for (const zoom of [1, 2.5] as const) {
    for (const rotation of [0, 90] as const) {
        test(`room labels and icons are painted in place at zoom ${zoom} and rotation ${rotation}`, async ({
            page,
        }) => {
            const label = `zoom ${zoom} rotation ${rotation}`;
            await mount(page, config(ROOM_MODE, rotation));
            if (zoom !== 1) {
                const anchor = await page.evaluate(() =>
                    (window as unknown as PaintWindow).visualHarness.roomAnchor("0"),
                );
                await page.evaluate(
                    input => (window as unknown as PaintWindow).visualHarness.setZoom(input.zoom, input.anchor),
                    { zoom, anchor },
                );
            }
            // Unselected: the icon and the badge-less pill.
            await expectPaintedInPlace(page, ".room-0-wrapper .room-icon-wrapper", `${label}, icon`);
            await expectPaintedInPlace(page, ".room-0-wrapper .room-pill.no-badge", `${label}, unselected pill`);
            // Selected: the badged pill.
            await tapRoom(page, "0");
            await expectPaintedInPlace(page, ".room-0-wrapper .room-pill:not(.no-badge)", `${label}, selected pill`);
            await expectPaintedInPlace(page, ".room-0-wrapper .room-pill-badge", `${label}, badge`);
        });
    }
}

test("a predefined point's icon and label are painted in place", async ({ page }) => {
    await mount(page, config(POINT_MODE, 0));
    await expectPaintedInPlace(page, ".predefined-point-icon-wrapper", "point icon");
    await expectPaintedInPlace(page, ".room-pill.predefined-point-label", "point label");
});

test("a pill's name and badge number are centred on their letters", async ({ page }) => {
    // Bedroom has no descender and no icon, so its capitals and its baseline are the letters to
    // centre, unselected and selected. The check reads pixels: the font decides where its glyphs
    // sit inside the layout box.
    await mount(page, config(ROOM_MODE, 0));
    const card = page.locator(CARD);
    const unselected = await inkGaps(page, card, ".room-2-wrapper .room-pill", ".room-2-wrapper .room-pill-name");
    expect(Math.abs(unselected.above - unselected.below), `name ${JSON.stringify(unselected)}`).toBeLessThanOrEqual(1);
    await tapRoom(page, "2");
    const name = await inkGaps(page, card, ".room-2-wrapper .room-pill", ".room-2-wrapper .room-pill-name");
    expect(Math.abs(name.above - name.below), `name ${JSON.stringify(name)}`).toBeLessThanOrEqual(1);
    const number = await inkGaps(
        page,
        card,
        ".room-2-wrapper .room-pill-badge",
        ".room-2-wrapper .room-pill-badge .room-pill-text",
    );
    expect(Math.abs(number.above - number.below), `badge ${JSON.stringify(number)}`).toBeLessThanOrEqual(1);
});
