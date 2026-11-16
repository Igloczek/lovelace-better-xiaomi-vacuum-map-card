#!/usr/bin/env node
/**
 * Fetches the pinned upstream card release and puts it where a real installation serves it.
 *
 * The side-by-side spec has to prove the two cards next to the bundle upstream actually ships, so
 * the version and its sha256 are pinned in `upstream-pin.json`, which this script and the spec both
 * read: there is one path and one digest to keep in step. The download happens once, in this setup
 * step, and is cached under the git-ignored `.cache/`: a spec run must not depend on GitHub being
 * reachable and must not silently test a different release than the one recorded in the pull
 * request.
 *
 * `--refresh` downloads the pinned release again even when the cache holds a matching file. A cache
 * that does not match the pin is downloaded again without the flag.
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

const pin = require("./upstream-pin.json");

const MIN_BYTES = 100_000;
const CACHE = path.join(__dirname, pin.cache);
const REFRESH = process.argv.slice(2).includes("--refresh");
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
    console.log(`downloading ${pin.url}`);
    const response = await fetch(pin.url);
    if (!response.ok) throw new Error(`upstream download failed: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
}

async function main() {
    let bytes;
    if (REFRESH) {
        console.log("--refresh: downloading the pinned release again");
    } else if (fs.existsSync(CACHE)) {
        const cached = fs.readFileSync(CACHE);
        if (digest(cached) === pin.sha256) bytes = cached;
        else console.log("the cached bundle does not match the pin; downloading it again");
    }
    bytes = bytes ?? (await download());

    if (bytes.length < MIN_BYTES) throw new Error(`the upstream download is too small: ${bytes.length} bytes`);
    const actual = digest(bytes);
    if (actual !== pin.sha256) {
        throw new Error(
            `the upstream bundle is not ${pin.version}: sha256 ${actual}, expected ${pin.sha256}. ` +
                "A release asset was replaced; check the new file before changing the pin.",
        );
    }

    // Written only after the digest matches, so a bad download never becomes the cached bundle.
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, bytes);
    for (const target of INSTALLS) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        console.log(`upstream ${pin.version} installed at ${target} (${bytes.length} bytes)`);
    }
    console.log(`pinned ${pin.version} sha256 ${pin.sha256}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
