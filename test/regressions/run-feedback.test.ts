import { afterEach, describe, expect, it, vi } from "vitest";

import { RUN_FEEDBACK_MS } from "../../src/card/run";
import { isInsideHomeAssistant } from "../../src/renderers/toast-renderer";
import type { MapModeConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
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
 * Where the card tells the user what happened to a run.
 *
 * The card's own toast sat at the bottom of the card, out of sight on a tall card or a scrolled
 * dashboard. Now the run button answers on itself (a spinner while the call is out, then a check or
 * a cross for a moment), and the words go to Home Assistant's own notification (`hass-notification`,
 * shown on the screen), with the card's toast kept only for a page that is not Home Assistant.
 */

const ROOM_MODE = {
    name: "Rooms",
    icon: "mdi:floor-plan",
    selection_type: "ROOM",
    repeats_type: "NONE",
    service_call_schema: {
        service: "vacuum.send_command",
        service_data: { entity_id: "[[entity_id]]", command: "app_segment_clean", params: "[[selection]]" },
    },
} as unknown as MapModeConfig;

interface Notification {
    message: string;
    duration?: number;
    dismissable?: boolean;
}

let homeAssistant: HTMLElement | undefined;

afterEach(() => {
    homeAssistant?.remove();
    homeAssistant = undefined;
});

/**
 * Mounts the card inside a `<home-assistant>` root, across a shadow root as the frontend does, and
 * collects every `hass-notification` that reaches it. Without `insideHa` the card is mounted in a
 * plain page.
 */
async function mount(
    insideHa = true,
    hassChange?: (hass: MockHass) => MockHass,
): Promise<{ card: CardHandle; hass: MockHass; notifications: Notification[] }> {
    useHarnessClock();
    let hass = fixtureHass(loadSyntheticFixture());
    if (hassChange) hass = hassChange(hass);
    const notifications: Notification[] = [];
    let container: HTMLElement | undefined;
    if (insideHa) {
        homeAssistant = document.createElement("home-assistant");
        document.body.appendChild(homeAssistant);
        const root = homeAssistant.attachShadow({ mode: "open" });
        container = document.createElement("div");
        root.appendChild(container);
        homeAssistant.addEventListener("hass-notification", event =>
            notifications.push((event as CustomEvent<Notification>).detail),
        );
    }
    const config: XiaomiVacuumMapCardConfig = {
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [ROOM_MODE],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
    const card = await mountCard(config, hass, container ? { container } : {});
    await card.fireMapLoad();
    return { card, hass, notifications };
}

const runButton = (card: CardHandle): Element => card.shadowRoot.querySelector(".map-actions-item.main")!;
const runIcon = (card: CardHandle): string | null =>
    runButton(card).querySelector(".run-icon")?.getAttribute("icon") ?? null;

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    card.shadowRoot
        .querySelector(`.room-${id}-wrapper .room-outline`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

/** Taps the run button and waits past the double-tap window, without settling the outcome. */
async function tapRun(card: CardHandle): Promise<void> {
    runButton(card).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

const inCardToast = (card: CardHandle): string =>
    card.shadowRoot.getElementById("map-card-toast-text")?.innerText ?? "";

describe("isInsideHomeAssistant", () => {
    it("finds the <home-assistant> root across shadow roots, and nothing in a plain page", () => {
        const ha = document.createElement("home-assistant");
        document.body.appendChild(ha);
        const inner = document.createElement("div");
        ha.attachShadow({ mode: "open" }).appendChild(inner);
        const deeper = document.createElement("span");
        inner.attachShadow({ mode: "open" }).appendChild(deeper);
        expect(isInsideHomeAssistant(deeper)).toBe(true);
        const plain = document.createElement("div");
        document.body.appendChild(plain);
        expect(isInsideHomeAssistant(plain)).toBe(false);
        ha.remove();
        plain.remove();
    });
});

describe("the run button shows the outcome where the user tapped", () => {
    it("shows a spinner while the call is out, then a check, then the play icon again", async () => {
        let resolve!: () => void;
        const { card, hass } = await mount(true, h => {
            h.callService = vi.fn(() => new Promise<void>(r => (resolve = r))) as never;
            return h;
        });
        expect(runIcon(card)).toBe("mdi:play");
        await clickRoom(card, "1");
        await tapRun(card);
        expect(runIcon(card)).toBe("mdi:loading");
        expect(runButton(card).classList.contains("run-busy")).toBe(true);
        expect(runButton(card).getAttribute("aria-busy")).toBe("true");

        resolve();
        await settle(card.element);
        expect(vi.mocked(hass.callService)).toHaveBeenCalledTimes(1);
        expect(runIcon(card)).toBe("mdi:check");
        expect(runButton(card).classList.contains("run-success")).toBe(true);

        await vi.advanceTimersByTimeAsync(RUN_FEEDBACK_MS);
        await settle(card.element);
        expect(runIcon(card)).toBe("mdi:play");
        expect(runButton(card).className).not.toMatch(/run-(busy|success|failure)/);
    });

    it("shows a cross when Home Assistant rejects the call, and the reason in its notification", async () => {
        const { card, notifications } = await mount(true, h => {
            h.callService = vi.fn(async () => {
                throw { code: "invalid_format", message: "required key not provided" };
            }) as never;
            return h;
        });
        await clickRoom(card, "1");
        await tapRun(card);
        await settle(card.element);
        expect(runIcon(card)).toBe("mdi:close");
        expect(runButton(card).classList.contains("run-failure")).toBe(true);
        expect(notifications).toHaveLength(1);
        expect(notifications[0].message).toMatch(/required key not provided/);
        expect(notifications[0].dismissable).toBe(true);
        expect(notifications[0].duration).toBeGreaterThanOrEqual(5000);
    });

    it("shows a cross and says why when nothing is selected", async () => {
        const { card, hass, notifications } = await mount();
        await tapRun(card);
        expect(vi.mocked(hass.callService)).not.toHaveBeenCalled();
        expect(runIcon(card)).toBe("mdi:close");
        expect(notifications.map(n => n.message)).toHaveLength(1);
        expect(notifications[0].message.length).toBeGreaterThan(0);
    });

    it("shows a cross when the vacuum is unavailable", async () => {
        const { card, hass, notifications } = await mount(
            true,
            h => withState(h, "vacuum.roborock_s7", { state: "unavailable" }).hass,
        );
        await clickRoom(card, "1");
        await tapRun(card);
        expect(vi.mocked(hass.callService)).not.toHaveBeenCalled();
        expect(runIcon(card)).toBe("mdi:close");
        expect(notifications).toHaveLength(1);
    });
});

describe("messages go to Home Assistant's notification", () => {
    it("an accepted run sends no notification: the button shows it", async () => {
        const { card, notifications } = await mount();
        await clickRoom(card, "1");
        await tapRun(card);
        await settle(card.element);
        expect(runIcon(card)).toBe("mdi:check");
        expect(notifications).toEqual([]);
        expect(card.shadowRoot.getElementById("map-card-toast")?.classList.contains("show")).toBe(false);
    });

    it("a refusal goes to Home Assistant, not to the card's own toast", async () => {
        const { card, notifications } = await mount();
        await tapRun(card);
        expect(notifications).toHaveLength(1);
        expect(card.shadowRoot.getElementById("map-card-toast")?.classList.contains("show")).toBe(false);
    });

    it("outside Home Assistant the card's own toast still says why", async () => {
        const { card } = await mount(false);
        await tapRun(card);
        expect(runIcon(card)).toBe("mdi:close");
        expect(card.shadowRoot.getElementById("map-card-toast")?.classList.contains("show")).toBe(true);
        expect(inCardToast(card).length).toBeGreaterThan(0);
    });
});
