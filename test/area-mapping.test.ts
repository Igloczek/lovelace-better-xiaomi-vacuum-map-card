import { describe, expect, it } from "vitest";

import {
    findUnmappedAreas,
    readVacuumAreaOptions,
    resolveAreaOutlines,
    type AreaOutlineInput,
} from "../src/model/area-mapping";

/**
 * The join from Home Assistant's area mapping to the map camera's rooms (issue #120, option 5). The
 * camera ids and Home Assistant's segment ids come from the #120 report: `roborock_custom_map` keys
 * its rooms 16..26, and core Roborock names the same segments `0_16`..`0_26`.
 */

const CAMERA = new Set(["16", "17", "18", "19", "20", "21", "26"]);

function roborock(overrides: Partial<AreaOutlineInput> = {}): AreaOutlineInput {
    return {
        platform: "roborock",
        cameraRoomIds: CAMERA,
        options: {
            areaMapping: { flur: ["0_17"], esszimmer: ["0_16"], kuche: ["0_18"] },
            lastSeenSegments: [
                { id: "0_16", name: "Esszimmer", group: "Erdgeschoss" },
                { id: "0_17", name: "Flur", group: "Erdgeschoss" },
                { id: "0_18", name: "Küche", group: "Erdgeschoss" },
            ],
        },
        ...overrides,
    };
}

const asObject = (map: ReadonlyMap<string, unknown> | undefined): Record<string, unknown> =>
    Object.fromEntries(map ?? []);

describe("resolveAreaOutlines", () => {
    it("joins Roborock's map-prefixed segment ids to the camera's bare room ids", () => {
        const outlines = resolveAreaOutlines(roborock());
        expect(asObject(outlines?.roomsByArea)).toEqual({ flur: ["17"], esszimmer: ["16"], kuche: ["18"] });
        expect(asObject(outlines?.areaByRoom)).toEqual({ "17": "flur", "16": "esszimmer", "18": "kuche" });
    });

    it("keeps every segment of an area that spans several, in mapped order", () => {
        const outlines = resolveAreaOutlines(
            roborock({ options: { areaMapping: { wohnbereich: ["0_21", "0_16"] }, lastSeenSegments: [] } }),
        );
        expect(asObject(outlines?.roomsByArea)).toEqual({ wohnbereich: ["21", "16"] });
    });

    it("has no rule for an integration whose join is not confirmed", () => {
        for (const platform of ["ecovacs", "matter", "template", "xiaomi_miot", undefined]) {
            expect(resolveAreaOutlines(roborock({ platform }))).toBeUndefined();
        }
    });

    it("has nothing to join before the user maps areas", () => {
        expect(resolveAreaOutlines(roborock({ options: { lastSeenSegments: [] } }))).toBeUndefined();
    });

    it("drops a segment the camera does not report", () => {
        const outlines = resolveAreaOutlines(
            roborock({ options: { areaMapping: { flur: ["0_17", "0_99"] }, lastSeenSegments: [] } }),
        );
        expect(asObject(outlines?.roomsByArea)).toEqual({ flur: ["17"] });
    });

    it("draws a room two areas claim for neither of them", () => {
        const outlines = resolveAreaOutlines(
            roborock({
                options: { areaMapping: { flur: ["0_17", "0_16"], esszimmer: ["0_16"] }, lastSeenSegments: [] },
            }),
        );
        expect(asObject(outlines?.roomsByArea)).toEqual({ flur: ["17"] });
        expect(outlines?.areaByRoom.has("16")).toBe(false);
    });

    describe("two floors numbered from the same start", () => {
        const segments = [
            { id: "0_16", name: "Esszimmer", group: "Erdgeschoss" },
            { id: "0_17", name: "Flur", group: "Erdgeschoss" },
            { id: "1_16", name: "Bad oben", group: "Obergeschoss" },
            { id: "1_20", name: "Kinderzimmer", group: "Obergeschoss" },
        ];
        const areaMapping = { esszimmer: ["0_16"], flur: ["0_17"], bad_oben: ["1_16"], kinderzimmer: ["1_20"] };

        it("draws the floor the current-map select names", () => {
            const ground = resolveAreaOutlines(
                roborock({ options: { areaMapping, lastSeenSegments: segments }, currentMapName: "Erdgeschoss" }),
            );
            expect(asObject(ground?.roomsByArea)).toEqual({ esszimmer: ["16"], flur: ["17"] });
            const upper = resolveAreaOutlines(
                roborock({ options: { areaMapping, lastSeenSegments: segments }, currentMapName: "Obergeschoss" }),
            );
            expect(asObject(upper?.roomsByArea)).toEqual({ bad_oben: ["16"], kinderzimmer: ["20"] });
        });

        it("without a known floor, draws only the bare ids one floor produces", () => {
            const outlines = resolveAreaOutlines(roborock({ options: { areaMapping, lastSeenSegments: segments } }));
            // 16 is on both floors, so neither area gets it; 17 and 20 are unique.
            expect(asObject(outlines?.roomsByArea)).toEqual({ flur: ["17"], kinderzimmer: ["20"] });
        });

        it("counts a floor nobody mapped yet: its bare ids are still ambiguous", () => {
            const outlines = resolveAreaOutlines(
                roborock({ options: { areaMapping: { esszimmer: ["0_16"] }, lastSeenSegments: segments } }),
            );
            expect(asObject(outlines?.roomsByArea)).toEqual({});
        });

        it("draws nothing when the select names a map Home Assistant has no segments for", () => {
            // The vacuum is on a floor added after the areas were mapped: none of the known floors is
            // shown, so their areas must not be drawn on its rooms.
            const outlines = resolveAreaOutlines(
                roborock({ options: { areaMapping, lastSeenSegments: segments }, currentMapName: "Keller" }),
            );
            expect(asObject(outlines?.roomsByArea)).toEqual({});
        });

        it("keeps the floors a shared map name names, and only their unique ids", () => {
            const shared = [
                { id: "0_16", name: "Esszimmer", group: "Home" },
                { id: "1_20", name: "Kinderzimmer", group: "Home" },
                { id: "1_17", name: "Bad", group: "Home" },
                { id: "2_25", name: "Werkstatt", group: "Garage" },
                { id: "2_17", name: "Lager", group: "Garage" },
            ];
            const outlines = resolveAreaOutlines(
                roborock({
                    cameraRoomIds: new Set(["16", "17", "20", "25"]),
                    options: {
                        areaMapping: {
                            esszimmer: ["0_16"],
                            kinderzimmer: ["1_20"],
                            bad: ["1_17"],
                            werkstatt: ["2_25"],
                        },
                        lastSeenSegments: shared,
                    },
                    currentMapName: "Home",
                }),
            );
            // 17 is on map 1 only among the "Home" maps; the garage's 2_17 does not make it ambiguous.
            expect(asObject(outlines?.roomsByArea)).toEqual({ esszimmer: ["16"], kinderzimmer: ["20"], bad: ["17"] });
        });

        it("without the segment list and a floor signal, draws nothing for a mapping on several floors", () => {
            // Without `last_seen_segments` the card cannot know a floor's unmapped rooms, so room 20 of
            // map 0 could be anything.
            const outlines = resolveAreaOutlines(
                roborock({ options: { areaMapping: { flur: ["0_17"], kinderzimmer: ["1_20"] } } }),
            );
            expect(asObject(outlines?.roomsByArea)).toEqual({});
        });

        it("treats segments without map names as no floor signal", () => {
            const unnamed = segments.map(segment => ({ ...segment, group: null }));
            const outlines = resolveAreaOutlines(
                roborock({ options: { areaMapping, lastSeenSegments: unnamed }, currentMapName: "Erdgeschoss" }),
            );
            expect(asObject(outlines?.roomsByArea)).toEqual({ flur: ["17"], kinderzimmer: ["20"] });
        });
    });

    it("joins Dreame's map-index prefix like Roborock's", () => {
        const outlines = resolveAreaOutlines(
            roborock({ platform: "dreame_vacuum", options: { areaMapping: { flur: ["0_17"] } } }),
        );
        expect(asObject(outlines?.roomsByArea)).toEqual({ flur: ["17"] });
    });

    it("joins Valetudo's unprefixed segment ids over MQTT as they are", () => {
        const outlines = resolveAreaOutlines({
            platform: "mqtt",
            cameraRoomIds: new Set(["1", "2", "3"]),
            options: { areaMapping: { kitchen: ["1"], hall: ["3", "2"] } },
        });
        expect(asObject(outlines?.roomsByArea)).toEqual({ kitchen: ["1"], hall: ["3", "2"] });
    });

    it("rejects a malformed Roborock id instead of guessing its room", () => {
        const outlines = resolveAreaOutlines(
            roborock({ options: { areaMapping: { flur: ["17", "_17", "0_"] }, lastSeenSegments: [] } }),
        );
        expect(asObject(outlines?.roomsByArea)).toEqual({});
    });
});

describe("readVacuumAreaOptions", () => {
    it("reads the mapping and the segments from a registry entry", () => {
        const entry = {
            entity_id: "vacuum.robot",
            options: {
                vacuum: {
                    area_mapping: { flur: ["0_17", null, "", 18], broken: "0_1" },
                    last_seen_segments: [
                        { id: "0_17", name: "Flur", group: "Erdgeschoss" },
                        null,
                        { name: "no id" },
                        { id: null },
                    ],
                },
            },
        };
        expect(readVacuumAreaOptions(entry)).toEqual({
            areaMapping: { flur: ["0_17", "18"] },
            lastSeenSegments: [{ id: "0_17", name: "Flur", group: "Erdgeschoss" }],
        });
    });

    it("is empty for an entry without vacuum options", () => {
        expect(readVacuumAreaOptions({ options: {} })).toEqual({});
        expect(readVacuumAreaOptions(undefined)).toEqual({});
    });
});

describe("findUnmappedAreas", () => {
    it("names the areas Home Assistant has no segments for", () => {
        expect(findUnmappedAreas(["flur", "bad", "leer"], { areaMapping: { flur: ["0_17"], leer: [] } })).toEqual([
            "bad",
            "leer",
        ]);
    });

    it("names every area while nothing is mapped", () => {
        expect(findUnmappedAreas(["flur"], {})).toEqual(["flur"]);
    });
});
