import type { Page } from "@playwright/test";
import {
    card,
    type CardHandle,
    clickRoom,
    expect,
    haNotification,
    login,
    nextFrames,
    openDashboard,
    serviceCall,
    shot,
    test,
    waitForCard,
    waitForMapImage,
} from "./helpers";

/**
 * What happens after Start, against a real Home Assistant and a vacuum that misbehaves the way real
 * ones do (`map_fixture/vacuum.py`): it reports its state late, cleans a multi-room command in its
 * own order, ignores a command while it heads home, docks after a job, can fail a call and can go
 * unavailable. The dashboard's ROOM mode is a custom `send_command`, so the card must not number
 * the rooms: this vacuum does not follow the order.
 */

const VACUUM = "vacuum.fake_vacuum";
const DASHBOARD = "/e2e-run/run";

async function configure(data: Record<string, unknown>): Promise<void> {
    await serviceCall("map_fixture", "vacuum_configure", data);
}

async function resetVacuum(activity = "docked"): Promise<void> {
    await serviceCall("map_fixture", "vacuum_reset", { activity });
    await configure({ lag: 0, room_seconds: 4, return_seconds: 3, fail_next: false, available: true, poll_seconds: 2 });
}

async function openRunCard(page: Page, dashboard = DASHBOARD): Promise<CardHandle> {
    await openDashboard(page, dashboard);
    await waitForCard(page);
    const target = await card(page);
    await expect
        .poll(() => target.evaluate(element => element.shadowRoot.querySelectorAll(".room-wrapper").length), {
            timeout: 60_000,
            message: "the run card must render its rooms",
        })
        .toBeGreaterThanOrEqual(3);
    await waitForMapImage(target);
    return target;
}

/** The vacuum state Home Assistant's frontend currently shows. */
function shownState(page: Page): Promise<string | undefined> {
    return page.evaluate(
        entity => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.state,
        VACUUM,
    );
}

function attribute(page: Page, name: string): Promise<unknown> {
    return page.evaluate(
        ([entity, key]) => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.attributes[key],
        [VACUUM, name] as const,
    );
}

/** Taps a room on its settled screen point, then waits for the card to paint the change. */
async function tapRoom(page: Page, target: CardHandle, id: string): Promise<void> {
    await clickRoom(page, target, id);
    await target.evaluate(async (element: any) => element.updateComplete);
    await nextFrames(page);
}

function selected(target: CardHandle): Promise<string[]> {
    return target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum())));
}

/** Rooms drawn as part of the run in progress. */
function running(target: CardHandle): Promise<string[]> {
    return target.evaluate(element =>
        ["0", "1", "2"].filter(id =>
            element.shadowRoot.querySelector(`.room-${id}-wrapper`)?.classList.contains("running"),
        ),
    );
}

/** Switches the card to the next or previous preset with a real tap on the preset selector arrow. */
async function switchPreset(page: Page, target: CardHandle, direction: "previous" | "next"): Promise<void> {
    const arrows = target.locator.locator("better-xvmc-preset-selector .preset-selector-icon-wrapper");
    await arrows.nth(direction === "next" ? 1 : 0).click();
    await expect
        .poll(() => target.evaluate(element => element.shadowRoot.querySelectorAll(".room-wrapper").length), {
            timeout: 60_000,
            message: "the switched preset must render its rooms",
        })
        .toBeGreaterThanOrEqual(3);
    await waitForMapImage(target);
    await nextFrames(page);
}

function presetName(target: CardHandle): Promise<string | undefined> {
    return target.locator
        .locator("better-xvmc-preset-selector .preset-label")
        .textContent()
        .then(text => text?.trim());
}

function numbers(target: CardHandle): Promise<number> {
    return target.evaluate(element => element.shadowRoot.querySelectorAll(".room-order").length);
}

function playIcons(target: CardHandle): Promise<number> {
    // The card's icon list, not the run button, which shows a play icon too.
    return target.locator.locator('.icons-wrapper ha-icon[icon="mdi:play"]').count();
}

async function pressStart(page: Page, target: CardHandle): Promise<void> {
    const box = await target.locator.locator(".map-actions-item.main").boundingBox();
    if (!box) throw new Error("the card has no run button");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // The run control waits 250 ms for a possible double tap.
    await page.waitForTimeout(600);
}

test.describe("the run after Start, with a misbehaving vacuum", () => {
    test.afterEach(async () => {
        await resetVacuum();
    });

    test("a lagging vacuum that plans its own route", async ({ loggedIn: page }) => {
        test.setTimeout(120_000);
        await resetVacuum();
        await configure({ lag: 6 });
        const target = await openRunCard(page);
        expect(await playIcons(target)).toBe(1);

        await tapRoom(page, target, "2");
        await tapRoom(page, target, "0");
        expect(await selected(target)).toEqual(["2", "0"]);
        // The vacuum does not follow the order, so the card does not promise one.
        expect(await numbers(target)).toBe(0);

        await pressStart(page, target);
        // Home Assistant still says docked, but the run is already on the map, and the play icon
        // (a full clean) is gone while the start is pending.
        expect(await shownState(page)).toBe("docked");
        expect(await running(target)).toEqual(["0", "2"]);
        expect(await playIcons(target)).toBe(0);
        await shot(page, "16-run-pending");

        // Once the start is reported, the rooms are locked.
        await expect.poll(() => shownState(page), { timeout: 20_000 }).toBe("cleaning");
        await tapRoom(page, target, "1");
        expect(await selected(target)).toEqual([]);
        expect(await running(target)).toEqual(["0", "2"]);

        // It cleans in its own order and docks; the run ends with it.
        await expect.poll(() => shownState(page), { timeout: 40_000 }).toBe("docked");
        expect(await attribute(page, "cleaned_rooms")).toEqual(["0", "2"]);
        await expect.poll(() => running(target)).toEqual([]);
        await tapRoom(page, target, "1");
        expect(await selected(target)).toEqual(["1"]);
    });

    test("a failed call gives the selection back", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ fail_next: true });
        const target = await openRunCard(page);
        await tapRoom(page, target, "2");
        await tapRoom(page, target, "0");
        await pressStart(page, target);

        await expect.poll(() => selected(target)).toEqual(["2", "0"]);
        expect(await running(target)).toEqual([]);
        expect(
            await page.evaluate(() => window.localStorage.getItem("better-xiaomi-vacuum-map-card.active-room-run")),
        ).toBeNull();
        expect(await shownState(page)).toBe("docked");
    });

    test("an unavailable vacuum keeps the run on the map without locking the rooms", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ room_seconds: 60 });
        const target = await openRunCard(page);
        await tapRoom(page, target, "1");
        await pressStart(page, target);
        await expect.poll(() => shownState(page)).toBe("cleaning");

        await configure({ available: false });
        await expect.poll(() => shownState(page)).toBe("unavailable");
        await page.waitForTimeout(3_000);
        expect(await running(target)).toEqual(["1"]);

        // Unknown is not working: a tap starts a new selection.
        await tapRoom(page, target, "2");
        expect(await selected(target)).toEqual(["2"]);
        expect(await running(target)).toEqual([]);
    });

    test("Start on an unavailable vacuum sends nothing and keeps the selection", async ({ loggedIn: page }) => {
        // A vacuum that died away from the dock is `unavailable`; Home Assistant skips it without
        // an error, so the card must not report a run that never started.
        await resetVacuum();
        const target = await openRunCard(page);
        await tapRoom(page, target, "1");
        await configure({ available: false });
        await expect.poll(() => shownState(page)).toBe("unavailable");

        await pressStart(page, target);

        // The reason is in Home Assistant's notification, and the run button shows the refusal.
        await expect.poll(() => haNotification(page)).toContain("vacuum is unavailable");
        expect(
            await target.evaluate(element =>
                element.shadowRoot.querySelector(".map-actions-item.main .run-icon")?.getAttribute("icon"),
            ),
        ).toBe("mdi:close");
        expect(await selected(target)).toEqual(["1"]);
        expect(await running(target)).toEqual([]);
        expect(
            await page.evaluate(() => window.localStorage.getItem("better-xiaomi-vacuum-map-card.active-room-run")),
        ).toBeNull();

        // Back online, nothing reached the vacuum, and Start sends the kept selection.
        await configure({ available: true });
        await expect.poll(() => shownState(page)).toBe("docked");
        expect(await attribute(page, "commands")).toEqual([]);
        await pressStart(page, target);
        await expect.poll(() => attribute(page, "commands")).toEqual([["1"]]);
        // Accepted: the run button shows the check where the user tapped.
        await expect
            .poll(() =>
                target.evaluate(element =>
                    element.shadowRoot.querySelector(".map-actions-item.main .run-icon")?.getAttribute("icon"),
                ),
            )
            .toBe("mdi:check");
    });

    test("a room command the vacuum ignores while heading home does not lock the rooms", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ return_seconds: 25 });
        const target = await openRunCard(page);
        await serviceCall("vacuum", "return_to_base", { entity_id: VACUUM });
        await expect.poll(() => shownState(page)).toBe("returning");

        await tapRoom(page, target, "1");
        await pressStart(page, target);
        // The fake vacuum rewrites its state every 2 s with a new attribute and the same
        // `returning`, as a polling integration does; let a few of those arrive.
        await page.waitForTimeout(5_000);
        // `returning` was shown before Start: it is not the start of this run.
        expect(await running(target)).toEqual(["1"]);
        await tapRoom(page, target, "2");
        expect(await selected(target)).toEqual(["2"]);

        await expect.poll(() => shownState(page), { timeout: 40_000 }).toBe("docked");
        expect(await attribute(page, "job_rooms")).toEqual([]);
    });

    test("a run stays on the map it was started on", async ({ loggedIn: page }) => {
        // One preset per floor for the same vacuum, both with the same ROOM mode and room ids.
        test.setTimeout(90_000);
        await resetVacuum();
        await configure({ room_seconds: 60 });
        const target = await openRunCard(page, "/e2e-run-floors/floors");
        expect(await presetName(target)).toBe("Ground floor");
        await tapRoom(page, target, "2");
        await pressStart(page, target);
        await expect.poll(() => shownState(page), { timeout: 20_000 }).toBe("cleaning");
        expect(await running(target)).toEqual(["2"]);

        await switchPreset(page, target, "next");
        expect(await presetName(target)).toBe("First floor");
        // The first floor's room 2 is another room: not shown as running, and taps select.
        expect(await running(target)).toEqual([]);
        await tapRoom(page, target, "1");
        expect(await selected(target)).toEqual(["1"]);
        await shot(page, "16-run-other-floor");

        await switchPreset(page, target, "previous");
        expect(await running(target)).toEqual(["2"]);
        await tapRoom(page, target, "1");
        expect(await selected(target)).toEqual([]);
    });

    test("a second tab shows the run the first started", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ lag: 6 });
        const first = await openRunCard(page);

        const secondPage = await page.context().newPage();
        await login(secondPage);
        const second = await openRunCard(secondPage);

        await tapRoom(page, first, "2");
        await tapRoom(page, first, "0");
        await pressStart(page, first);

        await expect.poll(() => running(second)).toEqual(["0", "2"]);
        await expect.poll(() => shownState(secondPage), { timeout: 20_000 }).toBe("cleaning");
        await tapRoom(secondPage, second, "1");
        expect(await selected(second)).toEqual([]);
        await secondPage.close();
    });
});
