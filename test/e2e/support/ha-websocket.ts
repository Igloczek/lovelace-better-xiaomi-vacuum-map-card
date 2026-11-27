// @ts-expect-error -- a plain JavaScript module without declarations.
import { freshAccessToken as harnessFreshAccessToken } from "./harness.cjs";
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

/**
 * The saved session's access token for `base`, refreshed first, as the harness does. The harness
 * (`support/harness.cjs`) owns the session logic; a rejected session throws with the reset command.
 */
export function freshAccessToken(base: string = haUrl()): Promise<string> {
    return harnessFreshAccessToken({ base });
}

export async function connectRealHass(): Promise<RealHass> {
    const base = haUrl();
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
