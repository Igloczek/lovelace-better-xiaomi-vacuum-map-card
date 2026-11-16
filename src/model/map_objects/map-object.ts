// noinspection CssUnresolvedCustomProperty
import { css, CSSResultGroup, html, svg, SVGTemplateResult, TemplateResult } from "lit";

import { Context } from "./context";
import { MousePosition } from "./mouse-position";
import {
    IconConfig,
    LabelConfig,
    PointType,
    RectangleType,
    TranslatableString,
    VariablesStorage,
    ZoneType,
} from "../../types/types";
import { conditional } from "../../utils";
import { cssRgb } from "../room-pill-palette";

/** Material Design Icons `check`. */
const CHECK_PATH = "M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z";

/** What a pill's badge shows: a position in the cleaning order, a checkmark, or no badge at all. */
export type PillBadge = number | "check" | undefined;

export abstract class MapObject {
    protected readonly _context: Context;

    protected constructor(context: Context) {
        this._context = context;
    }

    public get variables(): VariablesStorage {
        return {};
    }

    protected static findTopLeft(rect: RectangleType): PointType {
        const top = rect.sort((p1, p2) => p1[1] - p2[1])[0];
        const topIndex = rect.indexOf(top);
        const next = rect[(topIndex + 1) % 4];
        const previous = rect[(topIndex + 3) % 4];
        const atanNext = MapObject.calcAngle(top, next);
        const atanPrevious = MapObject.calcAngle(top, previous);
        const second = atanNext < atanPrevious ? next : previous;
        return second[0] < top[0] ? second : top;
    }

    protected static calcAngle(p2: PointType, p1: PointType): number {
        let atan = Math.atan2(p1[1] - p2[1], p1[0] - p2[0]);
        if (atan > Math.PI / 2) {
            atan = Math.PI - atan;
        }
        return atan;
    }

    private static _reverse([m1, m2, m3, m4]: RectangleType): RectangleType {
        return [m1, m4, m3, m2];
    }

    public abstract render(): SVGTemplateResult;

    protected scaled(value: number): number {
        return value / this._context.scale();
    }

    protected scaledCss(property: string): number {
        return parseFloat(this._context.cssEvaluator(property)) / this._context.scale();
    }

    protected realScaled(value: number): number {
        return value / this._context.realScale();
    }

    protected realScaled2(value: number): number {
        return value * this._context.realScale();
    }

    protected realScaled2Point(value: PointArrayNotation): PointArrayNotation {
        return [this.realScaled2(value[0]), this.realScaled2(value[1])];
    }

    protected realScaledPoint(value: PointArrayNotation): PointArrayNotation {
        return [this.realScaled(value[0]), this.realScaled(value[1])];
    }

    protected update(): void {
        this._context.update();
        this._context.selectionChanged();
    }

    protected localize(string: TranslatableString): string {
        return this._context.localize(string);
    }

    protected getMousePosition(event: MouseEvent | TouchEvent): MousePosition {
        return this._context.mousePositionCalculator(event);
    }

    protected vacuumToRealMap(x: number, y: number): PointType {
        const point = this._context.coordinatesConverter()?.vacuumToMap(x, y);
        if (!point) {
            throw Error("Missing calibration");
        }
        return point;
    }

    protected vacuumToScaledMap(x: number, y: number): PointType {
        return this.realScaled2Point(this.vacuumToRealMap(x, y));
    }

    protected scaledMapToVacuum(x: number, y: number): PointType {
        const [xs, ys] = this.realScaledPoint([x, y]);
        return this.realMapToVacuum(xs, ys);
    }

    protected realMapToVacuum(x: number, y: number): PointType {
        const point = this._context.coordinatesConverter()?.mapToVacuum(x, y);
        if (!point) {
            throw Error("Missing calibration");
        }
        return this._context.roundMap(point);
    }

    protected renderIcon(
        config: IconConfig | undefined,
        click: () => void,
        htmlClass: string,
        content?: TemplateResult,
        clickable = true,
    ): SVGTemplateResult {
        const mapped = config ? this.vacuumToScaledMap(config.x, config.y) : [];
        return svg`${conditional(
            config != null && mapped.length > 0,
            () => svg`
                <foreignObject class="icon-foreign-object"
                               style="--x-icon: ${mapped[0]}px; --y-icon: ${mapped[1]}px;"
                               x="${mapped[0]}px" y="${mapped[1]}px" width="36px" height="36px">         
                    <body xmlns="http://www.w3.org/1999/xhtml">
                      <div class="map-icon-wrapper ${htmlClass} ${clickable ? "clickable" : ""}"
                           @click="${clickable ? click : undefined}">
                          ${content ?? html`<ha-icon icon="${config?.name}" style="background: transparent;"></ha-icon>`}
                      </div>
                    </body>
                </foreignObject>
            `,
        )}`;
    }

    /**
     * `anchor` is the icon this label belongs to, when there is one. The label is then hung off the
     * icon and everything separating the two - the gap between their configured positions as well as
     * offset_x/offset_y - is applied after the counter-rotation, so it is measured on screen. A label
     * sitting below its icon stays below it however far the map is turned, instead of swinging around
     * and landing on top of it. At 0deg the result is identical to placing the label outright.
     *
     * `style` adds element-specific declarations. The anchor, the offset and the counter-rotation
     * stay in this one rule, so no caller repeats them; a caller that works out its own placement
     * (the stale marker) sets `--label-shift-x`/`--label-shift-y`, which the same rule adds to the
     * offset on screen.
     */
    protected renderLabel(
        config: LabelConfig | undefined,
        htmlClass: string,
        anchor?: IconConfig,
        style = "",
    ): SVGTemplateResult {
        const mapped = config ? this.vacuumToScaledMap(config.x, config.y) : [];
        const anchored = anchor ? this.vacuumToScaledMap(anchor.x, anchor.y) : undefined;
        const origin = anchored ?? mapped;
        const offsetX = (mapped[0] ?? 0) - (origin[0] ?? 0) + this.scaled(config?.offset_x ?? 0);
        const offsetY = (mapped[1] ?? 0) - (origin[1] ?? 0) + this.scaled(config?.offset_y ?? 0);
        return svg`${conditional(
            config != null && mapped.length > 0,
            () => svg`
                <text class="label-text ${htmlClass}"
                      style="--label-anchor-x: ${origin[0]}px; --label-anchor-y: ${origin[1]}px;
                             --label-offset-x: ${offsetX}px; --label-offset-y: ${offsetY}px;
                             ${style}"
                      x="${origin[0]}px"
                      y="${origin[1]}px">
                    ${config?.text}
                </text>
            `,
        )}`;
    }

    /**
     * The card's one label style: a pill with the name, in the theme's colours, the same for rooms,
     * predefined points and predefined rectangles. A selected object's pill also carries a badge (a
     * position in the cleaning order or a checkmark); an unselected one is the same pill without it.
     *
     * The pill is HTML in a foreignObject so it sizes to its text. The foreignObject covers the map
     * and half of it again on every side, so its own box always contains the pill: a browser that
     * repaints only what changed (Chromium, WebKit) repaints that box when the pill goes, where a
     * small box with the pill overflowing it left the rest of the pill painted over the map after
     * deselection. It is turned back against the map rotation around `origin` and stepped away by
     * `offset` on screen, exactly as `renderLabel` places a label, and divided by the zoom, so it stays
     * upright and the same size on screen; it ignores pointer events, so a tap reaches the object
     * underneath. Its colours come from the resolved palette (`roomPillPalette`), which keeps every
     * text pair at 4.5:1 or better.
     */
    protected renderPill(
        origin: PointType,
        offset: PointType,
        name: string | undefined,
        badge: PillBadge,
        htmlClass = "",
    ): SVGTemplateResult {
        if (!name && badge === undefined) return svg``;
        const palette = this._context.roomPillPalette();
        const style = [
            `--room-pill-background: ${cssRgb(palette.background)}`,
            `--room-pill-text: ${cssRgb(palette.text)}`,
            `--room-pill-ring: ${cssRgb(palette.ring)}`,
            `--room-pill-badge: ${cssRgb(palette.badge)}`,
            `--room-pill-badge-text: ${cssRgb(palette.badgeText)}`,
            `--room-pill-x: ${origin[0]}px`,
            `--room-pill-y: ${origin[1]}px`,
            `--room-pill-offset-x: ${offset[0]}px`,
            `--room-pill-offset-y: ${offset[1]}px`,
        ].join("; ");
        const badgeElement =
            badge === undefined
                ? ""
                : badge === "check"
                  ? html`<span class="room-pill-badge room-check" aria-label="selected"
                        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${CHECK_PATH}"></path></svg
                    ></span>`
                  : html`<span class="room-pill-badge room-order">${badge}</span>`;
        const classes = [
            "room-pill",
            htmlClass,
            badge === undefined ? "no-badge" : "",
            name ? "" : "badge-only",
            palette.badgeRing ? "badge-ring" : "",
        ]
            .filter(Boolean)
            .join(" ");
        return svg`
            <foreignObject class="room-pill-anchor" x="-50%" y="-50%" width="200%" height="200%">
                <body xmlns="http://www.w3.org/1999/xhtml" class="room-pill-canvas">
                    ${html`<div class="${classes}" style="${style}">${badgeElement}${name ? html`<span class="room-pill-name">${name}</span>` : ""}</div>`}
                </body>
            </foreignObject>
        `;
    }

    /**
     * A configured label drawn as a pill, placed as `renderLabel` places the plain text: around the
     * icon it belongs to (`anchor`), when there is one, and stepped away by the label's offset on
     * screen. A label without text draws nothing.
     */
    protected renderLabelPill(
        config: LabelConfig | undefined,
        htmlClass: string,
        anchor: IconConfig | undefined,
        badge: PillBadge,
    ): SVGTemplateResult {
        const name = config?.text?.trim();
        if (!config || !name) return svg``;
        const point = this.vacuumToScaledMap(config.x, config.y);
        const origin = anchor ? this.vacuumToScaledMap(anchor.x, anchor.y) : point;
        return this.renderPill(
            origin,
            [
                point[0] - origin[0] + this.scaled(config.offset_x ?? 0),
                point[1] - origin[1] + this.scaled(config.offset_y ?? 0),
            ],
            name,
            badge,
            htmlClass,
        );
    }

    protected vacuumToMapRect([vacX1, vacY1, vacX2, vacY2]: ZoneType): [RectangleType, RectangleType] {
        const v1 = [vacX1, vacY1];
        const v2 = [vacX2, vacY1];
        const v3 = [vacX2, vacY2];
        const v4 = [vacX1, vacY2];
        const m1 = this.vacuumToScaledMap(vacX1, vacY1);
        const m2 = this.vacuumToScaledMap(vacX2, vacY1);
        const m3 = this.vacuumToScaledMap(vacX2, vacY2);
        const m4 = this.vacuumToScaledMap(vacX1, vacY2);
        const vacuumPointsCycled = [v1, v2, v3, v4, v1, v2, v3, v4];
        const mapPointsCycled = [m1, m2, m3, m4, m1, m2, m3, m4];
        const mapPoints = [m1, m2, m3, m4] as RectangleType;
        const first = mapPointsCycled.indexOf(MapObject.findTopLeft(mapPoints));
        const outputMapPoints = mapPointsCycled.slice(first, first + 4) as RectangleType;
        const counterClockwise = this._isCounterClockwise(outputMapPoints);
        const outputVacuumPoints = vacuumPointsCycled.slice(first, first + 4) as RectangleType;
        if (counterClockwise) {
            return [MapObject._reverse(outputMapPoints), MapObject._reverse(outputVacuumPoints)];
        }
        return [outputMapPoints, outputVacuumPoints];
    }

    private _isCounterClockwise(rect: RectangleType): boolean {
        let sum = 0;
        rect.forEach((p, i) => (sum += (rect[(i + 1) % 4][0] - p[0]) * (rect[(i + 1) % 4][1] + p[1])));
        return sum < 0;
    }

    public static get styles(): CSSResultGroup {
        return css`
            .icon-foreign-object {
                overflow: visible;
                pointer-events: none;
            }

            .map-icon-wrapper {
                position: center;
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: auto;
            }

/* The label pill, the card's one label style (see renderPill). The foreignObject spans the map plus half of
               it on every side, so its box contains the pill and removing the pill repaints all of
               it; the pill is placed at the label's origin inside it (the body is twice the map, so
               25% of it is the map's own top-left corner). Transforms apply right to left: centre the
               pill on its own middle, divide by the zoom, step the label's offset, then turn back
               against the map rotation around the origin - the same placement as .label-text, so
               the pill sits exactly where the plain label was, upright and the same size on screen
               at any zoom and rotation. */
            .room-pill-anchor {
                overflow: visible;
                pointer-events: none;
            }

            .room-pill-canvas {
                position: relative;
                width: 100%;
                height: 100%;
                margin: 0;
                pointer-events: none;
            }

            .room-pill {
                --room-pill-font-size: var(--map-card-internal-room-label-font-size);
                --room-pill-height: calc(var(--room-pill-font-size) * 2);
                position: absolute;
                left: calc(25% + var(--room-pill-x, 0px));
                top: calc(25% + var(--room-pill-y, 0px));
                box-sizing: border-box;
                display: flex;
                align-items: center;
                gap: 6px;
                width: max-content;
                height: var(--room-pill-height);
                padding: 0 10px 0 3px;
                border-radius: calc(var(--room-pill-height) / 2);
                background: var(--room-pill-background);
                color: var(--room-pill-text);
                /* Set apart from the map by depth, not a hard outline: a hairline from the text
                   colour, and a soft two-layer shadow. */
                box-shadow: 0 0 0 1px color-mix(in srgb, var(--room-pill-ring) 18%, transparent);
                filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.2)) drop-shadow(0 3px 6px rgba(0, 0, 0, 0.14));
                font-size: var(--room-pill-font-size);
                font-weight: 600;
                letter-spacing: 0.01em;
                line-height: 1;
                white-space: nowrap;
                pointer-events: none;
                transform-origin: 0 0;
                transform: rotate(calc(-1 * var(--map-rotation, 0deg)))
                    translate(var(--room-pill-offset-x, 0px), var(--room-pill-offset-y, 0px))
                    scale(calc(1 / var(--map-scale)))
                    translate(-50%, -50%);
            }

            .room-pill.badge-only {
                padding: 0 3px;
            }

            /* An unselected label: the same pill, without the badge. */
            .room-pill.no-badge {
                padding: 0 10px;
            }

            .room-pill.predefined-point-label {
                --room-pill-font-size: var(--map-card-internal-predefined-point-label-font-size);
            }

            .room-pill.predefined-rectangle-label {
                --room-pill-font-size: var(--map-card-internal-predefined-rectangle-label-font-size);
            }

            .room-pill-badge {
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: center;
                flex: none;
                min-width: calc(var(--room-pill-height) - 6px);
                height: calc(var(--room-pill-height) - 6px);
                padding: 0 5px;
                border-radius: calc(var(--room-pill-height) / 2);
                background: var(--room-pill-badge);
                color: var(--room-pill-badge-text);
                font-size: calc(var(--room-pill-font-size) - 1px);
                font-weight: 700;
                font-variant-numeric: tabular-nums;
            }

            /* The checkmark sits in a true circle, the same size as a one-digit number. */
            .room-pill-badge.room-check {
                width: calc(var(--room-pill-height) - 6px);
                padding: 0;
            }

            .room-pill.badge-ring .room-pill-badge {
                box-shadow: 0 0 0 1px color-mix(in srgb, var(--room-pill-text) 35%, transparent);
            }

            .room-pill-badge svg {
                width: 13px;
                height: 13px;
                fill: currentColor;
            }

            .label-text {
                /* Unturn first, then step away from the anchor: the offset ends up measured on
                   screen, so a label configured to sit below its icon stays below it at any angle.
                   At 0deg this is exactly the old plain offset.
                   The origin has to be the anchor itself, not the middle of the glyphs, or the
                   text drifts by however far the two differ - doubled at 180deg.
                   --label-shift-* is the same screen-space step, for a label whose placement is
                   computed in CSS (the stale-room marker): it is added to the offset, so both end up
                   in one translate. */
                transform-box: view-box;
                transform-origin: var(--label-anchor-x, 0px) var(--label-anchor-y, 0px);
                transform: rotate(calc(-1 * var(--map-rotation, 0deg)))
                    translate(
                        calc(var(--label-offset-x, 0px) + var(--label-shift-x, 0px)),
                        calc(var(--label-offset-y, 0px) + var(--label-shift-y, 0px))
                    );
            }
        `;
    }
}
