#!/usr/bin/env node
/**
 * Installs the card from the renamed repository URL on a current Home Assistant.
 *
 * Home Assistant 2026.11 ships the core `marketplace` integration, which supersedes HACS: it
 * installs custom integrations, dashboard resources, themes and templates from GitHub, and it
 * removes a HACS config entry as a duplicate when both are present. This script runs the same
 * repository-add and install commands the Marketplace panel calls, then proves the asset and the
 * Lovelace resource.
 */
const { haUrl, freshAccessToken, connectWebSocket, describeInstance } = require("./support/harness.cjs");

const BASE = haUrl();
const REPO_URL = "https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card";
const REPO_NAME = "Igloczek/lovelace-better-xiaomi-vacuum-map-card";

async function socket() {
    const token = await freshAccessToken({ base: BASE });
    return connectWebSocket(token, { base: BASE });
}

/**
 * Home Assistant answers `/api/` and the websocket before its integrations finish loading. The
 * Marketplace then answers `not_loaded`; a restart right before this script is the normal case.
 * Wait for the integration instead of failing the sequence on a startup race.
 */
async function waitForMarketplace(ws) {
    for (let attempt = 0; attempt < 180; attempt++) {
        try {
            return await ws.send("marketplace/info");
        } catch (error) {
            const message = String(error.message);
            // `not_loaded` is the integration loading; `unknown_command` is a command registered by
            // that integration, so the frontend has not installed its handlers yet.
            if (!message.includes("not_loaded") && !message.includes("unknown_command")) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("the Marketplace integration did not load within 180s after the restart");
}

async function main() {
    console.log(describeInstance());
    const ws = await socket();
    const info = await waitForMarketplace(ws);
    console.log(`marketplace ${info.version}, github_connected=${info.github_connected}, stage=${info.stage}`);

    await ws.send("marketplace/warning/accept");
    const detected = await ws.send("marketplace/repositories/detect", { repository: REPO_URL });
    console.log(`detected categories: ${detected.categories.join(", ")}`);
    if (!detected.categories.includes("plugin"))
        throw new Error("the repository is not detected as a dashboard resource");

    try {
        await ws.send("marketplace/repositories/add", { repository: REPO_URL, category: "plugin" });
    } catch (error) {
        if (!String(error.message).includes("already")) throw error;
    }

    const repositories = await ws.send("marketplace/repositories/list", { categories: ["plugin"] });
    const repository = repositories.find(entry => entry.full_name === REPO_NAME);
    if (!repository) throw new Error(`marketplace did not register ${REPO_NAME}`);
    console.log(`registered ${repository.full_name} id=${repository.id} version=${repository.available_version}`);

    await ws.send("marketplace/repository/install", { repository: repository.id });

    // Verify through the same URL a browser uses, so the check works against an instance mounted
    // from another checkout or on another host.
    const assetUrl = `${BASE}/local/community/lovelace-better-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js`;
    let bytes = 0;
    for (let attempt = 0; attempt < 180; attempt++) {
        const response = await fetch(assetUrl);
        if (response.ok) {
            const body = await response.text();
            bytes = body.length;
            if (bytes > 100_000) break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (bytes <= 100_000) throw new Error(`marketplace did not serve the installed card at ${assetUrl}`);
    console.log(`installed asset served at ${assetUrl} (${bytes} bytes)`);

    const after = (await ws.send("marketplace/repositories/list", { categories: ["plugin"] })).find(
        entry => entry.full_name === REPO_NAME,
    );
    console.log(`marketplace reports installed=${after?.installed} version=${after?.installed_version}`);

    const resources = await ws.send("lovelace/resources");
    const resource = resources.find(entry => entry.url.includes("lovelace-better-xiaomi-vacuum-map-card"));
    if (!resource) throw new Error("no Lovelace resource was registered for the installed card");
    console.log(`lovelace resource: ${resource.url} (type ${resource.type})`);
    ws.close();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
