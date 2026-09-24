# Benchmarks (ratchet: a PR may only hold or improve these; RULES.md §2)
Each row: metric, best value, split, command/source. "seed" = number from R&D, not yet a CI check. RATCHET-01 turns rows into a CI job.

| Metric | Best | Split | Source |
|---|---|---|---|
| Team-points CRPS, independent pooled Normal (lower better) | 5.179 (2023) / 5.033 (2024) | fit 2021-22 | #215, #219 scripts/proj03a-calibration.mjs |
| Team-pair energy score (lower better) | 8.1251 (2023) / 7.8880 (2024), independent pair | fit 2021-22 | #219 (shared path lost) |
| Team-points 80% coverage per spread bucket | band 0.77-0.83 in every cell | 2023, 2024 | same (seed; incumbent misses 3/6) |
| Player price MAE (TM-09) | 1.654 | 2024 held out | #183 (seed) |
| Pair accuracy, player value vs next 5 wks | 0.729 (FantasyCalc) | 2023-24 snapshots | AI-01 decline (seed) |
| Who-trades AUC (activity) | 0.78 / 0.91 | r17 | LOOP-LOG r17 (seed) |
| Waiver pick top-5 hit | 22.1% (BC clone) vs 19.4% most-added | 2021-22 -> 2023, 10,995 adds | rnd/insane/ml.md (seed, unvalidated) |
| Checkout AUC (LIVING-01a) | 0.949 / 0.959; hard cases (added wk6-7) 0.850 / 0.862 vs adds-rule 0.806 / 0.844 | fit 2021-22, grade 2023 / 2024 | #220 living01a-fit.mjs |
| Start/sit decision win rate vs "start ESPN's higher number" | to measure | 2023-24 | C-01 / HX-01 (to measure) |
| Test suite | 1262 pass, 0 fail | main | CI (npm test) |
| Page load / API p95 | to measure | local | RATCHET-01 |
| E3 title-odds calibration (Sleeper week-7 replay, 906 league-seasons 2023-24) | Brier gain vs standings-only: playoffs +0.026 [0.023,0.028], title +0.0018 [0.0012,0.0024]; slopes 0.97 / 0.94 | fit 2021-22 | rnd/eval/eval-hist.md (study; uses teams' own wk1-7 points, not the served sim's projections) |
| E1 stand-in: P(pair trades this week) | slopes 0.93 / 0.90; log loss beats activity-only (gain all from week-of-season) | 2023 / 2024 | rnd/eval/eval-hist.md; TRUE P(accept) untestable on Sleeper (no declines) -> 2026 offer log |
