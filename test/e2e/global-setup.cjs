/**
 * Playwright global setup: prove the instance is usable before the first spec starts.
 *
 * The suite assumes an instance prepared by the scripts in this directory. When the saved session
 * belongs to a previous instance, every spec would otherwise sit on the login page until its test
 * timeout. This gate:
 *
 * - re-authenticates when the saved token is rejected by an instance that is still set up (the
 *   stale-token case; the session is rewritten in place and the run continues);
 * - refuses with the exact reset command when the instance has no prepared dashboards, or when the
 *   card resource is missing or not served, which is what a recreated Home Assistant looks like.
 */
const { describeInstance, ensureSession, tokenStatus, connectWebSocket, haUrl } = require("./support/harness.cjs");

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
        const url = String(resource.url).split("?")[0];
        let served = 0;
        try {
            const response = await fetch(`${new URL(url, haUrl())}?probe=${Date.now()}`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (response.ok) served = (await response.text()).length;
        } catch {
            served = 0;
        }
        if (served < 100_000) {
            throw new Error(
                `The card resource ${resource.url} is registered but Home Assistant does not serve it ` +
                    `(${served} bytes). Run \`node test/e2e/install-local-build.cjs\` after \`npm run build\`, ` +
                    `or \`npm run test:e2e:fresh\`.`,
            );
        }
        if (!String(resource.url).includes("v=branch-")) {
            console.warn(
                `warning: the card resource is not this checkout's build (${resource.url}); ` +
                    "run `node test/e2e/install-local-build.cjs` to test the branch",
            );
        }
        console.log(`e2e instance ready: ${resource.url} (${served} bytes)`);
    } finally {
        ws.close();
    }
};
