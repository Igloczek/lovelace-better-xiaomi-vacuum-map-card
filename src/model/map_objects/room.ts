// noinspection CssUnresolvedCustomProperty
import { css, CSSResultGroup, svg, SVGTemplateResult } from "lit";
import { forwardHaptic } from "custom-card-helpers";

import { Context } from "./context";
import { deleteFromArray } from "../../utils";
import { LabelConfig, RoomConfig } from "../../types/types";
import { PredefinedMapObject } from "./predefined-map-object";

/**
 * Free space from a room's label point along one screen direction, in map units: how far the marker
 * may travel that way before it leaves the room's outline. The marker's own size and lift are never
 * measured here - they are stylesheet expressions of the pill's variables - so this is the only
 * geometry the card hands the stylesheet, and it is the same at every zoom.
 */
interface StaleMarkerSpace {
    readonly up: number;
    readonly down: number;
    readonly left: number;
    readonly right: number;
}

/**
 * One camera room an area is drawn from (issue #120): its id in the camera's `rooms`, its outline in
 * vacuum coordinates and, when the colour detection found it, its outline in image pixels.
 */
export interface RoomSegment {
    readonly id: string;
    readonly outline: ReadonlyArray<readonly [number, number]>;
    readonly imageOutline?: Array<[number, number]>;
}

export interface RoomRenderOptions {
    readonly imageOutline?: Array<[number, number]>;
    /**
     * The camera rooms a Home Assistant area covers, each drawn as an outline of this room and each a
     * target for its taps. Given, they replace the single outline; the label and stale marker still
     * use the room's own outline, the largest of them.
     */
    readonly segments?: readonly RoomSegment[];
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
    private readonly _segments: readonly RoomSegment[];

    constructor(config: RoomConfig, context: Context, options: RoomRenderOptions = {}) {
        super(config, context);
        this._config = config;
        this._imageOutline = options.imageOutline;
        this._stale = options.stale === true;
        this._cardHitTest = options.cardHitTest === true;
        this._segments = options.segments ?? [];
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

    /**
     * A stale room's `default_state` is not in effect: it can never be selected. Reporting it lets a
     * rebuild that finds the room live again (Home Assistant's areas loading after the camera's
     * rooms, issue #120, or a segment the camera reports again) apply the configured default
     * instead of keeping the "not selected" the stale room was forced into.
     */
    public override defaultSelected(): boolean {
        return !this._stale && super.defaultSelected();
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

    /** The camera rooms this room is drawn from; empty unless it is an area (issue #120). */
    public get segments(): readonly RoomSegment[] {
        return this._segments;
    }

    /** The configured or metadata outline, in vacuum coordinates. */
    public get outline(): Array<[number, number]> {
        return (this._config?.outline ?? []).map(point => [point[0], point[1]]);
    }

    /**
     * The room's outline. Its icon, label and stale marker are drawn by `renderLabels`, in a layer
     * the card paints after every room's outline: drawn inside each room's own group, the next
     * room's outline painted over a label that reached across the border and cut it.
     */
    public render(): SVGTemplateResult {
        const { stale, highlighted, runOrder } = this._state();
        // An area is drawn with every camera room it covers; any other room with its one outline.
        const outlines: Array<{ points: Array<[number, number]>; image: boolean }> = this._segments.length
            ? this._segments.map(segment => ({
                  points: segment.imageOutline
                      ? segment.imageOutline.map(p => this.realScaled2Point(p) as [number, number])
                      : segment.outline.map(p => this.vacuumToScaledMap(p[0], p[1]) as [number, number]),
                  image: segment.imageOutline !== undefined,
              }))
            : [{ points: this._outlinePoints(), image: this._imageOutline !== undefined }];
        return svg`
            <g class="room-wrapper ${highlighted ? "selected" : ""} ${runOrder > 0 ? "running" : ""} ${stale ? "room-stale" : ""}
            ${this._outlineModeClass()} ${this._idClass()}">
                ${outlines.map(({ points, image }) => {
                    const clickable = !image && !stale && !this._cardHitTest;
                    return svg`<polygon class="room-outline ${clickable ? "clickable" : ""}"
                         points="${points.map(p => p.join(", ")).join(" ")}"
                         @click="${clickable ? async (): Promise<void> => this.click() : undefined}">
                </polygon>`;
                })}
            </g>
        `;
    }

    /** The room's icon, label pill and stale marker, for the layer above every outline. */
    public renderLabels(): SVGTemplateResult {
        const { stale, highlighted, order } = this._state();
        // Every room label is a pill (see `renderPill`). When a room shows a name and has an
        // outline to tap, selecting it replaces its icon with the badged pill. A room marked only
        // by its icon (no label, or `map_source.room_labels: false`) keeps its icon in the
        // selected colours instead — and adds the order badge at the icon's corner when
        // `cleaning_order` is on — so the icon stays visible and clickable. A room with a name but
        // no outline also keeps its icon so it can still be deselected. A stale room is never
        // highlighted: it is not a valid part of a run.
        const pill = highlighted && !stale;
        const name = this._context.showRoomLabels() ? this._config.label?.text?.trim() || undefined : undefined;
        const hasIcon = this._config.icon != null;
        const hasOutline =
            this._segments.length > 0 || this._imageOutline !== undefined || (this._config.outline?.length ?? 0) > 0;
        const iconOnly = hasIcon && !name;
        const keepIcon = iconOnly || (hasIcon && !hasOutline);
        const showPill = name !== undefined || (pill && (!iconOnly || order > 0));
        const anchor = showPill ? (iconOnly ? this._iconBadgeAnchor() : this._pillAnchor()) : undefined;
        return svg`
            <g class="room-label-layer ${highlighted ? "selected" : ""} ${stale ? "room-stale" : ""} ${this._idClass()}">
                ${pill && !keepIcon ? svg`` : this.renderIcon(this._config.icon, () => this.click(), "room-icon-wrapper", undefined, !stale)}
                ${anchor ? this.renderPill(anchor.origin, anchor.offset, name, pill ? (order > 0 ? order : "check") : undefined, "room-label") : svg``}
                ${this.renderStaleMarker(stale)}
            </g>
        `;
    }

    /** The class that names the room in the DOM; both its outline group and its label group carry it. */
    private _idClass(): string {
        return `room-${`${this._config.id}`.replace(/[^a-zA-Z0-9_-]/gm, "_")}-wrapper`;
    }

    /** The outline-visibility modifier class from `map_source.room_outlines`, or empty for the default (`true`). */
    private _outlineModeClass(): string {
        switch (this._context.roomOutlinesMode()) {
            case false:
                return "outline-hidden";
            case "selected":
                return "outline-selected-only";
            case "never":
                return "outline-never";
            default:
                return "";
        }
    }

    /**
     * Whether the room is stale, highlighted or part of a run, and its number in the order. Read once
     * per render: the live metadata decides staleness, and the accessor rebuilds its id set.
     */
    private _state(): { stale: boolean; highlighted: boolean; runOrder: number; order: number } {
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
        return { stale, highlighted, runOrder, order };
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
     * Top-right corner of the room's icon, in scaled map pixels, for the cleaning-order badge of
     * an icon-only room (`cleaning_order: true`). Stepped in screen space after counter-rotation
     * so the badge stays at the icon's top-right corner at every zoom and rotation.
     */
    private _iconBadgeAnchor(): { origin: [number, number]; offset: [number, number] } | undefined {
        const icon = this._config.icon;
        if (!icon) return undefined;
        const origin = this.vacuumToScaledMap(icon.x, icon.y) as [number, number];
        const raw = this.scaledCss("--map-card-internal-room-icon-wrapper-size");
        const size = Number.isFinite(raw) && raw > 0 ? raw : this.scaled(36);
        const shift = size * 0.44;
        return { origin, offset: [shift, -shift] };
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
     * The marker's size and its clearance from the pill are entirely stylesheet expressions of the
     * same variables the pill uses (`--map-card-internal-room-label-font-size`, divided by
     * `--map-scale`), so a theme font in any unit - `rem`, `em`, `vw`, `calc()` - and a live theme
     * change reach the marker with no card render and no computed-style read: the card never learns
     * how big the marker is. What the stylesheet cannot know is the room: it decides where inside
     * the outline there is space, so the card hands it the free space from the label point along
     * each screen direction, in map units, as custom properties on the marker, and CSS picks the
     * placement from those with `min()`/`max()`.
     *
     * Preferred is above the pill, clear of the whole of it. Where the room has no space for that,
     * the marker moves to the pill's badge side, above the pill's name - the one clearance from a
     * name that another element's CSS cannot measure, because the pill is as wide as its text - and
     * where the room has no space above at all the same clearance is taken below the pill, which is
     * what keeps a room at the image's top edge from clipping it. A room with none of the three still
     * gets the marker, over the pill's edge; stale rooms are appended after the live ones in
     * `setCurrentMode`, so it stays painted above them.
     *
     * The space is measured on screen: at a rotation other than 0 the screen's "up" is a turned
     * direction in map coordinates, and the marker's own transform stays `renderLabel`'s, so nothing
     * here repeats the counter-rotation.
     */
    private renderStaleMarker(stale: boolean): SVGTemplateResult {
        if (!stale) return svg``;
        // The point the live room with the same geometry centres its pill on: the label, else the
        // icon (a badge-only room), else the middle of the outline. The label's configured offset is
        // deliberately excluded - a detected room's label has none.
        const anchor = this._config.label ?? this._config.icon ?? this._outlineCenter();
        const outline = this._outlinePoints();
        if (!anchor || outline.length < 3) return svg``;

        const [x, y] = this.vacuumToScaledMap(anchor.x, anchor.y);
        const space = this._staleMarkerSpace(outline, [x, y], this._context.mapRotation());
        return this.renderLabel(
            { x: anchor.x, y: anchor.y, text: "!" },
            "room-stale-marker",
            undefined,
            `--stale-marker-up: ${space.up}px; --stale-marker-down: ${space.down}px;
             --stale-marker-left: ${space.left}px; --stale-marker-right: ${space.right}px;`,
        );
    }

    /**
     * The free space from `point` to the outline, along each of the four screen directions, in map
     * units (the unit the label's offset is measured in). A ray per direction, against the polygon
     * itself: a bounding box would put the space of an L-shaped room's leg into its notch, and the
     * marker would land in the neighbouring room.
     */
    private _staleMarkerSpace(
        outline: Array<[number, number]>,
        point: [number, number],
        rotation: number,
    ): StaleMarkerSpace {
        const radians = (rotation * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        // A screen direction in map coordinates: the map is drawn turned by `rotation`, so a screen
        // vector is turned back by the same angle before it is traced through the outline.
        const trace = (screenX: number, screenY: number): number => {
            const direction: [number, number] = [screenX * cos + screenY * sin, -screenX * sin + screenY * cos];
            // A ray that never crosses the outline (a label point outside its own room, a degenerate
            // outline) leaves no space that way; the stylesheet then treats it as such instead of
            // receiving an infinite length.
            const distance = this._distanceToOutline(outline, point, direction);
            return Number.isFinite(distance) ? Math.max(0, distance) : 0;
        };
        return {
            up: trace(0, -1),
            down: trace(0, 1),
            left: trace(-1, 0),
            right: trace(1, 0),
        };
    }

    /**
     * How far a ray from `origin` along the unit `direction` travels before it crosses the polygon,
     * in map units; `Infinity` when it never does. The nearest crossing is the outline in front of
     * the point, whichever way the outline runs.
     */
    private _distanceToOutline(
        outline: Array<[number, number]>,
        origin: [number, number],
        direction: [number, number],
    ): number {
        let nearest = Infinity;
        for (let index = 0; index < outline.length; index++) {
            const start = outline[index];
            const end = outline[(index + 1) % outline.length];
            const edge: [number, number] = [end[0] - start[0], end[1] - start[1]];
            // origin + t * direction = start + u * edge
            const denominator = direction[0] * edge[1] - direction[1] * edge[0];
            if (Math.abs(denominator) < 1e-9) continue;
            const offsetX = start[0] - origin[0];
            const offsetY = start[1] - origin[1];
            const t = (offsetX * edge[1] - offsetY * edge[0]) / denominator;
            const u = (offsetX * direction[1] - offsetY * direction[0]) / denominator;
            if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) nearest = Math.min(nearest, t);
        }
        return nearest;
    }

    /** The configured or detected outline in scaled map coordinates. */
    private _outlinePoints(): Array<[number, number]> {
        return this._imageOutline
            ? this._imageOutline.map(p => this.realScaled2Point(p) as [number, number])
            : (this._config?.outline ?? []).map(p => this.vacuumToScaledMap(p[0], p[1]) as [number, number]);
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

            /* A configured room whose id is no longer in the camera metadata: an exclamation mark
               placed above the room's label point. Its size and its clearance from the pill are CSS
               expressions of the very variables the label and the pill are sized with, so a theme
               font in any unit (px, rem, em, %, vw, calc()) and a live theme change reach the marker
               with no card render and no computed-style read. The card supplies only the room, as
               --stale-marker-up/-down/-left/-right: the free space from the label point to the
               outline along each screen direction, in map units. The anchor, the counter-rotation and
               the transform come from the shared .label-text rule; this rule adds the placement to it
               with --label-shift-x and --label-shift-y.
               Lengths are map units: a screen length divided by the zoom, exactly like the label's
               own font, so the marker stays the same size on screen at every zoom. */
            text.room-stale-marker {
                /* The marker's own box, measured from the rendered glyph: an SVG text's box carries
                   the font's ascent and descent and sits a little above its anchor - 1.16 em tall,
                   about 0.66 em above the anchor and 0.5 em below. */
                --stale-marker-above: 0.66em;
                --stale-marker-below: 0.5em;
                --stale-marker-half-width: 0.2em;
                /* The distance kept from the room's outline, on screen. */
                --stale-marker-inset: calc(1px / var(--map-scale));
                /* The pill: two label fonts tall, its name one font tall in the middle of it. */
                --stale-marker-pill-half: calc(var(--map-card-internal-room-label-font-size) / var(--map-scale));
                --stale-marker-gap: calc(6px / var(--map-scale));
                /* Clear of the whole pill above: the marker's lower half clears the pill's top edge. */
                --stale-marker-clear-up: calc(
                    var(--stale-marker-pill-half) + var(--stale-marker-gap) + var(--stale-marker-below)
                );
                /* Above the pill's name, which ends half a label font above the pill's middle. The
                   pill's width is its text's, which no element's CSS can measure from another, so a
                   name is the one clearance the marker cannot prove horizontally: it proves it
                   vertically, and every arm below keeps this one. */
                --stale-marker-name-up: calc(
                    var(--stale-marker-pill-half) / 2 + var(--stale-marker-gap) + var(--stale-marker-below)
                );
                /* The same two clearances below the pill, where the marker's upper half is the one
                   that has to clear. */
                --stale-marker-clear-down: calc(
                    var(--stale-marker-pill-half) + var(--stale-marker-gap) + var(--stale-marker-above)
                );
                --stale-marker-name-down: calc(
                    var(--stale-marker-pill-half) / 2 + var(--stale-marker-gap) + var(--stale-marker-above)
                );
                /* Beside the pill's badge end. The pill is as wide as its text, which no element's
                   CSS can measure here, so the clearance is taken from its height: the badge is a
                   disc of the pill's height, and one more height covers its padding and the gap. */
                --stale-marker-beside: calc(
                    var(--stale-marker-pill-half) * 2 + var(--stale-marker-gap) + var(--stale-marker-half-width)
                );
                /* How short the room is, in map units, of the placement above and of the badge side:
                   zero when it is not short at all. A shortage is multiplied up, so it can stand in
                   for a branch in the two placements below. "Above" is judged by the least the marker
                   needs up there - clear of the pill's name - so a room that cannot hold the whole
                   pill's clearance still keeps the marker above it, hugging the room's top edge. */
                --stale-marker-short-above: max(
                    0px,
                    var(--stale-marker-name-up) + var(--stale-marker-above) - var(--stale-marker-up)
                );
                --stale-marker-short-left: max(
                    0px,
                    var(--stale-marker-half-width) - var(--stale-marker-left)
                );
                /* How short the room is of the whole pill's clearance above: the marker overlaps the
                   pill whenever it is not zero, and takes the pill's badge side. */
                --stale-marker-short-clear: max(
                    0px,
                    var(--stale-marker-clear-up) + var(--stale-marker-above) - var(--stale-marker-up)
                );
                /* Above the pill while the room has the space there, else as high as the room allows,
                   and never lower than above the pill's name. When even that does not fit the room,
                   the same clearance is taken below the pill: a room at the map's top edge has no
                   space above it, and a marker pushed there is cut off by the map. */
                --label-shift-y: min(
                    calc(
                        -1 *
                            min(
                                var(--stale-marker-clear-up),
                                max(
                                    calc(var(--stale-marker-up) - var(--stale-marker-above) - var(--stale-marker-inset)),
                                    var(--stale-marker-name-up)
                                )
                            ) + 10000 * var(--stale-marker-short-above)
                    ),
                    min(
                        var(--stale-marker-clear-down),
                        max(
                            calc(var(--stale-marker-down) - var(--stale-marker-below) - var(--stale-marker-inset)),
                            var(--stale-marker-name-down)
                        )
                    )
                );
                /* The horizontal placement, used only when the way above is too short: the badge side
                   of the room, or the other side when that one has no room, never past the outline. */
                --stale-marker-away-left: min(
                    0px,
                    max(calc(-1 * var(--stale-marker-beside)), calc(var(--stale-marker-half-width) - var(--stale-marker-left)))
                );
                --stale-marker-away-right: max(
                    0px,
                    min(var(--stale-marker-beside), calc(var(--stale-marker-right) - var(--stale-marker-half-width)))
                );
                --label-shift-x: max(
                    calc(-10000 * var(--stale-marker-short-clear)),
                    var(--stale-marker-away-left),
                    min(
                        var(--stale-marker-away-right),
                        calc(var(--stale-marker-away-left) + 10000 * var(--stale-marker-short-left))
                    )
                );
                /* 1.4 label fonts, and never so large that the room cannot hold it even in its longer
                   direction: a room smaller than the marker still shows it, shrunk. */
                font-size: min(
                    calc(var(--map-card-internal-room-label-font-size) * 1.4 / var(--map-scale)),
                    calc(
                        min(
                                calc(var(--stale-marker-up) + var(--stale-marker-down)),
                                calc(var(--stale-marker-left) + var(--stale-marker-right))
                            ) *
                            0.5
                    )
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
            .room-label-layer.room-stale,
            .room-label-layer.room-stale .map-icon-wrapper {
                pointer-events: none;
            }

            .room-wrapper.selected > .room-outline {
                stroke: var(--map-card-internal-room-outline-line-color-selected);
                fill: var(--map-card-internal-room-outline-fill-color-selected);
            }

            /* map_source.room_outlines: false | "selected" | "never" (#124). Only the stroke is
               hidden: the polygon keeps its fill, so it stays the hit target and hover target, and
               a selected or running room keeps its fill tint. Stale rooms always keep their red
               outline so broken room ids stay obvious. */
            .room-wrapper.outline-hidden:not(.selected):not(.room-stale) > .room-outline,
            .room-wrapper.outline-selected-only:not(.selected):not(.room-stale) > .room-outline {
                stroke: transparent;
            }

            @media (hover: hover) {
                .room-wrapper.outline-hidden:not(.selected):not(.room-stale):hover > .room-outline {
                    stroke: var(--map-card-internal-room-outline-line-color);
                }
            }

            .room-wrapper.outline-never:not(.room-stale) > .room-outline {
                stroke: transparent;
            }

            .room-label-layer.selected .room-icon-wrapper {
                background: var(--map-card-internal-room-icon-background-color-selected);
                color: var(--map-card-internal-room-icon-color-selected);
            }


        `;
    }
}
