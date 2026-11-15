/*
 * Regenerates the committed synthetic map fixtures:
 *
 *   node test/fixtures/synthetic/generate.cjs
 *
 * The images are committed, but they are generated rather than hand-drawn so the geometry in the
 * PNGs, the camera metadata in camera.json and the room-detection assertions can be reviewed
 * together.
 *
 * - map.png is a 200x150 bitmap with three flat, saturated rooms on white, used by the unit tests
 *   and served by the end-to-end fixture camera.
 * - interlock.png is a 200x120 floor plan with two same-coloured L-shaped rooms around a hallway
 *   (the end-to-end hit-testing fixture). It is also copied into the end-to-end instance's config
 *   directory, which is the only place that container can read it from.
 */
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const THREE_ROOMS = {
    width: 200,
    height: 150,
    background: [255, 255, 255, 255],
    // id, colour, x0, y0, x1, y1 (inclusive pixel bounds)
    rooms: [
        { id: "0", color: [230, 25, 75, 255], left: 20, top: 20, right: 79, bottom: 69 },
        { id: "1", color: [60, 180, 75, 255], left: 100, top: 20, right: 169, bottom: 69 },
        { id: "2", color: [67, 99, 216, 255], left: 20, top: 90, right: 79, bottom: 129 },
    ],
};

/**
 * The same-coloured interlocking pair. A is a top bar and a left column, B a right column and an
 * arm reaching under A's bar, so each room's fill lies inside the other's bounding box. A thin wall
 * (the wall-coloured area between them) separates the two fills, as every map source draws walls.
 * The coordinates match the unit test in test/room-detection-boundaries.test.ts.
 */
const INTERLOCKING_ROOMS = {
    width: 200,
    height: 120,
    background: [19, 87, 148, 255],
    wall: { color: [93, 109, 126, 255], left: 8, top: 8, right: 191, bottom: 111 },
    shapes: [
        {
            id: "kitchen",
            color: [133, 193, 233, 255],
            points: [
                [10, 10],
                [109, 10],
                [109, 39],
                [39, 39],
                [39, 109],
                [10, 109],
            ],
        },
        {
            id: "hall",
            color: [133, 193, 233, 255],
            points: [
                [112, 10],
                [189, 10],
                [189, 109],
                [42, 109],
                [42, 42],
                [112, 42],
            ],
        },
    ],
};

/** A filled polygon (even-odd, pixel centres), the same fill the tests' SyntheticMap paints. */
const fillPolygon = (setPixel, points, color) => {
    const top = Math.floor(Math.min(...points.map(point => point[1])));
    const bottom = Math.ceil(Math.max(...points.map(point => point[1])));
    for (let y = top; y <= bottom; y++) {
        const centreY = y + 0.5;
        const crossings = [];
        points.forEach((point, index) => {
            const next = points[(index + 1) % points.length];
            if (point[1] <= centreY !== next[1] <= centreY) {
                crossings.push(point[0] + ((centreY - point[1]) / (next[1] - point[1])) * (next[0] - point[0]));
            }
        });
        crossings.sort((a, b) => a - b);
        for (let index = 0; index + 1 < crossings.length; index += 2) {
            for (let x = Math.ceil(crossings[index] - 0.5); x + 0.5 <= crossings[index + 1]; x++) setPixel(x, y, color);
        }
    }
};

const render = ({ width, height, background }, draw) => {
    const png = new PNG({ width, height });
    const setPixel = (x, y, rgba) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const offset = (y * width + x) * 4;
        png.data[offset] = rgba[0];
        png.data[offset + 1] = rgba[1];
        png.data[offset + 2] = rgba[2];
        png.data[offset + 3] = rgba[3];
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) setPixel(x, y, background);
    }
    draw(setPixel);
    return png;
};

const write = (file, png, width, height) => {
    fs.writeFileSync(file, PNG.sync.write(png, { width, height }));
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
};

const threeRooms = render(THREE_ROOMS, setPixel => {
    for (const room of THREE_ROOMS.rooms) {
        for (let y = room.top; y <= room.bottom; y++) {
            for (let x = room.left; x <= room.right; x++) setPixel(x, y, room.color);
        }
    }
});
write(path.join(__dirname, "map.png"), threeRooms, THREE_ROOMS.width, THREE_ROOMS.height);

const interlocking = render(INTERLOCKING_ROOMS, setPixel => {
    const { wall } = INTERLOCKING_ROOMS;
    for (let y = wall.top; y <= wall.bottom; y++) {
        for (let x = wall.left; x <= wall.right; x++) setPixel(x, y, wall.color);
    }
    for (const shape of INTERLOCKING_ROOMS.shapes) fillPolygon(setPixel, shape.points, shape.color);
});
write(path.join(__dirname, "interlock.png"), interlocking, INTERLOCKING_ROOMS.width, INTERLOCKING_ROOMS.height);
write(
    path.join(__dirname, "..", "..", "e2e", "ha", "config", "map_interlock.png"),
    interlocking,
    INTERLOCKING_ROOMS.width,
    INTERLOCKING_ROOMS.height,
);

/**
 * The same plan with a cleaning path drawn down the kitchen's bar, wall to wall. It cuts the bar's
 * right end off, and that piece lies wholly inside both rooms' bounds, so the shapes cannot say
 * which room it is: the end-to-end proof that the path-cut piece stays the kitchen's.
 */
const INTERLOCKING_PATH_COLOR = [147, 194, 238, 255];
const INTERLOCKING_PATH_X = 90;
const pathed = render(INTERLOCKING_ROOMS, setPixel => {
    const { wall } = INTERLOCKING_ROOMS;
    for (let y = wall.top; y <= wall.bottom; y++) {
        for (let x = wall.left; x <= wall.right; x++) setPixel(x, y, wall.color);
    }
    for (const shape of INTERLOCKING_ROOMS.shapes) fillPolygon(setPixel, shape.points, shape.color);
    for (let y = 10; y <= 39; y++) {
        setPixel(INTERLOCKING_PATH_X, y, INTERLOCKING_PATH_COLOR);
        setPixel(INTERLOCKING_PATH_X + 1, y, INTERLOCKING_PATH_COLOR);
    }
});
write(
    path.join(__dirname, "..", "..", "e2e", "ha", "config", "map_interlock_path.png"),
    pathed,
    INTERLOCKING_ROOMS.width,
    INTERLOCKING_ROOMS.height,
);
