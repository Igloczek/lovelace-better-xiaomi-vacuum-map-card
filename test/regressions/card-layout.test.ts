import { describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config-validators";
import { cardStyles, HORIZONTAL_STACK_BREAKPOINT_PX } from "../../src/card/styles";
import { XiaomiVacuumMapCard } from "../../src/xiaomi-vacuum-map-card";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle } from "../harness";
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

/**
 * The stylesheet as a browser without container-query support applies it: every `@container` block
 * removed, leaving the base rules that browser uses.
 */
function withoutContainerQueries(css: string): string {
    let out = "";
    let index = 0;
    for (;;) {
        const start = css.indexOf("@container", index);
        if (start < 0) return out + css.slice(index);
        out += css.slice(index, start);
        index = start + blockAt(css.slice(start), "@container").length;
    }
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
    it("marks only the horizontal card as the size container and leaves the vertical DOM untouched", async () => {
        // The horizontal wrapper is a two-column grid whose children are the map and the controls
        // column, and the container hook sits on `ha-card`; the container query then reads the
        // card's own width, which a sections cell, a phone, a sidebar or a popup sets.
        const horizontal = await mount({ layout: "horizontal" });
        const horizontalCard = horizontal.shadowRoot.querySelector("ha-card") as Element;
        expect(horizontalCard.getAttribute("class")).toBe("layout-horizontal");

        const wrapper = horizontal.shadowRoot.querySelector(HORIZONTAL) as Element;
        const map = wrapper?.querySelector(".map-wrapper") as Element;
        const column = wrapper?.querySelector(".controls-column") as Element;
        expect(map, "map inside the horizontal wrapper").not.toBeNull();
        expect(column, "controls column inside the horizontal wrapper").not.toBeNull();
        expect(follows(map, column)).toBe(true);
        await horizontal.cleanup();

        // FORK.md promises the vertical arrangement keeps upstream's DOM. A `class=""` attribute
        // would be a change too, and card-mod selectors keyed on `ha-card` would see it appear.
        const vertical = await mount();
        const verticalCard = vertical.shadowRoot.querySelector("ha-card") as Element;
        expect(verticalCard.hasAttribute("class"), "the vertical card renders no class attribute").toBe(false);
        await vertical.cleanup();
    });

    it("keeps an intrinsic width for a parent that sizes the card from its content", () => {
        // `container-type: inline-size` brings inline-size containment, which by itself makes the
        // card's intrinsic width 0: an inline-block, a flex row's `flex: 0 1 auto` child or a
        // `fit-content` wrapper would render a 0 px card. `contain-intrinsic-inline-size` applies
        // to inline-size containment and gives the card a width there; the visual suite proves the
        // rendered box in Chromium (a shrink-to-fit parent, a flex-centred parent and `fit-content`).
        const css = (cardStyles as unknown as { cssText: string }).cssText;
        expect(css).toMatch(/ha-card\.layout-horizontal\s*\{[^}]*container-type:\s*inline-size/);
        // The query is named, so the container must carry the name too.
        expect(css).toMatch(/ha-card\.layout-horizontal\s*\{[^}]*container-name:\s*xvmc-card/);
        expect(css).toMatch(/ha-card\.layout-horizontal\s*\{[^}]*contain-intrinsic-inline-size:\s*\d+px/);
    });

    it("stacks the map above the controls below the card-width breakpoint, by a container query", () => {
        // happy-dom has no layout engine and no container queries, so this asserts the stylesheet
        // contract; Chromium proves the rendered boxes in `test/visual/visual.spec.ts` (a card
        // resized across the breakpoint) and in the real Home Assistant (`layout.spec.ts`).
        const css = (cardStyles as unknown as { cssText: string }).cssText;

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

        // The clamped-column tweaks are the base rules (see the next test), so the stacked query
        // has to take them back: the full-width controls row gets the vertical arrangement's
        // values, keeping the action buttons their height and the mode name wrapping.
        expect(stacked).toMatch(/\.map-actions-list\s*\{[^}]*flex-wrap:\s*nowrap/);
        expect(stacked).toMatch(/\.dropdown-menu-button-text\s*\{[^}]*text-overflow:\s*clip/);
        expect(stacked).toMatch(/\.dropdown-menu-button-text\s*\{[^}]*display:\s*inline-flex/);
        expect(stacked).toMatch(/\.map-actions-list\s*\{[^}]*margin-inline-start:\s*auto/);
    });

    it("keeps the side-by-side control tweaks as base rules, so a browser without container queries is unchanged", () => {
        // Container queries arrived in Chromium 105, Firefox 110 and Safari 16. A browser without
        // them never enters the stacked query, so the horizontal card must already be arranged
        // there: the action buttons wrap inside the clamped column and a long mode name ellipsizes
        // instead of being clipped. Putting these inside `@container (width >= 400px)` lost both.
        const css = withoutContainerQueries((cardStyles as unknown as { cssText: string }).cssText);
        expect(css).toMatch(/\.layout-content\.horizontal \.map-actions-list\s*\{[^}]*flex-wrap:\s*wrap/);
        expect(css).toMatch(/\.layout-content\.horizontal \.map-actions-list\s*\{[^}]*height:\s*auto/);
        expect(css).toMatch(/\.layout-content\.horizontal \.map-controls\s*\{[^}]*justify-content:\s*center/);
        expect(css).toMatch(/\.layout-content\.horizontal \.dropdown-menu\s*\{[^}]*max-width:\s*100%/);
        expect(css).toMatch(/\.layout-content\.horizontal \.dropdown-menu-button\s*\{[^}]*display:\s*flex/);
        expect(css).toMatch(
            /\.layout-content\.horizontal \.dropdown-menu-button-text\s*\{[^}]*text-overflow:\s*ellipsis/,
        );
        expect(css).toMatch(/\.layout-content\.horizontal \.dropdown-menu-button-text\s*\{[^}]*white-space:\s*nowrap/);
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
        // Horizontal is a new arrangement: numeric rows are its default. 9 columns is the
        // "three quarters of a section" minimum.
        expect(horizontal).toEqual({ columns: 12, rows: 6, min_columns: 9 });

        for (const options of [vertical, horizontal]) {
            expect((options.columns as number) % 3).toBe(0);
            expect(options.min_columns ?? 1).toBeLessThanOrEqual(options.columns as number);
        }
        // The default height sits inside HA's valid range and nothing caps it: a `min_rows` or
        // `max_rows` here would clamp the user's own `grid_options` after HA's merge.
        expect(horizontal.min_rows).toBeUndefined();
        expect(horizontal.max_rows).toBeUndefined();
        expect(horizontal.rows).toBe(6);
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

    it("never clamps the height a user sets with grid_options", async () => {
        // Home Assistant's `hui-card.getGridOptions()` is `{...element.getGridOptions(),
        // ...config.grid_options}`, so a `min_rows`/`max_rows` the card returns survives the merge
        // and overrides the user's own `rows` (min/max are applied after the merge). The sections
        // resize handle writes only `rows` and `columns`, so a card-set floor silently stopped the
        // handle: `rows: 2` rendered as three rows. A per-card size the user picks must win.
        for (const layout of ["vertical", "horizontal"] as const) {
            const options = XiaomiVacuumMapCard.getGridOptions(layout);
            expect(options.min_rows, `${layout} min_rows`).toBeUndefined();
            expect(options.max_rows, `${layout} max_rows`).toBeUndefined();
        }
    });
});

describe("a sections-view cell taller than the card", () => {
    it("is filled by the horizontal layout, so a user's larger rows enlarge the controls column", async () => {
        // hui-card reflects `layout = "grid"` on the element in a sections view. The card then has a
        // definite cell height; the horizontal layout must use it instead of sitting at the map's
        // intrinsic height with dead space below, which is what made `grid_options: {rows: N}`
        // useless above the default.
        const card = await mount({ layout: "horizontal" });
        const haCard = card.shadowRoot.querySelector("ha-card") as Element;
        const layout = card.shadowRoot.querySelector(HORIZONTAL) as Element;
        expect(getComputedStyle(haCard).display).toBe("flow-root");

        card.element.layout = "grid";
        await settle(card.element);

        expect(getComputedStyle(haCard).display).toBe("flex");
        expect(getComputedStyle(haCard).flexDirection).toBe("column");
        expect(getComputedStyle(layout).flexGrow).toBe("1");
        await card.cleanup();
    });

    it("keeps the card's content height outside a sections view", async () => {
        // Masonry and panel views do not set `layout`, and they size the card to its content. The
        // horizontal layout must not take a flex share of a height that does not exist.
        const card = await mount({ layout: "horizontal" });
        const haCard = card.shadowRoot.querySelector("ha-card") as Element;
        expect(getComputedStyle(haCard).display).toBe("flow-root");
        await card.cleanup();
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
