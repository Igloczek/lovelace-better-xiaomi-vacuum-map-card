import type { Page } from "@playwright/test";

import {
    card,
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
 * A turned zone from the card to a Viomi, end to end. The `e2e-rotated-zone` dashboard uses
 * al-one/hass-xiaomi-miot's `vacuum_clean_zone_rotatable` on the fake vacuum, which takes the Viomi
 * zone protocol the way the robot does (map_fixture/vacuum.py `_viomi_command`): `set_uploadmap`,
 * then `set_zone [count, "i_0_x1_y1_..._x4_y4"]`, then `set_mode [3, 1]`. The zone is drawn and
 * turned with the mouse, and the corners the robot parsed must be the ones the card drew.
 */

const VACUUM = "vacuum.fake_vacuum";

function attribute(page: Page, name: string): Promise<unknown> {
    return page.evaluate(
        ([entity, key]) => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.attributes[key],
        [VACUUM, name] as const,
    );
}

async function centre(target: CardHandle, selector: string): Promise<{ x: number; y: number }> {
    const box = await target.locator.locator(selector).first().boundingBox();
    if (!box) throw new Error(`${selector} is not on screen`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("a zone turned with the rotate handle reaches the Viomi as its four turned corners", async ({
    loggedIn: page,
}) => {
    test.setTimeout(120_000);
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
    await serviceCall("map_fixture", "vacuum_configure", { lag: 0, room_seconds: 2, return_seconds: 2 });
    await openDashboard(page, "/e2e-rotated-zone/zone");
    await waitForCard(page);
    const target = await card(page);
    await waitForMapImage(target);

    // The zone mode opens with one zone on the map, without a + press.
    await expect.poll(() => target.evaluate(element => element.selectedManualRectangles.length)).toBe(1);
    await expect(target.locator.locator("polygon.manual-rectangle")).toHaveCount(1);
    await nextFrames(page);
    expect(await target.locator.locator(".manual-rectangle-rotate-circle").count()).toBe(1);

    // Turn it: drag the rotate handle a quarter of the way around the zone's centre, then back to
    // 45° from where it started.
    const zoneCentre = await centre(target, "polygon.manual-rectangle");
    const handle = await centre(target, ".manual-rectangle-rotate-circle");
    const radius = Math.hypot(handle.x - zoneCentre.x, handle.y - zoneCentre.y);
    const start = Math.atan2(handle.y - zoneCentre.y, handle.x - zoneCentre.x);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    for (let step = 1; step <= 9; step++) {
        const angle = start + (step * Math.PI) / 36;
        await page.mouse.move(zoneCentre.x + radius * Math.cos(angle), zoneCentre.y + radius * Math.sin(angle));
    }
    await page.mouse.up();
    await nextFrames(page);
    const degrees = await target.evaluate(element => (element.selectedManualRectangles[0].angle * 180) / Math.PI);
    expect(Math.abs(degrees)).toBe(45);
    await shot(page, "rotated-zone-drawn");

    const sent: number[] = await target.evaluate(element => element.selectedManualRectangles[0].toVacuum());
    expect(sent).toHaveLength(8);

    const box = await target.locator.locator(".map-actions-item.main").boundingBox();
    if (!box) throw new Error("the card has no run button");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect
        .poll(async () => ((await attribute(page, "viomi_commands")) as unknown[] | undefined)?.length ?? 0, {
            timeout: 20_000,
            message: "the vacuum must get all three commands",
        })
        .toBe(3);
    const commands = (await attribute(page, "viomi_commands")) as Array<[string, unknown[]]>;
    expect(commands.map(([command]) => command)).toEqual(["set_uploadmap", "set_zone", "set_mode"]);
    expect(commands[0][1]).toEqual([1]);
    expect(commands[2][1]).toEqual([3, 1]);
    expect((commands[1][1] as unknown[])[0]).toBe(1);

    // The robot's corners are the card's, in the card's order, to the template's 3 decimals.
    const zones = (await attribute(page, "viomi_zones")) as number[][];
    expect(zones).toHaveLength(1);
    zones[0].forEach((value, i) => expect(value).toBeCloseTo(sent[i], 3));
    // Turned 45°: no two neighbouring corners share an x or a y, as they would for a box.
    for (let i = 0; i < 4; i++) {
        const [x1, y1] = [zones[0][2 * i], zones[0][2 * i + 1]];
        const [x2, y2] = [zones[0][(2 * i + 2) % 8], zones[0][(2 * i + 3) % 8]];
        expect(Math.abs(x1 - x2)).toBeGreaterThan(1);
        expect(Math.abs(y1 - y2)).toBeGreaterThan(1);
    }
    await expect.poll(() => attribute(page, "viomi_zones"), { timeout: 20_000 }).toBeTruthy();
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
});
