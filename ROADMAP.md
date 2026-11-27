# Roadmap

What this fork plans to work on next. The current state of the card is described in the
[README](README.md); released changes are in [CHANGELOG.md](CHANGELOG.md); the differences from
upstream are in [FORK.md](FORK.md).

## How to propose work

Open an issue on the fork tracker with the platform and Home Assistant version involved, the
configuration that shows the problem, and what you expected instead. A change is only planned when it
can be checked on one real Home Assistant instance: either by a fixture that reproduces the report or
by the behaviour being observable in the UI. Vendor behaviour that needs the physical robot stays out
until someone can provide that evidence.

Every change is expected to come with a test that fails first, pass the repository gates, and be
reviewed before release. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow.

## Next

- **Roborock status and battery templates.** The generic duration handling is in place; the
  Roborock-specific tile templates need a real Roborock-core registry dump (the `unique_id`
  patterns and the status strings) before the regexes can be trusted.
- **Smaller stacked horizontal cards.** Now that a narrow horizontal card stacks, `min_columns: 9`
  is no longer needed to keep the map usable; letting a stacked card take a third or half of a
  section would give owners of a compact dashboard a smaller card, at the cost of a taller,
  scrolling one.

## Later

- **Templated predefined selections.** Dynamic selections currently come from an entity's state or
  attribute. Supporting Jinja templates would be a large change and needs a concrete use case that
  entity-backed selections cannot serve.
- **Valetudo JSON map source and icons.** Large and platform-specific; needs a Valetudo instance or
  a captured fixture before it can be tested.
- **Ecovacs SVG viewbox handling.** Needs an Ecovacs SVG camera fixture.
- **Delayed start.** An automation or script does this better than the card.
- **Hand icon and tile actions to Home Assistant.** They run through `custom-card-helpers`'
  `handleAction` (last released 2021), which knows no `assist` action and ignores an action-level
  `entity` for `more-info`; the card already patches `perform-action` in. Firing Home Assistant's
  `hass-action` event would support every current and future action type, but the card wraps
  `callService` to show a failed call, so it needs a way to keep that feedback first.
- **Drop `custom-card-helpers`.** Only its types, `fireEvent`, `forwardHaptic`, `hasAction` and
  `handleAction` are used; small local helpers would remove a stale dependency whose types lag
  Home Assistant's.

## Postponed, with unblock conditions

| Item | Why it waits | Unblocks when (data request) |
|---|---|---|
| Roborock status/battery tiles | The templates need the integration's real registry entries | A scrubbed Roborock-core registry dump and a status string sample are available ([#53](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/53)) |
| Templated predefined selections | No concrete use case and a large Jinja subscription change | A report that entity-backed selections cannot serve ([#48](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/48)) |
| Valetudo JSON map / icons | No Valetudo instance to verify | A captured map fixture or a Valetudo instance ([#50](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/50)) |
| Ecovacs SVG viewbox | No Ecovacs fixture | An Ecovacs SVG camera capture ([#51](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/51)) |
| Delayed start | A script or automation is the better place | A product reason that belongs in the card |
| Collapse map | `card-mod` and conditional cards already cover it | It becomes free alongside another layout change |
| Non-admin MQTT (#966) | Needs a non-admin Home Assistant user and an MQTT broker to verify | A report with that setup ([#52](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/52)) |

## Known limitations

Accepted in the 1.0 line, each with what would fix it:

- Two same-coloured rooms whose fills touch with no wall or gap between them cannot be split from
  the pixels: the map has to draw the boundary. This is the plain per-room trace's behaviour; the
  card does not guess.
- A room the camera publishes with its own outline keeps that outline where the colours cannot
  confirm a better shape: only part of the room drawn in a room colour, its colour running on into
  an open-plan neighbour, or a doorway strip that runs more than a few pixels past the outline's
  bounding box. Such a room is drawn as the integration publishes it (for Valetudo's MQTT Vacuum
  Camera, a convex hull). A wider trace window for outline rooms would cover the doorway case.

## Open questions and risks

- **HACS to Marketplace.** Home Assistant 2026.11 blocks the HACS integration and migrates installs
  to the Marketplace. Keep `hacs.json` accurate for older releases while the Marketplace path is the
  one that gets exercised.
- **Vendor-specific ordering.** The card can show the cleaning order and send selections in click
  order; whether a platform honours that order is vendor behaviour and cannot be promised here.
- **Real-device coverage.** Camera request rates, map refresh timing and long-name layouts are
  proven on a local Home Assistant with a fixture camera. Firmware quirks that change snapshot
  timing or room metadata need a report with logs.
- **Frontend internals.** The card relies on a few non-public frontend details: editor detection
  walks `hui-card[preview]`, `hui-section[preview]` and `hui-card-preview`, configuration errors
  render `hui-error-card`, the hold ripple is `ha-ripple`, and toasts use `hass-notification`. The
  pinned end-to-end suite catches a rename when the image is bumped.
- **Test environment drift.** The end-to-end suite pins Home Assistant 2026.11.0; new frontend
  releases can remove elements or change layouts, so re-run the suite when bumping the image.
