# Agent guide

## Fork relationship

- This repository is Igloczek's fork of `PiotrMachowski/lovelace-xiaomi-vacuum-map-card`; upstream remains the base for general development.
- Keep the current differences from upstream and the upstream-sync instructions in [`FORK.md`](FORK.md). Read it before changing fork-specific behavior or syncing upstream. Every row under **Active differences** is a preservation criterion for an upstream import.
- Add every intentional fork-only feature or fix to `FORK.md`, including what it changes and why. When upstream absorbs it, prove equivalence with the tests and move the row to **Superseded differences** with the upstream commit.
- [`ROADMAP.md`](ROADMAP.md) holds planned work and postponed items; [`CHANGELOG.md`](CHANGELOG.md) holds released changes. Do not keep a record of completed work in a standing document.
- For an upstream sync, follow [`.agents/skills/sync-upstream/SKILL.md`](.agents/skills/sync-upstream/SKILL.md). Its [fork-differences checklist](.agents/skills/sync-upstream/fork-differences.md) maps each active difference to the files that implement it and the test that proves it. Never delete a fork test, `FORK.md` row, a documentation anchor, or the sync skill to make an import pass.
- In a fresh clone, configure the original repository as `upstream` before attempting a sync; this checkout already has that remote configured.

## Project map

- This is a TypeScript/Lit custom card for Home Assistant. The card element is `src/xiaomi-vacuum-map-card.ts`: its state, Lit lifecycle, `render()` and the Home Assistant card API. Behaviour lives in `src/card/`, one module per area, as functions that take the card:
  - `presets.ts` presets, calibration, internal variables; `selection.ts` modes, the selection and the drawing context; `rooms.ts` camera room metadata, stale ids, colour detection and room taps; `active-run.ts` the started run on the map; `run.ts` the run button and service calls; `events.ts` window/editor events; `map-view.ts` zoom, pan, rotation and the stored map view; `map-refresh.ts` the camera snapshot URL and refresh timing; `render.ts` controls, warnings and toasts; `registry.ts` registry-change re-renders and the generated icon/tile refresh; `styles.ts` the card CSS.
- Add new behaviour to the module for its area, or a new module, not to the card class. Keep the card class to wiring. A card member that modules need is not `private`; tests reach a few internals through thin delegates on the class (`_getSelection`, `_restoreMapView`, `_rotateMap`, ...), keep those when you move code.
- Map models and geometry live in `src/model/`; configuration types are in `src/types/` and validation is in `src/config-validators.ts`. Empty YAML keys are normalised away in `src/config-normalization.ts` before anything reads the configuration; keep that pass in front of validation and rendering when adding a config field.
- Read `CONTRIBUTING.md` for platform-template and translation workflows. Update `docs/configuration.md` and `docs/platforms.md` when user-facing configuration or behavior changes; the README describes the card's current capabilities, install and usage.

## Map geometry

- Keep vacuum coordinates, calibrated map coordinates, source-image pixels, and CSS layout pixels distinct. Use `CoordinatesConverter` and the `MapObject` conversion helpers instead of mixing spaces.
- `realScale` converts source-image pixels to the canvas's untransformed layout size. `mapScale` is the pinch-zoom scale. The canvas and SVG overlays share the `#map-zoomer-content` transform.
- Use `calculateRealScale()` for the base image scale. `getBoundingClientRect()` includes CSS zoom and rotation and can apply a transform twice to overlays when an image reloads.
- `RoomColorDetector` returns image-pixel room outlines. Camera `rooms` metadata supplies room IDs and names; preserve configured room selections as a fallback when detection is unavailable.
- When changing map rendering, verify overlays and room hit-testing at multiple zoom levels and rotations.
- Verify every map overlay in **WebKit** as well as Chromium. WebKit is the engine of Safari and the Home Assistant iOS and macOS apps, and it paints HTML inside an SVG `foreignObject` away from its layout box when that HTML is positioned, transformed or filtered, while `getBoundingClientRect` still reports the right place. 1.5.0 shipped labels that every Chromium check passed and the Home Assistant app never showed. Put placement on the SVG element around the `foreignObject`, never on the HTML inside it, and prove an overlay by its pixels (`test/visual/paint.spec.ts`, the WebKit project of `npm run test:e2e`), not by its box. Keep rotation behavior in the shared map transform; add a manual rotation control only when the requested feature calls for one.

## Fixes are for every user

- Fix problems in the card, for every supported platform and vacuum. A report from one user's vacuum is a sample of a general bug: find the general cause and check the other platform templates and selection types for it.
- Never create or change scripts, automations, helpers, integrations or other configuration in a user's Home Assistant, including the maintainer's own instance, to make the card work. A workaround that lives in one installation fixes nothing for anyone else.
- A user's Home Assistant is for reproducing and verifying: read state, render templates, and drive the dashboard the way a user would. Installing a released card version to verify it is fine. Ask before changing the user's dashboard card configuration, and do not use it to work around a card bug.
- When a vacuum or integration cannot do what a feature needs (for example it ignores the room order), say so, and solve it in the card for all affected platforms or document the limitation; do not ship a per-installation workaround as the fix.

## Local checks

- Run `npm test` (Vitest with a happy-dom harness) for unit and DOM tests, and `npm run test:e2e:fresh` for the real-Home-Assistant suite (see `test/e2e/README.md`). The fresh runner resets the gitignored HA state, recreates the instance and runs the whole documented sequence; `npm run test:e2e` alone targets an already prepared instance and re-authenticates a stale saved token (or fails fast with the reset command). Give parallel worktrees their own `E2E_CONTAINER`, `E2E_HA_PORT` and `COMPOSE_PROJECT_NAME`; a custom port (or container) derives its own container and compose project, so scripts never touch another checkout's instance (see the isolation table in `test/e2e/README.md`).
- Leave no container running. `npm run test:e2e:fresh` tears its instance down unless you pass `--keep`; if you keep one, or start one by hand (`docker compose up`, the demo-video instance), stop it with `npm run e2e:down` or `docker compose ... down` as soon as you are done with it, pass or fail, and never hand work back or delete a worktree with its instance still up. Before handing back, run `npm run e2e:prune` to remove instances whose worktree is gone (it never touches a live worktree's). See "Leaving nothing running" in `test/e2e/README.md`.
- Run `npm run check:map-scale` for the zoom/rotation scale regression check and `npm run check:docs` for documentation links.
- Run `npm run build` for linting (oxlint) and the production bundle (Rolldown); `npx tsc --noEmit` is an additional type check.
- Run `npm run format` (oxfmt) before committing; CI fails on unformatted files. Lit template contents are deliberately not formatted.
- Use `npm start` for the development bundle. `CONTRIBUTING.md` documents loading it into a Home Assistant instance.
- Run each check once per head. When a check has already passed locally on the exact commit (unit tests, build, the visual suite in the CI image, the real-HA e2e suite), merge without waiting for CI's copy of it, and say which local run it rests on. Wait only for checks that ran nowhere else; the HACS and manifest `validate` jobs take under a minute.
- The visual suite needs the CI Docker image only to regenerate baselines (`test/visual/README.md`). On Apple Silicon that image is emulated and takes about five minutes a pass, so regenerate and prove stability in one container invocation, and run the cheap checks (`npm test`, `npx playwright test --ignore-snapshots`, a single spec on the host) first, so a wrong assertion fails in seconds instead of costing an emulated pass. When no baseline changes, the `visual` label's CI run (about two minutes) is enough on its own.

## Who decides what ships

Agents drive this project: they investigate, reproduce, build, test, open pull requests and prepare releases without waiting to be asked. They do not yet have the taste to judge UI and UX nuances, so whether a change may be merged and released depends on what kind of change it is. Sort every change into one of these three classes before merging; when it is not clearly class 1, it is class 2.

1. **Clear bug: merge it yourself.** The report is binary (it works or it does not), the reproduction was immediate, and the fix restores behaviour that is documented or obviously intended, with nothing visible changing beyond the fix. Merge it after the checks in "Local checks" pass on the exact head.
2. **Needs the maintainer's call: build it fully, then stop.** This covers anything that is not an obvious bug, a rough idea without a settled design, and every change to what users see or how they interact: layout, colours, icons, wording, animations, defaults, new or changed behaviour, and where a message or control appears. Do all the work, open the pull request, and do not merge or release it. Make the decision easy (see below) and wait for the maintainer's answer.
3. **Cannot be reproduced here: pre-release.** The change depends on a vacuum or integration we do not run. Follow the pre-release bullet under "GitHub releases" so external contributors can install and test it.

**What a class 2 hand-off contains.** The hand-off goes in the chat with the maintainer, never on GitHub: do not post hand-offs, screenshots or summaries as pull request or issue comments, and keep the pull request description short. GitHub comments are only for external contributors (the pre-release flow). Present it with the chat's built-in visualization tools (a rendered HTML page with the images side by side, or embedded images), so the maintainer can decide in a few minutes:

- The problem and the change in one short paragraph, written for a user, not as a diff summary.
- What it looks like: before and after screenshots, or a short recording for motion or interaction, in Chromium and WebKit, at the sizes and themes it affects. Capture them from a real Home Assistant (the e2e instance), keep the files in the scratchpad, and show them in the chat. When a step happens too fast to see (an instant test vacuum hides a spinner), slow it down for the capture.
- How to try it: a `vX.Y.Z-beta.N` pre-release (see "GitHub releases") with install steps, or the exact dashboard and steps. Install it on the maintainer's Home Assistant only when they ask.
- The alternatives you considered, your recommendation, and what you would change if they say no.
- What is proven: the tests and checks that passed on the head, and anything not verified.

End the thread's report with a single question the maintainer can answer yes or no, or by picking one option.

**Releases are batched.** Merging does not mean releasing. Before you cut a release, check the state of the whole project: other agent threads still running, open pull requests close to merging, and what master has gained since the last release (`git log <last tag>..origin/master`). Release when a batch is ready, not after every merge. Release on its own only for an urgent fix, such as a card that does not render, a run that cleans the wrong room, or lost configuration. Class 2 changes are released only after the maintainer has approved them.

## GitHub releases

- `.github/workflows/release.yml` builds and uploads `xiaomi-vacuum-map-card.js` when a GitHub release is published. Check that workflow when changing release packaging.
- Run `gh` in the authorized local environment, outside the sandbox.
- Releases use the fork's own `vX.Y.Z` tags, numbered in sequence from the last release (`gh release list --limit 1`). Upstream's legacy tags were deleted; never skip a version to dodge a stale tag — delete the stale tag instead. Check that the tag is free (`git ls-remote --tags origin vX.Y.Z`) before `gh release create`: on an existing tag it publishes that old commit and no release workflow run follows.
- A change we cannot verify ourselves (a vendor's robot or an integration we do not run) goes out as a pre-release first: keep the PR open, tag `vX.Y.Z-beta.N` for the next version on the PR head (push the tag first; `gh release create` rejects a branch commit as `--target`), publish it with `--prerelease` so the stable release stays Latest, and check the uploaded asset carries the change. Then ask the reporter on the issue to have their AI agent install it, test it and report back: a short prompt linking that comment, manual install and revert steps (edit the existing resource, never add a second copy), concrete test steps and what to report. Merge and release the stable version after they confirm.
