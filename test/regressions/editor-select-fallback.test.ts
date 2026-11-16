import { describe, expect, it, vi } from "vitest";

import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import {
    fixtureConfig,
    fixtureStates,
    loadSyntheticFixture,
    mockHass,
    mountEditor,
    settle,
    useHarnessClock,
    withoutCustomElement,
    type EditorHandle,
    type FixtureBundle,
} from "../harness";

/**
 * The editor's three pickers (entity, vacuum platform, camera) used to assume `ha-select` exists.
 * Home Assistant removed `ha-formfield` in 2026.11, so a removed or renamed `ha-select` would leave
 * the pickers as empty boxes. Each picker must fall back to a native `<select>` that reads and
 * writes the same config value and fires the same `config-changed` event.
 */

interface PickerElement extends Element {
    value?: string;
    configValue?: string;
}

/** The hass for these tests: the fixture plus a second vacuum and camera the pickers can switch to. */
function hassWithChoices(fixture: FixtureBundle) {
    const states = fixtureStates(fixture);
    const vacuumId = Object.keys(states).find(entityId => entityId.startsWith("vacuum."));
    if (!vacuumId) throw new Error("the fixture has no vacuum entity");
    states["vacuum.second_vacuum"] = { ...states[vacuumId] };
    states["camera.second_map"] = { ...fixture.camera };
    return mockHass({ states, entities: fixture.registry });
}

function pickers(root: ShadowRoot): PickerElement[] {
    return Array.from(root.querySelectorAll("ha-select, select")) as PickerElement[];
}

function picker(root: ShadowRoot, configValue: string): PickerElement {
    const element = pickers(root).find(candidate => candidate.configValue === configValue);
    if (!element) throw new Error(`no picker for ${configValue}`);
    return element;
}

/** Fires the event the real element fires: `selected` for ha-select, `change` for a native select. */
async function choose(editor: EditorHandle, configValue: string, value: string): Promise<void> {
    const element = picker(editor.shadowRoot, configValue);
    if (element.tagName.toLowerCase() === "ha-select") {
        element.dispatchEvent(new CustomEvent("selected", { detail: { value } }));
    } else {
        (element as HTMLSelectElement).value = value;
        element.dispatchEvent(new Event("change"));
    }
    await settle(editor.element);
}

function recordConfigChanges(editor: EditorHandle): XiaomiVacuumMapCardConfig[] {
    const changes: XiaomiVacuumMapCardConfig[] = [];
    editor.element.addEventListener("config-changed", (event: Event) => {
        changes.push((event as CustomEvent<{ config: XiaomiVacuumMapCardConfig }>).detail.config);
    });
    return changes;
}

function expectCurrentValues(editor: EditorHandle, config: XiaomiVacuumMapCardConfig): void {
    expect(picker(editor.shadowRoot, "entity").value).toBe(config.entity);
    expect(picker(editor.shadowRoot, "vacuum_platform").value).toBe("Xiaomi Miio");
    expect(picker(editor.shadowRoot, "camera").value).toBe(config.map_source?.camera);
}

/** Asserts a change of every picker updates its config field through one `config-changed` event. */
async function expectEveryPickerWritesConfig(editor: EditorHandle): Promise<void> {
    const changes = recordConfigChanges(editor);

    await choose(editor, "entity", "vacuum.second_vacuum");
    expect(changes.at(-1)?.entity).toBe("vacuum.second_vacuum");

    await choose(editor, "vacuum_platform", "Roborock");
    expect(changes.at(-1)?.vacuum_platform).toBe("Roborock");

    await choose(editor, "camera", "camera.second_map");
    expect(changes.at(-1)?.map_source?.camera).toBe("camera.second_map");

    expect(changes).toHaveLength(3);
}

describe("editor picker element fallback", () => {
    it("renders ha-select pickers with the configured values when the frontend defines it", async () => {
        useHarnessClock();
        const fixture = loadSyntheticFixture();
        const config = fixtureConfig(fixture);
        const editor = await mountEditor(config, hassWithChoices(fixture));

        expect(editor.shadowRoot.querySelectorAll("ha-select").length).toBeGreaterThanOrEqual(3);
        expect(editor.shadowRoot.querySelectorAll("select")).toHaveLength(0);
        expectCurrentValues(editor, config);
        await expectEveryPickerWritesConfig(editor);
    });

    it("renders native selects with the configured values when the frontend has no ha-select", async () => {
        useHarnessClock();
        const restore = withoutCustomElement("ha-select");
        try {
            const fixture = loadSyntheticFixture();
            const config = fixtureConfig(fixture);
            const editor = await mountEditor(config, hassWithChoices(fixture));

            // Assert the rendered tag, not only `customElements.get`: the harness registers every
            // ha-* tag, so only the rendered element proves the fallback was chosen.
            expect(editor.shadowRoot.querySelectorAll("ha-select")).toHaveLength(0);
            expect(editor.shadowRoot.querySelectorAll("select")).toHaveLength(3);
            expectCurrentValues(editor, config);
            await expectEveryPickerWritesConfig(editor);
        } finally {
            restore();
        }
    });

    it("shows a configured value the live entity list does not contain", async () => {
        useHarnessClock();
        const restore = withoutCustomElement("ha-select");
        try {
            const fixture = loadSyntheticFixture();
            const config = fixtureConfig(fixture);
            const hass = hassWithChoices(fixture);
            // A configured entity that is not loaded (a disabled integration, a slow startup) must
            // not make the picker silently show another vacuum.
            const orphan = "vacuum.not_loaded_yet";
            const editor = await mountEditor({ ...config, entity: orphan }, hass);

            const entity = picker(editor.shadowRoot, "entity") as HTMLSelectElement;
            expect(entity.value).toBe(orphan);
            expect(entity.selectedOptions[0]?.textContent).toBe(orphan);
        } finally {
            restore();
        }
    });

    it("switches to ha-select when the frontend defines it after the first render", async () => {
        useHarnessClock();
        const late = deferHaSelect();
        try {
            const fixture = loadSyntheticFixture();
            const config = fixtureConfig(fixture);
            // `ha-select` is not available yet: the editor has to stay usable instead of rendering
            // an unknown element, and it must not settle on the fallback once the element arrives.
            const editor = await mountEditor(config, hassWithChoices(fixture));
            expect(editor.shadowRoot.querySelectorAll("ha-select")).toHaveLength(0);
            expect(editor.shadowRoot.querySelectorAll("select")).toHaveLength(3);

            late.define();
            await settle(editor.element);

            expect(editor.shadowRoot.querySelectorAll("ha-select").length).toBeGreaterThanOrEqual(3);
            expect(editor.shadowRoot.querySelectorAll("select")).toHaveLength(0);
            expectCurrentValues(editor, config);
        } finally {
            late.restore();
        }
    });
});

/**
 * Simulates Home Assistant lazy-loading `ha-select` after the editor's first render: `get` reports
 * it missing and `whenDefined` settles only when `define()` is called.
 */
function deferHaSelect(): { define: () => void; restore: () => void } {
    const originalGet = customElements.get.bind(customElements);
    const originalWhenDefined = customElements.whenDefined.bind(customElements);
    let defined = false;
    let arrive: () => void = () => undefined;
    const arrival = new Promise<CustomElementConstructor>(resolve => {
        arrive = () => resolve(customElements.get("ha-select") ?? class extends HTMLElement {});
    });
    const getSpy = vi
        .spyOn(customElements, "get")
        .mockImplementation((name: string) => (name === "ha-select" && !defined ? undefined : originalGet(name)));
    const whenDefinedSpy = vi
        .spyOn(customElements, "whenDefined")
        .mockImplementation((name: string) =>
            name === "ha-select" ? arrival : (originalWhenDefined(name) as Promise<CustomElementConstructor>),
        );
    return {
        define: (): void => {
            defined = true;
            arrive();
        },
        restore: (): void => {
            getSpy.mockRestore();
            whenDefinedSpy.mockRestore();
        },
    };
}
