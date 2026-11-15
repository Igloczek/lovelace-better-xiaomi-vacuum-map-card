import { afterEach, describe, expect, it } from "vitest";

import { ACTIVE_ROOM_RUN_STORE_KEY } from "../../src/const";
import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle } from "../harness";
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
 * A selected room's label becomes a pill in the style of the Xiaomi Home app: a badge at its left
 * end and the room name. The badge shows the room's place in the order when the mode's
 * `cleaning_order` is on, and a checkmark when it is off. The rooms of a started run use the same
 * pill. Unselected rooms keep their plain label.
 *
 * The synthetic fixture's camera rooms are Kitchen (0), Living room (1) and Bedroom (2).
 */

const VACUUM = "vacuum.roborock_s7";

function config(mode: Partial<MapModeConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [{ template: "vacuum_clean_segment", ...mode } as MapModeConfig],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

async function mount(mode: Partial<MapModeConfig> = {}): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(config(mode), fixtureHass(loadSyntheticFixture()));
    await card.fireMapLoad();
    return card;
}

function wrapper(card: CardHandle, id: string): Element {
    const element = card.shadowRoot.querySelector(`.room-${id}-wrapper`);
    if (!element) throw new Error(`room ${id} is not rendered`);
    return element;
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = wrapper(card, id).querySelector(".room-outline");
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

interface PillView {
    badge: string | "check";
    name: string;
}

/** Every pill on the map, keyed by room id. */
function pills(card: CardHandle): Record<string, PillView> {
    const out: Record<string, PillView> = {};
    for (const id of ["0", "1", "2"]) {
        const pill = wrapper(card, id).querySelector(".room-pill");
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

function plainLabel(card: CardHandle, id: string): string | undefined {
    return wrapper(card, id).querySelector("text.room-label")?.textContent?.trim();
}

describe("selected-room pill", () => {
    afterEach(() => window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY));

    it("numbers the pill in click order when the cleaning order is on", async () => {
        const card = await mount({ cleaning_order: true });
        await clickRoom(card, "2");
        await clickRoom(card, "0");
        expect(pills(card)).toEqual({
            "2": { badge: "1", name: "Bedroom" },
            "0": { badge: "2", name: "Kitchen" },
        });
        // The pill replaces the plain label of a selected room; the others keep theirs.
        expect(plainLabel(card, "2")).toBeUndefined();
        expect(plainLabel(card, "1")).toBe("Living room");
        // The old badge drawn above the label is gone.
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

    it("shows the icon while unselected and the pill instead once selected", async () => {
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
        const icon = (id: string): Element | null => wrapper(card, id).querySelector(".room-icon-wrapper ha-icon");
        expect(icon("1")).not.toBeNull();
        expect(pills(card)).toEqual({});

        await clickRoom(card, "1");
        expect(icon("1")).toBeNull();
        expect(pills(card)).toEqual({ "1": { badge: "1", name: "Living room" } });
        expect(icon("0")).not.toBeNull();
    });

    it("sits exactly where the plain label is: same origin, same offset, centred, no pointer", async () => {
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
            const text = wrapper(card, id).querySelector("text.room-label") as SVGTextElement;
            return [
                text.getAttribute("x")!,
                text.getAttribute("y")!,
                text.style.getPropertyValue("--label-offset-x"),
                text.style.getPropertyValue("--label-offset-y"),
            ];
        };
        const before = { "0": labelPlacement("0"), "1": labelPlacement("1") };

        await clickRoom(card, "0");
        await clickRoom(card, "1");
        for (const id of ["0", "1"] as const) {
            const anchor = wrapper(card, id).querySelector("foreignObject.room-pill-anchor")!;
            const pill = wrapper(card, id).querySelector(".room-pill") as HTMLElement;
            expect(
                [
                    anchor.getAttribute("x"),
                    anchor.getAttribute("y"),
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
        expect(text).toMatch(/\.room-pill \{[^}]*translate\(-50%, -50%\)/);
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
        const pill = wrapper(card, "1").querySelector(".room-pill");
        expect(pill?.querySelector(".room-order")?.textContent?.trim()).toBe("1");
        expect(pill?.querySelector(".room-pill-name")).toBeNull();
    });

    it("never draws a pill on a stale room, so it cannot cover the stale marker", async () => {
        // Room 5 is configured but missing from the camera metadata (stale). A stored run that
        // still names it must not give it a pill: its `!` marker sits where the pill would.
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
        const stale = card.shadowRoot.querySelector(".room-5-wrapper");
        expect(stale?.classList.contains("room-stale")).toBe(true);
        expect(stale?.querySelector(".room-pill")).toBeNull();
        expect(stale?.querySelector("text.room-stale-marker")?.textContent?.trim()).toBe("!");
        expect(pills(card)).toEqual({ "0": { badge: "2", name: "Kitchen" } });
    });

    it("colours the pill from the resolved palette", async () => {
        const card = await mount({ cleaning_order: true });
        await clickRoom(card, "2");
        const pill = wrapper(card, "2").querySelector(".room-pill") as HTMLElement | null;
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
