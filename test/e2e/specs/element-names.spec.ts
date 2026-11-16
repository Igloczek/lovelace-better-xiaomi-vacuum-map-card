import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { login, shot, waitForCard, waitForHaReady, wsSend } from "./helpers";

/**
 * The fork registers `better-xiaomi-vacuum-map-card` so it can be installed next to the upstream
 * card. The upstream name stays as an alias, but only while the upstream bundle is absent: defining
 * it with upstream loaded would make upstream's own `customElements.define` throw, and copying the
 * upstream-named storage keys would hand this card the upstream card's saved view and run.
 *
 * `test/e2e/fetch-upstream.cjs` downloads the pinned upstream release (v2.4.1, sha256 checked) and
 * installs it at the two locations a real installation leaves it:
 *
 * - the HACS repository folder, `www/community/lovelace-xiaomi-vacuum-map-card/`. Home Assistant
 *   2026.11 no longer serves the `/hacsfiles/` prefix HACS registered, so the surviving file is
 *   loaded from its `/local/community/<repository>/` URL (the one the Marketplace migration writes);
 * - a manual install in `www/`, loaded from `/local/xiaomi-vacuum-map-card.js`.
 *
 * Every mixed test runs against both, in both resource orders. Home Assistant appends every
 * resource's script before any of them runs, so the fork sees the upstream script before it
 * decides, in either order.
 */

const FORK_MARKER = "lovelace-better-xiaomi-vacuum-map-card";
const FORK_TAG = "better-xiaomi-vacuum-map-card";
const LEGACY_TAG = "xiaomi-vacuum-map-card";

/** The pinned upstream build; `fetch-upstream.cjs` owns the download and holds the same pin. */
const UPSTREAM_VERSION = "v2.4.1";
const UPSTREAM_SHA256 = "6eb544c670480607c75d82321bb5d1932c781098c1f34391084ecefcac23d445";
const UPSTREAM_CACHE = path.join(__dirname, "..", ".cache", `upstream-${UPSTREAM_VERSION}.js`);
const WWW = path.join(__dirname, "..", "ha", "config", "www");

/**
 * The two real layouts. The HACS folder is also this fork's pre-rename Marketplace path, which is
 * why the bundle must be recognised by what it registers, never by a path.
 */
const UPSTREAM_INSTALLS = [
    {
        name: "hacs-folder",
        url: `/local/community/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js?v=${UPSTREAM_VERSION.slice(1)}`,
        file: path.join(WWW, "community", "lovelace-xiaomi-vacuum-map-card", "xiaomi-vacuum-map-card.js"),
    },
    {
        name: "manual-local",
        url: `/local/xiaomi-vacuum-map-card.js?v=${UPSTREAM_VERSION.slice(1)}`,
        file: path.join(WWW, "xiaomi-vacuum-map-card.js"),
    },
] as const;
type UpstreamInstall = (typeof UPSTREAM_INSTALLS)[number];

/** The fork's own Marketplace folder, created before the rename: upstream's path word for word. */
const OLD_PATH_URL = "/local/community/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js";
const OLD_PATH_FILE = UPSTREAM_INSTALLS[0].file;
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
        resource.url.startsWith(OLD_PATH_URL) ||
        resource.url.startsWith(UPSTREAM_INSTALLS[1].url.split("?")[0])
    );
}

/**
 * Copies the pinned release from the ignored cache to the install locations named. The cache is
 * written by `fetch-upstream.cjs`; the digest is checked again here, so a corrupted or swapped file
 * fails the spec instead of silently testing another build.
 */
function installUpstreamBundles(...names: Array<UpstreamInstall["name"]>): void {
    if (!fs.existsSync(UPSTREAM_CACHE)) {
        throw new Error(`missing ${UPSTREAM_CACHE}; run node test/e2e/fetch-upstream.cjs`);
    }
    const digest = createHash("sha256").update(fs.readFileSync(UPSTREAM_CACHE)).digest("hex");
    if (digest !== UPSTREAM_SHA256) {
        throw new Error(
            `the cached upstream bundle is not ${UPSTREAM_VERSION} (sha256 ${digest}); ` +
                "run node test/e2e/fetch-upstream.cjs --refresh",
        );
    }
    for (const install of UPSTREAM_INSTALLS) {
        if (names.length > 0 && !names.includes(install.name)) continue;
        fs.mkdirSync(path.dirname(install.file), { recursive: true });
        fs.copyFileSync(UPSTREAM_CACHE, install.file);
    }
}

/** Removes the upstream copies; the fork's own installed bundle stays where the installer put it. */
function removeUpstreamBundles(): void {
    for (const install of UPSTREAM_INSTALLS) fs.rmSync(install.file, { force: true });
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

const INSTALLED_URL = "/local/community/lovelace-better-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js";

function knownForkResourceUrl(): string {
    // The installer's URL when a card row was seen, otherwise the installed path itself: a failed
    // run must not leave the suite unable to restore the resource it needs.
    return forkResourceUrl ?? `${INSTALLED_URL}?v=e2e-side-by-side`;
}

/**
 * Replaces every card resource row with exactly these URLs, in this order. A `"fork"` entry is this
 * card's installed URL, resolved after the lookup so it can be restored after a test replaced it.
 */
async function setCardResources(urls: Array<string | "fork">): Promise<void> {
    const resources = await wsSend<Resource[]>("lovelace/resources");
    const fork = resources.find(resource => resource.url.includes(FORK_MARKER));
    if (fork) forkResourceUrl = fork.url;
    const resolved = urls.map(url => (url === "fork" ? knownForkResourceUrl() : url));
    for (const resource of resources) {
        if (isCardResource(resource)) {
            await wsSend("lovelace/resources/delete", { resource_id: resource.id });
        }
    }
    for (const url of resolved) {
        await wsSend("lovelace/resources/create", { res_type: "module", url });
    }
}

/** Registers the fork and the upstream card, in exactly this resource order. */
async function setCardResourceOrder(upstreamUrl: string, order: Array<"fork" | "upstream">): Promise<void> {
    await setCardResources(order.map(kind => (kind === "fork" ? "fork" : upstreamUrl)));
}

async function keepOnlyTheForkResource(): Promise<void> {
    await setCardResources(["fork"]);
}

function recordRegistrationErrors(page: import("@playwright/test").Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", error => {
        if (/customElements|already been used|define/i.test(error.message)) errors.push(error.message);
    });
    page.on("console", message => {
        const text = message.text();
        if (message.type() === "error" && /customElements|already been used|define/i.test(text)) errors.push(text);
        // The fork explains the one failure it can see but not prevent: it took the legacy name
        // before a bundle it could not judge tried to register it. Seeing that warning means the
        // decision went the wrong way, even though nothing threw.
        if (message.type() === "warning" && text.includes("Better Xiaomi Vacuum Map Card:")) errors.push(text);
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

/**
 * Proves the rendered `custom:xiaomi-vacuum-map-card` is the upstream implementation, not the
 * fork's alias.
 *
 * `instanceof` is exact: the alias is a subclass of the fork's class, so an aliased card would be
 * an instance of it. An upstream card is not.
 */
async function expectLegacyOwnedByUpstream(page: import("@playwright/test").Page): Promise<void> {
    const ownership = await page
        .locator(LEGACY_TAG)
        .first()
        .evaluate(
            (element: any, tags: { legacy: string; fork: string }) => {
                const legacy = customElements.get(tags.legacy) as CustomElementConstructor | undefined;
                const fork = customElements.get(tags.fork) as CustomElementConstructor | undefined;
                return {
                    legacyDefined: !!legacy,
                    forkDefined: !!fork,
                    legacyIsForkAlias: !!legacy && !!fork && Object.getPrototypeOf(legacy) === fork,
                    elementIsFork: !!fork && element instanceof fork,
                };
            },
            { legacy: LEGACY_TAG, fork: FORK_TAG },
        );
    expect(ownership).toEqual({
        legacyDefined: true,
        forkDefined: true,
        legacyIsForkAlias: false,
        elementIsFork: false,
    });
}

/** The card with the fork's own type must be the fork's class, not another bundle's. */
async function expectForkCardIsFork(page: import("@playwright/test").Page): Promise<void> {
    const isFork = await page
        .locator(FORK_TAG)
        .first()
        .evaluate(
            (element: any, forkTag: string) =>
                element instanceof (customElements.get(forkTag) as CustomElementConstructor),
            FORK_TAG,
        );
    expect(isFork).toBe(true);
}

/** A card whose type resolves to nothing shows Home Assistant's error card instead. */
async function expectNoErrorCard(page: import("@playwright/test").Page): Promise<void> {
    await expect(page.locator("hui-error-card")).toHaveCount(0);
}

test.describe("custom element names", () => {
    test.describe.configure({ mode: "serial" });

    test.afterAll(async () => {
        removeUpstreamBundles();
        removeOldPathBundle();
        await keepOnlyTheForkResource();
    });

    test("renders a card with the fork's own type", async ({ page }) => {
        await keepOnlyTheForkResource();
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

    test("serves this card from upstream's path without waiting on itself", async ({ page }) => {
        // The real production layout: the Marketplace folder predates the repository rename, so the
        // only card resource is `/local/community/lovelace-xiaomi-vacuum-map-card/...`, which is
        // upstream's path and this card's own URL at the same time. No upstream bundle is loaded.
        removeUpstreamBundles();
        installOldPathBundle();
        await setCardResources([`${OLD_PATH_URL}?v=e2e-old-path`]);
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
        await setCardResources(["fork", `${OLD_PATH_URL}?v=e2e-dead-row`]);
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

test.describe("side by side with the upstream card", () => {
    test.describe.configure({ mode: "serial" });

    test.afterAll(async () => {
        removeUpstreamBundles();
        await keepOnlyTheForkResource();
    });

    for (const install of UPSTREAM_INSTALLS) {
        for (const order of [
            ["fork", "upstream"],
            ["upstream", "fork"],
        ] as const) {
            test(`loads both cards from the ${install.name} install with the ${order.join("-then-")} order`, async ({
                page,
            }) => {
                installUpstreamBundles(install.name);
                await setCardResourceOrder(install.url, [...order]);
                const errors = recordRegistrationErrors(page);

                await login(page);
                await page.goto("/e2e-element-names/mixed");
                await waitForHaReady(page);
                await expectCardRendered(page, FORK_TAG);
                await expectCardRendered(page, LEGACY_TAG);
                // Upstream owns the legacy name here: the fork must have left it alone.
                await expectLegacyOwnedByUpstream(page);
                await expectForkCardIsFork(page);
                // Neither card fell back to Home Assistant's error card.
                await expectNoErrorCard(page);
                expect(errors).toEqual([]);
                await shot(page, `42-element-names-${install.name}-${order.join("-then-")}`);
            });
        }
    }

    test("keeps the fork's own type when the upstream card is installed", async ({ page }) => {
        installUpstreamBundles("hacs-folder");
        await setCardResourceOrder(UPSTREAM_INSTALLS[0].url, ["upstream", "fork"]);
        const errors = recordRegistrationErrors(page);
        await login(page);
        await page.goto("/e2e-element-names/new");
        await waitForHaReady(page);
        await expectCardRendered(page, FORK_TAG);
        await expectNoErrorCard(page);
        expect(errors).toEqual([]);
    });

    test("keeps the upstream type when this card is served from the old path", async ({ page }) => {
        // The pre-rename Marketplace install: this card's own URL is upstream's historical path
        // word for word. With a manual upstream copy also installed, the fork must still recognise
        // the other resource as upstream and leave it the legacy name.
        removeUpstreamBundles();
        installOldPathBundle();
        installUpstreamBundles("manual-local");
        await setCardResources([`${OLD_PATH_URL}?v=e2e-old-path-mixed`, UPSTREAM_INSTALLS[1].url]);
        const errors = recordRegistrationErrors(page);

        await login(page);
        await page.goto("/e2e-element-names/mixed");
        await waitForHaReady(page);
        await expectCardRendered(page, FORK_TAG);
        await expectCardRendered(page, LEGACY_TAG);
        await expectLegacyOwnedByUpstream(page);
        await expectForkCardIsFork(page);
        await expectNoErrorCard(page);
        expect(errors).toEqual([]);
        await shot(page, "45-element-names-old-path-with-upstream");
    });

    for (const order of [
        ["upstream", "fork"],
        ["fork", "upstream"],
    ] as const) {
        test(`leaves the upstream card's stored view and run in its own keys (${order.join("-then-")})`, async ({
            page,
        }) => {
            installUpstreamBundles("hacs-folder");
            await setCardResourceOrder(UPSTREAM_INSTALLS[0].url, [...order]);
            const errors = recordRegistrationErrors(page);
            const viewKey = "card-e2e-upstream-state";
            const legacyView = { [viewKey]: { s: 2, x: 12, y: 34, r: 0, ts: 1 } };
            const legacyRun = {
                "vacuum.fake_vacuum": { entity: "vacuum.fake_vacuum", roomIds: ["16"], startedAt: 1, seenActive: true },
            };

            await login(page);
            await page.addInitScript(
                value => {
                    window.localStorage.setItem("xiaomi-vacuum-map-card.map-view", JSON.stringify(value.view));
                    window.localStorage.setItem("xiaomi-vacuum-map-card.active-room-run", JSON.stringify(value.run));
                },
                { view: legacyView, run: legacyRun },
            );
            await page.goto("/e2e-element-names/mixed");
            await waitForHaReady(page);
            await expectCardRendered(page, LEGACY_TAG);
            await expectCardRendered(page, FORK_TAG);

            // A rendered card does not mean the alias decision has settled; wait for the marker it
            // writes when upstream owns the name before reading the storage it must leave alone.
            await expect
                .poll(() =>
                    page.evaluate(() => window.localStorage.getItem("better-xiaomi-vacuum-map-card.upstream-seen")),
                )
                .toBe("1");

            const stored = await page.evaluate(() => ({
                legacyView: window.localStorage.getItem("xiaomi-vacuum-map-card.map-view"),
                legacyRun: window.localStorage.getItem("xiaomi-vacuum-map-card.active-room-run"),
                forkView: window.localStorage.getItem("better-xiaomi-vacuum-map-card.map-view"),
                forkRun: window.localStorage.getItem("better-xiaomi-vacuum-map-card.active-room-run"),
                migrated: window.localStorage.getItem("better-xiaomi-vacuum-map-card.storage-migrated"),
                upstreamSeen: window.localStorage.getItem("better-xiaomi-vacuum-map-card.upstream-seen"),
            }));

            // Untouched: the upstream card keeps using its own keys.
            expect(JSON.parse(stored.legacyView ?? "{}")).toHaveProperty([viewKey]);
            expect(JSON.parse(stored.legacyRun ?? "{}")).toEqual(legacyRun);
            // Never copied, and the one-shot migration never marked itself done. The fork's own card
            // on this page may store its own view, but nothing under its key may be upstream's state.
            expect(stored.forkView ?? "").not.toContain(viewKey);
            expect(stored.forkRun ?? "").not.toContain("vacuum.fake_vacuum");
            expect(stored.migrated).toBeNull();
            // The browser now remembers that the legacy name and keys belong to the upstream card.
            expect(stored.upstreamSeen).toBe("1");
            expect(errors).toEqual([]);
        });
    }
});

test.describe("legacy storage keys", () => {
    test.afterAll(async () => {
        removeUpstreamBundles();
        await keepOnlyTheForkResource();
    });

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
