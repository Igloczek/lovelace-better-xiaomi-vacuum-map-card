/**
 * Playwright global setup: prove the instance serves this checkout's card before the first spec.
 *
 * The suite assumes an instance prepared by the scripts in this directory. When the saved session
 * belongs to a previous instance, every spec would otherwise sit on the login page until its test
 * timeout, and when the card installed is the last release, every spec would silently test that
 * release instead of this checkout. This gate fails the run, with the command that fixes it, when:
 *
 * - the saved session is rejected by an instance that is still set up and cannot be refreshed or
 *   signed in again with the e2e credentials (the stale-token case re-authenticates first);
 * - the instance has no prepared dashboards, or no card resource (a recreated instance);
 * - the bundle Home Assistant serves at the card's resource URL is not byte-identical to `dist/`
 *   (the Marketplace copy was not replaced by `install-local-build.cjs`, or `dist/` is stale).
 */
const fs = require("node:fs");
const path = require("node:path");

const {
    BUNDLE,
    CONFIG_DIR,
    describeInstance,
    ensureSession,
    tokenStatus,
    connectWebSocket,
    haUrl,
    sha256,
} = require("./support/harness.cjs");

const REBUILD = "`npm run build` and `node test/e2e/install-local-build.cjs`";

module.exports = async () => {
    const instance = describeInstance();
    console.log(`e2e instance: ${instance}`);

    let token;
    try {
        token = await ensureSession({ timeoutMs: 60_000 });
    } catch (error) {
        throw new Error(
            `The Home Assistant end-to-end instance is not usable: ${error.message}. ` +
                `Start it with \`docker compose -f test/e2e/compose.yaml up -d\` or run ` +
                `\`npm run test:e2e:fresh\`.`,
        );
    }

    const status = await tokenStatus(token);
    if (status !== 200) {
        throw new Error(
            `The Home Assistant session is still rejected by ${instance} (GET /api/ returned ${status}). ` +
                `Run \`npm run test:e2e:fresh\` to rebuild and re-authenticate the instance.`,
        );
    }

    const ws = await connectWebSocket(token);
    try {
        const dashboards = await ws.send("lovelace/dashboards/list");
        const hasDashboards = Array.isArray(dashboards) && dashboards.some(entry => entry.url_path === "e2e-map");
        if (!hasDashboards) {
            throw new Error(
                `The instance at ${instance} is authenticated but has no e2e dashboards. ` +
                    `It was recreated or reset without its setup step: run \`npm run test:e2e:fresh\` ` +
                    `(or \`node test/e2e/setup.cjs\` on a prepared instance).`,
            );
        }

        const resources = await ws.send("lovelace/resources");
        const resource = Array.isArray(resources)
            ? resources.find(entry => String(entry.url).includes("better-xiaomi-vacuum-map-card"))
            : undefined;
        if (!resource) {
            throw new Error(
                `The instance at ${instance} is authenticated but has no card resource. ` +
                    `Run \`node test/e2e/marketplace-install.cjs\` and \`node test/e2e/install-local-build.cjs\`, ` +
                    `or \`npm run test:e2e:fresh\`.`,
            );
        }

        // The file this checkout builds. Missing dist/ means there is nothing to compare against.
        if (!fs.existsSync(BUNDLE)) {
            throw new Error(`${BUNDLE} does not exist; run \`npm run build\` before the e2e suite.`);
        }
        const built = fs.readFileSync(BUNDLE);

        // What Home Assistant serves at the resource URL, the same file a browser executes.
        const url = String(resource.url).split("?")[0];
        // Home Assistant serves a precompressed sibling to a browser that accepts it, so a stale .gz
        // or .br next to the file would run in Chromium while the plain file below matches dist/.
        if (url.startsWith("/local/")) {
            const file = path.join(CONFIG_DIR, "www", ...url.slice("/local/".length).split("/"));
            const stale = [".gz", ".br"].map(suffix => `${file}${suffix}`).filter(sibling => fs.existsSync(sibling));
            if (stale.length > 0) {
                throw new Error(
                    `Precompressed copies of the card are installed next to it (${stale.join(", ")}); ` +
                        `the browser would run those instead of this checkout's build. Run ${REBUILD}.`,
                );
            }
        }
        let response;
        try {
            response = await fetch(`${new URL(url, haUrl())}?probe=${Date.now()}`, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(30_000),
            });
        } catch (error) {
            throw new Error(`The card resource ${resource.url} could not be fetched (${error.message}). ${REBUILD}`);
        }
        if (!response.ok) {
            throw new Error(
                `The card resource ${resource.url} is registered but Home Assistant answers HTTP ` +
                    `${response.status} for it. Run ${REBUILD}, or \`npm run test:e2e:fresh\`.`,
            );
        }
        const served = Buffer.from(await response.arrayBuffer());
        const servedHash = sha256(served);
        const builtHash = sha256(built);
        if (servedHash !== builtHash) {
            throw new Error(
                `The card served at ${resource.url} is not this checkout's build: Home Assistant serves ` +
                    `${served.length} bytes (sha256 ${servedHash.slice(0, 16)}), dist/ has ${built.length} bytes ` +
                    `(sha256 ${builtHash.slice(0, 16)}). The specs would test the installed release instead of ` +
                    `this checkout. Run ${REBUILD}, or \`npm run test:e2e:fresh\`.`,
            );
        }
        if (!String(resource.url).includes("v=branch-")) {
            console.warn(
                `warning: the card resource has no branch cache-buster (${resource.url}); ` +
                    "the bundle is still this checkout's build",
            );
        }
        console.log(
            `e2e instance ready: ${resource.url} (${served.length} bytes, dist/ sha256 ${builtHash.slice(0, 16)})`,
        );
    } finally {
        ws.close();
    }
};
