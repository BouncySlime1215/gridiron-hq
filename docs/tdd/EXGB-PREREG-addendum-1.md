# E-XGB pre-registration, addendum 1 (2026-09-25): arm B2, actual points, model lock, shadow grader

Written 2026-09-25, before any confirmatory week (6-13) has kicked off, before any
confirmatory forecast exists, and before any 2026 week-3+ outcome was read. Everything in
`EXGB-PREREG.md` stands unless changed here.

## A1. Arm B2 added: the ESPN-corrector as a feature model (coordinator's request, 2026-09-25)

The registered arm B stays, renamed **B1**: `ESPN + lambda_B1 * (A - ESPN)`.

**B2** is added as a second corrector. It is secondary, has its own family of 4 position tests
(Holm within B2), and must never be described as independent of ESPN:

- `r(x, ESPN)` is an XGBoost model of `actual - ESPN`. Its inputs are the arm A panel features
  plus ESPN's projection.
- **Pretraining uses a proxy.** `r` is pretrained on RETROSPECTIVE ESPN for 2022-2025
  (fetched 2026-09-25 by `scripts/eval/exgb-espn-retro.mjs`, after the games). This conflicts
  with the original arm-B rule "never trained on retrospective ESPN values", which is why it
  is a separate arm and not a replacement.
- The final artifact also trains on 2026 frozen rows (weeks 2 up to the cutoff in A3).
- `B2 = ESPN + lambda_B2 * r`. `lambda_B2` is in [0, 1], fitted per position by least
  absolute error on **frozen** ESPN rows only (2026 weeks 2-5), with an `r` that never saw
  2026. The frozen data decides how much of the proxy-trained correction to trust;
  lambda = 0 means B2 is plain ESPN.

Frozen ESPN for weeks 2-5:

- Week 2 is the 2026-09-17 22:08Z `espn_player_market_weekly` capture, which predates that
  week's first kickoff.
- Weeks 3-5 come from `espn_weekly_projection_snapshots` through the grading rule (latest
  capture strictly before the player's kickoff, never a late row).

**B1's lambda** is also fitted with an arm-A model trained on 2022-2025 only, so both
lambdas are fitted out of sample.

## A2. Actual points

`player_week_usage` has no two-point conversions, which section 4 counts. The actual is
therefore:

- nflverse's full-PPR `nfl_ffopportunity_weekly.actual_fantasy_points` where present. It
  matched section 4's formula exactly on 96% of 2025 rows and differs by the 2-point plays.
- Otherwise the section 4 formula without 2-point plays, reported as `n_actual_fallback` by
  position and week.

## A3. Model lock

**Settings are locked now**, in `scripts/eval/exgb-lock.json`, committed with this addendum.
It holds:

- the feature list;
- per position, arm A (XGBoost; LightGBM secondary) and B2's residual model, chosen by the
  section 1 rule: rolling-origin folds validating 2023, 2024 and 2025, 12 settings per grid,
  lowest mean validation MAE, 2022-2025 data only;
- the seed;
- the SHA-256 of `exgb_panel.py`, `exgb_arms.py` and `exgb_shadow.py`. The predictor refuses
  to run if any of them changes.

**Artifacts** are a deterministic function of the lock and the data:

- The run is `exgb_shadow.py fit --through-week 5`, on a read-only copy of the live DB taken
  after week 5's finals are ingested (Tuesday 2026-10-13 or Wednesday 2026-10-14).
- The artifact and manifest hashes are committed in addendum 2 **before 2026-10-15 20:15 ET**.
- If addendum 2 misses that time, grading starts with the first week whose first kickoff
  follows it. The 6-week minimum still applies, and "not run" is possible.
- The settings in the lock cannot change after this commit. A code fix that changes a hash
  needs its own addendum before week 6, stating that no setting changed
  (`exgb_lock.py --rehash`).

## A4. Shadow logging and grading (the flag)

- `GRIDIRON_EXGB=1` (its own flag; preview mode never sets it) runs the shadow pipeline:
  - `exgb_shadow_predict` forecasts every arm at each ESPN capture window (Tuesday after
    waivers, Saturday morning, 2 h before each kickoff) into the append-only
    `exgb_shadow_predictions`.
  - `exgb_weekly_grade` grades each finished week into the append-only
    `exgb_weekly_grades`.
- **The graded forecast** is the latest one strictly before the player's kickoff (never a
  late row), with our projection as the counted fallback (section 3).
- **Running rows are provisional.** Every weekly running Holm result before the outcome
  freeze is marked provisional; the result of record is the read at the freeze
  (2026-12-15).
- Weeks 2-5 are graded too, but as exploratory rows (`confirmatory = 0`).
- Nothing is served. Wiring a passing position into projections is still section 8, and
  happens after the result of record.
