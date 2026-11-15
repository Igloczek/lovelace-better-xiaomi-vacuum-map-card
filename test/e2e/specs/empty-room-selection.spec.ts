import type { Page } from "@playwright/test";
import { card, expect, openDashboard, serviceCall, shot, test, waitForCard, type CardHandle } from "./helpers";

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

/** A point inside a room, off-centre towards a vertex so the label is not the target. */
function roomPoint(target: CardHandle, id: string): Promise<{ x: number; y: number } | null> {
    return target.evaluate((element, roomId: string) => {
        const outline = element.shadowRoot.querySelector(
            `.room-${roomId}-wrapper .room-outline`,
        ) as SVGPolygonElement | null;
        const matrix = outline?.getScreenCTM();
        if (!outline || !matrix || outline.points.numberOfItems === 0) return null;
        const svg = outline.ownerSVGElement!;
        const screen: Array<{ x: number; y: number }> = [];
        for (let index = 0; index < outline.points.numberOfItems; index++) {
            const point = svg.createSVGPoint();
            point.x = outline.points.getItem(index).x;
            point.y = outline.points.getItem(index).y;
            screen.push(point.matrixTransform(matrix));
        }
        const centre = screen.reduce((acc, p) => ({ x: acc.x + p.x / screen.length, y: acc.y + p.y / screen.length }), {
            x: 0,
            y: 0,
        });
        const vertex = screen[0];
        return { x: centre.x + (vertex.x - centre.x) * 0.6, y: centre.y + (vertex.y - centre.y) * 0.6 };
    }, id);
}

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

function toast(target: CardHandle): Promise<string> {
    return target.evaluate(element => element.shadowRoot.getElementById("map-card-toast-text")?.innerText ?? "");
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
    // The run control waits 250 ms for a possible double tap.
    await page.waitForTimeout(600);
}

test("a selection that has no room ids left is reported and never sent", async ({ loggedIn: page }) => {
    await serviceCall("map_fixture", "set_rooms", { mode: "reset" });
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
    await openDashboard(page, DASHBOARD);
    await waitForCard(page);
    const target = await card(page);
    await expect
        .poll(() => target.evaluate(element => element.shadowRoot.querySelectorAll(".room-wrapper").length))
        .toBe(3);

    try {
        const point = await roomPoint(target, "0");
        expect(point, "room 0 must be on the map").not.toBeNull();
        await page.mouse.click(point!.x, point!.y);
        await expect.poll(() => selected(target)).toEqual(["0"]);
        expect(await warning(target)).toBe("");

        // The re-map keeps the geometry and renumbers the segments: the selected id is gone.
        await serviceCall("map_fixture", "set_rooms", { mode: "shift" });

        await expect.poll(async () => (await shownRooms(target)).stale, { timeout: 15_000 }).toContain("0");
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
        expect(await toast(target)).toContain("no longer on the camera map");

        // A live room of the new metadata is selectable again, the warning goes away, and the kept
        // room's stale marker goes with it instead of staying red for the life of the card.
        const livePoint = await roomPoint(target, "7");
        expect(livePoint, "the re-mapped room 7 must be live").not.toBeNull();
        await page.mouse.click(livePoint!.x, livePoint!.y);
        await expect.poll(() => selected(target)).toEqual(["7"]);
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
        await expect.poll(async () => (await shownRooms(target)).ids, { timeout: 15_000 }).toContain("0");
    }
});
