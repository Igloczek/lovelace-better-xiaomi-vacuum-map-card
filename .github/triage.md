# Issue triage

This repository is triaged by the issue triage agent (`Igloczek/issue-triage-agent`, private).
Its procedure applies; this file adds what is specific to Better Xiaomi Vacuum Map Card.

- **Maintainer:** `Igloczek`
- **Docs:** `README.md`, `docs/configuration.md`, `docs/platforms.md` and `docs/templates/`,
  `docs/report-a-problem.md`; released changes in `CHANGELOG.md`, fork-only behaviour in `FORK.md`.
- **Roadmap:** `ROADMAP.md`
- **Releases:** `gh release list` (a version a user names may not exist).

## Reproducing

A run may use the unit tests (`npm test`), the visual harness, and the real-Home-Assistant e2e
instance (`test/e2e/README.md`): give the instance its own port and container, and stop it when
done. It never touches the maintainer's own Home Assistant. A fix thread follows `AGENTS.md`.

## Building, shipping, and Chief of staff

This repository is run ~99% autonomously (see `AGENTS.md`). Triage decides sensible config names,
option shapes and opt-in enhancements itself instead of bouncing routine design questions to the
maintainer.

- **Build what is safe and sensible:** when a bug reproduces or a feature/follow-up request is real,
  non-breaking, does not drastically change UX and cannot degrade overall quality, start a
  `Build #<number>` thread and notify the repository's standing `Chief of staff` thread
  (`t3_thread_search` for `Chief of staff`).
- **Locally proven changes ship autonomously:** a build thread follows `AGENTS.md`, proves the
  change with red-first tests and Chromium + WebKit visual / real-HA checks, opens a pull request,
  and hands it to `Chief of staff` for review, merge and batched release — without waiting for
  maintainer approval.
- **Hardware/integrations we do not own:** if the change genuinely cannot be verified without the
  reporter's vacuum or integration, the build thread ships a `vX.Y.Z-beta.N` pre-release on the
  pull request head ("GitHub releases" in `AGENTS.md`) and comments on the issue asking the
  reporter's AI agent to install, test and report back.
- **Follow-ups and beta replies:** when a user replies to confirm a pre-release, report a problem
  with a beta, provide requested data, or ask for a concrete non-breaking follow-up on a closed
  issue, route the summary (in your own words) to the existing `Build #<number>` thread or to
  `Chief of staff` so it is acted on without involving the maintainer.
- **Escalate only the ~1%:** leave a decision for the maintainer only when a change is breaking,
  drastically changes UX for everyone, or risks degrading overall quality/experience. Otherwise,
  settle the triage thread (`t3_thread_organize` `settle`) once your work and hand-off are done.

## Project-specific rules

- **Bugs** need the card configuration, the camera's `calibration_points`, the vacuum integration
  and its version, and the browser console error. When reproducing needs the user's setup data,
  give them the report-problem prompt from `docs/report-a-problem.md`: their AI agent collects
  and redacts it.
- **Agent reports** carry `<!-- agent-report:v1 -->` in the body or a comment. Check one with
  `node scripts/agent-report/cli.mjs check <file>`; label a complete one `agent-report`, and for
  an incomplete one ask for the missing fields by name.
- **New platform requests:** platform templates come from upstream (`docs/platforms.md`). Check
  `docs/platforms.md` first: the platform may already be supported. Otherwise say what the card
  can do with the generic setup and what the request still needs.
- **Data requests:** issues the maintainer opened to collect data from users (#48, #50–#53) wait for
  outside comments. Acknowledge data that arrives and forward a summary to `Chief of staff` so it
  can pick up the unblocked work.
