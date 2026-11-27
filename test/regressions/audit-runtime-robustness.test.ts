import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION_HANDLER_CUSTOM_ELEMENT_NAME } from "../../src/const";
import { actionHandlerBind } from "../../src/action-handler-directive";
import { copyMessage } from "../../src/utils";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle } from "../harness";

/**
 * Findings of the quality and security audit that reached users' browsers: code that trusted
 * page-wide events, browser APIs and element reconnects more than Home Assistant guarantees.
 */

type CardInternals = { _handleLovelaceDomEvent(event: Event): Promise<void> };

async function mount() {
    const fixture = loadSyntheticFixture();
    const config: XiaomiVacuumMapCardConfig = { ...fixtureConfig(fixture), persist_map_view: false };
    const card = await mountCard(config, fixtureHass(fixture));
    await settle(card.element);
    return card;
}

describe("the ll-custom listener", () => {
    // `ll-custom` is the event Home Assistant's `fire-dom-event` action sends, and every card on the
    // page hears every one of them: another card or a browser_mod popup decides what is in `detail`.
    it.each([
        ["no detail", new CustomEvent("ll-custom")],
        ["a string detail", new CustomEvent("ll-custom", { detail: "refresh" })],
        ["a null card payload", new CustomEvent("ll-custom", { detail: { xiaomi_vacuum_map_card: null } })],
        ["a string card payload", new CustomEvent("ll-custom", { detail: { xiaomi_vacuum_map_card: "start" } })],
    ])("ignores an event with %s instead of rejecting", async (_name, event) => {
        const card = await mount();
        await expect(
            (card.element as unknown as CardInternals)._handleLovelaceDomEvent(event),
        ).resolves.toBeUndefined();
    });

    it.each(["internal_variable.set", "map_mode.set", "repeats.set"])(
        "ignores %s without its data instead of rejecting",
        async action => {
            const card = await mount();
            const event = new CustomEvent("ll-custom", {
                detail: { xiaomi_vacuum_map_card: { action_handler_id: "this", action } },
            });
            const element = card.element as unknown as CardInternals & {
                selectedMode: number;
                repeats: number;
                internalVariables: Record<string, unknown>;
            };
            const before = {
                mode: element.selectedMode,
                repeats: element.repeats,
                variables: element.internalVariables,
            };
            await expect(element._handleLovelaceDomEvent(event)).resolves.toBeUndefined();
            expect({
                mode: element.selectedMode,
                repeats: element.repeats,
                variables: element.internalVariables,
            }).toEqual(before);
        },
    );
});

describe("copyMessage", () => {
    afterEach(() => vi.unstubAllGlobals());

    // Home Assistant reached over plain http (a LAN address) is not a secure context, and browsers
    // leave `navigator.clipboard` undefined there. The editor's copy buttons must still copy.
    it("copies without the asynchronous clipboard API", () => {
        vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
        const execCommand = vi.fn(() => true);
        Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
        expect(() => copyMessage("[[1, 2, 3, 4]]")).not.toThrow();
        expect(execCommand).toHaveBeenCalledWith("copy");
    });

    it("does not leave a rejected clipboard write unhandled", async () => {
        // A plain function: a `vi.fn` records how its promise settles, which handles the rejection.
        const written: string[] = [];
        const writeText = (text: string): Promise<void> => {
            written.push(text);
            return Promise.reject(new DOMException("Document is not focused.", "NotAllowedError"));
        };
        vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
        Object.defineProperty(document, "execCommand", { value: () => true, configurable: true });
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            copyMessage("text");
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(written).toEqual(["text"]);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });
});

describe("the action handler element", () => {
    // The handler lives on `document.body` and is shared by every card. It is connected again
    // whenever something moves it (a body re-render, a test harness, a custom dashboard), and each
    // connect used to add seven more document listeners that were never removed.
    it("removes its document listeners when disconnected, so reconnects do not pile them up", () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        actionHandlerBind(host, {});
        const handler = document.body.querySelector(ACTION_HANDLER_CUSTOM_ELEMENT_NAME)!;
        const added = vi.spyOn(document, "addEventListener");
        const removed = vi.spyOn(document, "removeEventListener");
        try {
            for (let i = 0; i < 3; i++) {
                handler.remove();
                document.body.appendChild(handler);
            }
            expect(added.mock.calls.length).toBeGreaterThan(0);
            expect(removed.mock.calls.map(call => call.slice(0, 2))).toEqual(
                added.mock.calls.map(call => call.slice(0, 2)),
            );
        } finally {
            added.mockRestore();
            removed.mockRestore();
            host.remove();
        }
    });
});

describe("a new manual zone", () => {
    // `[a, b].sort()` compares numbers as strings: `[-0.5, -1.2]` and `[800, 1200]` stay unsorted.
    // Viomi and xiaomi_miot maps use metres around zero, Valetudo centimetres across 999/1000. The
    // payload and the handles normalise the box again, so this is the stored box being kept in the
    // `[min x, min y, max x, max y]` shape the resize logic assumes.
    it.each([
        ["metres below zero", [-0.5, -1.2], [-1.2, -0.5]],
        ["centimetres across 1000", [800, 1200], [800, 1200]],
        ["mixed signs", [5, -10], [-10, 5]],
    ])("stores its box in numeric order with %s", async (_name, [a, b], expected) => {
        const { ManualRectangle } = await import("../../src/model/map_objects/manual-rectangle");
        const corners = [
            [a, a],
            [b, b],
        ];
        let call = 0;
        const context = {
            realScale: () => 1,
            roundMap: (p: number[]) => p,
            coordinatesConverter: () => ({ mapToVacuum: () => corners[call++] }),
        };
        const zone = new ManualRectangle(0, 0, 10, 10, "1", context as never);
        expect((zone as unknown as { _vacRect: number[] })._vacRect).toEqual([
            expected[0],
            expected[0],
            expected[1],
            expected[1],
        ]);
    });
});
