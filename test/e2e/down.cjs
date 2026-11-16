#!/usr/bin/env node
/**
 * Stop and remove this checkout's end-to-end instance (container and compose network).
 *
 * It resolves the instance the same way every other script does (`E2E_CONTAINER`, `E2E_HA_PORT`,
 * `E2E_HA_URL`, `COMPOSE_PROJECT_NAME`), so run it with the environment the instance was started
 * with. The gitignored state under `ha/config` stays; `npm run test:e2e:fresh` resets it.
 *
 * Usage: npm run e2e:down
 */
const { compose, describeInstance } = require("./support/harness.cjs");

console.log(`stopping ${describeInstance()}`);
compose(["down", "--remove-orphans"]);
