---
name: gridiron-depth-rank-rejected-2026-09-22
description: Depth-chart rank adds nothing to a rushing participation forecast that already uses last-3 usage — it is measurably worse — and the nflverse depth-chart schema changed in 2025 (repo already handles both).
metadata:
  type: project
---

Package #16, 2026-09-22. Full record `/mnt/project-files/DEPTHRANK-SPEC.md`,
script `/mnt/project-files/dc-test.mjs`.

**Depth-chart rank is a NEGATIVE for rushing participation.** Layered on
package #14's injury-report model (so this is incremental value), fit
2022-2023, eval **2024 only**, n = 5,710 player-weeks, paired bootstrap
clustered on player, 2,000 resamples, seed 20260922:

- on-field rush plays: **+0.0243 MAE [0.0168, 0.0321]** — worse
- carries: **+0.0044 MAE [0.0029, 0.0067]** — worse

Both intervals exclude zero on the harmful side. 89.3% of player-weeks carry a
rank, so this is not a coverage problem.

**Read the multipliers, not the deltas.** Relative to the overall ratio:
rank 1 x0.9810, rank 2 x1.0268, rank 3+ x1.0645, no depth row x0.9960. They
run the *wrong way* — the highest multiplier is on rank 3+.

**Why:** almost certainly not that depth position is uninformative, but that
the **last-3-week usage baseline already contains it**. An RB1 on the chart has
been taking RB1 carries for three weeks and those carries are the baseline's
input. The chart is a slower, noisier restatement. Against a model with no
recent-usage term it could still help — do not quote this as "depth charts are
useless".

**How to apply:** do not wire depth rank into `projections.js` for skill-player
participation. If someone proposes it, this is the measurement.

**nflverse depth-chart schema changed between 2024 and 2025.** 2024 has
`season, club_code, week, game_type, depth_team, depth_position`; 2025 has
`dt, team, player_name, gsis_id, pos_grp, pos_abb, pos_slot, pos_rank` — no
`week`, no `game_type`, 554,216 timestamped snapshot rows. Parsed with the old
reader it yields **0 REG rows**, which looks like an empty season and is not.
**The repo already handles both** — `server/services/nfl-advanced.js:215`:
`const week = n(r.week) || (r.dt ? weekFromDate(season, r.dt) : null);`.
Verified at source. No bug. But it is why #16's eval is one season.

Rushing-participation candidates now closed: spread, total (both #15), depth
rank (#16). **Committee split — the per-team backfield allocation — is the
remaining testable home for the 89%.**

Related: [[gridiron-injury-report-forecasts-snaps-2026-09-22]],
[[gridiron-game-script-does-not-forecast-snaps]],
[[mae-punishes-a-mean-matching-bias-correction]],
[[zero-is-not-missing-in-participation]].
