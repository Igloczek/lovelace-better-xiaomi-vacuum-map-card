# Visual regression harness

Playwright renders the **built** `dist/xiaomi-vacuum-map-card.js` in Chromium against the committed
synthetic fixture (`test/fixtures/synthetic/`) and compares screenshots. No Home Assistant frontend
is involved: `index.html` plus `harness.js` mount the card element with a mock `hass`, and
`server.cjs` serves the bundle, the fixture and the camera-proxy image path.

`npm test` (Vitest) does not run this suite. It runs in `.github/workflows/visual.yml` on
`workflow_dispatch` and on every push to a pull request that carries the `visual` label
(`opened`, `synchronize`, `reopened` and `labeled` events). Unlabelled pull requests skip the job.

## Scenarios

| Test | What it locks down |
| --- | --- |
| `overlay alignment at zoom 1 and rotation 0` | detected room outlines, labels and the map image agree at rest |
| `overlay alignment at zoom 1 and rotation 90` | rotation is applied once, to image and overlay together |
| `overlay alignment at zoom 2.5 and rotation 0` | `realScale` stays in untransformed layout pixels when zoomed |
| `overlay alignment at zoom 2.5 and rotation 90` | both at once, the case that historically drifted |
| `a configured map_view is the rendered starting view` | a configured default opens the card at its centred scale and offset, and a later user zoom still wins |
| `a configured map_view is centred at rotation 90` | rotation pivots on the content centre, so a scale-only default keeps the map centred and overlays aligned |
| `a stored view beats the configured default after a remount` | a real browser pan/zoom is written to the store and read back over `map_view` |
| `room hit-testing follows zoom 1/2.5 and rotation 0/90` | at each overlay zoom/rotation pair, taps near two corners of the framed room toggle it and taps on the visible background 5 image px outside it select nothing; the tap is mapped back to source-image pixels through the shared transform |
| `room hit-testing selects the clicked room at zoom 1` | clicking a room's colour selects that room; the selected room shows its pill with its number (the mode sets `cleaning_order: true`) and the others keep their plain label |
| `default vertical layout` | header, preset selector, map and controls stack vertically |
| `layout geometry at 360, 400 and 800 px` | vertical stacks the controls below the map; horizontal puts them beside it above the 400 px breakpoint and stacks them at 360 px |
| `horizontal layout at 400 px`, `... 800 px`, `... 1200 px` | side-by-side geometry at three widths (400 is the breakpoint, still side by side), map and controls inside the card, the controls column wrapping and scrolling instead of overflowing, one screenshot each |
| `horizontal layout stacks at 360 px` | the map fills the card, the controls follow it in normal flow (not the absolute scrolling column), nothing overflows sideways, one screenshot |
| `the stack follows the card width, not the window` | the same 360 px card stacks in a 1200 px window, 400 px stays side by side and 399 px stacks (the query is exclusive), and the room overlay follows the map across the breakpoint |
| `a long mode name ellipsizes inside the controls column at 500 px` | a 42-character mode name does not widen the dropdown or clip the mode icon: the controls column does not scroll sideways, the icon stays inside it, and the collapsed name is ellipsized |
| `horizontal layout adapts when the container is resized` | resizing the container to 1200 px widens the map and moves the controls, the room overlay is recalculated to the new scale, and resizing back restores the narrow geometry |
| `a sections-view grid cell makes the card fill its height: scroll when short, controls use a taller one` | the reflected `layout="grid"` hook makes the card fill a fixed cell and scroll inside it when shorter than the content, and a taller cell's extra height is used by the controls column instead of sitting below the map as dead space |
| `horizontal layout keeps room, mode and tile interactions` | room hit-testing, opening the mode dropdown and selecting a mode (the mode changes), a tile click and the map-before-controls DOM/focus order in the horizontal arrangement |

`paint.spec.ts` runs in Chromium **and WebKit** (the `webkit` project in `playwright.config.ts`).
WebKit, the engine of Safari and the Home Assistant iOS and macOS apps, can paint HTML in a
`foreignObject` away from its layout box, so a layout reading proves nothing there. For each label
pill (unselected, selected, its badge), room icon and predefined point icon and label, at zoom 1 and
2.5 and rotation 0 and 90, it screenshots the overlay's box, hides the overlay and screenshots the
box again; the two must differ. It takes no baselines, so the WebKit project needs none. On the
1.5.0 pill it fails in WebKit and passes in Chromium.

`apartment.spec.ts` runs in Chromium and WebKit on a realistic floor plan, the `camera.apartment_map`
camera that `harness.js` adds next to the synthetic one (`test/fixtures/apartment/`, regenerated by
`node test/fixtures/apartment/generate.cjs`): nine rooms sharing walls, L-, T- and stepped shapes, a
chamfered corner, two rooms smaller than their names, Polish names, a room the camera does not name,
same-coloured neighbours, furniture and a robot path. At rotation 0 and 90 every room is found and a
tap inside it, and on each side of a shared wall, selects that room; at the whole-plan zoom and at
2.5, unselected and with every room selected, no room border is painted over any label: the
outlines are drawn solid magenta for the check and no label's box may contain a magenta pixel (a
before/after comparison was flaky, because text and edge antialiasing can land a subpixel apart
between two paints). Hiding a label must still change its pixels (it is painted where it is laid
out). It takes no baselines.

`room-label-offsets.spec.ts` runs in Chromium and WebKit on the apartment plan, with no baselines.
The corridor's (13) and the storage room's (14) detected label points put their pills on top of each
other on the whole plan; `room_label_offsets` on the corridor must move its pill by exactly the
configured screen pixels at zoom 1 and 2.5 and rotation 0 and 90, clear of the storage pill, painted
at its new box (hiding it changes those pixels) and gone from the old one, selected or not. A
`unit: map` nudge must keep the pill at the same fraction of the map image at card widths 400 and
700 (a `px` one does not), and move exactly as an image point does at zoom 1 and 2.5 and rotation 0
and 90, painted at its new box.

`default-zone.spec.ts` also runs in Chromium and WebKit, with no baselines. For `MANUAL_RECTANGLE` and
`MANUAL_ROTATABLE_RECTANGLE`, at rotation 0 and 90, the zone mode opens with one zone inside the map
and painted there (its pixels change when it is hidden); real mouse input then moves and resizes it,
`+` adds a second zone and the delete control removes one.

`map-view-robustness.spec.ts` asserts geometry only — no screenshots — so it also runs on a
developer machine. It reads the map point in the middle of the viewport from the rendered
transform, and the living room's outline against the room's place in the rendered image:

| Test group | What it locks down |
| --- | --- |
| `persisted map view across card widths` | a view stored at 800 px reopens on the same map point at 400 px (rotation 0 and 90), and resizing a zoomed card keeps that point in view and stores the rescaled view |
| `camera image reloads` | three snapshots while zoomed and rotated keep the view, `realScale` and the overlay; a camera image that doubles in size keeps the overlay on its room |
| `re-attach` | a card removed and re-added during its delayed work and a snapshot load keeps its view, overlay and no lingering transition |
| `touch gestures` | real CDP touch input: a two-finger twist rotates, stays aligned, does not select the room under the fingers and is remembered; a twist near 90° snaps; a locked map ignores pans and twists; `two_finger_pan` pans only with two fingers; a one-finger tap still selects a room |
| `map appearance` | `transparent_background` clears the white background in a dark theme, keeps room colours and detection, and labels stay light with a dark outline |
| `horizontal layout at phone widths` | at 320, 360 and 390 px the card does not overflow sideways and stacks the map above the full-width controls; at 412 px it stays side by side with the map right of the card's share and the controls beside it |
| `horizontal layout in a parent that sizes the card from its content` | in an inline-block parent, a flex row that centres the card and a `fit-content` wrapper the horizontal card keeps a real width (not the 0 px inline-size containment gives it), stays two columns and keeps its room overlay aligned |
| `cards mounted while hidden` | a card created inside a `display: none` container applies its stored view and base scale once shown, with no further `hass` update |
| `map lock persistence` | the lock and the locked view survive a reload; `persist_map_lock: false` keeps the view but not the lock |

The horizontal scenarios mount a fixture with three modes, four icons and eight tiles so the
clamped controls column has to wrap and scroll. `#card-root` is 400 px wide by default, so each
scenario sets the root width explicitly; the vertical baseline keeps the default width and is
unchanged by B10. The resize scenario asserts the room overlay against the CSS-scaled image box as
well as the map/control boxes, so a stale `realScale` after a resize fails the geometry instead of
only the screenshot.

The four overlay scenarios also assert numeric geometry, not just pixels: the framed room's
outline bounding box, in source-image pixels, must equal the rectangle in
`test/fixtures/synthetic/map.png` within 0.75 px (`LIVING_ROOM_IMAGE_RECT` in `visual.spec.ts`).
That check covers the detected outline and the calibration conversion, and it names the failing edge
so a broken outline is readable without comparing images. It is **not** the guard for scale or
transform alignment: the box is derived with `getBBox()` divided by `realScale`, which cancels a
base-scale error and ignores the zoom and rotation transforms, so those regressions are caught by
the screenshots. The tolerance is deliberately below one image pixel; a 1 layout-pixel drift can
therefore pass, and the measured values currently land exactly on the rectangle.

`room-pill.spec.ts` covers the selected-room pill. In the light and the dark theme, at zoom 1 and
2.5 and rotation 0 and 90, it asserts geometry and computed colours, not only pixels: the pill's
name and the badge glyph reach 4.5:1 against their backgrounds, the pill is light in the light
theme and dark in the dark one, it has a hairline edge and a drop shadow, ignores pointer events (a tap at
its centre reaches the room), stays upright and the same size within 1 px, and its pointer tip
lands on the room label's anchor within 1.5 px. Further cases
cover the checkmark when the order is off, a dark dashboard with `transparent_background`, and
`--map-card-room-pill-*` overrides that pair unreadable colours, which the card must correct. Each
geometry case also takes a screenshot (`room-pill-<theme>-zoom-<z>-rotation-<r>.png`,
`room-pill-<theme>-checkmark.png`, `room-pill-dark-transparent.png`).

`live-path.spec.ts` covers the live path overlay (`live_path`) and runs in WebKit too, with
`paint.spec.ts`: WebKit is the engine of the Home Assistant macOS app, and it has painted map overlays away
from their layout boxes. It reads no overlay box: at zoom 1 and 2.5 × rotation 0 and 90 it computes
the screen point of each driven position from the map image's rectangle and the calibration, and
asserts the screenshot shows the path's and the robot's colours there, nothing in the path's colour
off the path, the path kept after docking and gone when the next run starts.

`stale-marker.spec.ts` covers the stale-room `!` marker, which a selected room's pill shares a point
with. It hands the card the label font the way a theme may - `12px`, `1.4rem`, `2em`,
`calc(10px + 1vw)` and `40px` - and asserts that the marker's rendered size is 1.4 x the font the
pill resolved, so no unit is parsed. A theme change is made without `requestUpdate()` (the test
counts the renders) and must still move and resize the marker. Across zoom 0.5-4 and rotation
0/90/180/270 it asserts that the marker's box never intersects the pill's name box, that it is drawn
and not clipped by the map, that it is clear of the whole pill wherever the room has the space for
it, and that it is inside the room's outline polygon - sampled with `isPointInFill` - wherever the
room has the space above the name; a 100 px square room, a room at the image's top edge and an
L-shaped room whose notch sits above the label point cover the rooms a bounding box would get wrong.
Where the room is shorter than that footprint the test asserts the marker is painted above the pill
it overlaps instead, and the name box is checked in every one of those cases.

Run the assertions on any machine without the baselines with `npx playwright test --ignore-snapshots`.
The server listens on `VISUAL_PORT` (default 4173); set it when another checkout's harness server
already holds the port, or `reuseExistingServer` tests that checkout's bundle instead of yours.

## Baselines

The PNGs in `__screenshots__/` were generated in `mcr.microsoft.com/playwright:v1.65.0-jammy`, the
image CI runs in. Everything — dependency install, bundle build and test run — must happen **inside
that image**. Running the tests on the host uses the host's Chromium, and running only the test step
in the container against a host `npm ci`/`npm run build` still renders with a different browser and
font stack than CI.

Regenerate from the repository root:

```sh
docker run --rm --platform linux/amd64 \
    -v "$PWD":/work \
    -w /work \
    -e HOME=/tmp \
    --user "$(id -u):$(id -g)" \
    mcr.microsoft.com/playwright:v1.65.0-jammy \
    bash -lc 'npm ci && npm run build && npx playwright test --update-snapshots'
```

Then run the same command without `--update-snapshots` to prove the new baselines are stable. A
baseline generated on another platform will make the job permanently red. Every `--update-snapshots`
commit needs a sentence in the pull request explaining what changed in the image.

- **Apple Silicon:** `--platform linux/amd64` is required when generating. Without it Docker pulls
  the arm64 image, whose font rasterisation differs, and the amd64 CI job fails on the new baseline.
- **Ownership:** `--user "$(id -u):$(id -g)"` with `-e HOME=/tmp` makes `node_modules`, `dist` and
  the reports owned by you, like CI's `--user 1001`. Without it the container runs as root and
  leaves root-owned files in the checkout, which needs a `sudo chown -R` to clean up. The container
  user does not need to own `/ms-playwright`: the image's browsers are readable by every user.
- **Version bump:** bumping `@playwright/test` means bumping the image tag and `PLAYWRIGHT_VERSION`
  in `.github/workflows/visual.yml` and regenerating **every** baseline in the new image. The
  workflow deliberately has no `playwright install` step, so a version mismatch fails loudly
  (`Executable doesn't exist`, or the explicit guard step) instead of silently downloading a
  different Chromium into the old image and comparing against older baselines.

Threshold is `maxDiffPixelRatio: 0.001` with `animations: "disabled"` and `caret: "hide"`; see
`playwright.config.ts`.
