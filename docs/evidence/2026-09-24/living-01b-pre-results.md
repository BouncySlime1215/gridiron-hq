# LIVING-01b PRE kill test: results

Pre-registration: `docs/evidence/2026-09-24/living-01b-pre-preregistration.md` (committed first, 6b08a806).
Script: `scripts/rnd/living-01b-pre.mjs`. Corpus: the local Sleeper team-season corpus
(read-only, seasons 2021-2024; 2025 not read). Run 2026-09-24 on Nick's Mac, R = 1000.

## Verdict: PASS (team-level replay)

Rule: playoff AND title log-score delta (living - frozen) 90% lower bound > 0, in 2023 AND 2024.

| season | leagues | playoff log delta [90%] | title log delta [90%] |
|---|---|---|---|
| 2023 | 474 | +0.01220 [+0.00860, +0.01558] | +0.00948 [+0.00685, +0.01222] |
| 2024 | 471 | +0.01725 [+0.01233, +0.02176] | +0.00745 [+0.00483, +0.01009] |

Not gating (positive = living better):

| season | playoff Brier | title Brier | playoff log, errors only | title log, errors only |
|---|---|---|---|---|
| 2023 | +0.00224 [+0.00114, +0.00332] | +0.00168 [+0.00118, +0.00215] | +0.00860 [+0.00536, +0.01171] | +0.00420 [+0.00215, +0.00654] |
| 2024 | +0.00279 [+0.00135, +0.00408] | +0.00124 [+0.00069, +0.00180] | +0.01351 [+0.00911, +0.01763] | +0.00513 [+0.00280, +0.00734] |

Frozen mean log score per team: playoff -0.4952 (2023), -0.5152 (2024); title -0.3084, -0.2936.

Fit (2021-22, 138,001 team-weeks, 907 leagues, league-clustered SE):
g = +0.236 points per cumulative claim (SE 0.021); L = -17.97 points in a lineup-error week (SE 0.29).
Most of the gain is the lineup-error term (the errors-only arm is 44-78% of the full delta).
Dropped: 2 leagues each season (short season, missing weeks, pairings or playoff count).

## What this does and does not show

- It is the **team-level** replay of 01b's mechanism (engagement chain, claims, lineup
  errors). The corpus has no weekly rosters or projections, so the player-level
  season-sim and its waiver policy's choices are **not** graded here.
- **Deviation (disclosed):** before the registered run, one smoke run at R = 50 (same
  code, same parameters) printed the held-out numbers. Its verdict was FAIL only because
  the 2024 title lower bound was -0.0007 at that run count. Nothing was changed after it;
  the registered R = 1000 run above is the result.
- The flag stays OFF: ENGINE-SPECS also hard-gates 01b behind CE-03 and PROJ-03-c
  clearing the sim, which has not happened.

## Raw

```
LIVING01B_PRE {"cut":6,"runs":1000,"g_raw":0.2359,"g":0.2359,"L":-17.9685,"se":[0.0214,0.293],"fit_n":138001,"holdout":{"2023":{"leagues":474,"teams":5172,"title_leagues":474,"frozen_po_log":-0.49519488148387986,"frozen_ti_log":-0.3084233917889402,"po_log":{"est":0.0122,"ci90":[0.0086,0.01558]},"ti_log":{"est":0.00948,"ci90":[0.00685,0.01222]},"po_brier":{"est":0.00224,"ci90":[0.00114,0.00332]},"ti_brier":{"est":0.00168,"ci90":[0.00118,0.00215]},"po_log_err":{"est":0.0086,"ci90":[0.00536,0.01171]},"ti_log_err":{"est":0.0042,"ci90":[0.00215,0.00654]},"pass":true},"2024":{"leagues":471,"teams":5178,"title_leagues":471,"frozen_po_log":-0.5152436221196567,"frozen_ti_log":-0.29358014210498007,"po_log":{"est":0.01725,"ci90":[0.01233,0.02176]},"ti_log":{"est":0.00745,"ci90":[0.00483,0.01009]},"po_brier":{"est":0.00279,"ci90":[0.00135,0.00408]},"ti_brier":{"est":0.00124,"ci90":[0.00069,0.0018]},"po_log_err":{"est":0.01351,"ci90":[0.00911,0.01763]},"ti_log_err":{"est":0.00513,"ci90":[0.0028,0.00734]},"pass":true}},"pass":true}
```
