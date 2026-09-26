---
name: playoff-odds-miscalibrated
description: Graded on 184,959 real team-weeks, the simulate-and-count playoff probability is worse than the league base rate at weeks 2-3 and overconfident at both ends at every week; the fitted logistic beats it everywhere.
metadata:
  type: project
  modified: 2026-09-20T03:20:00.000Z
---

**Measured 2026-09-20**, `scripts/calibrate-playoff-odds.mjs` on branch
`claude/project-thread-f921do-odds-calibration-hold` head `8b8e7e8`, evidence
`docs/tdd/playoff-odds-calibration.tdd.md`. Nothing in the repo had ever compared a
published playoff percentage to a real finish — `trade-verify.js:78-90` bounds only
Monte Carlo NOISE, and a simulation can be perfectly stable and perfectly wrong.

**184,959 team-weeks, 2,500 leagues, 2021-2025, 200 sims, deterministic RNG.**
Brier, lower better; base rate is exact on average because precisely
`playoff_teams` of `num_teams` qualify in every league.

| week | simulation | base rate | worst gap | fitted (leave-one-season-out) |
|---|---|---|---|---|
| 2 | **0.2855** | 0.2410 | 0.3473 | **0.2134** |
| 3 | **0.2439** | 0.2410 | 0.2780 | 0.1994 |
| 4 | 0.2162 | 0.2410 | 0.2198 | 0.1870 |
| 8 | 0.1342 | 0.2409 | 0.0852 | 0.1312 |

1. **Weeks 2-3 are worse than no information.** Informative only from week 4.
2. **Overconfident at both ends, every week.** A "0%" team qualifies **12%** of the
   time, a "100%" team misses **10%**; the middle is nearly exact and the mean
   prediction equals the observed rate to 4 dp, so the spread is too wide, not
   biased. Simulating from a thin estimate of a team's own scoring does this.
3. **The fitted logistic wins at every week**, worst calibration gap **0.022** vs
   the simulation's 0.085-0.347. Stable across all five seasons.

**What it does NOT say** (carry these with the numbers, always): it grades the
simulate-and-count machinery and the bracket, NOT the app's projections (Sleeper
leagues; `players.sleeper_id` covers 751/8,556); the empirical-bootstrap
substitution is least like the app early, exactly where the worst numbers are; the
fitted model had home advantage (other seasons of the same corpus, a different
format mix from Nick's five ESPN leagues); and League Hub's actual number — from
week 1, zero records, through-2025 projections — was NOT graded and has no reason
to beat this floor.

**Three responses, all proposals, none implemented** (changing what a page says
needs the coordinator, then Nick): suppress the percentage before week 4,
publish the fitted probability for the playoff question, or widen the simulator's
spread. **Recommended: suppress before week 4** — Nick's leagues are in week 2.

**Reusable:** `server/services/calibration-metrics.js` (`brierScore`,
`reliabilityBins`), tested and mutation-checked. **Equal-COUNT bins are load
bearing:** a simulator's probabilities pile up near 0 and 1, so equal-width bins
average the extreme disagreement away and this finding reads as nothing. Point it
next at the title odds, `predictRankGap`, the trade window and Trade Brain
confidence — none has ever been graded. See [[gridiron-failure-modes]],
[[o4-corpus-not-in-the-image]].
