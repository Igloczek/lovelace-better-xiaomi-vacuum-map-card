import { expect, test, type Page } from "@playwright/test";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * A zone mode opens with one zone painted on the map, ready to drag, with no `+` press. Runs in
 * Chromium and WebKit (playwright.config.ts). The zone is proven by its pixels: the area inside it
 * changes when the polygon is hidden. Then real mouse input moves and resizes it, `+` adds a second
 * one, and the delete control removes the default one, at zoom 1 and with the map rotated by 90.
 */

const CARD = "better-xiaomi-vacuum-map-card";

interface HarnessWindow {
    visualHarness: {
        ready: boolean;
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
    };
}

function config(selectionType: string, rotation: number): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [
            {
                name: "Zone",
                icon: "mdi:select-drag",
                selection_type: selectionType,
                repeats_type: "NONE",
                max_selections: 5,
                service_call_schema: { service: "vacuum.send_command", service_data: { params: "[[selection]]" } },
            } as unknown as MapModeConfig,
        ],
        map_rotation: rotation,
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

async function mount(page: Page, cardConfig: XiaomiVacuumMapCardConfig): Promise<void> {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as HarnessWindow).visualHarness?.ready);
    await page.evaluate(input => (window as unknown as HarnessWindow).visualHarness.mount(input), cardConfig);
    await expect(page.locator(CARD)).toBeVisible();
}

const zones = (page: Page): Promise<number[][]> =>
    page.locator(CARD).evaluate((card: any) => card.selectedManualRectangles.map((r: any) => r.toVacuum()));

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
    const box = await page.locator(CARD).locator(selector).first().boundingBox();
    if (!box) throw new Error(`${selector} is not on screen`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Whether hiding the first zone polygon changes the 5×5 pixels around `point`. */
async function zonePaintsAt(page: Page, point: { x: number; y: number }): Promise<boolean> {
    const clip = { x: Math.round(point.x) - 2, y: Math.round(point.y) - 2, width: 5, height: 5 };
    const toggle = (hidden: boolean): Promise<void> =>
        page.locator(CARD).evaluate((card: Element, value: boolean) => {
            const polygon = card.shadowRoot!.querySelector("polygon.manual-rectangle") as SVGElement;
            polygon.style.visibility = value ? "hidden" : "";
        }, hidden);
    const shown = await page.screenshot({ clip, animations: "disabled" });
    await toggle(true);
    const hidden = await page.screenshot({ clip, animations: "disabled" });
    await toggle(false);
    return !shown.equals(hidden);
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
    await page.mouse.up();
}

for (const selectionType of ["MANUAL_RECTANGLE", "MANUAL_ROTATABLE_RECTANGLE"]) {
    for (const rotation of [0, 90] as const) {
        test(`${selectionType} opens with a painted, draggable zone at map rotation ${rotation}`, async ({ page }) => {
            await mount(page, config(selectionType, rotation));
            const polygons = page.locator(CARD).locator("polygon.manual-rectangle");
            await expect(polygons).toHaveCount(1);
            expect(await zones(page)).toHaveLength(1);

            // The zone lies on the map, and its pixels are painted. The default fill is faint over the
            // harness's white floor; an opaque one makes every painted pixel count without moving it.
            const mapBox = (await page.locator(CARD).locator("#map-image").boundingBox())!;
            const zoneBox = (await polygons.first().boundingBox())!;
            expect(zoneBox.width).toBeGreaterThan(20);
            expect(zoneBox.height).toBeGreaterThan(20);
            expect(zoneBox.x).toBeGreaterThanOrEqual(mapBox.x);
            expect(zoneBox.y).toBeGreaterThanOrEqual(mapBox.y);
            expect(zoneBox.x + zoneBox.width).toBeLessThanOrEqual(mapBox.x + mapBox.width);
            expect(zoneBox.y + zoneBox.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);
            await page.locator(CARD).evaluate((card: Element) => {
                const polygon = card.shadowRoot!.querySelector("polygon.manual-rectangle") as SVGElement;
                polygon.style.setProperty("fill", "rgb(255, 0, 255)", "important");
                polygon.style.setProperty("fill-opacity", "1", "important");
            });
            const inside = { x: zoneBox.x + zoneBox.width * 0.3, y: zoneBox.y + zoneBox.height * 0.7 };
            expect(await zonePaintsAt(page, inside), "the default zone is painted").toBe(true);

            // The label pill is painted where it is laid out (WebKit paints foreignObject HTML away
            // from its box when it is misplaced), and the outline shows over white floor.
            const pill = page.locator(CARD).locator(".manual-rectangle-description .room-pill").first();
            const pillBox = (await pill.boundingBox())!;
            const pillCentre = { x: pillBox.x + pillBox.width / 2, y: pillBox.y + pillBox.height / 2 };
            const pillShown = await page.screenshot({
                clip: { x: pillBox.x, y: pillBox.y, width: pillBox.width, height: pillBox.height },
            });
            await page.locator(CARD).evaluate((card: Element) => {
                (card.shadowRoot!.querySelector(".manual-rectangle-description") as SVGElement).style.visibility =
                    "hidden";
            });
            const pillHidden = await page.screenshot({
                clip: { x: pillBox.x, y: pillBox.y, width: pillBox.width, height: pillBox.height },
            });
            await page.locator(CARD).evaluate((card: Element) => {
                (card.shadowRoot!.querySelector(".manual-rectangle-description") as SVGElement).style.visibility = "";
            });
            expect(pillShown.equals(pillHidden), "the label pill is painted").toBe(false);
            expect(pillCentre.x).toBeGreaterThan(zoneBox.x);
            expect(pillCentre.x).toBeLessThan(zoneBox.x + zoneBox.width);

            // Real mouse input moves it and resizes it.
            const [start] = await zones(page);
            await drag(page, inside, 30, 20);
            const [moved] = await zones(page);
            expect(moved, "the zone moves").not.toEqual(start);
            await drag(page, await centreOf(page, ".manual-rectangle-resize-circle"), 25, 25);
            const [resized] = await zones(page);
            expect(resized, "the zone resizes").not.toEqual(moved);

            // + adds a second zone; deleting the first leaves the second, renumbered.
            await page.locator(CARD).locator(".map-actions-item:has(ha-icon[icon='mdi:plus'])").click();
            await expect(polygons).toHaveCount(2);
            const delete1 = await centreOf(page, ".manual-rectangle-delete-circle");
            await page.mouse.click(delete1.x, delete1.y);
            await expect(polygons).toHaveCount(1);
            expect(await zones(page)).toHaveLength(1);
        });
    }
}
