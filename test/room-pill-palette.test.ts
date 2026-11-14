import { describe, expect, it } from "vitest";

import {
    contrastRatio,
    parseCssColor,
    relativeLuminance,
    resolveRoomPillPalette,
    WCAG_AA_TEXT_CONTRAST,
} from "../src/model/room-pill-palette";

/**
 * The selected-room pill must stay readable in every theme: its name against its background, and
 * the badge's glyph against the badge, at WCAG AA (4.5:1). The palette is resolved from the theme's
 * CSS custom properties; a pair that would fall short is corrected rather than shown.
 */

const HA_LIGHT = { background: "#ffffff", text: "#212121", badge: "#03a9f4" };
const HA_DARK = { background: "#1c1c1c", text: "#e1e1e1", badge: "#03a9f4" };

describe("contrastRatio", () => {
    it("matches the WCAG reference values", () => {
        expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
        expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
        // #767676 on white is the classic 4.54:1 boundary colour.
        expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
    });
});

describe("parseCssColor", () => {
    it("reads the forms a computed custom property can take", () => {
        expect(parseCssColor("#fff")).toEqual([255, 255, 255]);
        expect(parseCssColor(" #03a9f4 ")).toEqual([3, 169, 244]);
        expect(parseCssColor("#03a9f4ff")).toEqual([3, 169, 244]);
        expect(parseCssColor("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
        expect(parseCssColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
        expect(parseCssColor("rgb(1 2 3 / 50%)")).toEqual([1, 2, 3]);
        expect(parseCssColor("white")).toEqual([255, 255, 255]);
        expect(parseCssColor("black")).toEqual([0, 0, 0]);
    });

    it("returns undefined for what it cannot read", () => {
        for (const value of ["", "var(--x)", "hsl(1, 2%, 3%)", "#12", "transparent", "not-a-colour"]) {
            expect(parseCssColor(value), value).toBeUndefined();
        }
    });
});

function check(palette: ReturnType<typeof resolveRoomPillPalette>): void {
    expect(contrastRatio(palette.text, palette.background)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    expect(contrastRatio(palette.badgeText, palette.badge)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
}

describe("resolveRoomPillPalette", () => {
    it("meets AA with Home Assistant's default light and dark themes", () => {
        for (const theme of [HA_LIGHT, HA_DARK]) {
            const palette = resolveRoomPillPalette(theme);
            check(palette);
            // The theme's own pair is kept when it is readable.
            expect(palette.background).toEqual(parseCssColor(theme.background));
            expect(palette.text).toEqual(parseCssColor(theme.text));
        }
    });

    it("keeps the pill light in a light theme and dark in a dark one", () => {
        // A dark pill on a light dashboard (and the reverse) looks like a mistake next to Home
        // Assistant's own tooltips and cards, however readable it is.
        expect(relativeLuminance(resolveRoomPillPalette(HA_LIGHT).background)).toBeGreaterThan(0.8);
        expect(relativeLuminance(resolveRoomPillPalette(HA_DARK).background)).toBeLessThan(0.1);
    });

    it("never draws dark on dark or light on light, whatever the theme or override says", () => {
        const pairs = [
            { background: "#1c1c1c", text: "#212121" },
            { background: "#ffffff", text: "#eeeeee" },
            { background: "#777777", text: "#888888" },
            { background: "#03a9f4", text: "#ffffff" },
        ];
        for (const pair of pairs) check(resolveRoomPillPalette({ ...pair, badge: "#03a9f4" }));
    });

    it("picks a readable badge glyph for every badge colour", () => {
        for (let r = 0; r <= 255; r += 51) {
            for (let g = 0; g <= 255; g += 51) {
                for (let b = 0; b <= 255; b += 51) {
                    const badge = `rgb(${r}, ${g}, ${b})`;
                    check(resolveRoomPillPalette({ ...HA_LIGHT, badge }));
                    check(resolveRoomPillPalette({ ...HA_LIGHT, badge, badgeText: "#ffffff" }));
                }
            }
        }
    });

    it("keeps an explicit badge glyph colour that is readable", () => {
        const palette = resolveRoomPillPalette({ ...HA_LIGHT, badge: "#1565c0", badgeText: "#ffffff" });
        expect(palette.badgeText).toEqual([255, 255, 255]);
    });

    it("falls back to readable defaults when a colour cannot be read", () => {
        const palette = resolveRoomPillPalette({ background: "", text: "var(--nope)", badge: "hsl(1,2%,3%)" });
        check(palette);
    });

    it("draws the pill's ring in a colour that separates it from the map", () => {
        // The ring is the pill's text colour: whatever lies behind the pill contrasts with either
        // the ring or the body, so the pill never melts into a room or the background.
        for (const theme of [HA_LIGHT, HA_DARK]) {
            const palette = resolveRoomPillPalette(theme);
            expect(palette.ring).toEqual(palette.text);
            for (let v = 0; v <= 255; v += 5) {
                const behind: [number, number, number] = [v, v, v];
                const best = Math.max(contrastRatio(behind, palette.ring), contrastRatio(behind, palette.background));
                expect(best, `grey ${v}`).toBeGreaterThanOrEqual(3);
            }
        }
    });

    it("rings the badge when it would not stand out from the pill", () => {
        expect(resolveRoomPillPalette({ ...HA_DARK, badge: "#03a9f4" }).badgeRing).toBe(false);
        expect(resolveRoomPillPalette({ ...HA_LIGHT, badge: "#03a9f4" }).badgeRing).toBe(true);
        expect(resolveRoomPillPalette({ ...HA_DARK, badge: "#2a2a2a" }).badgeRing).toBe(true);
    });
});
