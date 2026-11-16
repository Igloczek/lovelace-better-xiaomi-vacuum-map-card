#!/usr/bin/env node
/**
 * Puts the locally built bundle in front of the end-to-end tests.
 *
 * The installer step (`marketplace-install.cjs`) proves that a user can install a released version
 * from the repository URL. Behaviour tests, however, must run against the code in this checkout, not
 * the last release, otherwise a pull request can never be proven before it is released.
 *
 * This copies `dist/xiaomi-vacuum-map-card.js` over the installed file and gives the Lovelace
 * resource a fresh cache-buster, so the browser loads the branch build from the same path the
 * installer created.
 */
const fs = require("node:fs");
const path = require("node:path");

const { freshAccessToken, connectWebSocket, describeInstance } = require("./support/harness.cjs");

const CONFIG = path.join(__dirname, "ha", "config");
const BUNDLE = path.join(__dirname, "..", "..", "dist", "xiaomi-vacuum-map-card.js");
const INSTALLED = path.join(
    CONFIG,
    "www",
    "community",
    "lovelace-better-xiaomi-vacuum-map-card",
    "xiaomi-vacuum-map-card.js",
);

async function socket() {
    const token = await freshAccessToken();
    return connectWebSocket(token);
}

async function main() {
    console.log(describeInstance());
    const ws = await socket();
    const resources = await ws.send("lovelace/resources");
    const resource = resources.find(entry => entry.url.includes("lovelace-better-xiaomi-vacuum-map-card"));
    if (!resource) throw new Error("no installed card resource; run marketplace-install.cjs first");
    const base = resource.url.split("?")[0];
    const version = Date.now().toString(36);
    await ws.send("lovelace/resources/update", {
        resource_id: resource.id,
        res_type: "module",
        url: `${base}?v=branch-${version}`,
    });
    console.log(`resource cache-buster updated: ${base}?v=branch-${version}`);
    ws.close();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
