// noinspection CssUnresolvedCustomProperty
import { css, CSSResultGroup, html, svg, SVGTemplateResult } from "lit";
import { forwardHaptic } from "custom-card-helpers";

import { Context } from "./context";
import { deleteFromArray } from "../../utils";
import { LabelConfig, RoomConfig } from "../../types/types";
import { PredefinedMapObject } from "./predefined-map-object";
import { cssRgb } from "../room-pill-palette";

/** Material Design Icons `check`. */
const CHECK_PATH = "M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z";

/**
 * The stale-room marker's size in multiples of its own font, in screen pixels. The marker is a `!`
 * drawn at 1.4 label fonts (see the stylesheet); its SVG text box is about 1.15 font sizes tall and
 * 0.33 wide, and the anchor sits about 0.65 font sizes above the middle of it. The box is therefore
 * measured from the anchor as 0.7 font sizes above, 0.55 below and 0.2 either side, rounded up so the
 * glyph always lands inside the room and clear of the pill. The pill is two label fonts tall (its
 * height is `--map-card-internal-room-label-font-size * 2`), which is where the clearance comes from
 * - a theme may make it taller by raising the font, and the marker follows.
 */
const STALE_MARKER_FONT_SCALE = 1.4;
const STALE_MARKER_BOX_WIDTH = 0.4;
const STALE_MARKER_BOX_ABOVE = 0.7;
const STALE_MARKER_BOX_BELOW = 0.55;
const STALE_MARKER_GAP = 6;
/** Distance in screen pixels between the room outline and the marker, when the room is big enough. */
const STALE_MARKER_ROOM_INSET = 1;
/** `--map-card-room-label-font-size`'s default, for a frontend that cannot resolve the variable. */
const DEFAULT_LABEL_FONT_SIZE = 12;

export interface RoomRenderOptions {
    readonly imageOutline?: Array<[number, number]>;
    /** The configured id is absent from the live camera metadata (issue #928). */
    readonly stale?: boolean;
    /**
     * The card resolves taps on this room's outline itself (`roomIdAtImagePoint`), because a colour
     * detection exists: the outline must not be a click target of its own, or a bounding-box
     * outline would take taps meant for a detected room it overlaps.
     */
    readonly cardHitTest?: boolean;
}

export class Room extends PredefinedMapObject {
    private readonly _config: RoomConfig;
    private readonly _imageOutline?: Array<[number, number]>;
    private readonly _stale: boolean;
    private readonly _cardHitTest: boolean;

    constructor(config: RoomConfig, context: Context, options: RoomRenderOptions = {}) {
        super(config, context);
        this._config = config;
        this._imageOutline = options.imageOutline;
        this._stale = options.stale === true;
        this._cardHitTest = options.cardHitTest === true;
        // A stale room exists only to show which configured id no longer matches the map. It must
        // never be selected, including through `default_state` or a state entity, or a service
        // call would clean a room id the camera no longer reports (issue #928).
        if (this._stale) {
            this._selected = false;
        }
    }

    public selectionKey(): string {
        return String(this._config.id);
    }

    public restoreSelected(selected: boolean): void {
        if (this._stale) return;
        super.restoreSelected(selected);
    }

    /**
     * True when the id is absent from the live camera metadata: a configured id the camera no
     * longer reports (`#928`), or a selected room that vanished from the metadata since the last
     * rebuild. Either way the id cannot be cleaned, so the room is drawn as a warning and is never
     * sent (see `getUsableSelectedRooms`).
     */
    public get stale(): boolean {
        return this._stale || !this._context.roomAvailable(this.selectionKey());
    }

    /** True when the outline was detected from the map image. */
    public get hasImageOutline(): boolean {
        return this._imageOutline !== undefined;
    }

    /** The configured or metadata outline, in vacuum coordinates. */
    public get outline(): Array<[number, number]> {
        return (this._config?.outline ?? []).map(point => [point[0], point[1]]);
    }

    public render(): SVGTemplateResult {
        const poly = this._outlinePoints();
        // Read once per render: the live metadata decides it, and the accessor rebuilds its id set.
        const stale = this.stale;
        // Rooms are sent in click order, so a selected room shows its position in that order. Once
        // a run has started and the selection is cleared, the rooms of that run look exactly as they
        // did when selected, numbers included, until the vacuum is done. A tap either is refused
        // (rooms locked) or drops the run first (see `click`), so the two sources never mix.
        // The numbers are drawn only where the platform follows the order (see
        // `MapMode.showsRoomOrder`); elsewhere the rooms are highlighted without a number.
        const runOrder = this._selected ? 0 : this._context.activeRoomOrder().indexOf(String(this._config.id)) + 1;
        const position = this._selected ? this._context.selectedRooms().indexOf(this) + 1 : runOrder;
        const order = this._context.showRoomOrder() ? position : 0;
        // A room that cannot be cleaned is never drawn as selected, or the card would look ready to
        // send a selection that the service call drops (an empty room list).
        const highlighted = (this._selected && !stale) || runOrder > 0;
        // A highlighted room's label becomes a pill (badge + name). A stale room never shows one:
        // it is not a valid part of a run, and a pill would cover its `!` marker.
        const pill = highlighted && !stale;
        return svg`
            <g class="room-wrapper ${highlighted ? "selected" : ""} ${runOrder > 0 ? "running" : ""} ${stale ? "room-stale" : ""}
            room-${`${this._config.id}`.replace(/[^a-zA-Z0-9_-]/gm, "_")}-wrapper">
                <polygon class="room-outline ${this._imageOutline || stale || this._cardHitTest ? "" : "clickable"}"
                         points="${poly.map(p => p.join(", ")).join(" ")}"
                         @click="${
                             this._imageOutline || stale || this._cardHitTest
                                 ? undefined
                                 : async (): Promise<void> => this.click()
                         }">
                </polygon>
                ${pill ? svg`` : this.renderIcon(this._config.icon, () => this.click(), "room-icon-wrapper", undefined, !stale)}
                ${pill ? this.renderPill(order) : svg``}
                ${this.renderStaleMarker(stale)}
                ${pill ? svg`` : this.renderLabel(this._config.label, "room-label", this._config.icon)}
            </g>
        `;
    }

    /**
     * The label of a selected room, or of a room in a started run, drawn as a pill in the style of
     * the Xiaomi Home app: a round badge at its left end and the room name, drawn exactly where the
     * plain label is (centred on the label's point, with its offset). The badge holds the room's place in the order when the mode numbers rooms
     * (`cleaning_order`) and a checkmark otherwise. A room without a label shows the badge alone.
     *
     * The pill is HTML in a foreignObject so it sizes to its text. The foreignObject covers the map
     * and half of it again on every side, so its own box always contains the pill: a browser that
     * repaints only what changed (Chromium, WebKit) repaints that box when the pill goes, where a
     * small box with the pill overflowing it left the rest of the pill painted over the map after
     * deselection. Like the label it is turned back
     * against the map rotation around the same origin and stepped away by the same offset, and it is
     * divided by the zoom, so it stays upright and the same size on screen; it ignores pointer events, so a tap reaches the room underneath. Its colours come from
     * the resolved palette (`roomPillPalette`), which keeps every text pair at 4.5:1 or better.
     */
    private renderPill(order: number): SVGTemplateResult {
        const anchor = this._pillAnchor();
        if (!anchor) return svg``;
        const { origin, offset } = anchor;
        const palette = this._context.roomPillPalette();
        const name = this._config.label?.text?.trim();
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
        const badge =
            order > 0
                ? html`<span class="room-pill-badge room-order">${order}</span>`
                : html`<span class="room-pill-badge room-check" aria-label="selected"
                      ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${CHECK_PATH}"></path></svg
                  ></span>`;
        return svg`
            <foreignObject class="room-pill-anchor" x="-50%" y="-50%" width="200%" height="200%">
                <body xmlns="http://www.w3.org/1999/xhtml" class="room-pill-canvas">
                    ${html`<div class="room-pill ${name ? "" : "badge-only"} ${palette.badgeRing ? "badge-ring" : ""}"
                                style="${style}">${badge}${name ? html`<span class="room-pill-name">${name}</span>` : ""}</div>`}
                </body>
            </foreignObject>
        `;
    }

    /**
     * Where the pill goes, in scaled map pixels, computed as `renderLabel` places the plain label:
     * the origin it turns around (the icon when the room has one, else the label) and the offset it
     * then steps on screen. A room without a label is centred on its icon, else on the middle of its
     * outline.
     */
    private _pillAnchor(): { origin: [number, number]; offset: [number, number] } | undefined {
        const anchor = this._labelAnchor();
        if (!anchor) return undefined;
        return {
            origin: anchor.origin,
            offset: [
                anchor.point[0] - anchor.origin[0] + this.scaled(anchor.offset[0]),
                anchor.point[1] - anchor.origin[1] + this.scaled(anchor.offset[1]),
            ],
        };
    }

    /**
     * The point a room's label is centred on, the point its glyph turns around, and the label's own
     * offset on screen. A room without a label is centred on its icon, else on the middle of its
     * outline. The label point is also where a selected room's pill is centred when colour detection
     * moved the offset to zero, which is why the stale marker works from this point.
     */
    private _labelAnchor():
        | { origin: [number, number]; point: [number, number]; offset: [number, number] }
        | undefined {
        const label = this._config.label;
        const icon = this._config.icon;
        const labelPoint = label ? this.vacuumToScaledMap(label.x, label.y) : undefined;
        const iconPoint = icon ? this.vacuumToScaledMap(icon.x, icon.y) : undefined;
        const centre = !labelPoint && !iconPoint ? this._outlineCenter() : undefined;
        const centrePoint = centre ? this.vacuumToScaledMap(centre.x, centre.y) : undefined;
        const point = labelPoint ?? iconPoint ?? centrePoint;
        if (!point) return undefined;
        return {
            origin: labelPoint ? (iconPoint ?? labelPoint) : point,
            point: [point[0], point[1]],
            offset: label ? [label.offset_x ?? 0, label.offset_y ?? 0] : [0, 0],
        };
    }

    /**
     * A room whose id is no longer in the camera metadata, configured or selected. The room is
     * drawn from its last known outline and marked with an exclamation mark above its label point;
     * the card's warning names the ids. It is never clickable or selected (issue #928).
     *
     * The marker is placed in map coordinates, not by a stylesheet lift: the position has to respect
     * the room's outline and the map's edge, and both change with the zoom while the marker stays a
     * fixed size on screen. It hangs off the label point (where the pill of the live room with the
     * same geometry is centred, the label offset excluded), lifted on screen by the pill's own half
     * height (one label font, its height is two) plus half the marker glyph and a gap. The lift is
     * therefore independent of `--map-card-room-icon-wrapper-size`.
     *
     * A room too small to take the marker clear of the pill still gets it: the glyph shrinks to fit
     * and is clamped inside the outline, and it is painted after every live room's pill (stale rooms
     * are appended last in `setCurrentMode`), so it stays visible over the pill's edge. At rotations
     * other than 0 the "up" of the lift is the screen's up, so the lift is turned back into map
     * coordinates with the shared map rotation; the marker's own transform stays `renderLabel`'s, so
     * nothing here repeats it.
     */
    private renderStaleMarker(stale: boolean): SVGTemplateResult {
        if (!stale) return svg``;
        // The same point the pill would be centred on: the label, else the icon (a badge-only room),
        // else the middle of the outline. The label's configured offset is deliberately excluded.
        const anchor = this._config.label ?? this._config.icon ?? this._outlineCenter();
        const bounds = this._outlineBounds();
        if (!anchor || !bounds) return svg``;

        const scale = this._context.scale();
        const rotation = (this._context.mapRotation() * Math.PI) / 180;
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const [labelX, labelY] = this.vacuumToScaledMap(anchor.x, anchor.y);
        const font = this._cssPixels("--map-card-internal-room-label-font-size", DEFAULT_LABEL_FONT_SIZE);
        const below = font * STALE_MARKER_FONT_SCALE * STALE_MARKER_BOX_BELOW;
        const lift = font + below + STALE_MARKER_GAP;

        // A room smaller than the marker shrinks the glyph so the whole marker can stay inside its
        // outline; the extents are the screen box turned into map axes (a rotated glyph covers more
        // ground along a map axis than its upright width).
        const inset = STALE_MARKER_ROOM_INSET / scale;
        let markerFont = font * STALE_MARKER_FONT_SCALE;
        let extents = this._staleMarkerExtents(markerFont, cos, sin, scale);
        const innerWidth = bounds.maxX - bounds.minX - 2 * inset;
        const innerHeight = bounds.maxY - bounds.minY - 2 * inset;
        const fit = Math.min(
            1,
            extents.width > 0 ? innerWidth / extents.width : 1,
            extents.height > 0 ? innerHeight / extents.height : 1,
        );
        if (fit > 0 && fit < 1) {
            markerFont *= fit;
            extents = this._staleMarkerExtents(markerFont, cos, sin, scale);
        }

        // The screen's "up" is a rotated direction in map coordinates: turn (0, -lift) by -rotation.
        const x = this._clampToOutline(
            labelX + (-lift * sin) / scale,
            bounds.minX + inset - extents.minX,
            bounds.maxX - inset - extents.maxX,
        );
        const y = this._clampToOutline(
            labelY + (-lift * cos) / scale,
            bounds.minY + inset - extents.minY,
            bounds.maxY - inset - extents.maxY,
        );

        // `renderLabel` applies an offset on screen after the counter-rotation; give it the screen
        // vector from the label point to the clamped map point.
        const deltaX = x - labelX;
        const deltaY = y - labelY;
        return this.renderLabel(
            {
                x: anchor.x,
                y: anchor.y,
                text: "!",
                offset_x: (deltaX * cos - deltaY * sin) * scale,
                offset_y: (deltaX * sin + deltaY * cos) * scale,
            },
            "room-stale-marker",
            undefined,
            `--map-card-internal-room-stale-marker-font-size: ${markerFont}px;`,
        );
    }

    /**
     * The marker's box relative to its anchor, in map units: its extremes on both axes and its
     * size. The anchor is not the box's centre (SVG text hangs its middle baseline on the anchor),
     * so the box is measured as the four screen corners turned into map coordinates.
     */
    private _staleMarkerExtents(
        fontSize: number,
        cos: number,
        sin: number,
        scale: number,
    ): { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number } {
        const halfWidth = (fontSize * STALE_MARKER_BOX_WIDTH) / 2;
        const above = fontSize * STALE_MARKER_BOX_ABOVE;
        const below = fontSize * STALE_MARKER_BOX_BELOW;
        const mapped = [
            [-halfWidth, -above],
            [halfWidth, -above],
            [-halfWidth, below],
            [halfWidth, below],
        ].map(([x, y]) => [(cos * x + sin * y) / scale, (-sin * x + cos * y) / scale]);
        const xs = mapped.map(point => point[0]);
        const ys = mapped.map(point => point[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
    }

    /** Keeps `value` between `min` and `max`, or centres it when the range is empty. */
    private _clampToOutline(value: number, min: number, max: number): number {
        return min <= max ? Math.min(Math.max(value, min), max) : (min + max) / 2;
    }

    /** The configured or detected outline in scaled map coordinates. */
    private _outlinePoints(): Array<[number, number]> {
        return this._imageOutline
            ? this._imageOutline.map(p => this.realScaled2Point(p) as [number, number])
            : (this._config?.outline ?? []).map(p => this.vacuumToScaledMap(p[0], p[1]) as [number, number]);
    }

    /** The bounds of `_outlinePoints()` in scaled map coordinates. */
    private _outlineBounds(): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
        const points = this._outlinePoints();
        if (points.length === 0) return undefined;
        return {
            minX: Math.min(...points.map(p => p[0])),
            minY: Math.min(...points.map(p => p[1])),
            maxX: Math.max(...points.map(p => p[0])),
            maxY: Math.max(...points.map(p => p[1])),
        };
    }

    /** A CSS length in screen pixels, or `fallback` when the frontend cannot resolve it. */
    private _cssPixels(property: string, fallback: number): number {
        const value = parseFloat(this._context.cssEvaluator(property));
        return Number.isFinite(value) ? value : fallback;
    }

    /**
     * An anchor for the badge of a configured room that has neither an icon nor a label: the average
     * of the outline's vertices, which is close to the middle of the convex outlines a configured
     * room has. It is not a true centroid.
     */
    private _outlineCenter(): LabelConfig | undefined {
        const outline = this._config.outline;
        if (!outline?.length) return undefined;
        const sum = outline.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
        return { text: "", x: sum[0] / outline.length, y: sum[1] / outline.length };
    }

    public toVacuum(): number | string {
        return this._config.id;
    }

    public async click(): Promise<void> {
        // A stale room is a warning, not a target: its id is absent from the live camera metadata.
        if (this.stale) return;
        // While the vacuum works through a started run the map shows its order, and the rooms are
        // locked so that order cannot change until the vacuum is done. Before the vacuum has
        // reported the start (polling integrations lag), a tap begins a new selection instead.
        if (this._context.roomsLocked()) {
            forwardHaptic("failure");
            return;
        }
        if (this._context.activeRoomOrder().length > 0) this._context.dismissActiveRun();
        if (!this._selected && this._context.selectedRooms().length >= this._context.maxSelections()) {
            forwardHaptic("failure");
            return;
        }
        this._toggleSelected();
        if (this._selected) {
            this._context.selectedRooms().push(this);
        } else {
            deleteFromArray(this._context.selectedRooms(), this);
        }
        this._context.selectionChanged();
        if (await this._context.runImmediately()) {
            this._selected = false;
            deleteFromArray(this._context.selectedRooms(), this);
            this._context.selectionChanged();
            return;
        }
        forwardHaptic("selection");
        this.update();
    }

    public static get styles(): CSSResultGroup {
        return css`
            .room-wrapper {
            }

            .room-outline {
                stroke: var(--map-card-internal-room-outline-line-color);
                stroke-width: calc(var(--map-card-internal-room-outline-line-width) / var(--map-scale));
                fill: var(--map-card-internal-room-outline-fill-color);
                stroke-linejoin: round;
                stroke-dasharray: calc(var(--map-card-internal-room-outline-line-segment-line) / var(--map-scale)),
                    calc(var(--map-card-internal-room-outline-line-segment-gap) / var(--map-scale));
                transition: stroke var(--map-card-internal-transitions-duration) ease,
                    fill var(--map-card-internal-transitions-duration) ease;
            }

            .room-icon-wrapper {
                x: var(--x-icon);
                y: var(--y-icon);
                height: var(--map-card-internal-room-icon-wrapper-size);
                width: var(--map-card-internal-room-icon-wrapper-size);
                border-radius: var(--map-card-internal-small-radius);
                transform-box: fill-box;
                overflow: hidden;
                transform: translate(
                        calc(var(--map-card-internal-room-icon-wrapper-size) / -2),
                        calc(var(--map-card-internal-room-icon-wrapper-size) / -2)
                    )
                    scale(calc(1 / var(--map-scale)))
                    rotate(calc(-1 * var(--map-rotation, 0deg)));
                background: var(--map-card-internal-room-icon-background-color);
                color: var(--map-card-internal-room-icon-color);
                --mdc-icon-size: var(--map-card-internal-room-icon-size);
                transition: color var(--map-card-internal-transitions-duration) ease,
                    background var(--map-card-internal-transitions-duration) ease;
            }

            /* The selected-room pill (see renderPill). The foreignObject spans the map plus half of
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
                --room-pill-height: calc(var(--map-card-internal-room-label-font-size) * 2);
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
                font-size: var(--map-card-internal-room-label-font-size);
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
                font-size: calc(var(--map-card-internal-room-label-font-size) - 1px);
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

            /* A configured room whose id is no longer in the camera metadata: an exclamation mark
               placed above the room's label point. renderStaleMarker computes the position in map
               coordinates - it has to stay inside the room's outline and the map, and both of those
               change with the zoom - and passes it through the label-text offset. The text is only
               sized and coloured here; the counter-rotation, the anchor and the offset come from the
               shared label-text rule, never from a copy. The glyph shrinks in a room too small to
               hold it, so its size is set per marker as a screen length divided by the zoom. */
            text.room-stale-marker {
                font-size: calc(
                    var(
                            --map-card-internal-room-stale-marker-font-size,
                            calc(var(--map-card-internal-room-label-font-size) * 1.4)
                        )
                        / var(--map-scale)
                );
                font-weight: 700;
                text-anchor: middle;
                dominant-baseline: middle;
                fill: var(--map-card-internal-room-label-color-stale, var(--error-color, #db4437));
                stroke: var(--map-card-internal-room-label-outline-color);
                stroke-width: calc(var(--map-card-internal-room-label-outline-width) / var(--map-scale));
                stroke-linejoin: round;
                paint-order: stroke fill;
                pointer-events: none;
            }

            .room-wrapper.room-stale > .room-outline {
                stroke: var(--map-card-internal-room-outline-line-color-stale, var(--error-color, #db4437));
                fill: var(--map-card-internal-room-outline-fill-color-stale, rgba(219, 68, 55, 0.12));
            }

            /* A stale room is a warning, not a hit target. After an id shift its stored outline can
               cover a live room with the same geometry, and its fill would swallow the click meant
               for the room underneath. The pointer-events property inherits, so the outline, label and
               marker are all transparent; the icon's own pointer-events: auto rule in .map-icon-wrapper
               needs the more specific rule below to be covered too. */
            .room-wrapper.room-stale,
            .room-wrapper.room-stale .map-icon-wrapper {
                pointer-events: none;
            }

            .room-wrapper.room-stale > .room-label {
                fill: var(--map-card-internal-room-label-color-stale, var(--error-color, #db4437));
            }

            .room-label {
                text-anchor: middle;
                dominant-baseline: middle;
                pointer-events: none;
                font-size: calc(var(--map-card-internal-room-label-font-size) / var(--map-scale));
                font-weight: 600;
                fill: var(--map-card-internal-room-label-color);
                stroke: var(--map-card-internal-room-label-outline-color);
                stroke-width: calc(var(--map-card-internal-room-label-outline-width) / var(--map-scale));
                stroke-linejoin: round;
                paint-order: stroke fill;
                transition: fill var(--map-card-internal-transitions-duration) ease;
            }

            .room-wrapper.selected > .room-outline {
                stroke: var(--map-card-internal-room-outline-line-color-selected);
                fill: var(--map-card-internal-room-outline-fill-color-selected);
            }

            .room-wrapper.selected > * > .room-icon-wrapper {
                background: var(--map-card-internal-room-icon-background-color-selected);
                color: var(--map-card-internal-room-icon-color-selected);
            }

            .room-wrapper.selected > .room-label {
                fill: var(--map-card-internal-room-label-color-selected);
            }

        `;
    }
}
