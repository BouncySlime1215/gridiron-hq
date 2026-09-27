---
name: gridiron-snap-share-simpson-paradox-2026-09-22
description: Snap share adds real signal over prior opportunity WITHIN each position (0.26-0.35) but measures as 0.04 pooled — a Simpson's paradox that would wrongly kill the feature.
metadata:
  type: project
---

Measured 2026-09-22 for PLAN 02 (`/mnt/project-files/PLAN-02-snap-share-participation-2026-09-22.md`).
Source: real nflverse `snap_counts_2024.csv` + `stats_player_week_2024.csv`, REG only.
**Feed-level correlations — NOT the rig, NOT production.** They say the signal exists;
they do NOT say weekly MAE improves.

## THE RESULT — pooling destroys it
Partial correlation `r(opp_w, snap_{w-1} | opp_{w-1})` — does last week's snap share add
over last week's opportunity in predicting this week's?

| slice | n | partial |
|---|---:|---:|
| **ALL pooled** | 3,802 | **0.0427** |
| WR | 1,839 | **0.3513** |
| TE | 836 | **0.2599** |
| RB | 1,127 | **0.2648** |

**Pooled it reads as nothing; within every position it is substantial.** Position drives
the level of both quantities, so between-position variance inflates pooled
`r(opp_w, opp_w-1)` to 0.7502 and swamps the within-position signal. **A pooled fit or
pooled gate returns "adds nothing" and is WRONG.** Fit and grade per position; the RED
test must fail a pooled implementation (a WR and an RB with identical snap share and
identical prior opportunity must get different adjustments).

**Generalise this:** any per-player feature whose level differs systematically by position
is exposed to the same artefact. Check pooling before accepting any "adds nothing" verdict.

## Hypothesis for the Auditor — NOT a claim
The **depth-chart-rank** precedent ("a large raw gradient that added nothing because it
was already inside `targets` and `offense_pct`") is the prior being used to discount
snap share. **If that measurement was pooled across positions it may have failed for this
same artefact.** Its working has not been read. Worth re-reading for pooling before it
carries that weight.

## Supporting figures
- vs the model's availability term (player-season, skill, n=564):
  `r(games-played rate, mean snap%) = 0.4906`, r² 0.2407 — **76% unexplained**.
- **142 skill players played all 17 games** in 2024, so the model's availability term is
  IDENTICAL (1.0) for all of them, while their snap shares run **0.007 to 0.963**
  (median 0.497). Availability cannot distinguish a decoy from an every-down starter.
- Contemporaneous (player-week): WR vs targets r=0.7148; TE vs targets r=0.6213;
  RB vs carries r=0.8283; RB vs targets+carries r=0.8798 (only 23% unexplained — RB is
  where the redundancy worry is real, TE is where it is weakest).

## Premise correction carried into the plan
Auditor criterion 2 says to correlate against `offense_pct`, "which the model already
has." **`projections.js` has NO snap term at all** (grepped: no `offense_pct`, no
`nfl_snaps`; the only match at `:648` is a comment about a passer). What it has is an
availability rate (`:611-630`), explicitly "a *role* forecast, not an injury forecast."

## Not established
2024 only, one season. No within-season stability check — a one-week lag was measured,
not how far the signal persists. No MAE lift. All three flagged in the plan's §4.

Related: [[gridiron-planner-role-and-path-facts-2026-09-22]],
[[gridiron-feed-zero-contamination-2026-09-22]].
