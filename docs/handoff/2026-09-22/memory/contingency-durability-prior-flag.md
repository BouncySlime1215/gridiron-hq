---
name: contingency-durability-prior-flag
description: weeklyAvailability serves durability_prior_measured (added 2026-09-20) — read the flag, never compare the prior to 0.92, because the row is rounded to three places.
metadata:
  type: project
  modified: 2026-09-20T06:51:25.107Z
---

`weeklyAvailability` in `server/services/contingency.js` serves
`durability_prior_measured` (boolean) beside `durability_prior`. Added on
branch `claude/project-thread-w45mur-wiring-names-hold` (a6d00bb, off main
791b131, held under the GitHub freeze — a new PR after Nick's go, not a
fast-forward onto #72).

**Why:** the prior was silently substituted with the constant 0.92 for any
player `availability()` has no row for — no `player_week_usage` in any season
through the cutoff. 0.92 sits inside the range real measured priors occupy, so
a player with four seasons on file and one with none came back identical in
every served field. `source` does not separate them: it names the formula that
priced the week, not the prior's origin. On the live database
`player_week_usage` holds 2021-25 and no 2026, so in the 2026 season this is
not a corner case — it is every player until the usage table catches up.

**How to apply:** consumers read the flag. `durability_prior_measured === false`
maps to the fantasy plan's `default_durability` basis; `true` with no fitted
rate maps to `durability_prior`. **Never detect the default by comparing the
number to 0.92** — the row is served to `+toFixed(3)`, so a float test also
catches a veteran whose real measurement rounds to 0.920. The constant is named
`DEFAULT_DURABILITY_PRIOR`; the other 0.92 in the file (practice-status branch)
is a different quantity and deliberately not the same constant.

The default's value remains unjustified and unfitted. Nothing can be fitted for
a player with no games, so the honest end state is a default that admits what
it is, not a better guess.

Related: [[test-seam-exports-stay]], [[gridiron-failure-modes]].
