# Holdout ledger: every look at the 2025 season

2025 is the held-out season for fantasy model work: fit on 2024 and earlier,
evaluate on 2025 once. A held-out season stops being held out a little every
time anyone computes something on it and then decides what to do next
(Dwork et al. 2015, *Science* 349:636). This file counts those looks, so a
reader can see how much of 2025 is already spent before trusting a new 2025
number.

"2025 is the held-out season" is this contract's rule for fantasy model work
done in units. Two pieces of code pick a season differently, and
`STATS-METHOD.md` says how each relates:

- The model registry's sealed holdout (`server/modeling/walk-forward.js:35-44`)
  seals the latest season in the pinned dataset. Once a dataset holds any 2026
  week, it seals 2026 and refuses 2025. It allows one opening per experiment and
  does not count openings across experiments (rule 2).
- Two scheduled jobs, `nfl_weekly_learning` and `nfl_model_growth`, call the
  same retrain, `retrainWeeklyWeights` (`server/services/weekly-learning.js`),
  which is built to fit and auto-promote weekly weights on settled 2026
  snapshots (rule 5).

**The rule** (`docs/evidence/STATS-METHOD.md`, rule 2): a unit that computes
anything on 2025 outcomes appends one row per hypothesis test here, in the same
commit as the result. Rows are never edited or deleted. A correction is a new
row whose note names the row it corrects.

## Where the ledger stands

Seeded 2026-09-22 by unit S-00 from `origin/main` at `d6d7bd5a`.

| | count |
|---|---|
| Rows (looks at 2025) | 153 |
| Fantasy rows | 128 |
| Betting rows (out of product scope, kept because they spent 2025 too) | 25 |
| Fantasy feature-lift rows (the family `STATS-METHOD.md` rule 3 corrects over) | 76 |
| Files the census grep returns | 144 |
| Files that originate at least one row | 56 |

Recount the table with the command in `STATS-METHOD.md` rule 3. It reads this
file and prints these counts.

**What this ledger does not cover yet.** The census was limited to
`docs/evidence/` and `docs/tdd/`. The same grep finds more files that were not
classified: 35 other files under `docs/` (361 lines) and 286 files under
`server/` and `scripts/` (1,763 lines). At least one of those is a real look.
The 2025 table in the comment at `server/services/matchups.js:28-45` is the
control here: the grep finds 13 lines in that file. Extending the census to
those paths is a follow-up unit. Until then, the true number of looks is
**at least** 153.

## How it was built

Tree: `origin/main` at `d6d7bd5a`. The method was pre-registered in
`docs/tdd/2026-09-22-stats-method-contract.tdd.md` section 2 and committed
before any row was written.

```
# C1, the pattern the work queue suggested: 743 lines, 135 files
git grep -n -i -E 'held.?out|2025' origin/main -- docs/evidence docs/tdd
# C2, widened, the census actually used: 892 lines, 144 files
git grep -n -i -E 'held.?out|hold.?out|out.of.sample|2025' origin/main -- docs/evidence docs/tdd
```

C1 cannot match "holdout" or "hold-out", so C2 adds 9 files. One of them,
`docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-RESULTS.md`, is a real
held-out result that only says "out of sample". It turned out to grade 2021 and
2022, not 2025, so it is classed NOISE.

Known-nonzero control: `docs/evidence/2026-09-22/target-share-prior-result.md`,
a known 2025 look, has 5 matching lines under both C1 and C2, and it
originates rows L145-L149.

Every file C2 returns is in the classification table at the end, in exactly one
class:

| class | meaning | files |
|---|---|---|
| LOOK | reports a result computed with 2025 outcomes as evaluation data; originates rows | 55 |
| ARTIFACT | raw output (`.json`, `.mjs`, `.txt`); its look is the document that reports it. One artifact with no reporting document originates its own row | 22 |
| NOISE | the match is not about the 2025 season's outcomes (ids, fixtures, script names, other seasons) | 20 |
| PLAN | a plan, a pre-registration, or a test that was never run | 19 |
| COVERAGE | 2025 appears as data coverage, row counts, a descriptive statistic, or a code check on real records | 15 |
| RESTATE | quotes a 2025 result that another file originates | 10 |
| FIT | 2025 used only to fit or tune something, with no metric reported on it. Not a row, but it spends 2025 too | 3 |

### How rows were cut

- One row per separately reported hypothesis test with its own verdict. A table
  of variants from one run gives one row per variant.
- Controls, placebo arms, synthetic-signal arms and deliberate-leak arms are not
  rows. They check the instrument. The power checks that do detect something
  are recorded once each, as `other`.
- A result that first appears outside `docs/evidence` and `docs/tdd` (a code
  comment or a reference doc) is recorded at the first in-scope file that
  reports it. The note says "origin out of scope".
- **Declared deviation.** Betting studies get one row per study, not one per
  test. They are out of product scope and outside the feature-lift family, and
  the per-test detail stays in the cited file. This was decided after the
  pre-registration and is written here so a reader can disagree with it.
- Numbers are copied as the source printed them, including the sign. The
  `better` column says which sign favours the candidate. They are that source's
  rig magnitudes. Directions carry between rigs. Magnitudes do not (Independent
  Auditor, condition A).
- A figure the Independent Auditor withdrew, or the source itself withdrew, is
  marked in the note and is not used for any correction.

## Columns

| column | meaning |
|---|---|
| id | `L` + three digits, in date order. New rows take the next number |
| date | the run date the source states; otherwise the date the file was added to `main` |
| unit/PR | the `#N` of the commit that added the file, or that commit's short sha |
| domain | `fantasy` or `betting` |
| family | `FL` = fantasy feature-lift: "change X to a fantasy model improves a 2025 accuracy metric against the incumbent". `other` = everything else (calibration bands, non-inferiority gates, grading against dumb baselines, diagnostics) |
| hypothesis, metric, result | shortened from the source; the result is the source's own verdict |
| est, lo, hi, level | the point estimate and interval exactly as printed; `level` is the interval's confidence in percent |
| p (source) | a p-value only when the source printed one |
| better | `-` means a negative estimate favours the candidate; `+` means a positive one does |
| shipped | what the source says happened: `yes`, `no`, `held`, or `n.a.` |
| file:line | where the result is printed, on `d6d7bd5a` |
| note | origin out of scope, withdrawn, assumed levels (marked "guess"), and similar |

## Rows

| id | date | unit/PR | domain | family | hypothesis | metric | result | est | lo | hi | level | p (source) | better | shipped | file:line | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L001 | 2026-08-26 | 3d178a1d | fantasy | FL | Fitted shrinkage k* beats hardcoded K | season-total MAE (and CRPS -0.011 [-0.82, 0.80]) | gate FAILED, constants kept | -0.078 | -1.23 | 1.10 | 90 |  | - | no | `docs/evidence/historical/STAGE_1_RESULTS.md:48` |  |
| L002 | 2026-08-26 | 3d178a1d | fantasy | other | Weekly parameter uncertainty (WEEKLY_LEVEL sigma 0.45) fixes coverage | coverage_80 / PIT calibration / CRPS | PASSED: 0.724 -> 0.795, 0.161 -> 0.110, CRPS flat |  |  |  |  |  |  | yes | `docs/evidence/historical/STAGE_1_RESULTS.md:70` |  |
| L003 | 2026-08-26 | 3d178a1d | fantasy | other | Reproduction: model vs 60/40 blend and season average, season-total and weekly | MAE / Spearman | season total: model wins; weekly: model loses |  |  |  |  |  |  | n.a. | `docs/evidence/historical/STAGE_1_RESULTS.md:92` |  |
| L004 | 2026-08-26 | 3d178a1d | fantasy | FL | Prior-season role tiers improve the structural head | weekly MAE | 4.602 vs 4.586, reject | +0.016 |  |  |  |  | - | no | `docs/evidence/historical/STAGE_1_RESULTS.md:109` |  |
| L005 | 2026-08-26 | 3d178a1d | fantasy | FL | Prior-week offensive-snap tier improves the structural head | weekly MAE | 4.594, reject | +0.008 |  |  |  |  | - | no | `docs/evidence/historical/STAGE_1_RESULTS.md:111` |  |
| L006 | 2026-08-26 | 3d178a1d | fantasy | FL | Separate role memory (seasonDecay 0.05, weekHalfLife 5) improves the structural head | weekly MAE | 4.586 -> 4.501 | -0.085 |  |  |  |  | - | yes (WEEKLY_ROLE_RECENCY) | `docs/evidence/historical/STAGE_1_RESULTS.md:132` |  |
| L007 | 2026-08-26 | 3d178a1d | fantasy | FL | Position-aware ensemble beats the fixed 60/40 blend | weekly MAE | Stage 1.3 green | -0.0215 | -0.0403 | -0.0036 | 90 |  | - | yes (weekly ensemble) | `docs/evidence/historical/STAGE_1_RESULTS.md:163` |  |
| L008 | 2026-08-26 | 3d178a1d | fantasy | other | Position-aware ensemble beats season-to-date (dumb baseline) | weekly MAE | beats | -0.0885 | -0.1206 | -0.0560 | 90 |  | - | yes | `docs/evidence/historical/STAGE_1_RESULTS.md:164` |  |
| L009 | 2026-08-26 | 20a66cd8 | betting | other | Props walk-forward accuracy 2022-2025 | MAE / Brier | passing yards MAE 70.14 |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/model-diagnostic-2026-08-26.md:192` |  |
| L010 | 2026-08-26 | 20a66cd8 | fantasy | other | Season model vs trivial 60/40 blend (2025 held out, 382 players) | season-total MAE | model 42.68 loses to blend 42.10 |  |  |  |  |  |  | n.a. | `docs/evidence/historical/model-diagnostic-2026-08-26.md:261` |  |
| L011 | 2026-08-27 | 5ae830ed | fantasy | other | Shared player-week engine accuracy, 2022-2025 walk-forward | MAE by stat; champion 4.7569 | development diagnostics, not an untouched holdout |  |  |  |  |  |  | yes (engine) | `docs/evidence/historical/STAGE_2_RESULTS.md:29` |  |
| L012 | 2026-08-27 | 5ae830ed | fantasy | other | Weekly-distribution gate re-run after identity fix (refit 2023+24, validate 2025) | coverage / calibration / CRPS | 0.791 / 0.095 / 3.169; no change to WEEKLY_LEVEL |  |  |  |  |  |  | no change | `docs/evidence/historical/STAGE_2_RESULTS.md:140` | same run reported at docs/evidence/history/WORK_LOG.md:160 |
| L013 | 2026-08-27 | b0256408 | betting | other | Historical profitability baseline 2022-2025 | ROI / CLV | 2022-2025 seasons opened repeatedly; no longer untouched |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/profitability-baselines.md:75` |  |
| L014 | 2026-08-27 | 5ae830ed | betting | other | Prop stat models beat own-average baselines, 2022-2025 (4 stats) | MAE | all four pass |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/history/WORK_LOG.md:51` |  |
| L015 | 2026-08-27 | 5ae830ed | fantasy | FL | Offseason team-change factor improves early-season opportunity (2025 weeks 2-5) | opportunity MAE | passed narrowly; not wired | -0.033 | -0.064 | -0.0008 | 90 |  | - | no | `docs/evidence/history/WORK_LOG.md:267` |  |
| L016 | 2026-08-27 | 5ae830ed | fantasy | FL | Same factor, movers only | opportunity MAE | passed narrowly; not wired | -0.149 | -0.295 | -0.0018 | 90 |  | - | no | `docs/evidence/history/WORK_LOG.md:268` |  |
| L017 | 2026-08-27 | 5ae830ed | betting | other | Wong teasers 1999-2025 | win rate | 74.69%, SE 1.17pp |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/history/WORK_LOG.md:495` |  |
| L018 | 2026-08-27 | 5ae830ed | betting | other | Passing yards: volume vs efficiency component replacement, 2022-2025 | MAE | both replacements worse; decomposition stays |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/history/WORK_LOG.md:645` |  |
| L019 | 2026-08-27 | 5ae830ed | betting | other | Twenty passing specialists, validated on 2024-2025 | MAE / Holm | zero promoted |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/history/WORK_LOG.md:737` |  |
| L020 | 2026-08-30 | de8fde26 | betting | other | Full ensemble replay 2021-2025 | record / units | 2025: 71-64-1, 52.6% |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/nfl-model-status-through-2026-08-30.md:71` |  |
| L021 | 2026-09-01 | ae834b47 | betting | other | Council v3 blind audit 2021-2025 (run 7) | units | 2025 +1.825; total -16.952 |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/MODEL_AUDIT_RUN_7.md:49` |  |
| L022 | 2026-09-02 | ef917a63 | betting | other | nfl-market alpha/carryover fit, 2025 held out | margin error | held-out 10.12; hindsight picks the same pair |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/DIAGNOSTIC_2026_09_02.md:315` |  |
| L023 | 2026-09-02 | ef917a63 | betting | other | Beat-the-close line-move study, 2024-2025 held out (incl. QBR, weather) | CLV | ratings_vs_open +0.58 [0.27, 0.95], Holm p < 0.01; wind on totals +0.47 |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/DIAGNOSTIC_2026_09_02.md:458` |  |
| L024 | 2026-09-07 | 873c4f19 | fantasy | FL | Cross-source ADP disagreement improves the ranker (additive) | season points MAE, dMAE | declined | +0.32 | -0.45 | 1.07 | 90 |  | - | no | `docs/evidence/historical/ADP_DISAGREEMENT.md:99` |  |
| L025 | 2026-09-07 | 873c4f19 | fantasy | FL | Cross-source ADP disagreement improves the ranker (multiplicative) | season points MAE, dMAE | declined | +0.44 | -0.44 | 1.31 | 90 |  | - | no | `docs/evidence/historical/ADP_DISAGREEMENT.md:99` |  |
| L026 | 2026-09-07 | 873c4f19 | fantasy | other | Disagreement predicts outcome variance (band width) | variance test | 2025 marginal at p = 0.048 |  |  |  |  | 0.048 |  | no | `docs/evidence/historical/ADP_DISAGREEMENT.md:120` |  |
| L027 | 2026-09-07 | 89392b2f | fantasy | FL | Residual ECR velocity improves the ranker (top 150) | mean squared error | declined, 0/3 | +0.47 | -39.9 | 47.1 | 90 |  | - | no | `docs/evidence/historical/ADP_REPRICE_LATENCY.md:118` |  |
| L028 | 2026-09-07 | 89392b2f | fantasy | FL | Residual ECR velocity improves the ranker (full panel, secondary) | mean squared error | +0.46, ns | +0.46 |  |  |  |  | - | no | `docs/evidence/historical/ADP_REPRICE_LATENCY.md:125` |  |
| L029 | 2026-09-07 | 5abc78fb | betting | other | Audit run 8: cutoff-safe NFL reconstruction 2022-2025 | OOS R-squared | R-squared -0.0025 to +0.0007 at every lambda |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/BETTING_CAPABILITY_AUDIT-evidence.md:36` | artifact docs/evidence/2026-09-01/NFL_AUDIT_RUN_8_MANIFEST.json |
| L030 | 2026-09-07 | fe3c3fa7 | betting | other | Player engines aggregated to team level improve the market model | margin MAE | blocked: 2025 +0.0036 [-0.0999, +0.0959]; sign reverses in 2025 |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/BETTING_PLAYER_ENGINES.md:132` |  |
| L031 | 2026-09-07 | 32eb5d49 | fantasy | FL | Fitted inverse-variance consensus weights beat hand-set 2:1 | season points MAE | declined, 0/3 | +0.049 | -0.107 | +0.218 | 90 |  | - | no | `docs/evidence/historical/CONSENSUS_WEIGHTS.md:95` | source prints p 0.715 with sidedness not stated; p derived from the interval |
| L032 | 2026-09-07 | 32eb5d49 | fantasy | other | Own-curve arm: 1:1, 1:2, 1:0 vs 2:1 | season points MAE | apparent significance was the curve refit |  |  |  |  |  |  | no | `docs/evidence/historical/CONSENSUS_WEIGHTS.md:136` | grading method withdrawn by the source; not used for BH |
| L033 | 2026-09-07 | 32eb5d49 | fantasy | FL | Consensus weighting equal 1:1 beats 2:1 (fixed curve) | season points MAE | 2025 +0.087 ns | +0.087 |  |  |  |  | - | no | `docs/evidence/historical/CONSENSUS_WEIGHTS.md:149` |  |
| L034 | 2026-09-07 | 32eb5d49 | fantasy | FL | Consensus weighting FFC-heavy 1:2 beats 2:1 (fixed curve) | season points MAE | 2025 +0.042 ns | +0.042 |  |  |  |  | - | no | `docs/evidence/historical/CONSENSUS_WEIGHTS.md:150` |  |
| L035 | 2026-09-07 | 32eb5d49 | fantasy | FL | Consensus weighting expert-only 1:0 beats 2:1 (fixed curve) | season points MAE | 2025 +0.094 ns | +0.094 |  |  |  |  | - | no | `docs/evidence/historical/CONSENSUS_WEIGHTS.md:151` |  |
| L036 | 2026-09-07 | 32eb5d49 | fantasy | FL | Consensus weighting Sleeper-slot-only 0:1 beats 2:1 (fixed curve) | season points MAE | 2025 +0.116 ns | +0.116 |  |  |  |  | - | no | `docs/evidence/historical/CONSENSUS_WEIGHTS.md:152` |  |
| L037 | 2026-09-07 | 8d4030a8 | fantasy | other | How preseason ECR rank maps to realized production, 2021-2025 | hit/bust rates, tiers | descriptive audit; RB-over-WR pattern concentrated in 2023-2025 |  |  |  |  |  |  | yes (draft-audit signals) | `docs/evidence/historical/DRAFT_AUDIT_2021_2025.md:1` |  |
| L038 | 2026-09-07 | 09effa3a | fantasy | FL | Draft-board abstention gate separates reliable picks | slot-adjusted residual separation | 0/3 seasons | -3.77 | -10.61 | +3.26 | 90 |  | + | no | `docs/evidence/historical/DRAFT_BOARD_ABSTENTION.md:89` |  |
| L039 | 2026-09-07 | 737f3d58 | fantasy | FL | Preseason p20/p80 band variant pooled beats the raw band (top 150) | pinball loss | worse | +3.24 | 0.23 | 6.10 | 90 |  | - | no | `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md:100` |  |
| L040 | 2026-09-07 | 737f3d58 | fantasy | FL | Preseason p20/p80 band variant width-1.0 beats the raw band (top 150) | pinball loss | no | 0.00 | 0 | 0 | 90 |  | - | no | `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md:101` |  |
| L041 | 2026-09-07 | 737f3d58 | fantasy | FL | Preseason p20/p80 band variant shrink-10 beats the raw band (top 150) | pinball loss | no | -0.57 | -1.35 | 0.18 | 90 |  | - | no | `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md:102` |  |
| L042 | 2026-09-07 | 737f3d58 | fantasy | FL | Preseason p20/p80 band variant shrink-50 beats the raw band (top 150) | pinball loss | no | +0.40 | -1.35 | 2.11 | 90 |  | - | no | `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md:103` |  |
| L043 | 2026-09-07 | 737f3d58 | fantasy | FL | Preseason p20/p80 band variant kernel-18 beats the raw band (top 150) | pinball loss | better | -1.49 | -2.88 | -0.09 | 90 |  | - | yes (kernel band) | `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md:104` |  |
| L044 | 2026-09-07 | 737f3d58 | fantasy | FL | Kernel band beats the raw band (top 200) | pinball loss | yes | -1.35 | -2.48 | -0.24 | 90 |  | - | yes (kernel band) | `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md:166` |  |
| L045 | 2026-09-07 | 4b9c6349 | betting | other | Player engines into TD prop calibration (season grain) | log loss | declined 0/3; 2025 -0.0002 [-0.0012, +0.0008] |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/PROPS_PLAYER_ENGINES.md:69` |  |
| L046 | 2026-09-07 | 0a3c868c | betting | other | Player engines into TD prop calibration (weekly grain) | log loss | declined 0/3 |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/historical/PROPS_PLAYER_ENGINES_WEEKLY.md:105` |  |
| L047 | 2026-09-07 | 402b77f7 | fantasy | FL | Preseason v2 charting block (NGS, RYOE, aDOT) improves the preseason board | Spearman and MAE, 3 held-out seasons | declined 0/3 seasons |  |  |  |  |  |  | no (evidence drivers only) | `docs/evidence/historical/session-results-2026-09-07.md:30` | origin out of scope: docs/reference/fantasy/PRESEASON_MODEL.md |
| L048 | 2026-09-07 | 402b77f7 | fantasy | FL | Live board model-nudge weight 0.2 beats weight 0 | MAE, 3 held-out seasons | beats w=0 in 2/3 seasons; no weight significant on any season |  |  |  |  |  |  | yes (0.2) | `docs/evidence/historical/session-results-2026-09-07.md:33` | origin out of scope: docs/reference/fantasy/PRESEASON_MODEL.md |
| L049 | 2026-09-07 | 402b77f7 | fantasy | FL | Offseason v2: 39 variables improve the published multiplier | held-out error | none improved; v1 stays |  |  |  |  |  |  | no | `docs/evidence/historical/session-results-2026-09-07.md:38` | aggregate of 39 tests; origin out of scope: docs/reference/fantasy/OFFSEASON_MODEL.md |
| L050 | 2026-09-07 | 402b77f7 | fantasy | other | In-house season model vs comparator (2025 held out) | season MAE | 42.9 vs 47.0 |  |  |  |  |  |  | yes (relative nudge) | `docs/evidence/historical/session-results-2026-09-07.md:41` |  |
| L051 | 2026-09-08 | 503de3a0 | betting | other | Tree/AutoML lab: spreads and totals movement and cover, 2023-2025 | log loss / MAE / ROI | spreads abstain (no_move); totals 2025 no_move; no promotion |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/contracts/research-packages-2026-09-08.md:263` | also reported at docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:362-367 |
| L052 | 2026-09-08 | 4ea1e2b8 | fantasy | FL | Role-scenario allocation (Package D) improves the touches forecast | touches MAE, beneficiaries | 2025 MAE 2.473 -> 2.429, significant | -0.0457 | -0.0742 | -0.0170 | 90 |  | - | no | `docs/evidence/historical/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08-evidence.md:282` | numbers from docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:380; origin artifact out of scope |
| L053 | 2026-09-08 | 4ea1e2b8 | fantasy | FL | Role-scenario allocation improves the yards forecast | yards MAE | CI straddles zero; 2025 21.533 -> 21.669 (worse) |  |  |  |  |  | - | no | `docs/evidence/historical/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08-evidence.md:282` |  |
| L054 | 2026-09-09 | fcf7e1f2 | betting | other | Run 27 spread selections 2021-2025 | ROI | 2025: 27 bets, -0.98%; all: -7.75% |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:15` |  |
| L055 | 2026-09-09 | fcf7e1f2 | fantasy | FL | Role-changepoint detector beats the existing detector | F1 | F1 0.0586 vs 0.0548; recall up, precision down |  |  |  |  |  | + | no | `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:382` |  |
| L056 | 2026-09-10 | 0746ea6e | betting | other | Wong teaser window over 1999-2025; season-level read of 2025 | win rate | 2025 unusable: game_lines.spread corrupted |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-10/CODEX-6-HANDOFF.md:577` |  |
| L057 | 2026-09-10 | f92719ee | betting | other | Family contribution on 1,424 common games 2021-2025 | margin error / contribution | three-answer comparison |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md:97` | artifact docs/evidence/2026-09-10/family-contribution-2021-2025.json |
| L058 | 2026-09-11 | 889dcf12 | betting | other | Re-count of the Wong edge bounded to 1999-2024 vs 1999-2025; ensemble edge vs ATS | win rate; r | r = -0.007 (no); 2025 dropped from the teaser count |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-11/RETURN-TO-CODEX.md:76` |  |
| L059 | 2026-09-13 | 871c963b | betting | other | Probability of backtest overfitting over 4 seasons 2022-2025 | PBO | PBO 0.167 |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-13/STAGE_2_PURGED_EVALUATION.md:140` | artifact purged-evaluation-report.json |
| L060 | 2026-09-13 | 8d7a1836 | betting | other | Team-observation model walk-forward, 2023-2025 | R-squared | R-squared 0.75 walk-forward (source) |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-13/integration-reports/BETTING_INSANE_REPORT.md:38` |  |
| L061 | 2026-09-13 | 5c3b801e | betting | other | Football-first vs the closing spread, five held-out seasons 2021-2025 | win rate | 117-125, 48.35%, z = -1.26; team-trend totals 43.81% |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-13/integration-reports/HISTORICAL_VERDICT_REPORT.md:54` | artifact historical-leaderboard-report.json |
| L062 | 2026-09-13 | 6746aed4 | betting | other | Props-to-spread model, 2023-2025 test window | margin error | does not beat the top-down ensemble |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-13/integration-reports/PROPS_TO_SPREAD_REPORT.md:190` |  |
| L063 | 2026-09-16 | d9b4a90d | betting | other | Player availability models (rate, LR, LGB, isotonic) walk-forward incl. 2025 | log loss / Brier / AUC | generated tables, no verdict in file |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-16/news-line/availability_model_tables.md:91` | news-line study; player availability |
| L064 | 2026-09-16 | d9b4a90d | betting | other | Opener CLV for every forecaster, pooled 2022-2025 | CLV | one small real edge at the opener |  |  |  |  |  |  | n.a. (betting) | `docs/evidence/2026-09-16/opener-clv/summary.md:1` |  |
| L065 | 2026-09-17 | d9b4a90d | fantasy | FL | Matchup card spread C2 (DEFAULT_CV x 1.63) beats current spread B0 | per-matchup log loss, week-clustered | SHIP; log loss 0.6669 vs 0.6726, ECE 0.010 vs 0.039 | -0.0057 | -0.0096 | -0.0016 | 90 |  | - | yes (SPREAD_SCALE 1.63) | `docs/tdd/review-fixes.tdd.md:462` | gate text in week2-numbers.tdd.md; first in-scope result line here |
| L066 | 2026-09-17 | d9b4a90d | fantasy | other | Lineup card P(right) = Phi(gap/14.5) is calibrated and not worse than the six-bin lookup | per-pair log loss (non-inferiority) + bin calibration | ship A: Phi(gap/sigma); not significant | -0.0005 | -0.0014 | 0.0003 | 90 |  |  | yes (A) | `docs/tdd/week2-numbers.tdd.md:45` | non-inferiority gate, not a lift claim |
| L067 | 2026-09-17 | d9b4a90d | fantasy | other | Boom/bust candidate A (global mean-preserving shock) passes the weekly-level gate | coverage_80 band, calibration error, CRPS | G1 FAIL (coverage 0.772 out of band) |  |  |  |  |  |  | no | `docs/tdd/week2-numbers.tdd.md:287` |  |
| L068 | 2026-09-17 | d9b4a90d | fantasy | other | Boom/bust candidate B (per-position sigma) passes the weekly-level gate | coverage_80 band, calibration error, CRPS (non-inferiority) | G1-G3 PASS; CRPS diff -0.0296 | -0.0296 | -0.0413 | -0.0179 | 90 |  | - | yes (WEEKLY_LEVEL B) | `docs/tdd/week2-numbers.tdd.md:288` | band/calibration gate; CRPS was a non-inferiority guard |
| L069 | 2026-09-17 | d9b4a90d | fantasy | FL | Matchup multiplier (home/away as live, 1.02 / 0.98) improves the live weekly projection | MAE, played player-weeks, weeks 5-18 | none passed; all four slightly worse than no adjustment | +0.0004 | -0.0037 | +0.0045 | 90 |  | - | no (matchup mult set to 1) | `docs/tdd/week2-numbers.tdd.md:299` | numbers: server/services/matchups.js:38-41 (origin out of scope) |
| L070 | 2026-09-17 | d9b4a90d | fantasy | FL | Matchup multiplier (home/away fitted, one h) improves the live weekly projection | MAE, played player-weeks, weeks 5-18 | none passed; all four slightly worse than no adjustment | +0.0036 | -0.0050 | +0.0121 | 90 |  | - | no (matchup mult set to 1) | `docs/tdd/week2-numbers.tdd.md:299` | numbers: server/services/matchups.js:38-41 (origin out of scope) |
| L071 | 2026-09-17 | d9b4a90d | fantasy | FL | Matchup multiplier (home/away fitted per position) improves the live weekly projection | MAE, played player-weeks, weeks 5-18 | none passed; all four slightly worse than no adjustment | +0.0043 | -0.0045 | +0.0129 | 90 |  | - | no (matchup mult set to 1) | `docs/tdd/week2-numbers.tdd.md:299` | numbers: server/services/matchups.js:38-41 (origin out of scope) |
| L072 | 2026-09-17 | d9b4a90d | fantasy | FL | Matchup multiplier (DvP strictly prior, fitted K 200, recency 0.5) improves the live weekly projection | MAE, played player-weeks, weeks 5-18 | none passed; all four slightly worse than no adjustment | +0.0007 | -0.0021 | +0.0035 | 90 |  | - | no (matchup mult set to 1) | `docs/tdd/week2-numbers.tdd.md:299` | numbers: server/services/matchups.js:38-41 (origin out of scope) |
| L073 | 2026-09-18 | d9b4a90d | fantasy | FL | Weeks 2-4: structural-only head (b) beats live fit-1 (a) | MAE, played player-weeks | (b) PASS, 4.7099 -> 4.3175 | -0.3965 | -0.5222 | -0.2725 | 90 |  | - | yes (fit-2 promoted) | `docs/tdd/early-week-blend.tdd.md:55` |  |
| L074 | 2026-09-18 | d9b4a90d | fantasy | FL | Weeks 2-4: fitted early buckets (c) beat live fit-1 (a) | MAE, played player-weeks | beat (a) significantly, fail G2 in 2025 (worse than (b)); 4.3304 |  |  |  |  |  | - | no | `docs/tdd/early-week-blend.tdd.md:57` |  |
| L075 | 2026-09-18 | d9b4a90d | fantasy | FL | Weeks 2-4: k/(n+k) blend (d) beats live fit-1 (a) | MAE, played player-weeks | beat (a) significantly, fail G2 in 2025 (worse than (b)); 4.3252 |  |  |  |  |  | - | no | `docs/tdd/early-week-blend.tdd.md:57` |  |
| L076 | 2026-09-18 | d9b4a90d | fantasy | other | Fake-floors fix keeps the 2025 weekly coverage gate | coverage_80 / calibration / CRPS | FAIL 0.776 / 0.111 / 3.083 (control: old engine identical) |  |  |  |  |  |  | yes (947d66c, after G1 failed) | `docs/tdd/fake-floors.tdd.md:74` |  |
| L077 | 2026-09-18 | d9b4a90d | fantasy | FL | Fake-floors fix improves the printed percentiles (D1) | mean quantile loss, 7 percentiles | 1.239 -> 1.229; played rows +0.002 to +0.007 worse | -0.010 | -0.013 | -0.007 | 90 |  | - | yes (shipped on G2 + D1) | `docs/tdd/fake-floors.tdd.md:96` |  |
| L078 | 2026-09-18 | d9b4a90d | fantasy | other | Designation x role gate G2 (cell guard) | per-cell log loss / calibration | run 2 FAIL; runs 1 and 3 PASS (21 of 21 cells) |  |  |  |  |  |  | held | `docs/tdd/play-chance-live.tdd.md:50` |  |
| L079 | 2026-09-18 | d9b4a90d | fantasy | FL | Decision-set gate G3: new chance to play beats current on starters | log loss, starters n=1,326 | 0.314 -> 0.125; first run of G3 on 2025 | -0.189 | -0.209 | -0.170 | 90 |  | - | held | `docs/tdd/play-chance-live.tdd.md:61` |  |
| L080 | 2026-09-18 | d9b4a90d | fantasy | other | Re-score of the play-chance G1 gate (runs 1-3, same hypothesis) | log loss | 3 scorings of 2025 for this model family; same G1 numbers |  |  |  |  |  |  | held | `docs/tdd/play-chance-live.tdd.md:67` | a repeat look, not a new family test |
| L081 | 2026-09-18 | d9b4a90d | fantasy | FL | Role-based chance to play beats the current availability rates | log loss, 8,657 player-weeks | PASS; ECE 0.074 -> 0.017 | -0.155 | -0.170 | -0.141 | 90 |  | - | held (code merged; production rate write held, play-chance-live.tdd.md section 6) | `docs/tdd/play-chance.tdd.md:30` |  |
| L082 | 2026-09-18 | d9b4a90d | fantasy | FL | Vegas game-script lift (lineup-brain.js:280) improves weekly points | weekly MAE | worse: +0.0125, no ordering gain | +0.0125 | +0.0031 | +0.0225 | 90 |  | - | yes (live, never gated) | `docs/tdd/review-fixes-2.tdd.md:172` | interval level not stated in source; 90% entered as a guess (house default) |
| L083 | 2026-09-18 | d9b4a90d | fantasy | other | Weekly coverage gate result is stable across draws and seeds (2025) | coverage_80 | 0.782 at 300 draws, 0.777 at seed 3, 0.778 at 2,000 (outside band) |  |  |  |  |  |  | n.a. (deferred) | `docs/tdd/review-fixes.tdd.md:493` | artifact docs/evidence/baselines/2025-weekly-distribution-draws.json |
| L084 | 2026-09-18 | d9b4a90d | fantasy | FL | Rest-of-season model (d) beats the weekly blend (a) for ros_ppg | ROS points/game MAE, weeks 1-4 pooled | PASS 12/12; w6-10 -0.16 [-0.25, -0.06] | -0.67 | -0.80 | -0.54 | 90 |  | - | yes | `docs/tdd/ros-projection.tdd.md:27` |  |
| L085 | 2026-09-20 | #68 | fantasy | other | Opportunity number (shipped k=6/10 vs own average), targets | targets MAE, weeks 5-17 | loses to own average |  | -0.198 | -0.074 | 90 |  | + | yes (as shipped) | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:95` | interval = baseline error - model error; level not printed in table, 90% assumed (guess) |
| L086 | 2026-09-20 | #68 | fantasy | other | Opportunity number (fitted k vs own average), targets | targets MAE, weeks 5-17 | beats own average |  | +0.017 | +0.050 | 90 |  | + | n.a. (candidate arm) | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:95` | interval = baseline error - model error; level not printed in table, 90% assumed (guess) |
| L087 | 2026-09-20 | #68 | fantasy | other | Opportunity number (shipped k=6/10 vs own average), carries | carries MAE, weeks 5-17 | loses to own average |  | -0.421 | -0.268 | 90 |  | + | yes (as shipped) | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:96` | interval = baseline error - model error; level not printed in table, 90% assumed (guess) |
| L088 | 2026-09-20 | #68 | fantasy | other | Opportunity number (fitted k vs own average), carries | carries MAE, weeks 5-17 | beats own average |  | +0.011 | +0.044 | 90 |  | + | n.a. (candidate arm) | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:96` | interval = baseline error - model error; level not printed in table, 90% assumed (guess) |
| L089 | 2026-09-20 | #68 | fantasy | other | Opportunity number (shipped vs EWMA), targets | targets MAE | as printed |  | -0.187 | -0.078 | 90 |  | + | n.a. | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:151` | interval = EWMA error - model error; 90% assumed (guess) |
| L090 | 2026-09-20 | #68 | fantasy | other | Opportunity number (fitted k vs EWMA), targets | targets MAE | as printed |  | +0.016 | +0.056 | 90 |  | + | n.a. | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:151` | interval = EWMA error - model error; 90% assumed (guess) |
| L091 | 2026-09-20 | #68 | fantasy | other | Opportunity number (shipped vs EWMA), carries | carries MAE | as printed |  | -0.434 | -0.285 | 90 |  | + | n.a. | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:152` | interval = EWMA error - model error; 90% assumed (guess) |
| L092 | 2026-09-20 | #68 | fantasy | other | Opportunity number (fitted k vs EWMA), carries | carries MAE | as printed |  | -0.014 | +0.039 | 90 |  | + | n.a. | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:152` | interval = EWMA error - model error; 90% assumed (guess) |
| L093 | 2026-09-20 | #68 | fantasy | FL | Fitted efficiency k beats the hand-set efficiency constants | weekly MAE | worse: 4.773 vs 4.749 | +0.024 |  |  |  |  | - | no (excluded on evidence) | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:449` | origin out of scope: server/services/shrinkage-fit.js:465-473 |
| L094 | 2026-09-20 | #68 | fantasy | FL | A grid k beats the shipped literal for yards per target (2024-2025 pooled) | yards per target MAE, forward usage | no | +0.0161 | -0.0004 | +0.0317 | 90 |  | + | no | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:550` | grid minimum chosen on the same rows (selection-biased); est = shipped - grid minimum |
| L095 | 2026-09-20 | #68 | fantasy | FL | A grid k beats the shipped literal for catch rate (2024-2025 pooled) | catch rate MAE, forward usage | no | +0.0005 | -0.0003 | +0.0013 | 90 |  | + | no | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:551` | grid minimum chosen on the same rows (selection-biased); est = shipped - grid minimum |
| L096 | 2026-09-20 | #68 | fantasy | FL | A grid k beats the shipped literal for yards per carry (2024-2025) | ypc MAE | the literal is the grid minimum |  |  |  |  |  |  | no | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:552` |  |
| L097 | 2026-09-20 | #68 | fantasy | FL | A grid k beats the shipped literal for yards per attempt (2024-2025 pooled) | yards per attempt MAE, forward usage | no | +0.0295 | -0.0289 | +0.0824 | 90 |  | + | no | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:553` | grid minimum chosen on the same rows (selection-biased); est = shipped - grid minimum |
| L098 | 2026-09-20 | #68 | fantasy | FL | A grid k beats the shipped literal for receiving TD rate (2024-2025 pooled) | receiving TD rate MAE, forward usage | no | +0.0003 | -0.0001 | +0.0007 | 90 |  | + | no | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:554` | grid minimum chosen on the same rows (selection-biased); est = shipped - grid minimum |
| L099 | 2026-09-20 | #68 | fantasy | FL | A grid k beats the shipped literal for rushing TD rate (2024-2025 pooled) | rushing TD rate MAE, forward usage | no | +0.0001 | -0.0002 | +0.0004 | 90 |  | + | no | `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md:555` | grid minimum chosen on the same rows (selection-biased); est = shipped - grid minimum |
| L100 | 2026-09-20 | #72 | fantasy | FL | Published cascade opportunity_without beats base_opportunity on absence weeks (Test A) | opportunity MAE, 77 graded rows | improvement -1.97%, interval straddles zero |  | -1.231 | +1.207 | 90 |  | - | yes (published, no numeric consumer) | `docs/tdd/cascade-grade.tdd.md:129` |  |
| L101 | 2026-09-20 | #72 | fantasy | FL | Own recent usage x multiplier beats own recent usage (Test B) | opportunity MAE | -68.32% (worse), interval excludes zero the wrong way |  | +0.576 | +6.399 | 90 |  | - | yes (published, no numeric consumer) | `docs/tdd/cascade-grade.tdd.md:209` | before-fix column |
| L102 | 2026-09-20 | #72 | fantasy | other | Test B after the one-target multiplier fix (#72) | opportunity MAE | -46.72% (still worse) |  | +0.142 | +4.574 | 90 |  |  | yes (#72 fix) | `docs/tdd/cascade-grade.tdd.md:209` | after-fix column |
| L103 | 2026-09-20 | #72 | fantasy | other | Double-counting explains the Test B penalty (clean vs contaminated split) | opportunity MAE | 2025 clean +53.39%, contaminated +44.14%; causal claim retracted |  |  |  |  |  |  | n.a. | `docs/tdd/cascade-grade.tdd.md:233` |  |
| L104 | 2026-09-22 | #68 | fantasy | other | Chosen k beats prior-only for ypt (select 2018-21, judge 2022-25) | MSE, research estimator | split, does not replicate | +0.150885 | +0.041352 | +0.268924 | 95 |  | + | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md:120` | research estimator on nflverse CSVs, not the shipped code path |
| L105 | 2026-09-22 | #68 | fantasy | other | Chosen k beats prior-only for catch_rate (select 2018-21, judge 2022-25) | MSE, research estimator | holds both ways | +0.000440 | +0.000180 | +0.000716 | 95 |  | + | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md:121` | research estimator on nflverse CSVs, not the shipped code path |
| L106 | 2026-09-22 | #68 | fantasy | other | Chosen k beats prior-only for rec_td_rate (select 2018-21, judge 2022-25) | MSE, research estimator | null both ways | +0.000014 | -0.000009 | +0.000040 | 95 |  | + | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md:122` | research estimator on nflverse CSVs, not the shipped code path |
| L107 | 2026-09-22 | #68 | fantasy | other | Chosen k beats prior-only for ypc (select 2018-21, judge 2022-25) | MSE, research estimator | null both ways | +0.027835 | -0.002600 | +0.060387 | 95 |  | + | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md:123` | research estimator on nflverse CSVs, not the shipped code path |
| L108 | 2026-09-22 | #68 | fantasy | other | Chosen k beats prior-only for ypa (select 2018-21, judge 2022-25) | MSE, research estimator | split | +0.160649 | +0.062571 | +0.278769 | 95 |  | + | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md:124` | research estimator on nflverse CSVs, not the shipped code path |
| L109 | 2026-09-22 | #68 | fantasy | other | Chosen k beats prior-only for rush_td_rate (select 2018-21, judge 2022-25) | MSE, research estimator | null both ways | +0.000023 | -0.000003 | +0.000051 | 95 |  | + | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md:125` | research estimator on nflverse CSVs, not the shipped code path |
| L110 | 2026-09-22 | #68 | fantasy | other | Chosen k beats prior-only for pass_td_rate (select 2018-21, judge 2022-25) | MSE, research estimator | split | +0.000018 | -0.000012 | +0.000049 | 95 |  | + | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md:126` | research estimator on nflverse CSVs, not the shipped code path |
| L111 | 2026-09-22 | #68 | fantasy | other | Part 2 sweep: ypc, ypa, rush_td_rate, pass_td_rate k on 2018-2025 (in-sample) | MSE | section 1 headline withdrawn |  |  |  |  |  |  | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants-rushing-passing.md:63` | withdrawn; not used for BH |
| L112 | 2026-09-22 | #68 | fantasy | other | Part 1 sweep: ypt, catch_rate, rec_td_rate k on 2018-2025 (in-sample) | MSE | margins selected and reported on the same rows; superseded by corrections doc |  |  |  |  |  |  | no | `docs/evidence/2026-09-22/efficiency-shrinkage-constants.md:49` | withdrawn in part (corrections doc); not used for BH |
| L113 | 2026-09-22 | #68 | fantasy | other | Oracle with the player leaking into his own feature | delta MSE | detected, and meaningless (leak) | +1.5496 | +1.2140 | +1.8945 | 95 |  |  | n.a. | `docs/evidence/2026-09-22/opponent-defence-the-oracle-was-the-player.md:90` |  |
| L114 | 2026-09-22 | #68 | fantasy | other | Ceiling: hindsight opponent defence, player removed (oracle) | delta MSE | no detection; declined on its own ceiling | +0.0533 | -0.0065 | +0.1156 | 95 |  |  | n.a. | `docs/evidence/2026-09-22/opponent-defence-the-oracle-was-the-player.md:91` |  |
| L115 | 2026-09-22 | #68 | fantasy | FL | Prior-weeks opponent pass defence improves the weekly projection | delta MSE, 5 held-out seasons | no detection (4/5 seasons) | +0.0265 | -0.0303 | +0.0831 | 95 |  | + | no | `docs/evidence/2026-09-22/opponent-defence-the-oracle-was-the-player.md:111` |  |
| L116 | 2026-09-22 | #68 | fantasy | FL | Adding own protection alone improves the weekly projection | PPR MAE, 2018-2025 OOS | not detected | +0.0004 | -0.0009 | +0.0016 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:40` |  |
| L117 | 2026-09-22 | #68 | fantasy | FL | Adding matchup (opp rush − own protection) improves the weekly projection | PPR MAE, 2018-2025 OOS | not detected | +0.0006 | -0.0024 | +0.0036 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:41` |  |
| L118 | 2026-09-22 | #68 | fantasy | FL | Adding sack and hit matchups improves the weekly projection | PPR MAE, 2018-2025 OOS | not detected | +0.0003 | -0.0028 | +0.0036 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:42` |  |
| L119 | 2026-09-22 | #68 | fantasy | FL | Adding opponent pass-rush rate improves the weekly projection | PPR MAE, 2018-2025 OOS | detected pooled, failed split-half replication | +0.0040 | +0.0010 | +0.0071 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:43` |  |
| L120 | 2026-09-22 | #68 | fantasy | FL | Adding opponent pass EPA allowed improves the weekly projection | PPR MAE, 2018-2025 OOS | detected pooled, failed split-half replication | +0.0110 | +0.0073 | +0.0147 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:44` |  |
| L121 | 2026-09-22 | #68 | fantasy | FL | Pass-rush on top of pass EPA allowed | PPR MAE | not detected across three seeds | +0.0012 | -0.0002 | +0.0027 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:60` |  |
| L122 | 2026-09-22 | #68 | fantasy | other | Split-half replication, opponent pass-rush, 2022-2025 half | PPR MAE | not replicated | -0.0007 | -0.0042 | +0.0028 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:69` | 2022-2025 column |
| L123 | 2026-09-22 | #68 | fantasy | other | Split-half replication, opponent pass EPA allowed, 2022-2025 half | PPR MAE | not replicated | -0.0018 | -0.0043 | +0.0005 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md:70` | 2022-2025 column |
| L124 | 2026-09-22 | #68 | fantasy | FL | Adding practice status (dnp/limited/full) improves the weekly projection | PPR MAE, 2018-2025 OOS | not detected | +0.0007 | -0.0032 | +0.0047 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-practice-participation-measurement.md:57` |  |
| L125 | 2026-09-22 | #68 | fantasy | FL | Adding report status (questionable/doubtful) improves the weekly projection | PPR MAE, 2018-2025 OOS | not detected | +0.0010 | -0.0020 | +0.0041 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-practice-participation-measurement.md:58` |  |
| L126 | 2026-09-22 | #68 | fantasy | FL | Adding both improves the weekly projection | PPR MAE, 2018-2025 OOS | not detected | +0.0006 | -0.0034 | +0.0047 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-practice-participation-measurement.md:59` |  |
| L127 | 2026-09-22 | #68 | fantasy | FL | Adding red-zone inside-20 touches improves TD prediction | TD MSE, 2018-2025 OOS | not detected | +0.00025 | -0.00015 | +0.00063 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:36` |  |
| L128 | 2026-09-22 | #68 | fantasy | FL | Adding red-zone inside-10 touches improves TD prediction | TD MSE, 2018-2025 OOS | not detected | +0.00015 | -0.00012 | +0.00042 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:37` |  |
| L129 | 2026-09-22 | #68 | fantasy | FL | Adding red-zone both zones touches improves TD prediction | TD MSE, 2018-2025 OOS | not detected | +0.00018 | -0.00023 | +0.00058 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:38` |  |
| L130 | 2026-09-22 | #68 | fantasy | FL | Adding red-zone inside-20 touches improves PPR prediction | PPR MSE, 2018-2025 OOS | not detected | +0.01966 | -0.01292 | +0.05235 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:40` |  |
| L131 | 2026-09-22 | #68 | fantasy | FL | Adding red-zone inside-10 touches improves PPR prediction | PPR MSE, 2018-2025 OOS | not detected | -0.00426 | -0.01584 | +0.00642 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:41` |  |
| L132 | 2026-09-22 | #68 | fantasy | other | Power check: red-zone touches against a weak baseline | TD MSE | DETECTED (instrument check) |  |  |  |  |  |  | n.a. | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:58` |  |
| L133 | 2026-09-22 | #68 | fantasy | FL | Red-zone touches, interaction variant 1 | TD MSE | not detected | +0.00004 | -0.00039 | +0.00048 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:68` |  |
| L134 | 2026-09-22 | #68 | fantasy | FL | Red-zone touches interacted with position | TD MSE | not detected | +0.00007 | -0.00038 | +0.00049 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:69` |  |
| L135 | 2026-09-22 | #68 | fantasy | FL | Red-zone touches interacted with snap share | TD MSE | not detected | +0.00018 | -0.00017 | +0.00051 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md:69` |  |
| L136 | 2026-09-22 | #68 | fantasy | FL | Route share and targets-per-route improve the weekly projection | PPR MAE, 25,323 OOS predictions 2018-2025 | does not clear zero | -0.0010 | -0.0027 | +0.0008 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-routes-run-lift-proof.md:23` |  |
| L137 | 2026-09-22 | #68 | fantasy | FL | Route share on top of snap share | PPR MAE | nothing | -0.0007 | -0.0018 | +0.0005 | 95 |  | + | no | `docs/evidence/2026-09-22/phase-a-routes-run-lift-proof.md:27` |  |
| L138 | 2026-09-22 | #68 | fantasy | other | Route share vs snap share as the volume feature | PPR MAE | indistinguishable | +0.0008 | -0.0035 | +0.0055 | 95 |  |  | n.a. | `docs/evidence/2026-09-22/phase-a-routes-run-lift-proof.md:56` |  |
| L139 | 2026-09-22 | #68 | fantasy | other | Contamination check: is the shipped arm in-sample (2022-2025) | targets MAE | premise does not hold; fractions stand | +0.1006 | +0.0950 | +0.1062 | 95 |  |  | n.a. | `docs/evidence/2026-09-22/snap-volume-is-partly-forecastable.md:90` |  |
| L140 | 2026-09-22 | #68 | fantasy | other | Snap forecast arm std` season-to-date beats naive (judged 2022-2025) | targets MAE | worse than naive | -0.0124 | -0.0166 | -0.0082 | 95 |  | + | no | `docs/evidence/2026-09-22/snap-volume-is-partly-forecastable.md:118` | PROXY data, not the production pipeline |
| L141 | 2026-09-22 | #68 | fantasy | other | Snap forecast arm trail3` last three weeks beats naive (judged 2022-2025) | targets MAE | beats naive | +0.0384 | +0.0247 | +0.0516 | 95 |  | + | no | `docs/evidence/2026-09-22/snap-volume-is-partly-forecastable.md:119` | PROXY data, not the production pipeline |
| L142 | 2026-09-22 | #68 | fantasy | other | Snap forecast arm ewma` alpha 0.4 beats naive (judged 2022-2025) | targets MAE | best causal arm | +0.0588 | +0.0465 | +0.0716 | 95 |  | + | no | `docs/evidence/2026-09-22/snap-volume-is-partly-forecastable.md:120` | PROXY data, not the production pipeline |
| L143 | 2026-09-22 | #68 | fantasy | other | EWMA snap forecast beats the R&D trail3 stand-in (2022-2025) | targets MAE | partly reachable (about 1/8 to 1/7 of perfect snaps) | +0.0204 | +0.0159 | +0.0247 | 95 |  | + | no | `docs/evidence/2026-09-22/snap-volume-is-partly-forecastable.md:137` |  |
| L144 | 2026-09-22 | #68 | fantasy | other | Start/sit win rate by projection margin (2018-2025 OOS) | pairwise decision win rate | curve re-derived; research baseline, not production week_points |  |  |  |  |  |  | yes (DECISION_CURVE, lineup-brain.js:268) | `docs/evidence/2026-09-22/start-sit-decision-curve.md:150` |  |
| L145 | 2026-09-22 | #68 | fantasy | FL | Per-position target-share prior beats the single 0.06 prior (pre-registered primary) | targets MAE, weeks played, 2,367 player-weeks | branch 1 fired; observed +0.1044 | +0.1044 | +0.0680 | +0.1437 | 90 |  | + | no (default-off, sharePrior flag) | `docs/evidence/2026-09-22/target-share-prior-result.md:56` | section 5 prints [+0.0661, +0.1460] for the same comparison |
| L146 | 2026-09-22 | #68 | fantasy | FL | Same, pre-registered secondary: rows with 3-5 prior games | targets MAE, 554 rows | larger than primary | +0.1740 | +0.1052 | +0.2403 | 90 |  | + | no | `docs/evidence/2026-09-22/target-share-prior-result.md:112` |  |
| L147 | 2026-09-22 | #68 | fantasy | FL | Same prior on the availability-inclusive metric | decision_including_dnp MAE | null | -0.0136 | -0.0499 | +0.0225 | 90 |  | + | no | `docs/evidence/2026-09-22/target-share-prior-result.md:131` |  |
| L148 | 2026-09-22 | #68 | fantasy | other | De-biased (level removed) comparison, conditional metric | de-biased MAE | observed +0.1269 | +0.1269 | +0.0965 | +0.1573 | 90 |  | + | no | `docs/evidence/2026-09-22/target-share-prior-result.md:153` | +0.1273 was the bootstrap mean, withdrawn as a point estimate (Auditor R51.2) |
| L149 | 2026-09-22 | #68 | fantasy | other | De-biased comparison, incl. DNP metric | de-biased MAE | observed +0.0482 | +0.0482 | +0.0249 | +0.0713 | 90 |  | + | no | `docs/evidence/2026-09-22/target-share-prior-result.md:155` |  |
| L150 | 2026-09-22 | #68 | fantasy | other | How far the weekly model sits below its ceiling (2018-2025 OOS) | MAE headroom | +0.4258 inside bracket [+0.0895, +0.5940]; cite the bracket | +0.4258 | +0.3948 | +0.4538 | 95 |  |  | n.a. | `docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md:185` |  |
| L151 | 2026-09-22 | #92 | fantasy | other | Which half (rushing or receiving tiers) earns the four-tier gain | TD MAE | script scores 2025; no result recorded in any doc |  |  |  |  |  |  | n.a. | `docs/evidence/redzone-tier-decomposition.mjs:26` | artifact with no reporting .md |
| L152 | 2026-09-22 | #92 | fantasy | FL | Four red-zone tiers beat three for expected touchdowns | TD MAE, 5,229 player-weeks | improvement real, -0.68% MAE; TD bias slightly worse | -0.001859 | -0.002678 | -0.000125 | 95 |  | - | yes | `docs/tdd/redzone-tiers.tdd.md:95` |  |
| L153 | 2026-09-22 | #106 | fantasy | FL | Unit-1 volume-shrinkage fit beats hardcoded k (CRPS gate) | CRPS, 4,532 player-weeks | result not reported in docs/; local DB row note says activated, active column 0 |  |  |  |  |  |  | unclear (row note vs active=0) | `docs/tdd/shrinkage-fit-efficiency-weighting-2026-09-22.tdd.md:143` | origin out of scope (local shrinkage_fits row; Auditor verdict in handoff memory gridiron-audit-unit-1-verdict) |
| L154 | 2026-09-23 | CE-05 (branch claude/local-ce-05-league-rules) | fantasy | other | league-rules seedStandings reproduces every stored ESPN playoff seed (rule check, not a model) | seeds equal / teams, league_season_teams | PASSED: 2025 26/26 (3 leagues); 2023-2024 36/36; plain wins-then-points control 8/10 in league 2 2023 and 2024 |  |  |  |  |  |  | yes | `docs/evidence/2026-09-23/league-rules-replay.md` | not a model fit; settings for past seasons are the 2026 payload's (guess) |

## 2026 forward looks

`STATS-METHOD.md` rule 5 gates a ship on the 2026 weeks already played, and
every such check is a look at 2026. Record it here with the same columns and an
`F` id (F001, F002, ...), so 2026 is not spent silently the way 2025 was.
The BH command reads only `L` rows.

Two sources of `F` rows besides a unit's own rule-5 check:

- **Job fits.** Every `weekly_ensemble_fits` row with `through_season >= 2026`,
  written by `saveWeeklyFit` (`server/services/weekly-weight-store.js:140`), is a
  2026 forward look, promoted or not. Rows come from `retrainWeeklyWeights`
  (`server/services/weekly-learning.js:224`) or from the hand-run promotion
  scripts through `promoteWeeklyFitChecked` (`weekly-weight-store.js:174`). The
  same query catches both. Two jobs call the retrain:
  `nfl_weekly_learning` (`weekly-learning.js:407`) and `nfl_model_growth`
  (`server/services/nfl-model-growth.js:308`). Neither writes this ledger, so
  the next statistical unit logs any such row here, whichever job wrote it
  (`STATS-METHOD.md` rule 5).
- **Registry openings of 2026.** A `model_backtests` row with protocol
  `sealed_holdout` and season 2026 (`server/routes/model.js:348-349`).

| id | date | unit/PR | domain | family | hypothesis | metric | result | est | lo | hi | level | p (source) | better | shipped | file:line | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F001 | 2026-09-23 | CE-05 (branch claude/local-ce-05-league-rules) | fantasy | other | league-rules seedStandings reproduces the current ESPN seeds (teams[].playoffSeed) after 2 weeks | seeds equal / teams, leagues.payload | PASSED: 46/46 across 5 leagues |  |  |  |  |  |  | yes | `docs/evidence/2026-09-23/league-rules-replay.md` | rule check, not a model; no job fit or registry opening |
| F005 | 2026-09-23 | RL-11-1 (branch claude/local-rl-11-1-activity-receptiveness) | fantasy | other | the activity receptiveness term (adds per week + has traded) ranks 2026 teams that complete a trade in week w+1, w = 1-2 | within-league-week AUC, league_transactions_raw (local copy) | HOLDS by rule 5 (point > 0.5), anecdote-sized: 20 team-weeks, 6 trade sides, 1 league | 0.6875 |  |  |  |  | higher | no (default-off: 2024 held-out AUC 0.6439 missed its 0.645 bar) | `docs/tdd/2026-09-23-activity-receptiveness.tdd.md` | no interval (one league); MDE80 0.359; an earlier run on ce7d6137 with a trade-count bug gave 0.7568, superseded |
| F006 | 2026-09-23 | RL-11-1 (branch claude/local-rl-11-1-activity-receptiveness) | fantasy | other | re-run of F005 after skeptic review: same data and function, the dead-start producer now matches names through normalizePlayerName, and the interval is the pre-registered team-cluster bootstrap | within-league-week AUC, league_transactions_raw (local copy) | HOLDS by rule 5 on the team-cluster interval, anecdote-sized: 20 team-weeks, 6 trade sides, 1 league, 10 teams | 0.6875 | 0.4667 | 0.8833 | 0.90 |  | higher | no (default-off: 2024 held-out AUC 0.6439 missed its 0.645 bar) | `docs/tdd/2026-09-23-activity-receptiveness.tdd.md` | F005's 'no interval' came from resampling leagues, a deviation from the pre-registration; MDE80 0.359 |

Before F001 there were none. On a local copy (not production, 2026-09-22), `weekly_ensemble_fits`
has 2 rows, both through 2025 week 18 (the known-nonzero control), and
`model_backtests` has 0 rows.

## File classification: every file the census returns

| file | class | rows | why |
|---|---|---|---|
| `docs/evidence/2026-09-01/NFL_AUDIT_RUN_8_MANIFEST.json` | ARTIFACT | 0 | run 8 manifest; reported at historical/BETTING_CAPABILITY_AUDIT-evidence.md |
| `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md` | LOOK | 2 | run 27 spread record; role-changepoint F1 (tree lab and role scenarios restated) |
| `docs/evidence/2026-09-09/run31-completed-comparison.json` | ARTIFACT | 0 | run 31 comparison; reported at 2026-09-09/AUDIT-EVIDENCE.md |
| `docs/evidence/2026-09-10/CODEX-6-HANDOFF.md` | LOOK | 1 | Wong window incl. 2025; game_lines 2025 corruption |
| `docs/evidence/2026-09-10/DECISION-RECORD.md` | RESTATE | 0 | run 27 record from AUDIT-EVIDENCE.md |
| `docs/evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md` | LOOK | 1 | family contribution on 2021-2025 games |
| `docs/evidence/2026-09-10/family-contribution-2021-2025.json` | ARTIFACT | 0 | reported at 2026-09-10/IMPLEMENTATION-SUMMARY.md |
| `docs/evidence/2026-09-10/slice-final/baseline-suite-before.txt` | ARTIFACT | 0 | test log; test names mention held-out |
| `docs/evidence/2026-09-10/slice-final/ci-conditions-suite.txt` | ARTIFACT | 0 | test log; test names mention held-out |
| `docs/evidence/2026-09-10/superseded-plan-2026-09-09.md` | PLAN | 0 | superseded plan |
| `docs/evidence/2026-09-11/RETURN-TO-CODEX.md` | LOOK | 1 | Wong recount 1999-2025 vs 1999-2024; ensemble edge |
| `docs/evidence/2026-09-12/ENSEMBLE-RANK-STAGE-1.md` | PLAN | 0 | real-data run not executed; command only |
| `docs/evidence/2026-09-12/FORECAST-COMBINATION-STAGE-2.md` | PLAN | 0 | measured on 2022-2024 fixture; 2025 only in a proposed command |
| `docs/evidence/2026-09-12/JOINT-SCORING-STAGE-3.md` | NOISE | 0 | held-out seasons are 2022-2024 |
| `docs/evidence/2026-09-12/governed-reevaluation.json` | ARTIFACT | 0 | reported at integration-reports/MODEL_BUILD_REPORT.md (2022-2024 fixture) |
| `docs/evidence/2026-09-12/joint-score-report-football.json` | ARTIFACT | 0 | "2025" is a number (p 0.2025) |
| `docs/evidence/2026-09-12/joint-score-report-gaussian.json` | ARTIFACT | 0 | "2025" is a number (8.2025) |
| `docs/evidence/2026-09-13/STAGE_2_PURGED_EVALUATION.md` | LOOK | 1 | PBO over 2022-2025 |
| `docs/evidence/2026-09-13/historical-leaderboard-report.json` | ARTIFACT | 0 | reported at integration-reports/HISTORICAL_VERDICT_REPORT.md |
| `docs/evidence/2026-09-13/integration-reports/BETTING_INSANE_REPORT.md` | LOOK | 1 | walk-forward on 2023-2025 team observations |
| `docs/evidence/2026-09-13/integration-reports/BETTING_MODEL_REPORT.md` | RESTATE | 0 | quotes unverifiable branch claims (m4, m5) on 2022-2025 |
| `docs/evidence/2026-09-13/integration-reports/GIANT_PLAN_BUILD_REPORT.md` | NOISE | 0 | copied 2025->2026 QBR rows (data fix) |
| `docs/evidence/2026-09-13/integration-reports/HISTORICAL_VERDICT_REPORT.md` | LOOK | 1 | five held-out seasons 2021-2025 |
| `docs/evidence/2026-09-13/integration-reports/MODEL_BUILD_REPORT.md` | PLAN | 0 | 408 held-out games 2022-2024 fixture; 2025 only in commands |
| `docs/evidence/2026-09-13/integration-reports/NEWS_TIMING_REPORT.md` | COVERAGE | 0 | news archive coverage |
| `docs/evidence/2026-09-13/integration-reports/PIPELINE_REPORT.md` | NOISE | 0 | holdout isolation prose |
| `docs/evidence/2026-09-13/integration-reports/PROPS_TO_SPREAD_REPORT.md` | LOOK | 1 | 2023-2025 test window |
| `docs/evidence/2026-09-13/integration-reports/UNIFICATION_AND_HISTORICAL_REPORT.md` | RESTATE | 0 | reproduces HISTORICAL_VERDICT_REPORT; sigma fit 2021-2025 |
| `docs/evidence/2026-09-13/integration-reports/UNIFICATION_REPORT.md` | NOISE | 0 | holdout semantics prose |
| `docs/evidence/2026-09-13/purged-evaluation-report.json` | ARTIFACT | 0 | reported at 2026-09-13/STAGE_2_PURGED_EVALUATION.md |
| `docs/evidence/2026-09-15/BETTING-MODEL-AUDIT-AND-PROFIT-PLAN.md` | PLAN | 0 | plan; ridge-s2025 artifact id |
| `docs/evidence/2026-09-15/BETTING-MODEL-MASTER-PLAN.md` | PLAN | 0 | plan |
| `docs/evidence/2026-09-15/BETTING-MODEL-UNIFIED-PLAN.md` | PLAN | 0 | plan |
| `docs/evidence/2026-09-15/LINEAR-IMPORT.md` | PLAN | 0 | plan |
| `docs/evidence/2026-09-15/STAGE-1-BASELINE-FREEZE.md` | NOISE | 0 | field name untouched_holdout |
| `docs/evidence/2026-09-15/STATUS.md` | RESTATE | 0 | family contribution from IMPLEMENTATION-SUMMARY.md |
| `docs/evidence/2026-09-16/data-lineage-report.md` | NOISE | 0 | migration file name |
| `docs/evidence/2026-09-16/news-line/availability_model_tables.md` | LOOK | 1 | availability models walk-forward incl. 2025 |
| `docs/evidence/2026-09-16/opener-clv/summary.md` | LOOK | 1 | opener CLV pooled 2022-2025 |
| `docs/evidence/2026-09-17/recovery/DATA-CATALOG.md` | COVERAGE | 0 | table date ranges |
| `docs/evidence/2026-09-20/AUDIT-FINDINGS-LEDGER.md` | RESTATE | 0 | D27, D30-D33 from MODEL-AUDIT-2026-09-20.md |
| `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md` | LOOK | 15 | opportunity vs baselines; efficiency grid; efficiency fitter |
| `docs/evidence/2026-09-20/cascade-grade.json` | ARTIFACT | 0 | reported at docs/tdd/cascade-grade.tdd.md |
| `docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-PREREGISTRATION.md` | PLAN | 0 | pre-registration; states "No 2025" |
| `docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-RESULTS.md` | NOISE | 0 | out-of-sample means 2021, 2022 (no 2025) |
| `docs/evidence/2026-09-22/coupled-prior-and-availability-preregistration.md` | PLAN | 0 | pre-registration; restates target-share result |
| `docs/evidence/2026-09-22/efficiency-shrinkage-constants-corrections.md` | LOOK | 7 | out-of-sample re-test judged on 2022-2025 |
| `docs/evidence/2026-09-22/efficiency-shrinkage-constants-rushing-passing.md` | LOOK | 1 | in-sample sweep 2018-2025 (withdrawn in part) |
| `docs/evidence/2026-09-22/efficiency-shrinkage-constants.md` | LOOK | 1 | in-sample sweep 2018-2025 (superseded in part) |
| `docs/evidence/2026-09-22/fourth-down-rate-unit-mismatch.md` | COVERAGE | 0 | descriptive team-season values 2018-2025 |
| `docs/evidence/2026-09-22/last-week-points-as-a-projection-trace.md` | RESTATE | 0 | early-week-blend 2025 numbers |
| `docs/evidence/2026-09-22/model-rows-654ff93.json` | ARTIFACT | 0 | script name nfl-2022-2025-rebuild |
| `docs/evidence/2026-09-22/model-rows-fragment.json` | ARTIFACT | 0 | script name nfl-2022-2025-rebuild |
| `docs/evidence/2026-09-22/opp-adj-def-epa-wiring-audit.md` | RESTATE | 0 | OL-vs-DL split-half numbers |
| `docs/evidence/2026-09-22/opponent-defence-the-oracle-was-the-player.md` | LOOK | 3 | opponent defence, 5 held-out seasons incl. 2025 |
| `docs/evidence/2026-09-22/phase-a-ol-vs-dl-lift-proof.md` | LOOK | 8 | OL-vs-DL, 2018-2025 OOS |
| `docs/evidence/2026-09-22/phase-a-practice-participation-measurement.md` | LOOK | 3 | practice participation, 2018-2025 OOS |
| `docs/evidence/2026-09-22/phase-a-red-zone-inside-10-lift-proof.md` | LOOK | 9 | red-zone inside 10, 2018-2025 OOS |
| `docs/evidence/2026-09-22/phase-a-routes-run-lift-proof.md` | LOOK | 3 | routes run, 2018-2025 OOS |
| `docs/evidence/2026-09-22/phase-a-routes-run-source-audit.md` | COVERAGE | 0 | source coverage 2016-2025 |
| `docs/evidence/2026-09-22/same-week-leakage-sweep.md` | FIT | 0 | absorption table fitted on 2021-2025 |
| `docs/evidence/2026-09-22/snap-volume-is-partly-forecastable.md` | LOOK | 5 | judged on 2022-2025 |
| `docs/evidence/2026-09-22/start-sit-decision-curve.md` | LOOK | 1 | decision curve over 2018-2025 OOS |
| `docs/evidence/2026-09-22/target-share-prior-preregistration.md` | PLAN | 0 | pre-registration |
| `docs/evidence/2026-09-22/target-share-prior-result.md` | LOOK | 5 | held-out 2025 |
| `docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md` | LOOK | 1 | ceiling over 2018-2025 OOS |
| `docs/evidence/ablation-tiers.mjs` | ARTIFACT | 0 | identical to redzone-tier-ablation.mjs; reported at docs/tdd/redzone-tiers.tdd.md |
| `docs/evidence/baselines/2025-baseline-pre-stage1.json` | ARTIFACT | 0 | reported at historical/STAGE_1_RESULTS.md |
| `docs/evidence/baselines/2025-baseline.json` | ARTIFACT | 0 | freeze-baseline output; see STAGE_1_RESULTS.md |
| `docs/evidence/baselines/2025-weekly-distribution-draws.json` | ARTIFACT | 0 | reported at docs/tdd/review-fixes.tdd.md |
| `docs/evidence/contracts/beat-the-close-original.md` | PLAN | 0 | frozen experiment contract |
| `docs/evidence/contracts/research-packages-2026-09-08.md` | LOOK | 1 | tree/AutoML lab 2023-2025 (first in-scope report) |
| `docs/evidence/feed-zero-contamination-measured.md` | COVERAGE | 0 | row counts per season |
| `docs/evidence/fourth-down-units.mjs` | ARTIFACT | 0 | descriptive query 2022-2025 |
| `docs/evidence/historical/ADP_DISAGREEMENT.md` | LOOK | 3 | held-out 2023-2025 |
| `docs/evidence/historical/ADP_REPRICE_LATENCY.md` | LOOK | 2 | held-out 2023-2025 |
| `docs/evidence/historical/BETTING_CAPABILITY_AUDIT-evidence.md` | LOOK | 1 | reports audit run 8 (2022-2025); rest is proposals |
| `docs/evidence/historical/BETTING_PLAYER_ENGINES.md` | LOOK | 1 | held-out 2023-2025 |
| `docs/evidence/historical/CONSENSUS_WEIGHTS.md` | LOOK | 6 | held-out 2023-2025 |
| `docs/evidence/historical/DIAGNOSTIC_2026_09_02.md` | LOOK | 2 | 2025 held out; 2024-2025 held out |
| `docs/evidence/historical/DRAFT_AUDIT_2021_2025.md` | LOOK | 1 | ECR vs realized 2021-2025 |
| `docs/evidence/historical/DRAFT_BOARD_ABSTENTION.md` | LOOK | 1 | held-out 2023-2025 |
| `docs/evidence/historical/DRAFT_LOOKAHEAD_VARIANCE.md` | FIT | 0 | SPREAD_SD_CALIBRATION 1.30 solved on 2023-2025 rows |
| `docs/evidence/historical/LIVE_BETTING_FEASIBILITY-evidence.md` | PLAN | 0 | proposal |
| `docs/evidence/historical/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08-evidence.md` | LOOK | 2 | first in-scope report of role-scenario 2025 holdout |
| `docs/evidence/historical/MODEL_AUDIT_RUN_7.md` | LOOK | 1 | run 7 2021-2025 |
| `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md` | LOOK | 6 | held-out 2023-2025 |
| `docs/evidence/historical/PROPS_PLAYER_ENGINES.md` | LOOK | 1 | held-out 2023-2025 |
| `docs/evidence/historical/PROPS_PLAYER_ENGINES_WEEKLY.md` | LOOK | 1 | held-out 2023-2025 |
| `docs/evidence/historical/STAGE_1_RESULTS.md` | LOOK | 8 | validate on 2025 |
| `docs/evidence/historical/STAGE_2_RESULTS.md` | LOOK | 2 | 2022-2025 walk-forward; 2025 gate re-run |
| `docs/evidence/historical/build-order-measurements.md` | RESTATE | 0 | STAGE_1_RESULTS and model-diagnostic numbers |
| `docs/evidence/historical/execution-work-through-2026-09-08.md` | COVERAGE | 0 | archive coverage |
| `docs/evidence/historical/model-diagnostic-2026-08-26.md` | LOOK | 2 | fantasy 2025 held out; props 2022-2025 |
| `docs/evidence/historical/nfl-model-status-through-2026-08-30.md` | LOOK | 1 | replay 2021-2025 |
| `docs/evidence/historical/platform-audit-2026-08-24-findings.md` | NOISE | 0 | prose |
| `docs/evidence/historical/profitability-baselines.md` | LOOK | 1 | baseline 2022-2025 |
| `docs/evidence/historical/session-results-2026-09-07.md` | LOOK | 4 | first in-scope report of preseason/offseason model held-out results |
| `docs/evidence/historical/status-narrative-2026-09-02-facts.md` | RESTATE | 0 | betting record 2022-2025 |
| `docs/evidence/history/WORK_LOG.md` | LOOK | 6 | offseason factor on 2025; props and teasers |
| `docs/evidence/redzone-tier-ablation.mjs` | ARTIFACT | 0 | reported at docs/tdd/redzone-tiers.tdd.md |
| `docs/evidence/redzone-tier-decomposition.mjs` | ARTIFACT | 1 | scores 2025; no reporting doc, so it originates its own row |
| `docs/tdd/2026-09-22-depth-zero-rows-loud.md` | NOISE | 0 | schema label 2025+ |
| `docs/tdd/availability-honest-degradation.tdd.md` | NOISE | 0 | test fixture weeks |
| `docs/tdd/beat-reporter-accuracy-injury-status.tdd.md` | COVERAGE | 0 | code hand-check on real 2025 records; no prediction scored |
| `docs/tdd/beat-reporter-accuracy-return-from-injury.tdd.md` | COVERAGE | 0 | code hand-check on real 2025 records |
| `docs/tdd/beat-reporter-accuracy-role-change.tdd.md` | COVERAGE | 0 | code hand-check on real 2025 records |
| `docs/tdd/beat-reporter-accuracy-suspension.tdd.md` | COVERAGE | 0 | code hand-check on real 2025 records |
| `docs/tdd/cascade-grade.tdd.md` | LOOK | 4 | graded 2024 and 2025 |
| `docs/tdd/ceiling-lineup-recency.tdd.md` | NOISE | 0 | test fixture |
| `docs/tdd/coach-table-origins.tdd.md` | NOISE | 0 | script name |
| `docs/tdd/consensus-season.tdd.md` | PLAN | 0 | "a held-out test would look like" |
| `docs/tdd/data-freshness-rule-contract.tdd.md` | COVERAGE | 0 | fixture coverage 2021-2025 |
| `docs/tdd/data-freshness.tdd.md` | COVERAGE | 0 | coverage 2021-2025 |
| `docs/tdd/early-week-blend.tdd.md` | LOOK | 3 | gate G1-G3 on 2024 and 2025 |
| `docs/tdd/evidence-report-guard-two-more.tdd.md` | NOISE | 0 | guard test on a seeded scratch DB |
| `docs/tdd/fake-floors.tdd.md` | LOOK | 2 | 2025 harness gate and D1 |
| `docs/tdd/feed-zero-averages.tdd.md` | PLAN | 0 | unmeasured seasons named |
| `docs/tdd/fourth-down-units.tdd.md` | COVERAGE | 0 | descriptive 2022-2025 |
| `docs/tdd/injury-participation-term.tdd.md` | FIT | 0 | rates fitted on 2021-2025, no held-out replay |
| `docs/tdd/league-history-writer.tdd.md` | PLAN | 0 | prose |
| `docs/tdd/llm-plumbing.tdd.md` | NOISE | 0 | model id |
| `docs/tdd/manager-data-pipeline.tdd.md` | NOISE | 0 | league name |
| `docs/tdd/participation-columns.tdd.md` | COVERAGE | 0 | HTTP probe and column presence |
| `docs/tdd/play-chance-gate-v2.md` | PLAN | 0 | pre-registration; result not in docs/evidence or docs/tdd |
| `docs/tdd/play-chance-live.tdd.md` | LOOK | 3 | G1-G3 on 2025, three runs |
| `docs/tdd/play-chance.tdd.md` | LOOK | 1 | scored once on 2025 |
| `docs/tdd/redzone-tiers.tdd.md` | LOOK | 1 | fit 2022-2024, scored once on 2025 |
| `docs/tdd/review-fixes-2.tdd.md` | LOOK | 1 | Vegas lift replay on 2025 |
| `docs/tdd/review-fixes.tdd.md` | LOOK | 2 | posture result; coverage draw/seed sensitivity |
| `docs/tdd/ros-projection.tdd.md` | LOOK | 1 | gate on 2024 and 2025 |
| `docs/tdd/route-splits.tdd.md` | PLAN | 0 | ablation gate could not run |
| `docs/tdd/shrinkage-fit-efficiency-weighting-2026-09-22.tdd.md` | LOOK | 1 | names the Unit-1 CRPS gate row test_season 2025 |
| `docs/tdd/start-sit-decision-curve.tdd.md` | RESTATE | 0 | decision curve from docs/evidence/2026-09-22/start-sit-decision-curve.md |
| `docs/tdd/swallowed-absence-rebuild-ensemble.tdd.md` | NOISE | 0 | script name |
| `docs/tdd/sweeps/EDITS.md` | NOISE | 0 | identifier off_ngs_season_2025 |
| `docs/tdd/sweeps/catalog.json` | ARTIFACT | 0 | identifier |
| `docs/tdd/sweeps/start-sit-decision-curve.mutations.json` | ARTIFACT | 0 | mutation spec text |
| `docs/tdd/tactics-and-packages.tdd.md` | NOISE | 0 | league name |
| `docs/tdd/trade-engine-correctness.tdd.md` | NOISE | 0 | league name |
| `docs/tdd/transactions-as-of.tdd.md` | COVERAGE | 0 | league season row |
| `docs/tdd/waiver-kicker-defense.tdd.md` | PLAN | 0 | "a held-out test would look like" |
| `docs/tdd/week2-numbers.tdd.md` | LOOK | 7 | gates validated on 2025 once |
| `docs/tdd/wiring-map-route-deletions.tdd.md` | NOISE | 0 | route description |
