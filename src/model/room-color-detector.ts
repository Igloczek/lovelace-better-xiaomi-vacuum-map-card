import { MapExtractorRoom, PointType } from "../types/types";
import { CoordinatesConverter } from "./map_objects/coordinates-converter";
import { CameraRoom, readCameraRooms } from "./camera-rooms";

interface PixelBounds {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

/** A metadata room with usable geometry, in image pixels. */
interface RoomEntry {
    readonly id: string;
    readonly bounds: PixelBounds;
    /** The room's metadata shape: its own outline, or its bounds rectangle. */
    readonly polygon: PointType[];
    /**
     * Whether the room is traced from the colours. Rooms described by bounds always are; a room
     * with its own outline is too, unless an earlier pass found its trace disagrees with that
     * outline, which is then kept as it is.
     */
    readonly detectable: boolean;
    /** The camera publishes the room's own outline, not only its bounds. */
    readonly ownOutline: boolean;
    /** Colours that cover enough of the room's bounds to be its fill, most frequent first. */
    readonly colorKeys: number[];
}

interface RoomCandidate {
    readonly id: string;
    readonly bounds: PixelBounds;
    /** Colours that cover enough of the room's bounds to be its fill, most frequent first. */
    readonly colorKeys: number[];
    /** Every other metadata room. */
    readonly others: RoomEntry[];
}

/**
 * A room of one contested fill colour, as the shared-floor attribution sees it. Only rooms the
 * plain trace detected are attributed: a room the camera describes with its own outline is kept as
 * it is, and only bounds-described rooms compete for a colour's patches.
 */
interface FloorRoom {
    /** The room's label in the image-wide label map. */
    readonly label: number;
    readonly id: string;
    /** The room's camera bounds, which are also its metadata shape for a traced room. */
    readonly bounds: PixelBounds;
    readonly colorKey: number;
}

/** The connected floor patches of one fill colour, with what each room's bounds contain. */
interface ColourFloors {
    readonly colorKey: number;
    /** The patch of this colour at each image pixel; -1 where the pixel is not that colour. */
    readonly patch: Int32Array;
    readonly sizes: number[];
    readonly boxes: PixelBounds[];
    /** `counts[room][patch]`: how many of a patch's pixels lie inside a room's bounds. */
    readonly counts: Uint32Array[];
    readonly shapeAreas: number[];
    /** The patch that fills each room's bounds best, if any. */
    readonly anchors: Array<number | undefined>;
    /** How many of a patch's pixels lie inside an undetected room's reserved shape. */
    readonly reservedCounts: number[];
}

export interface DetectedRoomColor {
    readonly id: string;
    readonly colorKey: number;
    readonly center: PointType;
    readonly outline: PointType[];
}

/**
 * The part of `ImageData` room detection reads. Declaring it lets PNG fixtures and other pure
 * pixel buffers go through `detectFromImageData` without a browser canvas, while a real
 * `ImageData` still satisfies it.
 */
export interface ImageDataLike {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

/**
 * What a detection may do beyond the plain per-room trace. The colour attribution for shared floors
 * is on by default; a caller that needs the plain trace (the differential tests that keep the
 * pre-attribution result as the reference) turns it off.
 */
export interface RoomDetectionOptions {
    readonly roomColorAttribution?: boolean;
    /**
     * Whether rooms that publish their own outline are traced too (on by default). Off keeps every
     * such room to its published outline, as the card did before issue #77.
     */
    readonly outlineTracing?: boolean;
}

export interface RoomColorDetection {
    readonly imageData: ImageDataLike;
    readonly regions: DetectedRoomColor[];
    /**
     * The first room detected for each fill colour. Map sources reuse colours (Valetudo and Dreame
     * colour segments from a four-colour palette), so this is not a tap lookup: use `roomIdAt`.
     */
    readonly roomIdByColor: Map<number, string>;
    /**
     * The room under each image pixel, as an index into `labelRoomIds` (-1 for none). Unlike the
     * colour lookup it covers what the map draws over a room (cleaning paths, the robot, icons,
     * furniture) and tells apart rooms that share a colour. Use `RoomColorDetector.roomIdAt`.
     */
    readonly labels: Int16Array;
    readonly labelRoomIds: string[];
    /**
     * What the detection depends on besides the pixels: image size, calibration and every room's
     * metadata shape (`RoomColorDetector.geometryKey`). A newer snapshot of the same map with the
     * same key only moved the robot or extended a path.
     */
    readonly geometryKey?: string;
    /** Every room described by bounds was found. */
    readonly complete?: boolean;
}

/**
 * Gaps up to twice this many pixels wide inside a room are closed: a cleaning path or the robot
 * drawn over the room's fill splits the colour mask, which made the room shrink to its largest
 * piece and left the path unclickable. Another room's colour is never claimed.
 */
const GAP_CLOSING_RADIUS = 4;

/**
 * How far past a room's camera bounds its colour is examined. A patch of the colour that reaches
 * this margin continues beyond the room, so it belongs to a larger neighbour that merely overlaps
 * the room's bounding box (an L-shaped room around another room).
 */
const BOUNDS_MARGIN = GAP_CLOSING_RADIUS + 4;

/**
 * An area no room colour covers but rooms enclose on every side (the robot, a room icon, furniture,
 * a no-go zone) belongs to the nearest enclosing room, up to this many pixels. Larger enclosed
 * areas are left alone: they are more likely an unsegmented part of the floor.
 */
const ENCLOSED_AREA_LIMIT = 64 * 64;

/**
 * A tap on something drawn at a room's edge (the docked robot, the charger, a wall) selects the
 * nearest room within this many pixels. The image background never does.
 */
const TAP_REACH = 10;

/**
 * A colour patch that fits a room's bounds this well (inside share x coverage) is taken without
 * scoring the room's other candidate colours (a path colour, a neighbour seen through the bounding
 * box). Those are scored only if the room ends up without a patch.
 */
const GOOD_FIT = 0.5;

/** The least share of its own bounds a room's fill covers. */
const MIN_COVERAGE = 0.15;

/**
 * A colour patch that lies this share inside a room's metadata shape may be that room's floor. The
 * shape is the room's own outline when the camera publishes one, its bounds rectangle otherwise.
 * A patch a room's own floor forms is wholly inside its shape; a neighbour's floor seen through an
 * interlocking bounding box is only partly inside.
 */
const PATCH_CONTAINMENT = 0.98;

/**
 * A room's floor patch is the patch that fills its shape best (containment x coverage). A room
 * whose best patch is also another room's best patch has no floor of its own in this colour (a
 * nested closet whose fill touches the room around it, or an open-plan pair with no drawn
 * boundary): the pixels cannot tell the rooms apart, so the plain trace is kept.
 */
const FLOOR_FIT = 0.2;

/**
 * A room keeps at least this share of the pixels the plain trace gave it, unless everything it lost
 * is the gaining room's own floor: two interlocking L-shaped rooms share more than half of their
 * bounding boxes, so giving a neighbour its arm back can cost a room most of what the plain trace
 * wrongly handed it.
 */
const KEPT_AREA_SHARE = 0.6;

/**
 * A room the camera publishes with its own outline takes its traced region only when the convex
 * hulls of the two overlap at least this much (intersection over union). Comparing hulls lets a
 * coarse published outline (Valetudo's camera publishes each room's convex hull, which fills in an
 * L-shaped room's notch with its neighbour's floor) be replaced by the room's real shape, while a
 * trace that found only part of the room, or ran on into an open-plan neighbour, leaves the
 * published outline in place.
 */
const OUTLINE_AGREEMENT = 0.75;

/** Smallest patch that can be a room's floor rather than noise from an anti-aliased edge. */
const MIN_PATCH = 8;

/** A pixel of a contested colour that no floor patch has claimed yet. */
const UNLABELLED = -2;

/** Border colours within this per-channel distance of the dominant border colour are background. */
const BACKGROUND_TOLERANCE = 24;

/** Saturated-colour test shared by the room colour histogram. */
const MIN_SATURATION = 24;
const MIN_BRIGHTNESS = 55;

interface ColorComponent {
    /** Indexes into the room's window. */
    readonly pixels: Int32Array;
    /** Pixels inside the room's camera bounds. */
    readonly inside: number;
    /** The patch reaches the window margin, so it continues outside the room's bounds. */
    readonly clipped: boolean;
    /** The patch holds a solid 5 x 5 block: a fill, not a wall or a path line. */
    readonly solid: boolean;
}

interface RoomArea {
    /** The window the area covers: the room's camera bounds plus the margin. */
    readonly bounds: PixelBounds;
    readonly width: number;
    readonly height: number;
    /** 1 where the pixel belongs to the room's colour after closing. */
    readonly mask: Uint8Array;
    /**
     * What the solidity test reads: the closing as if no colour were a barrier, plus pixels within
     * one quantisation step of the room's colour. Lanes of a candidate path colour and a lossy
     * image's noise across neighbouring colour bins still form a solid fill; a wall stays a line.
     */
    readonly near: Uint8Array;
    /** Distance from the room's own colour, for pixels the closing claimed. */
    readonly distance: Uint8Array;
}

interface RoomOption {
    readonly candidate: RoomCandidate;
    readonly colorKey: number;
    readonly area: RoomArea;
    /** Every patch of the colour in the room's window. */
    readonly components: ColorComponent[];
    readonly component: ColorComponent;
    readonly score: number;
    /** The rooms whose bounds were barriers for this patch's closing, as a sorted id list. */
    readonly barrierIds: string;
}

/** What enclosed-area filling and tap reach may grow into. */
interface GrowLimits {
    /** Each label's room bounds: a room never grows outside them. */
    readonly labelBounds: PixelBounds[];
    /** 1 inside an undetected room's metadata shape. */
    readonly reserved: Uint8Array;
    /** Each label's fill colour key. */
    readonly labelColors: number[];
    /** Every detected room's fill colour: a room never grows over another room's colour. */
    readonly usedKeys: Set<number>;
    readonly imageData: ImageDataLike;
}

interface BoundaryEdge {
    readonly startX: number;
    readonly startY: number;
    readonly endX: number;
    readonly endY: number;
    readonly direction: number;
}

export class RoomColorDetector {
    public static getColorKey(red: number, green: number, blue: number): number {
        return ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
    }

    /** The id of the room drawn at an image pixel, including what is drawn over its fill. */
    public static roomIdAt(detection: RoomColorDetection, x: number, y: number): string | undefined {
        const { width, height } = detection.imageData;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
        x = Math.floor(x);
        y = Math.floor(y);
        if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
        const label = detection.labels[y * width + x];
        return label >= 0 ? detection.labelRoomIds[label] : undefined;
    }

    /**
     * The inputs a detection depends on besides the pixels: image size, calibration and each room's
     * metadata shape. Two snapshots with the same key show the same rooms in the same places.
     */
    public static geometryKey(
        width: number,
        height: number,
        rooms: Record<string, MapExtractorRoom> | undefined,
        converter: CoordinatesConverter,
    ): string {
        const shapes = readCameraRooms(rooms)
            .map(room => [room.id, room.outline] as const)
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
        const origin = converter.vacuumToMap(0, 0);
        const unitX = converter.vacuumToMap(1000, 0);
        const unitY = converter.vacuumToMap(0, 1000);
        return JSON.stringify([width, height, origin, unitX, unitY, shapes]);
    }

    public static detect(
        image: HTMLImageElement | HTMLCanvasElement,
        rooms: Record<string, MapExtractorRoom>,
        converter: CoordinatesConverter,
    ): RoomColorDetection | undefined {
        const isCanvas = image instanceof HTMLCanvasElement;
        const imageWidth = isCanvas ? image.width : image.naturalWidth;
        const imageHeight = isCanvas ? image.height : image.naturalHeight;
        if ((!isCanvas && !image.complete) || !imageWidth || !imageHeight || !converter.calibrated) {
            return undefined;
        }

        const canvas = isCanvas ? image : document.createElement("canvas");
        if (!isCanvas) {
            canvas.width = imageWidth;
            canvas.height = imageHeight;
        }
        const context = canvas.getContext("2d");
        if (!context) return undefined;

        try {
            if (!isCanvas) context.drawImage(image, 0, 0);
            const imageData = context.getImageData(0, 0, imageWidth, imageHeight);
            return this.detectFromImageData(imageData, rooms, converter);
        } catch {
            // A remote image without canvas access cannot be segmented; callers keep their normal room config.
            return undefined;
        }
    }

    /**
     * Pure room detection over raw RGBA pixels. `detect` is the browser/canvas wrapper; callers
     * that already have pixel data (PNG fixtures in tests, or a future non-canvas source) use
     * this directly. `converter` must be calibrated, which `detect` checks.
     *
     * 1. Each room with camera bounds lists the colours that fill a good share of its bounds.
     * 2. For every room and colour, the colour is closed over small gaps (paths, the robot) and
     *    split into connected patches. A patch scores by how much of it lies inside the bounds and
     *    how much of the bounds it covers; a patch that runs out of the bounds belongs to a larger
     *    neighbour and scores low. Rooms take their best patch, best first, and a patch is taken
     *    once. Colours are not exclusive: map sources reuse them for rooms that do not touch.
     * 3. Room patches are written to a per-pixel label map; an area enclosed by rooms goes to the
     *    nearest one. Outlines and label points come from that map.
     * 4. Taps reach a room across what is drawn at its edge (the robot, the charger, walls), up to
     *    `TAP_REACH` pixels, never across the image background.
     *
     * When two rooms of one colour have interlocking camera bounds, both floors lie inside the other
     * room's bounding box, and step 2's per-room trace bridges the wall between them: one room's
     * region takes the other's arm. The colour's connected patches are then attributed to the rooms
     * and the plain trace's labels are corrected, but only when the correction provably does not
     * lose a room or a floor the plain trace found (`_attributeSharedFloor`). With attribution off
     * (`options.roomColorAttribution`), the method returns exactly the plain trace.
     */
    public static detectFromImageData(
        imageData: ImageDataLike,
        rooms: Record<string, MapExtractorRoom>,
        converter: CoordinatesConverter,
        options: RoomDetectionOptions = {},
    ): RoomColorDetection | undefined {
        const cameraRooms = readCameraRooms(rooms);
        const ownOutlines = cameraRooms.filter(room => !room.fromBounds).map(room => room.id);
        if (options.outlineTracing === false || ownOutlines.length === 0) {
            return this._detectWith(imageData, rooms, cameraRooms, converter, options, new Set(ownOutlines))?.detection;
        }
        // Rooms with their own outline are traced like rooms with bounds. A room whose trace does
        // not agree with its outline is left to the outline and the rooms are traced again, so its
        // floor is reserved for it as before; each pass keeps at least one more outline, so this
        // ends, and with every outline kept it is exactly the earlier detection.
        const kept = new Set<string>();
        for (;;) {
            const result = this._detectWith(imageData, rooms, cameraRooms, converter, options, kept);
            if (result === undefined) {
                if (kept.size === ownOutlines.length) return undefined;
                ownOutlines.forEach(id => kept.add(id));
                continue;
            }
            const rejected = result.regions.filter(region => {
                const shape = result.ownShapes.get(region.id);
                if (shape === undefined) return false;
                return result.runsOn.has(region.id) || this._hullAgreement(region.outline, shape) < OUTLINE_AGREEMENT;
            });
            if (rejected.length === 0) return result.detection;
            rejected.forEach(region => kept.add(region.id));
        }
    }

    /**
     * One detection pass. `keptOutlines` names the rooms with their own outline that are not traced
     * this time but keep that outline.
     */
    private static _detectWith(
        imageData: ImageDataLike,
        rooms: Record<string, MapExtractorRoom>,
        cameraRooms: CameraRoom[],
        converter: CoordinatesConverter,
        options: RoomDetectionOptions,
        keptOutlines: ReadonlySet<string>,
    ):
        | {
              detection: RoomColorDetection;
              regions: DetectedRoomColor[];
              /** The published outline of each traced room that has one. */
              ownShapes: Map<string, PointType[]>;
              /**
               * Traced rooms with their own outline whose colour patch runs on past the trace window
               * (an open-plan neighbour in the same fill): the trace is cut off there, not by a wall.
               */
              runsOn: Set<string>;
          }
        | undefined {
        const entries = cameraRooms
            .map(room => this._getEntry(room, imageData, converter, keptOutlines))
            .filter((entry): entry is RoomEntry => entry !== undefined);
        const candidates: RoomCandidate[] = entries
            .filter(entry => entry.detectable && entry.colorKeys.length > 0)
            .map(entry => ({
                id: entry.id,
                bounds: entry.bounds,
                colorKeys: entry.colorKeys,
                others: entries.filter(other => other !== entry),
            }));
        const allKeys = new Set(candidates.flatMap(candidate => candidate.colorKeys));

        const imageWidth = imageData.width;
        const claimed = new Uint8Array(imageWidth * imageData.height);
        const chosen: RoomOption[] = [];
        const assignedRooms = new Set<string>();
        /** Takes the best options first; a patch mostly claimed by an earlier room is skipped. */
        const assign = (options: RoomOption[]): void => {
            options.sort((left, right) => right.score - left.score);
            options.forEach(option => {
                if (assignedRooms.has(option.candidate.id)) return;
                const { area, component } = option;
                let overlap = 0;
                component.pixels.forEach(index => {
                    if (claimed[this._toImageIndex(area, index, imageWidth)]) overlap++;
                });
                if (overlap * 2 > component.pixels.length) return;
                component.pixels.forEach(index => (claimed[this._toImageIndex(area, index, imageWidth)] = 1));
                assignedRooms.add(option.candidate.id);
                chosen.push(option);
            });
        };
        const optionsFor = (candidate: RoomCandidate, colorKey: number): RoomOption[] => {
            const foreign = new Set(allKeys);
            foreign.delete(colorKey);
            // While scoring, any room that could have this colour is a barrier: a same-coloured
            // neighbour behind a thin wall must not merge into the patch.
            const barriers = candidate.others.filter(other => other.colorKeys.includes(colorKey));
            const area = this._closeRoomArea(
                colorKey,
                foreign,
                candidate.bounds,
                barriers.map(other => other.bounds),
                imageData,
            );
            const components = this._components(area, candidate.bounds);
            const barrierIds = barriers
                .map(other => other.id)
                .sort()
                .join("\n");
            return components
                .map(component => ({
                    candidate,
                    colorKey,
                    area,
                    components,
                    component,
                    score: this._score(component, candidate.bounds),
                    barrierIds,
                }))
                .filter(option => option.score > 0);
        };

        // First round: each room's colours in order of frequency, stopping at a good fit.
        const firstRound: RoomOption[] = [];
        const nextKey = new Map<string, number>();
        candidates.forEach(candidate => {
            let index = 0;
            while (index < candidate.colorKeys.length) {
                const options = optionsFor(candidate, candidate.colorKeys[index++]);
                firstRound.push(...options);
                if (options.some(option => option.score >= GOOD_FIT)) break;
            }
            nextKey.set(candidate.id, index);
        });
        assign(firstRound);
        // Second round: rooms left without a patch score the colours the first round skipped.
        const secondRound: RoomOption[] = [];
        candidates.forEach(candidate => {
            if (assignedRooms.has(candidate.id)) return;
            candidate.colorKeys
                .slice(nextKey.get(candidate.id))
                .forEach(colorKey => secondRound.push(...optionsFor(candidate, colorKey)));
        });
        if (secondRound.length > 0) assign(secondRound);
        if (chosen.length === 0) return undefined;

        // Label with the colours rooms actually use, so the closing may claim anything else that is
        // drawn over a room (a translucent no-go zone, an icon), and never another room's fill.
        const usedKeys = new Set(chosen.map(option => option.colorKey));
        const labels = new Int16Array(imageWidth * imageData.height).fill(-1);
        const priority = new Uint8Array(labels.length).fill(255);
        const labelRoomIds: string[] = [];
        const labelBounds: PixelBounds[] = [];
        const finalAreas: RoomArea[] = [];
        const finalComponents: ColorComponent[][] = [];
        // The final area of each room is closed against the colours rooms actually use, and only the
        // rooms that really share its colour are barriers: those assigned the same colour, and rooms
        // left undetected that contain it. A differently coloured neighbour whose bounding box
        // overlaps this room (interlocking L-shaped rooms) is no barrier; its colour already is.
        // When nothing differs from scoring (the usual case) the scored area is reused.
        const chosenColor = new Map(chosen.map(option => [option.candidate.id, option.colorKey]));
        const sameColors = [...allKeys].every(key => usedKeys.has(key));
        chosen.forEach(option => {
            const foreign = new Set(usedKeys);
            foreign.delete(option.colorKey);
            const barriers = option.candidate.others.filter(other =>
                chosenColor.has(other.id)
                    ? chosenColor.get(other.id) === option.colorKey
                    : other.colorKeys.includes(option.colorKey),
            );
            const reuse =
                sameColors &&
                barriers
                    .map(other => other.id)
                    .sort()
                    .join("\n") === option.barrierIds;
            const area = reuse
                ? option.area
                : this._closeRoomArea(
                      option.colorKey,
                      foreign,
                      option.candidate.bounds,
                      barriers.map(other => other.bounds),
                      imageData,
                  );
            const components = reuse ? option.components : this._components(area, option.candidate.bounds);
            const label = labelRoomIds.push(option.candidate.id) - 1;
            labelBounds.push(option.candidate.bounds);
            finalAreas.push(area);
            finalComponents.push(components);
            this._labelChosen(area, components, option, label, labels, priority, imageWidth);
        });

        // Rooms the colours did not reveal keep their own metadata shape: nothing below may give
        // their floor to a detected neighbour.
        const detectedIds = new Set(labelRoomIds);
        const reserved = this._reserve(
            entries.filter(entry => !detectedIds.has(entry.id)),
            imageData.width,
            imageData.height,
        );
        chosen.forEach((option, label) =>
            this._labelSecondary(
                finalAreas[label],
                finalComponents[label],
                option,
                label,
                labels,
                reserved,
                imageWidth,
            ),
        );

        // Two same-coloured rooms whose camera bounds overlap without one containing the other: the
        // plain trace bridges the wall between their floors and gives one room the other's arm. The
        // colour's patches are attributed to the rooms here, before the last passes, and only when
        // the result cannot be worse than the plain trace (`_attributeSharedFloor`).
        if (options.roomColorAttribution !== false) {
            this._attributeSharedFloor(chosen, labels, reserved, imageData);
        }

        const grow: GrowLimits = {
            labelBounds,
            reserved,
            labelColors: chosen.map(option => option.colorKey),
            usedKeys,
            imageData,
        };
        this._fillEnclosedAreas(labels, imageData.width, imageData.height, grow);
        const outlineLabels = labels.slice();
        this._extendTapReach(labels, imageData, grow);

        const regions: DetectedRoomColor[] = [];
        const roomIdByColor = new Map<number, string>();
        chosen.forEach((option, label) => {
            const region = this._extractRegion(
                option.candidate.id,
                option.colorKey,
                label,
                finalAreas[label],
                outlineLabels,
                imageWidth,
            );
            if (!region) return;
            regions.push(region);
            if (!roomIdByColor.has(option.colorKey)) roomIdByColor.set(option.colorKey, option.candidate.id);
        });

        if (regions.length === 0) return undefined;
        const detectable = entries.filter(entry => entry.detectable).length;
        const ownShapes = new Map(
            entries.filter(entry => entry.detectable && entry.ownOutline).map(entry => [entry.id, entry.polygon]),
        );
        const runsOn = new Set(
            chosen
                .filter(option => ownShapes.has(option.candidate.id) && option.component.clipped)
                .map(option => option.candidate.id),
        );
        return {
            regions,
            ownShapes,
            runsOn,
            detection: {
                imageData,
                regions,
                roomIdByColor,
                labels,
                labelRoomIds,
                geometryKey: this.geometryKey(imageData.width, imageData.height, rooms, converter),
                complete: regions.length === detectable,
            },
        };
    }

    /**
     * How well two outlines in image pixels agree, ignoring concavities: the intersection over
     * union of their convex hulls, counted at pixel centres.
     */
    private static _hullAgreement(first: PointType[], second: PointType[]): number {
        const hulls = [this._convexHull(first), this._convexHull(second)];
        if (hulls.some(hull => hull.length < 3)) return 0;
        const all = [...hulls[0], ...hulls[1]];
        const left = Math.floor(Math.min(...all.map(point => point[0])));
        const right = Math.ceil(Math.max(...all.map(point => point[0])));
        const top = Math.floor(Math.min(...all.map(point => point[1])));
        const bottom = Math.ceil(Math.max(...all.map(point => point[1])));
        let intersection = 0;
        let union = 0;
        for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
                const inFirst = this._contains(hulls[0], x + 0.5, y + 0.5);
                const inSecond = this._contains(hulls[1], x + 0.5, y + 0.5);
                if (inFirst || inSecond) union++;
                if (inFirst && inSecond) intersection++;
            }
        }
        return union === 0 ? 0 : intersection / union;
    }

    /** The convex hull of a polygon's points (monotone chain). */
    private static _convexHull(points: PointType[]): PointType[] {
        const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (o: PointType, a: PointType, b: PointType): number =>
            (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const half = (list: PointType[]): PointType[] => {
            const chain: PointType[] = [];
            for (const point of list) {
                while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
                    chain.pop();
                }
                chain.push(point);
            }
            chain.pop();
            return chain;
        };
        return [...half(sorted), ...half([...sorted].reverse())];
    }

    private static _toImageIndex(area: RoomArea, index: number, imageWidth: number): number {
        const x = index % area.width;
        const y = (index - x) / area.width;
        return (area.bounds.top + y) * imageWidth + area.bounds.left + x;
    }

    private static _getEntry(
        room: CameraRoom,
        imageData: ImageDataLike,
        converter: CoordinatesConverter,
        keptOutlines: ReadonlySet<string>,
    ): RoomEntry | undefined {
        const polygon = room.outline.map(point => converter.vacuumToMap(point[0], point[1]));
        if (polygon.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return undefined;
        const bounds = this._getBounds(polygon, imageData.width, imageData.height);
        if (!bounds) return undefined;
        return {
            id: room.id,
            bounds,
            polygon,
            detectable: room.fromBounds || !keptOutlines.has(room.id),
            ownOutline: !room.fromBounds,
            colorKeys: this._colorKeysIn(bounds, imageData),
        };
    }

    /** The colours that cover at least 8% of a room's bounds, most frequent first. */
    private static _colorKeysIn(bounds: PixelBounds, imageData: ImageDataLike): number[] {
        const counts = new Uint32Array(32768);
        const seen: number[] = [];
        let coloredPixels = 0;
        for (let y = bounds.top; y <= bounds.bottom; y++) {
            for (let x = bounds.left; x <= bounds.right; x++) {
                const key = this._roomColorKey(imageData, (y * imageData.width + x) * 4);
                if (key === undefined) continue;
                if (counts[key]++ === 0) seen.push(key);
                coloredPixels++;
            }
        }

        if (coloredPixels < 8) return [];
        return seen
            .filter(key => counts[key] >= 8 && counts[key] >= coloredPixels * 0.08)
            .sort((left, right) => counts[right] - counts[left]);
    }

    /** The colour key of a pixel that can be a room fill: opaque, saturated and not too dark. */
    private static _roomColorKey(imageData: ImageDataLike, offset: number): number | undefined {
        if (imageData.data[offset + 3] < 128) return undefined;
        const red = imageData.data[offset];
        const green = imageData.data[offset + 1];
        const blue = imageData.data[offset + 2];
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        if (maximum - minimum < MIN_SATURATION || maximum < MIN_BRIGHTNESS) return undefined;
        return this.getColorKey(red, green, blue);
    }

    private static _getBounds(points: PointType[], imageWidth: number, imageHeight: number): PixelBounds | undefined {
        const left = Math.max(0, Math.floor(Math.min(...points.map(point => point[0]))));
        const top = Math.max(0, Math.floor(Math.min(...points.map(point => point[1]))));
        const right = Math.min(imageWidth - 1, Math.ceil(Math.max(...points.map(point => point[0]))));
        const bottom = Math.min(imageHeight - 1, Math.ceil(Math.max(...points.map(point => point[1]))));
        if (!(right >= left) || !(bottom >= top)) return undefined;
        return { left, top, right, bottom };
    }

    /**
     * How well a colour patch matches a room's camera bounds: the share of the patch inside the
     * bounds times the share of the bounds it fills. A patch that continues past the margin is a
     * neighbour seen through the room's bounding box.
     */
    private static _score(component: ColorComponent, bounds: PixelBounds): number {
        if (component.inside < 8 || !component.solid) return 0;
        const boundsArea = (bounds.right - bounds.left + 1) * (bounds.bottom - bounds.top + 1);
        const precision = component.inside / component.pixels.length;
        const coverage = Math.min(1, component.inside / boundsArea);
        // A room's fill covers a fair share of its own bounding box; a wall or a path running
        // through the bounds of a room drawn without colour does not.
        if (precision < 0.5 || coverage < MIN_COVERAGE) return 0;
        return precision * coverage * (component.clipped ? 0.25 : 1);
    }

    /**
     * The room's pixels after closing small gaps: its own colour, plus pixels of anything drawn over
     * it (a path, the robot) in gaps up to 2 * GAP_CLOSING_RADIUS wide. This is a morphological
     * closing with a square element: grow the colour mask by the radius, then shrink it back, so the
     * outer border does not grow. A foreign room colour is never claimed. `distance` is how far a
     * claimed pixel is from the room's own colour (0 for its own pixels).
     */
    private static _closeRoomArea(
        colorKey: number,
        foreignColors: Set<number>,
        roomBounds: PixelBounds,
        barriers: PixelBounds[],
        imageData: ImageDataLike,
    ): RoomArea {
        const radius = GAP_CLOSING_RADIUS;
        const bounds: PixelBounds = {
            left: Math.max(0, roomBounds.left - BOUNDS_MARGIN),
            top: Math.max(0, roomBounds.top - BOUNDS_MARGIN),
            right: Math.min(imageData.width - 1, roomBounds.right + BOUNDS_MARGIN),
            bottom: Math.min(imageData.height - 1, roomBounds.bottom + BOUNDS_MARGIN),
        };
        const width = bounds.right - bounds.left + 1;
        const height = bounds.bottom - bounds.top + 1;
        // The bounds of a room that may share this colour, outside this room's own (or inside it, for
        // a smaller room): map sources reuse a colour for rooms that do not touch, often only a thin
        // wall apart. The closing would bridge that wall and run into the same-coloured neighbour,
        // so the neighbour's area is a barrier, never own colour.
        const otherOwned = new Uint8Array(width * height);
        const area = (box: PixelBounds): number => (box.right - box.left + 1) * (box.bottom - box.top + 1);
        barriers.forEach(other => {
            // Where the bounds overlap, the smaller room owns the overlap: a closet inside a room's
            // bounding box is the closet's, even when it has the room's colour.
            const ownsOverlap = area(other) < area(roomBounds);
            const left = Math.max(other.left, bounds.left);
            const right = Math.min(other.right, bounds.right);
            const top = Math.max(other.top, bounds.top);
            const bottom = Math.min(other.bottom, bounds.bottom);
            for (let y = top; y <= bottom; y++) {
                for (let x = left; x <= right; x++) {
                    const inOwn =
                        x >= roomBounds.left && x <= roomBounds.right && y >= roomBounds.top && y <= roomBounds.bottom;
                    if (!inOwn || ownsOverlap) otherOwned[(y - bounds.top) * width + x - bounds.left] = 1;
                }
            }
        });
        const own = new Uint8Array(width * height);
        const near = new Uint8Array(width * height);
        const foreignRoom = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                if (otherOwned[index]) {
                    foreignRoom[index] = 1;
                    continue;
                }
                const imageOffset = ((bounds.top + y) * imageData.width + bounds.left + x) * 4;
                if (imageData.data[imageOffset + 3] < 128) continue;
                const key = this.getColorKey(
                    imageData.data[imageOffset],
                    imageData.data[imageOffset + 1],
                    imageData.data[imageOffset + 2],
                );
                if (key === colorKey) own[index] = 1;
                else if (foreignColors.has(key)) foreignRoom[index] = 1;
                if (this._nearKey(key, colorKey)) near[index] = 1;
            }
        }

        // Grow: Chebyshev distance to the room's own colour, up to the radius.
        const distance = this._chebyshevDistance(own, width, height, radius + 1);
        const grown = new Uint8Array(width * height);
        for (let index = 0; index < grown.length; index++) grown[index] = distance[index] <= radius ? 1 : 0;

        // Shrink back: keep a grown pixel only when no pixel outside the grown area (or outside the
        // window) is within the radius.
        const outside = new Uint8Array(width * height);
        for (let index = 0; index < outside.length; index++) outside[index] = grown[index] ? 0 : 1;
        const toOutside = this._chebyshevDistance(outside, width, height, radius + 1);
        const mask = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                if (own[index]) {
                    mask[index] = 1;
                    continue;
                }
                if (!grown[index]) continue;
                const toEdge = Math.min(x + 1, y + 1, width - x, height - y);
                if (Math.min(toOutside[index], toEdge) <= radius) continue;
                // Solidity ignores colour barriers: lanes of a path colour that is a candidate
                // colour still close into a solid fill there.
                near[index] = 1;
                if (!foreignRoom[index]) mask[index] = 1;
            }
        }
        for (let index = 0; index < near.length; index++) if (mask[index]) near[index] = 1;
        return { bounds, width, height, mask, near, distance };
    }

    /** 8-connected patches of an area's mask, with how much of each lies inside `roomBounds`. */
    private static _components(area: RoomArea, roomBounds: PixelBounds): ColorComponent[] {
        const { width, height, mask, bounds } = area;
        const visited = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        const solidAt = this._solidBlocks(area.near, width, height);
        const components: ColorComponent[] = [];
        // A window side that is not the image's own edge: a patch touching it runs past the margin.
        const clipLeft = bounds.left < roomBounds.left - (BOUNDS_MARGIN - 1);
        const clipTop = bounds.top < roomBounds.top - (BOUNDS_MARGIN - 1);
        const clipRight = bounds.right > roomBounds.right + (BOUNDS_MARGIN - 1);
        const clipBottom = bounds.bottom > roomBounds.bottom + (BOUNDS_MARGIN - 1);
        for (let start = 0; start < mask.length; start++) {
            if (!mask[start] || visited[start]) continue;
            const tail = this._floodFill8(mask, visited, width, height, start, queue);
            let inside = 0;
            let clipped = false;
            let solid = false;
            for (let position = 0; position < tail; position++) {
                const index = queue[position];
                const x = index % width;
                const y = (index - x) / width;
                const imageX = bounds.left + x;
                const imageY = bounds.top + y;
                if (
                    imageX >= roomBounds.left &&
                    imageX <= roomBounds.right &&
                    imageY >= roomBounds.top &&
                    imageY <= roomBounds.bottom
                ) {
                    inside++;
                }
                if (solidAt[index]) solid = true;
                if (
                    (clipLeft && x === 0) ||
                    (clipTop && y === 0) ||
                    (clipRight && x === width - 1) ||
                    (clipBottom && y === height - 1)
                ) {
                    clipped = true;
                }
            }
            components.push({ pixels: queue.slice(0, tail), inside, clipped, solid });
        }
        return components;
    }

    /** Colour keys at most one quantisation step apart on every channel. */
    private static _nearKey(key: number, other: number): boolean {
        return (
            Math.abs((key >> 10) - (other >> 10)) <= 1 &&
            Math.abs(((key >> 5) & 31) - ((other >> 5) & 31)) <= 1 &&
            Math.abs((key & 31) - (other & 31)) <= 1
        );
    }

    /** 1 at the centre of every 5 x 5 block that lies wholly in the mask. */
    private static _solidBlocks(mask: Uint8Array, width: number, height: number): Uint8Array {
        const horizontal = new Uint8Array(mask.length);
        for (let y = 0; y < height; y++) {
            let run = 0;
            for (let x = 0; x < width; x++) {
                run = mask[y * width + x] ? run + 1 : 0;
                if (run >= 5) horizontal[y * width + x - 2] = 1;
            }
        }
        const solid = new Uint8Array(mask.length);
        for (let x = 0; x < width; x++) {
            let run = 0;
            for (let y = 0; y < height; y++) {
                run = horizontal[y * width + x] ? run + 1 : 0;
                if (run >= 5) solid[(y - 2) * width + x] = 1;
            }
        }
        return solid;
    }

    /**
     * Writes a room's chosen patch into the image-wide label map. A pixel two rooms claim goes to the
     * one whose own colour is nearer, then to the one whose bounds contain it.
     */
    private static _labelChosen(
        area: RoomArea,
        components: ColorComponent[],
        option: RoomOption,
        label: number,
        labels: Int16Array,
        priority: Uint8Array,
        imageWidth: number,
    ): void {
        const roomBounds = option.candidate.bounds;
        const chosen = this._findChosen(components, option);
        if (!chosen) return;
        chosen.pixels.forEach(index => {
            const x = index % area.width;
            const y = (index - x) / area.width;
            const imageX = area.bounds.left + x;
            const imageY = area.bounds.top + y;
            const imageIndex = imageY * imageWidth + imageX;
            const inside =
                imageX >= roomBounds.left &&
                imageX <= roomBounds.right &&
                imageY >= roomBounds.top &&
                imageY <= roomBounds.bottom;
            const rank = area.distance[index] * 2 + (inside ? 0 : 1);
            if (rank < priority[imageIndex]) {
                labels[imageIndex] = label;
                priority[imageIndex] = rank;
            }
        });
    }

    /**
     * Adds the other patches of a room's colour that lie almost wholly inside its bounds (a room split
     * by a wide obstacle). Written after every room's chosen patch, and only where nothing is
     * labelled: a patch that touches another room's pixels or an undetected room's shape is that
     * room's, not this one's (a same-coloured closet inside the room's bounding box).
     */
    private static _labelSecondary(
        area: RoomArea,
        components: ColorComponent[],
        option: RoomOption,
        label: number,
        labels: Int16Array,
        reserved: Uint8Array,
        imageWidth: number,
    ): void {
        const chosen = this._findChosen(components, option);
        components.forEach(component => {
            if (component === chosen || component.clipped || component.inside * 10 < component.pixels.length * 9)
                return;
            const imageIndexes = component.pixels.map(index => this._toImageIndex(area, index, imageWidth));
            if (imageIndexes.some(index => reserved[index] || (labels[index] >= 0 && labels[index] !== label))) return;
            imageIndexes.forEach(index => {
                if (labels[index] < 0) labels[index] = label;
            });
        });
    }

    /**
     * The chosen patch in an area's components. The final area can differ from the one the patch was
     * scored in (fewer colours are barriers once rooms are assigned); there it is the patch that
     * contains the same seed pixel.
     */
    private static _findChosen(components: ColorComponent[], option: RoomOption): ColorComponent | undefined {
        if (components.includes(option.component)) return option.component;
        const seed = option.component.pixels[0];
        return components.find(component => component.pixels.includes(seed));
    }

    /**
     * Gives each of two same-coloured rooms with interlocking camera bounds its own floor.
     *
     * The plain trace above closes each room's colour over small gaps while the *other* room's
     * bounding box is a barrier only where one box contains the other. Two interlocking L-shaped
     * rooms around a hallway contain neither, so nothing stops the closing bridging the wall between
     * them: the room that wins the assignment takes its neighbour's arm as well, and a tap on that
     * arm cleans the wrong room. Here the colour's connected patches are attributed to the rooms and
     * the plain trace's labels are corrected.
     *
     * The attribution is accepted for a colour only when it provably loses nothing the plain trace
     * found - this is the guard that keeps a shared-colour map never worse than before:
     *
     * 1. Every room of the colour carries a floor patch of its own: a patch at least
     *    `PATCH_CONTAINMENT` inside the room's metadata shape (its own outline, or its bounds) that
     *    fits that shape best (`FLOOR_FIT`), and no two rooms claim the same patch. If a room has no
     *    such patch - a nested closet whose fill touches the room around it, an open-plan pair with
     *    no drawn boundary - the pixels cannot tell the rooms apart and the plain trace is kept.
     * 2. A room's detected area stays above `KEPT_AREA_SHARE` of what the plain trace gave it,
     *    unless every pixel it loses went to a room whose metadata bounds contain it. Two
     *    interlocking L rooms can share most of their bounding boxes, so handing a neighbour its arm
     *    back may cost a room most of what the plain trace wrongly gave it; a pixel lost to a room
     *    whose bounds do not contain it is never accepted.
     * 3. A pixel only ever changes to a room whose bounds contain it, and never to a room of another
     *    colour, or into an undetected room's reserved shape (a patch half inside one is left alone).
     *
     * Anything else falls back to the plain trace's labels for the whole colour: the attribution can
     * only change a result the plain trace got wrong, never a room or a floor it found.
     *
     * A patch no single shape contains (a piece a cleaning path or furniture cuts off a floor) is
     * settled by one local rule: it goes to the room whose already-attributed floor it reaches
     * through what the map draws over a floor, and only when exactly one room is reachable. A
     * crossed colour that itself joins two rooms' floors is a wall and is never crossed, so a
     * same-coloured neighbour is not bridged; a path, the robot or furniture is. When the pixels
     * cannot settle it, the plain trace keeps the piece.
     */
    private static _attributeSharedFloor(
        chosen: RoomOption[],
        labels: Int16Array,
        reserved: Uint8Array,
        imageData: ImageDataLike,
    ): void {
        const groups = this._contestedGroups(chosen);
        if (groups.size === 0) return;
        groups.forEach((labelIndexes, colorKey) => {
            const rooms: FloorRoom[] = labelIndexes.map(label => {
                const option = chosen[label];
                return {
                    label,
                    id: option.candidate.id,
                    bounds: option.candidate.bounds,
                    colorKey: option.colorKey,
                };
            });
            const floors = this._colourFloors(colorKey, rooms, reserved, imageData);
            if (!floors) return;
            const snapshot = labels.slice();
            if (!this._applyFloorOwnership(floors, rooms, labels, imageData)) labels.set(snapshot);
        });
    }

    /**
     * The colours that more than one chosen room uses while their camera bounds overlap without one
     * containing the other. Those are the only colours where the plain trace can hand one room's
     * floor to another; a colour repeated on rooms with disjoint or nested bounds is left alone.
     */
    private static _contestedGroups(chosen: RoomOption[]): Map<number, number[]> {
        const byColor = new Map<number, number[]>();
        chosen.forEach((option, label) => {
            const group = byColor.get(option.colorKey);
            if (group) group.push(label);
            else byColor.set(option.colorKey, [label]);
        });
        const contested = new Map<number, number[]>();
        byColor.forEach((labels, colorKey) => {
            const overlaps = labels.some((left, index) =>
                labels.slice(index + 1).some(right => {
                    const first = chosen[left].candidate.bounds;
                    const second = chosen[right].candidate.bounds;
                    const intersects =
                        first.left <= second.right &&
                        second.left <= first.right &&
                        first.top <= second.bottom &&
                        second.top <= first.bottom;
                    if (!intersects) return false;
                    const contains = (outer: PixelBounds, inner: PixelBounds): boolean =>
                        outer.left <= inner.left &&
                        outer.top <= inner.top &&
                        outer.right >= inner.right &&
                        outer.bottom >= inner.bottom;
                    // Nesting is the plain trace's own case (a closet inside a room's bounds).
                    return !contains(first, second) && !contains(second, first);
                }),
            );
            if (overlaps) contested.set(colorKey, labels);
        });
        return contested;
    }

    /**
     * Labels every connected patch of one fill colour and measures how much of it each room's
     * metadata shape contains. Returns undefined when the metadata cannot attribute the colour: a
     * patch too small to be a floor, a shared anchor, or no patch filling a room's shape.
     */
    private static _colourFloors(
        colorKey: number,
        rooms: FloorRoom[],
        reserved: Uint8Array,
        imageData: ImageDataLike,
    ): ColourFloors | undefined {
        const { width, height, data } = imageData;
        const patch = new Int32Array(width * height).fill(-1);
        const reservedCounts: number[] = [];
        for (let index = 0; index < patch.length; index++) {
            const offset = index * 4;
            if (data[offset + 3] < 128) continue;
            if (this.getColorKey(data[offset], data[offset + 1], data[offset + 2]) !== colorKey) continue;
            patch[index] = UNLABELLED;
        }
        const sizes: number[] = [];
        const boxes: PixelBounds[] = [];
        const stack: number[] = [];
        // A scanline flood fill: fills are wide flat runs, and filling a run at a time is several
        // times faster than stepping a queue pixel by pixel. 8-connected, like `_components`.
        for (let origin = 0; origin < patch.length; origin++) {
            if (patch[origin] !== UNLABELLED) continue;
            const label = sizes.length;
            let size = 0;
            let reservedPixels = 0;
            let leftmost = width;
            let rightmost = 0;
            let topmost = height;
            let bottommost = 0;
            stack.push(origin);
            while (stack.length > 0) {
                const seed = stack.pop() as number;
                if (patch[seed] !== UNLABELLED) continue;
                const rowStart = seed - (seed % width);
                const y = rowStart / width;
                const rowEnd = rowStart + width - 1;
                let left = seed;
                while (left > rowStart && patch[left - 1] === UNLABELLED) left--;
                let right = seed;
                while (right < rowEnd && patch[right + 1] === UNLABELLED) right++;
                for (let index = left; index <= right; index++) {
                    patch[index] = label;
                    size++;
                    if (reserved[index]) reservedPixels++;
                }
                leftmost = Math.min(leftmost, left - rowStart);
                rightmost = Math.max(rightmost, right - rowStart);
                topmost = Math.min(topmost, y);
                bottommost = Math.max(bottommost, y);
                const from = Math.max(rowStart, left - 1);
                const to = Math.min(rowEnd, right + 1);
                if (y > 0) {
                    for (let index = from; index <= to; index++) {
                        if (patch[index - width] === UNLABELLED) stack.push(index - width);
                    }
                }
                if (y < height - 1) {
                    for (let index = from; index <= to; index++) {
                        if (patch[index + width] === UNLABELLED) stack.push(index + width);
                    }
                }
            }
            sizes.push(size);
            reservedCounts.push(reservedPixels);
            boxes.push({ left: leftmost, top: topmost, right: rightmost, bottom: bottommost });
        }
        if (sizes.length === 0) return undefined;

        const counts = rooms.map(() => new Uint32Array(sizes.length));
        const shapeAreas = rooms.map((room, index) => {
            const { bounds } = room;
            let area = 0;
            for (let y = bounds.top; y <= bounds.bottom; y++) {
                for (let x = bounds.left; x <= bounds.right; x++) {
                    area++;
                    const found = patch[y * width + x];
                    if (found >= 0) counts[index][found]++;
                }
            }
            return area;
        });

        const anchors: Array<number | undefined> = rooms.map((_room, index) => {
            let best = -1;
            let bestFit = FLOOR_FIT;
            for (let label = 0; label < sizes.length; label++) {
                if (sizes[label] < MIN_PATCH) continue;
                const containment = counts[index][label] / sizes[label];
                if (containment < PATCH_CONTAINMENT) continue;
                const fit = containment * (counts[index][label] / shapeAreas[index]);
                if (fit > bestFit) {
                    bestFit = fit;
                    best = label;
                }
            }
            return best >= 0 ? best : undefined;
        });
        // A patch two rooms both fit best is a floor the pixels cannot split (a closet whose fill
        // touches the room around it, an open-plan pair): leave this colour to the plain trace.
        const anchorrooms = new Set<number>();
        for (const anchor of anchors) {
            if (anchor === undefined || anchorrooms.has(anchor)) return undefined;
            anchorrooms.add(anchor);
        }
        return { colorKey, patch, sizes, boxes, counts, shapeAreas, anchors, reservedCounts };
    }

    /**
     * The room that owns each patch of the colour, or undefined where the pixels cannot say.
     *
     * A room's own floor patch is its anchor. A patch wholly inside exactly one room's shape belongs
     * to it. A patch several shapes contain equally is a piece cut off a floor: it goes to the one
     * room whose anchor it reaches without crossing a wall, and only when exactly one room is so
     * reachable. A patch no shape contains, or one mostly inside an undetected room's shape, is left
     * as the plain trace had it.
     */
    private static _applyFloorOwnership(
        floors: ColourFloors,
        rooms: FloorRoom[],
        labels: Int16Array,
        imageData: ImageDataLike,
    ): boolean {
        const { width } = imageData;
        const owners: Array<number | undefined> = floors.sizes.map(() => undefined);
        const anchorRoom = new Map<number, number>();
        floors.anchors.forEach((anchor, room) => {
            if (anchor === undefined) return;
            owners[anchor] = room;
            anchorRoom.set(anchor, room);
        });
        // The unique room whose shape contains the patch, when there is one.
        const containing = floors.sizes.map((size, label) => {
            if (size < MIN_PATCH || owners[label] !== undefined) return [];
            if (floors.reservedCounts[label] * 2 > size) return [];
            return rooms
                .map((_room, room) => room)
                .filter(room => floors.counts[room][label] / size >= PATCH_CONTAINMENT);
        });
        const separating = new Map<number, boolean>();
        const window = this._floorsWindow(rooms, imageData);
        const walk = new Int32Array(floors.patch.length);
        const wallWalk = new Int32Array(floors.patch.length);
        const markers = { walk: 0, wall: 0 };
        containing.forEach((found, label) => {
            if (found.length === 1) owners[label] = found[0];
            else if (found.length > 1)
                owners[label] = this._fragmentOwner(
                    label,
                    floors,
                    found,
                    anchorRoom,
                    imageData,
                    window,
                    separating,
                    walk,
                    wallWalk,
                    markers,
                );
        });
        // A pixel only ever changes to a room whose bounds contain it: every owned patch is inside
        // its owner's bounds by construction, so this is a check rather than a filter.

        // Re-label the pixels the plain trace gave another room, and refuse the whole correction
        // when it would lose a room or more than `KEPT_AREA_SHARE` of a floor the trace found.
        const labelRoom = new Map<number, number>();
        rooms.forEach((room, index) => labelRoom.set(room.label, index));
        const before = new Int32Array(rooms.length);
        for (let index = 0; index < labels.length; index++) {
            const room = labelRoom.get(labels[index]);
            if (room !== undefined) before[room]++;
        }
        const after = before.slice();
        const lost = new Int32Array(rooms.length);
        const lostFloor = new Int32Array(rooms.length);
        const lostOutside = new Int32Array(rooms.length);
        owners.forEach((owner, label) => {
            if (owner === undefined) return;
            const box = floors.boxes[label];
            const target = rooms[owner].label;
            for (let y = box.top; y <= box.bottom; y++) {
                for (let x = box.left; x <= box.right; x++) {
                    const index = y * width + x;
                    if (floors.patch[index] !== label) continue;
                    const current = labels[index];
                    if (current === target) continue;
                    const previous = labelRoom.get(current);
                    if (previous !== undefined) {
                        if (rooms[previous].colorKey !== rooms[owner].colorKey) continue;
                        lost[previous]++;
                        after[previous]--;
                        if (floors.anchors[previous] === floors.patch[index]) lostFloor[previous]++;
                        const { bounds } = rooms[owner];
                        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)
                            lostOutside[previous]++;
                    }
                    labels[index] = target;
                    after[owner]++;
                }
            }
        });
        for (let room = 0; room < rooms.length; room++) {
            // A room the plain trace found keeps a patch of its own, and it never loses a pixel of
            // its own floor: that floor is the one piece the metadata shape gives only this room.
            if (before[room] > 0 && after[room] < MIN_PATCH) return false;
            if (lostFloor[room] > 0) return false;
            // Giving a neighbour its arm back can cost most of a bounding box, so the area may fall
            // below `KEPT_AREA_SHARE` only for pixels the gaining room's own bounds contain: those
            // are the pixels the metadata shapes attributed to the other room, not this one's.
            if (
                lost[room] > 0 &&
                after[room] < before[room] * KEPT_AREA_SHARE &&
                (lostFloor[room] > 0 || lostOutside[room] > 0)
            )
                return false;
        }
        return true;
    }

    /** The window the wall test reads: the contested rooms' bounds plus the closing margin. */
    private static _floorsWindow(rooms: FloorRoom[], imageData: ImageDataLike): PixelBounds {
        const margin = BOUNDS_MARGIN + GAP_CLOSING_RADIUS * 2;
        return {
            left: Math.max(0, Math.min(...rooms.map(room => room.bounds.left)) - margin),
            top: Math.max(0, Math.min(...rooms.map(room => room.bounds.top)) - margin),
            right: Math.min(imageData.width - 1, Math.max(...rooms.map(room => room.bounds.right)) + margin),
            bottom: Math.min(imageData.height - 1, Math.max(...rooms.map(room => room.bounds.bottom)) + margin),
        };
    }

    /**
     * The room a piece cut off a floor belongs to: the only one of the candidate rooms whose anchor
     * patch is reachable from the piece across what the map draws over a floor (a path, the robot,
     * an icon, furniture), up to the same gap the closing bridges. A crossed colour that joins two
     * rooms' anchors is a wall and is not crossed. Undefined when no room, or more than one, is
     * reachable: the pixels cannot settle it.
     */
    private static _fragmentOwner(
        label: number,
        floors: ColourFloors,
        candidates: number[],
        anchorRoom: Map<number, number>,
        imageData: ImageDataLike,
        window: PixelBounds,
        separating: Map<number, boolean>,
        walk: Int32Array,
        wallWalk: Int32Array,
        markers: { walk: number; wall: number },
    ): number | undefined {
        const { width, height, data } = imageData;
        const marker = ++markers.walk;
        const reached = new Set<number>();
        const box = floors.boxes[label];
        let frontier: number[] = [];
        for (let y = box.top; y <= box.bottom; y++) {
            for (let x = box.left; x <= box.right; x++) {
                const index = y * width + x;
                if (floors.patch[index] !== label) continue;
                walk[index] = marker;
                frontier.push(index);
            }
        }
        for (let step = 0; step < GAP_CLOSING_RADIUS * 2 && frontier.length > 0; step++) {
            const next: number[] = [];
            for (const index of frontier) {
                const x = index % width;
                const y = (index - x) / width;
                for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                        if (nx < window.left || nx > window.right || ny < window.top || ny > window.bottom) continue;
                        const neighbour = ny * width + nx;
                        if (walk[neighbour] === marker) continue;
                        walk[neighbour] = marker;
                        const offset = neighbour * 4;
                        if (data[offset + 3] < 128) continue;
                        const found = floors.patch[neighbour];
                        if (found >= 0) {
                            const room = anchorRoom.get(found);
                            if (room !== undefined && candidates.includes(room)) reached.add(room);
                            continue;
                        }
                        const key = this.getColorKey(data[offset], data[offset + 1], data[offset + 2]);
                        if (
                            this._separatesFloors(
                                key,
                                neighbour,
                                floors,
                                anchorRoom,
                                imageData,
                                window,
                                separating,
                                wallWalk,
                                markers,
                            )
                        )
                            continue;
                        next.push(neighbour);
                    }
                }
            }
            frontier = next;
        }
        if (reached.size !== 1) return undefined;
        return [...reached][0];
    }

    /**
     * Whether a colour separates two rooms' floors: one of its connected patches touches the anchor
     * patches of two different rooms. That is what a wall, a map background or a solid obstacle
     * between rooms does; a cleaning path, an icon or a piece of furniture drawn on one room touches
     * only that room's floor (or none, outside every room). The answer is computed once per colour
     * inside the contested rooms' window.
     */
    private static _separatesFloors(
        colorKey: number,
        start: number,
        floors: ColourFloors,
        anchorRoom: Map<number, number>,
        imageData: ImageDataLike,
        window: PixelBounds,
        cache: Map<number, boolean>,
        wallWalk: Int32Array,
        markers: { walk: number; wall: number },
    ): boolean {
        const cached = cache.get(colorKey);
        if (cached !== undefined) return cached;
        const { width, data } = imageData;
        const marker = ++markers.wall;
        const stack = [start];
        wallWalk[start] = marker;
        const touched = new Set<number>();
        while (stack.length > 0) {
            const index = stack.pop() as number;
            const x = index % width;
            const y = (index - x) / width;
            for (let ny = Math.max(window.top, y - 1); ny <= Math.min(window.bottom, y + 1); ny++) {
                for (let nx = Math.max(window.left, x - 1); nx <= Math.min(window.right, x + 1); nx++) {
                    const neighbour = ny * width + nx;
                    if (wallWalk[neighbour] === marker) continue;
                    const found = floors.patch[neighbour];
                    if (found >= 0) {
                        const room = anchorRoom.get(found);
                        if (room !== undefined) touched.add(room);
                        continue;
                    }
                    const offset = neighbour * 4;
                    if (data[offset + 3] < 128) continue;
                    if (this.getColorKey(data[offset], data[offset + 1], data[offset + 2]) !== colorKey) continue;
                    wallWalk[neighbour] = marker;
                    stack.push(neighbour);
                }
            }
        }
        const separates = touched.size >= 2;
        cache.set(colorKey, separates);
        return separates;
    }

    /** Marks the metadata shapes of rooms that were not detected. */
    private static _reserve(entries: RoomEntry[], width: number, height: number): Uint8Array {
        const reserved = new Uint8Array(width * height);
        entries.forEach(entry => {
            const { bounds, polygon } = entry;
            for (let y = bounds.top; y <= bounds.bottom; y++) {
                for (let x = bounds.left; x <= bounds.right; x++) {
                    if (this._contains(polygon, x + 0.5, y + 0.5)) reserved[y * width + x] = 1;
                }
            }
        });
        return reserved;
    }

    private static _contains(polygon: PointType[], x: number, y: number): boolean {
        let inside = false;
        for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
            const [xi, yi] = polygon[index];
            const [xj, yj] = polygon[previous];
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    /**
     * Gives an unlabelled area that rooms enclose on every side (it does not reach the image edge)
     * to the nearest enclosing room whose bounds contain it: the robot, a room icon or name,
     * furniture, a no-go zone. Floor outside every room's bounds (an unsegmented hallway) stays
     * unlabelled, and so does an undetected room's shape. The robot on a threshold is split between
     * the two rooms it covers.
     */
    private static _fillEnclosedAreas(labels: Int16Array, width: number, height: number, grow: GrowLimits): void {
        const visited = new Uint8Array(labels.length);
        const queue = new Int32Array(labels.length);
        const limit = Math.max(ENCLOSED_AREA_LIMIT, Math.floor(labels.length * 0.002));
        for (let start = 0; start < labels.length; start++) {
            if (labels[start] >= 0 || visited[start]) continue;
            let head = 0;
            let tail = 0;
            let open = false;
            queue[tail++] = start;
            visited[start] = 1;
            while (head < tail) {
                const index = queue[head++];
                const x = index % width;
                const y = (index - x) / width;
                if (x === 0 || y === 0 || x === width - 1 || y === height - 1) open = true;
                if (x > 0 && !visited[index - 1] && labels[index - 1] < 0) {
                    visited[index - 1] = 1;
                    queue[tail++] = index - 1;
                }
                if (x < width - 1 && !visited[index + 1] && labels[index + 1] < 0) {
                    visited[index + 1] = 1;
                    queue[tail++] = index + 1;
                }
                if (y > 0 && !visited[index - width] && labels[index - width] < 0) {
                    visited[index - width] = 1;
                    queue[tail++] = index - width;
                }
                if (y < height - 1 && !visited[index + width] && labels[index + width] < 0) {
                    visited[index + width] = 1;
                    queue[tail++] = index + width;
                }
            }
            if (open || tail > limit) continue;
            this._growLabels(labels, width, height, queue.subarray(0, tail), Number.MAX_SAFE_INTEGER, grow);
        }
    }

    /**
     * Lets a tap on something drawn at a room's edge reach the room: unlabelled pixels that are not
     * the image background take the nearest room label within `TAP_REACH` pixels, inside that room's
     * bounds. The background is the colour that dominates the image border (or transparency),
     * matched with a tolerance so a lossy image's noise is still background.
     */
    private static _extendTapReach(labels: Int16Array, imageData: ImageDataLike, grow: GrowLimits): void {
        const { width, height } = imageData;
        const isBackground = this._backgroundTest(imageData);
        const targets: number[] = [];
        for (let index = 0; index < labels.length; index++) {
            if (labels[index] < 0 && !isBackground(index * 4)) targets.push(index);
        }
        this._growLabels(labels, width, height, Int32Array.from(targets), TAP_REACH, grow);
    }

    /**
     * Whether a pixel is the image background: transparent, or within `BACKGROUND_TOLERANCE` per
     * channel of a colour that covers at least a tenth of the image border. Border colours are
     * grouped coarsely (16 levels per channel) so noise does not split them below that share.
     */
    private static _backgroundTest(imageData: ImageDataLike): (offset: number) => boolean {
        const { width, height, data } = imageData;
        const groups = new Map<number, { count: number; red: number; green: number; blue: number }>();
        let total = 0;
        const count = (x: number, y: number): void => {
            const offset = (y * width + x) * 4;
            total++;
            if (data[offset + 3] < 128) return;
            const key = ((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4);
            const group = groups.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
            group.count++;
            group.red += data[offset];
            group.green += data[offset + 1];
            group.blue += data[offset + 2];
            groups.set(key, group);
        };
        for (let x = 0; x < width; x++) {
            count(x, 0);
            count(x, height - 1);
        }
        for (let y = 1; y < height - 1; y++) {
            count(0, y);
            count(width - 1, y);
        }
        const colors: Array<[number, number, number]> = [];
        groups.forEach(group => {
            if (group.count * 10 >= total)
                colors.push([group.red / group.count, group.green / group.count, group.blue / group.count]);
        });
        return (offset: number): boolean =>
            data[offset + 3] < 128 ||
            colors.some(
                color =>
                    Math.abs(data[offset] - color[0]) <= BACKGROUND_TOLERANCE &&
                    Math.abs(data[offset + 1] - color[1]) <= BACKGROUND_TOLERANCE &&
                    Math.abs(data[offset + 2] - color[2]) <= BACKGROUND_TOLERANCE,
            );
    }

    /**
     * Multi-source breadth-first growth of room labels into `targets` (unlabelled pixels), up to
     * `reach` steps (8-connected). Each target takes the label of the nearest room whose bounds
     * contain it and whose colour does not clash: pixels of another detected room's fill colour
     * and reserved pixels (an undetected room's shape) are never taken.
     */
    private static _growLabels(
        labels: Int16Array,
        width: number,
        height: number,
        targets: Int32Array,
        reach: number,
        grow: GrowLimits,
    ): void {
        if (targets.length === 0) return;
        const isTarget = new Uint8Array(labels.length);
        targets.forEach(index => {
            if (!grow.reserved[index]) isTarget[index] = 1;
        });
        const data = grow.imageData.data;
        const canTake = (label: number, index: number): boolean => {
            const bounds = grow.labelBounds[label];
            const x = index % width;
            const y = (index - x) / width;
            if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return false;
            // Pixels of another detected room's fill colour are that room's (or an icon in it), never
            // this room's.
            const offset = index * 4;
            if (data[offset + 3] < 128) return true;
            const key = this.getColorKey(data[offset], data[offset + 1], data[offset + 2]);
            return key === grow.labelColors[label] || !grow.usedKeys.has(key);
        };
        let frontier: number[] = [];
        const seen = new Uint8Array(labels.length);
        // Seed with labelled pixels that touch a target.
        targets.forEach(index => {
            if (!isTarget[index]) return;
            const x = index % width;
            const y = (index - x) / width;
            for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                    const neighbor = ny * width + nx;
                    if (labels[neighbor] >= 0 && !isTarget[neighbor] && !seen[neighbor]) {
                        seen[neighbor] = 1;
                        frontier.push(neighbor);
                    }
                }
            }
        });
        for (let step = 0; step < reach && frontier.length > 0; step++) {
            const next: number[] = [];
            frontier.forEach(index => {
                const label = labels[index];
                const x = index % width;
                const y = (index - x) / width;
                for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                        const neighbor = ny * width + nx;
                        if (!isTarget[neighbor] || labels[neighbor] >= 0 || !canTake(label, neighbor)) continue;
                        labels[neighbor] = label;
                        next.push(neighbor);
                    }
                }
            });
            frontier = next;
        }
    }

    /**
     * The room's outline and label point from the label map. The outline is the outer border of the
     * room's largest connected piece. The label point is that piece's centroid when it lies well
     * inside the room; for an L- or U-shaped room, where the centroid falls on a neighbour or
     * outside, it is the point deepest inside the room nearest to the centroid.
     */
    private static _extractRegion(
        id: string,
        colorKey: number,
        label: number,
        area: RoomArea,
        labels: Int16Array,
        imageWidth: number,
    ): DetectedRoomColor | undefined {
        const { bounds, width, height } = area;
        const mask = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (labels[(bounds.top + y) * imageWidth + bounds.left + x] === label) mask[y * width + x] = 1;
            }
        }

        const visited = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        let largestComponent = new Int32Array(0);
        for (let start = 0; start < mask.length; start++) {
            if (!mask[start] || visited[start]) continue;
            const tail = this._floodFill8(mask, visited, width, height, start, queue);
            if (tail > largestComponent.length) largestComponent = queue.slice(0, tail);
        }

        if (largestComponent.length < 8) return undefined;
        const componentMask = new Uint8Array(mask.length);
        largestComponent.forEach(index => (componentMask[index] = 1));
        this._fillHoles(componentMask, width, height);
        const outline = this._getOutline(componentMask, width, height, bounds.left, bounds.top);
        if (outline.length < 3) return undefined;
        const center = this._labelPoint(componentMask, width, height);
        return {
            id,
            colorKey,
            center: [bounds.left + center[0], bounds.top + center[1]],
            outline,
        };
    }

    /**
     * The Chebyshev depth of a pixel inside the mask (0 when it is outside), counted up to `limit`:
     * how many square rings around it lie fully in the mask, plus one.
     */
    private static _squareDepth(
        mask: Uint8Array,
        width: number,
        height: number,
        x: number,
        y: number,
        limit: number,
    ): number {
        if (x < 0 || y < 0 || x >= width || y >= height || !mask[y * width + x]) return 0;
        for (let ring = 1; ring <= limit; ring++) {
            if (x - ring < 0 || y - ring < 0 || x + ring >= width || y + ring >= height) return ring;
            for (let offset = -ring; offset <= ring; offset++) {
                if (
                    !mask[(y - ring) * width + x + offset] ||
                    !mask[(y + ring) * width + x + offset] ||
                    !mask[(y + offset) * width + x - ring] ||
                    !mask[(y + offset) * width + x + ring]
                ) {
                    return ring;
                }
            }
        }
        return limit + 1;
    }

    /** Sets every pixel the mask encloses (4-connected background not reaching the window edge). */
    private static _fillHoles(mask: Uint8Array, width: number, height: number): void {
        const outside = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        let tail = 0;
        const push = (index: number): void => {
            if (mask[index] || outside[index]) return;
            outside[index] = 1;
            queue[tail++] = index;
        };
        for (let x = 0; x < width; x++) {
            push(x);
            push((height - 1) * width + x);
        }
        for (let y = 0; y < height; y++) {
            push(y * width);
            push(y * width + width - 1);
        }
        for (let head = 0; head < tail; head++) {
            const index = queue[head];
            const x = index % width;
            const y = (index - x) / width;
            if (x > 0) push(index - 1);
            if (x < width - 1) push(index + 1);
            if (y > 0) push(index - width);
            if (y < height - 1) push(index + width);
        }
        for (let index = 0; index < mask.length; index++) if (!outside[index]) mask[index] = 1;
    }

    /** The centroid, or the deepest point nearest to it when the centroid is near an edge. */
    private static _labelPoint(mask: Uint8Array, width: number, height: number): PointType {
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (let index = 0; index < mask.length; index++) {
            if (!mask[index]) continue;
            const x = index % width;
            sumX += x + 0.5;
            sumY += (index - x) / width + 0.5;
            count++;
        }
        const centroid: PointType = [sumX / count, sumY / count];
        const centroidX = Math.floor(centroid[0]);
        const centroidY = Math.floor(centroid[1]);
        // Fast path: the deepest point of any shape is at most half its bounding box's shorter side
        // from the edge, so a centroid at least a quarter of that side deep is deep enough.
        let minX = width;
        let maxX = 0;
        let minY = height;
        let maxY = 0;
        for (let index = 0; index < mask.length; index++) {
            if (!mask[index]) continue;
            const x = index % width;
            const y = (index - x) / width;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
        const shorterSide = Math.min(maxX - minX + 1, maxY - minY + 1);
        if (
            this._squareDepth(mask, width, height, centroidX, centroidY, Math.ceil(shorterSide / 4)) >=
            shorterSide / 4
        ) {
            return centroid;
        }
        const outside = new Uint8Array(mask.length);
        for (let index = 0; index < mask.length; index++) outside[index] = mask[index] ? 0 : 1;
        const depth = this._chebyshevDistance(outside, width, height, 255);
        // The window edge counts as outside too.
        const depthAt = (index: number): number => {
            const x = index % width;
            const y = (index - x) / width;
            return Math.min(depth[index], x + 1, y + 1, width - x, height - y);
        };
        let maximum = 0;
        for (let index = 0; index < mask.length; index++) if (mask[index]) maximum = Math.max(maximum, depthAt(index));
        const centroidIndex = Math.floor(centroid[1]) * width + Math.floor(centroid[0]);
        if (mask[centroidIndex] && depthAt(centroidIndex) * 2 >= maximum) return centroid;

        let best: PointType = centroid;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < mask.length; index++) {
            if (!mask[index] || depthAt(index) * 4 < maximum * 3) continue;
            const x = index % width;
            const y = (index - x) / width;
            const distance = (x + 0.5 - centroid[0]) ** 2 + (y + 0.5 - centroid[1]) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = [x + 0.5, y + 0.5];
            }
        }
        return best;
    }

    /**
     * Chebyshev (8-neighbour) distance to the nearest set pixel, capped at `cap` (at most 255). Two
     * raster passes (a chamfer transform), which is exact for the chessboard metric.
     */
    private static _chebyshevDistance(source: Uint8Array, width: number, height: number, cap: number): Uint8Array {
        const distance = new Uint8Array(source.length);
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const index = row + x;
                if (source[index]) continue;
                let best = cap;
                if (x > 0 && distance[index - 1] + 1 < best) best = distance[index - 1] + 1;
                if (y > 0) {
                    const above = index - width;
                    if (distance[above] + 1 < best) best = distance[above] + 1;
                    if (x > 0 && distance[above - 1] + 1 < best) best = distance[above - 1] + 1;
                    if (x < width - 1 && distance[above + 1] + 1 < best) best = distance[above + 1] + 1;
                }
                distance[index] = best;
            }
        }
        for (let y = height - 1; y >= 0; y--) {
            const row = y * width;
            for (let x = width - 1; x >= 0; x--) {
                const index = row + x;
                let best = distance[index];
                if (best === 0) continue;
                if (x < width - 1 && distance[index + 1] + 1 < best) best = distance[index + 1] + 1;
                if (y < height - 1) {
                    const below = index + width;
                    if (distance[below] + 1 < best) best = distance[below] + 1;
                    if (x > 0 && distance[below - 1] + 1 < best) best = distance[below - 1] + 1;
                    if (x < width - 1 && distance[below + 1] + 1 < best) best = distance[below + 1] + 1;
                }
                distance[index] = best;
            }
        }
        return distance;
    }

    /**
     * Flood-fills the 8-connected patch of `mask` that contains `start` into `queue` and marks it in
     * `visited`. Returns the patch's size; its pixels are `queue[0..size)`.
     */
    private static _floodFill8(
        mask: Uint8Array,
        visited: Uint8Array,
        width: number,
        height: number,
        start: number,
        queue: Int32Array,
    ): number {
        const length = width * height;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        visited[start] = 1;
        while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            const hasLeft = x > 0;
            const hasRight = x < width - 1;
            for (let row = -1; row <= 1; row++) {
                const centre = index + row * width;
                if (centre < 0 || centre >= length) continue;
                if (hasLeft && mask[centre - 1] && !visited[centre - 1]) {
                    visited[centre - 1] = 1;
                    queue[tail++] = centre - 1;
                }
                if (row !== 0 && mask[centre] && !visited[centre]) {
                    visited[centre] = 1;
                    queue[tail++] = centre;
                }
                if (hasRight && mask[centre + 1] && !visited[centre + 1]) {
                    visited[centre + 1] = 1;
                    queue[tail++] = centre + 1;
                }
            }
        }
        return tail;
    }

    private static _getOutline(
        mask: Uint8Array,
        width: number,
        height: number,
        offsetX: number,
        offsetY: number,
    ): PointType[] {
        const edges: BoundaryEdge[] = [];
        const outgoing = new Map<number, number[]>();
        const vertexKey = (x: number, y: number): number => y * (width + 1) + x;
        const addEdge = (startX: number, startY: number, endX: number, endY: number, direction: number): void => {
            const edgeId = edges.length;
            edges.push({ startX, startY, endX, endY, direction });
            const key = vertexKey(startX, startY);
            outgoing.set(key, [...(outgoing.get(key) ?? []), edgeId]);
        };
        const filled = (x: number, y: number): boolean =>
            x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!filled(x, y)) continue;
                if (!filled(x, y - 1)) addEdge(x, y, x + 1, y, 0);
                if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1, 1);
                if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1, 2);
                if (!filled(x - 1, y)) addEdge(x, y + 1, x, y, 3);
            }
        }

        const used = new Uint8Array(edges.length);
        let largestLoop: PointType[] = [];
        let largestArea = 0;
        for (let start = 0; start < edges.length; start++) {
            if (used[start]) continue;
            const first = edges[start];
            const loop: PointType[] = [[first.startX, first.startY]];
            let current = start;
            let closed = false;
            let steps = 0;
            while (!used[current] && steps <= edges.length) {
                steps++;
                used[current] = 1;
                const edge = edges[current];
                loop.push([edge.endX, edge.endY]);
                if (edge.endX === first.startX && edge.endY === first.startY) {
                    closed = true;
                    break;
                }
                const nextEdges = (outgoing.get(vertexKey(edge.endX, edge.endY)) ?? []).filter(edgeId => !used[edgeId]);
                if (nextEdges.length === 0) break;
                nextEdges.sort((left, right) => {
                    const leftTurn = (edges[left].direction - edge.direction + 4) % 4;
                    const rightTurn = (edges[right].direction - edge.direction + 4) % 4;
                    const priority = (turn: number): number => (turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3);
                    return priority(leftTurn) - priority(rightTurn);
                });
                current = nextEdges[0];
            }
            if (!closed || loop.length < 4) continue;
            const area = Math.abs(this._polygonArea(loop));
            if (area > largestArea) {
                largestArea = area;
                largestLoop = loop;
            }
        }

        return this._simplifyClosed(largestLoop, 2.5).map(point => [point[0] + offsetX, point[1] + offsetY]);
    }

    private static _polygonArea(points: PointType[]): number {
        let area = 0;
        points.forEach((point, index) => {
            const next = points[(index + 1) % points.length];
            area += point[0] * next[1] - next[0] * point[1];
        });
        return area / 2;
    }

    private static _simplifyClosed(points: PointType[], tolerance: number): PointType[] {
        if (points.length < 5) return points.slice(0, -1);
        const ring = points.slice(0, -1);
        let split = 1;
        let distance = 0;
        ring.forEach((point, index) => {
            const dx = point[0] - ring[0][0];
            const dy = point[1] - ring[0][1];
            const currentDistance = dx * dx + dy * dy;
            if (currentDistance > distance) {
                split = index;
                distance = currentDistance;
            }
        });
        const first = this._simplifyOpen(ring.slice(0, split + 1), tolerance);
        const second = this._simplifyOpen([...ring.slice(split), ring[0]], tolerance);
        return [...first.slice(0, -1), ...second.slice(0, -1)];
    }

    private static _simplifyOpen(points: PointType[], tolerance: number): PointType[] {
        if (points.length <= 2) return points;
        const keep = new Uint8Array(points.length);
        const stack: Array<[number, number]> = [[0, points.length - 1]];
        const threshold = tolerance * tolerance;
        keep[0] = 1;
        keep[points.length - 1] = 1;
        while (stack.length > 0) {
            const [start, end] = stack.pop() as [number, number];
            const first = points[start];
            const last = points[end];
            const dx = last[0] - first[0];
            const dy = last[1] - first[1];
            const lengthSquared = dx * dx + dy * dy;
            let farthest = -1;
            let farthestDistance = threshold;
            for (let index = start + 1; index < end; index++) {
                const point = points[index];
                const position =
                    lengthSquared === 0
                        ? 0
                        : Math.max(
                              0,
                              Math.min(1, ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / lengthSquared),
                          );
                const nearestX = first[0] + position * dx;
                const nearestY = first[1] + position * dy;
                const distanceX = point[0] - nearestX;
                const distanceY = point[1] - nearestY;
                const currentDistance = distanceX * distanceX + distanceY * distanceY;
                if (currentDistance > farthestDistance) {
                    farthestDistance = currentDistance;
                    farthest = index;
                }
            }
            if (farthest >= 0) {
                keep[farthest] = 1;
                stack.push([start, farthest], [farthest, end]);
            }
        }
        return points.filter((_point, index) => keep[index] === 1);
    }
}
