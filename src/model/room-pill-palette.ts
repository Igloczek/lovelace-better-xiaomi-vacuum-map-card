/**
 * Colours of the selected-room pill (badge + room name), resolved so the text is always readable.
 *
 * The card reads the theme's colours from CSS custom properties, and a theme (or a user override)
 * can pair colours that are unreadable together, such as a dark name on a dark pill. Every pair the
 * pill draws text with is therefore checked against WCAG AA for normal text (4.5:1); a pair that
 * falls short gets black or white text, whichever reads better. Pure, so it can be tested without a
 * browser.
 */

export type Rgb = [number, number, number];

/** WCAG 2.x AA contrast for normal-size text. */
export const WCAG_AA_TEXT_CONTRAST = 4.5;

/** WCAG 2.x contrast for non-text UI parts (a badge against the pill around it). */
const WCAG_UI_CONTRAST = 3;

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/** Used when a theme colour cannot be read: Home Assistant's default light card, text and accent. */
const DEFAULT_BACKGROUND: Rgb = WHITE;
const DEFAULT_TEXT: Rgb = [0x21, 0x21, 0x21];
const DEFAULT_BADGE: Rgb = [0x03, 0xa9, 0xf4];

const NAMED: Record<string, Rgb> = { white: WHITE, black: BLACK };

/**
 * Reads a colour as a computed custom property returns it: `#rgb`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()`/`rgba()` in comma or space syntax, `white` or `black`. Alpha is dropped: the pill is
 * drawn opaque. Anything else is undefined, so the caller can fall back.
 */
export function parseCssColor(value: string | undefined): Rgb | undefined {
    const text = (value ?? "").trim().toLowerCase();
    if (!text) return undefined;
    if (text in NAMED) return [...NAMED[text]] as Rgb;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
    if (hex) {
        const digits = hex[1].length === 3 ? hex[1].split("").map(d => d + d).join("") : hex[1].slice(0, 6);
        return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
    }
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(text);
    if (rgb) {
        const channels = rgb.slice(1, 4).map(Number);
        if (channels.every(c => Number.isFinite(c) && c >= 0 && c <= 255)) return channels.map(Math.round) as Rgb;
    }
    return undefined;
}

function channel(value: number): number {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

/** `preferred` when it reads on `background`, otherwise black or white, whichever reads better. */
function readableOn(background: Rgb, preferred: Rgb | undefined): Rgb {
    if (preferred && contrastRatio(preferred, background) >= WCAG_AA_TEXT_CONTRAST) return preferred;
    // One of black and white always reaches at least 4.58:1 on any colour.
    return contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE;
}

export interface RoomPillColours {
    /** The pill's body. */
    background: string;
    /** The room name. */
    text: string;
    /** The badge disc. */
    badge: string;
    /** The badge's number or checkmark; derived from the badge colour when not given. */
    badgeText?: string;
}

export interface RoomPillPalette {
    background: Rgb;
    text: Rgb;
    /** The pill's hairline edge, drawn from the text colour at low opacity. */
    ring: Rgb;
    badge: Rgb;
    badgeText: Rgb;
    /** True when the badge needs a ring to stand out from the pill body (below 3:1). */
    badgeRing: boolean;
}

/**
 * The badge colour with a white glyph: the colour itself when white already reads on it at 4.5:1,
 * otherwise the same hue darkened just enough. A white glyph on a vivid badge is the look the
 * vendor app goes for; deepening keeps that look without the unreadable light-blue badge.
 */
function deepenForWhite(badge: Rgb): Rgb {
    for (let factor = 1; factor >= 0; factor -= 0.01) {
        const shade = badge.map(channel => Math.round(channel * factor)) as Rgb;
        if (contrastRatio(WHITE, shade) >= WCAG_AA_TEXT_CONTRAST) return shade;
    }
    return BLACK;
}

/** Resolves the pill's colours from the raw theme values, correcting any unreadable pair. */
export function resolveRoomPillPalette(colours: RoomPillColours): RoomPillPalette {
    const background = parseCssColor(colours.background) ?? DEFAULT_BACKGROUND;
    const text = readableOn(background, parseCssColor(colours.text) ?? DEFAULT_TEXT);
    const themeBadge = parseCssColor(colours.badge) ?? DEFAULT_BADGE;
    const explicitGlyph = parseCssColor(colours.badgeText);
    // An explicit glyph colour is kept (and corrected only if unreadable); otherwise the glyph is
    // white and the badge is deepened under it.
    const badge = explicitGlyph ? themeBadge : deepenForWhite(themeBadge);
    const badgeText = explicitGlyph ? readableOn(badge, explicitGlyph) : WHITE;
    return {
        background,
        text,
        ring: text,
        badge,
        badgeText,
        badgeRing: contrastRatio(badge, background) < WCAG_UI_CONTRAST,
    };
}

export function cssRgb([r, g, b]: Rgb): string {
    return `rgb(${r}, ${g}, ${b})`;
}
