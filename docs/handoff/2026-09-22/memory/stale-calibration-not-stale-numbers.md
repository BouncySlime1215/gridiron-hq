---
name: stale-calibration-not-stale-numbers
description: A fitting script reading a table does NOT mean a constant was fitted on it — the league_week_scores cross-check, and why to read what consumes the computed value.
metadata:
  type: project
---

Found 2026-09-20 while auditing PR #47 against Nick's standing five questions
("is this based on stats, is this just made up, how do we know").

**CORRECTED, and the correction is the lesson.** I first wrote that posture
constants were FITTED against `league_week_scores`, so production constants
rested on a hand-maintained table. That was wrong; the release thread caught it
and I verified their reading.

`fit-posture-calibration.mjs:499-517` is the section headed "Cross-check against
real ESPN team-week scores": it computes a pooled within-team SD, writes
`result.league_week_scores`, prints it, and **nothing downstream reads that
field**. `lineup-posture.js:131` says it outright — "they are not the same
quantity, and the fit is on the one P(win) needs" — and `SPREAD_SCALE = 1.63` is
fitted on the lineup residual (SD ~21.5, slope 0.87 → ~26.5).
`trade-horizon.js:47` is the same shape: the runtime derives a league's calendar
from `payload.settings.scheduleSettings`, and the table is cited only as what
revealed the doubled playoff totals.

**So what a manual-only writer made stale is the CORROBORATING numbers** in two
comments — 62 team-seasons, 861 team-weeks, SD 24.1, CV 0.20 — not any fitted
constant, and no re-fit waited on PR #47. A cross-check nobody can re-run is
still worth noting, but it is a quieter finding than the one I claimed.

**Why this is the more useful memory:** "a table is read by a fitting script"
does not mean "a constant was fitted on it". A script can read a table to
corroborate and throw the result away. Read what consumes the computed value,
not just what the script selects — the same reachability rule MEMORY.md already
states for constants ("read callers AND where the pool was built"), applied to a
number rather than a code path. Overstating a finding costs more than missing
one, because the stronger version gets relayed.

**How to apply:** when auditing a model, ask what its constants were fitted
against and whether THAT input has a writer on a timer. Grep the fitting script
for its input tables, not just the serving path. A calibration input with a
manual-only writer is the same class of finding as an endpoint named for what it
does not serve.

**Second finding from the same audit:** the whole path from
`league_week_scores` to a number Nick acts on was undocumented — luck-panel →
archetype store → the `outcome` source in `manager_signals`
(manager-signals.js:268-276) → `counterparty-pricing.js:452-457`'s
`luck_self_view`, a term in the trade price. The wiring map showed only the first
hop. Trace to where a decision is made, not to the first reader.

**Unification candidate, with its brake:** all three acceptance-band sources
(`trade-acceptance.js:65`) are `fitted: false` around a declared
`UNANCHORED_CENTRE = 0.30`. `league_season_teams` + `league_week_scores` joined to
`league_transactions_raw` is the only pairing in the repo that could make one
fitted. Brake: ~12 league-seasons, growing forward only (ESPN serves a ~3-day
transaction window).

**Where NOT to point it:** O4's Team Outlook. Its basis module uses 692 public
Sleeper leagues *because* Nick's own league-seasons are small and descriptive;
repointing it here trades a large out-of-sample base for a tiny in-sample one.
In-league comparison beside the verdict, never the estimator.

See [[league-history-orphan-closed]].
