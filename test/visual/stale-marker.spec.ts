import { expect, test, type Page } from "@playwright/test";

import type { RoomConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * The stale-room `!` marker on the map overlay.
 *
 * A configured ROOM id that the camera no longer reports is drawn from its stored outline and
 * marked with an exclamation mark. After a re-map the live room with the same geometry keeps the
 * same label point, so the stale marker and that room's selected pill share it: the marker must stay
 * clear of the pill, or - where the room has no space for that - stay inside the room and clear of
 * the pill's *name*, which is the one part of it the user needs to read. In every case it belongs
 * inside the stale room's outline, because a marker over a neighbouring room names the wrong room.
 *
 * The marker's size and its clearance are CSS expressions of the same variables the pill uses, so
 * the cases below hand it a font the way a theme may - `rem`, `em`, `vw`, a `calc()` - and switch it
 * live, without a render. What the card supplies is the room's free space, computed from the outline
 * polygon; the L-shaped room proves the polygon and not its bounding box.
 *
 * These are geometry assertions, so they run on any machine; baselines live in `__screenshots__/`.
 */

const CARD = "better-xiaomi-vacuum-map-card";

const ZOOMS = [0.5, 1, 2.5, 4];
const ROTATIONS = [0, 90, 180, 270];
/** Between them, every unit a theme may express the label font in, plus a large plain size. */
const FONT_UNITS = ["12px", "1.4rem", "2em", "calc(10px + 1vw)", "40px"];
/** The gap the marker keeps from the pill and from the name, in screen pixels. */
const GAP = 6;

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
        type: "custom:better-xiaomi-vacuum-map-card",
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

/**
 * The stale rooms below lie over live room 1, whose detected label point is the middle of its
 * outline - the fixture map is 200 x 150 image px at 10 vacuum units per pixel, so room 1 spans
 * image (100, 20) to (170, 70) and its label sits at (135, 45). A configured stale room that keeps
 * the same label point puts its marker on that room's pill.
 */
const ANCHOR = { x: 1350, y: 450 };
/** The live room the pill belongs to. */
const LIVE_ROOM = "1";
/** The configured room the camera no longer reports. */
const STALE_ROOM = "9";

/** A stale room the camera has no id for: a big room with space on every side of the label. */
const ROOM_WITH_SPACE: RoomConfig = {
    id: STALE_ROOM,
    label: { text: "Old living room", ...ANCHOR },
    outline: [
        [200, 100],
        [1900, 100],
        [1900, 1400],
        [200, 1400],
    ],
} as RoomConfig;

/**
 * 100 layout px square at zoom 1: the ordinary room of the review, where a 20-32 px label font makes
 * the pill taller than half the room and the old code clamped the marker into the pill's name.
 */
const SMALL_ROOM: RoomConfig = {
    id: STALE_ROOM,
    label: { text: "Old hall", ...ANCHOR },
    outline: [
        [1050, 150],
        [1650, 150],
        [1650, 750],
        [1050, 750],
    ],
} as RoomConfig;

/**
 * A room whose outline reaches the image's top edge (image y = 0). `#map-zoomer` clips its content,
 * so a marker lifted above the room there is cut off: this room has 45 image px of space above the
 * label and the whole 55 below it.
 */
const ROOM_AT_TOP_EDGE: RoomConfig = {
    id: STALE_ROOM,
    label: { text: "Old hallway", ...ANCHOR },
    outline: [
        [1000, 0],
        [1700, 0],
        [1700, 1100],
        [1000, 1100],
    ],
} as RoomConfig;

/**
 * An L: a bar across the map (image y 20-140) and a leg up its left end (image x 40-80, y 0-20), so
 * the label point 25 image px below the bar's top edge has a notch directly above it. The room's
 * bounding box reaches image y = 0 through the leg; the outline does not. The anchor's free space is
 * up 25, down 95, left 95 and right 55 image px.
 */
const L_SHAPED_ROOM: RoomConfig = {
    id: STALE_ROOM,
    label: { text: "Old study", ...ANCHOR },
    outline: [
        [400, 1400],
        [1900, 1400],
        [1900, 200],
        [800, 200],
        [800, 0],
        [400, 0],
    ],
} as RoomConfig;

function configWith(stale: RoomConfig): XiaomiVacuumMapCardConfig {
    return cardConfig({
        map_modes: [{ template: "vacuum_clean_segment", cleaning_order: true, predefined_selections: [stale] }],
    });
}

async function mount(page: Page, config: XiaomiVacuumMapCardConfig): Promise<void> {
    await page.evaluate(input => (window as unknown as VisualWindow).visualHarness.mount(input), config);
    await expect(page.locator(CARD)).toBeVisible();
}

/**
 * Sets the label font the way a theme or card-mod does, and waits for the browser to lay out the new
 * value. No render is requested: the marker's size and clearance are the stylesheet's.
 */
async function setLabelFont(page: Page, value: string): Promise<void> {
    await page.evaluate(async font => {
        const card = document.querySelector("better-xiaomi-vacuum-map-card") as HTMLElement;
        card.style.setProperty("--map-card-room-label-font-size", font);
        for (let frame = 0; frame < 2; frame++) {
            await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        }
    }, value);
}

async function setRotation(page: Page, degrees: number): Promise<void> {
    await page.evaluate(async rotation => {
        const card = document.querySelector("better-xiaomi-vacuum-map-card") as HTMLElement & {
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
    /** The pill's name text, not the pill: that is what the marker must never cover. */
    name: Box | null;
    pill: Box | null;
    badge: Box | null;
    /** The map viewport, which clips its content. */
    zoomer: Box;
    /** True when every sample of the marker's box is inside the stale room's outline. */
    insidePolygon: boolean;
    /** Screen pixels from the label point straight up to the room's outline. */
    freeUp: number;
    /** Screen pixels from the label point straight left to the room's outline. */
    freeLeft: number;
    /** The label point's screen position, which the pill and the marker are placed from. */
    anchorX: number;
    anchorY: number;
    /** The marker's computed font size, in screen pixels. */
    markerFont: number;
    /** The label font the theme asked for, in screen pixels, as the pill resolved it. */
    labelFont: number;
    /** True when the stale room is painted after the live one, so its marker is on top of the pill. */
    paintedAbove: boolean;
}

/**
 * The boxes and the polygon containment, in viewport pixels. The containment is sampled on a 3x3
 * grid of the marker's box and tested with the browser's own `isPointInFill` against the rendered
 * outline polygon, so a concave room is covered too.
 */
function measure(page: Page): Promise<MarkerGeometry> {
    return page.locator(CARD).evaluate(
        (element, ids) => {
            const root = (element as HTMLElement).shadowRoot!;
            const node = (selector: string): Element | null => root.querySelector(selector);
            const box = (elementOrSelector: Element | string | null): Box | null => {
                const target = typeof elementOrSelector === "string" ? node(elementOrSelector) : elementOrSelector;
                if (!target) return null;
                const rect = target.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            };
            const marker = node(`.room-${ids.staleId}-wrapper .room-stale-marker`) as SVGTextElement;
            const polygon = node(`.room-${ids.staleId}-wrapper .room-outline`) as SVGPolygonElement;
            const stale = node(`.room-${ids.staleId}-wrapper`);
            const live = node(`.room-${ids.liveId}-wrapper`);
            const pill = node(`.room-${ids.liveId}-wrapper .room-pill`);
            const markerBox = box(marker)!;
            const mapScale = (element as unknown as { mapScale: number }).mapScale;

            // The outline in screen pixels, and the label point: the marker's own x/y attributes are
            // in the same user space as the polygon (its CSS transform does not enter the CTM).
            const matrix = polygon.getScreenCTM()!;
            const points: Array<{ x: number; y: number }> = [];
            for (let index = 0; index < polygon.points.numberOfItems; index++) {
                const point = polygon.points.getItem(index);
                points.push(new DOMPoint(point.x, point.y).matrixTransform(matrix));
            }
            const origin = new DOMPoint(
                parseFloat(marker.getAttribute("x") ?? "0"),
                parseFloat(marker.getAttribute("y") ?? "0"),
            ).matrixTransform(matrix);

            let freeUp = Infinity;
            for (let index = 0; index < points.length; index++) {
                const start = points[index];
                const end = points[(index + 1) % points.length];
                // Where this edge crosses the vertical line through the origin, at or above it.
                if (start.x === end.x) continue;
                const t = (origin.x - start.x) / (end.x - start.x);
                if (t < 0 || t > 1) continue;
                const y = start.y + t * (end.y - start.y);
                if (y <= origin.y + 0.01) freeUp = Math.min(freeUp, origin.y - y);
            }
            let freeLeft = Infinity;
            for (let index = 0; index < points.length; index++) {
                const start = points[index];
                const end = points[(index + 1) % points.length];
                // Where this edge crosses the horizontal line through the origin, to its left.
                if (start.y === end.y) continue;
                const t = (origin.y - start.y) / (end.y - start.y);
                if (t < 0 || t > 1) continue;
                const x = start.x + t * (end.x - start.x);
                if (x <= origin.x + 0.01) freeLeft = Math.min(freeLeft, origin.x - x);
            }

            const inverse = matrix.inverse();
            const inside = [0, 0.5, 1].every(fx =>
                [0, 0.5, 1].every(fy =>
                    polygon.isPointInFill(
                        new DOMPoint(
                            markerBox.x + markerBox.width * fx,
                            markerBox.y + markerBox.height * fy,
                        ).matrixTransform(inverse),
                    ),
                ),
            );

            return {
                marker: markerBox,
                // The name's line, one font tall around its letters: the element itself is trimmed
                // to the capital height (text-box), but ascenders and accents (Ł, Ś) reach the line.
                name: ((): Box | null => {
                    const name = node(`.room-${ids.liveId}-wrapper .room-pill-name`);
                    const letters = box(name);
                    if (!name || !letters) return letters;
                    const font = parseFloat(getComputedStyle(name).fontSize);
                    const middle = letters.y + letters.height / 2;
                    return { x: letters.x, y: middle - font / 2, width: letters.width, height: font };
                })(),
                pill: box(pill),
                badge: box(`.room-${ids.liveId}-wrapper .room-pill-badge`),
                zoomer: box("#map-zoomer")!,
                insidePolygon: inside,
                freeUp,
                freeLeft,
                anchorX: origin.x,
                anchorY: origin.y,
                // The marker's font is in map units (the zoom divides it), the pill's in screen px:
                // both reach the screen through the same zoom.
                markerFont: parseFloat(getComputedStyle(marker).fontSize) * mapScale,
                labelFont: pill ? parseFloat(getComputedStyle(pill).fontSize) : Number.NaN,
                paintedAbove: !!(
                    stale &&
                    live &&
                    live.compareDocumentPosition(stale) & Node.DOCUMENT_POSITION_FOLLOWING
                ),
            };
        },
        { staleId: STALE_ROOM, liveId: LIVE_ROOM },
    );
}

function overlaps(first: Box | null, second: Box | null): boolean {
    if (!first || !second) return false;
    return !(
        first.x + first.width <= second.x ||
        second.x + second.width <= first.x ||
        first.y + first.height <= second.y ||
        second.y + second.height <= first.y
    );
}

/** The slack allowed where a placement decision changes: rounding, and the CSS's estimate of a glyph. */
const TOLERANCE = 2;

/**
 * The invariants that hold at every zoom, rotation and font: the marker is drawn, it never covers
 * the pill's name, and it stays inside the room when the room has the space it needs above the name.
 * The space it needs is measured from the rendered boxes - the label point to the name's top edge,
 * the gap, and the marker - so the test does not restate the stylesheet's numbers. Where the room is
 * shorter than that, the marker keeps the name readable and takes the pill's side instead, which is
 * the trade the design makes for a room too small for both.
 */
function expectMarkerClear(geometry: MarkerGeometry, where: string): void {
    expect(geometry.marker.width, `${where}: the marker must be drawn`).toBeGreaterThan(0.5);
    expect(geometry.marker.height, `${where}: the marker must be drawn`).toBeGreaterThan(1);
    expect(overlaps(geometry.marker, geometry.name), `${where}: the marker must not cover the pill's name`).toBe(false);
    if (!geometry.pill || !geometry.name) return;
    const neededAboveName = geometry.anchorY - geometry.name.y + GAP + geometry.marker.height;
    if (geometry.freeUp >= neededAboveName + TOLERANCE) {
        expect(geometry.insidePolygon, `${where}: the marker must stay inside the room's outline`).toBe(true);
    } else if (geometry.freeUp <= neededAboveName - TOLERANCE) {
        // The room cannot hold it above the name: it must be painted above the pill it overlaps.
        expect(geometry.paintedAbove, `${where}: an overlapping marker must paint above the pill`).toBe(true);
    }
    // The marker clears the whole pill wherever the room has that much space above it.
    const neededAbovePill = geometry.anchorY - geometry.pill.y + GAP + geometry.marker.height;
    if (geometry.freeUp >= neededAbovePill + TOLERANCE) {
        expect(
            geometry.marker.y + geometry.marker.height,
            `${where}: the room has room above, so the marker must clear the pill`,
        ).toBeLessThanOrEqual(geometry.pill.y - 1);
    }
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

    test("takes the label font's size in any unit and moves with a live theme change", async ({ page }) => {
        // `parseFloat` of a themed length was the defect: `1.4rem` became 1.4, and the marker was
        // drawn inside the pill at 0.66 x 2 px. Every unit below has to reach the marker unparsed.
        test.setTimeout(120_000);
        await mount(page, configWith(ROOM_WITH_SPACE));
        await selectRoom(page, LIVE_ROOM);
        await setZoom(page, 1);

        const measured: Record<string, number> = {};
        for (const font of FONT_UNITS) {
            await setLabelFont(page, font);
            const geometry = await measure(page);
            expectMarkerClear(geometry, `label font ${font}`);
            // The marker is 1.4 label fonts, which means the browser resolved the theme's length.
            expect(
                geometry.markerFont,
                `label font ${font}: the marker must be sized from the resolved font`,
            ).toBeCloseTo(1.4 * geometry.labelFont, 1);
            measured[font] = geometry.marker.height;
        }
        expect(measured["12px"]).toBeLessThan(measured["40px"]);
        expect(measured["1.4rem"], "1.4rem (22.4 px) must be between 12 px and 40 px").toBeGreaterThan(
            measured["12px"],
        );
        expect(new Set(Object.values(measured)).size, "every unit must reach the marker").toBeGreaterThan(1);

        // A live theme change, with no `requestUpdate()`: the marker follows the stylesheet. A card
        // that computed the position would need a render, and its marker would not move at all.
        // Zoomed in, the room has room above the pill at both fonts, so the lift itself changes.
        await setZoom(page, 2.5);
        await setLabelFont(page, "12px");
        const before = await measure(page);
        const renders = await page.evaluate(async () => {
            const card = document.querySelector("better-xiaomi-vacuum-map-card") as HTMLElement & {
                requestUpdate: (...args: unknown[]) => unknown;
            };
            const original = card.requestUpdate.bind(card);
            let count = 0;
            card.requestUpdate = (...args: unknown[]) => {
                count++;
                return original(...args);
            };
            card.style.setProperty("--map-card-room-label-font-size", "40px");
            for (let frame = 0; frame < 2; frame++) {
                await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
            }
            return count;
        });
        const after = await measure(page);
        expect(renders, "a theme change must not need a card render").toBe(0);
        expect(after.marker.y, "the marker must follow a live font change").toBeLessThan(before.marker.y);
        expect(after.marker.height, "the marker must grow with a live font change").toBeGreaterThan(
            before.marker.height,
        );
        expectMarkerClear(after, "after a live theme change");
    });

    test("keeps clear of the pill wherever the room has the space", async ({ page }) => {
        // The reviewed placements: above the pill when the room is tall enough, and never over its
        // name when it is not. Every zoom and rotation is measured, including the ones where the
        // pill is taller than the room.
        test.setTimeout(240_000);
        await mount(page, configWith(ROOM_WITH_SPACE));
        await selectRoom(page, LIVE_ROOM);

        for (const font of ["12px", "32px", "40px"]) {
            await setLabelFont(page, font);
            for (const rotation of ROTATIONS) {
                await setRotation(page, rotation);
                for (const zoom of ZOOMS) {
                    const anchor = await page.evaluate(
                        id => (window as unknown as VisualWindow).visualHarness.roomAnchor(id),
                        STALE_ROOM,
                    );
                    await setZoom(page, zoom, anchor);
                    const geometry = await measure(page);
                    expectMarkerClear(geometry, `label font ${font}, rotation ${rotation}, zoom ${zoom}`);
                }
            }
        }

        // And the preferred placement is really taken when the room has the space for it: at the
        // default font and one step of zoom the marker sits clear above the pill, centred on it, and
        // the room's outline holds it.
        await setLabelFont(page, "12px");
        await setRotation(page, 0);
        await setZoom(page, 1);
        const geometry = await measure(page);
        expect(geometry.marker.y + geometry.marker.height).toBeLessThanOrEqual(geometry.pill!.y - 1);
        expect(
            geometry.marker.x + geometry.marker.width,
            "the marker must be centred above the pill, not pushed to a side",
        ).toBeGreaterThan(geometry.pill!.x);
        expect(geometry.marker.x).toBeLessThan(geometry.pill!.x + geometry.pill!.width);
        expect(geometry.insidePolygon, "the preferred placement must stay inside the room").toBe(true);

        // A room too short for the pill's full clearance puts the marker on the badge side instead,
        // still above the name: left of the name's own box, and clear of the name's band. Half a
        // zoom step is enough to make that room too short for the pill at the default font.
        await setZoom(page, 0.5);
        const beside = await measure(page);
        expect(beside.marker.y + beside.marker.height, "beside the pill, above the name").toBeLessThanOrEqual(
            beside.name!.y + 1,
        );
        expect(
            beside.marker.x + beside.marker.width,
            "beside the pill, to the badge side of the name",
        ).toBeLessThanOrEqual(beside.name!.x);
        expect(beside.insidePolygon, "the badge-side placement must stay inside the room").toBe(true);
    });

    test("keeps the pill's name readable in a room too short for the whole pill", async ({ page }) => {
        // The reviewed case: 100 px of room at zoom 1 with a 20-32 px label font. The pill is then
        // taller than half the room, and clamping the marker to the room's top edge buried it in the
        // pill's name. It now sits above the name, inside the room, on the pill's badge side.
        test.setTimeout(240_000);
        await mount(page, configWith(SMALL_ROOM));
        await selectRoom(page, LIVE_ROOM);

        for (const font of ["20px", "32px", "40px"]) {
            await setLabelFont(page, font);
            for (const rotation of [0, 90, 180, 270]) {
                await setRotation(page, rotation);
                for (const zoom of ZOOMS) {
                    const anchor = await page.evaluate(
                        id => (window as unknown as VisualWindow).visualHarness.roomAnchor(id),
                        STALE_ROOM,
                    );
                    await setZoom(page, zoom, anchor);
                    const geometry = await measure(page);
                    const where = `small room, label font ${font}, rotation ${rotation}, zoom ${zoom}`;
                    expectMarkerClear(geometry, where);
                }
            }
        }
    });

    test("is not clipped by the map's top edge", async ({ page }) => {
        // A room whose outline starts at image y = 0: `#map-zoomer` clips its content, so a marker
        // lifted above it is cut off. The marker takes the room's space, below the pill when the way
        // above it is too short.
        test.setTimeout(240_000);
        await mount(page, configWith(ROOM_AT_TOP_EDGE));
        await selectRoom(page, LIVE_ROOM);

        for (const font of ["12px", "32px", "40px"]) {
            await setLabelFont(page, font);
            await setRotation(page, 0);
            await setZoom(page, 1);
            const geometry = await measure(page);
            expectMarkerClear(geometry, `top edge, label font ${font}`);
            expect(
                geometry.marker.y,
                `top edge, label font ${font}: the marker must not be clipped above the map`,
            ).toBeGreaterThanOrEqual(geometry.zoomer.y - 0.5);
        }

        // And at every rotation and zoom, with the room in view.
        await setLabelFont(page, "32px");
        for (const rotation of ROTATIONS) {
            await setRotation(page, rotation);
            for (const zoom of ZOOMS) {
                const anchor = await page.evaluate(
                    id => (window as unknown as VisualWindow).visualHarness.roomAnchor(id),
                    STALE_ROOM,
                );
                await setZoom(page, zoom, anchor);
                const geometry = await measure(page);
                expectMarkerClear(geometry, `top edge, rotation ${rotation}, zoom ${zoom}`);
            }
        }
    });

    test("follows an L-shaped outline instead of its bounding box", async ({ page }) => {
        // The notch sits directly above the label point, and the room's bounding box reaches image
        // y = 0 through a leg elsewhere: a marker placed from the box lands in the notch, over the
        // neighbouring room. The space is measured along the outline, so it does not.
        test.setTimeout(240_000);
        await mount(page, configWith(L_SHAPED_ROOM));
        await selectRoom(page, LIVE_ROOM);

        for (const font of ["12px", "32px"]) {
            await setLabelFont(page, font);
            for (const rotation of [0, 90]) {
                await setRotation(page, rotation);
                for (const zoom of [1, 2.5]) {
                    const anchor = await page.evaluate(
                        id => (window as unknown as VisualWindow).visualHarness.roomAnchor(id),
                        STALE_ROOM,
                    );
                    await setZoom(page, zoom, anchor);
                    const geometry = await measure(page);
                    const where = `L-shaped room, label font ${font}, rotation ${rotation}, zoom ${zoom}`;
                    expectMarkerClear(geometry, where);
                    expect(geometry.insidePolygon, `${where}: the marker must not sit in the notch`).toBe(true);
                }
            }
        }
    });
});
