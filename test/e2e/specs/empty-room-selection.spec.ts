import type { Page } from "@playwright/test";
import {
    card,
    clickRoom,
    expect,
    haNotification,
    openDashboard,
    serviceCall,
    shot,
    test,
    waitForCard,
    waitForMapImage,
    waitForRoomId,
    waitForRooms,
    type CardHandle,
} from "./helpers";

/**
 * A ROOM selection that would send no room ids, on a real instance.
 *
 * The dashboard's ROOM mode is template-only: `predefined_selections` is empty, so every room comes
 * from the camera's `rooms` metadata and the selected room has no configured id for the stale-id
 * audit. After a re-map that renumbers the segments, the old selection reached `_getSelection` as an
 * empty list: the card looked ready and the run button called the service with nothing to clean.
 * The card must mark the vanished room, warn with its id, and refuse the run without calling the
 * fake vacuum.
 */

const VACUUM = "vacuum.fake_vacuum";
const DASHBOARD = "/e2e-empty-rooms/rooms";

function selected(target: CardHandle): Promise<string[]> {
    return target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum())));
}

/** The rooms the card currently draws, their stale ids and the selected ones. */
function shownRooms(target: CardHandle): Promise<{ ids: string[]; stale: string[]; selected: string[] }> {
    return target.evaluate(element => {
        const wrappers = [...element.shadowRoot.querySelectorAll(".room-wrapper")];
        const idOf = (wrapper: Element): string =>
            (wrapper.getAttribute("class") ?? "").match(/room-([\w-]+)-wrapper/)?.[1] ?? "";
        return {
            ids: wrappers.map(idOf),
            stale: wrappers.filter(wrapper => wrapper.classList.contains("room-stale")).map(idOf),
            selected: wrappers.filter(wrapper => wrapper.classList.contains("selected")).map(idOf),
        };
    });
}

function warning(target: CardHandle): Promise<string> {
    return target.evaluate(element =>
        (element.shadowRoot.querySelector(".room-selection-warning")?.textContent ?? "").trim(),
    );
}

function attribute(page: Page, name: string): Promise<unknown> {
    return page.evaluate(
        ([entity, key]) => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.attributes[key],
        [VACUUM, name] as const,
    );
}

async function pressStart(page: Page, target: CardHandle): Promise<void> {
    const box = await target.locator.locator(".map-actions-item.main").boundingBox();
    if (!box) throw new Error("the card has no run button");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // The run control waits 250 ms for a possible double tap. Wait for the refusal it produces
    // instead of sleeping for that timer: the run button turns into a cross, and Home Assistant's
    // notification says why.
    await expect
        .poll(
            () =>
                target.evaluate(element =>
                    element.shadowRoot.querySelector(".map-actions-item.main .run-icon")?.getAttribute("icon"),
                ),
            { timeout: 20_000 },
        )
        .toBe("mdi:close");
    await expect.poll(() => haNotification(page)).toContain("no longer on the camera map");
}

test("a selection that has no room ids left is reported and never sent", async ({ loggedIn: page }) => {
    await serviceCall("map_fixture", "set_rooms", { mode: "reset" });
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
    await openDashboard(page, DASHBOARD);
    await waitForCard(page);
    const target = await card(page);
    // A fresh instance loads the bundle, the camera snapshot and the room colours for the first
    // time: wait for the image and the rooms instead of the five-second default poll window.
    await waitForMapImage(target);
    await waitForRooms(target, ["0", "1", "2"]);

    try {
        await clickRoom(page, target, "0");
        await expect.poll(() => selected(target), { timeout: 15_000 }).toEqual(["0"]);
        expect(await warning(target)).toBe("");

        // The re-map keeps the geometry and renumbers the segments: the selected id is gone.
        await serviceCall("map_fixture", "set_rooms", { mode: "shift" });

        await expect.poll(async () => (await shownRooms(target)).stale, { timeout: 30_000 }).toContain("0");
        const afterRemap = await shownRooms(target);
        // The vanished selection stays on the map as a warning, and never as a selected room.
        expect(afterRemap.ids).toContain("0");
        expect(afterRemap.selected).toEqual([]);
        expect(await warning(target)).toContain("0");
        expect(await selected(target)).toEqual([]);
        await shot(page, "18-empty-room-selection");

        // The run is refused: the fake vacuum receives no command at all (an empty call would show
        // up as an empty entry in `commands`), and the card says why.
        expect(await attribute(page, "commands")).toEqual([]);
        await pressStart(page, target);
        expect(await attribute(page, "commands")).toEqual([]);
        expect(await attribute(page, "job_rooms")).toEqual([]);
        expect(await attribute(page, "cleaned_rooms")).toEqual([]);
        await expect.poll(() => haNotification(page)).toContain("no longer on the camera map");

        // A live room of the new metadata is selectable again, the warning goes away, and the kept
        // room's stale marker goes with it instead of staying red for the life of the card.
        await waitForRoomId(target, "7", { timeout: 30_000 });
        await clickRoom(page, target, "7");
        await expect.poll(() => selected(target), { timeout: 15_000 }).toEqual(["7"]);
        expect(await warning(target)).toBe("");
        await expect.poll(async () => (await shownRooms(target)).stale).toEqual([]);
        const afterSelection = await shownRooms(target);
        expect(afterSelection.ids).toEqual(["7", "8", "9"]);
        expect(afterSelection.selected).toEqual(["7"]);
    } finally {
        // Always restore the fixture: a failure above must not renumber the camera for later specs.
        // The room selected above is stale again after the reset, by design; the original ids are
        // what proves the fixture is back.
        await serviceCall("map_fixture", "set_rooms", { mode: "reset" });
        await waitForRoomId(target, "0", { timeout: 30_000 });
    }
});
