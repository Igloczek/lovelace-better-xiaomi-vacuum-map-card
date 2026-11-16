/**
 * The Home Assistant instance the Playwright project drives.
 *
 * `E2E_HA_URL` is authoritative when set. Otherwise the port is taken from `E2E_HA_PORT` (or the
 * URL's own port), so a worktree that only publishes another port does not silently drive the
 * default `:8123` instance of another checkout.
 */
export function haPort(): string {
    if (process.env.E2E_HA_PORT) return process.env.E2E_HA_PORT;
    if (process.env.E2E_HA_URL) {
        try {
            const url = new URL(process.env.E2E_HA_URL);
            return url.port || (url.protocol === "https:" ? "443" : "80");
        } catch {
            // fall through to the documented default
        }
    }
    return "8123";
}

export function haUrl(): string {
    return (process.env.E2E_HA_URL || `http://localhost:${haPort()}`).replace(/\/+$/, "");
}
