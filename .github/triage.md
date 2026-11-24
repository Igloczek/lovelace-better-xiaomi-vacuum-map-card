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

## Shipping a test version

A build thread follows `AGENTS.md`: it sorts the change into a class, and a class 1 bug fix merges
as usual. Anything else built for an issue stays an open pull request and ships as a
`vX.Y.Z-beta.N` pre-release on its head ("GitHub releases" in `AGENTS.md`), with a comment on the
issue asking the reporter's AI agent to install, test and report back. The build thread ends with
the class 2 hand-off for the maintainer in its own chat; merging and the stable release wait for
their approval.

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
- **Data requests:** issues the maintainer opened to collect data from users (#50–#53) wait for
  outside comments. Acknowledge data that arrives, and name it in the report for the maintainer.
