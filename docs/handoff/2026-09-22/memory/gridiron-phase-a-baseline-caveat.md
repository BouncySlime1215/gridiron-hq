---
name: gridiron-phase-a-baseline-caveat
description: The Phase A lift proofs used a research baseline that omits the repo's own opponent adjustment — why that makes the nulls conservative, and what to audit next.
metadata:
  type: project
  modified: 2026-09-22T04:37:32.508Z
---

**CAVEAT THAT QUALIFIES ALL OF THE ABOVE — the baseline used in these proofs is
a RESEARCH baseline, not the production model.** It knows prior targets,
receptions, receiving yards, prior PPR, snap share (`offense_pct`), games played
and position. It does NOT include the repo's own opponent adjustment:
`nfl-features.js:217` `def_epa_per_play`, `:219` `def_success_rate`, `:228`
`opp_adj_def_epa` (computed at `:445`). This cuts one way only — the production
model has strictly MORE information, so a feature that adds nothing to the
research baseline has even less to add to the real one. The nulls are therefore
conservative, not inflated. But any future "detection" against this baseline
must be re-checked against the repo's existing features before it is believed:
the OL-vs-DL run's pooled detection was substantially rediscovering
`opp_adj_def_epa`.

**Next job recommended 2026-09-22 and pending the coordinator's call:** stop
adding features, and audit whether `opp_adj_def_epa` actually reaches the
projection a user sees — Phase 0 item 5's question pointed at the model layer.
Coaching run/pass tendency (the last of Nick's seven) should NOT be run as
written: it is team-level and player-invariant, and its 4th-down half sits on
the unit-mismatch bug in `off_fourth_down_rate` (evidence commit 0176b575), so
it cannot be tested honestly until that is fixed.

See [[gridiron-phase-a-feature-verdicts]] for the five verdicts and
[[gridiron-weekly-ceiling-2026-09-22]] for the one number that explains them.

**RESOLVED 2026-09-22, and it reopens OL-vs-DL for fantasy.** Model evidence
audit fully traced `opp_adj_def_epa` (`nfl-features.js:228`, computed `:445`,
spread into `teamFeatureVector` at `:477`): it is betting-side ONLY. All three
callers (`nfl-reasoning.js`, `nfl-ai-replay.js`, `routes/nfl-betting.js`) are
betting; no fantasy client file calls that route; and it is not in the
`nfl_team_week_features` JSON blob either (`nfl-pbp.js`'s `writeTeamWeeks`
does not import `nfl-features.js`). Verdict: half_done — correctly computed,
unreachable from the fantasy product. Evidence:
`docs/evidence/2026-09-22/opp-adj-def-epa-wiring-audit.md`.

**Consequence:** the "already built" premise above is FALSE for fantasy —
only betting has opponent-defense-quality; fantasy's only opponent signal is
`vegasLift`, a betting-line multiplier in `lineup-brain.js`. OL-vs-DL's
decline now stands only on the weaker "failed split-half replication"
reason, and that replication design confounded era with training-set size
(see the OL-vs-DL row in [[gridiron-phase-a-feature-verdicts]]). Coordinator
approved a cleaner re-test (fixed training-set size across the split, or a
rolling-origin design) as a real next candidate once the current queue
clears — not re-run yet.
