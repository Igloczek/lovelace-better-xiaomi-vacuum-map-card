import { expect, test, type Page } from "@playwright/test";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * A turned zone is painted turned. Runs in Chromium and WebKit (playwright.config.ts): the zone is
 * an SVG polygon, and a box check would pass for an outline painted unturned, so the proof is the
 * pixels. Two points are compared with the polygon shown and hidden: one inside the turned zone but
 * outside the unturned box (it must change), and one inside the unturned box but outside the turned
 * zone (it must not). Both at zoom 1 and rotation 0, and with the map rotated by 90.
 */

const CARD = "better-xiaomi-vacuum-map-card";

interface HarnessWindow {
    visualHarness: {
        ready: boolean;
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
    };
}

const ZONE_MODE: Partial<MapModeConfig> = {
    name: "Turned zone",
    icon: "mdi:rotate-right",
    selection_type: "MANUAL_ROTATABLE_RECTANGLE",
    repeats_type: "NONE",
    service_call_schema: { service: "vacuum.send_command", service_data: { params: "[[selection]]" } },
} as Partial<MapModeConfig>;

function config(rotation: number): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:better-xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [ZONE_MODE as MapModeConfig],
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

/** The polygon's corners on screen, from its `points` through its screen transform. */
function screenCorners(page: Page): Promise<Array<{ x: number; y: number }>> {
    return page.locator(CARD).evaluate((card: Element) => {
        const polygon = card.shadowRoot!.querySelector("polygon.manual-rectangle") as SVGPolygonElement;
        const matrix = polygon.getScreenCTM()!;
        return Array.from(polygon.points).map(p => {
            const s = new DOMPoint(p.x, p.y).matrixTransform(matrix);
            return { x: s.x, y: s.y };
        });
    });
}

/** Whether hiding the zone polygon changes the 3×3 pixels around `point`. */
async function zonePaintsAt(page: Page, point: { x: number; y: number }): Promise<boolean> {
    const clip = { x: Math.round(point.x) - 1, y: Math.round(point.y) - 1, width: 3, height: 3 };
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

const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
});

for (const rotation of [0, 90] as const) {
    test(`a turned zone is painted turned at map rotation ${rotation}`, async ({ page }) => {
        await mount(page, config(rotation));
        // The zone mode opens with its zone already on the map.
        await expect.poll(() => page.locator(CARD).locator("polygon.manual-rectangle").count()).toBe(1);

        // The default fill is faint over the harness's white floor; an opaque one makes every
        // painted pixel count. It changes the colour only, not where the polygon is painted.
        await page.locator(CARD).evaluate((card: Element) => {
            const polygon = card.shadowRoot!.querySelector("polygon.manual-rectangle") as SVGElement;
            polygon.style.setProperty("fill", "rgb(255, 0, 255)", "important");
            polygon.style.setProperty("fill-opacity", "1", "important");
        });
        const unturned = await screenCorners(page);
        const centre = lerp(unturned[0], unturned[2], 0.5);
        await page.locator(CARD).evaluate((card: any) => {
            card.selectedManualRectangles[0].setAngle(Math.PI / 6);
            card.requestUpdate();
        });
        await page.waitForTimeout(100);
        const turned = await screenCorners(page);
        expect(
            turned.some((p, i) => Math.hypot(p.x - unturned[i].x, p.y - unturned[i].y) > 5),
            "the corners move when the zone turns",
        ).toBe(true);
        expect(await page.locator(CARD).locator(".manual-rectangle-rotate-circle").count()).toBe(1);

        // Near a turned corner: inside the turned zone. Near an unturned corner: inside the old box.
        const insideTurned = turned.map(corner => lerp(centre, corner, 0.85));
        const insideBox = unturned.map(corner => lerp(centre, corner, 0.92));
        const inPolygon = (point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>): boolean => {
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const [a, b] = [polygon[i], polygon[j]];
                if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x)
                    inside = !inside;
            }
            return inside;
        };
        const onlyTurned = insideTurned.find(p => !inPolygon(p, unturned));
        const onlyBox = insideBox.find(p => !inPolygon(p, turned));
        expect(onlyTurned, "a point inside the turned zone outside the box").toBeDefined();
        expect(onlyBox, "a point inside the box outside the turned zone").toBeDefined();
        expect(await zonePaintsAt(page, onlyTurned!), "the turned zone is painted at its turned corner").toBe(true);
        expect(await zonePaintsAt(page, onlyBox!), "nothing of the zone is left at the unturned corner").toBe(false);
    });
}
