// noinspection CssUnresolvedCustomProperty

import { css, CSSResultGroup, svg, SVGTemplateResult } from "lit";
import { forwardHaptic } from "custom-card-helpers";

import { Context } from "./context";
import { deleteFromArray, stopEvent } from "../../utils";
import { PointType, RectangleType, ZoneType } from "../../types/types";
import { MapObject } from "./map-object";
import {
    angleDegrees,
    orderedZone,
    resizeRotatedZone,
    rotatedZoneCorners,
    rotatePoint,
    snapAngle,
    zoneCentre,
} from "../rotated-zone";

/** Material Design Icons `rotate-right`. */
const ROTATE_ICON_PATH =
    "M16.89,15.5L18.31,16.89C19.21,15.73 19.76,14.39 19.93,13H17.91C17.77,13.87 17.43,14.72 16.89,15.5M13,17.9V19.92C14.39,19.75 15.74,19.21 16.9,18.31L15.46,16.87C14.71,17.41 13.87,17.76 13,17.9M19.93,11C19.76,9.61 19.21,8.27 18.31,7.11L16.89,8.53C17.43,9.28 17.77,10.13 17.91,11M15.55,5.55L11,1V4.07C7.06,4.56 4,7.92 4,12C4,16.08 7.05,19.44 11,19.93V17.91C8.16,17.43 6,14.97 6,12C6,9.03 8.16,6.57 11,6.09V10L15.55,5.55Z";

enum DragMode {
    NONE,
    RESIZE,
    MOVE,
    ROTATE,
}

export class ManualRectangle extends MapObject {
    public _id: string;

    private _selectedTarget!: EventTarget | null;
    private _selectedElement!: SVGGraphicsElement | null;
    private _dragMode: DragMode;

    private _vacRect: ZoneType;
    private _vacRectSnapshot: ZoneType;
    private _startPointSnapshot!: PointType;

    /**
     * Radians the zone is turned around its centre, in vacuum coordinates. Always 0 unless the zone
     * is `rotatable` (`MANUAL_ROTATABLE_RECTANGLE`); `_vacRect` stays the unrotated box.
     */
    private _angle = 0;
    private _angleSnapshot = 0;

    constructor(
        x: number,
        y: number,
        width: number,
        height: number,
        id: string,
        context: Context,
        public readonly rotatable = false,
    ) {
        super(context);
        this._id = id;
        this._dragMode = DragMode.NONE;
        this._vacRect = this._toVacuumFromDimensions(x, y, width, height);
        this._vacRectSnapshot = this._vacRect;
    }

    /** The rotation in radians; 0 for a zone that cannot rotate. */
    public get angle(): number {
        return this._angle;
    }

    /** Turns a rotatable zone, snapped as a drag of the rotate handle is. Ignored otherwise. */
    public setAngle(angle: number): void {
        if (!this.rotatable) return;
        this._angle = snapAngle(angle);
        this.update();
    }

    /**
     * The corners on the map and in vacuum coordinates, in the order the handles use: the
     * description at 0, rotate at 1, resize at 2 and delete at 3. The order is taken from the
     * unrotated box, so the handles stay on their corners while the zone turns.
     */
    private _corners(rect: ZoneType = this._vacRect, angle: number = this._angle): [RectangleType, RectangleType] {
        const [mapAtZero, vacuumAtZero] = this.vacuumToMapRect(rect);
        if (angle === 0) return [mapAtZero, vacuumAtZero];
        const centre = zoneCentre(rect);
        const vacuum = vacuumAtZero.map(p => rotatePoint(p, centre, angle)) as RectangleType;
        return [vacuum.map(p => this.vacuumToScaledMap(p[0], p[1])) as RectangleType, vacuum];
    }

    /** The centre of a rectangle given by its four corners, in the same space. */
    private static _centre(rect: RectangleType): PointType {
        return [
            rect.reduce((sum, p) => sum + p[0], 0) / rect.length,
            rect.reduce((sum, p) => sum + p[1], 0) / rect.length,
        ];
    }

    private static _toPoints(rect: RectangleType): string {
        const points = rect
            .filter(p => !isNaN(p[0]) && !isNaN(p[1]))
            .map(p => p.join(", "))
            .join(" ");
        if (points.length == 3) console.error(`Points: ${points}`);
        return points;
    }

    public render(): SVGTemplateResult {
        const mapRect = this._corners()[0];
        const descriptionPoint = mapRect[0];
        const movePoint = mapRect[2];
        const deletePoint = mapRect[3];
        const rotatePoint = mapRect[1];
        const angle = ManualRectangle.calcAngle(mapRect[0], mapRect[3]);
        return svg`
            <g class="manual-rectangle-wrapper ${this.isSelected() ? "selected" : ""} ${
                this.rotatable ? "rotatable" : ""
            }"
               style="--x-resize:${movePoint[0]}px; 
                      --y-resize:${movePoint[1]}px;
                      --x-rotate:${rotatePoint[0]}px;
                      --y-rotate:${rotatePoint[1]}px;
                      --x-delete:${deletePoint[0]}px;
                      --y-delete:${deletePoint[1]}px;
                      --x-description:${descriptionPoint[0]}px;
                      --y-description:${descriptionPoint[1]}px;
                      --angle-description: ${angle}rad;">
                <polygon class="manual-rectangle-halo" points="${ManualRectangle._toPoints(mapRect)}"></polygon>
                <polygon class="manual-rectangle draggable movable"
                         @mousedown="${(e: MouseEvent): void => this._startDrag(e)}"
                         @mousemove="${(e: MouseEvent): void => this._drag(e)}"
                         @mouseup="${(e: MouseEvent): void => this._endDrag(e)}"
                         @touchstart="${(e: MouseEvent): void => this._startDrag(e)}"
                         @touchmove="${(e: MouseEvent): void => this._drag(e)}"
                         @touchend="${(e: MouseEvent): void => this._endDrag(e)}"
                         @touchleave="${(e: MouseEvent): void => this._endDrag(e)}"
                         @touchcancel="${(e: MouseEvent): void => this._endDrag(e)}"
                         points="${ManualRectangle._toPoints(mapRect)}">
                </polygon>
                <g class="manual-rectangle-description">
                    ${this._renderLabel(mapRect)}
                </g>
                <circle class="manual-rectangle-delete-circle clickable"
                        @mouseup="${(e: MouseEvent): void => this._delete(e)}"></circle>
                <path class="manual-rectangle-delete-icon"
                      d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z">
                </path>
                <circle class="manual-rectangle-resize-circle draggable resizer"
                        @mousedown="${(e: MouseEvent): void => this._startDrag(e)}"
                        @mousemove="${(e: MouseEvent): void => this._drag(e)}"
                        @mouseup="${(e: MouseEvent): void => this._endDrag(e)}"
                        @touchstart="${(e: MouseEvent): void => this._startDrag(e)}"
                        @touchmove="${(e: MouseEvent): void => this._drag(e)}"
                        @touchend="${(e: MouseEvent): void => this._endDrag(e)}"
                        @touchleave="${(e: MouseEvent): void => this._endDrag(e)}"
                        @touchcancel="${(e: MouseEvent): void => this._endDrag(e)}">
                </circle>
                <path class="manual-rectangle-resize-icon"
                      d="M13,21H21V13H19V17.59L6.41,5H11V3H3V11H5V6.41L17.59,19H13V21Z">
                </path>
                ${this.rotatable ? this._renderRotateHandle() : ""}
            </g>
        `;
    }

    /**
     * The zone's label: the same pill the rooms wear, at the zone's centre, upright and the same size
     * on screen at any zoom and rotation. The badge is the zone's number, the text its size (and its
     * angle when turned). The pill ignores the pointer, so a drag that starts on it moves the zone.
     */
    private _renderLabel(mapRect: RectangleType): SVGTemplateResult {
        const centre = ManualRectangle._centre(mapRect);
        const number = Number(this._id);
        return this.renderPill(
            centre,
            [0, 0],
            this._getDimensions() || undefined,
            Number.isFinite(number) ? number : undefined,
            "manual-rectangle-label",
        );
    }

    private _renderRotateHandle(): SVGTemplateResult {
        return svg`
            <circle class="manual-rectangle-rotate-circle draggable rotator"
                    @mousedown="${(e: MouseEvent): void => this._startDrag(e)}"
                    @mousemove="${(e: MouseEvent): void => this._drag(e)}"
                    @mouseup="${(e: MouseEvent): void => this._endDrag(e)}"
                    @touchstart="${(e: MouseEvent): void => this._startDrag(e)}"
                    @touchmove="${(e: MouseEvent): void => this._drag(e)}"
                    @touchend="${(e: MouseEvent): void => this._endDrag(e)}"
                    @touchleave="${(e: MouseEvent): void => this._endDrag(e)}"
                    @touchcancel="${(e: MouseEvent): void => this._endDrag(e)}">
            </circle>
            <path class="manual-rectangle-rotate-icon" d="${ROTATE_ICON_PATH}"></path>
        `;
    }

    public isSelected(): boolean {
        return this._selectedElement != null;
    }

    public externalDrag(event: MouseEvent | TouchEvent): void {
        this._drag(event);
    }

    /**
     * The zone as the service gets it: `[x1, y1, x2, y2]`, or for a rotatable zone its four corners
     * `[x1, y1, x2, y2, x3, y3, x4, y4]` in the order `rotatedZoneCorners` documents (also at angle
     * 0, so the payload has one shape). Repeats are appended for `INTERNAL` repeats.
     */
    public toVacuum(repeats: number | null = null): number[] {
        const ordered = orderedZone(this._vacRect);
        const zone: number[] = this.rotatable
            ? rotatedZoneCorners(ordered, this._angle).flatMap(p => this._context.roundMap(p))
            : ordered;
        if (repeats != null) {
            return [...zone, repeats];
        }
        return zone;
    }

    private _getDimensions(): string {
        const [x1, y1, x2, y2] = orderedZone(this._vacRect);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const divider = this._context.coordinatesToMetersDivider();
        if (divider === -1) return "";
        const rounder = (v: number): string => (v / divider).toFixed(1);
        const angle = this._angle !== 0 ? ` ${angleDegrees(this._angle)}°` : "";
        const unit = this.localize("unit.meter_shortcut");
        return `${rounder(width)} ${unit} × ${rounder(height)} ${unit}${angle ? ` ·${angle}` : ""}`;
    }

    private _startDrag(event: MouseEvent | TouchEvent): void {
        if (window.TouchEvent && event instanceof TouchEvent && (event as TouchEvent).touches.length > 1) {
            return;
        }
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        if (!(<Element>event.target).classList.contains("draggable")) {
            return;
        }
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        if (!(<Element>event.target).parentElement?.classList.contains("manual-rectangle-wrapper")) {
            return;
        }
        if (!(event.target as SVGGraphicsElement).parentElement) {
            return;
        }
        stopEvent(event);
        this._selectedTarget = event.target;
        const targetElement = event.target as SVGGraphicsElement;
        if (targetElement.classList.contains("movable")) {
            this._dragMode = DragMode.MOVE;
        } else if (targetElement.classList.contains("resizer")) {
            this._dragMode = DragMode.RESIZE;
        } else if (targetElement.classList.contains("rotator") && this.rotatable) {
            this._dragMode = DragMode.ROTATE;
        } else {
            this._dragMode = DragMode.NONE;
        }
        this._selectedElement = (event.target as SVGGraphicsElement).parentElement as unknown as SVGGraphicsElement;
        this._vacRectSnapshot = [...this._vacRect];
        this._angleSnapshot = this._angle;
        const mousePosition = this.getMousePosition(event);
        this._startPointSnapshot = this.scaledMapToVacuum(mousePosition.x, mousePosition.y);
        this.update();
    }

    private _drag(event: MouseEvent | TouchEvent): void {
        if (window.TouchEvent && event instanceof TouchEvent && (event as TouchEvent).touches.length > 1) {
            return;
        }
        if (this._selectedElement) {
            stopEvent(event);
            const coord = this.getMousePosition(event);
            if (coord) {
                const currentPoint = this.scaledMapToVacuum(coord.x, coord.y);
                const diffX = currentPoint[0] - this._startPointSnapshot[0];
                const diffY = currentPoint[1] - this._startPointSnapshot[1];
                switch (this._dragMode) {
                    case DragMode.MOVE:
                        this._vacRect = [
                            this._vacRectSnapshot[0] + diffX,
                            this._vacRectSnapshot[1] + diffY,
                            this._vacRectSnapshot[2] + diffX,
                            this._vacRectSnapshot[3] + diffY,
                        ] as ZoneType;
                        this._setup(this._corners()[0]);
                        break;
                    case DragMode.ROTATE: {
                        const centre = zoneCentre(this._vacRectSnapshot);
                        const startAngle = Math.atan2(
                            this._startPointSnapshot[1] - centre[1],
                            this._startPointSnapshot[0] - centre[0],
                        );
                        const currentAngle = Math.atan2(currentPoint[1] - centre[1], currentPoint[0] - centre[0]);
                        this._angle = snapAngle(this._angleSnapshot + currentAngle - startAngle);
                        this._setup(this._corners()[0]);
                        break;
                    }
                    case DragMode.RESIZE:
                        if (this._angle !== 0) {
                            this._resizeRotated(diffX, diffY);
                            break;
                        }
                        const topLeftVacuumPoint = this.vacuumToMapRect(this._vacRectSnapshot)[1][0];
                        const tmpSnapshot = [...this._vacRect] as ZoneType;
                        if (topLeftVacuumPoint[0] === this._vacRectSnapshot[0]) {
                            this._vacRect[2] = this._vacRectSnapshot[2] + diffX;
                        } else {
                            this._vacRect[0] = this._vacRectSnapshot[0] + diffX;
                        }
                        if (topLeftVacuumPoint[1] === this._vacRectSnapshot[1]) {
                            this._vacRect[3] = this._vacRectSnapshot[3] + diffY;
                        } else {
                            this._vacRect[1] = this._vacRectSnapshot[1] + diffY;
                        }
                        if (
                            Math.sign(this._vacRect[0] - this._vacRect[2]) !=
                                Math.sign(tmpSnapshot[0] - tmpSnapshot[2]) ||
                            Math.sign(this._vacRect[1] - this._vacRect[3]) != Math.sign(tmpSnapshot[1] - tmpSnapshot[3])
                        )
                            this._vacRect = tmpSnapshot;
                        this._setup(this._corners()[0]);
                        break;
                    case DragMode.NONE:
                        break;
                }
            }
        }
    }

    /**
     * Resize of a turned zone: the resize corner follows the pointer and the opposite corner stays
     * put, measured along the zone's own sides.
     */
    private _resizeRotated(diffX: number, diffY: number): void {
        const [, vacuumAtZero] = this._corners(this._vacRectSnapshot, 0);
        const [, vacuum] = this._corners(this._vacRectSnapshot, this._angle);
        const fixed = vacuum[0];
        const moved: PointType = [vacuum[2][0] + diffX, vacuum[2][1] + diffY];
        const previousDiagonal: PointType = [
            vacuumAtZero[2][0] - vacuumAtZero[0][0],
            vacuumAtZero[2][1] - vacuumAtZero[0][1],
        ];
        const resized = resizeRotatedZone(fixed, moved, previousDiagonal, this._angle);
        if (resized) this._vacRect = resized;
        this._setup(this._corners()[0]);
    }

    private _setup(mapRect: RectangleType): void {
        // A drag reshapes the zone without a render: the outline, its halo and the label follow here.
        const points = ManualRectangle._toPoints(mapRect);
        this._selectedElement?.querySelector?.("polygon.manual-rectangle")?.setAttribute("points", points);
        this._selectedElement?.querySelector?.("polygon.manual-rectangle-halo")?.setAttribute("points", points);
        const anchor = this._selectedElement?.querySelector?.(".room-pill-anchor") as SVGElement | null | undefined;
        if (anchor) {
            const centre = ManualRectangle._centre(mapRect);
            anchor.style.setProperty("--room-pill-x", `${centre[0]}px`);
            anchor.style.setProperty("--room-pill-y", `${centre[1]}px`);
        }
        // Lit owns the name's text node (its markers sit around it), so change only its data: setting
        // textContent would remove the markers and break the next render.
        const name = this._selectedElement?.querySelector?.(".room-pill-name");
        const text = name
            ? Array.from(name.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim())
            : undefined;
        if (text) text.nodeValue = this._getDimensions();
        const descriptionPoint = mapRect[0];
        const movePoint = mapRect[2];
        const deletePoint = mapRect[3];
        const angle = ManualRectangle.calcAngle(mapRect[0], mapRect[3]);
        this._selectedElement?.style?.setProperty("--x-rotate", mapRect[1][0] + "px");
        this._selectedElement?.style?.setProperty("--y-rotate", mapRect[1][1] + "px");
        this._selectedElement?.style?.setProperty("--x-resize", movePoint[0] + "px");
        this._selectedElement?.style?.setProperty("--y-resize", movePoint[1] + "px");
        this._selectedElement?.style?.setProperty("--x-delete", deletePoint[0] + "px");
        this._selectedElement?.style?.setProperty("--y-delete", deletePoint[1] + "px");
        this._selectedElement?.style?.setProperty("--x-description", descriptionPoint[0] + "px");
        this._selectedElement?.style?.setProperty("--y-description", descriptionPoint[1] + "px");
        this._selectedElement?.style?.setProperty("--angle-description", angle + "rad");
    }

    private _endDrag(event: MouseEvent | TouchEvent): void {
        stopEvent(event);
        this._selectedElement = null;
        this._selectedTarget = null;
        this.update();
    }

    private _delete(event: MouseEvent | TouchEvent): void {
        stopEvent(event);
        const index = deleteFromArray(this._context.selectedManualRectangles(), this);
        if (index > -1) {
            for (let i = index; i < this._context.selectedManualRectangles().length; i++) {
                this._context.selectedManualRectangles()[i]._id = (i + 1).toString();
            }
            forwardHaptic("selection");
            this.update();
        }
    }

    private _toVacuumFromDimensions(x, y, width, height): [number, number, number, number] {
        const imageX = this.realScaled(x);
        const imageY = this.realScaled(y);
        const imageWidth = this.realScaled(width);
        const imageHeight = this.realScaled(height);
        const vacuumStart = this.realMapToVacuum(imageX, imageY);
        const vacuumEnd = this.realMapToVacuum(imageX + imageWidth, imageY + imageHeight);
        return orderedZone([vacuumStart[0], vacuumStart[1], vacuumEnd[0], vacuumEnd[1]]);
    }

    public static get styles(): CSSResultGroup {
        return css`
            .resizer {
                cursor: nwse-resize;
            }

            .movable {
                cursor: move;
            }

            .rotator {
                cursor: grab;
            }

            .manual-rectangle-wrapper {
            }

            .manual-rectangle-wrapper.selected {
            }

            /* A wider stroke in the card's background colour under the zone's own outline, so the
               outline reads on white floor and on coloured rooms alike. */
            .manual-rectangle-halo {
                fill: none;
                stroke: var(--map-card-internal-manual-rectangle-halo-color);
                stroke-linejoin: round;
                stroke-width: calc(
                    (var(--map-card-internal-manual-rectangle-line-width) + 2 * var(--map-card-internal-manual-rectangle-halo-width)) /
                        var(--map-scale)
                );
                pointer-events: none;
            }

            .manual-rectangle {
                stroke: var(--map-card-internal-manual-rectangle-line-color);
                stroke-linejoin: round;
                stroke-dasharray: calc(var(--map-card-internal-manual-rectangle-line-segment-line) / var(--map-scale)),
                    calc(var(--map-card-internal-manual-rectangle-line-segment-gap) / var(--map-scale));
                fill: var(--map-card-internal-manual-rectangle-fill-color);
                stroke-width: calc(var(--map-card-internal-manual-rectangle-line-width) / var(--map-scale));
            }

            .manual-rectangle-wrapper.selected > .manual-rectangle {
                stroke: var(--map-card-internal-manual-rectangle-line-color-selected);
                fill: var(--map-card-internal-manual-rectangle-fill-color-selected);
            }

            .manual-rectangle-delete-circle {
                r: calc(var(--map-card-internal-manual-rectangle-delete-circle-radius) / var(--map-scale));
                cx: var(--x-delete);
                cy: var(--y-delete);
                stroke: var(--map-card-internal-manual-rectangle-delete-circle-line-color);
                fill: var(--map-card-internal-manual-rectangle-delete-circle-fill-color);
                stroke-width: calc(
                    var(--map-card-internal-manual-rectangle-delete-circle-line-width) / var(--map-scale)
                );
            }

            .manual-rectangle-delete-icon {
                fill: var(--map-card-internal-manual-rectangle-delete-icon-color);
                /* move to the circle first, then unturn, so the glyph stays upright on top of it */
                transform: translate(var(--x-delete), var(--y-delete))
                    rotate(calc(-1 * var(--map-rotation, 0deg)))
                    translate(calc(-8.5px / var(--map-scale)), calc(-8.5px / var(--map-scale)))
                    scale(calc(0.71 / var(--map-scale)));
                pointer-events: none;
            }

            .manual-rectangle-wrapper.selected > .manual-rectangle-delete-circle {
                stroke: var(--map-card-internal-manual-rectangle-delete-circle-line-color-selected);
                fill: var(--map-card-internal-manual-rectangle-delete-circle-fill-color-selected);
                opacity: 50%;
            }

            .manual-rectangle-wrapper.selected > .manual-rectangle-delete-icon {
                fill: var(--map-card-internal-manual-rectangle-delete-icon-color-selected);
                opacity: 50%;
            }

            .manual-rectangle-resize-circle {
                r: calc(var(--map-card-internal-manual-rectangle-resize-circle-radius) / var(--map-scale));
                cx: var(--x-resize);
                cy: var(--y-resize);
                stroke: var(--map-card-internal-manual-rectangle-resize-circle-line-color);
                fill: var(--map-card-internal-manual-rectangle-resize-circle-fill-color);
                stroke-width: calc(
                    var(--map-card-internal-manual-rectangle-resize-circle-line-width) / var(--map-scale)
                );
            }

            .manual-rectangle-resize-icon {
                fill: var(--map-card-internal-manual-rectangle-resize-icon-color);
                transform: translate(var(--x-resize), var(--y-resize))
                    rotate(calc(-1 * var(--map-rotation, 0deg)))
                    translate(calc(-8.5px / var(--map-scale)), calc(-8.5px / var(--map-scale)))
                    scale(calc(0.71 / var(--map-scale)));
                pointer-events: none;
            }

            .manual-rectangle-wrapper.selected > .manual-rectangle-resize-circle {
                stroke: var(--map-card-internal-manual-rectangle-resize-circle-line-color-selected);
                fill: var(--map-card-internal-manual-rectangle-resize-circle-fill-color-selected);
                opacity: 50%;
            }

            .manual-rectangle-wrapper.selected > .manual-rectangle-resize-icon {
                fill: var(--map-card-internal-manual-rectangle-resize-icon-color-selected);
                opacity: 50%;
            }

            /* The rotate handle wears the resize handle's colours: both reshape the zone. */
            .manual-rectangle-rotate-circle {
                r: calc(var(--map-card-internal-manual-rectangle-resize-circle-radius) / var(--map-scale));
                cx: var(--x-rotate);
                cy: var(--y-rotate);
                stroke: var(--map-card-internal-manual-rectangle-resize-circle-line-color);
                fill: var(--map-card-internal-manual-rectangle-resize-circle-fill-color);
                stroke-width: calc(
                    var(--map-card-internal-manual-rectangle-resize-circle-line-width) / var(--map-scale)
                );
            }

            .manual-rectangle-rotate-icon {
                fill: var(--map-card-internal-manual-rectangle-resize-icon-color);
                transform: translate(var(--x-rotate), var(--y-rotate))
                    rotate(calc(-1 * var(--map-rotation, 0deg)))
                    translate(calc(-8.5px / var(--map-scale)), calc(-8.5px / var(--map-scale)))
                    scale(calc(0.71 / var(--map-scale)));
                pointer-events: none;
            }

            .manual-rectangle-wrapper.selected > .manual-rectangle-rotate-circle {
                stroke: var(--map-card-internal-manual-rectangle-resize-circle-line-color-selected);
                fill: var(--map-card-internal-manual-rectangle-resize-circle-fill-color-selected);
                opacity: 50%;
            }

            .manual-rectangle-wrapper.selected > .manual-rectangle-rotate-icon {
                fill: var(--map-card-internal-manual-rectangle-resize-icon-color-selected);
                opacity: 50%;
            }
        `;
    }
}
