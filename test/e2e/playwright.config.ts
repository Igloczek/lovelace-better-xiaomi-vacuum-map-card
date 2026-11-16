import { defineConfig, devices } from "@playwright/test";

import { haUrl } from "./support/instance";

/**
 * End-to-end suite against a real Home Assistant instance.
 *
 * `setup.cjs` onboards the instance, registers the card resource and writes the dashboards; this
 * project only drives the UI. Start the instance with `docker compose -f test/e2e/compose.yaml up -d`
 * and run `node test/e2e/setup.cjs` first, or let `npm run test:e2e:fresh` do the whole sequence.
 *
 * `global-setup.cjs` runs before the specs: it validates the saved session (re-authenticating when
 * the token is stale) and fails immediately, with the reset command, when the instance has no
 * dashboards or installed card. Without it a stale token made every spec time out on the login page.
 */
export default defineConfig({
    testDir: "./specs",
    globalSetup: "./global-setup.cjs",
    timeout: 90_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["list"], ["html", { open: "never", outputFolder: "./artifacts/playwright-report" }]],
    outputDir: "./artifacts/test-results",
    use: {
        baseURL: haUrl(),
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "off",
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
    },
    projects: [
        {
            name: "chromium",
            // Keep the viewport from `use`; re-spreading the device here would reset it to 1280x720.
            use: { browserName: "chromium" },
        },
        {
            // WebKit is the engine of Safari and of the Home Assistant iOS and macOS apps. It lays
            // out HTML overlays like Chromium but can paint them elsewhere (1.5.0's labels), so the
            // label and live-path specs run here too and check the pixels, not only the layout.
            name: "webkit",
            use: { browserName: "webkit" },
            testMatch: ["room-pill.spec.ts", "live-path.spec.ts", "apartment-rooms.spec.ts"],
        },
    ],
});
