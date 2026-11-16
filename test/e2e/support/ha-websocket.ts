import * as fs from "node:fs";
import * as path from "node:path";

import { haUrl } from "./instance";

/**
 * A minimal Home Assistant websocket client for specs that run card modules in Node against the
 * real instance. It exposes the two pieces of `hass` the service-call code uses:
 * `connection.subscribeMessage` (for `render_template`) and `callService`.
 */
export interface RealHass {
    connection: {
        subscribeMessage: (
            callback: (msg: Record<string, unknown>) => void,
            message: Record<string, unknown>,
        ) => Promise<() => Promise<void>>;
    };
    callService: (
        domain: string,
        service: string,
        serviceData?: Record<string, unknown>,
        target?: Record<string, unknown>,
    ) => Promise<unknown>;
    sendMessage: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
    close: () => void;
}

const AUTH_FILE = path.join(__dirname, "..", ".auth", "token.json");
const FRESH_HINT = "run `npm run test:e2e:fresh` (or `node test/e2e/setup.cjs`) to re-authenticate";

/**
 * An access token for the setup script's session. Access tokens expire after 30 minutes, so the
 * refresh token is exchanged first, as the frontend does; the stored access token is the fallback.
 *
 * A session from another instance is rejected by `GET /api/`; that becomes one clear error naming
 * the fresh command, instead of a websocket that never authenticates and a spec that times out.
 */
export async function freshAccessToken(base = haUrl()): Promise<string> {
    let saved: { access_token?: string; refresh_token?: string } | undefined;
    try {
        saved = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as { access_token?: string; refresh_token?: string };
    } catch {
        saved = undefined;
    }
    if (!saved?.access_token) {
        throw new Error(`no saved Home Assistant session in test/e2e/.auth/token.json; ${FRESH_HINT}`);
    }
    if (saved.refresh_token) {
        let failure = "";
        try {
            const response = await fetch(`${base}/auth/token`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: saved.refresh_token,
                    client_id: `${base}/`,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (response.ok) return ((await response.json()) as { access_token: string }).access_token;
            failure = `refresh returned HTTP ${response.status}`;
        } catch (error) {
            failure = `refresh failed: ${(error as Error).message}`;
        }
        if (failure) {
            console.warn(`the saved refresh token did not work (${failure}); checking the access token`);
        }
    }
    let status = 0;
    try {
        const response = await fetch(`${base}/api/`, {
            headers: { authorization: `Bearer ${saved.access_token}` },
            signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
    } catch {
        status = 0;
    }
    if (status === 200) return saved.access_token;
    throw new Error(
        `the saved Home Assistant session in test/e2e/.auth/token.json is not accepted by ${base} ` +
            `(GET /api/ returned ${status === 0 ? "no response" : `HTTP ${status}`}); ${FRESH_HINT}`,
    );
}

export async function connectRealHass(): Promise<RealHass> {
    const base = process.env.E2E_HA_URL || "http://localhost:8123";
    const token = await freshAccessToken(base);
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/websocket`);
    let nextId = 1;
    const pending = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: unknown) => void }>();
    const subscriptions = new Map<number, (event: Record<string, unknown>) => void>();

    await new Promise<void>((resolve, reject) => {
        socket.addEventListener("error", reject, { once: true });
        socket.addEventListener("message", event => {
            const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (msg.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
            else if (msg.type === "auth_ok") resolve();
            else if (msg.type === "auth_invalid") reject(new Error(String(msg.message)));
            else if (msg.type === "result") {
                const entry = pending.get(msg.id as number);
                pending.delete(msg.id as number);
                if (!entry) return;
                if (msg.success) entry.resolve(msg);
                else entry.reject(msg.error);
            } else if (msg.type === "event") {
                subscriptions.get(msg.id as number)?.(msg.event as Record<string, unknown>);
            }
        });
    });

    const sendMessage = (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ ...message, id }));
        });

    return {
        connection: {
            subscribeMessage: async (callback, message) => {
                const id = nextId;
                subscriptions.set(id, callback);
                try {
                    await sendMessage(message);
                } catch (e) {
                    subscriptions.delete(id);
                    throw e;
                }
                return async () => {
                    subscriptions.delete(id);
                    await sendMessage({ type: "unsubscribe_events", subscription: id }).catch(() => undefined);
                };
            },
        },
        callService: async (domain, service, serviceData, target) =>
            (
                await sendMessage({
                    type: "call_service",
                    domain,
                    service,
                    service_data: serviceData ?? {},
                    ...(target ? { target } : {}),
                })
            ).result,
        sendMessage,
        close: () => socket.close(),
    };
}
