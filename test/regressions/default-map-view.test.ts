import { describe, expect, it, vi } from "vitest";

import { setPresetIndex } from "../../src/card/presets";
import { MAP_VIEW_STORE_KEY } from "../../src/const";
import { getMapView } from "../../src/model/map-view-store";
import type { CalibrationPoint, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle, HarnessClock, MockHass } from "../harness";
import {
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    settle,
    useHarnessClock,
    withState,
} from "../harness";

/**
 * The configured default map view (issue #873).
 *
 * A stored view still wins, a card with no stored view starts at `map_view`, and the reset action
 * returns to it. The assertions read the map view state the card renders from — `mapScale`, `mapX`,
 * `mapY`, `mapRotation` — rather than the storage helpers, so the tests would also catch a view
 * that is resolved correctly but never applied to the pinch-zoom transform.
 */

/** The map view state the card exposes, as the visual harness reads it too. */
interface MapViewState {
    mapScale: number;
    mapX: number;
    mapY: number;
    mapRotation: number;
}

interface MapFixture {
    card: CardHandle;
    clock: HarnessClock;
    hass: MockHass;
    config: XiaomiVacuumMapCardConfig;
}

function defaultViewConfig(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    const fixture = loadSyntheticFixture();
    return {
        ...fixtureConfig(fixture),
        // Pin tiles and icons empty: this file is about the map view only.
        tiles: [],
        icons: [],
        map_view: { scale: 2.5, x: 24, y: -18, rotation: 90 },
        ...overrides,
    };
}

function rect(width: number, height: number): DOMRect {
    return {
        x: 0,
        y: 0,
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        toJSON: () => ({}),
    };
}

/**
 * happy-dom has no layout, so the restore's zero-size guard would stop every scenario before it
 * applies anything. Give the zoomer and its content the box a rendered card has, as the existing
 * refresh-policy test does.
 */
/** The viewport and content box every scenario renders with, in layout pixels. */
const VIEWPORT_WIDTH = 400;
const VIEWPORT_HEIGHT = 300;
const CONTENT_WIDTH = 400;
const CONTENT_HEIGHT = 300;

/**
 * The raw pinch-zoom offsets of a view configured with `map_view`.
 *
 * A configured `x`/`y` is an offset from the centred view, while `mapX`/`mapY` (and the transform)
 * position the content's top-left corner. The card converts between the two; these expectations
 * mirror that conversion so a scale-only view is visibly centred rather than pinned to the
 * top-left corner.
 */
function centredOffsets(scale: number, x: number, y: number): { x: number; y: number } {
    return {
        x: VIEWPORT_WIDTH / 2 - (scale * CONTENT_WIDTH) / 2 + x,
        y: VIEWPORT_HEIGHT / 2 - (scale * CONTENT_HEIGHT) / 2 + y,
    };
}

/** The view state the card exposes for a configured `map_view`. */
function configuredViewState(scale: number, x: number, y: number, rotation: number): MapViewState {
    const offsets = centredOffsets(scale, x, y);
    return { mapScale: scale, mapX: offsets.x, mapY: offsets.y, mapRotation: rotation };
}

/** The viewport and content boxes a rendered card has; zero is what a hidden container reports. */
interface MapLayout {
    viewportWidth: number;
    viewportHeight: number;
    contentWidth: number;
    contentHeight: number;
}

const VISIBLE_LAYOUT: MapLayout = {
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
    contentWidth: CONTENT_WIDTH,
    contentHeight: CONTENT_HEIGHT,
};

const HIDDEN_LAYOUT: MapLayout = { viewportWidth: 0, viewportHeight: 0, contentWidth: 0, contentHeight: 0 };

function giveMapLayout(card: CardHandle, layout: MapLayout = VISIBLE_LAYOUT): void {
    const zoomer = card.shadowRoot.getElementById("map-zoomer") as HTMLElement;
    const content = card.shadowRoot.getElementById("map-zoomer-content") as HTMLElement;
    vi.spyOn(zoomer, "getBoundingClientRect").mockReturnValue(rect(layout.viewportWidth, layout.viewportHeight));
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue(rect(layout.contentWidth, layout.contentHeight));
    // The centring maths reads the untransformed layout box, which happy-dom reports as 0.
    vi.spyOn(content, "offsetWidth", "get").mockReturnValue(layout.contentWidth);
    vi.spyOn(content, "offsetHeight", "get").mockReturnValue(layout.contentHeight);
}

/**
 * Stands in for the browser's `ResizeObserver` so a test can deliver the callback the card
 * registered, the way the element gaining a layout box does. The harness stub only records calls.
 */
function captureResizeObserver(): { fire: () => void; restore: () => void } {
    const original = globalThis.ResizeObserver;
    let callback: ResizeObserverCallback | undefined;
    class CapturingResizeObserver {
        public constructor(notification: ResizeObserverCallback) {
            callback = notification;
        }
        public observe(): void {}
        public unobserve(): void {}
        public disconnect(): void {}
    }
    globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
    return {
        fire: () => callback?.([], {} as ResizeObserver),
        restore: () => {
            globalThis.ResizeObserver = original;
        },
    };
}

function pinchZoom(card: CardHandle): HTMLElement & {
    scale: number;
    x: number;
    y: number;
    setTransform: (options: Record<string, unknown>) => void;
} {
    return card.shadowRoot.getElementById("map-zoomer") as HTMLElement & {
        scale: number;
        x: number;
        y: number;
        setTransform: (options: Record<string, unknown>) => void;
    };
}

function viewState(card: CardHandle): MapViewState {
    const state = card.element as unknown as MapViewState;
    return {
        mapScale: state.mapScale,
        mapX: state.mapX,
        mapY: state.mapY,
        mapRotation: state.mapRotation,
    };
}

/** Whether a reset is waiting for the map to get a layout box. */
function deferredReset(card: CardHandle): boolean {
    const state = card.element as unknown as { pendingMapViewReset?: boolean };
    return state.pendingMapViewReset === true;
}

/** What the card renders for the rotation, which must follow the applied view, not only its field. */
function renderedRotation(card: CardHandle): string {
    const cardElement = card.shadowRoot.querySelector("ha-card") as HTMLElement;
    return cardElement.style.getPropertyValue("--map-rotation").trim();
}

async function mountWithView(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): Promise<MapFixture> {
    const clock = useHarnessClock();
    const fixture = loadSyntheticFixture();
    const config = defaultViewConfig(overrides);
    const hass = fixtureHass(fixture);
    const card = await mountCard(config, hass);
    // The mount-time delayed restore runs before the image is ready; the load is what applies a view.
    giveMapLayout(card);
    await card.fireMapLoad();
    return { card, clock, hass, config };
}

async function remount(card: CardHandle, config: XiaomiVacuumMapCardConfig): Promise<CardHandle> {
    const parent = card.element.parentElement as HTMLElement;
    card.element.remove();
    const next = await mountCard(config, card.hass);
    giveMapLayout(next);
    await next.fireMapLoad();
    return next;
}

/** A user pan/zoom, as the pinch-zoom gesture would apply it. */
async function panAndZoom(card: CardHandle, scale: number, x: number, y: number): Promise<void> {
    pinchZoom(card).setTransform({ scale, x, y, allowChangeEvent: true });
    await settle(card.element);
}

/** The one stored entry, keyed the way the card keys it. */
function storedView(): { key: string | undefined; view: ReturnType<typeof getMapView> } {
    const storage = JSON.parse(window.localStorage.getItem(MAP_VIEW_STORE_KEY) ?? "{}") as Record<string, unknown>;
    const key = Object.keys(storage)[0];
    return { key, view: key ? getMapView(key) : undefined };
}

/** The card action a dashboard button fires at this card. */
async function fireMapViewReset(card: CardHandle): Promise<void> {
    document.dispatchEvent(
        new CustomEvent("ll-custom", {
            detail: {
                xiaomi_vacuum_map_card: {
                    action_handler_id: "this",
                    action: "map_view.reset",
                },
            },
        }),
    );
    await settle(card.element);
}

describe("configured default map view in the card", () => {
    it("applies the configured map_view on the first render when nothing is stored", async () => {
        const { card } = await mountWithView();

        expect(viewState(card)).toEqual(configuredViewState(2.5, 24, -18, 90));
        expect(renderedRotation(card)).toBe("90deg");
        expect(storedView().view).toBeUndefined();
    });

    it("keeps the previous neutral view when no default is configured", async () => {
        const { card } = await mountWithView({ map_view: undefined, map_rotation: 90 });

        expect(viewState(card)).toEqual({ mapScale: 1, mapX: 0, mapY: 0, mapRotation: 90 });
        expect(renderedRotation(card)).toBe("90deg");
    });

    it("lets a user pan/zoom win and persists it, so it beats the default after a reload", async () => {
        const { card, clock, config } = await mountWithView();

        await panAndZoom(card, 2, 10, 20);
        // The save is debounced exactly like a gesture's; nothing is written until it flushes.
        expect(storedView().view).toBeUndefined();
        await clock.advance(400);

        expect(viewState(card)).toEqual({ mapScale: 2, mapX: 10, mapY: 20, mapRotation: 90 });
        const stored = storedView();
        expect(stored.view).toMatchObject({ scale: 2, x: 10, y: 20, rotation: 90 });

        const reloaded = await remount(card, config);
        expect(viewState(reloaded)).toEqual({ mapScale: 2, mapX: 10, mapY: 20, mapRotation: 90 });
    });

    it("returns to the configured default from the map_view.reset action and persists it", async () => {
        const { card, clock } = await mountWithView();
        await panAndZoom(card, 1.25, -40, 35);
        await clock.advance(400);
        expect(viewState(card).mapScale).toBe(1.25);

        await fireMapViewReset(card);

        expect(viewState(card)).toEqual(configuredViewState(2.5, 24, -18, 90));
        expect(renderedRotation(card)).toBe("90deg");

        // The reset is persisted exactly like an equivalent gesture: the next load keeps it.
        await clock.advance(400);
        expect(storedView().view).toMatchObject({
            scale: 2.5,
            ...centredOffsets(2.5, 24, -18),
            rotation: 90,
        });
    });

    it("defers a reset fired while the map has no layout size until the map is laid out", async () => {
        const observer = captureResizeObserver();
        try {
            const { card, clock, config } = await mountWithView();
            await panAndZoom(card, 2, 10, 20);
            await clock.advance(400);
            expect(storedView().view).toMatchObject({ scale: 2, x: 10, y: 20 });

            // A hidden dashboard tab or a closed container: the card is still attached, so the
            // dashboard action reaches it, but its map has no layout box.
            giveMapLayout(card, HIDDEN_LAYOUT);
            await fireMapViewReset(card);
            await clock.advance(400);

            // The configured view cannot be centred against a zero-size layout; applying what it
            // resolves to would pin the content's top-left corner in the viewport, and storing it
            // would keep that wrong view on the next load. Neither may happen.
            expect(viewState(card)).toEqual({ mapScale: 2, mapX: 10, mapY: 20, mapRotation: 90 });
            expect(storedView().view).toMatchObject({ scale: 2, x: 10, y: 20 });
            expect(deferredReset(card)).toBe(true);

            // The map gets a layout box again: the resize observer applies the reset exactly once.
            giveMapLayout(card);
            observer.fire();
            await clock.advance(400);
            expect(viewState(card)).toEqual(configuredViewState(2.5, 24, -18, 90));
            expect(deferredReset(card)).toBe(false);
            expect(storedView().view).toMatchObject({
                scale: 2.5,
                ...centredOffsets(2.5, 24, -18),
                rotation: 90,
            });

            // A later resize delivers the callback again; the reset must not be replayed.
            observer.fire();
            expect(viewState(card)).toEqual(configuredViewState(2.5, 24, -18, 90));

            // The stored reset view is the one a reload opens at.
            const reloaded = await remount(card, config);
            expect(viewState(reloaded)).toEqual(configuredViewState(2.5, 24, -18, 90));

            // And the deferred reset is not replayed over a view the user changes after the reload.
            await panAndZoom(reloaded, 1.25, -40, 35);
            observer.fire();
            expect(viewState(reloaded)).toEqual({ mapScale: 1.25, mapX: -40, mapY: 35, mapRotation: 90 });
        } finally {
            observer.restore();
        }
    });

    it("keeps a reset fired before the session's first restore instead of restoring over it", async () => {
        const { card, clock } = await mountWithView();
        await panAndZoom(card, 2, 10, 20);
        await clock.advance(400);
        expect(storedView().view).toMatchObject({ scale: 2, x: 10, y: 20 });

        // A card that has only just got a layout box has not resolved its map-view key yet; the
        // delayed restore that resolves it runs after the reset.
        const state = card.element as unknown as { restoredMapViewKey?: string };
        state.restoredMapViewKey = undefined;
        await fireMapViewReset(card);
        card.element._restoreMapView();
        await clock.advance(400);

        expect(viewState(card)).toEqual(configuredViewState(2.5, 24, -18, 90));
        expect(storedView().view).toMatchObject({ scale: 2.5, ...centredOffsets(2.5, 24, -18), rotation: 90 });
    });

    it("drops a deferred reset when the card switches to another preset", async () => {
        const second = { ...defaultViewConfig(), preset_name: "Second" };
        const { card } = await mountWithView({
            preset_name: "First",
            additional_presets: [second] as XiaomiVacuumMapCardConfig[],
        });
        giveMapLayout(card, HIDDEN_LAYOUT);
        await fireMapViewReset(card);
        expect(deferredReset(card)).toBe(true);

        // The reset was asked for on the preset being left; applied after the switch it would
        // overwrite the other preset's stored view.
        setPresetIndex(card.element, 1);
        expect(deferredReset(card)).toBe(false);
    });

    it("returns to the neutral view from the reset control when no default is configured", async () => {
        const { card, clock } = await mountWithView({ map_view: undefined, map_rotation: 90 });
        await panAndZoom(card, 2, 30, -10);
        await clock.advance(400);
        expect(viewState(card).mapScale).toBe(2);

        const reset = card.shadowRoot.querySelector('ha-icon[icon="mdi:image-filter-center-focus"]') as HTMLElement;
        reset.click();
        await settle(card.element);

        expect(viewState(card)).toEqual({ mapScale: 1, mapX: 0, mapY: 0, mapRotation: 90 });
        // Neutral is scale 1, no offset and the preset's configured rotation — the pre-B9 reset.
        await clock.advance(400);
        expect(storedView().view).toMatchObject({ scale: 1, x: 0, y: 0, rotation: 90 });
    });

    it("applies the configured default even when persistence is disabled", async () => {
        const { card, clock } = await mountWithView({ persist_map_view: false });

        expect(viewState(card)).toEqual(configuredViewState(2.5, 24, -18, 90));

        await panAndZoom(card, 1.5, 5, 5);
        await clock.advance(400);
        // `persist_map_view: false` still means "remember nothing", so no stored entry appears.
        expect(storedView().key).toBeUndefined();
        expect(viewState(card).mapScale).toBe(1.5);
    });

    it("centres a scale-only default exactly like one press of the zoom-in control", async () => {
        const { card } = await mountWithView({ map_view: { scale: 1.5 }, map_rotation: 0 });

        // The configured view is not pinned to the content's top-left corner: scale 1.5 alone puts
        // the content centre in the viewport centre, which is where the zoom control leaves it.
        expect(viewState(card)).toEqual({
            mapScale: 1.5,
            mapX: -100,
            mapY: -75,
            mapRotation: 0,
        });

        // The same card with no configured view, after one press of zoom-in, must land identically.
        const neutralClock = useHarnessClock();
        const fixture = loadSyntheticFixture();
        const neutral = await mountCard(
            defaultViewConfig({ map_view: undefined, map_rotation: 0 }),
            fixtureHass(fixture),
        );
        giveMapLayout(neutral);
        await neutral.fireMapLoad();
        const zoomIn = neutral.shadowRoot.querySelector('ha-icon[icon="mdi:magnify-plus"]') as HTMLElement;
        zoomIn.click();
        await settle(neutral.element);
        await neutralClock.advance(400);

        expect(viewState(neutral)).toEqual({ mapScale: 1.5, mapX: -100, mapY: -75, mapRotation: 0 });
    });

    it.each([true, false])(
        "keeps the current view when the map key changes mid-session (persistence %s)",
        async persist => {
            const { card, clock, hass } = await mountWithView({ persist_map_view: persist });
            const keyOf = (): string => (card.element as unknown as { _getMapViewKey: () => string })._getMapViewKey();
            const keyBefore = keyOf();

            // A user pan/zoom. With persistence on it is the stored view for the current key.
            await panAndZoom(card, 3, -400, -298);
            await clock.advance(400);
            expect(viewState(card)).toEqual({ mapScale: 3, mapX: -400, mapY: -298, mapRotation: 90 });

            // The fixture camera has no map-id attribute, so the key falls back to a hash of its
            // calibration points. A re-map changes that hash and with it the key, mid-session.
            const camera = hass.states["camera.vacuum_map"];
            const calibration = camera.attributes.calibration_points as CalibrationPoint[];
            const remapped = withState(hass, camera.entity_id, {
                attributes: {
                    ...camera.attributes,
                    calibration_points: calibration.map((point, index) =>
                        index === 0 ? { ...point, map: { ...point.map, x: point.map.x + 10 } } : point,
                    ),
                },
            }).hass;
            await card.updateHass(remapped);
            await clock.advance(400);

            // The key really changed: otherwise the "view kept" assertion would be vacuous.
            expect(keyOf()).not.toBe(keyBefore);
            // The configured default must not be applied over what the user is looking at.
            expect(viewState(card)).toEqual({ mapScale: 3, mapX: -400, mapY: -298, mapRotation: 90 });
        },
    );

    it("applies a stored view that exists for the new key when the key changes mid-session", async () => {
        const { card, clock, hass, config } = await mountWithView();
        const camera = hass.states["camera.vacuum_map"];
        const originalAttributes = camera.attributes;
        const calibration = originalAttributes.calibration_points as CalibrationPoint[];

        // Store a view under the original key.
        await panAndZoom(card, 3, -400, -298);
        await clock.advance(400);

        // Re-map: the new key has nothing stored, so the current view is kept.
        const remapped = withState(hass, camera.entity_id, {
            attributes: {
                ...originalAttributes,
                calibration_points: calibration.map(point => ({
                    ...point,
                    map: { x: point.map.x, y: point.map.y + 10 },
                })),
            },
        }).hass;
        await card.updateHass(remapped);
        await clock.advance(400);
        expect(viewState(card).mapScale).toBe(3);

        // Store a different view under the new key.
        await panAndZoom(card, 1.5, 12, 34);
        await clock.advance(400);

        // Switching back to the original map is a later key change, not a session start: the
        // stored view for that key wins over the configured default.
        const original = withState(remapped, camera.entity_id, { attributes: originalAttributes }).hass;
        await card.updateHass(original);
        await clock.advance(400);

        expect(viewState(card)).toEqual({ mapScale: 3, mapX: -400, mapY: -298, mapRotation: 90 });
        expect(config.map_view).toEqual({ scale: 2.5, x: 24, y: -18, rotation: 90 });
    });

    it("uses an edited map_view instead of the view stored for the old one", async () => {
        const { card, clock, config } = await mountWithView();
        await panAndZoom(card, 2, 10, 20);
        await clock.advance(400);
        expect(storedView().view).toMatchObject({ scale: 2, x: 10, y: 20 });

        // Editing `map_view` starts a new key, so the remembered gesture cannot keep overriding
        // the new default until the user happens to press reset.
        card.element.setConfig({ ...config, map_view: { scale: 1.5 } });
        await clock.advance(400);

        expect(viewState(card)).toEqual(configuredViewState(1.5, 0, 0, 0));
    });

    it("raises a config error instead of applying a malformed default", async () => {
        const clock = useHarnessClock();
        const fixture = loadSyntheticFixture();
        // A malformed view never reaches the map: `setConfig` keeps the error and `render` shows it.
        const card = await mountCard(defaultViewConfig({ map_view: { scale: 0 } }), fixtureHass(fixture));
        await clock.advance(400);

        expect(card.shadowRoot.querySelector("hui-error-card, pre")).not.toBeNull();
        expect(storedView().key).toBeUndefined();
    });
});

describe("storage key compatibility", () => {
    const keyOf = (card: CardHandle): string =>
        (card.element as unknown as { _getMapViewKey: () => string })._getMapViewKey();

    it("keeps the pre-B9 storage key for a card without map_view", async () => {
        const without = await mountWithView({ map_view: undefined });
        const withDefault = await mountWithView({ map_view: { scale: 2 } });

        const plainKey = keyOf(without.card);
        const defaultKey = keyOf(withDefault.card);

        // The pre-B9 key was `card|preset|source|mapid`. A card with no configured default must keep
        // exactly that shape, otherwise every existing user loses the view they saved on upgrade.
        expect(plainKey.split("|")).toHaveLength(4);
        expect(defaultKey.split("|")).toHaveLength(5);
        expect(defaultKey.startsWith(`${plainKey}|`)).toBe(true);
    });
});
