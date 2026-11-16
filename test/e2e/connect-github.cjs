#!/usr/bin/env node
/**
 * Connects a GitHub account to Home Assistant's Marketplace on the end-to-end instance.
 *
 * Home Assistant 2026.11 blocks the HACS custom integration and ships the Marketplace instead. A
 * fresh Marketplace needs a GitHub account before it can add a custom repository; the interactive
 * device flow cannot run in a headless test, so this writes the token into the Marketplace config
 * entry exactly where the flow stores it, then asks for a restart.
 *
 * The token comes from GITHUB_TOKEN (or `gh auth token` when that is available) and is written only
 * to `test/e2e/ha/config/.storage`, which is gitignored. It is never part of the repository.
 *
 * Usage: GITHUB_TOKEN=... node test/e2e/connect-github.cjs [--restart]
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { compose, describeInstance, waitForApi } = require("./support/harness.cjs");

const CONFIG = path.join(__dirname, "ha", "config");
const ENTRIES = path.join(CONFIG, ".storage", "core.config_entries");

/**
 * Home Assistant writes its config-entry store shortly after startup, not when the websocket is
 * ready. A fresh instance that has just been onboarded can still be flushing it, so wait for the
 * file instead of failing the whole sequence on a first-start race.
 */
async function waitForEntries({ timeoutMs = 60_000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(ENTRIES)) return;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(
        `${ENTRIES} did not appear within ${timeoutMs / 1000}s; start Home Assistant and run ` +
            `test/e2e/setup.cjs first`,
    );
}

async function waitForMarketplaceEntry({ timeoutMs = 60_000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = "the file has no marketplace entry";
    while (Date.now() < deadline) {
        try {
            const data = JSON.parse(fs.readFileSync(ENTRIES, "utf8"));
            const entries = data.data?.entries;
            const marketplace = Array.isArray(entries)
                ? entries.find(entry => entry.domain === "marketplace")
                : undefined;
            if (marketplace) return { data, marketplace };
            last = "the file has no marketplace entry";
        } catch (error) {
            last = error.message;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(
        `no marketplace config entry in ${ENTRIES} (${last}); Home Assistant 2026.11 creates one on first start`,
    );
}

function tokenFromEnvironment() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
    try {
        return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    } catch {
        throw new Error("no GitHub token: set GITHUB_TOKEN or log in with `gh auth login`");
    }
}

async function main() {
    await waitForEntries();
    const token = tokenFromEnvironment();
    console.log(describeInstance());

    const wantsRestart = process.argv.includes("--restart");
    // Stop first: Home Assistant rewrites the config-entry store while it runs, so a token written
    // under a live instance can be overwritten on shutdown. Read the store only after it stopped,
    // otherwise the shutdown write is lost. The compose project is the one this instance belongs to,
    // so a renamed container is not left running with an old token while another project restarts.
    if (wantsRestart) compose(["stop", "homeassistant"], { stdio: "inherit" });

    const { data, marketplace } = await waitForMarketplaceEntry();
    marketplace.data = { ...(marketplace.data ?? {}), token };

    fs.writeFileSync(ENTRIES, JSON.stringify(data, null, 2));
    // Keep the token off disk anywhere else, including logs.
    console.log(`marketplace GitHub token written to the ignored state file for entry ${marketplace.entry_id}`);

    if (wantsRestart) {
        compose(["start", "homeassistant"], { stdio: "inherit" });
        const status = await waitForApi({ timeoutMs: 180_000 });
        console.log(`Home Assistant back at ${status === 401 ? "/api/ (unauthenticated, ready)" : "/api/"}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
