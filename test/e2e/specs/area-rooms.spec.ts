import type { Page } from "@playwright/test";
import {
    card,
    expect,
    openDashboard,
    serviceCall,
    shot,
    test,
    waitForCard,
    waitForMapImage,
    type CardHandle,
} from "./helpers";

/**
 * A ROOM mode that cleans Home Assistant areas, on a real instance (issue #120).
 *
 * Home Assistant's `vacuum.clean_area` takes area ids and resolves them to the robot's segments
 * through the area mapping the user set on the vacuum. `setup.cjs` creates the areas `flur`,
 * `esszimmer` and `arbeitszimmer`, maps them to the fake vacuum's segments `0`, `1` and `2`, and
 * configures the card the way the report did: icon-only rooms whose ids are area ids, on a camera
 * that publishes the numeric segment ids. The stale-room audit used to compare those area ids with
 * the camera's segment ids, marked every room stale and sent nothing.
 *
 * Real Home Assistant matters here twice: the card reads the frontend's own `hass.areas`, and the
 * run goes through Home Assistant's `clean_area`, whose area mapping only a real instance applies.
 */

const VACUUM = "vacuum.fake_vacuum";

function attribute(page: Page, name: string): Promise<unknown> {
    return page.evaluate(
        ([entity, key]) => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.attributes[key],
        [VACUUM, name] as const,
    );
}

function warning(target: CardHandle): Promise<string> {
    return target.evaluate(element =>
        (element.shadowRoot.querySelector(".room-config-warning")?.textContent ?? "").trim(),
    );
}

/** The rooms the card offers, with whether each is drawn stale. */
function rooms(target: CardHandle): Promise<Array<{ id: string; stale: boolean }>> {
    return target.evaluate(element =>
        [...element.shadowRoot.querySelectorAll(".room-label-layer")].map((layer: Element) => ({
            id: (layer.getAttribute("class") ?? "").match(/room-([\w-]+)-wrapper/)?.[1] ?? "",
            stale: layer.classList.contains("room-stale"),
        })),
    );
}

function selected(target: CardHandle): Promise<string[]> {
    return target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum())));
}

async function clickIcon(page: Page, target: CardHandle, id: string): Promise<void> {
    const box = await target.locator.locator(`.room-label-layer.room-${id}-wrapper .map-icon-wrapper`).boundingBox();
    if (!box) throw new Error(`room ${id} has no icon on screen`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function pressStart(page: Page, target: CardHandle): Promise<void> {
    const box = await target.locator.locator(".map-actions-item.main").boundingBox();
    if (!box) throw new Error("the card has no run button");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async () => {
    await serviceCall("map_fixture", "set_rooms", { mode: "reset" });
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
});

test("cleans the selected Home Assistant areas through vacuum.clean_area", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-areas/rooms");
    await waitForCard(page);
    const target = await card(page);
    await waitForMapImage(target);

    // The camera publishes segments 0, 1 and 2; the card offers the configured areas, none stale.
    await expect
        .poll(() => rooms(target), { timeout: 30_000 })
        .toEqual([
            { id: "flur", stale: false },
            { id: "esszimmer", stale: false },
            { id: "arbeitszimmer", stale: false },
        ]);
    expect(await warning(target)).toBe("");

    await clickIcon(page, target, "esszimmer");
    await clickIcon(page, target, "flur");
    await expect.poll(() => selected(target), { timeout: 15_000 }).toEqual(["esszimmer", "flur"]);
    await shot(page, "area-rooms-selected");

    await pressStart(page, target);
    // Home Assistant resolved esszimmer and flur to segments 1 and 0, in the order sent.
    await expect.poll(() => attribute(page, "commands"), { timeout: 20_000 }).toEqual([["1", "0"]]);
});

test("names an area id Home Assistant does not have, and never sends it", async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-areas/deleted");
    await waitForCard(page);
    const target = await card(page);
    await waitForMapImage(target);

    await expect.poll(() => warning(target), { timeout: 30_000 }).toContain("gaestezimmer");
    const text = await warning(target);
    expect(text).toContain("neither Home Assistant areas nor rooms on the camera map");
    for (const live of ["flur", "esszimmer", "arbeitszimmer"]) expect(text).not.toContain(live);
    expect((await rooms(target)).filter(room => room.stale).map(room => room.id)).toEqual(["gaestezimmer"]);
    await shot(page, "area-rooms-deleted");

    await clickIcon(page, target, "arbeitszimmer");
    await expect.poll(() => selected(target), { timeout: 15_000 }).toEqual(["arbeitszimmer"]);
    await pressStart(page, target);
    await expect.poll(() => attribute(page, "commands"), { timeout: 20_000 }).toEqual([["2"]]);
});
