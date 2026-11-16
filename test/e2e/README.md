# End-to-end suite (real Home Assistant)

These tests drive a real Home Assistant instance in Docker, install the card the way a user does,
and exercise the behaviours the mock harness cannot prove. A release is published only after this
suite passes against the release candidate; screenshots are written to the gitignored
`test/e2e/artifacts/`.

## What it covers

| Spec | What it proves |
|---|---|
| `render.spec.ts` | The card renders from the installed Lovelace resource against a real camera entity. |
| `editor.spec.ts` | The visual editor opens in edit mode on a card whose ROOM mode starts empty; the Title field is the element the frontend provides and real keyboard typing reaches Home Assistant's edit-dialog config; **Generate rooms config** is the only way the room ids appear, and it does. The four switch labels are visible even though this frontend no longer defines `ha-formfield`. The entity, vacuum-platform and camera pickers each show the configured value and changing one reaches the dialog config. |
| `element-names.spec.ts` | The fork renders from `custom:better-xiaomi-vacuum-map-card`; `custom:xiaomi-vacuum-map-card` renders through the compatibility alias while the upstream bundle is absent, and is defined within half the fork's grace period after the fork's bundle loads, so the fork does not wait on itself; with the fork served from the pre-rename `/local/community/lovelace-xiaomi-vacuum-map-card/` path (the real Marketplace layout) the old type still renders and the stored view migrates; a dead resource row at that path, left by an upgrade, does not stop the alias or cost the grace period. With upstream's released bundle (v2.4.1, pinned and sha256-checked by `fetch-upstream.cjs`) installed in the HACS folder and as a manual `/local/xiaomi-vacuum-map-card.js`, with the fork running first and with upstream running first (forced: the second bundle's response is held until the first has run, and the order the browser ran them in is asserted), both cards render, neither shows Home Assistant's error card, the console shows no define error and no fork warning, the fork's own card is the fork's class (its editor is `better-xiaomi-vacuum-map-card-editor`), `custom:xiaomi-vacuum-map-card` is upstream's class, and the upstream card's stored view and run stay in its own keys. The same holds with this card served from the pre-rename path next to a manual upstream install. Not covered: a bundle that defines the element late, after it has loaded (a wrapper or a renamed build), because the pinned upstream defines it as soon as it runs. The upstream bundle is downloaded into the gitignored `test/e2e/.cache/`, never committed. |
| `map-view.spec.ts` | `map_view` opens at the configured view, a real wheel gesture changes scale and offsets, the reset control returns to the default, and the view persists across reloads. A reset fired while the card is hidden (no map layout) is not applied or stored against zero size: it applies the centred default once the card is shown and stores that. |
| `layout.spec.ts` | `layout: horizontal` places the map beside the controls in a real **sections** view, a long mode name ellipsizes inside the column, and changing the card's grid options (what the resize handle causes) resizes the card: a 6-column override stops at the card's 9-column floor, a user `min_columns` goes narrower, and per-card `rows` overrides render exactly at 12 and 9 columns for a wide (4:1) and a tall (1:4) map, including two rows below the card's old floor and a tall map that only fits at a larger size. Below a 400 px card width the card stacks the map above the full-width controls: the narrowest sections span (9 of 12 columns) and a 390 px phone stack, the room outline still sits on the map, a tap selects the room, the card scrolls to its controls, and a narrow window with a wide card stays side by side. The vertical layout stays stacked. |
| `zoom-rotation.spec.ts` | At zoom 2.5 and rotation 90, the painted room colour's screen box must match the outline's screen box within 4 px in all four directions (set `E2E_OVERLAY_SHIFT="20,0"` to prove the check fails on a shifted overlay), and clicking each outline selects that room. |
| `view-switch-resize.spec.ts` | A zoomed map in the sections view keeps the same map point in view and its camera snapshot after switching to another view and back, and after the window narrows to phone width. |
| `camera-rate.spec.ts` | Vacuum state changes cause no snapshot request inside the refresh window (at most the one interval refresh); a camera change causes exactly one; a hidden tab causes none; becoming visible again causes one. |
| `yaml-y-key.spec.ts` | A YAML dashboard with an unquoted `y:` key applies the offset, so Home Assistant 2026.11 does not reproduce the boolean-key bug (upstream #952). |
| `config-defaults.spec.ts` | Against the real `hass`: the card-picker stub is built from the real display registry and states, a preset without `map_modes` gains the room mode from the camera's `rooms`, and malformed YAML (`map_modes` as a string, an empty `id:` or `map:`) shows Home Assistant's own error card naming the field. The cards are created in the page and removed; no dashboard changes. |
| `selection-lifecycle.spec.ts` | Two rooms are tapped in a non-id order; turning the third room's `state_entity` (`input_boolean.e2e_clean_living_room`) on adds it at the end, a camera bump keeps the order, and turning the boolean off removes only that room, with the badges renumbered to match. |
| `service-call-contract.spec.ts` | Every platform template × map mode × string/number room id is built with the card's `MapMode` in Node and checked against the integration's service schema (`test/contract/service-contracts.ts`); modes with `evaluate_data_as_template` are rendered by this Home Assistant's `render_template`, the setup platforms' `persistent_notification.create` and every `vacuum.send_command` template are called for real (on the demo vacuum), and a template error rejects instead of hanging. |
| `interlock-rooms.spec.ts` | Two same-coloured L-shaped rooms whose bounding boxes interlock (a second fixture camera, `camera.interlocking_map`, `map_interlock.png`): at zoom 1 and 2.5 and rotation 0 and 90, a tap on each room's floor selects that room, including the arm of one room that lies inside the other's bounds. The camera then serves the same plan with a 2 px cleaning path down the kitchen's bar (`map_interlock_path.png`, `map_fixture.interlock_path`), which cuts off a piece lying inside both rooms' bounds: the piece and the path over it still select the kitchen. |
| `stale-rooms.spec.ts` | The fixture renumbers its segments while keeping the geometry: the card marks the configured rooms stale, warns with their ids, refuses to select them, and still selects the new live id. At phone width and in a narrow sections-view cell the warning wraps and shows every stale id instead of clipping after the first, and the stale marker of a room whose geometry a selected room still occupies never covers that room's pill name at label fonts 12, 32 and 40 (switched live, with no render), staying clear of the pill or painted above the edge it overlaps at zoom 1, 0.5 and 2.5. |
| `empty-room-selection.spec.ts` | In a template-only ROOM mode the selected room's id leaves the camera metadata: the room is kept on the map as stale, a warning names it, and the run button sends nothing to the fake vacuum (no command at all, not even an empty one) while showing the refusal toast; a live id of the new metadata selects again and the kept room's stale marker goes with the warning. |
| `run-lifecycle.spec.ts` | Against a fake vacuum that reports late, plans its own route, ignores a command while heading home, docks, fails a call and goes unavailable: the run is on the map from Start, the play icon is hidden while the start is pending, rooms lock only once the start is reported, the run ends when the vacuum docks, a failed call gives the selection back, `unavailable` keeps the run without locking, Start on an `unavailable` vacuum sends nothing, says so and keeps the selection for when it is back, a stale `returning` is not taken as the start, a second tab shows the run, a run is neither shown nor locking on a second preset's map with the same room ids (`e2e-run-floors`), and the card does not number rooms for a vacuum that ignores the order. |
| `live-path.spec.ts` | On the `e2e-live-path` dashboard, with `live_path` on a position entity Home Assistant publishes (`sensor.e2e_live_position`, posted through the REST API), the card follows the frontend's own `hass` updates: the robot is painted where the calibration puts it while the fake vacuum is docked, the path grows while it cleans, stays after docking and starts afresh on the next run. Proven by screenshot pixels located from the map image's rectangle. This spec also runs in the `webkit` project. Screenshot `live-path-cleaning.png`. |
| `room-pill.spec.ts` | In Home Assistant's default theme, light and dark (the browser's colour scheme), a selected room's label is a pill with its number and name, the name and the badge glyph reach 4.5:1 against the colours the theme supplies, and an unselected room shows the same pill without a badge. Every pill, selected and unselected, is painted inside its own layout box (hiding it changes those pixels). This spec also runs in the `webkit` project, the engine of Safari and the Home Assistant apps, where 1.5.0's pills were laid out correctly but painted off the map. Screenshots `17-room-pill-light.png` and `17-room-pill-dark.png`. |
| `rename-registry.spec.ts` | Renaming an entity, its device and its area through Home Assistant's websocket API updates a tile's label while the card stays on screen, and changing a sensor's registry icon updates a generated tile's icon, without a reload. |

## What it does not cover

- HACS itself: Home Assistant 2026.11 blocks the HACS custom integration and ships the Marketplace.
  The card's `hacs.json` metadata is unchanged and the HACS action in CI still validates it, but the
  HACS UI install can only be exercised on an older Home Assistant release.
- Hardware-specific behaviour: the Roborock status/battery templates need the integration's
  runtime registry, and vendor service semantics need the device. Those stay postponed.
- Real phone scrolling and a real drag-resize: the resize uses the grid options the handle writes,
  and the hidden-tab check overrides `document.hidden` rather than moving the page to a background
  window. Both are documented limitations of a headless run.

## Isolation between worktrees

Every script and spec resolves the instance through `support/harness.cjs` (the TypeScript specs load
the same module), so they agree on one instance. `E2E_HA_URL` wins for the URL; otherwise the URL is
`http://localhost:$E2E_HA_PORT` (default `8123`). The container and the compose project come from
these rules, in order:

| Environment set | Container | Compose project |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | as below | `COMPOSE_PROJECT_NAME` |
| `E2E_CONTAINER=C` | `C` | `C` |
| only a custom port (`E2E_HA_PORT`, or the port of `E2E_HA_URL`) | `xvmc-e2e-ha-<port>` | `xvmc-e2e-<port>` |
| nothing, or the default port `8123` | `xvmc-e2e-ha` | compose's default (`e2e`) |

The rule: **a checkout that runs on its own port derives its own container and project from it**,
so `test:e2e:fresh`'s `compose down` and `connect-github.cjs --restart` can never stop or restart the
default instance another worktree is using. Two checkouts must not share a port, a container or a
project; set `E2E_HA_PORT` (and, for an explicit name, `E2E_CONTAINER` and `COMPOSE_PROJECT_NAME`).
A manual `docker compose -f test/e2e/compose.yaml` reads the same variables and uses the default
names unless they are exported too, so prefer the scripts.

## Stale state and sessions

`test/e2e/ha/config/.storage` and `test/e2e/.auth/token.json` are gitignored and survive a branch
switch or a recreated container. A saved session that no longer matches the instance used to leave
every spec on the login page until its own timeout.

`ensureSession` (used by `setup.cjs` and by global setup) resolves the session in this order:

1. the saved **refresh token** is exchanged at the instance, as the frontend does, and the new access
   token is written back to `token.json`;
2. if that is refused, the saved **access token** is checked against `GET /api/`;
3. if both are refused, the file is dropped and the session is re-created with the e2e credentials:
   an instance that is not yet onboarded gets its owner created, an onboarded one signs in. Credentials
   the instance refuses fail with the command that rebuilds it.

The websocket helpers the specs use (`freshAccessToken`) run steps 1 and 2 only: they never create or
replace a session, so a rejected session fails the test run with the reset command.

Global setup also fails the run, with the rebuild command, when:

- the instance has no e2e dashboards or no card resource (a recreated instance);
- the bundle Home Assistant serves at the card's resource URL is not byte-identical to `dist/`
  (SHA-256 compared over HTTP), which is what a run without `install-local-build.cjs` looks like: the
  Marketplace release would otherwise be tested in place of this checkout.

`npm run test:e2e:fresh` does the whole documented sequence from a clean state: reset the ignored
runtime files, recreate the container, wait for `/api/`, onboard, connect Marketplace, install from
the repository, build and install the branch bundle, then run Playwright. It then tears the instance
down, pass or fail; pass `--keep` to leave it running to inspect a failure or rerun single specs with
`npm run test:e2e`, and stop it with `npm run e2e:down` (same environment) when done.

## Leaving nothing running

An instance outlives the agent and the worktree that started it: containers left by deleted
worktrees used to run for days, logging errors against a missing bind mount and holding their ports.

- `npm run test:e2e:fresh` tears down after itself unless `--keep` is passed.
- `npm run e2e:down` stops this checkout's instance (it resolves the same variables as every script).
- `npm run e2e:prune` removes harness containers (label `xvmc.harness`, from this compose file and the
  demo-video one) whose worktree no longer exists, with their networks. It never touches an instance
  whose worktree is still there; `--all` removes those too, `--dry-run` lists what it would remove.

Before handing work back, an agent stops every instance it started and runs `npm run e2e:prune`.

## Install path

Home Assistant 2026.11 ships the core **marketplace** integration and blocks the `hacs` custom
integration (`loader.py`: built into Home Assistant as the Marketplace); upgrading migrates an
existing HACS install. `marketplace-install.cjs` therefore installs from the repository URL through
Marketplace, and `install-local-build.cjs` then overlays the branch build so the behaviour specs test
the pull request rather than the last release. It copies `dist/xiaomi-vacuum-map-card.js` over the
installed file, removes the installer's stale `.gz`/`.br` siblings (Home Assistant would serve them
instead), checks the copy's SHA-256 and gives the resource a branch cache-buster. Global setup then
verifies the bytes Home Assistant actually serves, so the overlay cannot be skipped silently.

## Running it

```sh
# from a clean tree, or after switching branches: the whole sequence, one command
E2E_CONTAINER=xvmc-e2e-harness E2E_HA_PORT=8162 COMPOSE_PROJECT_NAME=xvmc-harness \
  npm run test:e2e:fresh

# keep the instance to inspect it or rerun specs, then stop it
E2E_CONTAINER=xvmc-e2e-harness E2E_HA_PORT=8162 COMPOSE_PROJECT_NAME=xvmc-harness \
  npm run test:e2e:fresh -- --keep
E2E_CONTAINER=xvmc-e2e-harness E2E_HA_PORT=8162 COMPOSE_PROJECT_NAME=xvmc-harness \
  npm run e2e:down
```

`test:e2e:fresh` also accepts `--no-build` (reuse `dist/`) and Playwright arguments after `--`. It
runs:

```sh
docker compose -f test/e2e/compose.yaml down --remove-orphans
git clean -fdX test/e2e/ha/config test/e2e/.auth test/e2e/artifacts
docker compose -f test/e2e/compose.yaml up -d                 # wait for /api/ to answer 401
node test/e2e/setup.cjs                                       # onboarding + storage dashboards
node test/e2e/connect-github.cjs --restart                    # Marketplace GitHub token
node test/e2e/marketplace-install.cjs                         # install from the repository URL
npm run build && node test/e2e/install-local-build.cjs        # put this checkout's build in front
node test/e2e/fetch-upstream.cjs                              # pinned upstream for the side-by-side spec
npm run test:e2e
docker compose -f test/e2e/compose.yaml down --remove-orphans  # unless --keep
```

The manual steps below do the same thing and remain useful for a single step; they honour the same
`E2E_CONTAINER`, `E2E_HA_PORT`, `E2E_HA_URL` and `COMPOSE_PROJECT_NAME`:

```sh
npm run build
docker compose -f test/e2e/compose.yaml up -d      # Home Assistant 2026.11.0 on $E2E_HA_PORT
node test/e2e/setup.cjs                            # onboarding + storage dashboards
node test/e2e/connect-github.cjs --restart         # Marketplace GitHub token (GITHUB_TOKEN or gh auth)
node test/e2e/marketplace-install.cjs              # install from the repository URL (proves the path)
node test/e2e/install-local-build.cjs              # put this checkout's build in front of the specs
node test/e2e/fetch-upstream.cjs                   # pinned upstream release for the side-by-side spec
npm run test:e2e
```

Screenshots are written to `test/e2e/artifacts/` (gitignored); attach the relevant ones to a pull
request or release when a behaviour changes.

`fetch-upstream.cjs` pins the upstream release (`v2.4.1`) and its sha256, caches it under the
gitignored `test/e2e/.cache/`, and copies it into the instance's `www/` at both locations a real
install leaves it: the historical HACS folder (`www/community/lovelace-xiaomi-vacuum-map-card/`) and
a manual `www/xiaomi-vacuum-map-card.js`. Home Assistant 2026.11 blocks HACS and no longer serves
the `/hacsfiles/` prefix HACS registered, so the HACS folder is loaded from its
`/local/community/<repository>/` URL — the same URL the Marketplace migration writes. The spec
verifies the cached digest too, so a replaced release asset fails loudly instead of testing another
build. Use `node test/e2e/fetch-upstream.cjs --refresh` after changing the pin.

## Fixture camera

`test/e2e/ha/config/custom_components/map_fixture` is a test-only integration: it serves the
committed synthetic maps through `/api/map_fixture/image`, counts every request, exposes the room
metadata the card reads, and offers `map_fixture.bump` (a new map, like an integration would push)
and `map_fixture.set_image`. It is never part of the released card. `camera.vacuum_map` serves
`map_fixture.png` and is the camera the bump/remap services drive; `camera.interlocking_map`
(`map_key: interlock`) serves `map_interlock.png` with fixed two-room metadata, so a re-map in
another spec cannot renumber it, and swaps to `map_interlock_path.png` while
`map_fixture.interlock_path` is on. Both are cameras of the same config entry, named by the
`cameras:` list under `map_fixture:` in `configuration.yaml`. All maps are generated by
`test/fixtures/synthetic/generate.cjs`, which also writes the end-to-end copies.

Its camera, vacuum and consumable sensor come from one config entry, imported from the
`map_fixture:` YAML key, because Home Assistant only attaches a device to an entity that belongs to
a config entry. The card resolves the vacuum's sibling sensors through that device, which is what
`rename-registry.spec.ts` needs: the sensor's registry icon is what a generated tile shows.

The same integration provides `vacuum.fake_vacuum` (`map_fixture/vacuum.py`), a vacuum that behaves
the way real ones misbehave: it reports each change `lag` seconds late (a polling integration such
as xiaomi_miot lags ~30 s), cleans a multi-room `app_segment_clean` in its own order (recorded in
`cleaned_rooms`), ignores a command while returning, docks after a job, and can fail the next call
or go unavailable. Every `poll_seconds` (2 s) it rewrites its state with a new `polled` attribute
and the same activity, as a polling integration does, and its `commands` attribute lists every room
command it received, so a spec can tell "sent nothing" from "sent an empty room list".
`map_fixture.vacuum_configure` sets `lag`,
`room_seconds`, `return_seconds`, `poll_seconds`, `fail_next` and `available`; `map_fixture.vacuum_reset` puts it into an activity at once.

`connect-github.cjs` writes the token into the ignored Home Assistant state file
(`test/e2e/ha/config/.storage`), because the Marketplace device flow cannot run headless. Nothing
under `.storage`, `.auth` or `artifacts` is committed.
