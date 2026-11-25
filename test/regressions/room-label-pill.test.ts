import { afterEach, describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config-validators";
import { ACTIVE_ROOM_RUN_STORE_KEY } from "../../src/const";
import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle } from "../harness";
import {
    roomQuery,
    roomQueryAll,
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    settle,
    useHarnessClock,
    withState,
} from "../harness";

/**
 * Every room label is a pill, in the style of the Xiaomi Home app. A selected room's pill gains a
 * badge at its left end: the room's place in the order when the mode's `cleaning_order` is on, and
 * a checkmark when it is off. The rooms of a started run use the same pill. An unselected room
 * shows the same pill without the badge.
 *
 * The synthetic fixture's camera rooms are Kitchen (0), Living room (1) and Bedroom (2).
 */

const VACUUM = "vacuum.roborock_s7";

function config(mode: Partial<MapModeConfig> = {}, mapSource: Record<string, unknown> = {}): XiaomiVacuumMapCardConfig {
    const base = fixtureConfig(loadSyntheticFixture());
    return {
        ...base,
        map_source: { ...base.map_source, ...mapSource },
        map_modes: [{ template: "vacuum_clean_segment", ...mode } as MapModeConfig],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

async function mount(mode: Partial<MapModeConfig> = {}, mapSource: Record<string, unknown> = {}): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(config(mode, mapSource), fixtureHass(loadSyntheticFixture()));
    await card.fireMapLoad();
    return card;
}

function wrapper(card: CardHandle, id: string): Element {
    const element = card.shadowRoot.querySelector(`.room-${id}-wrapper`);
    if (!element) throw new Error(`room ${id} is not rendered`);
    return element;
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = roomQuery(card.shadowRoot, id, ".room-outline");
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

interface PillView {
    badge: string | "check";
    name: string;
}

/** Every selected (badged) pill on the map, keyed by room id. */
function pills(card: CardHandle): Record<string, PillView> {
    const out: Record<string, PillView> = {};
    for (const id of ["0", "1", "2"]) {
        const pill = roomQuery(card.shadowRoot, id, ".room-pill:not(.no-badge)");
        if (!pill) continue;
        const check = pill.querySelector(".room-pill-badge.room-check");
        const number = pill.querySelector(".room-pill-badge.room-order")?.textContent?.trim();
        out[id] = {
            badge: check ? "check" : (number ?? ""),
            name: pill.querySelector(".room-pill-name")?.textContent?.trim() ?? "",
        };
    }
    return out;
}

/** The name on an unselected room's badge-less pill. */
function plainLabel(card: CardHandle, id: string): string | undefined {
    return roomQuery(card.shadowRoot, id, ".room-pill.no-badge .room-pill-name")?.textContent?.trim();
}

describe("room label pill", () => {
    afterEach(() => window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY));

    it("numbers the pill in click order when the cleaning order is on", async () => {
        const card = await mount({ cleaning_order: true });
        await clickRoom(card, "2");
        await clickRoom(card, "0");
        expect(pills(card)).toEqual({
            "2": { badge: "1", name: "Bedroom" },
            "0": { badge: "2", name: "Kitchen" },
        });
        // A selected room's pill gains the badge; the others keep the same pill without one.
        expect(plainLabel(card, "2")).toBeUndefined();
        expect(plainLabel(card, "1")).toBe("Living room");
        // There is one label style: no plain SVG text label, and no badge drawn above a label.
        expect(card.shadowRoot.querySelectorAll("text.room-label")).toHaveLength(0);
        expect(card.shadowRoot.querySelectorAll("text.room-order")).toHaveLength(0);
    });

    it("renumbers when a room leaves the selection", async () => {
        const card = await mount({ cleaning_order: true });
        for (const id of ["2", "0", "1"]) await clickRoom(card, id);
        await clickRoom(card, "0");
        expect(pills(card)).toEqual({
            "2": { badge: "1", name: "Bedroom" },
            "1": { badge: "2", name: "Living room" },
        });
    });

    it("shows a checkmark when the cleaning order is off", async () => {
        const card = await mount();
        await clickRoom(card, "2");
        await clickRoom(card, "0");
        expect(pills(card)).toEqual({
            "2": { badge: "check", name: "Bedroom" },
            "0": { badge: "check", name: "Kitchen" },
        });
        expect(card.shadowRoot.querySelectorAll(".room-order")).toHaveLength(0);
    });

    it("keeps the pill on the rooms of a started run", async () => {
        for (const cleaningOrder of [true, false]) {
            const card = await mount({ cleaning_order: cleaningOrder });
            await clickRoom(card, "2");
            await clickRoom(card, "0");
            const button = card.shadowRoot.querySelector(".map-actions-item.main");
            button?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
            await settle(card.element, 400);
            await card.updateHass(
                withState(card.hass, VACUUM, { state: "cleaning", last_changed: "2026-11-01T10:00:30.000Z" }).hass,
            );
            await settle(card.element);
            const badge = (n: string): string => (cleaningOrder ? n : "check");
            expect(pills(card)).toEqual({
                "2": { badge: badge("1"), name: "Bedroom" },
                "0": { badge: badge("2"), name: "Kitchen" },
            });
            card.element.remove();
            window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY);
        }
    });

    it("shows the icon and a badge-less pill while unselected, the badged pill instead once selected", async () => {
        const card = await mount({
            cleaning_order: true,
            predefined_selections: [
                {
                    id: 0,
                    icon: { name: "mdi:silverware-fork-knife", x: 500, y: 450 },
                    label: { text: "Kitchen", x: 500, y: 450 },
                    outline: [
                        [200, 200],
                        [800, 200],
                        [800, 700],
                        [200, 700],
                    ],
                },
                {
                    id: 1,
                    icon: { name: "mdi:sofa", x: 1350, y: 450 },
                    label: { text: "Living room", x: 1350, y: 450 },
                    outline: [
                        [1000, 200],
                        [1700, 200],
                        [1700, 700],
                        [1000, 700],
                    ],
                },
            ],
        } as Partial<MapModeConfig>);
        const icon = (id: string): Element | null => roomQuery(card.shadowRoot, id, ".room-icon-wrapper ha-icon");
        expect(icon("1")).not.toBeNull();
        expect(pills(card)).toEqual({});
        expect(plainLabel(card, "1")).toBe("Living room");

        await clickRoom(card, "1");
        expect(icon("1")).toBeNull();
        expect(pills(card)).toEqual({ "1": { badge: "1", name: "Living room" } });
        expect(icon("0")).not.toBeNull();
    });

    it("stays where it is when selected: same origin, same offset, centred, no pointer", async () => {
        // Kitchen has an icon with a label offset below it, so the label turns around the icon and
        // steps its offset on screen; Living room has a label of its own.
        const card = await mount({
            cleaning_order: true,
            predefined_selections: [
                {
                    id: 0,
                    icon: { name: "mdi:silverware-fork-knife", x: 500, y: 450 },
                    label: { text: "Kitchen", x: 500, y: 450, offset_y: 30 },
                    outline: [
                        [200, 200],
                        [800, 200],
                        [800, 700],
                        [200, 700],
                    ],
                },
                {
                    id: 1,
                    label: { text: "Living room", x: 1350, y: 450, offset_x: -10 },
                    outline: [
                        [1000, 200],
                        [1700, 200],
                        [1700, 700],
                        [1000, 700],
                    ],
                },
            ],
        } as Partial<MapModeConfig>);
        const labelPlacement = (id: string): string[] => {
            const pill = roomQuery(card.shadowRoot, id, ".room-pill-anchor") as SVGGElement;
            return [
                pill.style.getPropertyValue("--room-pill-x"),
                pill.style.getPropertyValue("--room-pill-y"),
                pill.style.getPropertyValue("--room-pill-offset-x"),
                pill.style.getPropertyValue("--room-pill-offset-y"),
            ];
        };
        const before = { "0": labelPlacement("0"), "1": labelPlacement("1") };
        // Kitchen turns around its icon and steps its offset below it on screen.
        expect(before["0"]).toEqual(["50px", "45px", "0px", "35px"]);

        await clickRoom(card, "0");
        await clickRoom(card, "1");
        for (const id of ["0", "1"] as const) {
            const pill = roomQuery(card.shadowRoot, id, ".room-pill-anchor") as SVGGElement;
            expect(
                [
                    pill.style.getPropertyValue("--room-pill-x"),
                    pill.style.getPropertyValue("--room-pill-y"),
                    pill.style.getPropertyValue("--room-pill-offset-x"),
                    pill.style.getPropertyValue("--room-pill-offset-y"),
                ],
                `room ${id}`,
            ).toEqual(before[id]);
        }
        // Centred on that point like the label text, not lifted above it on a pointer.
        const css = (card.element.constructor as unknown as { styles: unknown }).styles;
        const text = JSON.stringify(css);
        expect(text).not.toContain("room-pill-pointer");
        expect(text).not.toContain(".room-pill::after");
        // Placed by the SVG group around the foreignObject. The pill's HTML carries no position,
        // transform or filter: WebKit paints such HTML in a foreignObject away from its layout
        // box, which is how 1.5.0's labels vanished in Safari and the Home Assistant apps.
        expect(text).toMatch(/\.room-pill-anchor \{[^}]*transform: translate\(var\(--room-pill-x/);
        const pillRule = (/\.room-pill \{([^}]*)\}/.exec(text)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(pillRule).not.toBe("");
        expect(pillRule).not.toMatch(/(^|[;\s])(position|transform|filter|left|top):/);
    });

    it("gives the pill a foreignObject box that contains it, so removing it repaints all of it", async () => {
        // A browser repaints only what changed. With a 1 px foreignObject and the pill overflowing
        // it, deselecting left most of the pill painted over the map (seen in a real dashboard).
        // The box is centred on the label point and far larger than any pill; the pill is centred
        // in it by flex layout, never by positioning the HTML.
        const card = await mount({});
        await clickRoom(card, "1");
        const box = roomQuery(card.shadowRoot, "1", ".room-pill-anchor > foreignObject.room-pill-box")!;
        expect([
            box.getAttribute("x"),
            box.getAttribute("y"),
            box.getAttribute("width"),
            box.getAttribute("height"),
        ]).toEqual(["-320", "-80", "640", "160"]);
        expect(box.querySelector(".room-pill-canvas > .room-pill")).not.toBeNull();
        // Deselected, the room keeps its pill, without the badge, in the same box.
        await clickRoom(card, "1");
        const after = roomQueryAll(card.shadowRoot, "1", "foreignObject.room-pill-box");
        expect(after).toHaveLength(1);
        expect(after[0].getAttribute("width")).toBe("640");
        expect(after[0].querySelector(".room-pill-badge")).toBeNull();
    });

    it("shows the badge alone for a room without a label", async () => {
        // The camera reports no room metadata (metadata rooms always get a name, `Room 1` at
        // worst), so the configured room is drawn as configured: without a label.
        useHarnessClock();
        const base = fixtureHass(loadSyntheticFixture());
        const camera = Object.keys(base.states).find(id => id.startsWith("camera."))!;
        const { rooms: _rooms, ...attributes } = base.states[camera].attributes as Record<string, unknown>;
        const hass = withState(base, camera, { attributes }).hass;
        const card = await mountCard(
            config({
                cleaning_order: true,
                predefined_selections: [
                    {
                        id: 1,
                        outline: [
                            [1000, 200],
                            [1700, 200],
                            [1700, 700],
                            [1000, 700],
                        ],
                    },
                ],
            } as Partial<MapModeConfig>),
            hass,
        );
        await card.fireMapLoad();
        await clickRoom(card, "1");
        const pill = roomQuery(card.shadowRoot, "1", ".room-pill");
        expect(pill?.querySelector(".room-order")?.textContent?.trim()).toBe("1");
        expect(pill?.querySelector(".room-pill-name")).toBeNull();
    });

    it("never badges a stale room, and paints its marker over its name pill", async () => {
        // Room 5 is configured but missing from the camera metadata (stale). A stored run that
        // still names it must not badge it: it is not part of the run. Its name keeps the plain
        // pill, and the `!` marker is drawn after it, so it is never covered.
        const run = { entity: VACUUM, roomIds: ["5", "0"], startedAt: Date.now(), seenActive: true };
        useHarnessClock();
        window.localStorage.setItem(
            ACTIVE_ROOM_RUN_STORE_KEY,
            JSON.stringify({ [VACUUM]: { ...run, startedAt: Date.now() } }),
        );
        const card = await mountCard(
            config({
                cleaning_order: true,
                predefined_selections: [
                    {
                        id: 5,
                        label: { text: "Old room", x: 500, y: 1100 },
                        outline: [
                            [200, 900],
                            [800, 900],
                            [800, 1300],
                            [200, 1300],
                        ],
                    },
                ],
            } as Partial<MapModeConfig>),
            withState(fixtureHass(loadSyntheticFixture()), VACUUM, { state: "cleaning" }).hass,
        );
        await card.fireMapLoad();
        expect(card.shadowRoot.querySelector(".room-5-wrapper")?.classList.contains("room-stale")).toBe(true);
        // The pill and the marker live in the room's label group, above every outline.
        const stale = card.shadowRoot.querySelector(".room-label-layer.room-5-wrapper");
        expect(stale?.classList.contains("room-stale")).toBe(true);
        expect(stale?.querySelector(".room-pill-badge")).toBeNull();
        expect(stale?.querySelector(".room-pill.no-badge .room-pill-name")?.textContent?.trim()).toBe("Old room");
        const children = [...stale!.children];
        const marker = stale!.querySelector("text.room-stale-marker")!;
        expect(marker.textContent?.trim()).toBe("!");
        expect(children.indexOf(marker)).toBeGreaterThan(children.indexOf(stale!.querySelector(".room-pill-anchor")!));
        expect(pills(card)).toEqual({ "0": { badge: "2", name: "Kitchen" } });
    });

    it("colours the pill from the resolved palette", async () => {
        const card = await mount({ cleaning_order: true });
        await clickRoom(card, "2");
        const pill = roomQuery(card.shadowRoot, "2", ".room-pill") as HTMLElement | null;
        // The palette is applied as inline custom properties the stylesheet reads, so a theme change
        // re-resolves contrast instead of trusting the theme.
        for (const property of [
            "--room-pill-background",
            "--room-pill-text",
            "--room-pill-badge",
            "--room-pill-badge-text",
        ]) {
            expect(pill?.style.getPropertyValue(property), property).toMatch(/^rgb\(/);
        }
    });
});

describe("room labels above every outline", () => {
    it("draws every room's outline before any room's icon, label or stale marker", async () => {
        const card = await mount({ cleaning_order: true });
        await clickRoom(card, "1");
        const svg = card.shadowRoot.getElementById("svg-wrapper")!;
        const outlines = Array.from(svg.querySelectorAll(".room-wrapper"));
        const labels = Array.from(svg.querySelectorAll(".room-label-layer"));
        expect(outlines.length).toBeGreaterThan(1);
        expect(labels).toHaveLength(outlines.length);
        const lastOutline = outlines[outlines.length - 1];
        for (const label of labels) {
            expect(lastOutline.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
        // An outline group holds only the outline; the pills and icons are in the label layer.
        for (const outline of outlines) {
            expect(outline.querySelector(".room-pill, .map-icon-wrapper, .room-stale-marker")).toBeNull();
        }
    });
});

describe("icon-only rooms keep their icon when selected", () => {
    afterEach(() => window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY));

    const ICON_ROOMS = [
        {
            id: 0,
            icon: { name: "mdi:silverware-fork-knife", x: 500, y: 450 },
            label: { text: "Kitchen", x: 500, y: 450, offset_y: 30 },
            outline: [
                [200, 200],
                [800, 200],
                [800, 700],
                [200, 700],
            ],
        },
        {
            id: 1,
            icon: { name: "mdi:sofa", x: 1350, y: 450 },
            label: { text: "Living room", x: 1350, y: 450, offset_y: 30 },
            outline: [
                [1000, 200],
                [1700, 200],
                [1700, 700],
                [1000, 700],
            ],
        },
    ];

    it("keeps the icon and shows no pill when room_labels is false and cleaning_order is off", async () => {
        const card = await mount({ predefined_selections: ICON_ROOMS } as Partial<MapModeConfig>, {
            room_labels: false,
        });

        const icon = (id: string): Element | null => roomQuery(card.shadowRoot, id, ".room-icon-wrapper ha-icon");
        const layer = (id: string): Element | null =>
            card.shadowRoot.querySelector(`.room-label-layer.room-${id}-wrapper`);

        expect(icon("0")).not.toBeNull();
        expect(icon("1")).not.toBeNull();
        expect(card.shadowRoot.querySelectorAll(".room-pill")).toHaveLength(0);

        await clickRoom(card, "1");
        expect(layer("1")?.classList.contains("selected")).toBe(true);
        expect(icon("1")).not.toBeNull();
        expect(roomQuery(card.shadowRoot, "1", ".room-pill")).toBeNull();
        expect(layer("0")?.classList.contains("selected")).toBe(false);

        // Clicking the icon itself deselects the room again.
        const iconWrapper = roomQuery(card.shadowRoot, "1", ".room-icon-wrapper.clickable");
        expect(iconWrapper).not.toBeNull();
        iconWrapper!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element);
        expect(layer("1")?.classList.contains("selected")).toBe(false);
        expect(icon("1")).not.toBeNull();
    });

    it("keeps the icon and shows the order badge at its corner when room_labels is false and cleaning_order is on", async () => {
        const card = await mount(
            { cleaning_order: true, predefined_selections: ICON_ROOMS } as Partial<MapModeConfig>,
            { room_labels: false },
        );

        await clickRoom(card, "1");
        await clickRoom(card, "0");

        expect(roomQuery(card.shadowRoot, "1", ".room-icon-wrapper ha-icon")).not.toBeNull();
        expect(roomQuery(card.shadowRoot, "0", ".room-icon-wrapper ha-icon")).not.toBeNull();
        expect(pills(card)).toEqual({
            "1": { badge: "1", name: "" },
            "0": { badge: "2", name: "" },
        });
        // The order badge sits at the icon's top-right corner rather than on top of the icon centre.
        const anchor = roomQuery(card.shadowRoot, "1", ".room-pill-anchor") as SVGGElement;
        expect(parseFloat(anchor.style.getPropertyValue("--room-pill-offset-x"))).toBeGreaterThan(0);
        expect(parseFloat(anchor.style.getPropertyValue("--room-pill-offset-y"))).toBeLessThan(0);

        // Deselecting room 1 removes its badge and renumbers room 0 to 1, keeping both icons.
        roomQuery(card.shadowRoot, "1", ".room-icon-wrapper.clickable")!.dispatchEvent(
            new MouseEvent("click", { bubbles: true, composed: true }),
        );
        await settle(card.element);
        expect(roomQuery(card.shadowRoot, "1", ".room-icon-wrapper ha-icon")).not.toBeNull();
        expect(roomQuery(card.shadowRoot, "1", ".room-pill")).toBeNull();
        expect(pills(card)).toEqual({ "0": { badge: "1", name: "" } });
    });

    it("keeps the icon of an outline-less icon-only room clickable so it can be deselected", async () => {
        // Without camera metadata the configured rooms are drawn as written: icon only, no outline,
        // no label (the same shape an area room has without a confirmed area-mapping join).
        useHarnessClock();
        const base = fixtureHass(loadSyntheticFixture());
        const camera = Object.keys(base.states).find(id => id.startsWith("camera."))!;
        const { rooms: _rooms, ...attributes } = base.states[camera].attributes as Record<string, unknown>;
        const hass = withState(base, camera, { attributes }).hass;
        const card = await mountCard(
            config({
                predefined_selections: [
                    { id: "flur", icon: { name: "mdi:door", x: 500, y: 450 } },
                    { id: "kueche", icon: { name: "mdi:silverware-fork-knife", x: 1350, y: 450 } },
                ],
            } as Partial<MapModeConfig>),
            hass,
        );
        await card.fireMapLoad();

        const clickIcon = async (id: string): Promise<void> => {
            const el = roomQuery(card.shadowRoot, id, ".room-icon-wrapper.clickable");
            if (!el) throw new Error(`room ${id} has no clickable icon`);
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
            await settle(card.element);
        };

        await clickIcon("flur");
        expect(
            card.shadowRoot.querySelector(".room-label-layer.room-flur-wrapper")?.classList.contains("selected"),
        ).toBe(true);
        expect(roomQuery(card.shadowRoot, "flur", ".room-icon-wrapper ha-icon")).not.toBeNull();
        expect(roomQuery(card.shadowRoot, "flur", ".room-pill")).toBeNull();

        // The icon is the room's only click target: clicking it again must deselect the room.
        await clickIcon("flur");
        expect(
            card.shadowRoot.querySelector(".room-label-layer.room-flur-wrapper")?.classList.contains("selected"),
        ).toBe(false);
        expect(roomQuery(card.shadowRoot, "flur", ".room-icon-wrapper ha-icon")).not.toBeNull();
    });

    it("keeps the icon clickable when a room has an icon and a label but no outline", async () => {
        useHarnessClock();
        const base = fixtureHass(loadSyntheticFixture());
        const camera = Object.keys(base.states).find(id => id.startsWith("camera."))!;
        const { rooms: _rooms, ...attributes } = base.states[camera].attributes as Record<string, unknown>;
        const hass = withState(base, camera, { attributes }).hass;
        const card = await mountCard(
            config({
                predefined_selections: [
                    {
                        id: "flur",
                        icon: { name: "mdi:door", x: 500, y: 450 },
                        label: { text: "Flur", x: 500, y: 450, offset_y: 35 },
                    },
                ],
            } as Partial<MapModeConfig>),
            hass,
        );
        await card.fireMapLoad();

        const iconEl = (): Element | null => roomQuery(card.shadowRoot, "flur", ".room-icon-wrapper.clickable");
        iconEl()!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element);
        expect(iconEl()).not.toBeNull();
        expect(roomQuery(card.shadowRoot, "flur", ".room-pill .room-pill-badge.room-check")).not.toBeNull();
        expect(roomQuery(card.shadowRoot, "flur", ".room-pill .room-pill-name")?.textContent?.trim()).toBe("Flur");

        iconEl()!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element);
        expect(
            card.shadowRoot.querySelector(".room-label-layer.room-flur-wrapper")?.classList.contains("selected"),
        ).toBe(false);
    });

    it("keeps the selected icon styled during a started run", async () => {
        const card = await mount({ predefined_selections: ICON_ROOMS } as Partial<MapModeConfig>, {
            room_labels: false,
        });
        await clickRoom(card, "1");
        const button = card.shadowRoot.querySelector(".map-actions-item.main");
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element, 400);
        await card.updateHass(
            withState(card.hass, VACUUM, { state: "cleaning", last_changed: "2026-11-01T10:00:30.000Z" }).hass,
        );
        await settle(card.element);

        expect(card.shadowRoot.querySelector(".room-label-layer.room-1-wrapper")?.classList.contains("selected")).toBe(
            true,
        );
        expect(roomQuery(card.shadowRoot, "1", ".room-icon-wrapper ha-icon")).not.toBeNull();
        expect(roomQuery(card.shadowRoot, "1", ".room-pill")).toBeNull();
    });
});

describe("map_source.room_outlines (#124)", () => {
    afterEach(() => window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY));

    const hasOutlineClass = (card: CardHandle, className: string): Record<string, boolean> =>
        Object.fromEntries(
            [...card.shadowRoot.querySelectorAll("g.room-wrapper")].map(group => [
                /room-(\w+)-wrapper/.exec(group.getAttribute("class") ?? "")?.[1] ?? "?",
                group.classList.contains(className),
            ]),
        );

    const outlineModesOn = (card: CardHandle): string[] =>
        [...card.shadowRoot.querySelectorAll("g.room-wrapper")].flatMap(group =>
            ["outline-hidden", "outline-selected-only", "outline-never"].filter(cls => group.classList.contains(cls)),
        );

    it("draws the outlines as before by default and when room_outlines is true", async () => {
        for (const mapSource of [{}, { room_outlines: true }]) {
            const card = await mount({}, mapSource);
            expect(outlineModesOn(card)).toEqual([]);
            card.element.remove();
        }
    });

    it("marks every room's outline as hidden when room_outlines is false, and keeps it clickable", async () => {
        const card = await mount({}, { room_outlines: false });
        const rooms = hasOutlineClass(card, "outline-hidden");
        expect(Object.keys(rooms).length).toBeGreaterThan(0);
        expect(Object.values(rooms).every(Boolean)).toBe(true);
        expect(Object.values(hasOutlineClass(card, "outline-selected-only")).some(Boolean)).toBe(false);
        expect(Object.values(hasOutlineClass(card, "outline-never")).some(Boolean)).toBe(false);
        // The polygon is still there and still the hit target; selecting keeps its own outline
        // because the hiding rule excludes selected, running and stale rooms.
        await clickRoom(card, "1");
        expect(wrapper(card, "1").classList.contains("selected")).toBe(true);
        expect(wrapper(card, "1").classList.contains("outline-hidden")).toBe(true);
    });

    it('marks every room as selected-only when room_outlines is "selected", and keeps it clickable', async () => {
        const card = await mount({ cleaning_order: true }, { room_outlines: "selected" });
        const rooms = hasOutlineClass(card, "outline-selected-only");
        expect(Object.keys(rooms).length).toBeGreaterThan(0);
        expect(Object.values(rooms).every(Boolean)).toBe(true);
        expect(Object.values(hasOutlineClass(card, "outline-hidden")).some(Boolean)).toBe(false);
        expect(Object.values(hasOutlineClass(card, "outline-never")).some(Boolean)).toBe(false);

        await clickRoom(card, "1");
        expect(wrapper(card, "1").classList.contains("selected")).toBe(true);
        expect(wrapper(card, "1").classList.contains("outline-selected-only")).toBe(true);
        expect(pills(card)).toEqual({ "1": { badge: "1", name: "Living room" } });

        // The stylesheet hides idle outlines for selected-only and does not re-show them on hover.
        const css = JSON.stringify((card.element.constructor as unknown as { styles: unknown }).styles);
        expect(css).toContain(".room-wrapper.outline-selected-only:not(.selected):not(.room-stale) > .room-outline");
        expect(css).not.toContain(".outline-selected-only:not(.selected):not(.room-stale):hover");
    });

    it('marks every room as outline-never when room_outlines is "never", keeps clickability, pill, and selected fill', async () => {
        const card = await mount({ cleaning_order: true }, { room_outlines: "never" });
        const rooms = hasOutlineClass(card, "outline-never");
        expect(Object.keys(rooms).length).toBeGreaterThan(0);
        expect(Object.values(rooms).every(Boolean)).toBe(true);
        expect(Object.values(hasOutlineClass(card, "outline-hidden")).some(Boolean)).toBe(false);
        expect(Object.values(hasOutlineClass(card, "outline-selected-only")).some(Boolean)).toBe(false);

        await clickRoom(card, "1");
        expect(wrapper(card, "1").classList.contains("selected")).toBe(true);
        expect(wrapper(card, "1").classList.contains("outline-never")).toBe(true);
        expect(pills(card)).toEqual({ "1": { badge: "1", name: "Living room" } });

        // Starting a run keeps the room highlighted and still marked outline-never.
        const button = card.shadowRoot.querySelector(".map-actions-item.main");
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element, 400);
        await card.updateHass(
            withState(card.hass, VACUUM, { state: "cleaning", last_changed: "2026-11-01T10:00:30.000Z" }).hass,
        );
        await settle(card.element);
        expect(wrapper(card, "1").classList.contains("selected")).toBe(true);
        expect(wrapper(card, "1").classList.contains("running")).toBe(true);
        expect(wrapper(card, "1").classList.contains("outline-never")).toBe(true);
        expect(pills(card)).toEqual({ "1": { badge: "1", name: "Living room" } });

        // The stylesheet hides only the stroke (never the selected fill), beats `.room-wrapper.selected > .room-outline`
        // in specificity, and excludes `.room-stale`.
        const css = JSON.stringify((card.element.constructor as unknown as { styles: unknown }).styles);
        const neverRule = /\.room-wrapper\.outline-never:not\(\.room-stale\)\s*>\s*\.room-outline\s*\{([^}]*)\}/.exec(
            css,
        )?.[1];
        expect(neverRule).toBeDefined();
        expect(neverRule).toContain("stroke: transparent");
        expect(neverRule).not.toContain("fill:");
    });

    it('keeps stale rooms marked stale with their warning marker under room_outlines: "never"', async () => {
        const card = await mount(
            {
                predefined_selections: [
                    {
                        id: 5,
                        label: { text: "Old room", x: 500, y: 1100 },
                        outline: [
                            [200, 900],
                            [800, 900],
                            [800, 1300],
                            [200, 1300],
                        ],
                    },
                ],
            } as Partial<MapModeConfig>,
            { room_outlines: "never" },
        );
        const staleWrapper = wrapper(card, "5");
        expect(staleWrapper.classList.contains("room-stale")).toBe(true);
        expect(staleWrapper.classList.contains("outline-never")).toBe(true);
        const marker = card.shadowRoot.querySelector(".room-label-layer.room-5-wrapper text.room-stale-marker");
        expect(marker?.textContent?.trim()).toBe("!");
    });

    it("validates map_source.room_outlines and normalizes empty keys to default", async () => {
        for (const valid of [true, false, "selected", "never", null, ""]) {
            expect(validateConfig(config({}, { room_outlines: valid })), `valid: ${JSON.stringify(valid)}`).toEqual([]);
        }

        // Empty YAML keys normalize away so the card renders with outlines on (the default).
        for (const empty of [null, ""]) {
            const card = await mount({}, { room_outlines: empty });
            expect(outlineModesOn(card)).toEqual([]);
            card.element.remove();
        }

        for (const invalid of ["always", "none", 123, {}, []]) {
            const errors = validateConfig(config({}, { room_outlines: invalid }));
            expect(errors.length, `invalid: ${JSON.stringify(invalid)}`).toBeGreaterThan(0);
            expect(errors[0]).toContain("room_outlines");
            expect(errors[0]).not.toMatch(/undefined|\[object Object\]/);
        }
    });
});
