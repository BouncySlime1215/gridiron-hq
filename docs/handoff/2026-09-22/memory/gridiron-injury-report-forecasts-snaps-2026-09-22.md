---
name: gridiron-injury-report-forecasts-snaps-2026-09-22
description: The free nflverse injury report captures 21% of the participation ceiling (0.0926 of 0.4405 targets weekly MAE) and beats naive — partly revising package #12, whose sample had deleted every week a player missed.
metadata:
  type: project
---

Measured 2026-09-22, free nflverse releases only. Spec `SNAPFORECAST-SPEC.md`,
scripts `sf-build.mjs` / `sf-test.mjs` / `sf-ceiling.mjs`. 14,751 player-weeks,
2023-2025 REG, weeks 5-18.

**Result, one identical row set:**

| predictor | MAE (targets) |
|---|---:|
| naive: prior mean targets per week | 1.5674 |
| on-field share x last-3 forecast (package #12's baseline) | 1.5122 |
| **on-field share x injury-adjusted forecast** | **1.4196** |
| on-field share x ACTUAL snaps (the ceiling) | 1.0717 |

Injury-adjusted beats the baseline by **−0.0926 [−0.1004, −0.0748]** = **21.0%
of the ceiling**, and beats naive by 0.1478. Forecasting snaps directly:
6.1139 → 5.7592 plays.

**IT REVISES [[gridiron-participation-not-target-rate-2026-09-22]], my own
package.** #12 kept only player-weeks with >=1 on-field pass play, which
deleted every week a player MISSED — exactly what an injury report predicts.
17.1% of rows here are absences. "Participation is the binding constraint"
stands; "a realistic forecast captures none of it" was an artifact of my sample
construction. **Lesson: a filter that keeps only rows where the thing happened
cannot measure a signal about whether it happens.**

**Why the report is legitimate, not leakage:** the week-W report publishes
before kickoff. Status→play-rate multipliers are fitted on PRIOR SEASONS only,
so evaluation starts 2023.

**How informative** (26,959 player-weeks, 2022-2025): Out → P(absent) 0.9987;
Doubtful 0.9910; Questionable 0.2672; no report row 0.1204. The graded
multiplier beats a hard zero-when-Out rule (−0.0926 against −0.0710), so the
value is not only in "Out".

**Wiring gap, not a data gap — the second in the same file.** `nfl_injuries` is
already ingested (`nfl-advanced.js:335-410`) and read by `draft-assist.js:903`
(display) and `role-scenario-engine.js:127` (a boolean gate). `nfl_snaps` is
already ingested too. **Neither reaches `projections.js`**, whose availability
is game-granular (`:611-630`) with a QB-only within-game term (`:652-669`).

**Recommendation:** a graded snap multiplier from the report, not a boolean
"is he out". Gated unit — it moves live start/sit and `projections.js` is not
R&D's file.

**CARRIES TOO, but the two halves move opposite ways** (package #14,
`RUSHSNAP-SPEC.md`, 17,025 player-weeks): naive 1.1014 → last-3 1.0693 →
injury-adjusted **0.9989** → perfect snaps 0.4428. Injury-adjusted beats the
baseline by −0.0703 [−0.0798, −0.0507] and naive by −0.1024.
- **Participation matters MORE on the ground:** perfect snaps cut baseline
  error by **59%** against 29% for receiving. Rushing volume is mostly who is
  on the field.
- **The report captures LESS of it: 11.2% against 21.0%.** What decides carries
  beyond availability is committee split and game script, which no Wednesday
  report knows. A build should expect a smaller return on carries and not be
  graded as failing for it.
- **Untested and probably the bigger rushing prize:** game script, which IS
  measurable from free data (spreads, totals, win probability) and was not
  examined.

**79% of the receiving ceiling is still unclaimed** — game script, blowouts, in-game
injury, benching and committee rotation are not in a Wednesday report. The
multiplier is league-wide, and teams differ in how they use "Questionable".
