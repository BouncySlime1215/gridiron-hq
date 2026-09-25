# E-XGB pre-registration: can a per-position tree model beat FROZEN ESPN weekly projections?

Status: registered 2026-09-25, before any 2026 week-6+ outcome exists and before any
model's 2026 confirmatory predictions are made. Any change after this commit is an
addendum (`EXGB-PREREG-addendum-N.md`) with its reason and date, and cannot touch the
confirmatory weeks' results once one of them has kicked off.

Background: evidence note M3 (Princeton 2026 thesis: XGBoost 2.909 vs ESPN 3.074 weekly
PPR MAE on 2025, RB/WR/TE, with ESPN fetched after the fact; Wharton 2026: preseason,
ESPN better at RB/WR). Nothing here has been shown yet against ESPN numbers that are
proven to predate kickoff. This test is the proof, or the refutation.

## 1. Confirmatory window and calendar

- **Confirmatory weeks: 2026 regular-season weeks 6-13.** Week 6 opens Thursday
  2026-10-15 20:15 ET; week 13 ends Monday 2026-12-07.
- 2026 weeks 1-5 are development only: collection shakedown, tuning, and fitting the
  corrector arm's blend (section 5). They are never part of the confirmatory result.
- **Model lock:** the feature list, preprocessing, hyperparameters, seeds and trained
  artifacts for every arm are frozen in one commit before 2026-10-15 20:15 ET, and that
  commit's SHA is recorded in `EXGB-PREREG-addendum-1.md` in the same commit. The
  hyperparameter rule is fixed now: chronological rolling-origin folds (train seasons
  < s, validate season s, for s in 2023, 2024, 2025), pick the setting with the lowest
  mean validation MAE per position from a grid of at most 24 settings, then refit on
  2022-2025 plus 2026 weeks 1-5. No refit during weeks 6-13.
- **Outcome freeze:** actual points are read once, on or after 2026-12-15 (after week-13
  stat corrections), and that read is what is scored.

## 2. The three forecasts compared

| Name | What | Frozen how |
|---|---|---|
| ESPN | ESPN's weekly projected fantasy points, PPR defaults (`scoring_key = 'ppr'`) | `espn_weekly_projection_snapshots` via `frozenEspnForGrading`: the latest capture strictly before that player's own kickoff; rows with `late = 1` never count |
| Current | Our current weekly projection (`weekly_prediction_snapshots.prediction`) | the pregame snapshot (first write wins, refused once the slate starts) |
| Model | The E-XGB arm (section 5) | logged per player-game with a UTC timestamp strictly before that player's kickoff (candidate head in `weekly_prediction_snapshots.candidate_heads_json` or its own append-only table); a prediction stamped at or after kickoff is dropped and counted as missing |

## 3. Eligible population (primary)

Every QB, RB, WR and TE player-game in weeks 6-13 whose team plays that week and that has
**both** a frozen ESPN projection **and** a Current snapshot row. Included on purpose:
projections of zero, and players who then do not play (actual = 0 points). This is the
all-eligible population; it rewards forecasting who plays, as a lineup decision does.

- If the Model has no frozen prediction for an eligible player-game, the Model is scored
  with Current's number for it (a fallback, not a drop), and the fallback count is
  reported by position and week.
- Reported, never silently dropped: players absent from ESPN, failed ID joins, team
  changes, postponed or cancelled games (a game not played in its scheduled week is
  excluded, and listed), stat corrections.

## 4. Metric and test

- **Primary metric: MAE per position**, actual full-PPR points (1 per reception, 0.1 per
  rushing/receiving yard, 0.04 per passing yard, 6 per rushing/receiving TD, 4 per passing
  TD, -2 per interception, -2 per fumble lost, 2 per two-point conversion), from the
  nflverse weekly finals as read at the outcome freeze.
- Paired difference per player-game: `d = |actual - comparator| - |actual - model|`
  (positive favours the model). RMSE and its paired difference are secondary.
- **Uncertainty:** week-blocked paired bootstrap (resample the 8 weeks with replacement,
  keeping each week's player-games together), 10,000 draws, seed 20261015. One-sided
  p-value = share of draws with mean `d` <= 0.
- **Multiplicity: Holm across the 4 positions** at familywise alpha = 0.05, applied
  separately to the "vs ESPN" p-values and the "vs Current" p-values.

## 5. Arms

Each arm is its own family of four position tests (Holm within the arm).

- **Arm A, standalone (primary).** Per-position gradient-boosted trees (XGBoost; LightGBM
  as a pre-specified secondary) on lagged-only features: prior-week and trailing-3/5
  target share, snap share, carries, targets, air yards, red-zone share (when present),
  team implied total and spread as of before kickoff, injury status as of before
  kickoff, opponent points allowed to the position (trailing). No ESPN input of any
  kind.
- **Arm B, ESPN-corrector (secondary, never described as independent of ESPN).**
  `ESPN + lambda_pos * (ArmA - ESPN)`, with `lambda_pos` in [0, 1] fitted per position
  by least absolute error on 2026 weeks 2-5 frozen ESPN captures only (the only ESPN
  values whose timing is proven). It is never trained on retrospective ESPN values.

## 6. Pass bar (per position, per arm)

A position passes only if, over **at least 6 graded confirmatory weeks** (a week counts
when it has at least one valid pre-kickoff ESPN capture for the position), the model's
MAE is lower than **both** ESPN's and Current's by **>= 0.20 points AND >= 2%** of the
comparator's MAE, **and** both one-sided tests are significant after Holm. Fewer than 6
graded weeks means "not run", not "failed".

If the primary population passes but the played-only secondary does not, the result is
reported as an availability-forecasting win, not better point prediction for players who
play.

## 7. Secondary analyses (descriptive, no pass/fail)

Played-only; RMSE; per-week results; ESPN-projected starters vs fringe; pre-cutoff OUT
vs questionable vs active; capture lead time (Tuesday vs Saturday vs 2 h before);
league-4 scoring (`scoring_key = 'league:4'`) as a sensitivity check.

## 8. How a passing position feeds projections

- Only a position that passes in section 6 may be wired, and only behind its **own**
  flag, `GRIDIRON_EXGB` (off by default). It is never switched on by preview mode
  (`GRIDIRON_PREVIEW_UNCONFIRMED`) or any other flag.
- With the flag on, the model's number is logged as a shadow candidate head next to the
  served projection; the served number does not change until Nick explicitly approves
  serving it. A failing position is never wired.
- Independent replication: the next full season (2027) is the untouched confirmation;
  the flag's serving decision is re-checked against it.

## 9. What this pre-registration does not claim

The retrospective comparisons in `2026-09-25-exgb-retrospective.tdd.md` (2025 test
season, ESPN values fetched after the games) are exploratory. They carry exactly the
weakness of the Princeton thesis and cannot pass or fail anything here.
