import {
    expect,
    openDashboard,
    card,
    shot,
    test,
    waitForCard,
    waitForHaReady,
    getDashboardConfig,
    saveDashboardConfig,
} from "./helpers";

/**
 * `layout: horizontal` in a real sections view: the card must place the map beside the controls, a
 * long mode name must ellipsize instead of overflowing, and the geometry must follow the cell when
 * the window is resized. All measurements come from the rendered shadow DOM of the real frontend.
 */
test("horizontal layout in a real sections view, with resize and a long mode name", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-layout/sections");
    await waitForCard(page);
    const target = await card(page);

    const geometry = () =>
        target.evaluate(element => {
            const wrapper = element.shadowRoot.querySelector(".layout-content.horizontal");
            if (!wrapper) return null;
            const map = wrapper.querySelector(".map-wrapper") as HTMLElement;
            const controls = wrapper.querySelector(".controls-column") as HTMLElement;
            const mapBox = map.getBoundingClientRect();
            const controlsBox = controls.getBoundingClientRect();
            const column = element.shadowRoot.querySelector(".controls-column") as HTMLElement;
            const scroller = element.shadowRoot.querySelector(".controls-wrapper") as HTMLElement;
            const button = element.shadowRoot.querySelector(".dropdown-menu-button") as HTMLElement;
            const text = element.shadowRoot.querySelector(".dropdown-menu-button-text") as HTMLElement;
            return {
                cardWidth: element.getBoundingClientRect().width,
                map: { left: mapBox.left, right: mapBox.right, width: mapBox.width, height: mapBox.height },
                controls: { left: controlsBox.left, right: controlsBox.right, width: controlsBox.width },
                columnWidth: column.getBoundingClientRect().width,
                scrollWidth: scroller.scrollWidth,
                clientWidth: scroller.clientWidth,
                buttonRight: button.getBoundingClientRect().right,
                buttonLeft: button.getBoundingClientRect().left,
                textOverflow: getComputedStyle(text).textOverflow,
            };
        });

    await expect.poll(geometry).not.toBeNull();
    const wide = (await geometry())!;
    expect(wide.map.right).toBeLessThanOrEqual(wide.controls.left + 1); // side by side
    expect(wide.controls.width).toBeGreaterThan(150);

    // The long mode name must stay inside the controls column, not overflow or clip on both sides,
    // and it must actually be ellipsized: the text is wider than its box and the box is clipped with
    // an ellipsis, rather than being hard-cut by the scroll container.
    expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth + 1);
    expect(wide.buttonLeft).toBeGreaterThanOrEqual(wide.controls.left - 1);
    expect(wide.buttonRight).toBeLessThanOrEqual(wide.controls.right + 1);
    const nameBox = await target.evaluate(element => {
        const label = element.shadowRoot.querySelector(".dropdown-menu-button-text") as HTMLElement | null;
        if (!label) return null;
        const style = getComputedStyle(label);
        return {
            scrollWidth: label.scrollWidth,
            clientWidth: label.clientWidth,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
            display: style.display,
        };
    });
    expect(nameBox).not.toBeNull();
    expect(nameBox!.scrollWidth).toBeGreaterThan(nameBox!.clientWidth);
    expect(nameBox!.overflow).toBe("hidden");
    expect(nameBox!.textOverflow).toBe("ellipsis");
    expect(nameBox!.whiteSpace).toBe("nowrap");
    // text-overflow does not render on a flex container, which is how the long name used to be
    // hard-clipped. The rendered display mode is part of the check for that reason.
    expect(nameBox!.display).toBe("block");

    // Every control stays inside the card horizontally; the controls column scrolls vertically when
    // the cell is shorter than the content, which is allowed.
    const containment = await target.evaluate(element => {
        const cardRect = element.getBoundingClientRect();
        const controls = [
            ...element.shadowRoot.querySelectorAll(
                ".layout-content.horizontal .map-controls, .layout-content.horizontal .dropdown-menu-button",
            ),
        ];
        return controls.map(control => {
            const rect = control.getBoundingClientRect();
            return {
                cls: control.className,
                inside: rect.left >= cardRect.left - 1 && rect.right <= cardRect.right + 1,
            };
        });
    });
    for (const entry of containment) expect(entry.inside, `${entry.cls} must stay inside the card`).toBe(true);
    await shot(page, "05-layout-horizontal-1280");

    // Home Assistant caps a sections column at a fixed width, so a browser resize does not resize the
    // card. What the resize handle does is change the card's grid options, which is the real resize
    // path: shrink the cell to 6 columns, reload, and the card must follow it.
    const original = await getDashboardConfig("e2e-layout");
    try {
        const narrowed = JSON.parse(JSON.stringify(original));
        const cardConfig = narrowed.views.find((view: any) => view.path === "sections").sections[0].cards[0];
        cardConfig.grid_options = { columns: 6 };
        await saveDashboardConfig("e2e-layout", narrowed);
        await page.reload();
        await waitForCard(page);
        await waitForHaReady(page);
        await expect.poll(async () => (await geometry())?.cardWidth ?? 0).toBeLessThan(wide.cardWidth);
        const narrow = (await geometry())!;
        // The cell is below the narrow-width breakpoint now, so the map takes the whole card and the
        // controls moved under it (proved in detail by the breakpoint test below).
        expect(narrow.map.width).toBeGreaterThanOrEqual(narrow.cardWidth - 32);
        expect(narrow.map.width).toBeGreaterThan(wide.map.width);
        expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth + 1);
        await shot(page, "06-layout-horizontal-cell-6");

        const widened = JSON.parse(JSON.stringify(original));
        const wideCard = widened.views.find((view: any) => view.path === "sections").sections[0].cards[0];
        wideCard.grid_options = { columns: 12 };
        await saveDashboardConfig("e2e-layout", widened);
        await page.reload();
        await waitForCard(page);
        await waitForHaReady(page);
        await expect.poll(async () => (await geometry())?.cardWidth ?? 0).toBeGreaterThan(narrow.cardWidth);
        await shot(page, "07-layout-horizontal-cell-12");
    } finally {
        await saveDashboardConfig("e2e-layout", original);
    }

    // The page itself must never scroll sideways, whatever the viewport is.
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, "08-layout-page-720");
});

/**
 * Below a 400 px card the horizontal arrangement stacks: the map takes the whole card width and the
 * controls follow it. The measurement and the breakpoint's basis are in
 * `HORIZONTAL_STACK_BREAKPOINT_PX` (`src/card/styles.ts`).
 *
 * The card's width is what decides, not the window: the sections view gives a 12-column card 500 px
 * and the narrowest (9 of 12) 373 px whatever the window is, so this test narrows the *card* through
 * its grid options and separately proves that a narrow *window* with a wide card still sits side by
 * side. Overlay alignment and a room tap after the restack check that `realScale` followed the new
 * map width (see AGENTS.md "Map geometry").
 */
test("horizontal layout stacks below the narrow-width breakpoint", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-layout/sections");
    await waitForCard(page);
    const target = await card(page);

    const geometry = () =>
        target.evaluate(element => {
            const wrapper = element.shadowRoot.querySelector(".layout-content.horizontal");
            if (!wrapper) return null;
            const box = (selector: string) => {
                const found = element.shadowRoot.querySelector(selector) as HTMLElement | null;
                if (!found) return null;
                const rect = found.getBoundingClientRect();
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
            };
            const image = element.shadowRoot.getElementById("map-image") as HTMLImageElement;
            const outline = element.shadowRoot.querySelector(
                ".room-1-wrapper .room-outline",
            ) as SVGGraphicsElement | null;
            const imageBox = image.getBoundingClientRect();
            const outlineBox = outline?.getBoundingClientRect();
            // The fixture map is 200 x 150 image px and the living room is the 100..170 x 20..70
            // rectangle in it (the same numbers the visual harness uses).
            const expected = {
                left: imageBox.left + imageBox.width * (100 / 200),
                top: imageBox.top + imageBox.height * (20 / 150),
                right: imageBox.left + imageBox.width * (170 / 200),
                bottom: imageBox.top + imageBox.height * (70 / 150),
            };
            const scroller = element.shadowRoot.querySelector(".controls-wrapper") as HTMLElement;
            return {
                card: box("ha-card")!,
                map: box(".map-wrapper")!,
                controls: box(".controls-column")!,
                overlayError: outlineBox
                    ? Math.max(
                          Math.abs(outlineBox.left - expected.left),
                          Math.abs(outlineBox.top - expected.top),
                          Math.abs(outlineBox.right - expected.right),
                          Math.abs(outlineBox.bottom - expected.bottom),
                      )
                    : Number.POSITIVE_INFINITY,
                controlsPosition: getComputedStyle(scroller).position,
                controlsOverflowY: getComputedStyle(scroller).overflowY,
            };
        });

    await expect.poll(geometry).not.toBeNull();
    const wide = (await geometry())!;
    expect(wide.card.width).toBeGreaterThan(400);
    expect(wide.map.right).toBeLessThanOrEqual(wide.controls.left + 1); // side by side
    expect(wide.map.width).toBeLessThan(wide.card.width * 0.7);
    expect(wide.overlayError).toBeLessThanOrEqual(4);

    const original = await getDashboardConfig("e2e-layout");
    try {
        // 6 columns is what the resize handle writes when the user drags the card narrow; the card's
        // own `min_columns: 9` clamps the cell to the narrowest a sections card can be (9/12 of a
        // 500 px section).
        const narrowed = JSON.parse(JSON.stringify(original));
        narrowed.views.find((view: any) => view.path === "sections").sections[0].cards[0].grid_options = {
            columns: 6,
        };
        await saveDashboardConfig("e2e-layout", narrowed);
        await page.reload();
        await waitForCard(page);
        await waitForHaReady(page);

        await expect.poll(async () => (await geometry())?.card.width ?? 0).toBeLessThan(400);
        const stacked = (await geometry())!;
        // Stacked, not side by side: the controls start below the map and the map spans the card.
        expect(stacked.controls.top).toBeGreaterThanOrEqual(stacked.map.bottom - 1);
        expect(Math.abs(stacked.map.left - stacked.card.left)).toBeLessThanOrEqual(1);
        expect(stacked.map.width).toBeGreaterThanOrEqual(stacked.card.width - 32);
        expect(stacked.map.width).toBeGreaterThan(wide.map.width);
        // The controls leave their absolute column, so the card scrolls as a whole instead of the
        // controls scrolling inside the map's row height.
        expect(stacked.controlsPosition).toBe("static");
        expect(stacked.controlsOverflowY).toBe("visible");
        // The restacked map recalculated its base scale: the room outline still sits on the painted
        // room of the rescaled image.
        await expect.poll(async () => (await geometry())?.overlayError ?? 99).toBeLessThanOrEqual(4);
        await shot(page, "10-layout-horizontal-stacked");

        // Room hit-testing agrees with the restacked overlay: a tap inside the room selects it.
        const selected = async (): Promise<string[]> =>
            (await target.evaluate(element =>
                element.selectedRooms.map((room: any) => String(room.toVacuum())),
            )) as string[];
        const tapPoint = await target.evaluate(element => {
            const polygon = element.shadowRoot.querySelector(
                ".room-1-wrapper .room-outline",
            ) as SVGGraphicsElement | null;
            if (!polygon) return null;
            const rect = polygon.getBoundingClientRect();
            return { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.5 };
        });
        expect(tapPoint).not.toBeNull();
        await page.mouse.click(tapPoint!.x, tapPoint!.y);
        await expect.poll(selected).toEqual(["1"]);

        // In a 6-row cell the stacked content is taller than the cell, so the card scrolls to its
        // controls instead of spilling into the next grid row.
        const scrolled = await target.evaluate(element => {
            const haCard = element.shadowRoot.querySelector("ha-card") as HTMLElement;
            haCard.scrollTop = haCard.scrollHeight;
            const cardBox = haCard.getBoundingClientRect();
            const controls = (
                element.shadowRoot.querySelector(".controls-column") as HTMLElement
            ).getBoundingClientRect();
            return {
                scrollHeight: haCard.scrollHeight,
                clientHeight: haCard.clientHeight,
                controlsVisible: controls.top < cardBox.bottom && controls.bottom > cardBox.top && controls.height > 40,
                cardScrollWidth: haCard.scrollWidth,
                cardClientWidth: haCard.clientWidth,
            };
        });
        expect(scrolled.scrollHeight).toBeGreaterThan(scrolled.clientHeight);
        expect(scrolled.controlsVisible).toBe(true);
        expect(scrolled.cardScrollWidth).toBeLessThanOrEqual(scrolled.cardClientWidth + 1);
        await shot(page, "11-layout-horizontal-stacked-controls");
    } finally {
        await saveDashboardConfig("e2e-layout", original);
    }

    // The breakpoint follows the card, not the window: a narrow window keeps the 12-column card at
    // its 500 px width, so the arrangement stays side by side.
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto("/e2e-layout/sections");
    await waitForCard(page);
    await waitForHaReady(page);
    const narrowWindow = (await geometry())!;
    expect(narrowWindow.card.width).toBeGreaterThan(400);
    expect(narrowWindow.map.right).toBeLessThanOrEqual(narrowWindow.controls.left + 1);

    // A phone narrows the card itself: every phone width is below the breakpoint.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.reload();
    await waitForCard(page);
    await waitForHaReady(page);
    await expect.poll(async () => (await geometry())?.card.width ?? 0).toBeLessThan(400);
    const phone = (await geometry())!;
    expect(phone.controls.top).toBeGreaterThanOrEqual(phone.map.bottom - 1);
    expect(phone.map.width).toBeGreaterThanOrEqual(phone.card.width - 32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await shot(page, "12-layout-horizontal-phone-stacked");
});

test("vertical layout on a real dashboard is unchanged", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-layout/vertical");
    await waitForCard(page);
    const target = await card(page);
    const stacked = await target.evaluate(element => {
        const horizontal = element.shadowRoot.querySelector(".layout-content.horizontal");
        const map = element.shadowRoot.querySelector("pinch-zoom") as HTMLElement;
        const controls = element.shadowRoot.querySelector(".map-controls") as HTMLElement;
        const mapBox = map.getBoundingClientRect();
        const controlsBox = controls.getBoundingClientRect();
        return { hasWrapper: !!horizontal, controlsBelowMap: controlsBox.top >= mapBox.bottom - 1 };
    });
    expect(stacked.hasWrapper).toBe(false);
    expect(stacked.controlsBelowMap).toBe(true);
    await shot(page, "09-layout-vertical");
});
