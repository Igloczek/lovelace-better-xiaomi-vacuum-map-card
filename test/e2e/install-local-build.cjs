#!/usr/bin/env node
/**
 * Puts the locally built bundle in front of the end-to-end tests.
 *
 * The installer step (`marketplace-install.cjs`) proves that a user can install a released version
 * from the repository URL. Behaviour tests, however, must run against the code in this checkout, not
 * the last release, otherwise a pull request can never be proven before it is released.
 *
 * This copies `dist/xiaomi-vacuum-map-card.js` over the installed file, removes the installer's
 * pre-compressed `.gz`/`.br` siblings (Home Assistant's static handler serves them in preference to
 * the plain file, so a stale one would keep the released bundle in front of the specs), checks the
 * copy byte for byte, and gives the Lovelace resource a fresh cache-buster so the browser loads the
 * branch build from the same path the installer created. `global-setup.cjs` checks what Home Assistant
 * actually serves before any spec runs.
 */
const fs = require("node:fs");
const path = require("node:path");

const {
    BUNDLE,
    CONFIG_DIR,
    sha256,
    freshAccessToken,
    connectWebSocket,
    describeInstance,
} = require("./support/harness.cjs");

const INSTALLED = path.join(
    CONFIG_DIR,
    "www",
    "community",
    "lovelace-better-xiaomi-vacuum-map-card",
    "xiaomi-vacuum-map-card.js",
);

function install() {
    if (!fs.existsSync(BUNDLE)) throw new Error(`missing ${BUNDLE}; run npm run build first`);
    if (!fs.existsSync(INSTALLED)) {
        throw new Error(`missing ${INSTALLED}; run node test/e2e/marketplace-install.cjs first`);
    }
    fs.copyFileSync(BUNDLE, INSTALLED);
    for (const suffix of [".gz", ".br"]) {
        const sibling = `${INSTALLED}${suffix}`;
        if (fs.existsSync(sibling)) {
            fs.rmSync(sibling);
            console.log(`removed stale ${path.basename(sibling)}`);
        }
    }
    const built = sha256(fs.readFileSync(BUNDLE));
    const installed = sha256(fs.readFileSync(INSTALLED));
    if (built !== installed) {
        throw new Error(`the copy at ${INSTALLED} differs from ${BUNDLE} (${installed} vs ${built})`);
    }
    console.log(
        `branch build installed over the Marketplace copy (${fs.statSync(INSTALLED).size} bytes, sha256 ${built.slice(0, 16)})`,
    );
}

async function main() {
    console.log(describeInstance());
    install();

    const token = await freshAccessToken();
    const ws = await connectWebSocket(token);
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
