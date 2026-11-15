import type { Page } from "@playwright/test";

import { card, expect, openDashboard, shot, test, waitForCard, wsSend, type CardHandle } from "./helpers";

/**
 * A rename in Home Assistant's registries has to reach the card without a reload (ROADMAP known
 * limitations: renamed entities in tiles and in icons).
 *
 * Everything here goes through Home Assistant's own websocket API, the way the entity, device and
 * area dialogs do. The card is never reloaded: the element stays the same and the page keeps its
 * marker, so a stale label or icon is the card's fault and not a fresh render.
 *
 * The configured tile has no label, so its title is the display name Home Assistant composes from
 * the entity, device and area registries; the generated `filter_left` tile takes its icon from the
 * fixture sensor's registry entry.
 */

const VACUUM = "vacuum.fake_vacuum";
const SENSOR = "sensor.fake_vacuum_filter";
const AREA = "kitchen";
const RENAMED_ENTITY = "Renames robot";
const RENAMED_DEVICE = "Renames device";

function configure(pollSeconds: number): Promise<unknown> {
    return wsSend("call_service", {
        domain: "map_fixture",
        service: "vacuum_configure",
        service_data: { poll_seconds: pollSeconds },
    });
}

async function entityEntry(entityId: string): Promise<{ device_id?: string; area_id?: string | null }> {
    return wsSend("config/entity_registry/get", { entity_id: entityId });
}

async function restore(originalAreaName: string | undefined): Promise<void> {
    const entry = await entityEntry(VACUUM);
    await wsSend("config/entity_registry/update", { entity_id: VACUUM, name: null, area_id: null });
    if (entry.device_id) {
        await wsSend("config/device_registry/update", { device_id: entry.device_id, name_by_user: null });
    }
    await wsSend("config/entity_registry/update", { entity_id: SENSOR, icon: null });
    if (originalAreaName !== undefined) {
        await wsSend("config/area_registry/update", { area_id: AREA, name: originalAreaName });
    }
}

/** The label of the configured tile, as the card renders it. */
function tileLabel(target: CardHandle): Promise<string> {
    return target.evaluate(
        element =>
            (
                element.shadowRoot?.querySelector(".tile-renamed-wrapper .tile-title") as HTMLElement | null
            )?.textContent?.trim() ?? "",
    );
}

/** The icon of the generated `filter_left` tile, read from the element the card rendered. */
function filterTileIcon(target: CardHandle): Promise<string | null> {
    return target.evaluate(element => {
        const icon = element.shadowRoot?.querySelector(".tile-filter_left-wrapper ha-state-icon") as
            | (HTMLElement & { icon?: string | null })
            | null;
        return icon?.icon ?? null;
    });
}

/** The name Home Assistant's own frontend would show for this entity. */
function haDisplayName(page: Page, entityId: string): Promise<string> {
    return page.evaluate(id => {
        const hass = (document.querySelector("home-assistant") as any).hass;
        return String(hass.formatEntityName(hass.states[id], undefined));
    }, entityId);
}

test.describe("registry renames reach the card without a reload", () => {
    let originalAreaName: string | undefined;

    test.beforeEach(async ({ loggedIn: page }) => {
        // The fake vacuum polls its state every two seconds; a poll renders the card on its own and
        // would make a stale label look fresh. Nothing but a registry change may update it here.
        await configure(0).catch(() => undefined);
        const areas = await wsSend<{ area_id: string; name: string }[]>("config/area_registry/list");
        originalAreaName = areas.find(area => area.area_id === AREA)?.name;
        await openDashboard(page, "/e2e-renames/renames");
        await waitForCard(page);
        await page.evaluate(() => {
            (window as any).__renameMarker = true;
        });
    });

    test.afterEach(async () => {
        await restore(originalAreaName);
        await configure(2).catch(() => undefined);
    });

    test("an entity, device and area rename update the tile label", async ({ loggedIn: page }) => {
        const target = await card(page);
        const initial = await haDisplayName(page, VACUUM);
        await expect.poll(() => tileLabel(target)).toBe(initial);

        // The entity rename is what the entity settings dialog sends.
        await wsSend("config/entity_registry/update", { entity_id: VACUUM, name: RENAMED_ENTITY });
        await expect.poll(() => haDisplayName(page, VACUUM)).toContain(RENAMED_ENTITY);
        await expect.poll(() => tileLabel(target)).toBe(await haDisplayName(page, VACUUM));
        expect(await tileLabel(target)).not.toBe(initial);

        // A device rename changes the name part Home Assistant puts in front of the entity name.
        const entry = await entityEntry(VACUUM);
        await wsSend("config/device_registry/update", { device_id: entry.device_id, name_by_user: RENAMED_DEVICE });
        await expect.poll(() => haDisplayName(page, VACUUM)).toContain(RENAMED_DEVICE);
        await expect.poll(() => tileLabel(target)).toBe(await haDisplayName(page, VACUUM));
        expect(await tileLabel(target)).toContain(RENAMED_DEVICE);

        // Moving the entity to an area and renaming that area: the label must keep matching what
        // Home Assistant shows, and the card must not reload to do it.
        await wsSend("config/entity_registry/update", { entity_id: VACUUM, area_id: AREA });
        await expect.poll(() => tileLabel(target)).toBe(await haDisplayName(page, VACUUM));

        await wsSend("config/area_registry/update", { area_id: AREA, name: "Renamed kitchen" });
        await expect.poll(() => haDisplayName(page, VACUUM)).not.toBe("");
        await expect.poll(() => tileLabel(target)).toBe(await haDisplayName(page, VACUUM));

        // No reload: the same card element is still on screen and the page kept its marker.
        expect(await page.evaluate(() => (window as any).__renameMarker)).toBe(true);
        expect(await target.evaluate(element => element.isConnected)).toBe(true);
        await shot(page, "18-renamed-tile");
    });

    test("a registry icon change reaches a generated tile without a reload", async ({ loggedIn: page }) => {
        const target = await card(page);
        // The fixture sensor has no icon of its own yet, so the tile has none either.
        expect(await filterTileIcon(target)).toBeNull();

        await wsSend("config/entity_registry/update", { entity_id: SENSOR, icon: "mdi:air-filter" });
        await expect.poll(() => filterTileIcon(target)).toBe("mdi:air-filter");

        // A second change, with no reload in between: the model that was cached for the first icon
        // must not be served again.
        await wsSend("config/entity_registry/update", { entity_id: SENSOR, icon: "mdi:water" });
        await expect.poll(() => filterTileIcon(target)).toBe("mdi:water");

        expect(await page.evaluate(() => (window as any).__renameMarker)).toBe(true);
        expect(await target.evaluate(element => element.isConnected)).toBe(true);
        await shot(page, "18-renamed-icon");
    });
});
