import { expect, test, type Page } from "@playwright/test";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * The selected-room pill (Xiaomi Home app style): a badge with the room's place in the order, or a
 * checkmark, and the room name, with a pointer at the room's anchor.
 *
 * Every case asserts geometry and computed colours, so it runs on any machine; the screenshots are
 * the visual record and their baselines are generated in the pinned Playwright image (see
 * README.md). Readability is the hard requirement: name on pill and glyph on badge must reach WCAG
 * AA (4.5:1) in the light and dark theme, and the pill must stand out from whatever is behind it.
 */

const CARD = "xiaomi-vacuum-map-card";

interface VisualWindow {
    visualHarness: {
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
        setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<{ mapScale: number }>;
        roomAnchor: (roomId: string) => { x: number; y: number };
        roomPoint: (roomId: string, fractionX?: number, fractionY?: number) => { x: number; y: number };
        selectedRoomIds: () => string[];
    };
}

/** Home Assistant's default dark theme values the card reads. */
const DARK_THEME = `
    :root {
        --primary-text-color: #e1e1e1;
        --text-light-primary-color: #ffffff;
        --slider-color: #03a9f4;
        --slider-secondary-color: #4d4d4d;
        --secondary-background-color: #282828;
        --disabled-text-color: #6f6f6f;
        --card-background-color: #1c1c1c;
        color-scheme: dark;
    }
    html, body { background: #111111; }
`;

type Theme = "light" | "dark";

function config(mode: Partial<MapModeConfig>, overrides: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [{ template: "vacuum_clean_segment", ...mode } as MapModeConfig],
        tiles: [],
        icons: [],
        persist_map_view: false,
        ...overrides,
    };
}

async function open(page: Page, theme: Theme, cardConfig: XiaomiVacuumMapCardConfig): Promise<void> {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as { visualHarness?: { ready: boolean } }).visualHarness?.ready);
    if (theme === "dark") await page.addStyleTag({ content: DARK_THEME });
    await page.evaluate(input => (window as unknown as VisualWindow).visualHarness.mount(input), cardConfig);
    await expect(page.locator(CARD)).toBeVisible();
}

async function select(page: Page, ids: string[]): Promise<void> {
    for (const id of ids) {
        const point = await page.evaluate(roomId => (window as unknown as VisualWindow).visualHarness.roomPoint(roomId, 0.25, 0.5), id);
        await page.mouse.click(point.x, point.y);
    }
    await expect
        .poll(() => page.evaluate(() => (window as unknown as VisualWindow).visualHarness.selectedRoomIds()))
        .toEqual(ids);
}

/**
 * The room label's anchor on screen: its `x`/`y` through the SVG's screen transform. The label is
 * drawn centred on that point (and turned around it), so it is where the pill's pointer must end.
 */
async function labelCentre(page: Page, id: string): Promise<{ x: number; y: number }> {
    return page.locator(CARD).evaluate((card: Element, roomId: string) => {
        const text = card.shadowRoot!.querySelector(`.room-${roomId}-wrapper text.room-label`) as SVGTextElement | null;
        const svg = text?.ownerSVGElement;
        const matrix = svg?.getScreenCTM();
        if (!text || !svg || !matrix) throw new Error(`room ${roomId} has no label`);
        const point = svg.createSVGPoint();
        point.x = parseFloat(text.getAttribute("x") ?? "0");
        point.y = parseFloat(text.getAttribute("y") ?? "0");
        const screen = point.matrixTransform(matrix);
        return { x: screen.x, y: screen.y };
    }, id);
}

interface PillMeasure {
    box: { x: number; y: number; width: number; height: number };
    colour: string;
    background: string;
    badgeColour: string;
    badgeBackground: string;
    ring: string;
    pointerEvents: string;
    hitIsPill: boolean;
}

async function measurePill(page: Page, id: string): Promise<PillMeasure> {
    return page.locator(`${CARD}`).evaluate((card: Element, roomId: string) => {
        const root = card.shadowRoot!;
        const pill = root.querySelector(`.room-${roomId}-wrapper .room-pill`) as HTMLElement;
        const badge = pill.querySelector(".room-pill-badge") as HTMLElement;
        const rect = pill.getBoundingClientRect();
        const style = getComputedStyle(pill);
        const badgeStyle = getComputedStyle(badge);
        const hit = root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            colour: style.color,
            background: style.backgroundColor,
            badgeColour: badgeStyle.color,
            badgeBackground: badgeStyle.backgroundColor,
            ring: style.boxShadow,
            pointerEvents: style.pointerEvents,
            hitIsPill: !!hit?.closest(".room-pill"),
        };
    }, id);
}

function rgb(value: string): [number, number, number] {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    if (!match) throw new Error(`not an rgb colour: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(colour: string): number {
    return rgb(colour)
        .map(v => v / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}

function contrast(a: string, b: string): number {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

function expectReadable(pill: PillMeasure, label: string): void {
    expect(contrast(pill.colour, pill.background), `${label}: name on pill`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(pill.badgeColour, pill.badgeBackground), `${label}: glyph on badge`).toBeGreaterThanOrEqual(4.5);
    // The ring in the text colour keeps the pill apart from the map behind it.
    expect(pill.ring, `${label}: ring`).toContain(pill.colour.replace(/\s/g, " "));
    expect(pill.pointerEvents, `${label}: pointer-events`).toBe("none");
    expect(pill.hitIsPill, `${label}: a tap on the pill reaches the room`).toBe(false);
}

for (const theme of ["light", "dark"] as const) {
    test(`room pill readability and geometry in the ${theme} theme`, async ({ page }) => {
        let reference: { width: number; height: number } | undefined;
        for (const rotation of [0, 90] as const) {
            for (const zoom of [1, 2.5] as const) {
                const label = `${theme}, zoom ${zoom}, rotation ${rotation}`;
                await open(page, theme, config({ cleaning_order: true }, { map_rotation: rotation }));
                if (zoom !== 1) {
                    const anchor = await page.evaluate(() => (window as unknown as VisualWindow).visualHarness.roomAnchor("1"));
                    const result = await page.evaluate(
                        input => (window as unknown as VisualWindow).visualHarness.setZoom(input.zoom, input.anchor),
                        { zoom, anchor },
                    );
                    expect(result.mapScale).toBeCloseTo(zoom, 5);
                }
                const anchor = await labelCentre(page, "1");
                // At 2.5x the view is framed on room 1 and room 2 is off screen.
                await select(page, zoom === 1 ? ["1", "2"] : ["1"]);

                await expect(page.locator(`${CARD} .room-1-wrapper .room-pill .room-order`)).toHaveText("1");
                await expect(page.locator(`${CARD} .room-1-wrapper .room-pill-name`)).toHaveText("Living room");
                if (zoom === 1) await expect(page.locator(`${CARD} .room-2-wrapper .room-pill .room-order`)).toHaveText("2");
                await expect(page.locator(`${CARD} .room-1-wrapper text.room-label`)).toHaveCount(0);
                await expect(page.locator(`${CARD} .room-0-wrapper text.room-label`)).toHaveText("Kitchen");

                const pill = await measurePill(page, "1");
                expectReadable(pill, label);
                // The pill follows the theme the way the card does: a light body on a light
                // dashboard, a dark one on a dark dashboard, never the other way round.
                if (theme === "light") {
                    expect(luminance(pill.background), `${label}: light pill`).toBeGreaterThan(0.7);
                } else {
                    expect(luminance(pill.background), `${label}: dark pill`).toBeLessThan(0.2);
                }

                // Upright and the same size on screen at every zoom and rotation.
                expect(pill.box.width, `${label}: upright`).toBeGreaterThan(pill.box.height);
                reference ??= { width: pill.box.width, height: pill.box.height };
                expect(Math.abs(pill.box.width - reference.width), `${label}: width`).toBeLessThanOrEqual(1);
                expect(Math.abs(pill.box.height - reference.height), `${label}: height`).toBeLessThanOrEqual(1);

                // Centred over the room's anchor, the 5 px pointer reaching down to it.
                const centreX = pill.box.x + pill.box.width / 2;
                expect(Math.abs(centreX - anchor.x), `${label}: centred on the anchor`).toBeLessThanOrEqual(1);
                const tipY = pill.box.y + pill.box.height + 5;
                expect(Math.abs(tipY - anchor.y), `${label}: pointer tip on the anchor`).toBeLessThanOrEqual(1.5);

                await expect(page.locator(CARD)).toHaveScreenshot(`room-pill-${theme}-zoom-${zoom}-rotation-${rotation}.png`);
            }
        }
    });
}

test("the badge shows a checkmark when the cleaning order is off", async ({ page }) => {
    for (const theme of ["light", "dark"] as const) {
        await open(page, theme, config({}));
        await select(page, ["1", "2"]);
        await expect(page.locator(`${CARD} .room-pill .room-check svg`)).toHaveCount(2);
        await expect(page.locator(`${CARD} .room-pill .room-order`)).toHaveCount(0);
        expectReadable(await measurePill(page, "1"), `${theme} checkmark`);
        await expect(page.locator(CARD)).toHaveScreenshot(`room-pill-${theme}-checkmark.png`);
    }
});

test("the pill stays readable on a dark dashboard with transparent_background", async ({ page }) => {
    await open(
        page,
        "dark",
        config(
            { cleaning_order: true },
            { map_source: { camera: "camera.vacuum_map", transparent_background: true } },
        ),
    );
    await select(page, ["1"]);
    expectReadable(await measurePill(page, "1"), "dark + transparent_background");
    await expect(page.locator(CARD)).toHaveScreenshot("room-pill-dark-transparent.png");
});

test("a theme that pairs unreadable colours is corrected", async ({ page }) => {
    // A dark name on a dark pill, and a pale glyph on a pale badge: the card must not draw either.
    await open(page, "light", config({ cleaning_order: true }));
    await page.addStyleTag({
        content: `${CARD} { --map-card-room-pill-background-color: #1c1c1c; --map-card-room-pill-text-color: #303030;
                  --map-card-room-pill-badge-color: #ffeb3b; --map-card-room-pill-badge-text-color: #ffffff; }`,
    });
    await select(page, ["1"]);
    // The palette is resolved on render; the selection above rendered with the overrides in place.
    expectReadable(await measurePill(page, "1"), "unreadable overrides");
});
