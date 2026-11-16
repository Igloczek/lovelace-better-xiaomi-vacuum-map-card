import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { UPSTREAM_DEFINE_GRACE_MS } from "../../../src/card-element-names";
import pin from "../upstream-pin.json";
import { login, shot, waitForCard, waitForHaReady, wsSend } from "./helpers";

/**
 * The fork registers `better-xiaomi-vacuum-map-card` so it can be installed next to the upstream
 * card. The upstream name stays as an alias, but only while the upstream bundle is absent: defining
 * it with upstream loaded would make upstream's own `customElements.define` throw, and copying the
 * upstream-named storage keys would hand this card the upstream card's saved view and run.
 *
 * `test/e2e/fetch-upstream.cjs` downloads the pinned upstream release (`upstream-pin.json`, sha256
 * checked) and installs it at the two locations a real installation leaves it:
 *
 * - the HACS repository folder, `www/community/lovelace-xiaomi-vacuum-map-card/`. Home Assistant
 *   2026.11 no longer serves the `/hacsfiles/` prefix HACS registered, so the surviving file is
 *   loaded from its `/local/community/<repository>/` URL (the one the Marketplace migration writes);
 * - a manual install in `www/`, loaded from `/local/xiaomi-vacuum-map-card.js`.
 *
 * What the mixed tests prove, against the pinned bundle: with both installed, and with the fork
 * running first or upstream running first, both cards render, neither shows Home Assistant's error
 * card, nothing reports a define error, `custom:xiaomi-vacuum-map-card` is upstream's own class, and
 * the upstream card's stored view and run stay under its own keys. The order is forced rather than
 * left to the network: Home Assistant appends each resource as an async module, so the browser would
 * otherwise run them in download order. The second bundle's response is held until the first has
 * run, and the spec asserts the order the page recorded.
 *
 * What they do not prove: a bundle that defines the element late (a wrapper or a renamed build).
 * The pinned upstream defines the element as soon as it runs, so the fork's grace period after a
 * loaded candidate is never reached here. The mixed tests cover the fork waiting for a pending
 * upstream bundle; the timing test covers the fork not waiting on its own bundle.
 */

const FORK_MARKER = "lovelace-better-xiaomi-vacuum-map-card";
const FORK_TAG = "better-xiaomi-vacuum-map-card";
const FORK_EDITOR_TAG = "better-xiaomi-vacuum-map-card-editor";
const LEGACY_TAG = "xiaomi-vacuum-map-card";
const LEGACY_VIEW_KEY = "xiaomi-vacuum-map-card.map-view";
const LEGACY_RUN_KEY = "xiaomi-vacuum-map-card.active-room-run";
const FORK_VIEW_KEY = "better-xiaomi-vacuum-map-card.map-view";
const FORK_RUN_KEY = "better-xiaomi-vacuum-map-card.active-room-run";
const FORK_MIGRATED_KEY = "better-xiaomi-vacuum-map-card.storage-migrated";
const FORK_UPSTREAM_SEEN_KEY = "better-xiaomi-vacuum-map-card.upstream-seen";
/** A define collision: the browser's message for a name that is already taken in the registry. */
const REGISTRATION_ERROR = /customElements|CustomElementRegistry|already been (?:used|defined)/;

/** The pinned upstream build. `fetch-upstream.cjs` reads the same `upstream-pin.json`. */
const UPSTREAM_VERSION = pin.version;
const UPSTREAM_SHA256 = pin.sha256;
const UPSTREAM_CACHE = path.join(__dirname, "..", pin.cache);
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
const INSTALLED_URL = "/local/community/lovelace-better-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js";
const INSTALLED_FILE = path.join(
    WWW,
    "community",
    "lovelace-better-xiaomi-vacuum-map-card",
    "xiaomi-vacuum-map-card.js",
);
const BUILT_FILE = path.join(__dirname, "..", "..", "..", "dist", "xiaomi-vacuum-map-card.js");

/** The path of a resource URL without its cache-buster: what the page reports for a loaded script. */
function pathOf(url: string): string {
    return new URL(url, "http://localhost").pathname;
}

interface Resource {
    id: string;
    type: string;
    url: string;
}

interface BundlePaths {
    fork: string;
    upstream: string;
}

type BundleName = keyof BundlePaths;

const other = (bundle: BundleName): BundleName => (bundle === "fork" ? "upstream" : "fork");

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

function knownForkResourceUrl(): string {
    if (forkResourceUrl !== undefined) return forkResourceUrl;
    // A restarted worker forgets the URL after a test replaced the fork's row; the installed file is
    // still there, so restore its row instead of failing every later test.
    if (fs.existsSync(INSTALLED_FILE)) {
        console.warn(`the fork's resource row is gone; restoring it at ${INSTALLED_URL}`);
        return `${INSTALLED_URL}?v=e2e-side-by-side`;
    }
    throw new Error("the fork's Lovelace resource is missing; run node test/e2e/marketplace-install.cjs");
}

/**
 * Replaces every card resource row with exactly these URLs, in this order. A `"fork"` entry is this
 * card's installed URL, remembered from the first lookup so it can be restored after a test replaced
 * it.
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

/** Registers the fork and the upstream card as resource rows, in exactly this order. */
async function setCardResourceOrder(upstreamUrl: string, order: BundleName[]): Promise<void> {
    await setCardResources(order.map(kind => (kind === "fork" ? "fork" : upstreamUrl)));
}

async function keepOnlyTheForkResource(): Promise<void> {
    await setCardResources(["fork"]);
}

function recordRegistrationErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", error => {
        if (REGISTRATION_ERROR.test(error.message)) errors.push(error.message);
    });
    page.on("console", message => {
        const text = message.text();
        if (message.type() === "error" && REGISTRATION_ERROR.test(text)) errors.push(text);
        // The fork explains the one failure it can see but not prevent: it took the legacy name
        // before a bundle it could not judge tried to register it. Seeing that warning means the
        // decision went the wrong way, even though nothing threw.
        if (message.type() === "warning" && text.includes("Better Xiaomi Vacuum Map Card:")) errors.push(text);
    });
    return errors;
}

async function expectCardRendered(page: Page, tag: string): Promise<void> {
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
async function expectLegacyOwnedByUpstream(page: Page): Promise<void> {
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

/**
 * Proves the card rendered for `tag` is the fork's own class. The fork's `getConfigElement()` names
 * the fork's editor, which only this bundle defines; upstream's class names `xiaomi-vacuum-map-card-editor`.
 * A card of the other bundle therefore fails this check, and `tag` lets a test point it at one.
 */
async function expectForkCardIsFork(page: Page, tag = FORK_TAG): Promise<void> {
    const editor = await page
        .locator(tag)
        .first()
        .evaluate(async (element: any) => {
            const config = await element.constructor.getConfigElement();
            return String(config?.localName);
        });
    expect(editor).toBe(FORK_EDITOR_TAG);
}

/** A card whose type resolves to nothing shows Home Assistant's error card instead. */
async function expectNoErrorCard(page: Page): Promise<void> {
    await expect(page.locator("hui-error-card")).toHaveCount(0);
}

/**
 * Seeds upstream-named storage before the first navigation of the page. The migration marks itself
 * done on the first bundle evaluation even when it copies nothing, and `login()` loads the dashboard,
 * so a seed made after it would be skipped. The seed is guarded by that marker: once the migration
 * has run, a later navigation never re-seeds the page over the state the migration produced.
 */
async function seedLegacyStorage(page: Page, entries: Record<string, string>): Promise<void> {
    await page.addInitScript(
        (input: { marker: string; entries: Record<string, string> }) => {
            try {
                if (window.localStorage.getItem(input.marker) !== null) return;
                for (const [key, value] of Object.entries(input.entries)) window.localStorage.setItem(key, value);
            } catch {
                // Blocked storage: the migration then has nothing to copy, and the test fails on that.
            }
        },
        { marker: FORK_MIGRATED_KEY, entries },
    );
}

async function readStoredJson(page: Page, key: string): Promise<Record<string, unknown>> {
    const raw = await page.evaluate(storageKey => window.localStorage.getItem(storageKey), key);
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
}

/**
 * Records, in the page, when the fork's bundle finished loading and when the legacy name was
 * defined. A module's `load` fires after it has run, so the gap is the time the fork spent deciding
 * the alias: about one task when nothing competes, the grace period when it waits on a candidate.
 */
async function recordAliasTiming(page: Page, bundlePath: string): Promise<void> {
    await page.addInitScript(
        (input: { bundlePath: string; legacy: string }) => {
            const timing: { bundleLoadedAt?: number; legacyDefinedAt?: number } = {};
            (window as any).__aliasTiming = timing;
            document.addEventListener(
                "load",
                event => {
                    const src = (event.target as HTMLScriptElement | null)?.src;
                    if (timing.bundleLoadedAt === undefined && src && new URL(src).pathname === input.bundlePath) {
                        timing.bundleLoadedAt = performance.now();
                    }
                },
                true,
            );
            customElements.whenDefined(input.legacy).then(() => {
                timing.legacyDefinedAt = performance.now();
            });
        },
        { bundlePath, legacy: LEGACY_TAG },
    );
}

/**
 * The alias was defined without the grace period. With nothing to wait for the alias follows the
 * bundle's load by about one task; a fork that waits out its own grace period defines it
 * `UPSTREAM_DEFINE_GRACE_MS` later. Half of that separates the two with room for a loaded CI machine.
 */
async function expectAliasWithoutGrace(page: Page): Promise<void> {
    const timing = await page.evaluate(
        () => (window as any).__aliasTiming as { bundleLoadedAt?: number; legacyDefinedAt?: number } | undefined,
    );
    expect(timing?.bundleLoadedAt, "the fork's bundle load was not recorded").toBeGreaterThan(0);
    expect(timing?.legacyDefinedAt, "the alias was never defined").toBeGreaterThan(0);
    const waited = (timing?.legacyDefinedAt ?? 0) - (timing?.bundleLoadedAt ?? 0);
    expect(waited, `the alias was defined ${waited.toFixed(0)} ms after the fork's bundle loaded`).toBeLessThan(
        UPSTREAM_DEFINE_GRACE_MS / 2,
    );
}

/**
 * Runs the two bundles in a fixed order. Home Assistant appends each resource as an async module, so
 * the browser runs them as their responses arrive, which is a race. The second bundle's response is
 * held until the first one has loaded (a module's `load` fires after it has run), so the order is
 * the test's. `expectRanInOrder` then checks the order the page recorded.
 */
async function holdSecondUntilFirstRuns(page: Page, first: BundleName, paths: BundlePaths): Promise<void> {
    const second = other(first);
    const firstPath = paths[first];
    const secondPath = paths[second];
    await page.addInitScript(
        (tracked: string[]) => {
            const loads: string[] = [];
            (window as any).__bundleLoads = loads;
            // A bundle that fails to load is recorded too, so the held one is released and the order
            // assertion names the failed bundle instead of the navigation timing out.
            for (const type of ["load", "error"]) {
                document.addEventListener(
                    type,
                    event => {
                        const src = (event.target as HTMLScriptElement | null)?.src;
                        if (!src) return;
                        const pathname = new URL(src).pathname;
                        if (tracked.includes(pathname)) loads.push(type === "load" ? pathname : `failed ${pathname}`);
                    },
                    true,
                );
            }
        },
        [paths.fork, paths.upstream],
    );
    await page.route(
        url => url.pathname === paths.fork || url.pathname === paths.upstream,
        async route => {
            const request = route.request();
            if (request.method() !== "GET" || pathOf(request.url()) !== secondPath) {
                await route.continue();
                return;
            }
            // Released when the first bundle ran or failed, and in any case before the navigation's
            // own 30 s timeout, so a stuck first bundle surfaces in expectRanInOrder.
            await page
                .waitForFunction(
                    (loaded: string) =>
                        ((window as any).__bundleLoads ?? []).some(
                            (entry: string) => entry === loaded || entry === `failed ${loaded}`,
                        ),
                    firstPath,
                    { timeout: 20_000 },
                )
                .catch(() => undefined);
            await route.continue().catch(() => undefined);
        },
    );
}

async function expectRanInOrder(page: Page, first: BundleName, paths: BundlePaths): Promise<void> {
    const loads = await page.evaluate(() => ((window as any).__bundleLoads ?? []) as string[]);
    const expected = first === "fork" ? [paths.fork, paths.upstream] : [paths.upstream, paths.fork];
    expect(loads, "the order the browser ran the two bundles in").toEqual(expected);
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
        await seedLegacyStorage(page, { [LEGACY_VIEW_KEY]: JSON.stringify(storedView) });
        await recordAliasTiming(page, pathOf(OLD_PATH_URL));

        await login(page);
        await page.goto("/e2e-element-names/legacy");
        await waitForHaReady(page);
        await expectCardRendered(page, LEGACY_TAG);
        await expectAliasWithoutGrace(page);

        const isAlias = await page.evaluate(
            (tags: { legacy: string; fork: string }) => {
                const legacy = customElements.get(tags.legacy);
                const fork = customElements.get(tags.fork);
                return !!legacy && !!fork && Object.getPrototypeOf(legacy) === fork;
            },
            { legacy: LEGACY_TAG, fork: FORK_TAG },
        );
        expect(isAlias).toBe(true);
        await expect.poll(() => readStoredJson(page, FORK_VIEW_KEY)).toHaveProperty(["card-e2e-old-path"]);
        expect(errors).toEqual([]);
        await shot(page, "43-element-name-old-path");
    });

    test("renders the legacy type next to a dead resource row at the old path", async ({ page }) => {
        // The upgrade state from the rename: a resource row still points at the pre-rename path, the
        // installer deleted that file, and the working file is the fork's. The 404 must not stop the
        // alias: it is evidence that nothing can register upstream's name, and it must not cost the
        // grace period either.
        removeOldPathBundle();
        await setCardResources(["fork", `${OLD_PATH_URL}?v=e2e-dead-row`]);
        const errors = recordRegistrationErrors(page);
        await recordAliasTiming(page, pathOf(INSTALLED_URL));

        await login(page);
        const status = await page.request.get(`${OLD_PATH_URL}?v=e2e-dead-row`);
        expect(status.status(), "the old path must really 404 for this test to mean anything").toBe(404);
        await page.goto("/e2e-element-names/legacy");
        await waitForHaReady(page);
        await expectCardRendered(page, LEGACY_TAG);
        await expectAliasWithoutGrace(page);

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
        for (const first of ["fork", "upstream"] as const) {
            test(`loads both cards from the ${install.name} install with the ${first} bundle running first`, async ({
                page,
            }) => {
                installUpstreamBundles(install.name);
                const paths: BundlePaths = { fork: pathOf(INSTALLED_URL), upstream: pathOf(install.url) };
                await setCardResourceOrder(install.url, [first, other(first)]);
                const errors = recordRegistrationErrors(page);

                await login(page);
                await holdSecondUntilFirstRuns(page, first, paths);
                await page.goto("/e2e-element-names/mixed");
                await waitForHaReady(page);
                await expectRanInOrder(page, first, paths);
                await expectCardRendered(page, FORK_TAG);
                await expectCardRendered(page, LEGACY_TAG);
                // Upstream owns the legacy name here: the fork must have left it alone.
                await expectLegacyOwnedByUpstream(page);
                await expectForkCardIsFork(page);
                // Neither card fell back to Home Assistant's error card.
                await expectNoErrorCard(page);
                expect(errors).toEqual([]);
                await shot(page, `42-element-names-${install.name}-${first}-first`);
            });
        }
    }

    test("keeps the fork's own type when the upstream card is installed", async ({ page }) => {
        installUpstreamBundles("hacs-folder");
        await setCardResourceOrder(UPSTREAM_INSTALLS[0].url, ["upstream", "fork"]);
        const errors = recordRegistrationErrors(page);
        await login(page);
        await holdSecondUntilFirstRuns(page, "upstream", {
            fork: pathOf(INSTALLED_URL),
            upstream: pathOf(UPSTREAM_INSTALLS[0].url),
        });
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
        const paths: BundlePaths = { fork: pathOf(OLD_PATH_URL), upstream: pathOf(UPSTREAM_INSTALLS[1].url) };

        await login(page);
        await holdSecondUntilFirstRuns(page, "fork", paths);
        await page.goto("/e2e-element-names/mixed");
        await waitForHaReady(page);
        await expectRanInOrder(page, "fork", paths);
        await expectCardRendered(page, FORK_TAG);
        await expectCardRendered(page, LEGACY_TAG);
        await expectLegacyOwnedByUpstream(page);
        await expectForkCardIsFork(page);
        await expectNoErrorCard(page);
        expect(errors).toEqual([]);
        await shot(page, "45-element-names-old-path-with-upstream");
    });

    for (const first of ["fork", "upstream"] as const) {
        test(`leaves the upstream card's stored view and run in its own keys (${first} bundle first)`, async ({
            page,
        }) => {
            installUpstreamBundles("hacs-folder");
            await setCardResourceOrder(UPSTREAM_INSTALLS[0].url, [first, other(first)]);
            const errors = recordRegistrationErrors(page);
            const paths: BundlePaths = { fork: pathOf(INSTALLED_URL), upstream: pathOf(UPSTREAM_INSTALLS[0].url) };
            const viewKey = "card-e2e-upstream-state";
            const legacyView = { [viewKey]: { s: 2, x: 12, y: 34, r: 0, ts: 1 } };
            const legacyRun = {
                "vacuum.fake_vacuum": { entity: "vacuum.fake_vacuum", roomIds: ["16"], startedAt: 1, seenActive: true },
            };
            await seedLegacyStorage(page, {
                [LEGACY_VIEW_KEY]: JSON.stringify(legacyView),
                [LEGACY_RUN_KEY]: JSON.stringify(legacyRun),
            });

            await login(page);
            await holdSecondUntilFirstRuns(page, first, paths);
            await page.goto("/e2e-element-names/mixed");
            await waitForHaReady(page);
            await expectRanInOrder(page, first, paths);
            await expectCardRendered(page, LEGACY_TAG);
            await expectCardRendered(page, FORK_TAG);

            // A rendered card does not mean the alias decision has settled; wait for the marker it
            // writes when upstream owns the name before reading the storage it must leave alone.
            await expect
                .poll(() => page.evaluate(key => window.localStorage.getItem(key), FORK_UPSTREAM_SEEN_KEY))
                .toBe("1");

            const stored = await page.evaluate(
                (keys: string[]) =>
                    Object.fromEntries(keys.map(key => [key, window.localStorage.getItem(key)])) as Record<
                        string,
                        string | null
                    >,
                [
                    LEGACY_VIEW_KEY,
                    LEGACY_RUN_KEY,
                    FORK_VIEW_KEY,
                    FORK_RUN_KEY,
                    FORK_MIGRATED_KEY,
                    FORK_UPSTREAM_SEEN_KEY,
                ],
            );

            // Untouched: the upstream card keeps using its own keys.
            expect(JSON.parse(stored[LEGACY_VIEW_KEY] ?? "{}")).toHaveProperty([viewKey]);
            expect(JSON.parse(stored[LEGACY_RUN_KEY] ?? "{}")).toEqual(legacyRun);
            // Never copied, and the one-shot migration never marked itself done. The fork's own card
            // on this page may store its own view, but nothing under its key may be upstream's state.
            expect(stored[FORK_VIEW_KEY] ?? "").not.toContain(viewKey);
            expect(stored[FORK_RUN_KEY] ?? "").not.toContain("vacuum.fake_vacuum");
            expect(stored[FORK_MIGRATED_KEY]).toBeNull();
            // The browser now remembers that the legacy name and keys belong to the upstream card.
            expect(stored[FORK_UPSTREAM_SEEN_KEY]).toBe("1");
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
        const key = "card-e2e-alias";
        await seedLegacyStorage(page, {
            [LEGACY_VIEW_KEY]: JSON.stringify({ [key]: { s: 2, x: 12, y: 34, r: 0, ts: 1 } }),
        });
        await login(page);
        await page.goto("/e2e-element-names/new");
        await waitForHaReady(page);
        await waitForCard(page, FORK_TAG);
        await expect.poll(() => readStoredJson(page, FORK_VIEW_KEY)).toHaveProperty([key]);
        // The upstream key is kept: another card may still be using it.
        expect(await readStoredJson(page, LEGACY_VIEW_KEY)).toHaveProperty([key]);
    });
});
