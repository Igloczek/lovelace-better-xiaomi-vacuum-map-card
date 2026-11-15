import { LEGACY_CARD_CUSTOM_ELEMENT_NAME } from "./const";

/**
 * Registration of the card's element names.
 *
 * The fork registers its own names so it can be installed next to the upstream card. The upstream
 * name is kept as a compatibility alias, but only when the upstream bundle is not loaded: Lit's
 * `@customElement` throws when a name is already defined, so registering the alias while upstream is
 * present would break the upstream card.
 */

/** The subset of `CustomElementRegistry` the alias decision needs, so a test can supply a fake. */
export interface CustomElementRegistryLike {
    get(name: string): CustomElementConstructor | undefined;
    define(name: string, constructor: CustomElementConstructor): void;
}

/** The subset of `HTMLScriptElement` the decision reads. */
export interface ScriptLike {
    src: string;
}

const FORK_REPOSITORY_SEGMENT = "better-xiaomi-vacuum-map-card";
const UPSTREAM_ELEMENT_SEGMENT = "xiaomi-vacuum-map-card";

/** A resource URL without its cache-buster, lower-cased for a path comparison. */
export function resourcePath(url: string): string {
    try {
        return new URL(url, "http://localhost/").pathname.toLowerCase();
    } catch {
        return url.split(/[?#]/)[0].toLowerCase();
    }
}

/**
 * Whether a loaded dashboard resource could register the upstream element name.
 *
 * Home Assistant (`loadLovelaceResources`) appends a `<script>` for every dashboard resource before
 * any of them runs, so this module can see the complete resource list when it executes. Any other
 * module whose URL names the upstream card — the HACS path
 * `/hacsfiles/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js`, a manual
 * `/local/xiaomi-vacuum-map-card.js`, or any bundle built from it — may define the tag, so the fork
 * must leave it alone. Another copy of this fork is left out: it defines the alias itself (old
 * versions as their primary name), so yielding to it is equally safe.
 */
export function hasCompetingCardResource(ownUrl: string, scripts: ArrayLike<ScriptLike> = document.scripts): boolean {
    const ownPath = resourcePath(ownUrl);
    for (let index = 0; index < scripts.length; index++) {
        const src = scripts[index]?.src;
        if (!src) continue;
        const path = resourcePath(src);
        if (path === ownPath) continue;
        if (path.includes(FORK_REPOSITORY_SEGMENT)) continue;
        if (path.includes(UPSTREAM_ELEMENT_SEGMENT)) return true;
    }
    return false;
}

/** Whether this page may register the upstream name as an alias of this card. */
export function shouldDefineLegacyCardAlias(
    ownUrl: string,
    scripts: ArrayLike<ScriptLike> = document.scripts,
    registry: CustomElementRegistryLike = customElements,
): boolean {
    return !registry.get(LEGACY_CARD_CUSTOM_ELEMENT_NAME) && !hasCompetingCardResource(ownUrl, scripts);
}

/**
 * Registers `LEGACY_CARD_CUSTOM_ELEMENT_NAME` as a trivial subclass, so an existing dashboard with
 * `type: custom:xiaomi-vacuum-map-card` renders this card. Returns whether it registered.
 *
 * A subclass, not the class itself, so the two names stay independent elements with their own
 * `HTMLElementTagNameMap` entries; it inherits the editor and stub config, so Home Assistant's card
 * editor works for a legacy card too.
 */
export function defineLegacyCardAlias(
    cardClass: CustomElementConstructor,
    options: {
        ownUrl: string;
        scripts?: ArrayLike<ScriptLike>;
        registry?: CustomElementRegistryLike;
    },
): boolean {
    const scripts = options.scripts ?? document.scripts;
    const registry = options.registry ?? customElements;
    if (!shouldDefineLegacyCardAlias(options.ownUrl, scripts, registry)) return false;
    registry.define(LEGACY_CARD_CUSTOM_ELEMENT_NAME, class extends (cardClass as typeof HTMLElement) {});
    return true;
}

/**
 * Registers the alias in the next task, not while the bundle evaluates.
 *
 * Home Assistant's resource loader has already appended every resource's script by then, so waiting
 * one task cannot miss an upstream resource; it only lets a resource appended in the same turn be
 * seen. A legacy card Home Assistant creates before the alias exists is an unknown element; its
 * `customElements.whenDefined` handler fires `ll-rebuild` when this registers, exactly as it does for
 * a card whose resource loads late, so the card still renders.
 */
export function scheduleLegacyCardAlias(cardClass: CustomElementConstructor, ownUrl: string): void {
    if (typeof window === "undefined") return;
    window.setTimeout(() => defineLegacyCardAlias(cardClass, { ownUrl }), 0);
}
