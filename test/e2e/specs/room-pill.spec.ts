import type { Page } from "@playwright/test";
import { card, clickRoom, expect, openDashboard, shot, test, waitForCard, type CardHandle } from "./helpers";

/**
 * The selected-room pill inside the real Home Assistant frontend, in its default light theme and
 * in dark mode (the default theme follows the browser's colour scheme, so the instance is not
 * changed). The `e2e-selection` dashboard's ROOM mode sets `cleaning_order: true`, so the badges
 * carry numbers. The text must reach WCAG AA against the pill and the badge with the colours Home
 * Assistant's theme actually supplies.
 */

interface PillReading {
    badge: string;
    name: string;
    colour: string;
    background: string;
    badgeColour: string;
    badgeBackground: string;
}

function readPill(target: CardHandle, id: string): Promise<PillReading | null> {
    return target.evaluate((element, roomId: string) => {
        const pill = element.shadowRoot.querySelector(`.room-${roomId}-wrapper .room-pill`) as HTMLElement | null;
        const badge = pill?.querySelector(".room-pill-badge") as HTMLElement | null;
        if (!pill || !badge) return null;
        const style = getComputedStyle(pill);
        const badgeStyle = getComputedStyle(badge);
        return {
            badge: badge.textContent?.trim() ?? "",
            name: pill.querySelector(".room-pill-name")?.textContent?.trim() ?? "",
            colour: style.color,
            background: style.backgroundColor,
            badgeColour: badgeStyle.color,
            badgeBackground: badgeStyle.backgroundColor,
        };
    }, id);
}

function luminance(value: string): number {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    if (!match) throw new Error(`not an rgb colour: ${value}`);
    return [match[1], match[2], match[3]]
        .map(Number)
        .map(v => v / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}

function contrast(a: string, b: string): number {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * Hiding the overlay must change the pixels inside its own layout box; it only does when the
 * overlay is painted there. Engine-independent, and no baseline is involved.
 */
async function expectPaintedInPlace(page: Page, target: CardHandle, selector: string, label: string): Promise<void> {
    const box = await target.evaluate((element, sel: string) => {
        const rect = element.shadowRoot.querySelector(sel)?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    }, selector);
    expect(box, `${label}: ${selector} is rendered`).not.toBeNull();
    const clip = {
        x: Math.max(0, Math.floor(box!.x)),
        y: Math.max(0, Math.floor(box!.y)),
        width: Math.ceil(box!.width),
        height: Math.ceil(box!.height),
    };
    expect(clip.width * clip.height, `${label}: ${selector} has a size`).toBeGreaterThan(0);
    const setVisibility = (value: string): Promise<void> =>
        target.evaluate(
            (element, input: { sel: string; value: string }) => {
                (element.shadowRoot.querySelector(input.sel) as HTMLElement).style.visibility = input.value;
            },
            { sel: selector, value },
        );
    const shown = await page.screenshot({ clip, animations: "disabled" });
    await setVisibility("hidden");
    const hidden = await page.screenshot({ clip, animations: "disabled" });
    await setVisibility("");
    expect(shown.equals(hidden), `${label}: ${selector} is painted where its layout box is`).toBe(false);
}

async function selectAndCheck(page: Page, scheme: "light" | "dark"): Promise<void> {
    await page.emulateMedia({ colorScheme: scheme });
    await openDashboard(page, "/e2e-selection/rooms");
    await waitForCard(page);
    const target = await card(page);
    await expect
        .poll(() => target.evaluate(element => element.shadowRoot.querySelectorAll(".room-wrapper").length), {
            timeout: 45_000,
        })
        .toBeGreaterThanOrEqual(3);
    const darkMode = await page.evaluate(
        () => (document.querySelector("home-assistant") as any)?.hass?.themes?.darkMode,
    );
    expect(darkMode, "Home Assistant applied the colour scheme").toBe(scheme === "dark");

    for (const id of ["2", "0"]) {
        await clickRoom(page, target, id);
    }

    await expect.poll(() => readPill(target, "2")).toMatchObject({ badge: "1", name: "Bedroom" });
    const first = (await readPill(target, "2"))!;
    const second = (await readPill(target, "0"))!;
    expect(second).toMatchObject({ badge: "2", name: "Kitchen" });
    for (const [pill, label] of [
        [first, "Bedroom"],
        [second, "Kitchen"],
    ] as const) {
        expect(contrast(pill.colour, pill.background), `${scheme} ${label}: name`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(pill.badgeColour, pill.badgeBackground), `${scheme} ${label}: badge`).toBeGreaterThanOrEqual(
            4.5,
        );
        // The pill follows the theme in the expected direction: light on light, dark on dark.
        if (scheme === "light")
            expect(luminance(pill.background), `${scheme} ${label}: light pill`).toBeGreaterThan(0.7);
        else expect(luminance(pill.background), `${scheme} ${label}: dark pill`).toBeLessThan(0.2);
    }
    expect(await readPill(target, "1"), "an unselected room's pill has no badge").toBeNull();
    // Painted where they are laid out, selected and unselected: WebKit (this spec's second project)
    // painted 1.5.0's pills away from their boxes, which no layout reading notices.
    for (const selector of [".room-2-wrapper .room-pill", ".room-0-wrapper .room-pill", ".room-1-wrapper .room-pill"])
        await expectPaintedInPlace(page, target, selector, scheme);
    await shot(page, `17-room-pill-${scheme}`);
}

test("selected rooms show a readable pill in the light theme", async ({ loggedIn: page }) => {
    await selectAndCheck(page, "light");
});

test("selected rooms show a readable pill in the dark theme", async ({ loggedIn: page }) => {
    await selectAndCheck(page, "dark");
});
