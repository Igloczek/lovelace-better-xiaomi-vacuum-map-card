/**
 * Shared environment, compose and authentication helpers for the end-to-end suite.
 *
 * One place decides which Home Assistant instance every script and spec talks to, so a worktree
 * cannot pick up another worktree's container: `E2E_CONTAINER`, `E2E_HA_PORT`, `E2E_HA_URL` and
 * `COMPOSE_PROJECT_NAME` are resolved once and every docker compose call uses the same project.
 *
 * A saved session can outlive the instance it belongs to (the state directory is bind-mounted and
 * both `.storage` and `.auth` are gitignored). The helpers here validate the session before it is
 * used, re-authenticate when the instance is the same one, and otherwise fail with the command
 * that rebuilds the whole instance instead of letting a spec wait on the login page.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const E2E_DIR = path.join(ROOT, "test", "e2e");
const COMPOSE_FILE = path.join(E2E_DIR, "compose.yaml");
const AUTH_DIR = path.join(E2E_DIR, ".auth");
const TOKEN_FILE = path.join(AUTH_DIR, "token.json");
const ARTIFACTS = path.join(E2E_DIR, "artifacts");
const CONFIG_DIR = path.join(E2E_DIR, "ha", "config");
const BUNDLE = path.join(ROOT, "dist", "xiaomi-vacuum-map-card.js");

const USERNAME = process.env.E2E_HA_USER || "e2e";
const PASSWORD = process.env.E2E_HA_PASSWORD || "e2e-password";
const FRESH_COMMAND = "npm run test:e2e:fresh";
const DEFAULT_CONTAINER = "xvmc-e2e-ha";
const DEFAULT_PORT = "8123";

/** `E2E_HA_URL`, parsed strictly: a value that is not an http(s) URL with a host is an error. */
function parsedHaUrl() {
    const raw = process.env.E2E_HA_URL;
    if (!raw) return undefined;
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`E2E_HA_URL=${raw} is not a URL; write it as http://localhost:<port>`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
        throw new Error(`E2E_HA_URL=${raw} is not an http(s) URL; write it as http://localhost:<port>`);
    }
    return url;
}

/**
 * The instance's port. `E2E_HA_PORT` and the port of `E2E_HA_URL` must agree when both are set: the
 * port picks the container and compose project, the URL picks where every request goes, so a
 * mismatch would reset one instance and set up another.
 */
function haPort() {
    const url = parsedHaUrl();
    const urlPort = url ? url.port || (url.protocol === "https:" ? "443" : "80") : undefined;
    const envPort = process.env.E2E_HA_PORT ? String(process.env.E2E_HA_PORT) : undefined;
    if (envPort && urlPort && envPort !== urlPort) {
        throw new Error(
            `E2E_HA_PORT=${envPort} and E2E_HA_URL=${process.env.E2E_HA_URL} name different instances; set them to the same port`,
        );
    }
    return envPort ?? urlPort ?? DEFAULT_PORT;
}

/** A port other than the default: the instance then belongs to this checkout's own identity. */
function portIsCustom() {
    return haPort() !== DEFAULT_PORT;
}

/**
 * The container every script and the compose file address. `E2E_CONTAINER` wins. Otherwise a custom
 * port (`E2E_HA_PORT`, or the port of `E2E_HA_URL`) derives `xvmc-e2e-ha-<port>`, so a checkout that
 * only sets its port never addresses the default container another worktree is using. The default
 * port keeps the default container.
 */
function containerName() {
    if (process.env.E2E_CONTAINER) return process.env.E2E_CONTAINER;
    if (portIsCustom()) return `${DEFAULT_CONTAINER}-${haPort()}`;
    return DEFAULT_CONTAINER;
}

function haUrl() {
    const port = haPort();
    return (process.env.E2E_HA_URL || `http://localhost:${port}`).replace(/\/+$/, "");
}

function sanitizeProjectName(name) {
    const cleaned = String(name)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned || undefined;
}

/**
 * The compose project every script must use, in this order:
 *
 * 1. `COMPOSE_PROJECT_NAME`;
 * 2. a custom `E2E_CONTAINER` names its own project (`connect-github.cjs --restart` used to stop the
 *    default project while the container had been renamed);
 * 3. a custom port alone derives `xvmc-e2e-<port>`, so `docker compose down` in `test:e2e:fresh`
 *    never reaches the default project (`e2e`) that another worktree may be running;
 * 4. the default port and container keep compose's own default project.
 */
function composeProject() {
    if (process.env.COMPOSE_PROJECT_NAME) {
        return { name: sanitizeProjectName(process.env.COMPOSE_PROJECT_NAME), source: "COMPOSE_PROJECT_NAME" };
    }
    if (process.env.E2E_CONTAINER) {
        return { name: sanitizeProjectName(process.env.E2E_CONTAINER), source: "E2E_CONTAINER" };
    }
    if (portIsCustom()) {
        return { name: `xvmc-e2e-${haPort()}`, source: "derived from the custom port" };
    }
    return { name: undefined, source: "compose default" };
}

function composeArgs() {
    const args = ["compose", "-f", COMPOSE_FILE];
    const project = composeProject();
    if (project.name) args.push("-p", project.name);
    return args;
}

function compose(args, options = {}) {
    return execFileSync("docker", [...composeArgs(), ...args], {
        cwd: ROOT,
        stdio: "inherit",
        env: environment(),
        ...options,
    });
}

/** The environment children inherit, with the resolved instance settings made explicit. */
function environment(extra = {}) {
    const resolved = {
        ...process.env,
        E2E_CONTAINER: containerName(),
        E2E_HA_PORT: haPort(),
        E2E_HA_URL: haUrl(),
        ...extra,
    };
    const project = composeProject();
    if (project.name) resolved.COMPOSE_PROJECT_NAME = project.name;
    return resolved;
}

function describeInstance() {
    const project = composeProject();
    const projectLabel = project.name ? `${project.name} (${project.source})` : "compose default";
    return `${haUrl()} [container ${containerName()}, compose project ${projectLabel}]`;
}

async function request(pathname, options = {}, { base = haUrl(), timeoutMs = 15_000 } = {}) {
    const response = await fetch(`${base}${pathname}`, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        body = text;
    }
    return { status: response.status, body };
}

async function tokenStatus(token, { base = haUrl() } = {}) {
    if (!token) return 0;
    try {
        const { status } = await request("/api/", { headers: { authorization: `Bearer ${token}` } }, { base });
        return status;
    } catch {
        return 0;
    }
}

function readToken() {
    if (!fs.existsSync(TOKEN_FILE)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    } catch {
        return undefined;
    }
}

function writeToken(body) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(
        TOKEN_FILE,
        JSON.stringify({ access_token: body.access_token, refresh_token: body.refresh_token }, null, 2),
    );
}

function staleSessionError(detail) {
    return new Error(
        `the saved Home Assistant session in test/e2e/.auth/token.json is not accepted by ${haUrl()} ` +
            `(${detail}). Run \`${FRESH_COMMAND}\` to reset and re-authenticate the whole instance, ` +
            `or \`node test/e2e/setup.cjs\` if only the session was lost.`,
    );
}

/** Exchanges a saved refresh token for an access token; undefined when the instance refuses it. */
async function refreshAccessToken(refreshToken, { base = haUrl() } = {}) {
    try {
        const refreshed = await request(
            "/auth/token",
            {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                    client_id: `${base}/`,
                }).toString(),
            },
            { base },
        );
        if (refreshed.status === 200 && refreshed.body?.access_token) return refreshed.body.access_token;
    } catch {
        // An unreachable instance or a dropped connection: the caller decides what that means.
    }
    return undefined;
}

/**
 * The saved session's access token for this instance, or undefined when the instance accepts
 * neither the refresh token nor the access token (another instance, an expired session, or no
 * instance answering). The refresh token is tried first, as the frontend does: access tokens expire
 * after 30 minutes, and a refresh rotates the stored access token so the file stays usable.
 */
async function savedAccessToken({ base = haUrl() } = {}) {
    const saved = readToken();
    if (!saved?.access_token) return undefined;
    if (saved.refresh_token) {
        const refreshed = await refreshAccessToken(saved.refresh_token, { base });
        if (refreshed) {
            writeToken({ access_token: refreshed, refresh_token: saved.refresh_token });
            return refreshed;
        }
    }
    if ((await tokenStatus(saved.access_token, { base })) === 200) return saved.access_token;
    return undefined;
}

/**
 * Resolves the access token for a script that must not re-authenticate by itself (the websocket
 * helpers): the saved session, refreshed first; a rejected session fails with the reset command
 * instead of a login-page hang. `ensureSession` is the one that falls back to the credentials.
 */
async function freshAccessToken({ base = haUrl() } = {}) {
    if (!readToken()?.access_token) {
        throw new Error(
            `no saved Home Assistant session in test/e2e/.auth/token.json. Run \`${FRESH_COMMAND}\` ` +
                `(or \`node test/e2e/setup.cjs\` against ${base}).`,
        );
    }
    const token = await savedAccessToken({ base });
    if (token) return token;
    throw staleSessionError("the refresh token and the access token were both refused, or the instance did not answer");
}

/** Forgets the saved session; the next `ensureSession` signs in again. */
function removeToken() {
    fs.rmSync(TOKEN_FILE, { force: true });
}

/** Hex SHA-256 of a Buffer or string: the byte-identity check between dist/ and what HA serves. */
function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Waits until Home Assistant answers HTTP (the onboarding API is available on a fresh instance). */
async function waitForApi({ timeoutMs = 180_000, intervalMs = 1_000, base = haUrl() } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = "no response";
    while (Date.now() < deadline) {
        try {
            const { status } = await request("/api/", {}, { base, timeoutMs: 5_000 });
            if (status === 200 || status === 401) return status;
            last = `HTTP ${status}`;
        } catch (error) {
            last = error?.cause?.code || error?.message || String(error);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Home Assistant at ${base} did not answer /api/ within ${timeoutMs / 1000}s (${last})`);
}

async function createOwner() {
    const base = haUrl();
    const clientId = `${base}/`;
    const created = await request("/api/onboarding/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            client_id: clientId,
            name: "E2E",
            username: USERNAME,
            password: PASSWORD,
            language: "en",
        }),
    });
    if (created.status !== 200)
        throw new Error(`onboarding/users failed: ${created.status} ${JSON.stringify(created.body)}`);

    const token = await request("/auth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: created.body.auth_code,
            client_id: clientId,
        }).toString(),
    });
    if (token.status !== 200) throw new Error(`auth/token failed: ${token.status} ${JSON.stringify(token.body)}`);

    const auth = {
        headers: { authorization: `Bearer ${token.body.access_token}`, "content-type": "application/json" },
    };
    await request("/api/onboarding/core_config", { method: "POST", ...auth, body: "{}" });
    await request("/api/onboarding/analytics", { method: "POST", ...auth, body: "{}" });
    await request("/api/onboarding/integration", {
        method: "POST",
        ...auth,
        body: JSON.stringify({ client_id: clientId, redirect_uri: `${base}/?auth_callback=1` }),
    });
    writeToken(token.body);
    console.log("onboarding complete");
    return token.body.access_token;
}

async function loginWithCredentials() {
    const base = haUrl();
    const clientId = `${base}/`;
    const flow = await request("/auth/login_flow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            client_id: clientId,
            handler: ["homeassistant", null],
            redirect_uri: `${base}/?auth_callback=1`,
        }),
    });
    if (flow.status !== 200) throw new Error(`login_flow failed: ${flow.status} ${JSON.stringify(flow.body)}`);
    const step = await request(`/auth/login_flow/${flow.body.flow_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, username: USERNAME, password: PASSWORD }),
    });
    if (step.status !== 200 || !step.body.result)
        throw new Error(
            `login with the e2e credentials failed: ${step.status} ${JSON.stringify(step.body)}. ` +
                `The instance was created with other credentials; run \`${FRESH_COMMAND}\`.`,
        );
    const token = await request("/auth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: step.body.result,
            client_id: clientId,
        }).toString(),
    });
    if (token.status !== 200) throw new Error(`auth/token failed: ${token.status}`);
    writeToken(token.body);
    console.log("logged in with the e2e credentials");
    return token.body.access_token;
}

/**
 * Returns a token for the instance, re-authenticating when the saved session is stale.
 *
 * - The saved refresh token (then the saved access token) is accepted: reused, refreshed.
 * - Both refused by an onboarded instance: credentials login issues a new token.
 * - Both refused by a fresh instance: onboarding creates the owner and its token.
 *
 * The caller is responsible for the parts that need an already prepared instance (dashboards,
 * installed card): a fresh instance with a stale token still self-heals its session, then fails
 * with the documented fresh command if those are missing.
 */
async function ensureSession({ timeoutMs = 180_000 } = {}) {
    await waitForApi({ timeoutMs });
    // The saved session first: its refresh token (then its access token) against this instance.
    const existing = await savedAccessToken();
    if (existing) return existing;

    // Refused by this instance: the file belongs to one that was reset or recreated. Drop it and
    // authenticate with the e2e credentials; the token file is rewritten on success.
    if (readToken()) {
        console.warn(`the saved session is not accepted by ${haUrl()}; signing in with the e2e credentials`);
    }
    removeToken();
    let steps;
    try {
        steps = await request("/api/onboarding");
    } catch {
        steps = { status: 0 };
    }
    const userStep =
        steps.status === 200 && Array.isArray(steps.body) ? steps.body.find(step => step.step === "user") : undefined;
    if (userStep && !userStep.done) return await createOwner();
    return await loginWithCredentials();
}

/**
 * A websocket client that settles every command and rejects `auth_invalid` instead of hanging.
 */
function connectWebSocket(token, { base = haUrl(), timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/websocket`);
        let id = 0;
        const pending = new Map();
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`Home Assistant at ${base} did not complete the websocket authentication`));
        }, timeoutMs);
        const send = (type, payload = {}) =>
            new Promise((resolveCall, rejectCall) => {
                const messageId = ++id;
                pending.set(messageId, { resolve: resolveCall, reject: rejectCall, type });
                socket.send(JSON.stringify({ id: messageId, type, ...payload }));
            });
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.type === "auth_required") {
                socket.send(JSON.stringify({ type: "auth", access_token: token }));
            } else if (message.type === "auth_ok") {
                clearTimeout(timer);
                resolve({ send, close: () => socket.close() });
            } else if (message.type === "auth_invalid") {
                clearTimeout(timer);
                reject(staleSessionError(`websocket auth_invalid: ${message.message ?? "rejected"}`));
            } else if (message.type === "result") {
                const call = pending.get(message.id);
                if (!call) return;
                pending.delete(message.id);
                if (message.success) call.resolve(message.result);
                else call.reject(new Error(`${call.type}: ${JSON.stringify(message.error)}`));
            }
        };
        socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`websocket error connecting to ${base}`));
        };
    });
}

module.exports = {
    ROOT,
    E2E_DIR,
    COMPOSE_FILE,
    CONFIG_DIR,
    AUTH_DIR,
    TOKEN_FILE,
    ARTIFACTS,
    BUNDLE,
    USERNAME,
    PASSWORD,
    FRESH_COMMAND,
    containerName,
    haPort,
    haUrl,
    composeProject,
    composeArgs,
    compose,
    environment,
    describeInstance,
    describeEnvironment: describeInstance,
    request,
    tokenStatus,
    readToken,
    writeToken,
    removeToken,
    sha256,
    refreshAccessToken,
    savedAccessToken,
    freshAccessToken,
    waitForApi,
    ensureSession,
    connectWebSocket,
    staleSessionError,
    portIsCustom,
};
