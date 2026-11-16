/**
 * The Home Assistant instance the Playwright project drives.
 *
 * `support/harness.cjs` decides it for every script and spec: `E2E_HA_URL` is authoritative when
 * set, otherwise the port is `E2E_HA_PORT` (or the URL's own port). The specs import it from here so
 * there is one definition; `E2E_HA_PORT` alone is enough to point a checkout at its own instance.
 */
// The harness is CommonJS and shared with the Node scripts; Playwright loads both.
const harness: { haPort: () => string; haUrl: () => string } = require("./harness.cjs");

export const haPort: () => string = harness.haPort;
export const haUrl: () => string = harness.haUrl;
