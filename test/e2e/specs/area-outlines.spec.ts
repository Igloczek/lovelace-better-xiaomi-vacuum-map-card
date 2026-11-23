import type { Page } from "@playwright/test";
import { PNG } from "pngjs";

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
    wsSend,
    type CardHandle,
} from "./helpers";

/**
 * Areas drawn from Home Assistant's area mapping, on a real instance (issue #120, option 5).
 *
 * `vacuum.fake_roborock` is a fake core Roborock (custom_components/roborock takes the built-in's
 * domain, so its registry entry says `platform: roborock`). Its segment ids carry the map flag,
 * `0_13`, while `camera.apartment_map` keys its rooms by the bare segment, `13`, which is the #120
 * report's data. `setup.cjs` creates areas over the apartment and maps them in the vacuum's registry
 * options the way Home Assistant's own "map areas" dialog does: Korytarz spans the corridor (13) and
 * the storeroom (14), Strych is on the upper floor whose room 10 shares its bare id with Kuchnia, Taras
 * has no segments, and rooms 12, 15 and 18 are in no area.
 *
 * Real Home Assistant matters three times: the card reads the registry options over the real
 * websocket API (`config/entity_registry/get`), it notices a re-map through the frontend's own
 * registry update, and the run goes through `vacuum.clean_area`, which resolves the areas to the
 * segments the fake vacuum records. Runs in Chromium and WebKit (playwright.config.ts): the outlines
 * are proven by their painted pixels at several zoom levels and rotations.
 */

const VACUUM = "vacuum.fake_roborock";
const SELECT = "select.fake_roborock_selected_map";

/** Image points inside apartment rooms (see apartment-rooms.spec.ts). */
const INSIDE: Record<string, [number, number]> = {
    "10": [60, 30],
    "11": [40, 140],
    "12": [160, 30],
    "13": [130, 120],
    "14": [180, 108],
    "15": [180, 130],
    "16": [150, 190],
    "17": [220, 80],
    "18": [235, 175],
};

const MAPPING = {
    salon: ["0_11"],
    kuchnia: ["0_10"],
    korytarz: ["0_13", "0_14"],
    lazienka: ["0_16"],
    sypialnia: ["0_17"],
    strych: ["1_10"],
};

const VIEWS: Array<{ scale: number; rotation: number }> = [
    { scale: 1, rotation: 0 },
    { scale: 2, rotation: 90 },
    { scale: 1.5, rotation: 180 },
    { scale: 1, rotation: 270 },
];

async function setMapping(mapping: Record<string, string[]>): Promise<void> {
    const segments = await wsSend<{ segments?: unknown[] } | unknown[]>("vacuum/get_segments", { entity_id: VACUUM });
    await wsSend("config/entity_registry/update", {
        entity_id: VACUUM,
        options_domain: "vacuum",
        options: {
            area_mapping: mapping,
            last_seen_segments: Array.isArray(segments) ? segments : segments.segments,
        },
    });
}

function commands(page: Page): Promise<unknown> {
    return page.evaluate(
        entity => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.attributes.commands,
        VACUUM,
    );
}

const selectedIds = (target: CardHandle): Promise<string[]> =>
    target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum()))) as Promise<string[]>;

/** The offered rooms with the number of outlines each is drawn with. */
function offered(target: CardHandle): Promise<Record<string, number>> {
    return target.evaluate(element =>
        Object.fromEntries(element.selectableRooms.map((room: any) => [String(room.toVacuum()), room.segments.length])),
    ) as Promise<Record<string, number>>;
}

function warningText(target: CardHandle): Promise<string> {
    return target.evaluate(element =>
        [...element.shadowRoot.querySelectorAll(".room-config-warning")]
            .map((warning: Element) => warning.textContent?.trim() ?? "")
            .join(" "),
    );
}

/** The page point of an image pixel: the overlay shares the image's scale and transform. */
async function screenPoint(target: CardHandle, [x, y]: [number, number]): Promise<{ x: number; y: number }> {
    const point = await target.evaluate(
        (element, p: { x: number; y: number }) => {
            const svg = element.shadowRoot.getElementById("svg-wrapper") as SVGSVGElement;
            const matrix = svg.getScreenCTM();
            if (!matrix) return null;
            const local = svg.createSVGPoint();
            local.x = (p.x + 0.5) * element.realScale;
            local.y = (p.y + 0.5) * element.realScale;
            const screen = local.matrixTransform(matrix);
            return { x: screen.x, y: screen.y };
        },
        { x, y },
    );
    if (!point) throw new Error(`no screen position for ${x},${y}`);
    return point;
}

async function setView(target: CardHandle, scale: number, rotation: number): Promise<void> {
    await target.evaluate(
        async (element, view: { scale: number; rotation: number }) => {
            element._setRotation(view.rotation);
            const zoomer = element.shadowRoot.getElementById("map-zoomer");
            zoomer.setTransform({ scale: view.scale, x: 0, y: 0, allowChangeEvent: true });
            await element.updateComplete;
        },
        { scale, rotation },
    );
    await expect.poll(() => target.evaluate(element => element.mapRotation)).toBe(rotation);
    await expect.poll(() => target.evaluate(element => element.mapScale)).toBeCloseTo(scale, 1);
}

/** Whether an image point is on screen inside the map viewport at the current view. */
async function visible(target: CardHandle, point: [number, number]): Promise<boolean> {
    const { x, y } = await screenPoint(target, point);
    const box = (await target.locator.locator("#map-zoomer").boundingBox())!;
    return x > box.x + 4 && y > box.y + 4 && x < box.x + box.width - 4 && y < box.y + box.height - 4;
}

/** Every selected area's outline filled solid magenta, a colour nothing else on the map uses. */
async function markSelected(target: CardHandle, marked: boolean): Promise<void> {
    await target.evaluate((element, value: boolean) => {
        const root = element.shadowRoot as ShadowRoot;
        root.getElementById("selected-marked")?.remove();
        if (!value) return;
        const style = document.createElement("style");
        style.id = "selected-marked";
        style.textContent = `.room-wrapper.selected .room-outline { fill: rgb(255, 0, 255) !important;
            fill-opacity: 1 !important; transition: none !important; }
            .room-label-layer { display: none !important; }`;
        root.appendChild(style);
    }, marked);
}

/** Whether the painted pixel at an image point is the marked magenta. */
async function paintedMagenta(page: Page, target: CardHandle, point: [number, number]): Promise<boolean> {
    const { x, y } = await screenPoint(target, point);
    const png = PNG.sync.read(
        await page.screenshot({ clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 3, height: 3 } }),
    );
    const centre = (1 * 3 + 1) * 4;
    const [r, g, b] = [png.data[centre], png.data[centre + 1], png.data[centre + 2]];
    return r > 200 && b > 200 && g < 80;
}

async function tap(page: Page, target: CardHandle, point: [number, number]): Promise<void> {
    const { x, y } = await screenPoint(target, point);
    await page.mouse.click(x, y);
    await nextFrames(page);
}

async function pressStart(page: Page, target: CardHandle): Promise<void> {
    const box = await target.locator.locator(".map-actions-item.main").boundingBox();
    if (!box) throw new Error("the card has no run button");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openCard(page: Page, view: "configured" | "mapped"): Promise<CardHandle> {
    await openDashboard(page, `/e2e-area-outlines/${view}`);
    await waitForCard(page);
    const target = await card(page);
    await waitForMapImage(target);
    await expect.poll(() => target.evaluate(element => !!element.roomColorDetection), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => offered(target), { timeout: 30_000 }).toMatchObject({ korytarz: 2 });
    await nextFrames(page);
    return target;
}

test.beforeEach(async () => {
    await serviceCall("map_fixture", "vacuum_reset", { activity: "docked" });
    await serviceCall("select", "select_option", { entity_id: SELECT, option: "Erdgeschoss" });
    await setMapping(MAPPING);
});

test("draws each area from its mapped rooms and sends the area a tap selects, at every zoom and rotation", async ({
    loggedIn: page,
}) => {
    test.setTimeout(180_000);
    const target = await openCard(page, "configured");

    // Strych is on the upper floor and Taras has no segments: icon only. The rest have outlines.
    expect(await offered(target)).toEqual({
        salon: 1,
        kuchnia: 1,
        korytarz: 2,
        lazienka: 1,
        sypialnia: 1,
        strych: 0,
        taras: 0,
    });
    await shot(page, `area-outlines-${test.info().project.name}`);

    for (const { scale, rotation } of VIEWS) {
        const label = `zoom ${scale}, rotation ${rotation}`;
        await setView(target, scale, rotation);
        await nextFrames(page);

        // A tap in the storeroom (14) selects Korytarz, the area it belongs to; a tap in the
        // wardrobe (12), which is in no area, selects nothing.
        const storeroomVisible = await visible(target, INSIDE["14"]);
        if (storeroomVisible) {
            await tap(page, target, INSIDE["14"]);
            expect(await selectedIds(target), `${label}: storeroom`).toEqual(["korytarz"]);
        } else {
            await tap(page, target, INSIDE["13"]);
            expect(await selectedIds(target), `${label}: corridor`).toEqual(["korytarz"]);
        }
        if (await visible(target, INSIDE["12"])) {
            await tap(page, target, INSIDE["12"]);
            expect(await selectedIds(target), `${label}: wardrobe`).toEqual(["korytarz"]);
        }

        // Both of Korytarz's rooms are painted selected, and no other room is: by the pixels.
        await markSelected(target, true);
        try {
            for (const [roomId, selected] of [
                ["13", true],
                ["14", true],
                ["11", false],
                ["17", false],
                ["12", false],
            ] as const) {
                if (!(await visible(target, INSIDE[roomId]))) continue;
                expect(await paintedMagenta(page, target, INSIDE[roomId]), `${label}: room ${roomId}`).toBe(selected);
            }
        } finally {
            await markSelected(target, false);
        }
        // Clear the selection for the next view.
        await tap(page, target, storeroomVisible ? INSIDE["14"] : INSIDE["13"]);
        expect(await selectedIds(target), `${label}: cleared`).toEqual([]);
    }

    await setView(target, 1, 0);
    await tap(page, target, INSIDE["11"]);
    await tap(page, target, INSIDE["14"]);
    expect(await selectedIds(target)).toEqual(["salon", "korytarz"]);
    await pressStart(page, target);
    // Home Assistant resolved salon and korytarz to their segments, in the order sent.
    await expect.poll(() => commands(page), { timeout: 20_000 }).toEqual([["0_11", "0_13", "0_14"]]);
});

test("warns before the run about a selected area Home Assistant has no segments for", async ({ loggedIn: page }) => {
    const target = await openCard(page, "configured");

    expect(await warningText(target)).toBe("");
    const taras = await target.locator.locator(".room-label-layer.room-taras-wrapper .map-icon-wrapper").boundingBox();
    await page.mouse.click(taras!.x + taras!.width / 2, taras!.y + taras!.height / 2);
    await tap(page, target, INSIDE["17"]);
    expect(await selectedIds(target)).toEqual(["taras", "sypialnia"]);
    await expect.poll(() => warningText(target)).toContain("no segments mapped to these selected areas");
    expect(await warningText(target)).toContain(": taras.");
    await shot(page, `area-outlines-unmapped-${test.info().project.name}`);

    // The card still sends both; Home Assistant cleans the mapped one and reports the other.
    await pressStart(page, target);
    await expect.poll(() => commands(page), { timeout: 20_000 }).toEqual([["0_17"]]);
});

test("follows a re-map in Home Assistant and the vacuum's current floor without a reload", async ({
    loggedIn: page,
}) => {
    const target = await openCard(page, "configured");

    // The user moves the storeroom from Korytarz to Łazienka in the vacuum's settings.
    await setMapping({ ...MAPPING, korytarz: ["0_13"], lazienka: ["0_16", "0_14"] });
    await expect.poll(() => offered(target), { timeout: 20_000 }).toMatchObject({ korytarz: 1, lazienka: 2 });
    await tap(page, target, INSIDE["14"]);
    expect(await selectedIds(target)).toEqual(["lazienka"]);
    await tap(page, target, INSIDE["14"]);

    // The vacuum switches to the upper floor: room 10 is Strych's there, not Kuchnia's. The camera
    // publishes its next snapshot, which is when the card redraws.
    await serviceCall("select", "select_option", { entity_id: SELECT, option: "Obergeschoss" });
    await serviceCall("map_fixture", "bump");
    await expect.poll(() => offered(target), { timeout: 20_000 }).toMatchObject({ kuchnia: 0, strych: 1 });
    await tap(page, target, INSIDE["10"]);
    expect(await selectedIds(target)).toEqual(["strych"]);
});

test("builds the rooms from the area mapping when a clean_area mode lists none", async ({ loggedIn: page }) => {
    const target = await openCard(page, "mapped");

    // Every mapped area with a room on this floor; never the camera's segment rooms.
    expect(await offered(target)).toEqual({ salon: 1, kuchnia: 1, korytarz: 2, lazienka: 1, sypialnia: 1 });
    const names = await target.evaluate(element =>
        [...element.shadowRoot.querySelectorAll(".room-label-layer .room-pill")].map(
            (pill: Element) => pill.textContent?.trim() ?? "",
        ),
    );
    expect(names).toEqual(expect.arrayContaining(["Salon", "Korytarz", "Łazienka"]));
    await shot(page, `area-outlines-mapped-${test.info().project.name}`);

    await tap(page, target, INSIDE["16"]);
    await pressStart(page, target);
    await expect.poll(() => commands(page), { timeout: 20_000 }).toEqual([["0_16"]]);
});
