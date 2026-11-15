import { describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config-validators";
import { cardStyles, HORIZONTAL_STACK_BREAKPOINT_PX } from "../../src/card/styles";
import { XiaomiVacuumMapCard } from "../../src/xiaomi-vacuum-map-card";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard } from "../harness";
import type { CardHandle } from "../harness";

/**
 * The card's layout contract (batch B10).
 *
 * happy-dom has no layout engine: `getBoundingClientRect()` is all zeroes, so these tests assert
 * the DOM/CSS arrangement contract and the grid-options table. The real bounding boxes - including
 * the same arrangement at several widths and after a container resize - are asserted in
 * `test/visual/visual.spec.ts`, where Chromium actually lays the card out.
 */

const HORIZONTAL = ".layout-content.horizontal";

function cardConfig(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        // Two modes give the card a real controls block to place below/beside the map.
        map_modes: [{ template: "vacuum_clean_segment" }, { template: "vacuum_clean_zone" }],
        tiles: [],
        icons: [],
        ...overrides,
    };
}

async function mount(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): Promise<CardHandle> {
    const card = await mountCard(cardConfig(overrides), fixtureHass(loadSyntheticFixture()));
    await card.fireMapLoad();
    return card;
}

function follows(first: Element, second: Element): boolean {
    return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** The text of an at-rule block, from its opener to its matching closing brace. */
function blockAt(css: string, opener: string): string {
    const start = css.indexOf(opener);
    if (start < 0) return "";
    let depth = 0;
    for (let index = css.indexOf("{", start); index < css.length; index++) {
        if (css[index] === "{") depth++;
        else if (css[index] === "}" && --depth === 0) return css.slice(start, index + 1);
    }
    return css.slice(start);
}

describe("layout: vertical (default)", () => {
    it("renders the map above the controls and keeps the upstream wrapper-free DOM", async () => {
        const card = await mount();

        expect(card.shadowRoot.querySelector(HORIZONTAL)).toBeNull();

        const map = card.shadowRoot.querySelector(".map-wrapper");
        const controls = card.shadowRoot.querySelector(".controls-wrapper");
        expect(map).not.toBeNull();
        expect(controls).not.toBeNull();
        // Vertical means the map comes first in flow and the controls follow it, exactly as before
        // B10: there is no extra layout wrapper around them.
        expect(follows(map as Element, controls as Element)).toBe(true);
        expect(map?.parentElement?.tagName.toLowerCase()).toBe("ha-card");
        expect(controls?.parentElement?.tagName.toLowerCase()).toBe("ha-card");

        await card.cleanup();
    });

    it("is the layout an unknown or missing option resolves to without crashing", async () => {
        const invalid = await mountCard(
            cardConfig({ layout: "diagonal" as XiaomiVacuumMapCardConfig["layout"] }),
            fixtureHass(loadSyntheticFixture()),
        );
        // Validation turns the typo into an error card; no layout code runs and nothing throws.
        expect(invalid.shadowRoot.querySelector("pre")?.textContent).toContain("Invalid layout: diagonal");
        expect(invalid.shadowRoot.querySelector(HORIZONTAL)).toBeNull();
        await invalid.cleanup();

        const missing = await mount({ layout: undefined });
        expect(missing.shadowRoot.querySelector(HORIZONTAL)).toBeNull();
        await missing.cleanup();
    });
});

describe("layout: horizontal", () => {
    it("declares the two-column grid the side-by-side arrangement renders", async () => {
        for (const width of [400, 800]) {
            const container = document.createElement("div");
            container.style.width = `${width}px`;
            document.body.appendChild(container);
            const card = await mountCard(cardConfig({ layout: "horizontal" }), fixtureHass(loadSyntheticFixture()), {
                container,
            });
            await card.fireMapLoad();

            const wrapper = card.shadowRoot.querySelector(HORIZONTAL);
            expect(wrapper, `horizontal wrapper at ${width}px`).not.toBeNull();

            const map = wrapper?.querySelector(".map-wrapper");
            const column = wrapper?.querySelector(".controls-column");
            const controls = column?.querySelector(".controls-wrapper");
            expect(map, `map at ${width}px`).not.toBeNull();
            expect(column, `controls column at ${width}px`).not.toBeNull();
            expect(controls, `controls at ${width}px`).not.toBeNull();

            // Side by side: map in grid column 1, controls in grid column 2, same row. happy-dom
            // applies no container query, so this is the base rule; which width actually renders
            // the grid is asserted in Chromium by the visual suite.
            expect(map?.getAttribute("class")).toContain("map-wrapper");
            expect(follows(map as Element, column as Element)).toBe(true);
            const wrapperStyle = getComputedStyle(wrapper as Element);
            expect(wrapperStyle.display).toBe("grid");
            expect(wrapperStyle.gridTemplateColumns).toMatch(/1fr/);
            expect(wrapperStyle.gridTemplateColumns).toMatch(/clamp\(180px, 38%, 360px\)/);

            await card.cleanup();
            container.remove();
        }
    });

    it("stacks the map above the controls below the card-width breakpoint, by a container query", () => {
        // happy-dom has no layout engine and no container queries, so this asserts the stylesheet
        // contract; Chromium proves the rendered boxes in `test/visual/visual.spec.ts` (a card
        // resized across the breakpoint) and in the real Home Assistant (`layout.spec.ts`).
        const css = (cardStyles as unknown as { cssText: string }).cssText;

        // A size container on the card surface: the query follows the card's own width, which a
        // sections cell, a phone, a sidebar or a popup sets, rather than the window's.
        expect(css).toMatch(/ha-card\.layout-horizontal\s*\{[^}]*container-type:\s*inline-size/);
        expect(css).toContain("container-name: xvmc-card");

        const stackedOpener = `@container xvmc-card (width < ${HORIZONTAL_STACK_BREAKPOINT_PX}px)`;
        expect(css, "the breakpoint is a container query, not a viewport media query").toContain(stackedOpener);
        expect(css).not.toContain(`@media (width < ${HORIZONTAL_STACK_BREAKPOINT_PX}px)`);
        expect(css).not.toContain(`@media (max-width: ${HORIZONTAL_STACK_BREAKPOINT_PX - 1}px)`);

        const stacked = blockAt(css, stackedOpener);
        // One column: the map takes the full width and the controls follow it instead of sitting
        // beside it in a clamped 180 px column.
        expect(stacked).toMatch(/\.layout-content\.horizontal\s*\{[^}]*display:\s*block/);
        // The controls must leave their absolute column (side by side they scroll inside the map's
        // row); stacked they are in normal flow and grow to their content.
        expect(stacked).toMatch(/\.controls-wrapper\s*\{[^}]*position:\s*static/);
        expect(stacked).toMatch(/\.controls-wrapper\s*\{[^}]*overflow:\s*visible/);

        // The column-only tweaks (wrap, ellipsis) are for the side-by-side arrangement: a stacked
        // card is as wide as a vertical one and must use the shared control rules instead.
        const sideBySide = blockAt(css, `@container xvmc-card (width >= ${HORIZONTAL_STACK_BREAKPOINT_PX}px)`);
        expect(sideBySide).toMatch(/\.dropdown-menu-button-text\s*\{[^}]*text-overflow:\s*ellipsis/);
        expect(sideBySide).toMatch(/\.map-actions-list\s*\{[^}]*flex-wrap:\s*wrap/);
    });

    it("keeps the map, warnings and controls in stacking order inside the wrapper", async () => {
        // The DOM order is what the single-column stack renders: map, then any warning, then the
        // controls. The side-by-side grid reorders with explicit rows; the stack must not need to.
        const card = await mount({ layout: "horizontal" });
        const wrapper = card.shadowRoot.querySelector(HORIZONTAL) as Element;
        const map = wrapper.querySelector(".map-wrapper") as Element;
        const column = wrapper.querySelector(".controls-column") as Element;
        expect(follows(map, column)).toBe(true);
        expect(map.parentElement).toBe(wrapper);
        expect(column.parentElement).toBe(wrapper);
        // No row/column start on the controls column that a single-column stack would inherit.
        expect((column as HTMLElement).style.gridRow).toBe("");
        expect((column as HTMLElement).style.gridColumn).toBe("");
        await card.cleanup();
    });

    it("omits the horizontal wrapper when there are no controls", async () => {
        // A `layout: horizontal` card with no controls has nothing to place beside the map; it must
        // still render the map normally instead of an empty second column.
        const card = await mount({ layout: "horizontal", map_modes: [] });
        expect(card.shadowRoot.querySelector(HORIZONTAL)).toBeNull();
        expect(card.shadowRoot.querySelector(".map-wrapper")).not.toBeNull();
        await card.cleanup();
    });
});

describe("getGridOptions", () => {
    it("returns no numeric rows for the vertical layout, so the cell fits the content", () => {
        const vertical = XiaomiVacuumMapCard.getGridOptions();

        // HA's default grid size is `{columns: 12, rows: "auto"}`. A numeric `rows` would replace the
        // content-sized cell with a fixed, too-short one and a `max_rows` would cap a user override.
        expect(vertical.columns).toBe(12);
        expect(vertical.rows).toBeUndefined();
        expect(vertical.min_rows).toBeUndefined();
        expect(vertical.max_rows).toBeUndefined();
    });

    it("returns a valid sections-view table for both layouts and differs in min_columns", () => {
        const vertical = XiaomiVacuumMapCard.getGridOptions();
        const horizontal = XiaomiVacuumMapCard.getGridOptions("horizontal");

        expect(vertical).toEqual({ columns: 12 });
        // Horizontal is a new arrangement: numeric rows are its default, but no max_rows may cap
        // the user's own height. 9 columns is the "three quarters of a section" minimum.
        expect(horizontal).toEqual({ columns: 12, rows: 6, min_columns: 9, min_rows: 3 });

        for (const options of [vertical, horizontal]) {
            expect((options.columns as number) % 3).toBe(0);
            expect(options.min_columns ?? 1).toBeLessThanOrEqual(options.columns as number);
        }
        // HA clamps with these pairs; a table where the default sits outside its own range would
        // silently open at the clamped size instead.
        expect(horizontal.min_rows!).toBeLessThanOrEqual(horizontal.rows as number);
        // Horizontal is the width-hungry arrangement: it must not be resized as narrow as vertical.
        expect(horizontal.min_columns!).toBeGreaterThan(vertical.min_columns ?? 1);
    });

    it("uses the configured layout on the element, as hui-card reads it", async () => {
        const vertical = await mount();
        expect(vertical.element.getGridOptions()).toEqual(XiaomiVacuumMapCard.getGridOptions());
        await vertical.cleanup();

        const horizontal = await mount({ layout: "horizontal" });
        expect(horizontal.element.getGridOptions()).toEqual(XiaomiVacuumMapCard.getGridOptions("horizontal"));
        await horizontal.cleanup();
    });
});

describe("layout validation", () => {
    it("accepts both layouts and reports an unknown value instead of treating it as vertical", () => {
        expect(validateConfig(cardConfig({ layout: "vertical" }))).toEqual([]);
        expect(validateConfig(cardConfig({ layout: "horizontal" }))).toEqual([]);

        const errors = validateConfig(cardConfig({ layout: "diagonal" as XiaomiVacuumMapCardConfig["layout"] }));
        expect(errors).toContain('Invalid layout: diagonal. Use "vertical" or "horizontal"');
    });
});
