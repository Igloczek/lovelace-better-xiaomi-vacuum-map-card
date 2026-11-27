# Agent guide

## North star and autonomy

This is a Home Assistant custom card, not a nuclear plant: in the worst case someone starts their vacuum from another app or rolls back a version. The maintainer does not know every feature, does not own every vacuum, and does not want to study every user request.

**Default to 99% automation.** Agents and the **Chief of staff** own decisions, implementation, pull request review, merging and releases on their own — without asking the maintainer — as long as a change:

1. **is not breaking** (existing YAML, dashboards, element names and workflows keep working unchanged),
2. **does not drastically change UX** for existing users (opt-in options or clear, non-disruptive refinements), and
3. **cannot make the overall experience or quality worse** (proven by red-first tests, full local checks, and Chromium + WebKit pixel proof for overlays; no brittle hacks or bloat).

Priorities, in order:

1. **Never break existing setups** (`FORK.md` compatibility promise).
2. **Real-browser reliability** (especially WebKit — Safari and the Home Assistant iOS/macOS apps).
3. **Low friction for users** (sensible defaults, clean opt-in options, no `card-mod` workarounds needed for common asks).
4. **Test-first, CI green** (every bug adds a red-first test and closes the gap in the suite).

## Chief of staff

A standing pinned thread titled `Chief of staff` owns day-to-day delivery for this repository, backed by a daily scheduled sweep (`Chief of staff (daily sweep)`). It reviews and merges open pull requests, decides on feature and follow-up proposals, launches and steers `Build #N` threads, follows up on pre-release beta feedback, cuts batched stable releases (including the README demo video check), keeps `ROADMAP.md` current, and settles completed threads.

- Triage and build threads hand ready pull requests, reporter beta confirmations and design calls to `Chief of staff` (`t3_thread_search` for `Chief of staff`), not to the maintainer.
- `Chief of staff` only escalates to the maintainer for the ~1% calls under "Who decides what ships". Routine merges, opt-in features and releases do not ask for approval.
- **Keep `master` CI green.** Check `master`'s CI after every push and every release, including `Validate HACS` once the release asset is uploaded (it fails while a release has no `xiaomi-vacuum-map-card.js`). A red check is never a harmless side effect: fix it or re-run it at once.
- **Don't stall on a silent reporter.** When the likely cause of an open issue can be reproduced in the fixtures, build the fix instead of waiting for user data; ask for data only for what cannot be reproduced locally.
- **Settle and revive.** Every `Triage #N`, `Build #N`, worker or sweep thread settles itself (`t3_thread_organize`, `settle`) and removes its clean worktree once its work and hand-off are done. The daily sweep checks `master` CI and revives webhook triage threads whose run failed (for example on a quota limit), so no outside comment is dropped.

## GitHub comments

Agents post on GitHub through the maintainer's account, so readers must be able to tell them apart from the maintainer.

- **Mark every autonomous comment.** Any comment an agent posts on its own (triage, build, `Chief of staff`, beta notices, release updates, closing comments) starts with:

  ```markdown
  <!-- triage-agent -->
  > 🤖 **AI agent reply.** This is automated delivery, not the maintainer. They may check this issue later.
  ```

  (A triage run says `automated triage`.) A comment the maintainer approved word for word is theirs and needs no marker.
- **Every comment moves the issue forward.** No passive acknowledgements ("recorded, leaving open"). Ship what is confirmed right away, even if only one model or case is confirmed on a multi-model issue.
- **Close shipped issues, never silently.** When a fix ships in a stable release, close the issue as `completed` with a marked comment naming the version, what was verified, and that replying with a problem on that version reopens it.
- **Release notes are for users.** Write GitHub release notes in plain English about what changed for users, not internal jargon.

## Fork relationship

- This repository is Igloczek's fork of `PiotrMachowski/lovelace-xiaomi-vacuum-map-card`; upstream remains the base for general development.
- Keep the current differences from upstream and the upstream-sync instructions in [`FORK.md`](FORK.md). Read it before changing fork-specific behavior or syncing upstream. Every row under **Active differences** is a preservation criterion for an upstream import.
- Add every intentional fork-only feature or fix to `FORK.md`, including what it changes and why. When upstream absorbs it, prove equivalence with the tests and move the row to **Superseded differences** with the upstream commit.
- [`ROADMAP.md`](ROADMAP.md) holds planned work and postponed items; [`CHANGELOG.md`](CHANGELOG.md) holds released changes. Do not keep a record of completed work in a standing document.
- For an upstream sync, follow [`.agents/skills/sync-upstream/SKILL.md`](.agents/skills/sync-upstream/SKILL.md). Its [fork-differences checklist](.agents/skills/sync-upstream/fork-differences.md) maps each active difference to the files that implement it and the test that proves it. Never delete a fork test, `FORK.md` row, a documentation anchor, or the sync skill to make an import pass.
- The issue tracker is triaged by the issue triage agent (`Igloczek/issue-triage-agent`, private): a T3 webhook task on the maintainer's Mac runs its procedure for each new issue or comment, one thread per issue. What it needs to know about this project is in [`.github/triage.md`](.github/triage.md), and this project's end-to-end cases are in `.github/triage-e2e/`. No workflow comments on or edits issues; `.github/workflows/triage-e2e-file.yml` only files `triage-test` issues for that project's end-to-end test.
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

## Every bug improves the test suite

A bug that reached a user is also a bug in the test suite: the suite let it through. Fix both, so the
suite grows with every bug and the same class of problem cannot come back.

- **Red first.** Before fixing, write a test that reproduces the bug and fails on the current code. Prove it: run it against the unfixed code (or the last release) and see it fail, then fix and see it pass. A test that was never red proves nothing.
- **Find the gap, not only the case.** Ask why the suite missed it and close that gap for the whole class: a fixture too tidy to show it (three separated rectangles cannot show a label cut by a neighbour's border), a check that reads layout instead of pixels, one browser engine instead of Chromium and WebKit, a mock where the real Home Assistant behaves differently, a zoom, rotation or theme never tried. Extend the fixture, harness or helper so every later test gets the coverage too.
- **Test where the bug lives.** Logic in the Vitest DOM suite, rendering by its pixels in the visual suite in Chromium and WebKit, anything that depends on Home Assistant in the real-instance e2e suite. A bug that crossed levels gets a test at each.
- **Keep fixtures real.** New map tests use the realistic floor plan (`test/fixtures/apartment/`, camera `camera.apartment_map` in both the visual harness and the e2e instance): rooms sharing walls, irregular shapes, long and non-ASCII names, unnamed rooms, furniture and paths. When a user's map shows something the fixtures lack (a shape, a colour scheme, metadata, a platform's quirk), add it to the fixture's generator so it stays covered.
- **Report what testing turns up.** A realistic fixture finds problems beyond the one being fixed (labels of small neighbouring rooms overlapping each other). Fix them when they are in scope; otherwise name them to the maintainer instead of fixing them silently or leaving them unmentioned.
- **Never weaken the suite to pass.** Do not delete, loosen or skip a test to make a change pass; a test that needs updating keeps what it proved. A flaky test is a bug of its own.
- In the hand-off or report, name the test that was red before the fix and the gap in the suite it closes.

## Who decides what ships

Agents drive this project end to end: they investigate, reproduce, decide option names and shapes, build, test, review, merge and release without waiting to be asked. Sort every change into one of these three buckets:

1. **Agents decide, merge and ship (~99% of work).** Bug fixes, additive opt-in configuration options, platform/template fixes, documentation, and non-disruptive UX refinements. Pick the cleanest design yourself, prove it with red-first tests and the checks in "Local checks" on the exact head (including Chromium + WebKit pixel proof for map overlays), and merge — directly for a clear bug, or via `Chief of staff` review for new options and refinements — without asking the maintainer, as long as the change is **not breaking**, does **not drastically change UX**, and **cannot make overall experience or quality worse**.
2. **Needs real-hardware confirmation first: pre-release.** Use this only when a change genuinely depends on a vacuum model, firmware or integration we cannot simulate or prove locally. Keep the pull request open, publish a `vX.Y.Z-beta.N` pre-release from its head ("GitHub releases"), and ask the reporter's AI agent to test it. Once they confirm it works, `Chief of staff` merges and ships it without asking the maintainer. Do **not** hold a locally proven, card-only opt-in option behind a beta or maintainer queue just because it adds a config key or UI polish.
3. **Escalate to the maintainer (~1% of work).** Build or propose it, then stop and ask the maintainer in chat (never on GitHub) **only** when a change:
   - is **breaking** (removes or renames config keys, drops compatibility, or changes defaults in a way that breaks existing dashboards),
   - **drastically changes UX** (a major visual/layout overhaul or changing how the card works for everyone), or
   - **risks degrading overall experience or quality** (high maintenance burden, questionable trade-offs, or changing the fork's compatibility promise or scope).

**What an escalation hand-off contains.** Keep it in the chat with the maintainer, never on GitHub: do not post hand-offs, screenshots or summaries as pull request or issue comments, and keep pull request descriptions short. GitHub comments are only for external contributors. Present it with the chat's built-in visualization tools (a rendered HTML page with before/after images side by side, or embedded images) so the maintainer can decide in a minute:

- The problem and the change in one short paragraph, written for a user, not as a diff summary.
- What it looks like (when visual): before and after screenshots, or a short recording for motion or interaction, in Chromium and WebKit, captured from the real-HA e2e instance (kept in the scratchpad).
- The risk or trade-off that triggered escalation, the alternatives considered, your recommendation, and what you would change if they say no.
- What is proven: the tests and checks that passed on the head, and anything not verified.

End with a single question the maintainer can answer yes or no, or by picking one option.

**Releases are batched.** Merging does not mean releasing. Before cutting a release, `Chief of staff` checks other running agent threads, open pull requests close to merging, and what `master` has gained since the last release (`git log <last tag>..origin/master`). Cut a release autonomously when a batch is ready, not after every merge. Release on its own only for an urgent fix, such as a card that does not render, a run that cleans the wrong room, or lost configuration. Only changes escalated under bucket 3 wait for maintainer approval before merging and releasing.

## GitHub releases

- `.github/workflows/release.yml` builds and uploads `xiaomi-vacuum-map-card.js` when a GitHub release is published. Check that workflow when changing release packaging.
- Run `gh` in the authorized local environment, outside the sandbox.
- The built-in browser (`preview_*` tools) is signed in to the maintainer's GitHub account. When the API refuses an action you are already allowed to take, or the action exists only in the web UI (re-requesting a review on `hacs/default`, a UI-only control), do it there yourself instead of asking the maintainer. The rules for GitHub comments still apply, and close the tab when you are done.
- A release that touches the UI in any way (anything the card shows or how it moves: layout, controls, colours, icons, wording, overlays, animations) ships a re-recorded README demo video. Before tagging, rebuild from the commit being released, re-record `docs/media/demo.mp4` and regenerate `docs/media/demo.webp` ([`scripts/demo-video/README.md`](scripts/demo-video/README.md)), check the frames, and commit both to master. `npm run check:demo-video` fails while `src/` has changed since the last release tag and the video has not; pass `-- --no-ui-change` only when no listed change is visible in the card, and say why in the release note/log. When in doubt, re-record.
- Releases use the fork's own `vX.Y.Z` tags, numbered in sequence from the last release (`gh release list --limit 1`). Upstream's legacy tags were deleted; never skip a version to dodge a stale tag — delete the stale tag instead. Check that the tag is free (`git ls-remote --tags origin vX.Y.Z`) before `gh release create`: on an existing tag it publishes that old commit and no release workflow run follows.
- A change we cannot verify ourselves (a vendor's robot or an integration we do not run) goes out as a pre-release first: keep the PR open, tag `vX.Y.Z-beta.N` for the next version on the PR head (the next `N` that is free: parallel build threads share the numbering; push the tag first because `gh release create` rejects a branch commit as `--target`), publish it with `--prerelease` so the stable release stays Latest, and check the uploaded asset carries the change. Then ask the reporter on the issue to have their AI agent install it, test it and report back: a short prompt linking that comment, manual install and revert steps (edit the existing resource, never add a second copy), concrete test steps and what to report. Once confirmed, `Chief of staff` merges and ships the stable release autonomously without waiting for maintainer approval.
