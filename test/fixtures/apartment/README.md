# Apartment fixture

A realistic floor plan for the visual (`test/visual/apartment.spec.ts`) and end-to-end
(`test/e2e/specs/apartment-rooms.spec.ts`) suites, drawn the way the Xiaomi map extractors draw one
and modelled on a Viomi V8 map: 20 px per metre, transparent outside the flat, grey walls, rooms that
share those walls, irregular shapes, long and Polish names, a room the camera does not name,
same-coloured neighbours, furniture and a robot path over the floor. The synthetic three-room map in
`../synthetic/` has none of that, and real maps break the card exactly there.

Regenerate with `node test/fixtures/apartment/generate.cjs`. It writes `map.png` and `camera.json`
here, and the same image and room metadata into `test/e2e/ha/config/` (`map_apartment.png`,
`map_apartment_rooms.json`), the only place the end-to-end instance can read them from.
