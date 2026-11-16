# Dreame live position capture

Captured for [#47](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/47) from a
DreameBot L10s Ultra (`dreame.vacuum.r2228z`, firmware 4.3.9_3405) on Tasshack/dreame-vacuum 2.0.3 and
Home Assistant 2026.11.1, during one short room clean.

- `camera-samples.json`: the map camera's position and calibration attributes at three moments (docked
  before the run, started but still pre-washing in the dock, docked after the return). The integration
  has no path attribute; it paints the track into the camera image and publishes the robot's position
  as `vacuum_position: {x, y, a}` in vacuum coordinates.
- `position-track.json`: 15 of the 51 positions polled every 3 s (dock, room, back to dock), with the
  integration's `status` and `frame_id`.

Scrubbed by the reporter: every vacuum-space coordinate (positions and the `vacuum` side of
`calibration_points`) is shifted by x +10000, y +5000; pixel coordinates are unchanged. Tokens, rooms,
walls, furniture and pictures are removed.

The pixel side of `calibration_points` moves between frames (`map.y` 553 before the run, 737 after it)
while the vacuum side stays put, which is why the card keeps the track in vacuum coordinates.
