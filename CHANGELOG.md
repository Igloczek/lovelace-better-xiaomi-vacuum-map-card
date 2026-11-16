# Changelog

## 1.5.0

### Changed

- Every label on the map now uses one style, the room pill. Unselected rooms, predefined points and
  predefined rectangles show the pill without a badge, and selecting adds the badge (the room's
  number in the cleaning order, or a checkmark). The plain white outlined text labels are gone.
- The `--map-card-room-label-color(-selected)` and
  `--map-card-predefined-{point,rectangle}-label-color(-selected)` variables are removed. Every
  label takes its colours from `--map-card-room-pill-*`, and the card keeps the text readable.

### Added

- `map_source.room_labels: false` hides the card's room names when the map image already shows
  them (some integrations draw names into the map). A selected room keeps its badge.

## 1.4.3

### Fixed

- Switching to another preset no longer brings back a room selection that was on hold while the
  previous preset's camera had no room list. Floors often reuse room ids, so the card could show a
  room on the new floor as selected, and Start would have cleaned it, before the new preset finished
  loading.
- The editor's vacuum, platform and camera pickers fall back to plain dropdowns when Home
  Assistant's `ha-select` element is missing, instead of showing empty boxes, and switch to
  `ha-select` as soon as it loads.
- Two layout examples in the configuration docs now use `custom:better-xiaomi-vacuum-map-card`.

## 1.4.2

### Fixed

- Start on a vacuum that is unavailable (offline, or a dead battery after a failed dock) no longer
  reports success and shows a run that never started. Nothing is sent, the card says the vacuum is
  unavailable, and the selection stays for when it is back.

## 1.4.1

### Fixed

- The warning that lists stale room ids wraps instead of cutting off after the first id, so every
  id reads in a narrow card.
- A stale room's `!` marker stays visible next to a selected room's pill, never under it or over
  its name, and stays inside its room at every zoom and rotation. It follows the label font size,
  in any unit, as soon as the theme changes it.

## 1.4.0

### Changed

- The card has its own type, `custom:better-xiaomi-vacuum-map-card`, so it can be installed next to
  the original Xiaomi Vacuum Map Card. Existing `custom:xiaomi-vacuum-map-card` dashboards keep
  working while the original card is not installed, and the remembered map view and room run carry
  over. New cards from the card picker and the editor use the new type. See
  [Migrating from `custom:xiaomi-vacuum-map-card`](docs/configuration.md#migrating-from-customxiaomi-vacuum-map-card).
- The README's Marketplace button opens the repository in the right category; the old link was
  refused by Home Assistant.

### Fixed

- Two touching rooms that share a fill colour and interlock (two L-shaped rooms around a hallway)
  keep their own floor, including a piece a cleaning path cuts off, so a tap selects the room you
  tapped. Maps where this already worked are unchanged.

## 1.3.0

### Changed

- `layout: horizontal` stacks the controls under the map when the card is narrower than 400 px
  (the narrowest sections-view column, a phone, a sidebar), instead of squeezing the map to a
  thumbnail beside a clipped controls column. The switch follows the card's own width, not the
  window's. See [Layout](docs/configuration.md#layout).
- In a sections view the card takes exactly the height you give it with the resize handle or
  `grid_options`; it no longer forces at least three rows. A side-by-side card in a taller cell
  gives the extra height to the controls instead of leaving it empty. See
  [Resizing the card in a sections view](docs/configuration.md#resizing-the-card-in-a-sections-view).

### Fixed

- An empty key in the card YAML (`icons:`, `id:`, `map:` with nothing after it) no longer crashes
  the card; it counts as not set, and a required field left empty is reported by name.
- `map_view.reset` sent to a card in a hidden dashboard view no longer stores a view stuck in the
  map's top-left corner; the reset is applied when the card is shown.
- A room selection whose rooms have all left the camera map (after a re-map) is named in a warning
  and Start refuses to send an empty room list. Picking a room that is on the map clears it, and a
  room that comes back in the next camera update returns to the selection. A selection never
  carries over to a different camera. See [Selection lifetime](docs/configuration.md#selection-lifetime).
- Renaming an entity, device, area or floor, or changing an entity's icon in Home Assistant, updates
  the card's tiles and icons without a page reload.
- Tile generation no longer fails for a vacuum whose registry entries include an entity without an
  icon.

## 1.2.3

### Fixed

- In the Home Assistant Mac app (WebKit), deselecting a room whose pill reached over other rooms
  left the part of the pill over those rooms on screen. The pill's drawing box now covers the map,
  so removing it repaints all of it.

## 1.2.2

### Changed

- A selected room's pill sits exactly where the room's label was, centred on it, instead of above
  it like a tooltip, and it no longer has a pointer at the bottom. See
  [Selected room label](docs/configuration.md#selected-room-label).

## 1.2.1

### Fixed

- On a card with one preset per floor, a started room run is shown and locks the rooms only on the
  floor it was started on. Other floors' rooms could not be selected while the vacuum was cleaning,
  and where they shared the run's room ids (multi-floor Xiaomi, Roborock and Dreame maps do) they
  showed the run's pills. See [Selected room label](docs/configuration.md#selected-room-label).

## 1.2.0

### Changed

- A selected room's name turns into a pill, as in the Xiaomi Home app: a round badge next to the
  room name, with a small pointer at the room. The badge shows the room's place in the cleaning
  order where the platform follows it, and a checkmark elsewhere. Rooms of a started run keep their
  pills; a room with an icon shows the pill instead of the icon while selected. The pill follows
  the theme (light in a light theme, dark in a dark one), stays readable on every room colour, and
  its colours can be changed with the `--map-card-room-pill-*` CSS variables; whatever they are set
  to, the name and the badge glyph stay at 4.5:1 contrast or better. See
  [Selected room label](docs/configuration.md#selected-room-label).

### Fixed

- With the map locked, a press that slid off the card and was released there made the card drop the
  next room tap as if it ended a drag.

## 1.1.0

### Added

- A card added from the card picker uses the vacuum's own integration as its platform (Xiaomi Miio,
  Roborock core, Dreame, Xiaomi MIoT, Neato, Roomba, Deebot) and the map of the vacuum's own device,
  instead of always Xiaomi Miio and the first calibrated camera in the instance.
- Without `map_modes`, a camera that publishes `rooms` adds the platform's room mode to the
  defaults, so rooms can be cleaned without generating a config. Platforms whose room template
  needs hand-written variables or takes room names keep their defaults. A camera that is briefly
  unavailable keeps the mode and the selection.

### Changed

- Rooms are numbered only where the integration makes the vacuum clean them in the order they
  are sent: Valetudo, ValetudoRE (segments) and roomba_plus. On every other platform, including
  Xiaomi Miio, Roborock, Dreame and Viomi, and in modes with their own service call, the vacuum
  chooses its own route, so the selected rooms are highlighted without numbers. Set
  `cleaning_order: true` on a ROOM map mode to show the numbers anyway (it does not change the
  order the vacuum cleans in), or `false` to hide them. See
  [cleaning order per platform](docs/platforms.md#cleaning-order-per-platform).
- A run is no longer locked while the vacuum is paused or `unavailable`; a tap starts a new
  selection.
- `id_type: string` now sends room ids as strings; it had no effect before. A mode that sets it while
  its integration needs numbers now sends `"13"` instead of `13`: remove `id_type` or set it to
  `number`.

### Fixed

- A zoomed map keeps showing the same place when the card changes width: after a window resize,
  a phone rotation or a sections-view column change, and when a remembered view is reopened at
  another width. Before, the saved position was in screen pixels and could leave mostly empty
  space in view.
- A camera that updates faster than its map image downloads (a slow mobile connection, a chatty
  camera) no longer keeps the map from drawing: the card lets the current image finish loading,
  for at most five seconds, then fetches the newest one.
- A card that renders while Home Assistant has it detached keeps its map image instead of
  switching to the "disconnected" placeholder.
- A selection stays as the user made it: rooms, zones, points and drawn shapes, with their order
  and numbers, survive the card rebuilding them. An item drops out only when it disappears from the
  map or the configuration, and the rest keep their order.
  - A room, zone or point with a `state_entity` that changes outside the card no longer clears the
    rest of the selection or re-selects a `default_state` item the user deselected. It now joins
    the selection at the end when its entity turns on, and leaves when it turns off.
  - Zones and points read from an entity (`zones: sensor.x.attributes.zones`) follow that entity
    instead of staying as they were when the mode opened.
  - A room the camera stops reporting leaves the selection and its badge even when the map colours
    cannot be read, and a new room appears.
  - Setting the card configuration again (editor preview, dashboard re-render) keeps the current
    preset, mode and selection instead of returning to the first preset and mode with nothing
    selected. A `default_state` the editor newly sets still applies.
  - A camera or zone/point entity that is briefly unavailable (a Home Assistant restart) does not
    clear the selection: its items come back in their place when it returns.
  - `max_selections` holds when a `state_entity` item turns on outside the card or the limit is
    lowered: the items selected first are kept.
  - After a run clears the selection, the map shows it cleared right away.
- Invalid YAML (a scalar where a list belongs, a `null` list item, an unknown or numeric
  `selection_type`) shows a message naming the field instead of breaking the card. An empty key
  still counts as absent.
- A card that once had an old-style or invalid configuration renders again once the configuration
  is fixed, without reloading the page.
- A tile no longer shows `unavailable h`, `undefined h` or `NaN h`: a value that is not a number is
  shown as Home Assistant shows the state, without the unit. Numbers follow the user's number
  format (`1,5 h`).
- Duration tiles of Xiaomi Miio, humbertogontijo Roborock, Hypfer Valetudo, Deebot and Neatsvor
  convert from the unit the sensor reports, so a changed display unit no longer shows wrong hours.
- Deebot's total cleaning time tile is no longer dropped behind the cleaning time tile.
- A tile whose `icon_source` entity, or an icon whose condition entity, was removed no longer
  breaks the card.
- Room metadata with a broken entry, numeric strings, an empty name or a list instead of a mapping
  no longer breaks the map or uses list positions as room ids.
- The editor opens on frontends without card helpers, and clearing the camera field no longer
  throws.
- A templated service call (`evaluate_data_as_template`) works again with a selection inside a quoted
  Jinja string, such as `'[[selection]]' | from_json`. The Roomba room mode and the Valetudo RE saved
  zone mode failed with a template syntax error since 1.0.2.
- A service call that Home Assistant rejects keeps the selection and shows the error once (Home
  Assistant's own notification is turned off for the card's calls, and its translated message is
  shown). Before, the selection was cleared before Home Assistant answered.
- A second tap while a run is still being sent shows "Already sending" instead of sending the run
  twice, also for templated modes that wait for Home Assistant to render.
- Preset activation, the switch behind a selection's `state_entity`, and icon and tile service
  actions show an error when Home Assistant rejects them, instead of failing silently.
- Icon and tile actions written as `perform-action` (Home Assistant's current format) are performed;
  only `call-service` worked before.
- Valetudo's predefined go-to point sends its coordinates as numbers; Valetudo rejected the strings.
- The Deebot templates send room ids and zone coordinates in the format the running Home Assistant
  expects: lists from 2026.3 (where a `"13,14"` string was split into single characters, so room and
  zone cleaning did nothing), comma-separated strings before.
- The `send_command` room mode sends room ids read from the camera as numbers.
- The setup platforms' run button creates a notification with the coordinates; Home Assistant
  rejected the call before.
- `[[point_x]]` and `[[point_y]]` are filled for a point mode with `INTERNAL` repeats.
- Rooms that share a fill colour are all detected. Valetudo and Dreame colour rooms from a
  four-colour palette, and Xiaomi Cloud Map Extractor's default palette repeats colours, so only
  one room per colour was drawn and selectable from the map before. A room never extends into
  another room's area, so a narrow room or a closet next to a same-coloured room keeps its own
  taps.
- Tapping the robot, the charger, a room icon or name, furniture or a no-go zone drawn over a room
  selects that room, including the robot on a doorway between two rooms and the docked robot at
  a wall. Taps on the map's background still select nothing.
- The room name and order badge of an L- or U-shaped room are drawn on the room, not on the
  neighbouring room or the space inside its bend.
- A room the map colours did not reveal no longer takes taps meant for a detected room its outline
  overlaps, and a detected room no longer takes taps meant for it.
- While the vacuum cleans, a newer map snapshot of the same rooms reuses the room detection
  instead of tracing every room again.
- A room whose metadata outline is broken but whose bounds are usable keeps its bounds, a
  configured room whose metadata entry is unusable keeps its configured outline instead of
  vanishing, and room colour detection reads the metadata the same way as the rest of the card
  (numeric text, lists keyed by room id).
- The run shows the rooms that were sent, even if a room was tapped while Home Assistant was still
  answering the call.
- `unavailable` or `unknown` from a polling integration no longer ends a run mid-clean.
- Only `cleaning` reported after **Start** counts as the start of a run. The previous job's
  `cleaning` or `returning`, still shown by a lagging integration, or an update that only changes
  an attribute, no longer locks the rooms or lets a lagging `docked` end the run before the vacuum
  begins.
- A run that never starts ends after three minutes even when Home Assistant sends no further
  update, also after a reload.
- Several cards or tabs showing the same vacuum show the same run, and a card no longer deletes a
  run another card started.
- A run is shown only in the ROOM mode it was started from.
- While a start is pending, the icons treat the vacuum as cleaning, so the play icon does not offer
  a full clean during the ~30 s a polling integration needs to report the start; a new `docked` or
  `error` report shows the real state again at once.

### Documentation

- `id_type` and Jinja templates in `service_call_schema` are documented, and the Deebot page names the
  service it calls.

## 1.0.7

### Fixed

- Rooms are no longer locked after the vacuum has returned to the dock: a run ends as soon as the
  vacuum is docked, idle or in error. Before the vacuum reports that it started, a tap on a room
  starts a new selection instead of being refused.
- Dragging, pinching or rotating the map no longer selects the room under the pointer.

### Documentation

- Removed the one-room-at-a-time script recipe. A per-installation script is not a fix; the docs
  state that some vacuums (Viomi V8) ignore the room order instead.

## 1.0.6

### Fixed

- Tapping a cleaning path, or a small marker drawn over a room, selects that room. A path that
  crossed a room no longer shrinks the room's highlight to one side of it: gaps up to 8 px that
  the map draws over a room's colour are treated as part of the room.

## 1.0.5

### Fixed

- A run that docks between rooms keeps its order and lock: the run ends only once the vacuum has
  stayed out of `cleaning`, `paused` and `returning` for 90 seconds, and the card ends it on time
  even without a further state change.

### Documentation

- The one-room-at-a-time script waits until the vacuum has docked before sending the next room
  (the Viomi V8 ignores a room command while heading home) and resends a room that does not start.

## 1.0.4

### Changed

- During a run the rooms keep exactly the look they had when selected; the separate dashed style is
  gone.

### Fixed

- Rooms cannot be tapped while a run is in progress, so the cleaning order on the map cannot change
  until the vacuum is done.

## 1.0.3

### Fixed

- The cleaning order stays on the map after **Start**: the rooms of the run keep their numbers,
  with a dashed outline, until the vacuum is done. A reload keeps them.

### Documentation

- How to clean rooms in a fixed order on vacuums that plan their own route (Viomi V8): a script
  that sends one room at a time, started from the card.

## 1.0.2

### Added

- Agent problem reports: a user's AI agent collects, redacts and files a card problem with the
  [report-problem skill](.agents/skills/report-problem/SKILL.md); valid reports are labelled
  `agent-report`, and leaked tokens are removed from issues and comments automatically. See
  [Report a problem](docs/report-a-problem.md).

### Fixed

- Selected rooms keep the order they were clicked in when the live map refreshes, instead of
  falling back to room-id order.
- A ROOM mode with `evaluate_data_as_template` runs again with room ids from the camera metadata;
  a template error now shows a failure message instead of the run button doing nothing.

## 1.0.1

### Fixed

- The map viewport is transparent instead of Home Assistant's secondary grey, so a map with
  transparent or near-white areas blends into the card in light and dark themes. Set
  `--map-card-zoomer-background` to keep a visible frame.

## 1.0.0

First release of this fork under its own name and version line, based on upstream `v2.4.2`.

### Added

- Cleaning-order badges on selected rooms.
- `map_view` default view with a reset control and the `map_view.reset` action.
- `layout: horizontal` and sections-view grid sizing.
- Automatic room mapping from camera metadata and map colours.
- Persisted map view and rotation, with two-finger rotation.
- Transparent near-white map pixels and high-contrast room labels.

### Changed

- The camera snapshot reloads on a camera change or about once per five seconds instead of on every
  entity update, and stops while the tab is hidden.
- One scoped entity-registry lookup per vacuum, cached per device, replaces downloading the whole
  registry.
- Tile translations match regardless of case; labels, sensor durations and the return-to-base icon
  follow Home Assistant.
- Incomplete configurations and invalid dynamic selections produce validation messages instead of
  exceptions.
- The editor no longer mutates Home Assistant's frozen configuration, scopes room requests to the
  card being edited, and keeps a single rooms mode across repeated generation.
- Rooms removed by a re-map are marked, warned about and excluded from service calls.
- Editor controls follow the frontend: `ha-input` with an `ha-textfield` fallback, and labelled
  switches when `ha-formfield` is absent.

### Fixed

- Zoom and rotation are applied once to the image and its overlays, so room outlines stay aligned.
- A long mode name in the horizontal layout ellipsizes inside the controls column instead of being
  clipped without an ellipsis.
