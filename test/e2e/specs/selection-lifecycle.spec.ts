import {
    bumpCamera,
    card,
    clickRoom,
    expect,
    nextFrames,
    openDashboard,
    serviceCall,
    shot,
    test,
    waitForCard,
    waitForMapImage,
    type CardHandle,
} from "./helpers";

/**
 * Selection state across rebuilds on a real instance.
 *
 * Room 1 follows `input_boolean.e2e_clean_living_room`. Flipping that boolean outside the card, and
 * a new camera image, both rebuild the room objects. The user's rooms must survive each rebuild in
 * click order (the cleaning order); only the entity-backed room joins and leaves.
 */
const BOOLEAN = "input_boolean.e2e_clean_living_room";

function selected(target: CardHandle): Promise<string[]> {
    return target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum())));
}

function badges(target: CardHandle): Promise<Record<string, string>> {
    return target.evaluate(element => {
        const result: Record<string, string> = {};
        element.shadowRoot.querySelectorAll(".room-wrapper").forEach((wrapper: Element) => {
            const id = (wrapper.getAttribute("class") ?? "").match(/room-([\w-]+)-wrapper/)?.[1];
            const badge = wrapper.querySelector(".room-order")?.textContent?.trim();
            if (id && badge) result[id] = badge;
        });
        return result;
    });
}

/** The snapshot URL the card currently has on screen. */
function mapSrc(target: CardHandle): Promise<string> {
    return target.evaluate(
        element => (element.shadowRoot.getElementById("map-image-source") as HTMLImageElement | null)?.src ?? "",
    );
}

test("a selection survives entity and camera rebuilds in click order", async ({ loggedIn: page }) => {
    await serviceCall("input_boolean", "turn_off", { entity_id: BOOLEAN });
    await openDashboard(page, "/e2e-selection/rooms");
    await waitForCard(page);
    const target = await card(page);
    await waitForMapImage(target);

    try {
        for (const id of ["2", "0"]) {
            await clickRoom(page, target, id);
        }
        await expect.poll(() => selected(target)).toEqual(["2", "0"]);

        // Turned on outside the card (as an automation would): the room joins at the end.
        await serviceCall("input_boolean", "turn_on", { entity_id: BOOLEAN });
        await expect.poll(() => selected(target)).toEqual(["2", "0", "1"]);
        expect(await badges(target)).toEqual({ "2": "1", "0": "2", "1": "3" });

        // A new camera image rebuilds the rooms from the detected colours; nothing moves. Wait for
        // the card to load the new snapshot (a new URL) instead of assuming six seconds is enough.
        const beforeBump = await mapSrc(target);
        await bumpCamera(page);
        await expect
            .poll(() => mapSrc(target), { timeout: 30_000, message: "the card must load the bumped snapshot" })
            .not.toBe(beforeBump);
        await waitForMapImage(target);
        await nextFrames(page);
        expect(await selected(target)).toEqual(["2", "0", "1"]);
        await shot(page, "16-selection-after-rebuilds");

        // Turned off elsewhere: only that room leaves, the others keep their numbers.
        await serviceCall("input_boolean", "turn_off", { entity_id: BOOLEAN });
        await expect.poll(() => selected(target)).toEqual(["2", "0"]);
        expect(await badges(target)).toEqual({ "2": "1", "0": "2" });
    } finally {
        await serviceCall("input_boolean", "turn_off", { entity_id: BOOLEAN });
    }
});
