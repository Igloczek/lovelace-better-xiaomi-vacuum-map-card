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

## Now

- **Stale-room warning readability.** In a narrow card the warning truncates after the first stale
  id and an order badge can cover a stale marker; let the warning wrap and keep the marker visible.
- **Editor coverage on current frontends.** The editor already adapts to `ha-input` and to the
  removal of `ha-formfield`; keep watching Home Assistant frontend releases for the next element
  that disappears. Checked on 2026-11-15 against frontend `dev` (2026.12): only `ha-list*` goes,
  which the card does not use. The weak spot is `ha-select`: the editor's three pickers have no
  fallback and `editor.spec.ts` does not assert them, so a removal would leave empty boxes. Add a
  plain `<select>` fallback and an e2e assertion.
- **Default Marketplace listing.** The README button adds the repository as a custom repository.
  The pull request adding it to `plugin` in `hacs/default` is open and waiting for review:
  [hacs/default#14136](https://github.com/hacs/default/pull/14136) (opened 2026-11-14). Once it
  merges, switch the install steps to a catalog search and add the default badge.

## Next

- **Same-coloured interlocking rooms.** When two touching rooms share a fill colour and their
  bounding boxes interlock (two L-shaped rooms around a hallway), colour detection still gives part
  of one room to the other. Master already did (it then missed one of the rooms entirely); the
  four-colour map palettes avoid it, but a palette that repeats colours on touching rooms does not.
  Needs a synthetic fixture with same-coloured interlocking L rooms and a fix that splits by the
  rooms' metadata shape rather than only their bounds.
- **Roborock status and battery templates.** The generic duration handling is in place; the
  Roborock-specific tile templates need a real Roborock-core registry dump (the `unique_id`
  patterns and the status strings) before the regexes can be trusted.
- **Smaller stacked horizontal cards.** Now that a narrow horizontal card stacks, `min_columns: 9`
  is no longer needed to keep the map usable; letting a stacked card take a third or half of a
  section would give owners of a compact dashboard a smaller card, at the cost of a taller,
  scrolling one.

## Later

- **Live path overlay on a static floorplan.** A static image already works as the map source
  (`map_source.image` plus `transparent_background`); what is missing is drawing the robot's live
  path on top of such an image.
- **Templated predefined selections.** Dynamic selections currently come from an entity's state or
  attribute. Supporting Jinja templates would be a large change and needs a concrete use case that
  entity-backed selections cannot serve.
- **Rotated zone rectangles.** Zone APIs are axis-aligned; supporting arbitrary quadrilaterals
  needs evidence that a target platform accepts four points.
- **Valetudo JSON map source and icons.** Large and platform-specific; needs a Valetudo instance or
  a captured fixture before it can be tested.
- **Ecovacs SVG viewbox handling.** Needs an Ecovacs SVG camera fixture.
- **Delayed start.** An automation or script does this better than the card.

## Postponed, with unblock conditions

| Item | Why it waits | Unblocks when (data request) |
|---|---|---|
| Roborock status/battery tiles | The templates need the integration's real registry entries | A scrubbed Roborock-core registry dump and a status string sample are available ([#53](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/53)) |
| Live path overlay on a static image | No fixture and no decision on how a path overlays a picture | A path entity fixture and an agreed rendering ([#47](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/47)) |
| Templated predefined selections | No concrete use case and a large Jinja subscription change | A report that entity-backed selections cannot serve ([#48](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/48)) |
| Rotated zone rectangles | No platform documented to accept arbitrary points | Vendor documentation or a working service call ([#49](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/49)) |
| Valetudo JSON map / icons | No Valetudo instance to verify | A captured map fixture or a Valetudo instance ([#50](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/50)) |
| Ecovacs SVG viewbox | No Ecovacs fixture | An Ecovacs SVG camera capture ([#51](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/51)) |
| Delayed start | A script or automation is the better place | A product reason that belongs in the card |
| Collapse map | `card-mod` and conditional cards already cover it | It becomes free alongside another layout change |
| Non-admin MQTT (#966) | Needs a non-admin Home Assistant user and an MQTT broker to verify | A report with that setup ([#52](https://github.com/Igloczek/lovelace-better-xiaomi-vacuum-map-card/issues/52)) |

## Known limitations

Accepted in the 1.0 line, each with what would fix it:


## Open questions and risks

- **HACS to Marketplace.** Home Assistant 2026.11 blocks the HACS integration and migrates installs
  to the Marketplace. Keep `hacs.json` accurate for older releases while the Marketplace path is the
  one that gets exercised.
- **Vendor-specific ordering.** The card can show the cleaning order and send selections in click
  order; whether a platform honours that order is vendor behaviour and cannot be promised here.
- **Real-device coverage.** Camera request rates, map refresh timing and long-name layouts are
  proven on a local Home Assistant with a fixture camera. Firmware quirks that change snapshot
  timing or room metadata need a report with logs.
- **Test environment drift.** The end-to-end suite pins Home Assistant 2026.11.0; new frontend
  releases can remove elements or change layouts, so re-run the suite when bumping the image.
