#!/usr/bin/env node
/**
 * The documented end-to-end sequence in one command, from a clean instance.
 *
 * Agents lost runs by repeating the reset by hand (`docker compose down -v`, `git clean -fdX`,
 * then five scripts in order) and by forgetting one step. This runs the lot against the instance
 * the environment names, so `E2E_CONTAINER`, `E2E_HA_PORT`, `E2E_HA_URL` and `COMPOSE_PROJECT_NAME`
 * keep parallel worktrees apart. It stops and removes the container, deletes the ignored runtime
 * state (`.storage`, `.auth`, `artifacts`), boots Home Assistant, waits for `/api/` to answer, sets
 * up the dashboards, connects Marketplace to GitHub, installs the card from the repository, puts
 * this checkout's build in front of the specs, and runs Playwright.
 *
 * Usage:
 *   npm run test:e2e:fresh
 *   npm run test:e2e:fresh -- --down          # tear the instance down after the suite
 *   npm run test:e2e:fresh -- --no-build      # reuse an existing dist/ bundle
 *   npm run test:e2e:fresh -- -- specs/foo.spec.ts
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT, E2E_DIR, BUNDLE, compose, environment, describeInstance, waitForApi } = require("./support/harness.cjs");

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const flags = separator === -1 ? args : args.slice(0, separator);
const playwrightArgs = separator === -1 ? [] : args.slice(separator + 1);
const downAfter = flags.includes("--down");
const build = !flags.includes("--no-build");

function step(name) {
    console.log(`\n=== ${name}`);
}

function run(command, commandArgs, options = {}) {
    execFileSync(command, commandArgs, { cwd: ROOT, stdio: "inherit", env: environment(), ...options });
}

function resetIgnoredState() {
    // `-X` removes ignored files only, so the committed fixture files under ha/config stay. This is
    // the same reset the README used to ask for by hand; it covers .storage, www, logs, .auth and
    // artifacts in one go.
    run("git", ["clean", "-fdXq", "--", "test/e2e/ha/config", "test/e2e/.auth", "test/e2e/artifacts"]);
}

async function main() {
    console.log(`e2e fresh run against ${describeInstance()}`);
    if (build) {
        step("build the branch bundle");
        run("npm", ["run", "build"]);
    } else if (!fs.existsSync(BUNDLE)) {
        throw new Error(`--no-build was passed but ${BUNDLE} does not exist; run npm run build first`);
    }

    step("stop and remove this worktree's instance");
    try {
        compose(["down", "--remove-orphans"]);
    } catch {
        // No project yet (first run) is not an error.
    }
    // Reset only after Home Assistant stopped: it rewrites `.storage` on shutdown, which would put
    // the files we just deleted back.
    resetIgnoredState();

    step("start Home Assistant");
    compose(["up", "-d"]);
    const status = await waitForApi({ timeoutMs: 180_000 });
    console.log(`/api/ answers ${status === 401 ? "401 (unauthenticated, ready)" : `HTTP ${status}`}`);

    step("onboard and write the e2e dashboards");
    run(process.execPath, [path.join(E2E_DIR, "setup.cjs")]);

    step("connect Marketplace to GitHub (stops and restarts the container)");
    run(process.execPath, [path.join(E2E_DIR, "connect-github.cjs"), "--restart"]);

    step("install the released card from the repository URL");
    run(process.execPath, [path.join(E2E_DIR, "marketplace-install.cjs")]);

    step("put this checkout's build in front of the specs");
    run(process.execPath, [path.join(E2E_DIR, "install-local-build.cjs")]);

    step("run the Playwright suite");
    run("npm", ["run", "test:e2e", "--", ...playwrightArgs]);

    if (downAfter) {
        step("stop this worktree's instance");
        compose(["down", "--remove-orphans"]);
    }
}

main().catch(error => {
    console.error(`\ne2e fresh run failed: ${error.message}`);
    if (downAfter) {
        console.error("\n== stop this worktree's instance after the failure");
        try {
            compose(["down", "--remove-orphans"]);
        } catch (teardownError) {
            console.error(`teardown failed: ${teardownError.message}`);
        }
    }
    process.exit(1);
});
