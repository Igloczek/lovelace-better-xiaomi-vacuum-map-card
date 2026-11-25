/*
 * Regenerates the apartment fixture:
 *
 *   node test/fixtures/apartment/generate.cjs
 *
 * A floor plan drawn the way the Xiaomi map extractors (xiaomi_miot, the cloud map extractor) draw
 * one, modelled on the maintainer's Viomi V8 map: 20 px per metre, transparent outside the flat,
 * grey walls, and rooms that share those walls. Unlike the three separated rectangles of
 * `../synthetic/`, nothing here is tidy:
 *
 * - every room borders others across a 2 px wall, so a label can reach over a neighbour's outline;
 * - L-, T- and stepped shapes, and two rooms (closet, WC) far smaller than their names;
 * - long, short and Polish names (diacritics), one room the camera does not name;
 * - furniture blocks and a robot path drawn over the floor, a charger, and one room in the same
 *   colour as its neighbour across a wall (only the wall tells them apart).
 *
 * `camera.json` carries the camera's `rooms` metadata (vacuum metres, y up) and calibration; the
 * PNG and the metadata are generated together so the room bounds and the drawn rooms agree.
 */
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const WIDTH = 304;
const HEIGHT = 216;
const PX_PER_M = 20;
const TRANSPARENT = [0, 0, 0, 0];
const WALL = [93, 109, 126, 255];
const FURNITURE = [223, 223, 223, 255];
const PATH = [37, 99, 235, 255];
const CHARGER = [0, 0, 0, 255];

// The maintainer's map palette. Kitchen and Salon share a colour across their wall on purpose.
const GREEN = [82, 190, 128, 255];
const BLUE = [84, 153, 199, 255];
const ORANGE = [245, 176, 65, 255];
const SKY = [133, 193, 233, 255];
const TEAL = [72, 201, 176, 255];
const VIOLET = [175, 122, 197, 255];
const SAND = [229, 152, 102, 255];

/** id, camera name (undefined: the camera does not name it), colour and outline in image pixels. */
const ROOMS = [
    {
        id: "10",
        name: "Kuchnia",
        color: GREEN,
        points: [
            [10, 10],
            [118, 10],
            [118, 56],
            [10, 56],
        ],
    },
    {
        id: "11",
        name: "Salon",
        color: GREEN,
        points: [
            [10, 59],
            [118, 59],
            [118, 168],
            [64, 168],
            [64, 205],
            [10, 205],
        ],
    },
    {
        id: "12",
        name: "Garderoba i pralnia",
        color: VIOLET,
        points: [
            [121, 10],
            [198, 10],
            [198, 56],
            [121, 56],
        ],
    },
    {
        id: "13",
        name: "Korytarz",
        color: ORANGE,
        points: [
            [121, 59],
            [198, 59],
            [198, 95],
            [160, 95],
            [160, 140],
            [121, 140],
        ],
    },
    {
        id: "14",
        name: "Schowek",
        color: TEAL,
        points: [
            [163, 98],
            [198, 98],
            [198, 118],
            [163, 118],
        ],
    },
    {
        id: "15",
        name: "WC",
        color: SAND,
        points: [
            [163, 121],
            [198, 121],
            [198, 140],
            [163, 140],
        ],
    },
    {
        id: "16",
        name: "Łazienka",
        color: SKY,
        points: [
            [121, 143],
            [198, 143],
            [198, 205],
            [121, 205],
        ],
    },
    {
        id: "17",
        name: "Sypialnia",
        color: BLUE,
        // A chamfered outer corner: the one wall that is not axis-aligned.
        points: [
            [201, 10],
            [266, 10],
            [292, 36],
            [292, 100],
            [240, 100],
            [240, 118],
            [201, 118],
        ],
    },
    {
        id: "18",
        name: undefined,
        color: SKY,
        points: [
            [243, 103],
            [292, 103],
            [292, 205],
            [201, 205],
            [201, 121],
            [243, 121],
        ],
    },
];

/** Furniture the robot cannot reach: grey blocks inside rooms, as the extractor draws obstacles. */
const FURNITURE_BLOCKS = [
    [20, 70, 50, 95], // sofa in the salon
    [80, 120, 110, 160], // table
    [215, 20, 250, 45], // bed
];

/** The robot's path: a few runs across rooms and doorways, 1 px wide, drawn over the floor. */
const PATH_RUNS = [
    [
        [14, 180],
        [14, 110],
        [60, 110],
        [60, 100],
        [140, 100],
        [140, 70],
        [190, 70],
    ],
    [
        [140, 100],
        [140, 160],
        [180, 160],
        [180, 190],
    ],
    [
        [190, 70],
        [230, 70],
        [230, 90],
        [280, 90],
        [280, 150],
        [220, 150],
        [220, 190],
    ],
];

/** Fills a polygon (even-odd, pixel centres): the same fill as `../synthetic/generate.cjs`. */
function fillPolygon(setPixel, points, color) {
    const top = Math.floor(Math.min(...points.map(p => p[1])));
    const bottom = Math.ceil(Math.max(...points.map(p => p[1])));
    for (let y = top; y <= bottom; y++) {
        const cy = y + 0.5;
        const crossings = [];
        points.forEach((p, i) => {
            const n = points[(i + 1) % points.length];
            if (p[1] <= cy !== n[1] <= cy) crossings.push(p[0] + ((cy - p[1]) / (n[1] - p[1])) * (n[0] - p[0]));
        });
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) {
            for (let x = Math.ceil(crossings[i] - 0.5); x + 0.5 <= crossings[i + 1]; x++) setPixel(x, y, color);
        }
    }
}

function drawLine(setPixel, [x0, y0], [x1, y1], color) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
        setPixel(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), color);
    }
}

const png = new PNG({ width: WIDTH, height: HEIGHT });
const setPixel = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const o = (y * WIDTH + x) * 4;
    png.data[o] = rgba[0];
    png.data[o + 1] = rgba[1];
    png.data[o + 2] = rgba[2];
    png.data[o + 3] = rgba[3];
};
for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) setPixel(x, y, TRANSPARENT);
for (const room of ROOMS) fillPolygon(setPixel, room.points, room.color);
// The walls: every empty pixel within 2 px of a room, so they follow the rooms' shapes (a notch or
// a chamfer stays outside the flat) and fill the 2 px gaps between neighbours.
const isFloor = (x, y) => x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT && png.data[(y * WIDTH + x) * 4 + 3] > 0;
const walls = [];
for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
        if (isFloor(x, y)) continue;
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++)
            for (let dx = -2; dx <= 2 && !near; dx++) near = isFloor(x + dx, y + dy);
        if (near) walls.push([x, y]);
    }
}
for (const [x, y] of walls) setPixel(x, y, WALL);
for (const [x0, y0, x1, y1] of FURNITURE_BLOCKS)
    fillPolygon(
        setPixel,
        [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
        ],
        FURNITURE,
    );
for (const run of PATH_RUNS) for (let i = 0; i + 1 < run.length; i++) drawLine(setPixel, run[i], run[i + 1], PATH);
for (let y = 196; y <= 199; y++) for (let x = 12; x <= 15; x++) setPixel(x, y, CHARGER);

const encoded = PNG.sync.write(png);
// The visual harness serves the first; the end-to-end instance can only read its config directory.
const E2E_CONFIG = path.join(__dirname, "..", "..", "e2e", "ha", "config");
for (const out of [path.join(__dirname, "map.png"), path.join(E2E_CONFIG, "map_apartment.png")]) {
    fs.writeFileSync(out, encoded);
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

// Vacuum coordinates: metres, origin at the image's bottom-left, y up (as the Viomi reports them).
const toVacuum = ([x, y]) => [x / PX_PER_M, (HEIGHT - y) / PX_PER_M];
const round = v => Math.round(v * 100) / 100;
const rooms = {};
for (const room of ROOMS) {
    const vs = room.points.map(toVacuum);
    rooms[room.id] = {
        x0: round(Math.min(...vs.map(v => v[0]))),
        y0: round(Math.min(...vs.map(v => v[1]))),
        x1: round(Math.max(...vs.map(v => v[0]))),
        y1: round(Math.max(...vs.map(v => v[1]))),
        number: Number(room.id),
        ...(room.name ? { name: room.name } : {}),
    };
}
// The ground truth of every test that scores a traced outline: each room's floor as drawn, in image
// pixels (the polygons `fillPolygon` paints).
fs.writeFileSync(
    path.join(__dirname, "floor.json"),
    `${JSON.stringify(Object.fromEntries(ROOMS.map(room => [room.id, room.points])))}\n`,
);
console.log("wrote test/fixtures/apartment/floor.json");

const camera = {
    entity_id: "camera.apartment_map",
    state: "idle",
    attributes: {
        friendly_name: "Apartment map",
        entity_picture: "/api/camera_proxy/camera.apartment_map?token=REDACTED_TOKEN",
        access_token: "REDACTED_TOKEN",
        last_update_timestamp: 1761981600,
        calibration_points: [
            { map: { x: 0, y: HEIGHT }, vacuum: { x: 0, y: 0 } },
            { map: { x: PX_PER_M * 10, y: HEIGHT }, vacuum: { x: 10, y: 0 } },
            { map: { x: 0, y: HEIGHT - PX_PER_M * 10 }, vacuum: { x: 0, y: 10 } },
        ],
        rooms,
    },
    last_changed: "2026-11-01T10:00:00.000Z",
    last_updated: "2026-11-01T10:00:00.000Z",
    context: { id: "fixture-apartment-camera", parent_id: null, user_id: null },
};
fs.writeFileSync(path.join(__dirname, "camera.json"), `${JSON.stringify(camera, null, 4)}\n`);
console.log("wrote test/fixtures/apartment/camera.json");
// The end-to-end fixture camera publishes the same room metadata.
fs.writeFileSync(path.join(E2E_CONFIG, "map_apartment_rooms.json"), `${JSON.stringify(rooms, null, 4)}\n`);
console.log("wrote test/e2e/ha/config/map_apartment_rooms.json");

/*
 * The same flat as a Valetudo robot reports it through sca075's MQTT Vacuum Camera
 * (`valetudo_map_parser`), the camera the Valetudo platform docs recommend. That integration
 * publishes no `x0`/`y0`/`x1`/`y1` bounds, only each room's own `outline`, and the outline is not the
 * room: it is the convex hull of the segment's cells after a 3x3 morphological opening, in Valetudo
 * units (cm, y down, 5 cm per cell), closed by repeating its first point. An L-shaped or notched
 * room's hull spills across the wall into its neighbours, hulls of neighbours overlap, and the hull
 * of a cell grid sits one cell short on the right and bottom edges. `x`/`y` is the centre of the
 * hull's bounding box, which can lie outside an L-shaped room, and an unnamed segment is called
 * `Room <id>`. See `rooms_handler.py` in sca075/Python-package-valetudo-map-parser.
 *
 * Here one image pixel is one 5 cm cell, and the map is offset in the robot's frame as a real
 * Valetudo map is.
 */
const VALETUDO_CM_PER_PX = 5;
const VALETUDO_ORIGIN = [1200, 1500];

/** The floor cells of one room, as `fillPolygon` paints them. */
function roomMask(points) {
    const mask = new Uint8Array(WIDTH * HEIGHT);
    fillPolygon(
        (x, y) => {
            if (x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT) mask[y * WIDTH + x] = 1;
        },
        points,
        null,
    );
    return mask;
}

/** A 3x3 erosion followed by a 3x3 dilation, as the parser cleans each segment mask. */
function open3x3(mask) {
    const pass = (source, keep) => {
        const out = new Uint8Array(source.length);
        for (let y = 0; y < HEIGHT; y++) {
            for (let x = 0; x < WIDTH; x++) {
                let hits = 0;
                for (let dy = -1; dy <= 1; dy++)
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && ny >= 0 && nx < WIDTH && ny < HEIGHT && source[ny * WIDTH + nx]) hits++;
                    }
                out[y * WIDTH + x] = keep(hits) ? 1 : 0;
            }
        }
        return out;
    };
    return pass(
        pass(mask, hits => hits === 9),
        hits => hits > 0,
    );
}

/** The convex hull (monotone chain, counter-clockwise on screen) of the set cells' top-left corners. */
function convexHull(mask) {
    const points = [];
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (mask[y * WIDTH + x]) points.push([x, y]);
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = list => {
        const chain = [];
        for (const point of list) {
            while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0)
                chain.pop();
            chain.push(point);
        }
        chain.pop();
        return chain;
    };
    return [...half(points), ...half([...points].reverse())];
}

const toValetudo = ([x, y]) => [
    VALETUDO_ORIGIN[0] + x * VALETUDO_CM_PER_PX,
    VALETUDO_ORIGIN[1] + y * VALETUDO_CM_PER_PX,
];
const valetudoRooms = {};
for (const room of ROOMS) {
    const hull = convexHull(open3x3(roomMask(room.points))).map(toValetudo);
    const xs = hull.map(point => point[0]);
    const ys = hull.map(point => point[1]);
    valetudoRooms[room.id] = {
        number: Number(room.id),
        outline: [...hull, hull[0]],
        name: room.name ?? `Room ${room.id}`,
        x: Math.floor((Math.min(...xs) + Math.max(...xs)) / 2),
        y: Math.floor((Math.min(...ys) + Math.max(...ys)) / 2),
    };
}
const valetudoCamera = {
    entity_id: "camera.apartment_valetudo_map",
    state: "idle",
    attributes: {
        friendly_name: "Apartment Valetudo map",
        entity_picture: "/api/camera_proxy/camera.apartment_valetudo_map?token=REDACTED_TOKEN",
        access_token: "REDACTED_TOKEN",
        last_update_timestamp: 1761981600,
        calibration_points: [
            [0, 0],
            [PX_PER_M * 10, 0],
            [0, PX_PER_M * 10],
        ].map(([x, y]) => {
            const [vx, vy] = toValetudo([x, y]);
            return { map: { x, y }, vacuum: { x: vx, y: vy } };
        }),
        rooms: valetudoRooms,
    },
    last_changed: "2026-11-01T10:00:00.000Z",
    last_updated: "2026-11-01T10:00:00.000Z",
    context: { id: "fixture-apartment-valetudo-camera", parent_id: null, user_id: null },
};
fs.writeFileSync(path.join(__dirname, "camera-valetudo.json"), `${JSON.stringify(valetudoCamera, null, 4)}\n`);
console.log("wrote test/fixtures/apartment/camera-valetudo.json");
fs.writeFileSync(
    path.join(E2E_CONFIG, "map_apartment_valetudo_rooms.json"),
    `${JSON.stringify(valetudoRooms, null, 4)}\n`,
);
console.log("wrote test/e2e/ha/config/map_apartment_valetudo_rooms.json");

// The JSON files are committed in the repository's format (`npm run format`), so a regeneration
// leaves no diff and `format:check` passes.
require("node:child_process").execFileSync(
    path.join(__dirname, "..", "..", "..", "node_modules", ".bin", "oxfmt"),
    [
        path.join(__dirname, "camera.json"),
        path.join(__dirname, "camera-valetudo.json"),
        path.join(__dirname, "floor.json"),
        path.join(E2E_CONFIG, "map_apartment_rooms.json"),
        path.join(E2E_CONFIG, "map_apartment_valetudo_rooms.json"),
    ],
    { stdio: "inherit" },
);
