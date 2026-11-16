import type { Locator, Page } from "@playwright/test";
import { PNG } from "pngjs";

/**
 * How far the letters of a pill's text sit from the top and the bottom of their container, in CSS
 * pixels, measured from the pixels on screen: a layout box says nothing about where a font draws
 * its glyphs inside it, which is how a name that every box check called centred sat about 2 px low
 * in Home Assistant's Roboto.
 *
 * `container` is the box the text must be centred in (the pill for a name, the disc for a badge
 * number) and `text` the element holding the letters; both are selectors inside the card's shadow
 * root. Only the middle half of the text's width is read, so the pill's rounded ends and the badge
 * never count. A pixel is ink when it is nearer the text colour than the container's background.
 * Pick a text without descenders (Bedroom): a descender legitimately reaches below the
 * baseline the text is centred on.
 */
/** CSS pixels left out at the container's top and bottom edge; added back to both gaps. */
const INSET = 2;

export async function inkGaps(
    page: Page,
    card: Locator,
    container: string,
    text: string,
): Promise<{ above: number; below: number }> {
    const area = await card.evaluate(
        (element: Element, input: { container: string; text: string; INSET: number }) => {
            const root = element.shadowRoot!;
            const box = root.querySelector(input.container)!;
            const letters = root.querySelector(input.text)!;
            const outer = box.getBoundingClientRect();
            const inner = letters.getBoundingClientRect();
            const colour = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
            return {
                // Inset from the container's edges: a round badge's anti-aliased rim blends into the
                // pill around it, which can be the text colour (a white number on a white pill).
                clip: {
                    x: inner.x + inner.width / 4,
                    y: outer.y + input.INSET,
                    width: inner.width / 2,
                    height: outer.height - 2 * input.INSET,
                },
                ink: colour(getComputedStyle(letters).color),
                background: colour(getComputedStyle(box).backgroundColor),
            };
        },
        { container, text, INSET },
    );
    const png = PNG.sync.read(await page.screenshot({ clip: area.clip, animations: "disabled" }));
    const scale = png.height / area.clip.height;
    const distance = (pixel: number[], target: number[]): number =>
        Math.hypot(pixel[0] - target[0], pixel[1] - target[1], pixel[2] - target[2]);
    let first = -1;
    let last = -1;
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const index = (y * png.width + x) * 4;
            const pixel = [png.data[index], png.data[index + 1], png.data[index + 2]];
            if (distance(pixel, area.ink) < distance(pixel, area.background) * 0.6) {
                if (first < 0) first = y;
                last = y;
                break;
            }
        }
    }
    if (first < 0) throw new Error(`no ink found for ${text} in ${container}: ${JSON.stringify(area)}`);
    return { above: first / scale + INSET, below: (png.height - 1 - last) / scale + INSET };
}
