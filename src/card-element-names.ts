import { CARD_CUSTOM_ELEMENT_NAME, LEGACY_CARD_CUSTOM_ELEMENT_NAME, UPSTREAM_SEEN_KEY } from "./const";
import { migrateLegacyStorage, type StorageLike } from "./model/storage-migration";

/**
 * Registration of the card's element names.
 *
 * The fork registers its own names so it can be installed next to the upstream card. The upstream
 * name is kept as a compatibility alias, but only when there is evidence that the upstream card is
 * not going to register it: Lit's `@customElement` throws when a name is already defined, so
 * registering the alias while upstream is present would break the upstream card.
 *
 * A URL is not evidence. The repository was renamed, but the Marketplace folder and the resource
 * path were not: this card itself is served from
 * `/local/community/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js`, and an upgrade can
 * leave a second row there pointing at the deleted file next to the working one. Neither can be
 * judged by its path. The decision therefore reads what the resources did: an element that is
 * already registered wins, a resource whose fetch failed cannot register anything, and a resource
 * that loaded is given a bounded chance to register the element before the fork takes the name.
 */

/** The subset of `CustomElementRegistry` the alias decision needs, so a test can supply a fake. */
export interface CustomElementRegistryLike {
    get(name: string): CustomElementConstructor | undefined;
    define(name: string, constructor: CustomElementConstructor): void;
    whenDefined?(name: string): Promise<CustomElementConstructor>;
}

/** The subset of `HTMLScriptElement` the decision reads. */
export interface ScriptLike {
    src: string;
    addEventListener?(type: "load" | "error", listener: (event: Event) => void, options?: { once?: boolean }): void;
}

/** The part of a Resource Timing entry that tells a failed fetch from a delivered one. */
export interface ResourceTimingLike {
    /** The HTTP status, where the browser exposes it (`PerformanceResourceTiming.responseStatus`). */
    responseStatus?: number;
}

/** Reads the Resource Timing entry of a URL, or `undefined` while the fetch is still in flight. */
export type ResourceTimingReader = (url: string) => ResourceTimingLike | undefined;

/**
 * Asks whether a resource URL is served (`true`), missing (`false`) or unknown (`undefined`). Used
 * only when the browser exposes neither the script's `load`/`error` event in time nor a Resource
 * Timing `responseStatus` (Safari, iOS and older Firefox), so a dead resource row is told apart from
 * a loaded upstream bundle without waiting for the grace period.
 */
export type ResourceProbe = (url: string) => Promise<boolean | undefined>;

async function probeResource(url: string): Promise<boolean | undefined> {
    if (typeof fetch !== "function") return undefined;
    try {
        // The script was just fetched, so this is normally answered from the HTTP cache.
        const response = await fetch(url, { method: "HEAD", cache: "force-cache", credentials: "same-origin" });
        return response.ok;
    } catch {
        return undefined;
    }
}

/** Calls `onScript` for every `<script>` appended to the document after the subscription starts. */
export type ScriptObserver = (onScript: (script: ScriptLike) => void) => () => void;

const UPSTREAM_ELEMENT_SEGMENT = "xiaomi-vacuum-map-card";

/**
 * How long a resource that loaded but did not register the upstream element may take to do it.
 *
 * A `<script type="module">` fires `load` only after it has been evaluated, so a bundle that
 * registers the element itself has already done so when it settles. The wait is for a wrapper or a
 * proxy that imports the card asynchronously; that resolves within a task or two of the wrapper's
 * own evaluation. Two seconds is well past that, and short enough that a legacy
 * `custom:xiaomi-vacuum-map-card` card, which Home Assistant rebuilds when the alias registers,
 * does not visibly wait.
 */
export const UPSTREAM_DEFINE_GRACE_MS = 2_000;

/**
 * How long a resource whose fetch never settles may hold the alias back.
 *
 * A same-origin Home Assistant asset settles in milliseconds; this cap only stops a stalled request
 * (an unreachable CDN, a proxy that never answers) from leaving legacy cards unrendered forever.
 * The alias is defined once it expires, exactly as if the resource had failed.
 */
export const UPSTREAM_SCRIPT_SETTLE_MS = 10_000;

/** A resource URL without its cache-buster, lower-cased for a path comparison. */
export function resourcePath(url: string): string {
    let path: string;
    try {
        path = new URL(url, "http://localhost/").pathname.toLowerCase();
    } catch {
        path = url.split(/[?#]/)[0].toLowerCase();
    }
    // The installer serves the same file as `/hacsfiles/<repo>/…` and `/local/community/<repo>/…`
    // (one redirects to the other), so both spell one resource.
    return path.replace(/^\/hacsfiles\//, "/local/community/");
}

/**
 * Whether a script is a resource that could register the upstream element name.
 *
 * This is only a heuristic that narrows what to watch: `/hacsfiles/lovelace-xiaomi-vacuum-map-card/
 * xiaomi-vacuum-map-card.js`, a manual `/local/xiaomi-vacuum-map-card.js`, or a bundle built from
 * it. It is never evidence on its own: the fork's own Marketplace install is served from
 * `/local/community/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js` (the folder keeps the
 * repository's pre-rename name), which is upstream's path word for word. The executing bundle is
 * therefore excluded by its own URL, which is `import.meta.url`, and every remaining candidate is
 * judged by what it does — `customElements.get`, its `load`/`error` event and its Resource Timing
 * entry — not by its path. A renamed or proxied upstream bundle does not match this heuristic at
 * all; `watchForAliasCollision` covers the case where it registers after the alias.
 */
export function upstreamCandidateScripts(
    ownUrl: string,
    scripts: ArrayLike<ScriptLike> = document.scripts,
): ScriptLike[] {
    const ownPath = resourcePath(ownUrl);
    const candidates: ScriptLike[] = [];
    for (let index = 0; index < scripts.length; index++) {
        const script = scripts[index];
        const src = script?.src;
        if (!src) continue;
        const path = resourcePath(src);
        if (path === ownPath) continue;
        if (path.includes(UPSTREAM_ELEMENT_SEGMENT)) candidates.push(script);
    }
    return candidates;
}

function readResourceTiming(url: string): ResourceTimingLike | undefined {
    if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") return undefined;
    const entries = performance.getEntriesByName(url, "resource") as PerformanceResourceTiming[];
    const entry = entries[entries.length - 1];
    if (!entry) return undefined;
    return { responseStatus: (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus };
}

function observeNewScripts(onScript: (script: ScriptLike) => void): () => void {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => undefined;
    // Home Assistant appends resource scripts to `document.body`; other loaders use `head`. Only the
    // direct children are watched, so the observer stays cheap on a busy dashboard.
    const roots = [document.head, document.body].filter((root): root is HTMLElement => !!root);
    if (roots.length === 0) return () => undefined;
    const observer = new MutationObserver(records => {
        for (const record of records) {
            record.addedNodes.forEach(node => {
                const element = node as Element;
                if (element?.localName !== "script") return;
                const src = (node as HTMLScriptElement).src;
                if (src) onScript(node as unknown as ScriptLike);
            });
        }
    });
    roots.forEach(root => observer.observe(root, { childList: true }));
    return () => observer.disconnect();
}

/**
 * Whether this page may register the upstream name as an alias of this card.
 *
 * The evidence, in order:
 *
 * - `customElements.get("xiaomi-vacuum-map-card")` already returns an element: someone else owns
 *   the name (an upstream bundle, or another copy of this fork), so it is left alone.
 * - Every candidate resource failed (an `error` event, or a Resource Timing entry with a 4xx/5xx
 *   `responseStatus`): nothing can register the name, so the alias is free.
 * - No candidate at all: the alias is free.
 * - A candidate loaded: it had its chance while it was evaluated. Wait for
 *   `customElements.whenDefined` for `UPSTREAM_DEFINE_GRACE_MS`, so a wrapper that imports the card
 *   asynchronously is not pre-empted, then take the name if it is still undefined.
 *
 * The function is resolved by an event (a `load`/`error` on a candidate, a new `<script>`, or the
 * element being registered), not by polling.
 */
export async function decideLegacyCardAlias(options: {
    ownUrl: string;
    registry?: CustomElementRegistryLike;
    /** Read again on every wake, so a resource added while waiting is included. */
    scripts?: () => ArrayLike<ScriptLike>;
    readResourceTiming?: ResourceTimingReader;
    observeScripts?: ScriptObserver;
    probeResource?: ResourceProbe;
    graceMs?: number;
    settleMs?: number;
}): Promise<boolean> {
    const registry = options.registry ?? customElements;
    const readScripts = options.scripts ?? (() => document.scripts);
    const readTiming = options.readResourceTiming ?? readResourceTiming;
    const observe = options.observeScripts ?? observeNewScripts;
    const probe = options.probeResource ?? probeResource;
    const graceMs = options.graceMs ?? UPSTREAM_DEFINE_GRACE_MS;
    const settleMs = options.settleMs ?? UPSTREAM_SCRIPT_SETTLE_MS;

    if (registry.get(LEGACY_CARD_CUSTOM_ELEMENT_NAME)) return false;

    const scripts = new Map<string, ScriptLike>();
    const failed = new Set<string>();
    const loaded = new Set<string>();
    const watched = new WeakSet<ScriptLike>();
    const probed = new Set<string>();
    const startedAt = Date.now();
    let graceDeadline: number | undefined;
    let revision = 0;
    let wake: (() => void) | undefined;

    const notify = (): void => {
        revision += 1;
        const resolve = wake;
        wake = undefined;
        resolve?.();
    };
    const stateOf = (path: string): "failed" | "loaded" | "pending" => {
        if (failed.has(path)) return "failed";
        if (loaded.has(path)) return "loaded";
        const script = scripts.get(path);
        const timing = script ? readTiming(script.src) : undefined;
        if (typeof timing?.responseStatus === "number") {
            if (timing.responseStatus >= 400) {
                failed.add(path);
                return "failed";
            }
            loaded.add(path);
            return "loaded";
        }
        // No status from the browser: ask the server once instead of assuming the script loaded,
        // which would make a dead resource row cost the whole grace period on every load.
        if (script && !probed.has(path)) {
            probed.add(path);
            void probe(script.src).then(served => {
                if (served === false) failed.add(path);
                else loaded.add(path);
                notify();
            });
        }
        return "pending";
    };
    const changed = (seen: number): Promise<void> => {
        if (revision !== seen) return Promise.resolve();
        return new Promise(resolve => {
            wake = resolve;
        });
    };
    const defined = (): Promise<void> => {
        if (!registry.whenDefined) return new Promise(() => undefined);
        return registry.whenDefined(LEGACY_CARD_CUSTOM_ELEMENT_NAME).then(
            () => undefined,
            () => undefined,
        );
    };

    const stopObserving = observe(notify);
    try {
        for (;;) {
            if (registry.get(LEGACY_CARD_CUSTOM_ELEMENT_NAME)) return false;
            for (const script of upstreamCandidateScripts(options.ownUrl, readScripts())) {
                const path = resourcePath(script.src);
                scripts.set(path, script);
                if (watched.has(script)) continue;
                watched.add(script);
                if (typeof script.addEventListener !== "function") continue;
                script.addEventListener(
                    "error",
                    () => {
                        failed.add(path);
                        notify();
                    },
                    { once: true },
                );
                script.addEventListener(
                    "load",
                    () => {
                        loaded.add(path);
                        notify();
                    },
                    { once: true },
                );
            }

            const live = [...scripts.keys()].filter(path => stateOf(path) !== "failed");
            if (live.length === 0) return true;

            const pending = live.filter(path => stateOf(path) === "pending");
            const now = Date.now();
            if (pending.length === 0 && graceDeadline === undefined) graceDeadline = now + graceMs;
            const deadline = pending.length > 0 ? startedAt + settleMs : (graceDeadline as number);
            if (now >= deadline) return true;

            const seen = revision;
            await Promise.race([
                defined(),
                changed(seen),
                new Promise<void>(resolve => setTimeout(resolve, deadline - now)),
            ]);
        }
    } finally {
        stopObserving();
    }
}

/**
 * Registers `LEGACY_CARD_CUSTOM_ELEMENT_NAME` as a trivial subclass, so an existing dashboard with
 * `type: custom:xiaomi-vacuum-map-card` renders this card. Returns whether it registered.
 *
 * A subclass, not the class itself, so the two names stay independent elements with their own
 * `HTMLElementTagNameMap` entries; it inherits the editor and stub config, so Home Assistant's card
 * editor works for a legacy card too. The registry is checked again here: a renamed upstream bundle
 * that registered the name while the decision waited keeps it, and a failed `define` never escapes
 * into the fork's module.
 */
export function defineLegacyCardAlias(
    cardClass: CustomElementConstructor,
    options: { registry?: CustomElementRegistryLike } = {},
): boolean {
    const registry = options.registry ?? customElements;
    if (registry.get(LEGACY_CARD_CUSTOM_ELEMENT_NAME)) return false;
    try {
        registry.define(LEGACY_CARD_CUSTOM_ELEMENT_NAME, class extends (cardClass as typeof HTMLElement) {});
        return true;
    } catch {
        // Another module registered the name between the check and the define.
        return false;
    }
}

/** The warning for a resource that arrives after the alias is registered, or fails to define. */
function lateUpstreamWarning(detail: string): string {
    return (
        `Better Xiaomi Vacuum Map Card: ${detail}\n` +
        `"${LEGACY_CARD_CUSTOM_ELEMENT_NAME}" is already registered by ` +
        `"${CARD_CUSTOM_ELEMENT_NAME}" as a compatibility alias. Only the first definition of a ` +
        `custom element name is used, so the Xiaomi Vacuum Map Card bundle cannot register its own ` +
        `element and its cards will not render. Give this card "type: custom:${CARD_CUSTOM_ELEMENT_NAME}", ` +
        `or remove one of the two dashboard resources and reload. See ` +
        `docs/configuration.md#migrating-from-customxiaomi-vacuum-map-card.`
    );
}

/**
 * Warns when an upstream card resource is appended after the alias is registered.
 *
 * Home Assistant's resource editor appends one script to a running session, and it does not re-run
 * the resource list through this bundle. The alias cannot be withdrawn (a custom element name
 * cannot be unregistered), so the fork says what happened and what to do instead of leaving a
 * silently missing card.
 */
export function watchLateUpstreamScripts(options: {
    ownUrl: string;
    warn?: (message: string) => void;
    observeScripts?: ScriptObserver;
    readResourceTiming?: ResourceTimingReader;
}): () => void {
    const warn = options.warn ?? ((message: string) => console.warn(message));
    const observe = options.observeScripts ?? observeNewScripts;
    const readTiming = options.readResourceTiming ?? readResourceTiming;
    const reported = new Set<string>();
    const report = (src: string): void => {
        if (reported.has(src)) return;
        reported.add(src);
        warn(lateUpstreamWarning(`the Xiaomi Vacuum Map Card resource "${src}" was added after this card ran.`));
    };
    return observe(script => {
        const candidates = upstreamCandidateScripts(options.ownUrl, [script]);
        if (candidates.length === 0) return;
        const timing = readTiming(script.src);
        if (typeof timing?.responseStatus === "number" && timing.responseStatus >= 400) return;
        if (typeof script.addEventListener !== "function") {
            report(script.src);
            return;
        }
        script.addEventListener("load", () => report(script.src), { once: true });
    });
}

const DEFINE_COLLISION = /already (?:been )?(?:used|defined)/i;

/**
 * Warns once when a later bundle fails to register the upstream name.
 *
 * This is the only evidence available for an upstream bundle whose URL does not name the card (a
 * renamed file, a wrapper, a CDN path): the browser reports its unguarded `customElements.define`
 * as an uncaught error naming the element. `customElements.define` is not wrapped, because a page-
 * wide patch would change the registry for every other card.
 */
export function watchForAliasCollision(
    warn: (message: string) => void = message => console.warn(message),
    target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined"
        ? undefined
        : window,
): () => void {
    if (!target) return () => undefined;
    let warned = false;
    const listener = (event: Event): void => {
        if (warned) return;
        const message = (event as ErrorEvent).message ?? "";
        if (!message.includes(LEGACY_CARD_CUSTOM_ELEMENT_NAME) || !DEFINE_COLLISION.test(message)) return;
        warned = true;
        warn(lateUpstreamWarning("a bundle tried to register the Xiaomi Vacuum Map Card element."));
    };
    target.addEventListener("error", listener);
    return () => target.removeEventListener("error", listener);
}

export interface LegacyAliasInstallOptions {
    ownUrl: string;
    probeResource?: ResourceProbe;
    registry?: CustomElementRegistryLike;
    storage?: StorageLike;
    scripts?: () => ArrayLike<ScriptLike>;
    readResourceTiming?: ResourceTimingReader;
    observeScripts?: ScriptObserver;
    graceMs?: number;
    settleMs?: number;
    warn?: (message: string) => void;
    /** The window that reports a later bundle's define failure; a test supplies its own target. */
    collisionTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/**
 * Decides, registers and, only when the alias is registered, migrates the stored view and run.
 *
 * The storage keys moved from the upstream names to the fork's names. Copying them while the
 * upstream card is installed would hand its state to this card, so the migration follows exactly
 * the alias decision: it runs when the fork takes the upstream name, and never otherwise.
 *
 * One more task separates the decision from the registration. During the first dashboard load Home
 * Assistant appends every resource's script before any of them runs, so the fork already sees the
 * whole list; the task lets a renamed upstream bundle from the same batch register first, and the
 * guarded define leaves it the name.
 */
export async function installLegacyCardAlias(
    cardClass: CustomElementConstructor,
    options: LegacyAliasInstallOptions,
): Promise<boolean> {
    if (typeof window === "undefined") return false;
    const registry = options.registry ?? customElements;
    const shouldDefine = await decideLegacyCardAlias({ ...options, registry });
    if (!shouldDefine) {
        // Another bundle owns the upstream name. Remember it, so a later visit after that card is
        // removed does not copy its stored view and run into this card's keys.
        if (registry.get(LEGACY_CARD_CUSTOM_ELEMENT_NAME)) {
            try {
                (options.storage ?? window.localStorage).setItem(UPSTREAM_SEEN_KEY, "1");
            } catch {
                // Blocked storage: nothing to remember, nothing will be migrated either.
            }
        }
        return false;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!defineLegacyCardAlias(cardClass, { registry })) return false;
    try {
        migrateLegacyStorage(options.storage ?? window.localStorage, true);
    } catch {
        // Blocked storage: the card still works without a remembered view or run.
    }
    watchLateUpstreamScripts(options);
    watchForAliasCollision(options.warn, options.collisionTarget);
    return true;
}
