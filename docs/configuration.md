# Configuration

The configuration format is unchanged from the upstream card: no key was renamed and no option
was removed, so existing YAML keeps working. The card type is
`custom:better-xiaomi-vacuum-map-card`; `custom:xiaomi-vacuum-map-card` still works while the
original card is not installed (see
[the migration note](#migrating-from-customxiaomi-vacuum-map-card)). This fork adds
these options on top:
[`layout`](#layout), [`map_view`](#map-view-options), `map_rotation`, `map_rotation_gesture`,
`persist_map_view`, `persist_map_lock`, `map_view_storage_key` and `transparent_background`.

The card has a visual editor for the basic options; everything else is YAML-only. The
[demo config](demo_config.yaml) is a complete example.

### Migrating from `custom:xiaomi-vacuum-map-card`

The old type keeps working without an edit: when the original card is not installed, this card also
answers to `custom:xiaomi-vacuum-map-card`. The decision is made from what the dashboard's card
resources did, not from their file names:

- A resource that fails to load — an upgrade leaves a row pointing at the deleted
  `/local/community/lovelace-xiaomi-vacuum-map-card/xiaomi-vacuum-map-card.js` — cannot register the
  original card's element, so the alias is defined.
- A resource that loaded gets a bounded chance to register `xiaomi-vacuum-map-card` (two seconds
  after the last resource settles) before this card takes the name.
- An element another bundle already registered is never redefined.

Limits worth knowing:

- A renamed or proxied copy of the original card (a CDN URL, a wrapper module, a file this card
  cannot recognise) is not detected before it registers. The first definition of a custom element
  name wins, so when this card has already registered the alias, the original card's registration
  throws and its cards do not render. The browser console then shows one warning naming both cards
  (a failure inside a cross-origin script can be reported as an opaque `Script error` without the
  element name, and then only the fact that the cards do not render remains); remove one of the two
  resources and reload, or give this card `type: custom:better-xiaomi-vacuum-map-card`.
- A card resource added in a running session (Home Assistant's resource editor) is not seen by the
  bundle that has already run. Reload the page after adding the original card; if this card
  registered the alias first, the console warning above appears.
- Both cards listen for the same `ll-custom` event detail (`xiaomi_vacuum_map_card`). This card acts
  on an action only when its `action_handler_id` matches, while the original card also acts when
  the key is missing, so an action without one can be taken by the wrong card. With both installed,
  set `action_handler_id` on every `fire-dom-event` action (see [Action handling](#action-handling)).

## Features

Features include:

- Map-based controls:
  - Zoned cleaning (manual and saved)
  - Going to target (manual and saved)
  - Room cleaning
  - Following path
  - Custom services
- Icon controls:
  - Conditional visibility
  - Customizable service calls
- Value tiles:
  - Customizable content
  - Conditional visibility
  - Customizable service calls
- General:
  - Multiple vacuums support
  - Multiple maps (camera/image) support
  - Fully customizable styling

## Main options

<table>
  <tr>
    <th>Key</th>
    <th>Type</th>
    <th>Required</th>
    <th>Default</th>
    <th>Description</th>
  </tr>
  <tr>
    <td><code>title</code></td>
    <td>string</td>
    <td>no</td>
    <td><i>empty</i></td>
    <td>Card's title</td>
  </tr>
  <tr>
    <td><code>layout</code></td>
    <td>string</td>
    <td>no</td>
    <td><code>vertical</code></td>
    <td>Arranges the map above the controls (<code>vertical</code>) or places the map and the mode, icon and tile controls side by side (<code>horizontal</code>). See <a href="#layout">layout</a></td>
  </tr>
  <tr>
    <td><code>language</code></td>
    <td>string</td>
    <td>no</td>
    <td><i>autodetected</i></td>
    <td>Overrides autodetected language (<a href="#translations">supported languages</a>)</td>
  </tr>
  <tr>
    <td><code>action_handler_id</code></td>
    <td>string</td>
    <td>no</td>
    <td>-</td>
    <td>Enables <a href="#action-handling">action handling</a></td>
  </tr>
  <tr>
    <td><code>additional_presets</code></td>
    <td>list</td>
    <td>no</td>
    <td><i>empty</i></td>
    <td>A list of additional <a href="#preset-options">presets</a> (e.g. with different map/vacuum)</td>
  </tr>
  <tr>
    <td><code>persist_map_view</code></td>
    <td>boolean</td>
    <td>no</td>
    <td><code>true</code></td>
    <td>Remembers zoom level and map position across page reloads, separately per card, per preset and per map id. The position follows the map, so a view reopened at another card width frames the same part of the map</td>
  </tr>
  <tr>
    <td><code>persist_map_lock</code></td>
    <td>boolean</td>
    <td>no</td>
    <td><code>true</code></td>
    <td>Remembers the state of the lock button together with the map view</td>
  </tr>
  <tr>
    <td><code>map_view_storage_key</code></td>
    <td>string</td>
    <td>no</td>
    <td><i>autogenerated</i></td>
    <td>Overrides the autogenerated storage key. The generated one includes the dashboard path, so the same card on two views keeps a view per view; set this to survive a dashboard rename, or to the same value on several cards to share one view between them. Cards that share a key also share their <code>map_view</code>, because a configured default is part of the generated key</td>
  </tr>
  <tr>
    <td><code>map_view</code></td>
    <td>object</td>
    <td>no</td>
    <td><i>neutral view</i></td>
    <td>View the map opens at when nothing is stored for it, and returns to when the map is reset. See <a href="#map-view-options">map view options</a></td>
  </tr>
  <tr>
    <td colspan="5" style="text-align: center">
      All values from <a href="#preset-options">preset options</a> section
    </td>
  </tr>
</table>

### Map view options

`map_view` is the card's starting view. A view stored by `persist_map_view` still wins over it; the
card uses the configured view only when nothing is stored for the current card, preset and map. The
map reset control (the centre-focus icon on the map) and the [`map_view.reset`](#action-handling)
action return to it.

The scale is applied around the centre of the map area, exactly like the zoom-in control, and `x`/`y`
are offsets from that centred view: `map_view: {scale: 2.5}` changes the zoom and keeps the map
centred at any card width, while `x: 40` moves it 40 layout pixels to the right of the centred
position. Rotation pivots on the same centre, so the offsets stay screen offsets at every angle.

| Key        | Type   | Required | Default        | Description                                                                                  |
|------------|--------|----------|----------------|----------------------------------------------------------------------------------------------|
| `scale`    | number | no       | `1`            | Zoom level, from `0.5` to `100` (`1` is the map fitted to the card)                          |
| `x`        | number | no       | `0`            | Horizontal offset in layout pixels from the centred view; `0` keeps the map horizontally centred |
| `y`        | number | no       | `0`            | Vertical offset in layout pixels from the centred view; `0` keeps the map vertically centred |
| `rotation` | number | no       | `map_rotation` | Angle in degrees the map opens at and returns to when reset                                  |

Every key is optional, and a key that is left out keeps its neutral value, so
`map_view: {scale: 2.5}` only changes the zoom. A value that is not a number, or a `scale` outside
`0.5`–`100` (the range the zoom controls offer), is reported as a configuration error instead of
being applied. The configured view applies to the whole card: each preset uses it where that preset
has no stored view. `map_view` is a main-configuration option only; a value inside
`additional_presets` is ignored. Unlike `persist_map_view`, which decides whether the user's view is
remembered, `map_view` also applies with `persist_map_view: false`.

The configured view is part of the stored view's lookup, so editing `map_view` starts from the new
default instead of keeping the view remembered for the old one.

The reset also works on a card the user is not looking at. A card in a hidden dashboard view or a
closed container has no map layout to centre the view against, so the reset waits: it is applied
once, with the first real layout, and the stored view is the centred default rather than the map's
top-left corner.

```yaml
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.roborock_s7
map_source:
  camera: camera.vacuum_map
calibration_source:
  camera: true
vacuum_platform: Xiaomi Miio
map_view: # optional starting view; a stored view wins over it
  scale: 2.5
  x: 40
  y: -20
  rotation: 90
```

### Layout

`layout: horizontal` puts the map beside the modes, icons and tiles instead of above them. The
controls column scrolls inside the card when it is taller than the map, and the card never grows
wider than its container. The default `vertical` arrangement is unchanged. An unknown string is
reported as a configuration error so a typo does not silently fall back. The option is YAML-only
for now — the visual editor does not expose it.

```yaml
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.roborock_s7
map_source:
  camera: camera.vacuum_map
calibration_source:
  camera: true
vacuum_platform: Xiaomi Miio
layout: horizontal
```

Below a **400 px card width** the card stacks: the map takes the full width and the modes, icons and
tiles follow it, instead of the clamped controls column squeezing the map and scrolling in a short
window. The breakpoint follows the card's own width, not the window, so a phone, a narrow sections
cell, a sidebar and a popup all get the stacked arrangement while a wide card in the same window
stays side by side. At exactly 400 px the card is still side by side.

In a sections view that is the narrowest span: a 12-column section is about 500 px wide, and the
card asks for `min_columns: 9`, so its narrowest cell is about 373 px and stacks. A cell shorter than
the stacked map and controls scrolls inside the card, like any vertical card in a fixed-height cell.

That scroll is the accepted cost of stacking on the narrowest span. The horizontal layout's default
cell is 6 rows (about 300 px), and if the map keeps its height the controls start below the cell's
fold, so reaching them needs a scroll inside the card. The alternative — squeezing both into one cell
— is the arrangement the 400 px breakpoint exists to avoid, so the default stays. Raise
`grid_options.rows` for that card to give the stacked controls their own room:

```yaml
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.roborock_s7
layout: horizontal
grid_options:
  rows: 9
```

In the sections view the card uses Home Assistant's default grid size for the vertical layout: 12
columns wide with `rows: "auto"`, so the cell fits the card's content as it always has. The
horizontal layout asks for a numeric starting height (6 rows) and `min_columns: 9`, because the
controls column needs 180–360 px beside the map. Side by side, a taller cell than the map is filled
by the controls column, so the space is not wasted below the map; once the card stacks (below a
400 px card width) the content keeps its natural height. A cell shorter than the content scrolls the
card rather than shrinking the map.

#### Resizing the card in a sections view

Home Assistant's sections
[`grid_options`](https://www.home-assistant.io/dashboards/sections/#resizing-cards) set the size of
one card without `card-mod`: drag the resize handle in edit mode, or write the same values in YAML.
Home Assistant merges them over the size the card asks for, and the card never adds a minimum or
maximum height, so the size you pick is the size you get. The 9-column minimum is the card's default
for the horizontal layout; add a smaller `min_columns` to go narrower.

```yaml
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.roborock_s7
map_source:
  camera: camera.vacuum_map
calibration_source:
  camera: true
layout: horizontal
grid_options:
  columns: 12
  rows: 10 # 56 px per row with an 8 px gap between rows; any count your map and controls need
```

A wide map fits the default six rows with space left over; a tall map (a hallway, or a whole floor
on a portrait image) needs more. Below about four rows only the title and a strip of the map are
visible, so a card that small is only useful as a placeholder. The same keys work for the vertical
layout, where the default is content-sized unless you set a height. A card in a cell shorter than
its content scrolls inside the cell; the map keeps its aspect ratio instead of being stretched.

## Preset options

| Key                        | Type    | Required        | Default         | Description                                                                                       |
|----------------------------|---------|-----------------|-----------------|---------------------------------------------------------------------------------------------------|
| `preset_name`              | string  | yes<sup>1</sup> | -               | Name of the preset                                                                                |
| `entity`                   | string  | yes             | -               | Vacuum entity                                                                                     |
| `map_source`               | string  | yes             | -               | Preset's [map source](#map-source-options)                                                        |
| `calibration_source`       | object  | yes<sup>2</sup> | -               | Preset's [calibration source](#calibration-source-options)                                        |
| `vacuum_platform`          | string  | no              | `default`       | Preset's [vacuum platform](platforms.md#supported-vacuum-platforms)                               |
| `map_locked`               | boolean | no              | `false`         | Default state of pan/zoom                                                                         |
| `two_finger_pan`           | string  | no              | `false`         | Enables two finger map panning                                                                    |
| `map_rotation`             | number  | no              | `0`             | Angle in degrees the map starts at, and returns to when the map is reset                          |
| `map_rotation_gesture`     | boolean | no              | `true`          | Enables rotating the map by twisting two fingers                                                  |
| `icons`                    | list    | no              | _autogenerated_ | Preset's [icons](#icon-list-entry-options)                                                        |
| `append_icons`             | boolean | no              | `false`         | Enables appending configured icons to autogenerated ones instead of replacing them                |
| `tiles`                    | list    | no              | _autogenerated_ | Preset's [tiles](#tile-list-entry-options)                                                        |
| `append_tiles`             | boolean | no              | `false`         | Enables appending configured tiles to autogenerated ones instead of replacing them                |
| `map_modes`                | list    | no              | _autogenerated_ | Preset's [map modes](#map-modes-options)                                                          |
| `activate`                 | object  | no              | -               | [Service call](#service-call-schema-options) that should be executed after clicking preset name   |
| `activate_on_switch`       | boolean | no              | `false`         | Enables executing `activate` service call after switching map preset                              |
| `conditions`               | list    | no              | -               | List of [conditions](#condition-options) that need to be (all of them) met for preset to be shown |
| `clean_selection_on_start` | boolean | no              | `true`          | Allows to disable cleaning selection on cleanup start                                             |
| `internal_variables`       | object  | no              | -               | Allows to specify default values for internal variables                                           |
| `live_path`                | boolean or object | no    | `false`         | Draws the robot and the path it drives, see [live path options](#live-path-options)               |

<sup>1</sup> If multiple presets are configured

<sup>2</sup> Not mandatory when used with a platform that support a default calibration

### Generated defaults

- **Card picker.** A card added from the card picker or as an entity suggestion picks the
  [platform](platforms.md#platform-detection) from the vacuum's integration, the map of the
  vacuum's own device (a calibrated camera or image), and `calibration_source: {camera: true}` when
  that map publishes calibration points. A platform with built-in calibration also accepts its own
  device's map without calibration points.
- **Map modes.** Without `map_modes` a preset gets the platform's default modes. When the camera
  publishes `rooms` metadata and none of those defaults is a room mode, the platform's room mode is
  added too, with its rooms read from the metadata. It is added only when that template sends a
  complete service call with the camera's room ids: platforms whose room template needs
  hand-written variables (al-one/hass-xiaomi-miot, Hypfer/Valetudo, rand256/ValetudoRE, Roomba)
  or takes room names instead of ids (Neato, BenjaminPaap/home-assistant-myneato,
  romedtino/simple-wyze-vac) keep their defaults. The mode is only ever added: a camera that is
  briefly unavailable and publishes no `rooms` keeps the mode, the selected mode and the selection.
  A configured `map_modes` list is never changed.
- **Invalid configuration.** A value of the wrong shape (a scalar where a list belongs, a `null`
  list item, an unknown or numeric `selection_type`) is reported by name in the card instead of
  breaking it. An empty key at any level (`repeats_type:`, `icons:`, `id:`, `map:`) counts as
  absent, exactly like a key that was not written, and a field cleared in the editor is the same; a
  required field left empty is reported by name. Values inside action `data`, `service_data` and
  `variables` are sent as written, and an explicit `label: ""` or `icon: ""` still means none.

## Map source options

| Key      | Type   | Required       | Default       | Description                                  |
|----------|--------|----------------|---------------|----------------------------------------------|
| `camera` | string | no<sup>1</sup> | -             | Entity id of map camera                      |
| `image`  | string | no<sup>1</sup> | -             | URL of map image                             |
| `crop`   | object | no             | _no cropping_ | Images [cropping options](#cropping-options) |
| `transparent_background` | boolean | no | `false` | Makes near-white map pixels transparent so the map blends into the card |
| `room_labels` | boolean | no | `true` | Set to `false` when the map image already shows room names (some integrations draw them into the map); the card then draws no room names of its own, and a selected room shows its badge alone (or keeps its icon in the selected colours when the room has an icon) |
| `room_outlines` | boolean or string | no | `true` | Controls when the card draws room outlines: `true` always draws them; `false` hides them when idle and shows them on hover (with a mouse or trackpad), when selected, part of a started run, or stale; `"selected"` hides idle and hover outlines, showing them only when selected, part of a started run, or stale; `"never"` never draws room outlines (even when selected or running), while rooms stay tappable, selected/running rooms keep their fill (`--map-card-room-outline-fill-color-selected`) and badged pill (or selected icon), and stale rooms keep their red warning outline. The outline colours are the `--map-card-room-outline-*` [CSS variables](css_variables.md) |

<sup>1</sup> Exactly one of `camera` or `image` must be provided

A static image works as a floorplan background: point `image` at a same-origin picture such as
`/local/floorplan.png` and add `transparent_background: true` to blend near-white areas into the
card. Transparency reads the image's pixels, so an image from another origin needs CORS headers or
the browser blocks the read and the option silently does nothing. Drawing a live robot path on
top of a static image is not supported (upstream #503 / #922 overlap here); the camera source is the
supported way to get a live map with paths.

For `ROOM` selections, the card can use room IDs and names from the camera's `rooms` attribute, then trace each room's colored region from the map image. Rooms may share a color (Valetudo and Dreame use a four-color palette), and their bounding boxes may interlock: two L-shaped rooms around a hallway each cover the other's floor in their bounds. When that happens the card follows the wall the map draws between the two fills: each room keeps its own floor, a cleaning path or a piece of furniture drawn over a room stays that room's, and the card falls back to the plain per-room trace wherever the pixels cannot tell the rooms apart. A tap on the robot, the charger, a room icon or a path drawn over a room selects that room. Manual room definitions remain available as a fallback when the camera does not provide room metadata or the map has no distinct room colors. If the rooms you selected are no longer on the camera map, the card marks them stale and refuses to run a selection that would send no room ids.

Cameras differ in what they publish: Xiaomi Cloud Map Extractor and Dreame report each room's `x0`/`y0`/`x1`/`y1` bounds, while the Valetudo camera integration also reports the room's own `outline`. Bounds are enough as long as the map draws a wall or a gap between two rooms of the same color; two same-coloured rooms whose fills touch with no drawn wall or gap cannot be told apart from the image alone, and a room drawn with its own outline is left to that outline rather than traced.

#### Cleaning order

Rooms are sent in the order you tap them. Only some integrations make the vacuum clean them in
that order, and the card numbers the selected rooms only on those: `Hypfer/Valetudo`,
`rand256/ValetudoRE` (segments) and `johnnyh1975/ha_roomba_plus`. On every other platform, and in
any mode with its own `service_call_schema`, the vacuum chooses its own route, so a selected room
shows a checkmark instead of a number. The [platform list](platforms.md#cleaning-order-per-platform)
gives the reason for each.

If your vacuum does follow the order sent (for example your own service call asks for it), set
`cleaning_order: true` on the ROOM map mode to show the numbers. The setting only controls the
numbers; it does not make a vacuum follow the order. `cleaning_order: false` shows checkmarks on
the platforms that number by default.

<a id="selected-room-label"></a>
#### Map labels

Every label on the map is drawn the same way, as a pill, in the style of the Xiaomi Home app: room
names, and the labels of predefined points and rectangles. Selecting adds a round badge to the
pill: a room's number in the cleaning order (or a checkmark, see above), and a checkmark for a
predefined point or rectangle. The pill stays where it is. A room with an icon and a visible name shows its icon next to its pill until it is selected, and the badged pill alone after (a room with no outline keeps its icon so it stays clickable). A room marked only by an icon (no label, or `room_labels: false`) keeps its icon when selected, recoloured with `--map-card-room-icon-color-selected` and `--map-card-room-icon-background-color-selected`, and shows the cleaning-order badge at the icon's corner when `cleaning_order` is on. A room with neither a name nor an icon shows the badge alone once selected. If your map image already shows room names, set
[`room_labels: false`](#map-source-options) on the map source to hide the card's copies, and if it already draws the walls,
[`room_outlines`](#map-source-options) lets you hide the room outlines: `false` hides them until a room is hovered or selected, `"selected"` shows them only when selected or part of a run, and `"never"` hides them completely while keeping the selected fill and badged pill (or selected icon). The rooms of a started run keep their pills. The pill
stays upright and the same size at any zoom and rotation, and taps go through it to the room.

The pill follows the theme: light with dark text in a light theme, dark with light text in a dark
theme, like the card it sits on. A soft shadow and a hairline edge set it apart from any room
colour and from a light or dark dashboard. The same colours apply to every label. Colours can be changed with CSS variables on the card
(for example with `card_mod`):

| Variable | Default | Colours |
|---|---|---|
| `--map-card-room-pill-background-color` | the theme's card background (`--card-background-color`) | the pill |
| `--map-card-room-pill-text-color` | the theme's text colour (`--primary-text-color`) | the room name and the hairline edge |
| `--map-card-room-pill-badge-color` | the card's primary colour (`--map-card-primary-color`, else `--slider-color`) | the badge |
| `--map-card-room-pill-badge-text-color` | white, on the badge colour deepened until white reads at 4.5:1 | the number or checkmark |

Whatever these are set to, the card keeps the text readable: when a name or a badge glyph would
contrast less than 4.5:1 with what is behind it (WCAG AA), it is drawn in black or white instead,
whichever reads better. The pill is always drawn opaque; a colour's transparency is ignored.

After **Start** the rooms stay highlighted exactly as they were selected, with their pills. The
selection stays on the map until Home Assistant answers the call; once the call is accepted the
run of the rooms that were sent takes its place, and if the call fails the selection stays so you
can retry. While the vacuum works through the run (`cleaning` or
`returning`) the rooms are locked, so the order cannot change mid-run. Before the vacuum reports
the start, which polling integrations do tens of seconds late, while it is paused, and while its
state is `unavailable` or `unknown`, the run stays on the map but a tap on a room starts a new
selection instead. The run ends as soon as the vacuum is done (docked, idle, error), after three
minutes if it never starts, and in any case after 12 hours.

The run belongs to the map it was started on. On a card with one preset per floor, each with its
own camera (or image), the run is shown and locks the rooms only on its own floor; on the other
floors the rooms stay free to select, even where they have the same ids, as the segments of
multi-floor Xiaomi, Roborock and Dreame maps do. Presets and cards that show the same camera share
the run. A camera that switches between the maps of a multi-map vacuum shows the run only while it
reports the same map id attribute (`map_id`, `map_name`, `selected_map`, `current_map`, `map_slot`,
`map_index`, `pmap_id`) as at **Start**; a camera that reports none of them counts as one map.

Only `cleaning` reported after **Start** counts as the start: a different state than the one
shown when you pressed it, or the same state changed again (a new `last_changed`). A polling
integration can still show the previous job, then report its trip home and dock, before it reports
the new rooms; a `returning` is never taken as the start, and neither is an update that only
changes attributes such as the battery level. If the vacuum was already cleaning and nothing
changes, the run counts as started after three minutes; a vacuum still `returning` or `paused`
then ignored the command, and the run ends. While the start is pending, the card's
icons read the vacuum as `cleaning`, so the play icon does not offer a full clean for a job that is
already starting, until the vacuum reports a new state such as `docked` or `error`.

The run is remembered per vacuum in the browser and shared by every card and tab of that browser,
so a reload keeps it. It is not shared between browsers or devices, and the card cannot tell that
another app replaced the job with a different one. A vacuum that docks to recharge mid-run ends
the run.

### Cropping options

| Key      | Type   | Required | Default | Description                                      |
|----------|--------|----------|---------|--------------------------------------------------|
| `top`    | number | no       | 0       | Image cropping value from the top (in pixels)    |
| `bottom` | number | no       | 0       | Image cropping value from the bottom (in pixels) |
| `left`   | number | no       | 0       | Image cropping value from the left (in pixels)   |
| `right`  | number | no       | 0       | Image cropping value from the right (in pixels)  |

## Live path options

`live_path` draws the robot's current position, with its heading, and the path it drove on the
current or last run, over the map: a camera map or a static floorplan picture
(`map_source.image`). `live_path: true` reads the map camera's `vacuum_position` attribute; a
mapping names another source.

| Key         | Type   | Required        | Default             | Description                                                                                  |
|-------------|--------|-----------------|---------------------|----------------------------------------------------------------------------------------------|
| `entity`    | string | yes<sup>1</sup> | `map_source.camera` | Entity whose attribute holds the robot's position                                            |
| `attribute` | string | no              | `vacuum_position`   | Attribute with the position as `{x, y, a}` or `[x, y, a]` in vacuum coordinates (`a`: heading) |

<sup>1</sup> When the map source is an `image`

```yaml
map_source:
  image: /local/floorplan.png
calibration_source:
  calibration_points: # three or four points that place the vacuum's coordinates on the picture
    - vacuum: { x: 25500, y: 25500 }
      map: { x: 466, y: 1889 }
    - vacuum: { x: 26500, y: 26500 }
      map: { x: 730, y: 1625 }
    - vacuum: { x: 25500, y: 26500 }
      map: { x: 466, y: 1625 }
live_path:
  entity: camera.vacuum_map
```

- **Where the position comes from.** Tasshack/dreame-vacuum and the Xiaomi Cloud Map Extractor
  publish `vacuum_position` on their map camera; any entity attribute in vacuum coordinates works.
  The position goes through the preset's calibration, so it must be in the same coordinates as the
  `vacuum` side of the calibration points.
- **How the path is built.** Integrations publish the position, not the path, so the card records
  each position it sees while the vacuum is `cleaning`, `paused` or `returning`. A new run starts a
  new path; after docking the last run's path stays until the next one. The path is kept in this
  browser, so a reload keeps it, but positions from while no dashboard showed the card are missing.
- **Look.** A semi-transparent line in the primary colour under the room labels and selections,
  the same width on screen at any zoom, with the robot as a dot and a chevron pointing where it
  heads. Colour, opacity and width are [CSS variables](css_variables.md) (`--map-card-live-path-*`).
- **Camera maps.** A camera image that already paints the path (Dreame) shows both; the card's line
  follows the camera's calibration on every frame, so it stays on the painted track while the image
  grows.

## Calibration source options

| Key                  | Type    | Required       | Default | Description                                                                                                                                                                                      |
|----------------------|---------|----------------|---------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `camera`             | boolean | no<sup>1</sup> | -       | Enables retrieving calibration from camera defined in `map_source` ([Xiaomi Cloud Map Extractor](https://github.com/PiotrMachowski/Home-Assistant-custom-components-Xiaomi-Cloud-Map-Extractor)) |
| `entity`             | string  | no<sup>1</sup> | -       | Entity with calibration returned as a state                                                                                                                                                      |
| `attribute`          | string  | no             | -       | Enables usage of a configured attribute instead of state of given entity                                                                                                                         |
| `calibration_points` | list    | no<sup>1</sup> | -       | List of 3 or 4 [calibration points](#calibration-points-options)                                                                                                                                 |
| `identity`           | boolean | no<sup>1</sup> | -       | Enables using image coordinates on map (e.g. when map is used just for rooms)                                                                                                                    |
| `platform`           | string  | no<sup>1</sup> | -       | Enables using a default calibration from a chosen platform (provided that it supports it)                                                                                                        |

<sup>1</sup> Exactly one of `camera`, `entity`, `calibration_points`, `identity` or `platform` must be provided

### Calibration points options

Each of calibration points must have a following structure:

```yaml
vacuum: # coordinates of a point in a vacuum coordinate system
  x: 25500
  y: 25500
map: # coordinates of a point in a map coordinate system (can be read using e.g. Paint or Gimp)
  x: 466
  y: 1889
```

[Manual calibration guide](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card/wiki) (upstream wiki)

## Icon list entry options

![icons image](media/icons.png)

| Key                 | Type    | Required | Default     | Description                                                                                                                                                               |
|---------------------|---------|----------|-------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `icon`              | string  | yes      | -           | An icon to be displayed ([mdi](https://materialdesignicons.com/))                                                                                                         |
| `icon_id`           | string  | no       | -           | Icon ID that can be used to override the configuration                                                                                                                    |
| `tap_action`        | action  | no       | _more-info_ | [Action](https://www.home-assistant.io/lovelace/actions) that will be triggered when an icon is tapped. </br>**Warning:** use `service_data` instead of `data`            |
| `hold_action`       | action  | no       | -           | [Action](https://www.home-assistant.io/lovelace/actions) that will be triggered when an icon is held and released. </br>**Warning:** use `service_data` instead of `data` |
| `double_tap_action` | action  | no       | -           | [Action](https://www.home-assistant.io/lovelace/actions) that will be triggered when an icon is double-tapped. </br>**Warning:** use `service_data` instead of `data`     |
| `conditions`        | list    | no       | -           | List of [conditions](#condition-options) that need to be (all of them) met for an icon to be shown                                                                        |
| `tooltip`           | string  | no       | -           | Tooltip to be displayed on hoover                                                                                                                                         |
| `order`             | number  | no       | -           | Used to sort the icons                                                                                                                                                    |
| `replace_config`    | boolean | no       | `false`     | Marks that this icon should override the config of an already existing icon with the same `icon_id`                                                                       |
| `menu_id`           | string  | no       | -           | Adds this icon to the menu with given ID                                                                                                                                  |
| `label`             | string  | no       | -           | Label that should be displayed in the menu                                                                                                                                |
| `variables`         | object  | no       | -           | Variables that should be passed to to service calls                                                                                                                       |
| `remove`            | boolean | no       | `false`     | Allows to remove specific pre-defined icon (when combined with `icon_id` and `replace_config: true`                                                                       |

### Menu icon additional options

| Key                          | Type   | Required | Default | Description                                                                   |
|------------------------------|--------|----------|---------|-------------------------------------------------------------------------------|
| `type`                       | string | yes      | -       | Has to be set to `menu`                                                       |
| `menu_id`                    | string | yes      | -       | A menu ID                                                                     |
| `entity`                     | string | yes      | -       | Entity that should be used to generate the menu                               |
| `current_value_attribute`    | string | no       | -       | Changes the source of the selected value to given attribute                   |
| `available_values_attribute` | string | yes      | -       | Configures an attribute that contains all available values for the menu       |
| `icon_mapping`               | object | no       | -       | A mapping of possible entity value -> icon that should be used for the value  |
| `value_translation_keys`     | object | no       | -       | A mapping of possible entity value -> label that should be used for the value |
| `tap_action`                 | object | no       | -       | Action that should enable a specific value                                    |

Examples:
* Menu based on the `select` entity
  ```yaml
  type: "menu"
  menu_id: "water_box_mode"
  icon_id: "water_box_mode"
  entity: "select.water_box_mode"
  available_values_attribute: "options"
  icon: "mdi:water"
  icon_mapping:
      off: "mdi:water-remove"
      mild: "mdi:water-minus"
      moderate: "mdi:water"
      intense: "mdi:water-plus"
      custom: "mdi:water-sync"
  tap_action:
      action: "call-service"
      service: "select.select_option"
      service_data:
          option: "[[value]]"
          entity_id: "[[entity_id]]"
  ```

## Tile list entry options

![tiles image](media/tiles.png)

| Key                 | Type    | Required | Default     | Description                                                                                                                                                              |
|---------------------|---------|----------|-------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `label`             | string  | no       | -           | Label of a tile                                                                                                                                                          |
| `entity`            | string  | no       | -           | Entity which should be shown on a tile                                                                                                                                   |
| `internal_variable` | string  | no       | -           | Internal variable which should be shown on a tile                                                                                                                        |
| `icon`              | string  | no       | -           | An icon to be displayed ([mdi](https://materialdesignicons.com/))                                                                                                        |
| `icon_source`       | string  | no       | -           | Source of an icon, e.g: `vacuum.xiaomi.attributes.battery_icon`                                                                                                          |
| `attribute`         | string  | no       | -           | Attribute that should be shown on a tile                                                                                                                                 |
| `multiplier`        | number  | no       | -           | Multiplier that should be used to calculate value shown on a tile<sup>1</sup>                                                                                            |
| `precision`         | number  | no       | -           | Precision that should be used to present value on a tile                                                                                                                 |
| `unit`              | string  | no       | -           | Unit to be used                                                                                                                                                          |
| `tap_action`        | action  | no       | _more-info_ | [Action](https://www.home-assistant.io/lovelace/actions) that will be triggered when a tile is tapped. </br>**Warning:** use `service_data` instead of `data`            |
| `hold_action`       | action  | no       | -           | [Action](https://www.home-assistant.io/lovelace/actions) that will be triggered when a tile is held and released. </br>**Warning:** use `service_data` instead of `data` |
| `double_tap_action` | action  | no       | -           | [Action](https://www.home-assistant.io/lovelace/actions) that will be triggered when a tile is double-tapped. </br>**Warning:** use `service_data` instead of `data`     |
| `conditions`        | list    | no       | -           | List of [conditions](#condition-options) that need to be (all of them) met for a tile to be shown                                                                        |
| `tooltip`           | string  | no       | -           | Tooltip to be displayed on hoover                                                                                                                                        |
| `translations`      | map     | no       | -           | Translations that should be applied to tile's value                                                                                                                      |
| `tile_id`           | string  | no       | -           | ID of an autogenerated tile that should be replaced with this one                                                                                                        |
| `order`             | number  | no       | -           | Used to sort the tiles                                                                                                                                                   |
| `replace_config`    | boolean | no       | `false`     | Marks that this tile should override the config of an already existing tile with the same `tile_id`                                                                      |
| `variables`         | object  | no       | -           | Variables that should be passed to to service calls                                                                                                                      |
| `remove`            | boolean | no       | `false`     | Allows to remove specific pre-defined tile (when combined with `icon_id` and `replace_config: true`                                                                      |

<sup>1</sup> With `multiplier` or `precision` the value is formatted as a number in the user's
number format (for example `1,5 h` with a decimal comma). A value that is not a number
(`unavailable`, `unknown`, a missing attribute or entity) is shown the way Home Assistant shows the
state, without `unit`. Autogenerated duration tiles convert from the unit the sensor reports, so a
sensor whose display unit was changed in Home Assistant still shows the right number.

## Condition options

| Key                 | Type   | Required       | Default | Description                                              |
|---------------------|--------|----------------|---------|----------------------------------------------------------|
| `entity`            | string | no             | -       | Entity ID                                                |
| `attribute`         | string | no             | -       | Attribute to use instead of entity state                 |
| `internal_variable` | string | no             | -       | Name of internal variable to use instead of entity state |
| `value`             | string | no<sup>1</sup> | -       | Entity state/attribute has to be equal to this value     |
| `value_not`         | string | no<sup>1</sup> | -       | Entity state/attribute has to be unequal to this value   |

<sup>1</sup> Exactly one of them has to be provided

## Map modes options

![map modes image](media/map_modes.png)

| Key                     | Type    | Required        | Default | Description                                                                          |
|-------------------------|---------|-----------------|---------|--------------------------------------------------------------------------------------|
| `template`              | string  | no<sup>1</sup>  | -       | Map mode template to be used ([supported templates](#supported-templates))           |
| `name`                  | string  | yes<sup>2</sup> | -       | Name of map mode                                                                     |
| `icon`                  | string  | yes<sup>2</sup> | -       | Icon of map mode ([mdi](https://materialdesignicons.com/))                           |
| `selection_type`        | string  | yes<sup>2</sup> | -       | Type of selection, one of [supported ones](#supported-selection-types)               |
| `service_call_schema`   | object or list | yes<sup>2</sup> | -       | [Service call schema](#service-call-schema-options) that should be used in this mode; a list of them is sent in order |
| `run_immediately`       | boolean | no              | `false` | Enables calling service immediately after choosing a selection                       |
| `coordinates_rounding`  | boolean | no              | `true`  | Enables coordinates rounding                                                         |
| `max_selections`        | integer | no              | 1       | Maximal number of selections                                                         |
| `id_type`               | string  | no              | -       | `number` or `string`: the type room ids are sent as in a `ROOM` mode<sup>4</sup>      |
| `cleaning_order`        | boolean | no              | template, else `false` | ROOM modes: number the selected rooms in the order they are sent. On by default only where the integration follows that order ([cleaning order](#cleaning-order)) |
| `repeats_type`          | string  | no              | `NONE`  | Type of repeats inclusion, one of [supported ones](#supported-repeats-types)         |
| `max_repeats`           | integer | no              | 1       | Maximal value of repeats                                                             |
| `variables`             | object  | no              | -       | Variables that should be passed to `service_call_schema`                             |
| `predefined_selections` | list    | no<sup>3</sup>  | -       |                                                                                      |
| `room_label_offsets`    | object  | no              | -       | ROOM modes: move room names on screen without configuring the rooms ([moving a room's label](#room-label-offsets)) |

> You can override any value from built-in template by providing it in your configuration

<sup>1</sup> Not required if all parameters with (<sup>2</sup>) are provided

<sup>2</sup> Required if `template` is not provided

<sup>3</sup> Required if `template` is not provided and `selection_type` is one
of: `PREDEFINED_RECTANGLE`, `PREDEFINED_POINT`. `ROOM` selections can be read automatically from the map camera's `rooms` attribute.

<sup>4</sup> Room ids read from the camera's `rooms` attribute are strings (`"13"`), configured ids are
usually numbers. `id_type: number` sends a numeric id as a number and `id_type: string` sends every id
as a string; without it the id is sent as it was read. Templates set it where the integration needs it.

### Supported templates

List of supported templates depends on selected [`vacuum_platform`](platforms.md#supported-vacuum-platforms)

### Supported selection types

Following selection types are supported at this moment:

A zone mode (`MANUAL_RECTANGLE`, `MANUAL_ROTATABLE_RECTANGLE`) opens with one zone on the map, ready to
drag, resize and run. The `+` control adds further zones, up to the mode's `max_selections`, and each
zone's `×` deletes it. The zone is placed again on every fresh selection: opening the mode, switching
the preset, the `selection.clear` action and a run with `clean_selection_on_start` (the default). A
deleted zone stays deleted until then.

- `MANUAL_RECTANGLE`: Free-drawn rectangular zones on the map
  <details>
  <summary>Example video</summary>

  https://user-images.githubusercontent.com/6118709/141666913-d95f082d-f5bf-4ab5-a478-ba44effe6f34.mp4

  </details>
- `MANUAL_ROTATABLE_RECTANGLE`: Free-drawn zones like `MANUAL_RECTANGLE`, with a rotate handle on
  the corner next to the description. A drag of the handle turns the zone around its centre, in whole
  degrees, snapping onto multiples of 45° within 3°. Each zone is sent as its four corners,
  `[x1, y1, x2, y2, x3, y3, x4, y4]`: the corners `(min x, max y) (min x, min y) (max x, min y)
  (max x, max y)` of the unturned zone, each turned around its centre, so a zone that is not turned
  gives the corners of the same box `MANUAL_RECTANGLE` sends. Only vacuums that clean four arbitrary
  corners can use it; the Viomi templates offer it as `vacuum_clean_zone_rotatable`
  ([platforms](platforms.md#rotated-zones-per-platform)).
- `PREDEFINED_RECTANGLE`: Rectangular zones that can be selected on the map from `predefined_selections`
  <details>
  <summary>Example video</summary>

  https://user-images.githubusercontent.com/6118709/141666920-492a000c-9a78-4c20-b4f5-9343928140c7.mp4

  </details>
- `MANUAL_POINT`: Point selected by clicking in an arbitrary place on the map
  <details>
  <summary>Example video</summary>

  https://user-images.githubusercontent.com/6118709/141666921-2f3d66da-6ffc-492a-8439-625da97651bd.mp4

  </details>
- `PREDEFINED_POINT`: Point selected on the map from `predefined_selections`
  <details>
  <summary>Example video</summary>

  https://user-images.githubusercontent.com/6118709/141666923-965679e9-25fb-44cd-be08-fc63e5c85ce0.mp4

  </details>
- `ROOM`: Identifier-based selection. When the map camera exposes room metadata and the map uses distinct solid room colors, the card can detect each colored area, draw its outline, and use the room name from camera metadata. If color detection is unavailable, configured room selections are used.
  <details>
  <summary>Example video</summary>

  https://user-images.githubusercontent.com/6118709/141666925-34b01cde-82ff-447b-aecc-e9ced402b1ed.mp4

  </details>
- `MANUAL_PATH`: Path selected by clicking on the map
  <details>
  <summary>Example video</summary>

  https://user-images.githubusercontent.com/6118709/141666931-48d1717f-96d0-461d-84f4-788c071f3a78.mp4

  </details>

### Service call schema options

| Key                         | Type    | Required | Default | Description                                          |
|-----------------------------|---------|----------|---------|------------------------------------------------------|
| `service`                   | string  | yes      | -       | Service that should be called in a given mode        |
| `service_data`              | object  | no       | -       | Data that should be passed to service call           |
| `target`                    | object  | no       | -       | Target that should be passed to service call         |
| `evaluate_data_as_template` | boolean | no       | `false` | Enables support for jinja templates in service calls |  

`service_call_schema` can also be a list of these. A run then sends each call in order, every one
filled from the same selection, and the next is sent only after Home Assistant accepted the one
before; a refused call stops the rest. A Viomi zone clean is three raw commands, for example:

```yaml
service_call_schema:
  - service: vacuum.send_command
    service_data: { entity_id: "[[entity_id]]", command: set_uploadmap, params: [1] }
  - service: vacuum.send_command
    service_data: { entity_id: "[[entity_id]]", command: set_zone, params: ... }
  - service: vacuum.send_command
    service_data: { entity_id: "[[entity_id]]", command: set_mode, params: [3, 1] }
```

It is possible to use several built-in placeholders in `service_data` section. They will be replaced by:

- `[[entity_id]]`: `entity_id` defined in preset's config
- `[[selection]]`: selection made on the map (zone, point or path)
- `[[selection_size]]`: number of selections made on the map
- `[[selection_unwrapped]]`: the same as `[[selection]]`, but passed as string unwrapped from brackets
- `[[repeats]]`: selected number of repeats
- `[[point_x]]`: x coordinate of selected point (for `MANUAL_POINT` and `PREDEFINED_POINT` selection types, also with `INTERNAL` repeats)
- `[[point_y]]`: y coordinate of selected point (for `MANUAL_POINT` and `PREDEFINED_POINT` selection types, also with `INTERNAL` repeats)
- `[[variables]]`: a list of variables for all selections

It is possible to use any value from `variables` section (wrapped with double rectangular brackets):

```yaml
variables:
  test_variable: 123
service_call_schema:
  service: fake.service
  service_data:
    var: "[[test_variable]]"
```

It is possible to use following modifiers in `service_data` section:

- `|[[jsonify]]`: if value ends with this modifier it will be decoded as a JSON and attached to service call in
  unwrapped form
- `|[[jsonify_jinja]]`: behaves in the same way as `|[[jsonify]]`, but is executed after jinja templating

With `evaluate_data_as_template`, the whole `service_data` is rendered by Home Assistant as one
template. Write the Jinja code inside `{{ }}` and `{% %}` as you would in Home Assistant: a placeholder
such as `[[selection]]` can be used directly in it (`{{ [[selection]] | length }}`) or inside a quoted
string (`'[[selection]]' | from_json`), with string or number room ids. If Home Assistant reports a
template error, the card shows it and sends nothing.

### Supported repeats types

Following repeats types are supported at this moment:

- `NONE`: No repeats
- `INTERNAL`: Repeats number included in coordinates array (`[25500, 25000, 26500, 26500, 2]`)
- `EXTERNAL`: Repeats number used as a separate attribute in `service_call_schema`
- `REPEAT`: Repeats selection (repeats: `2`, selection: `[5,6]` => `[5,6,5,6]`)

### Predefined selection options

Format of data depends on selected `selection_type`:

* `PREDEFINED_RECTANGLE`

  | Key             | Type                    | Required | Default      | Description                                                                                                        |
  |-----------------|-------------------------|----------|--------------|--------------------------------------------------------------------------------------------------------------------|
  | `zones`         | list                    | yes      | -            | List of lists containing zone's coordinates in `[x,y,width,height]` format (e.g. `[[25500, 25000, 26500, 26500]]`) |
  | `icon`          | object                  | no       | -            | [Icon definition](#icon-options)                                                                                   |
  | `label`         | object                  | no       | -            | [Label definition](#label-options)                                                                                 |
  | `variables`     | object                  | no       | -            | Variables that should be passed to `service_call_schema`                                                           |
  | `default_state` | `selected`/`unselected` | no       | `unselected` | Default state of selection                                                                                         |
  | `state_entity`  | entity id               | no       | -            | Entity that should be used to store the state of selection                                                         |

  > See [this page](templates/setup.md#getting-coordinates) to check how to easily retrieve zone coordinates.

* `PREDEFINED_POINT`

  | Key             | Type                    | Required | Default      | Description                                                       |
  |-----------------|-------------------------|----------|--------------|-------------------------------------------------------------------|
  | `position`      | list                    | yes      | -            | Point's coordinates in `[x,y]` format (e.g. `[25500, 25000]`)     |
  | `icon`          | object                  | no       | -            | [Icon definition](#icon-options)                                  |
  | `label`         | object                  | no       | -            | [Label definition](#label-options)                                |
  | `variables`     | object                  | no       | -            | Variables that should be passed to `service_call_schema`          |
  | `default_state` | `selected`/`unselected` | no       | `unselected` | Default state of selection                                        |
  | `state_entity`  | entity id               | no       | -            | Entity that should be used to store the state of selection        |

  > See [this page](templates/setup.md#getting-coordinates) to check how to easily retrieve point coordinates.

* `ROOM`

 | Key             | Type                    | Required | Default      | Description                                                                                     |
 |-----------------|-------------------------|----------|--------------|-------------------------------------------------------------------------------------------------|
 | `id`            | string or number        | yes      | -            | Room's identifier: the vacuum's segment id, or a Home Assistant area id ([cleaning areas](#cleaning-home-assistant-areas)) |
 | `outline`       | list                    | no       | -            | List of points forming an outline of a room (e.g. `[[25500,25500],[26500,25500],[25500,26500]]` |
 | `icon`          | object                  | no       | -            | [Icon definition](#icon-options)                                                                |
 | `label`         | object                  | no       | -            | [Label definition](#label-options)                                                              |
 | `variables`     | object                  | no       | -            | Variables that should be passed to `service_call_schema`                                        |
 | `default_state` | `selected`/`unselected` | no       | `unselected` | Default state of selection                                                                      |
 | `state_entity`  | entity id               | no       | -            | Entity that should be used to store the state of selection (e.g. `switch.bathroom`)             |

  > See [this page](templates/setup.md#getting-coordinates) to check how to easily create outline.

  `predefined_selections` may be omitted when the map camera provides a `rooms` attribute. The card will use the names and identifiers from that attribute and, when the image has distinct room fill colors, detect the room shapes and centers from the image.

  <a id="room-label-offsets"></a>
  **Moving a room's label**

  A room the card places itself (read from the camera's `rooms` attribute, detected from the map
  colours, or an area drawn from the area mapping) has its name centred in the room. Two rooms can
  put their names on almost the same spot, for example a hallway wrapped around a kitchen, and one
  name then hides the other. `room_label_offsets` on the `ROOM` mode moves a room's name without
  configuring the room:

  ```yaml
  map_modes:
    - template: vacuum_clean_segment
      room_label_offsets:
        "17": { offset_x: -45, offset_y: -100 }
        "21": { offset_y: 40 }
  ```

  - The keys are the room ids the mode selects: the segment ids, or the area ids in a mode that
    cleans [Home Assistant areas](#cleaning-home-assistant-areas).
  - `offset_x` and `offset_y` are screen pixels, positive (right, down) or negative (left, up). They
    are added to the offset the card already gives the name (for example the step below a room's
    icon) and keep their size and direction at any zoom and rotation.
  - Only the name moves, and its badge once the room is selected. The room's outline, icon, where a
    tap selects it, and which rooms the mode offers stay as they are; the key configures no room, so
    an area mode keeps offering every mapped area.
  - An id the mode does not draw is ignored.

  A label's own `offset_x`/`offset_y` in `predefined_selections` keeps its meaning for a configured
  room. On a room whose outline the card detects from the map colours it is dropped, together with
  the configured label point it belongs to; use `room_label_offsets` there.

  <a id="cleaning-home-assistant-areas"></a>
  **Cleaning Home Assistant areas**

  Home Assistant's `vacuum.clean_area` cleans areas: it takes area ids and sends the robot the
  segments you assigned to each area in the vacuum's settings. A `ROOM` mode can use it with the area
  ids as the room ids:

  ```yaml
  map_modes:
    - name: Rooms
      icon: mdi:broom
      selection_type: ROOM
      max_selections: 10
      service_call_schema:
        service: vacuum.clean_area
        service_data:
          entity_id: "[[entity_id]]"
          cleaning_area_id: "[[selection]]"
      predefined_selections:
        - id: living_room
          icon: { name: mdi:sofa, x: 25300, y: 28000 }
        - id: kitchen
          icon: { name: mdi:silverware-variant, x: 24000, y: 28500 }
  ```

  The card decides what each configured id is on its own. An id that is an area in Home Assistant
  (Settings → Areas, the id in the area's URL) is an area id: it is not compared with the camera's
  room ids, and it is usable as long as the area exists. Every other id is a segment id and is
  checked against the camera's `rooms` metadata, as below. A mode whose ids are areas the camera
  does not publish shows only its configured rooms, because the camera's rooms are named by segment
  ids, which an area service does not take; tap a room's icon (or its configured `outline`) to
  select it. A mode with an id the camera does publish keeps the camera's rooms, even when that id
  is an area too (Roomba+ names its rooms `living_room`, `kitchen`, ...).

  <a id="area-outlines"></a>
  **Area outlines from Home Assistant's area mapping**

  Where the card can tell which of the camera's rooms each area covers, it draws every area with the
  outlines of those rooms and its name from Home Assistant, and a tap anywhere in one of those rooms
  selects the area. It reads the mapping you made in the vacuum's settings (Settings → Devices &
  services → the vacuum → Map areas), which Home Assistant keeps in the vacuum's entity registry
  entry, and follows a change of it without a page reload. The run still sends the area ids, and Home
  Assistant still turns them into segments, so the outlines decide only what is drawn and tapped,
  never what is cleaned.

  - An area that covers several rooms is drawn with all of them; a tap on any of them selects the
    whole area, and all of them are drawn selected.
  - A room in no area is not selectable in this mode.
  - A room's configured `icon` moves into the area's largest room, with the area's name below it
    (shown unless `map_source.room_labels` is `false`). A configured `label` keeps its text and
    offsets and moves with the icon. A configured `outline` is kept as it is, and the area is then
    drawn from it instead of the mapping.
  - The mode may leave out `predefined_selections` when its service is `vacuum.clean_area`: it then
    offers every mapped area that has a room on the map. A selected area that leaves the map (the
    vacuum moved to another floor, or the area was re-mapped) leaves the selection.
  - A mode that calls `vacuum.clean_area` never offers the camera's own rooms, even when every
    configured area is gone: their segment ids are no areas. The exception is a camera that names its
    rooms by area ids (a Roomba+ camera's slugs such as `living_room`): a configured id the camera
    publishes, or, without configured rooms, a camera room named by an area id, keeps the camera's
    rooms.
  - Selecting an area that has no segments in the mapping shows a warning before the run, because
    Home Assistant would not clean it (`areas_not_mapped`). The card still sends it. A mode that calls
    another service (a script) shows no such warning: the mapping is not what it cleans by.
  - Selected areas show a checkmark, not a number: Home Assistant keeps the order of the areas, but
    whether the vacuum follows it depends on the integration. Set `cleaning_order: true` to show
    numbers.

  The camera's room ids and Home Assistant's segment ids are joined by a rule for each vacuum
  integration. Only these are known; every other integration keeps the configured icons, without
  outlines:

  | Vacuum integration                   | Segment id in Home Assistant | Camera room id | Floor shown                                                       |
  |--------------------------------------|------------------------------|----------------|-------------------------------------------------------------------|
  | Roborock (core `roborock`)           | `0_16` (map flag, segment)   | `16`           | the vacuum's "Selected map" select                                |
  | Dreame (`dreame_vacuum`, Tasshack)   | `0_16` (map index, segment)  | `16`           | only rooms whose number no other map uses                         |
  | Valetudo over MQTT (core `mqtt`)     | `16`                         | `16`           | -                                                                 |

  On a vacuum with several maps whose rooms are numbered from the same start, the card draws a room
  only when it knows the room is on the map the camera shows; it does not guess:

  - With Roborock's "Selected map" select, only areas on the selected map are drawn. When it names a
    map Home Assistant has no segments for (a floor added after the areas were mapped), none are,
    until the areas are mapped again.
  - Without it, a room is drawn only when no other map has a room with the same number, judged from
    the segments Home Assistant last saw. A mapping on several maps saved without that segment list
    draws nothing.

  An id that is neither an area nor a room on the camera map is stale: a deleted area, or a segment
  a re-map renumbered. One exception follows from deciding by the id: an area whose id is also a
  segment id (an area named after a number, such as `16`) counts as an area, so a renumbered segment
  `16` is not reported while that area exists. The warning of a mode that calls `vacuum.clean_area`
  names areas as well, so an area's display name typed instead of its id is easy to spot.

### Selection lifetime

A selection changes only when you change it: a tap, switching mode or preset, the
`selection.clear` action, or starting a run with `clean_selection_on_start` (the default). Map and
camera refreshes, Home Assistant updates and setting the card configuration again keep the
selected items and their order, which is the cleaning order.

- An item whose room, zone or point disappears (from the camera `rooms` metadata, from an entity
  that supplies zones or points, or from the configuration) leaves the selection; the others keep
  their order.
- An item with a `state_entity` follows that entity. When the entity turns on outside the card, the
  item joins the end of the selection; when it turns off, the item leaves. The entity is the
  selection itself, so when it is `unavailable` the item leaves too and rejoins at the end when the
  entity comes back on (as in the original card).
- `default_state: selected` applies when an item first appears, when the configuration changes its
  `default_state`, and after the selection is cleared, not on every refresh: an item you deselected
  stays deselected.
- A source that is unavailable (the camera without `rooms` during a Home Assistant restart, or an
  unavailable entity that lists zones or points) is unknown, not empty: its selected items are
  hidden while it is away and come back in their place when it returns.
- `max_selections` holds on every refresh. The items you selected first keep their place; a
  `state_entity` item that turns on beyond the limit is not added (its entity stays on), and a
  configuration that lowers the limit keeps the first items. A `PREDEFINED_POINT` mode keeps one
  point, as a tap does.
- A configured room id that is neither a Home Assistant area nor in the camera `rooms` metadata is
  stale: the card names it in a warning, draws it stale and never sends it.
- A selected room whose id disappears from the camera `rooms` metadata (a re-map) can no longer be
  cleaned: the card leaves it out of the service call, draws it stale and, while it was the whole
  selection, names it in a warning and refuses the run instead of calling the service with an empty
  room list. The same warning covers rooms picked from the camera metadata in a mode without
  `predefined_selections`, which the stale configured-id warning cannot see. Selecting a room that
  is on the map again drops the stale mark, and while the whole selection is stale, a room whose id
  comes back in a later camera update returns to the selection in its place. A room that disappears
  while other selected rooms are still on the map is dropped from the selection, as before. A
  selection is never carried to a different camera.
- Setting the configuration again keeps the current preset and mode when they still exist.

### Icon options

| Key    | Type   | Required | Default | Description                                                       |
|--------|--------|----------|---------|-------------------------------------------------------------------|
| `name` | string | yes      | -       | An icon to be displayed ([mdi](https://materialdesignicons.com/)) |
| `x`    | number | yes      | -       | X coordinate of an icon (in vacuum's coordinate system)           |
| `y`    | number | yes      | -       | Y coordinate of an icon (in vacuum's coordinate system)           |

### Label options

| Key        | Type   | Required | Default | Description                                                       |
|------------|--------|----------|---------|-------------------------------------------------------------------|
| `text`     | string | yes      | -       | Text to be displayed                                              |
| `x`        | number | yes      | -       | X coordinate of a label (in vacuum's coordinate system)           |
| `y`        | number | yes      | -       | Y coordinate of a label (in vacuum's coordinate system)           |
| `offset_x` | number | no       | -       | Offset that should be applied to label in X direction (in pixels) |
| `offset_y` | number | no       | -       | Offset that should be applied to label in Y direction (in pixels) |

## Action handling

To enable handling actions you have to configure `action_handler_id` in [Main options](#main-options).
This card handles following actions:

- Starts cleaning
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: cleaning.start
  ```

- Set a value of internal variable
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: internal_variable.set
        data:
          variable: variable_1
          value: "some value"
  ```

- Selects next map mode
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: map_mode.next
  ```

- Selects previous map mode
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: map_mode.previous
  ```

- Selects a specific map mode
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: map_mode.set
        data:
          index: 2 
  ```

- Resets the map to its default view — the configured [`map_view`](#map-view-options), or the neutral
  view (scale `1`, no offset, `map_rotation`) when none is configured
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: map_view.reset
  ```

- Decrements a number of repeats
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: repeats.decrement
  ```

- Increments a number of repeats
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: repeats.increment
  ```

- Set a number of repeats
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: repeats.set
        data:
          value: 2
  ```

- Clears current selection
  ```yaml
    tap_action:
      action: fire-dom-event
      xiaomi_vacuum_map_card:
        action_handler_id: xiaomi_vacuum_map_card_id_1
        action: selection.clear
  ```

## FAQ

- **Make sure to check
  out the [upstream FAQ section in Discussions](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card/discussions/categories/faq),
  it contains a lot of useful information**

- **Does this card require rooted device?**

  No, it only utilizes features of Home Assistant.

- **How to create a map?**

  The easiest way is to
  use [Xiaomi Cloud Map Extractor](https://github.com/PiotrMachowski/Home-Assistant-custom-components-Xiaomi-Cloud-Map-Extractor),
  but you can use any image (e.g., a screenshot from Mi Home/FloleVac).

- **Can I use image that has a perspective distortion?**

  Yes, you just have to provide 4 calibration points.

## Migrating from upstream v1.x.x

<details>
<summary>Configuration with <code>map_image</code></summary>
<table>
<tr>
<th>Old config (<code>v1.x.x</code>)</th><th>New config (<code>v2.x.x)</code></th>
</tr>
<tr>
<td>
<pre>
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.xiaomi_vacuum
map_image: '/local/custom_lovelace/xiaomi_vacuum_map_card/map.png'
calibration_points:
  - vacuum:
      x: 25500
      y: 25500
    map:
      x: 466
      y: 1889
  - vacuum:
      x: 26500
      y: 26500
    map:
      x: 730
      y: 1625
  - vacuum:
      x: 25500
      y: 26500
    map:
      x: 466
      y: 1625
zones:
  - [[25500, 25500, 26500, 26500]]
  - [[24245, 25190, 27495, 27940], [27492, 26789, 28942, 27889]]
</pre>
</td>
<td>
<pre>
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.xiaomi_vacuum
map_source:
  image: '/local/custom_lovelace/xiaomi_vacuum_map_card/map.png'
calibration_source:
  calibration_points:
    - vacuum:
        x: 25500
        y: 25500
      map:
        x: 466
        y: 1889
    - vacuum:
        x: 26500
        y: 26500
      map:
        x: 730
        y: 1625
    - vacuum:
        x: 25500
        y: 26500
      map:
        x: 466
        y: 1625
map_modes:
  - template: vacuum_clean_zone
  - template: vacuum_goto
  - template: vacuum_clean_zone_predefined
    predefined_selections:
      - zones: [[25500, 25500, 26500, 26500]]
      - zones: [[24245, 25190, 27495, 27940], [27492, 26789, 28942, 27889]]
</pre>
</td>
</tr>
</table>
</details>
<br/>
<details>
<summary>Configuration with <code>map_camera</code></summary>
<table>
<tr>
<th>Old config (<code>v1.x.x</code>)</th><th>New config (<code>v2.x.x)</code></th>
</tr>
<tr>
<td>
<pre>
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.xiaomi_vacuum
map_camera: camera.xiaomi_cloud_map_extractor
camera_calibration: true
zones:
  - [[25500, 25500, 26500, 26500]]
  - [[24245, 25190, 27495, 27940], [27492, 26789, 28942, 27889]]
</pre>
</td>
<td>
<pre>
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.xiaomi_vacuum
map_source:
  camera: camera.xiaomi_cloud_map_extractor
calibration_source:
  camera: true
map_modes:
  - template: vacuum_clean_zone
  - template: vacuum_goto
  - template: vacuum_clean_zone_predefined
    predefined_selections:
      - zones: [[25500, 25500, 26500, 26500]]
      - zones: [[24245, 25190, 27495, 27940], [27492, 26789, 28942, 27889]]
</pre>
</td>
</tr>
</table>
</details>

## Translations

Currently, this card contains translations for following languages:
* `bg` - Bulgarian (Български)
* `ca` - Catalan (Català)
* `cs` - Czech (Čeština)
* `da` - Danish (Dansk)
* `de` - German (Deutsch)
* `el` - Greek (Ελληνικά)
* `en` - English
* `es` - Spanish (Español)
* `fi` - Finnish (Suomi)
* `fr` - French (Français)
* `he` - Hebrew (עברית)
* `hu` - Hungarian (Magyar)
* `is` - Icelandic (Íslenska)
* `it` - Italian (Italiano)
* `lv` - Latvian (Latviešu)
* `nb-NO` - Norwegian Bokmål (Norsk bokmål)
* `nl` - Dutch (Nederlands)
* `pl` - Polish (Polski)
* `pt` - Portuguese (Português)
* `pt-BR` - Brazilian Portuguese (Português Brasileiro)
* `ro` - Romanian (Română)
* `ru` - Russian (Русский)
* `sk` - Slovak (Slovenčina)
* `sv` - Swedish (Svenska)
* `tr` - Turkish (Türkçe)
* `uk` - Ukrainian (Українська)
* `zh` - Chinese (中文)
* `zh-Hant` - Traditional Chinese (正體中文)

[Adding a new language](../CONTRIBUTING.md#adding-new-translations)
