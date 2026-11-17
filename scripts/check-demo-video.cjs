#!/usr/bin/env node
/*
 * Release gate for the README demo video.
 *
 * A release whose changes touch the card's UI must ship a re-recorded `docs/media/demo.mp4` and
 * `docs/media/demo.webp` (see scripts/demo-video/README.md). This compares the commit being released
 * with the last stable release tag: when anything under `src/` changed and the video did not, it
 * fails and lists the changed files.
 *
 * `--no-ui-change` passes anyway. Use it only when every listed change provably leaves what the card
 * shows and how it moves untouched (a service payload, a validator), and say so in the release
 * hand-off. When in doubt, re-record.
 *
 * Usage: node scripts/check-demo-video.cjs [--no-ui-change] [ref]   (ref defaults to HEAD)
 */
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const noUiChange = args.includes("--no-ui-change");
const ref = args.find(a => !a.startsWith("--")) || "HEAD";
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const VIDEO = ["docs/media/demo.mp4", "docs/media/demo.webp"];

// Local tags can include upstream's legacy ones, so the last release is the newest fork tag on
// origin that the released commit contains.
const isAncestor = tag => {
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", tag, ref], { cwd: root, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
};
const lastTag = git("ls-remote", "--tags", "--refs", "origin", "v*")
    .split("\n")
    .map(line => line.split("refs/tags/")[1])
    .filter(t => /^v\d+\.\d+\.\d+$/.test(t || ""))
    .sort((a, b) => b.slice(1).localeCompare(a.slice(1), undefined, { numeric: true }))
    .find(t => {
        try {
            git("fetch", "-q", "origin", `refs/tags/${t}:refs/tags/${t}`);
        } catch {}
        return isAncestor(t);
    });
if (!lastTag) {
    console.error(`check-demo-video: no release tag on origin is an ancestor of ${ref}.`);
    process.exit(1);
}

const changed = (...paths) =>
    git("diff", "--name-only", `${lastTag}..${ref}`, "--", ...paths)
        .split("\n")
        .filter(Boolean);
const ui = changed("src");
const video = changed(...VIDEO);

if (!ui.length) {
    console.log(`check-demo-video: nothing under src/ changed since ${lastTag}; no re-recording needed.`);
} else if (video.length === VIDEO.length) {
    console.log(`check-demo-video: src/ changed since ${lastTag} and the demo video was re-recorded.`);
} else if (noUiChange) {
    console.log(
        `check-demo-video: --no-ui-change given; ${ui.length} src/ file(s) changed since ${lastTag} without a new video. State why in the release hand-off.`,
    );
} else {
    console.error(`check-demo-video: ${ui.length} file(s) under src/ changed since ${lastTag}:`);
    for (const file of ui) console.error("  " + file);
    console.error(
        video.length
            ? `but only ${video.join(", ")} was updated; re-record both.`
            : "but docs/media/demo.mp4 and demo.webp were not re-recorded.",
    );
    console.error("Re-record them (scripts/demo-video/README.md) and commit before tagging the release,");
    console.error("or pass --no-ui-change if none of these changes is visible in the card.");
    process.exit(1);
}
