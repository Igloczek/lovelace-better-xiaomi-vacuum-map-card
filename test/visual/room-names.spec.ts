import { expect, test, type Page } from "@playwright/test";

import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * `room_names` (#133) on the realistic floor plan, in Chromium and WebKit.
 *
 * The apartment's bathroom (Łazienka, 16) is renamed and the room the camera does not name (18,
 * drawn as "Room 18", like Xiaomi Cloud Map Extractor's `房间18`) has its name hidden. The proof is
 * pixels, since WebKit paints foreignObject HTML away from its layout box when it is placed the
 * wrong way: the renamed pill is painted at its box, and the hidden name leaves nothing painted where
 * its pill was - hiding the room's whole label layer changes no pixel there - while the room keeps its
 * outline and stays selectable, its order badge painted when selected. No baselines are taken.
 */

const CARD = "better-xiaomi-vacuum-map-card";
const BATHROOM = "16";
const UNNAMED = "18";
const HIDING: Record<string, Partial<MapModeConfig>> = {
    false: { room_names: { [BATHROOM]: "Ванная", [UNNAMED]: false } },
};

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

function config(rotation: number, names?: Partial<MapModeConfig>): XiaomiVacuumMapCardConfig {
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
                ...names,
            } as MapModeConfig,
        ],
        map_rotation: rotation,
        tiles: [],
        icons: [],
        persist_map_view: false,
    } as XiaomiVacuumMapCardConfig;
}

/** Mounts the card, zoomed in on room `zoomOn` when `zoom` is not 1. */
async function mount(page: Page, cardConfig: XiaomiVacuumMapCardConfig, zoom: number, zoomOn = UNNAMED): Promise<void> {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as HarnessWindow).visualHarness?.ready);
    await page.evaluate(() => {
        (document.getElementById("card-root") as HTMLElement).style.width = "400px";
    });
    await page.evaluate(input => (window as unknown as HarnessWindow).visualHarness.mount(input), cardConfig);
    await expect(page.locator(CARD)).toBeVisible();
    await expect.poll(() => page.locator(CARD).locator(".room-wrapper").count(), { message: "rooms detected" }).toBe(9);
    if (zoom !== 1) {
        const anchor = await page.evaluate(
            id => (window as unknown as HarnessWindow).visualHarness.roomAnchor(id),
            zoomOn,
        );
        await page.evaluate(
            input => (window as unknown as HarnessWindow).visualHarness.setZoom(input.zoom, input.anchor),
            { zoom, anchor },
        );
    }
    await page.waitForTimeout(400);
}

const pillSelector = (id: string): string => `.room-${id}-wrapper .room-pill`;
const layerSelector = (id: string): string => `.room-label-layer.room-${id}-wrapper`;

function box(page: Page, selector: string): Promise<Box> {
    return page.locator(CARD).evaluate((card: Element, input: string) => {
        const element = card.shadowRoot!.querySelector(input);
        if (!element) throw new Error(`${input} is not rendered`);
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector);
}

function text(page: Page, selector: string): Promise<string | undefined> {
    return page
        .locator(CARD)
        .evaluate(
            (card: Element, input: string) => card.shadowRoot!.querySelector(input)?.textContent?.trim(),
            selector,
        );
}

function exists(page: Page, selector: string): Promise<boolean> {
    return page
        .locator(CARD)
        .evaluate((card: Element, input: string) => !!card.shadowRoot!.querySelector(input), selector);
}

/** A pill box without its rounded ends and the band its shadow and edge antialiasing reach. */
function core(b: Box): Box {
    return { x: b.x + b.height / 2, y: b.y + b.height * 0.3, width: b.width - b.height, height: b.height * 0.4 };
}

/** Whether hiding the element at `selector` changes the pixels inside `area`. */
async function hidingChanges(page: Page, selector: string, area: Box): Promise<boolean> {
    const viewport = page.viewportSize()!;
    const clip = {
        x: Math.max(0, Math.floor(area.x)),
        y: Math.max(0, Math.floor(area.y)),
        width: Math.ceil(area.width),
        height: Math.ceil(area.height),
    };
    expect(clip.x + clip.width <= viewport.width && clip.y + clip.height <= viewport.height, "on screen").toBe(true);
    const toggle = (hidden: boolean) =>
        page.locator(CARD).evaluate(
            (card: Element, input: { selector: string; hidden: boolean }) => {
                (card.shadowRoot!.querySelector(input.selector) as HTMLElement).style.visibility = input.hidden
                    ? "hidden"
                    : "";
            },
            { selector, hidden },
        );
    const shown = await page.screenshot({ clip, animations: "disabled" });
    await toggle(true);
    const hidden = await page.screenshot({ clip, animations: "disabled" });
    await toggle(false);
    return !shown.equals(hidden);
}

for (const [hiding, NAMES] of Object.entries(HIDING))
    for (const zoom of [1, 2.5] as const) {
        for (const rotation of [0, 90] as const) {
            test(`a renamed room shows its new name and a hidden one (${hiding}) paints no pill at zoom ${zoom} and rotation ${rotation}`, async ({
                page,
            }) => {
                await mount(page, config(rotation), zoom);
                expect(await text(page, `${pillSelector(UNNAMED)} .room-pill-name`)).toBe("Room 18");
                const unnamedPill = await box(page, pillSelector(UNNAMED));
                // The check below can see a pill: hiding the plain card's label layer changes its pixels.
                expect(await hidingChanges(page, layerSelector(UNNAMED), core(unnamedPill)), "plain pill painted").toBe(
                    true,
                );

                // Renamed, and painted at its box (zoomed in on the bathroom, so it is on the map).
                await mount(page, config(rotation, NAMES), zoom, BATHROOM);
                expect(await text(page, `${pillSelector(BATHROOM)} .room-pill-name`)).toBe("Ванная");
                const bathroom = await box(page, pillSelector(BATHROOM));
                expect(await hidingChanges(page, pillSelector(BATHROOM), bathroom), "renamed pill painted").toBe(true);

                await mount(page, config(rotation, NAMES), zoom);

                // Hidden: no pill and nothing of the room's labels painted where its pill was; its outline
                // is still drawn.
                expect(await exists(page, pillSelector(UNNAMED)), "no pill for a hidden name").toBe(false);
                expect(
                    await hidingChanges(page, layerSelector(UNNAMED), core(unnamedPill)),
                    "nothing painted there",
                ).toBe(false);
                expect(await exists(page, `.room-${UNNAMED}-wrapper .room-outline`), "outline drawn").toBe(true);

                // Still selectable: a tap selects it, and its order badge (no name) is painted.
                const point = await page.evaluate(
                    id => (window as unknown as HarnessWindow).visualHarness.roomPoint(id, 0.5, 0.15),
                    UNNAMED,
                );
                await page.mouse.click(point.x, point.y);
                await expect
                    .poll(() =>
                        page.evaluate(() => (window as unknown as HarnessWindow).visualHarness.selectedRoomIds()),
                    )
                    .toContain(UNNAMED);
                await page.waitForTimeout(200);
                expect(await text(page, pillSelector(UNNAMED))).toBe("1");
                expect(await exists(page, `${pillSelector(UNNAMED)} .room-pill-name`)).toBe(false);
                const badge = await box(page, pillSelector(UNNAMED));
                expect(await hidingChanges(page, pillSelector(UNNAMED), badge), "badge painted").toBe(true);
            });
        }
    }
