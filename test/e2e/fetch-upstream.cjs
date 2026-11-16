#!/usr/bin/env node
/**
 * Fetches the pinned upstream card release and puts it where a real installation serves it.
 *
 * The side-by-side spec has to prove the two cards next to the bundle upstream actually ships, so
 * the version and its sha256 are pinned here. The download happens once, in this setup step, and is
 * cached under the git-ignored `.cache/`: a spec run must not depend on GitHub being reachable and
 * must not silently test a different release than the one recorded in the pull request.
 *
 * Two real layouts are installed, because they are the two ways this card ends up next to ours:
 *
 * - `www/community/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js` is the folder HACS
 *   installed the upstream card into. Home Assistant 2026.11 blocks HACS and no longer serves the
 *   `/hacsfiles/…` static path HACS registered, so after the upgrade the same folder is loaded
 *   through `/local/community/…`. A user who kept the upstream card and added this one therefore
 *   has this folder plus the fork's Marketplace folder.
 * - `www/xiaomi-vacuum-map-card.js` is the manual install the upstream README describes, loaded
 *   from `/local/xiaomi-vacuum-map-card.js`.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = "v2.4.1";
const SHA256 = "6eb544c670480607c75d82321bb5d1932c781098c1f34391084ecefcac23d445";
const RELEASE = `https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card/releases/download/${VERSION}/xiaomi-vacuum-map-card.js`;
const MIN_BYTES = 100_000;

const CACHE = path.join(__dirname, ".cache", `xiaomi-vacuum-map-card-${VERSION}.js`);
const INSTALLS = [
    path.join(
        __dirname,
        "ha",
        "config",
        "www",
        "community",
        "lovelace-xiaomi-vacuum-map-card",
        "xiaomi-vacuum-map-card.js",
    ),
    path.join(__dirname, "ha", "config", "www", "xiaomi-vacuum-map-card.js"),
];

function digest(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function download() {
    console.log(`downloading ${RELEASE}`);
    const response = await fetch(RELEASE);
    if (!response.ok) throw new Error(`upstream download failed: ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, bytes);
    return bytes;
}

async function main() {
    let bytes = fs.existsSync(CACHE) ? fs.readFileSync(CACHE) : undefined;
    if (bytes && digest(bytes) !== SHA256) {
        console.log("the cached bundle does not match the pin; downloading it again");
        bytes = undefined;
    }
    bytes = bytes ?? (await download());

    if (bytes.length < MIN_BYTES) throw new Error(`the upstream download is too small: ${bytes.length} bytes`);
    const actual = digest(bytes);
    if (actual !== SHA256) {
        throw new Error(
            `the upstream bundle is not ${VERSION}: sha256 ${actual}, expected ${SHA256}. ` +
                "A release asset was replaced; check the new file before changing the pin.",
        );
    }

    for (const target of INSTALLS) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        console.log(`upstream ${VERSION} installed at ${target} (${bytes.length} bytes)`);
    }
    console.log(`pinned ${VERSION} sha256 ${SHA256}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
