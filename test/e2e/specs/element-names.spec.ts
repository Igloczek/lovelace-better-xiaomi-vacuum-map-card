import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

import { login, shot, waitForCard, waitForHaReady, wsSend } from "./helpers";

/**
 * The fork registers `better-xiaomi-vacuum-map-card` so it can be installed next to the upstream
 * card. The upstream name stays as an alias, but only while the upstream bundle is absent: defining
 * it with upstream loaded would make upstream's own `customElements.define` throw.
 *
 * The suite installs the upstream release bundle as a second Lovelace resource and proves both
 * orders: Home Assistant appends every resource's script before any of them runs, so the fork sees
 * upstream before it decides, in either order.
 */

const FORK_MARKER = "lovelace-better-xiaomi-vacuum-map-card";
const UPSTREAM_FILE = path.join(__dirname, "..", "ha", "config", "www", "upstream", "xiaomi-vacuum-map-card.js");
const UPSTREAM_URL = "/local/upstream/xiaomi-vacuum-map-card.js?v=2.4.1";
const UPSTREAM_RELEASE =
    "https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card/releases/download/v2.4.1/xiaomi-vacuum-map-card.js";
const FORK_TAG = "better-xiaomi-vacuum-map-card";
const LEGACY_TAG = "xiaomi-vacuum-map-card";
/**
 * The fork's own Marketplace folder, created before the repository rename: the fork is served from
 * upstream's path word for word. The suite proves that this is recognised as the fork itself.
 */
const OLD_PATH_URL = "/local/community/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js";
const OLD_PATH_FILE = path.join(
    __dirname,
    "..",
    "ha",
    "config",
    "www",
    "community",
    "lovelace-xiaomi-vacuum-map-card",
    "xiaomi-vacuum-map-card.js",
);
const INSTALLED_FILE = path.join(
    __dirname,
    "..",
    "ha",
    "config",
    "www",
    "community",
    "lovelace-better-xiaomi-vacuum-map-card",
    "xiaomi-vacuum-map-card.js",
);
const BUILT_FILE = path.join(__dirname, "..", "..", "dist", "xiaomi-vacuum-map-card.js");

interface Resource {
    id: string;
    type: string;
    url: string;
}

let forkResourceUrl: string | undefined;

function isCardResource(resource: Resource): boolean {
    return (
        resource.url.includes(FORK_MARKER) ||
        resource.url.startsWith("/local/upstream/xiaomi-vacuum-map-card.js") ||
        resource.url.startsWith(OLD_PATH_URL)
    );
}

/** Copies the branch build to the pre-rename folder, so it is served from upstream's own path. */
function installOldPathBundle(): void {
    const source = fs.existsSync(INSTALLED_FILE) ? INSTALLED_FILE : BUILT_FILE;
    if (!fs.existsSync(source)) throw new Error(`missing ${source}; run npm run build and the installer steps`);
    fs.mkdirSync(path.dirname(OLD_PATH_FILE), { recursive: true });
    fs.copyFileSync(source, OLD_PATH_FILE);
}

/** Deletes that copy, so a resource row at the old path is a dead row that 404s. */
function removeOldPathBundle(): void {
    fs.rmSync(OLD_PATH_FILE, { force: true });
}

/** Registers exactly one card resource, at the given URL. */
async function setOnlyCardResource(url: string): Promise<void> {
    const resources = await wsSend<Resource[]>("lovelace/resources");
    const fork = resources.find(resource => resource.url.includes(FORK_MARKER));
    if (fork) forkResourceUrl = fork.url;
    for (const resource of resources) {
        if (isCardResource(resource)) {
            await wsSend("lovelace/resources/delete", { resource_id: resource.id });
        }
    }
    await wsSend("lovelace/resources/create", { res_type: "module", url });
}

/** Deletes the card resources and registers the fork's installed URL plus one extra resource. */
async function setForkResourcePlus(url: string): Promise<void> {
    const resources = await wsSend<Resource[]>("lovelace/resources");
    const fork = resources.find(resource => resource.url.includes(FORK_MARKER));
    if (fork) forkResourceUrl = fork.url;
    if (!forkResourceUrl) throw new Error("the fork's Lovelace resource is missing; run marketplace-install.cjs");
    for (const resource of resources) {
        if (isCardResource(resource)) {
            await wsSend("lovelace/resources/delete", { resource_id: resource.id });
        }
    }
    await wsSend("lovelace/resources/create", { res_type: "module", url: forkResourceUrl });
    await wsSend("lovelace/resources/create", { res_type: "module", url });
}

/**
 * Downloads the upstream release into the instance's `www/`, which Home Assistant serves at
 * `/local/`. The file is not committed: it is upstream's build, fetched for this test.
 */
async function ensureUpstreamBundle(): Promise<void> {
    if (fs.existsSync(UPSTREAM_FILE) && fs.statSync(UPSTREAM_FILE).size > 100_000) return;
    const response = await fetch(UPSTREAM_RELEASE);
    if (!response.ok) throw new Error(`could not download the upstream card: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100_000) throw new Error(`the upstream download is too small: ${bytes.length} bytes`);
    fs.mkdirSync(path.dirname(UPSTREAM_FILE), { recursive: true });
    fs.writeFileSync(UPSTREAM_FILE, bytes);
}

/** Registers the card resources in exactly this order, keeping the fork's installed URL. */
async function setCardResourceOrder(order: Array<"fork" | "upstream">): Promise<void> {
    const resources = await wsSend<Resource[]>("lovelace/resources");
    const fork = resources.find(resource => resource.url.includes(FORK_MARKER));
    if (!fork) throw new Error("the fork's Lovelace resource is missing; run marketplace-install.cjs");
    forkResourceUrl = fork.url;
    for (const resource of resources) {
        if (isCardResource(resource)) {
            await wsSend("lovelace/resources/delete", { resource_id: resource.id });
        }
    }
    for (const kind of order) {
        await wsSend("lovelace/resources/create", {
            res_type: "module",
            url: kind === "fork" ? fork.url : UPSTREAM_URL,
        });
    }
}

async function keepOnlyTheForkResource(): Promise<void> {
    const resources = await wsSend<Resource[]>("lovelace/resources");
    const fork = resources.find(resource => resource.url.includes(FORK_MARKER));
    if (!fork && !forkResourceUrl) throw new Error("the fork's Lovelace resource is missing");
    const url = fork?.url ?? forkResourceUrl!;
    const upstream = resources.filter(
        resource => isCardResource(resource) && resource.url.startsWith("/local/upstream/xiaomi-vacuum-map-card.js"),
    );
    for (const resource of upstream) await wsSend("lovelace/resources/delete", { resource_id: resource.id });
    if (!fork) {
        await wsSend("lovelace/resources/create", { res_type: "module", url });
    }
}

function recordRegistrationErrors(page: import("@playwright/test").Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", error => {
        if (/customElements|already been used|define/i.test(error.message)) errors.push(error.message);
    });
    page.on("console", message => {
        const text = message.text();
        if (message.type() === "error" && /customElements|already been used|define/i.test(text)) errors.push(text);
    });
    return errors;
}

async function expectCardRendered(page: import("@playwright/test").Page, tag: string): Promise<void> {
    await waitForCard(page, tag);
    const rendered = await page
        .locator(tag)
        .first()
        .evaluate((element: any) => ({
            hasCard: !!element.shadowRoot?.querySelector("ha-card"),
            hasMap: !!element.shadowRoot?.querySelector("#map-image, #map-image-source"),
            hasHass: !!element.hass,
        }));
    expect(rendered).toEqual({ hasCard: true, hasMap: true, hasHass: true });
}

test.describe("custom element names", () => {
    test.describe.configure({ mode: "serial" });

    test.afterAll(async () => {
        removeOldPathBundle();
        await keepOnlyTheForkResource();
    });

    test("renders a card with the fork's own type", async ({ page }) => {
        await login(page);
        await page.goto("/e2e-element-names/new");
        await waitForHaReady(page);
        await expectCardRendered(page, FORK_TAG);
        await shot(page, "40-element-name-new-type");
    });

    test("renders the upstream type through the alias while upstream is absent", async ({ page }) => {
        await keepOnlyTheForkResource();
        await login(page);
        await page.goto("/e2e-element-names/legacy");
        await waitForHaReady(page);
        await expectCardRendered(page, LEGACY_TAG);
        const isAlias = await page.evaluate(
            (tags: { legacy: string; fork: string }) => {
                const legacy = customElements.get(tags.legacy);
                const fork = customElements.get(tags.fork);
                return !!legacy && !!fork && Object.getPrototypeOf(legacy) === fork;
            },
            { legacy: LEGACY_TAG, fork: FORK_TAG },
        );
        expect(isAlias).toBe(true);
        await shot(page, "41-element-name-legacy-alias");
    });

    for (const order of [
        ["fork", "upstream"],
        ["upstream", "fork"],
    ] as const) {
        test(`loads the fork and the upstream card with the ${order.join("-then-")} order`, async ({ page }) => {
            await ensureUpstreamBundle();
            await setCardResourceOrder([...order]);
            const errors = recordRegistrationErrors(page);

            await login(page);
            await page.goto("/e2e-element-names/mixed");
            await waitForHaReady(page);
            await expectCardRendered(page, FORK_TAG);
            await expectCardRendered(page, LEGACY_TAG);

            // Upstream owns the legacy name here: the fork must have left it alone.
            const legacyIsUpstream = await page.evaluate(
                (tags: { legacy: string; fork: string }) => {
                    const legacy = customElements.get(tags.legacy);
                    const fork = customElements.get(tags.fork);
                    return {
                        defined: !!legacy,
                        isForkAlias: !!legacy && !!fork && Object.getPrototypeOf(legacy) === fork,
                    };
                },
                { legacy: LEGACY_TAG, fork: FORK_TAG },
            );
            expect(legacyIsUpstream).toEqual({ defined: true, isForkAlias: false });
            expect(errors).toEqual([]);
            await shot(page, `42-element-names-${order.join("-then-")}`);
        });
    }

    test("keeps the fork's own type when the upstream card is installed", async ({ page }) => {
        await ensureUpstreamBundle();
        await setCardResourceOrder(["upstream", "fork"]);
        const errors = recordRegistrationErrors(page);
        await login(page);
        await page.goto("/e2e-element-names/new");
        await waitForHaReady(page);
        await expectCardRendered(page, FORK_TAG);
        expect(errors).toEqual([]);
    });

    test("serves this card from upstream's path without waiting on itself", async ({ page }) => {
        // The real production layout: the Marketplace folder predates the repository rename, so the
        // only card resource is `/local/community/lovelace-xiaomi-vacuum-map-card/...`, which is
        // upstream's path and this card's own URL at the same time. No upstream bundle is loaded.
        installOldPathBundle();
        await setOnlyCardResource(`${OLD_PATH_URL}?v=e2e-old-path`);
        const errors = recordRegistrationErrors(page);
        const storedView = { "card-e2e-old-path": { s: 2, x: 5, y: 6, r: 0, ts: 1 } };

        await login(page);
        await page.addInitScript(value => {
            window.localStorage.setItem("xiaomi-vacuum-map-card.map-view", JSON.stringify(value));
        }, storedView);
        await page.goto("/e2e-element-names/legacy");
        await waitForHaReady(page);
        await expectCardRendered(page, LEGACY_TAG);

        const migrated = await page.evaluate(() => ({
            view: window.localStorage.getItem("better-xiaomi-vacuum-map-card.map-view"),
            isAlias: (() => {
                const legacy = customElements.get("xiaomi-vacuum-map-card");
                const fork = customElements.get("better-xiaomi-vacuum-map-card");
                return !!legacy && !!fork && Object.getPrototypeOf(legacy) === fork;
            })(),
        }));
        expect(migrated.isAlias).toBe(true);
        expect(JSON.parse(migrated.view ?? "{}")).toHaveProperty(["card-e2e-old-path"]);
        expect(errors).toEqual([]);
        await shot(page, "43-element-name-old-path");
    });

    test("renders the legacy type next to a dead resource row at the old path", async ({ page }) => {
        // The upgrade state from the rename: a resource row still points at the pre-rename path, the
        // installer deleted that file, and the working file is the fork's. The 404 must not stop the
        // alias: it is evidence that nothing can register upstream's name.
        removeOldPathBundle();
        await setForkResourcePlus(`${OLD_PATH_URL}?v=e2e-dead-row`);
        const errors = recordRegistrationErrors(page);

        await login(page);
        const status = await page.request.get(`${OLD_PATH_URL}?v=e2e-dead-row`);
        expect(status.status(), "the old path must really 404 for this test to mean anything").toBe(404);
        await page.goto("/e2e-element-names/legacy");
        await waitForHaReady(page);
        await expectCardRendered(page, LEGACY_TAG);

        const isAlias = await page.evaluate(
            (tags: { legacy: string; fork: string }) => {
                const legacy = customElements.get(tags.legacy);
                const fork = customElements.get(tags.fork);
                return !!legacy && !!fork && Object.getPrototypeOf(legacy) === fork;
            },
            { legacy: LEGACY_TAG, fork: FORK_TAG },
        );
        expect(isAlias).toBe(true);
        expect(errors).toEqual([]);
        await shot(page, "44-element-name-dead-row");
    });
});

test.describe("legacy storage keys", () => {
    test("migrates a view stored under the upstream key when the fork is alone", async ({ page }) => {
        await keepOnlyTheForkResource();
        await login(page);
        const key = "card-e2e-alias";
        await page.addInitScript(
            value => {
                window.localStorage.setItem("xiaomi-vacuum-map-card.map-view", JSON.stringify(value));
            },
            { [key]: { s: 2, x: 12, y: 34, r: 0, ts: 1 } },
        );
        await page.goto("/e2e-element-names/new");
        await waitForHaReady(page);
        await waitForCard(page, FORK_TAG);
        const migrated = await page.evaluate(() => ({
            view: window.localStorage.getItem("better-xiaomi-vacuum-map-card.map-view"),
            legacy: window.localStorage.getItem("xiaomi-vacuum-map-card.map-view"),
        }));
        expect(JSON.parse(migrated.view ?? "{}")).toHaveProperty([key]);
        // The upstream key is kept: another card may still be using it.
        expect(JSON.parse(migrated.legacy ?? "{}")).toHaveProperty([key]);
    });
});
