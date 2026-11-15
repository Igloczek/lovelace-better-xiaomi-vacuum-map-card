import { expect, test, type Page } from "@playwright/test";

import type { RoomConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * The stale-room `!` marker on the map overlay.
 *
 * A configured ROOM id that the camera no longer reports is drawn from its stored outline and
 * marked with an exclamation mark. After a re-map the live room with the same geometry keeps the
 * same label point, so the stale marker and that room's selected pill share it: the marker must
 * stay clear of the pill, or, when the room is too small for that, stay inside the room and be
 * painted above the pill. In every case it belongs inside the stale room's outline and inside the
 * map, because a marker over a neighbouring room names the wrong room.
 *
 * These are geometry assertions, so they run on any machine; baselines live in `__screenshots__/`
 * and are regenerated in the pinned Playwright image (see README.md).
 */

const CARD = "xiaomi-vacuum-map-card";

const ZOOMS = [0.5, 1, 2.5, 4];
const ROTATIONS = [0, 90, 180, 270];

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface VisualWindow {
    visualHarness: {
        mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
        setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<{ mapScale: number }>;
        roomAnchor: (roomId: string) => { x: number; y: number };
        roomPoint: (roomId: string, fractionX?: number, fractionY?: number) => { x: number; y: number };
        selectedRoomIds: () => string[];
    };
}

function cardConfig(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [{ template: "vacuum_clean_segment", cleaning_order: true }],
        tiles: [],
        icons: [],
        persist_map_view: false,
        ...overrides,
    };
}

/** A configured room the camera has no id for: stale, drawn from the stored outline. */
function staleRoom(overrides: Partial<RoomConfig>): RoomConfig {
    return {
        id: "9",
        label: { text: "Old room", x: 1350, y: 450, offset_y: 35 },
        icon: { name: "mdi:broom", x: 1350, y: 450 },
        ...overrides,
    } as RoomConfig;
}

/** The stale room lies exactly over live room 1, so their label points coincide. */
const STALE_OVER_LIVING_ROOM = staleRoom({
    outline: [
        [1000, 200],
        [1700, 200],
        [1700, 700],
        [1000, 700],
    ],
});

/** The stale room lies over live room 2: ~120 × 80 map px, small at 0.5× zoom. */
const STALE_OVER_BEDROOM = staleRoom({
    label: { text: "Old bedroom", x: 500, y: 1100, offset_y: 35 },
    icon: { name: "mdi:broom", x: 500, y: 1100 },
    outline: [
        [200, 900],
        [800, 900],
        [800, 1300],
        [200, 1300],
    ],
});

/** A stale room along the map's top edge (image y 0): its marker must not leave the map. */
const STALE_AT_TOP_EDGE = staleRoom({
    label: { text: "Old hallway", x: 1350, y: 200, offset_y: 35 },
    icon: { name: "mdi:broom", x: 1350, y: 200 },
    outline: [
        [1000, 0],
        [1700, 0],
        [1700, 400],
        [1000, 400],
    ],
});

function configWith(stale: RoomConfig): XiaomiVacuumMapCardConfig {
    return cardConfig({
        map_modes: [{ template: "vacuum_clean_segment", cleaning_order: true, predefined_selections: [stale] }],
    });
}

async function mount(page: Page, config: XiaomiVacuumMapCardConfig): Promise<void> {
    await page.evaluate(input => (window as unknown as VisualWindow).visualHarness.mount(input), config);
    await expect(page.locator(CARD)).toBeVisible();
}

async function setLabelFont(page: Page, font: number): Promise<void> {
    await page.evaluate(async size => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement & {
            requestUpdate: () => void;
            updateComplete: Promise<unknown>;
        };
        card.style.setProperty("--map-card-room-label-font-size", `${size}px`);
        // The marker's position is computed in the card, not in CSS, so it follows a theme font on
        // the next render. Tests ask for that render instead of relying on an unrelated update.
        card.requestUpdate();
        await card.updateComplete;
    }, font);
}

async function setIconSize(page: Page, size: number): Promise<void> {
    await page.evaluate(async value => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement & {
            requestUpdate: () => void;
            updateComplete: Promise<unknown>;
        };
        card.style.setProperty("--map-card-room-icon-wrapper-size", `${value}px`);
        card.requestUpdate();
        await card.updateComplete;
    }, size);
}

async function setRotation(page: Page, degrees: number): Promise<void> {
    await page.evaluate(async rotation => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement & {
            mapRotation: number;
            updateComplete: Promise<unknown>;
        };
        card.mapRotation = rotation;
        await card.updateComplete;
    }, degrees);
}

async function setZoom(page: Page, scale: number, anchor?: { x: number; y: number }): Promise<void> {
    await page.evaluate(input => (window as unknown as VisualWindow).visualHarness.setZoom(input.scale, input.anchor), {
        scale,
        anchor,
    });
}

async function selectRoom(page: Page, roomId: string): Promise<void> {
    const point = await page.evaluate(
        id => (window as unknown as VisualWindow).visualHarness.roomPoint(id, 0.5, 0.5),
        roomId,
    );
    await page.mouse.click(point.x, point.y);
    await expect
        .poll(() => page.evaluate(() => (window as unknown as VisualWindow).visualHarness.selectedRoomIds()))
        .toEqual([roomId]);
}

interface MarkerGeometry {
    marker: Box;
    room: Box;
    pill: Box | null;
    zoomer: Box;
    /** True when the stale room's wrapper is painted after the live room's, so its marker is on top. */
    staleAfterLive: boolean;
    markerOffsetY: number;
}

/** The boxes involved, in viewport pixels. */
function measure(page: Page, staleId: string, liveId?: string): Promise<MarkerGeometry> {
    return page.locator(CARD).evaluate(
        (element, ids) => {
            const root = (element as HTMLElement).shadowRoot!;
            const box = (selector: string): Box | null => {
                const node = root.querySelector(selector);
                if (!node) return null;
                const rect = node.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            };
            const stale = root.querySelector(`.room-${ids.staleId}-wrapper`);
            const live = ids.liveId ? root.querySelector(`.room-${ids.liveId}-wrapper`) : null;
            const marker = root.querySelector(`.room-${ids.staleId}-wrapper .room-stale-marker`) as SVGTextElement;
            const offset = /--label-offset-y:\s*(-?[\d.]+)px/.exec(marker?.getAttribute("style") ?? "");
            return {
                marker: box(`.room-${ids.staleId}-wrapper .room-stale-marker`)!,
                room: box(`.room-${ids.staleId}-wrapper .room-outline`)!,
                pill: ids.liveId ? box(`.room-${ids.liveId}-wrapper .room-pill`) : null,
                zoomer: box("#map-zoomer")!,
                staleAfterLive: !!(
                    stale &&
                    live &&
                    live.compareDocumentPosition(stale) & Node.DOCUMENT_POSITION_FOLLOWING
                ),
                markerOffsetY: offset ? Number(offset[1]) : Number.NaN,
            };
        },
        { staleId, liveId },
    );
}

/** The marker's box lies inside the other box, within `tolerance` viewport pixels. */
function expectInside(inner: Box, outer: Box, where: string, tolerance = 2): void {
    expect(inner.x, `${where}: marker left edge inside`).toBeGreaterThanOrEqual(outer.x - tolerance);
    expect(inner.y, `${where}: marker top edge inside`).toBeGreaterThanOrEqual(outer.y - tolerance);
    expect(inner.x + inner.width, `${where}: marker right edge inside`).toBeLessThanOrEqual(
        outer.x + outer.width + tolerance,
    );
    expect(inner.y + inner.height, `${where}: marker bottom edge inside`).toBeLessThanOrEqual(
        outer.y + outer.height + tolerance,
    );
}

/** The marker is clear of the pill and its badge, or painted over them while staying in the room. */
function expectVisibleNextToPill(geometry: MarkerGeometry, where: string): void {
    const { marker, room, pill, staleAfterLive } = geometry;
    if (!pill) return;
    const clear = marker.y + marker.height <= pill.y - 2;
    if (clear) return;
    // A room too small for the clearance keeps the marker and paints it above the pill (stale
    // wrappers come after the live rooms, so the marker's SVG text is painted last).
    expectInside(marker, room, `${where}: the overlapping marker must stay in the room`);
    expect(staleAfterLive, `${where}: the overlapping marker must be painted above the pill`).toBe(true);
}

/**
 * Walks zoom × rotation × label font and returns the measured geometries, checking the invariants
 * every time. `anchor` keeps the room in view, so "inside the map" is about the room's place in the
 * map rather than an arbitrary pan.
 */
async function checkMatrix(
    page: Page,
    options: {
        staleId: string;
        liveId?: string;
        fonts: number[];
        rotations?: number[];
        zooms?: number[];
    },
): Promise<MarkerGeometry[]> {
    const results: MarkerGeometry[] = [];
    for (const font of options.fonts) {
        await setLabelFont(page, font);
        for (const rotation of options.rotations ?? ROTATIONS) {
            await setRotation(page, rotation);
            for (const zoom of options.zooms ?? ZOOMS) {
                const anchor = await page.evaluate(
                    id => (window as unknown as VisualWindow).visualHarness.roomAnchor(id),
                    options.staleId,
                );
                await setZoom(page, zoom, anchor);
                const geometry = await measure(page, options.staleId, options.liveId);
                const where = `zoom ${zoom}, rotation ${rotation}, label font ${font}`;
                expect(geometry.marker.width, `${where}: the marker must be drawn`).toBeGreaterThan(0.5);
                expectInside(geometry.marker, geometry.room, `${where}: inside the stale room's outline`);
                expectInside(geometry.marker, geometry.zoomer, `${where}: inside the map`);
                expectVisibleNextToPill(geometry, where);
                results.push(geometry);
            }
        }
    }
    return results;
}

test.describe("stale-room marker", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/");
        await page.waitForFunction(
            () => (window as unknown as { visualHarness?: { ready: boolean } }).visualHarness?.ready === true,
            undefined,
            { timeout: 15_000 },
        );
    });

    test("stays inside the room and clear of the pill at every zoom, rotation and label font", async ({ page }) => {
        // Five fonts, four rotations and four zooms: the defect was a lift computed from the icon
        // size and the glyph, which a 28–40 px label font (the reviewed overlap was 15.9 px at 40)
        // and a 0 px icon both broke.
        test.setTimeout(180_000);
        await mount(page, configWith(STALE_OVER_LIVING_ROOM));
        await setIconSize(page, 0);
        await selectRoom(page, "1");

        const geometries = await checkMatrix(page, {
            staleId: "9",
            liveId: "1",
            fonts: [10, 20, 28, 32, 40],
        });

        // The pill is drawn throughout, and at least one big-font case is genuinely clear of it
        // (otherwise the fallback below would silently be the only path).
        expect(geometries.filter(geometry => geometry.pill !== null).length).toBeGreaterThan(0);
        expect(
            geometries.some(
                geometry => geometry.pill !== null && geometry.marker.y + geometry.marker.height <= geometry.pill.y - 2,
            ),
        ).toBe(true);
    });

    test("keeps the same clearance whatever the room icon size is", async ({ page }) => {
        // The reviewed bug: the lift added half the icon wrapper size, so a 0 px icon left the
        // marker 6.1 px inside the pill's edge while the pill's real height is the label font.
        test.setTimeout(120_000);
        await mount(page, configWith(STALE_OVER_LIVING_ROOM));
        await selectRoom(page, "1");

        const offsets = new Map<number, number[]>();
        for (const icon of [0, 36, 60]) {
            await setIconSize(page, icon);
            for (const font of [10, 12, 32, 40]) {
                await setLabelFont(page, font);
                await setRotation(page, 0);
                await setZoom(page, 1);
                const geometry = await measure(page, "9", "1");
                offsets.set(font, [...(offsets.get(font) ?? []), geometry.markerOffsetY]);
                expectVisibleNextToPill(geometry, `icon ${icon}, label font ${font}`);
            }
        }

        // The position is derived from the label font only: each font repeats the same offset for
        // every icon size.
        for (const [font, values] of offsets) {
            expect(values, `label font ${font} must place the marker identically for every icon`).toHaveLength(3);
            for (const value of values.slice(1)) expect(value).toBeCloseTo(values[0], 5);
        }
        // And the lift grows with the label font while the room still has room for it (the two
        // smallest fonts here are not clamped by the 100 px tall fixture room).
        expect(offsets.get(12)![0]).toBeLessThan(offsets.get(10)![0]);
    });

    test("stays inside a small room and is painted over the pill it cannot clear", async ({ page }) => {
        // The fixture bedroom is 120 × 80 map px: at 0.5× zoom and a 40 px font the marker cannot
        // sit above the pill without leaving the room, so it must shrink, stay inside and paint on
        // top.
        test.setTimeout(180_000);
        await mount(page, configWith(STALE_OVER_BEDROOM));
        await selectRoom(page, "2");

        const geometries = await checkMatrix(page, {
            staleId: "9",
            liveId: "2",
            fonts: [10, 32, 40],
            rotations: [0, 90],
            zooms: [0.5, 1, 2.5, 4],
        });

        // The fallback path is exercised, not assumed.
        expect(
            geometries.some(
                geometry => geometry.pill !== null && geometry.marker.y + geometry.marker.height > geometry.pill.y - 2,
            ),
            "a small room must force the marker over the pill at least once",
        ).toBe(true);
    });

    test("is not clipped by the map's top edge", async ({ page }) => {
        // A room whose outline starts at image y = 0: the old fixed CSS lift put the marker above
        // y = 0, where `#map-zoomer { overflow: hidden }` cut it off.
        test.setTimeout(120_000);
        await mount(page, configWith(STALE_AT_TOP_EDGE));

        for (const font of [12, 32, 40]) {
            await setLabelFont(page, font);
            await setRotation(page, 0);
            // The default framing puts the whole map in the viewport, so y = 0 is the viewport top.
            await setZoom(page, 1);
            const geometry = await measure(page, "9");
            expectInside(geometry.marker, geometry.zoomer, `top edge, label font ${font}, inside the map`);
            expect(geometry.marker.y, `top edge, label font ${font}, not clipped above the map`).toBeGreaterThanOrEqual(
                geometry.zoomer.y - 1,
            );
        }

        // Every rotation and zoom, with the room in view, keeps the marker in the room and the map.
        await checkMatrix(page, { staleId: "9", fonts: [12, 32, 40], zooms: [0.5, 1, 2.5, 4] });
    });
});
