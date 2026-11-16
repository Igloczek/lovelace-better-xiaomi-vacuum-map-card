import { expect, nextFrames, openDashboard, card, shot, test, waitForCard, waitForHaReady, viewState } from "./helpers";

/**
 * A reset that arrives while the map is not shown.
 *
 * The card stays attached in a hidden container (a tab the user is not looking at, a closed
 * popup), so a dashboard action still reaches it. The map has no layout box there, and a view
 * computed against zero would frame the map's top-left corner and store it: the reset has to wait
 * for the first real layout and store the centred default instead.
 */

/** The stored map view entries, as they are written to localStorage. */
async function storedMapViews(
    page: import("@playwright/test").Page,
): Promise<Array<{ key: string; scale: number; x: number; y: number; rotation: number; width?: number }>> {
    return page.evaluate(() => {
        const raw = window.localStorage.getItem("better-xiaomi-vacuum-map-card.map-view");
        const storage = raw ? (JSON.parse(raw) as Record<string, any>) : {};
        return Object.entries(storage).map(([key, entry]) => ({
            key,
            scale: Number(entry.s),
            x: Number(entry.x),
            y: Number(entry.y),
            rotation: Number(entry.r ?? 0),
            width: Number(entry.w) > 0 ? Number(entry.w) : undefined,
        }));
    });
}

test("a reset fired while the card is hidden applies and stores the default view when shown", async ({
    loggedIn: page,
}) => {
    await openDashboard(page, "/e2e-map/map");
    await waitForCard(page);
    const target = await card(page);
    const defaultView = await viewState(target);
    await expect.poll(async () => (await viewState(target)).scale).toBeCloseTo(2.5, 1);

    const mapBox = await target.evaluate(element => {
        const rect = (element.shadowRoot.getElementById("map-zoomer") as HTMLElement).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    for (let attempt = 0; attempt < 4 && (await viewState(target)).scale <= defaultView.scale + 0.1; attempt++) {
        await page.mouse.move(mapBox.x, mapBox.y);
        await page.mouse.wheel(0, -600);
        await nextFrames(page);
    }
    await expect.poll(async () => (await viewState(target)).scale).toBeGreaterThan(defaultView.scale + 0.1);
    await expect.poll(async () => (await storedMapViews(page)).length).toBe(1);
    const away = await viewState(target);

    // The card is still attached but its container has no layout box, as in a hidden view.
    await target.evaluate(element => {
        (element as HTMLElement).style.display = "none";
    });
    await expect
        .poll(async () =>
            target.evaluate(
                element => (element.shadowRoot.getElementById("map-zoomer-content") as HTMLElement).offsetWidth,
            ),
        )
        .toBe(0);

    await page.evaluate(() => {
        document.dispatchEvent(
            new CustomEvent("ll-custom", {
                detail: { xiaomi_vacuum_map_card: { action_handler_id: "this", action: "map_view.reset" } },
            }),
        );
    });
    // The view-save debounce is deliberately left to elapse: this asserts that nothing happened, so
    // there is no condition to wait for. A view computed from the zero-size layout would be applied
    // and stored by now.
    await page.waitForTimeout(800);

    const whileHidden = await viewState(target);
    expect(whileHidden.scale, "the reset is not applied against a zero-size layout").toBeCloseTo(away.scale, 1);
    expect(Math.abs(whileHidden.x - away.x) + Math.abs(whileHidden.y - away.y)).toBeLessThan(2);
    const hiddenStored = await storedMapViews(page);
    expect(hiddenStored).toHaveLength(1);
    expect(hiddenStored[0].x, "the pre-reset view is still what is stored").toBeCloseTo(away.x, 0);
    expect(hiddenStored[0].y).toBeCloseTo(away.y, 0);
    // The raw configured offsets would be the top-left framing; the reset must not have stored them.
    expect(Math.abs(hiddenStored[0].x - 40) + Math.abs(hiddenStored[0].y + 20)).toBeGreaterThan(20);

    // Shown again with nothing else happening: the deferred reset applies once.
    await target.evaluate(element => {
        (element as HTMLElement).style.display = "";
    });
    await expect.poll(async () => Math.abs((await viewState(target)).scale - defaultView.scale)).toBeLessThan(0.05);
    await expect
        .poll(async () => Math.abs((await viewState(target)).rotation - defaultView.rotation))
        .toBeLessThan(0.5);
    await expect.poll(async () => Math.abs((await viewState(target)).x - defaultView.x)).toBeLessThan(3);
    await expect.poll(async () => Math.abs((await viewState(target)).y - defaultView.y)).toBeLessThan(3);
    await shot(page, "05-hidden-reset-shown");

    // The reset was stored as the centred default at the card's real width, not as a zero-size one.
    await expect
        .poll(async () => {
            const entry = (await storedMapViews(page))[0];
            return entry ? Math.abs(entry.x - defaultView.x) + Math.abs(entry.y - defaultView.y) : Number.NaN;
        })
        .toBeLessThan(3);
    const stored = (await storedMapViews(page))[0];
    expect(stored.scale).toBeCloseTo(defaultView.scale, 1);
    expect(Math.abs(stored.x - defaultView.x), "stored offsets match the visible default").toBeLessThan(3);
    expect(Math.abs(stored.y - defaultView.y)).toBeLessThan(3);
    expect(stored.width).toBeGreaterThan(0);

    // And a reload opens at the stored value.
    await page.reload();
    await waitForCard(page);
    await waitForHaReady(page);
    const reloaded = await card(page);
    await expect.poll(async () => Math.abs((await viewState(reloaded)).scale - defaultView.scale)).toBeLessThan(0.05);
    await expect.poll(async () => Math.abs((await viewState(reloaded)).x - defaultView.x)).toBeLessThan(3);
    await expect.poll(async () => Math.abs((await viewState(reloaded)).y - defaultView.y)).toBeLessThan(3);
    await shot(page, "06-hidden-reset-reloaded");
});

/**
 * The configured default view on the real frontend (fetch + storage + Lit render).
 *
 * Inputs are real user gestures: a wheel zoom over the map and clicks on the card's own zoom and
 * reset controls. The view is asserted on scale and offsets, and it must survive a reload.
 */
test("map_view opens, resets and persists on a real dashboard", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-map/map");
    await waitForCard(page);
    const target = await card(page);

    // The card config sets map_view {scale: 2.5, x: 40, y: -20, rotation: 90}: every field must be
    // applied, including the rotation, not only the scale.
    await expect.poll(async () => (await viewState(target)).scale).toBeCloseTo(2.5, 1);
    await expect.poll(async () => (await viewState(target)).rotation).toBe(90);
    const defaultView = await viewState(target);
    expect(defaultView.scale).toBeCloseTo(2.5, 1);
    expect(defaultView.rotation).toBe(90);

    const mapBox = await target.evaluate(element => {
        const rect = (element.shadowRoot.getElementById("map-zoomer") as HTMLElement).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    // A real wheel gesture over the map. The card's pinch-zoom handles the wheel event; a retry
    // keeps the test stable while the card finishes attaching its gesture handlers after load.
    for (let attempt = 0; attempt < 4 && (await viewState(target)).scale <= defaultView.scale + 0.1; attempt++) {
        await page.mouse.move(mapBox.x, mapBox.y);
        await page.mouse.wheel(0, -600);
        await nextFrames(page);
    }
    // Compare with the configured view, not a constant: the card opens at 2.5, so a fixed 2.05
    // threshold would skip the gesture entirely and the rest of the test would assert nothing.
    await expect.poll(async () => (await viewState(target)).scale).toBeGreaterThan(defaultView.scale + 0.1);
    const wheeled = await viewState(target);
    expect(Math.abs(wheeled.x - defaultView.x) + Math.abs(wheeled.y - defaultView.y)).toBeGreaterThan(1);
    await shot(page, "02-map-view-panned");

    // The card's reset control returns to the configured default: all four values, not only scale.
    await target.evaluate(element => {
        const reset = element.shadowRoot.querySelector(".icon-on-map.clickable") as HTMLElement;
        reset.click();
    });
    await expect.poll(async () => Math.abs((await viewState(target)).scale - defaultView.scale)).toBeLessThan(0.05);
    await expect
        .poll(async () => Math.abs((await viewState(target)).rotation - defaultView.rotation))
        .toBeLessThan(0.5);
    await expect.poll(async () => Math.abs((await viewState(target)).x - defaultView.x)).toBeLessThan(3);
    await expect.poll(async () => Math.abs((await viewState(target)).y - defaultView.y)).toBeLessThan(3);
    await shot(page, "03-map-view-reset");

    // The map_view.reset action (fire-dom-event) must do the same from a changed view.
    await page.mouse.move(mapBox.x, mapBox.y);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => (await viewState(target)).scale).toBeGreaterThan(defaultView.scale + 0.1);
    await page.evaluate(() => {
        document.dispatchEvent(
            new CustomEvent("ll-custom", {
                detail: { xiaomi_vacuum_map_card: { action_handler_id: "this", action: "map_view.reset" } },
            }),
        );
    });
    await expect.poll(async () => Math.abs((await viewState(target)).scale - defaultView.scale)).toBeLessThan(0.05);
    await expect
        .poll(async () => Math.abs((await viewState(target)).rotation - defaultView.rotation))
        .toBeLessThan(0.5);

    // Reload: the stored view for this key was written by the reset, which equals the default here.
    await page.reload();
    await waitForCard(page);
    await waitForHaReady(page);
    const reloaded = await card(page);
    await expect.poll(async () => Math.abs((await viewState(reloaded)).scale - defaultView.scale)).toBeLessThan(0.05);
    await expect
        .poll(async () => Math.abs((await viewState(reloaded)).rotation - defaultView.rotation))
        .toBeLessThan(0.5);

    // A wheel gesture after the reset persists across another reload.
    // Give the reloaded card a moment to attach its gesture handlers, then zoom with the wheel.
    await expect
        .poll(async () => reloaded.evaluate(element => !!element.shadowRoot?.getElementById("map-zoomer")))
        .toBe(true);
    const mapBox2 = await reloaded.evaluate(element => {
        const rect = (element.shadowRoot.getElementById("map-zoomer") as HTMLElement).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    for (let attempt = 0; attempt < 3 && (await viewState(reloaded)).scale <= defaultView.scale + 0.1; attempt++) {
        await page.mouse.move(mapBox2.x, mapBox2.y);
        await page.mouse.wheel(0, -600);
        await nextFrames(page);
    }
    await expect.poll(async () => (await viewState(reloaded)).scale).toBeGreaterThan(defaultView.scale + 0.1);
    const gestures = await viewState(reloaded);
    // The gesture must really have moved away from the reset view, or the reload below proves
    // nothing about persistence.
    expect(Math.abs(gestures.x - defaultView.x) + Math.abs(gestures.y - defaultView.y)).toBeGreaterThan(1);
    // Wait for the debounced view save to carry the gesture, not for a guessed number of ms.
    await expect.poll(async () => (await storedMapViews(page))[0]?.scale ?? 0).toBeCloseTo(gestures.scale, 1);
    await page.reload();
    await waitForCard(page);
    await waitForHaReady(page);
    const afterReload = await card(page);
    await expect.poll(async () => (await viewState(afterReload)).scale).toBeCloseTo(gestures.scale, 1);
    await expect.poll(async () => Math.abs((await viewState(afterReload)).x - gestures.x)).toBeLessThan(4);
    await expect.poll(async () => Math.abs((await viewState(afterReload)).y - gestures.y)).toBeLessThan(4);
    await shot(page, "04-map-view-persisted");
});
