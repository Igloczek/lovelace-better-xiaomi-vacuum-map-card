/**
 * Characters that take up no ink: white space, invisible format characters (zero-width space and
 * joiners, word joiner, bidi marks, the byte-order mark), control characters, and the blank glyphs
 * some keyboards and apps use as a "space that is not a space" (Hangul fillers, braille blank).
 */
const INVISIBLE = /^[\s\p{Z}\p{Cf}\p{Cc}ᅟᅠㅤﾠ⠀]*$/u;

/**
 * A name as it can be shown, or undefined when it has no visible character: a pill drawn around a
 * zero-width space is an empty pill (#133). Visible names are returned trimmed.
 */
export function visibleText(text: string | undefined | null): string | undefined {
    if (typeof text !== "string" || INVISIBLE.test(text)) return undefined;
    return text.trim();
}
