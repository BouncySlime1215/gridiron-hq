<!-- prereg: docs/tdd/EXGB-PREREG.md -->
# E-XGB phase 1 — exploratory panel and tree models (RETROSPECTIVE, nothing served)

Exploratory only. The confirmatory test is `EXGB-PREREG.md` (frozen ESPN, 2026 weeks
6-13), committed before these numbers were produced. Nothing here passes or fails it.

## How it was run (2026-09-25)

1. Panel: `python3 scripts/eval/exgb_panel.py --db <clone of snapshots/data-ro.sqlite, 2026-09-24> --out panel.npz --leakage-check 200` (about 20 s).
2. ESPN retrospective: `node scripts/eval/exgb-espn-retro.mjs --season 2025 --weeks 1-18` (11,370 rows) and `--season 2026 --weeks 1-3` (1,630 rows), fetched 2026-09-25, written to a local file, never to a database.
3. Models: `~/gridiron-local/venv-ml/bin/python scripts/eval/exgb_models.py ...` (about 20 s, two threads). Two runs gave identical JSON.

## Panel

31,286 player-weeks (24,224 with a stat line; the rest are zero-point availability rows:
the player's team played, he had played in one of his previous 3 games, he had no line).
Rows (with a stat line):

| Position | 2022 | 2023 | 2024 | 2025 | 2026 (wk 1-2) |
|---|---|---|---|---|---|
| QB | 869 (633) | 893 (663) | 929 (664) | 940 (664) | 80 (76) |
| RB | 2,006 (1,581) | 1,909 (1,474) | 1,919 (1,536) | 1,930 (1,575) | 195 (182) |
| WR | 3,064 (2,387) | 3,062 (2,476) | 3,093 (2,441) | 3,183 (2,511) | 322 (303) |
| TE | 1,684 (1,207) | 1,619 (1,188) | 1,664 (1,223) | 1,753 (1,287) | 172 (153) |

Target check: the PPR formula matches nflverse's `actual_fantasy_points` to 0.077 points
MAE on 2024 (the gap is two-point conversions, which `player_week_usage` lacks).

**Leakage test:** 200 rows over 20 random weeks; every outcome from each week on was
perturbed and the panel rebuilt. 0 rows changed a feature; 149 of 149 played rows changed
their target. The unit test also plants a same-game feature and the check catches it.

### Features: available vs missing

| Feature | Status |
|---|---|
| prior-week, trailing-3 and trailing-5 target share, targets, receptions, carries, pass attempts, air-yards share, WOPR, receiving air yards, PPR | available (91% of rows have a prior game this season) |
| snap share (lag / trailing) | available, 87% |
| red-zone share (player RZ targets + carries / team's) | available, 79% lag-1 |
| expected fantasy points (ffopportunity), lagged | available, 80% lag-1 |
| team implied total, spread, game total | OPENING line, median across books, stamped before kickoff: 100% of 2022/2024/2025 rows, 94% of 2023; schedule line fallback flagged `line_src`; 2026 only 46% opening |
| injury status and practice DNP | available; it is the week's final report, and its as-of time is not proven (M3 caveat) |
| opponent points allowed to the position (trailing this season, and last season) | available, 95% / 100% |
| routes run / route participation | **missing**: no table holds it |
| pre-kickoff timestamps for injury reports | **missing** |

## Results (MAE, full-PPR points)

### 2025 test season vs ESPN — RETROSPECTIVE, NOT FROZEN

ESPN's 2025 numbers were fetched in September 2026, after the games — the same weakness
as the Princeton thesis. Nothing proves they are what ESPN showed before kickoff (see the
drift check below). Rows where ESPN has a projection:

| Position | n | XGBoost | LightGBM | Trailing mean | ESPN (retro) | weeks XGBoost beat ESPN |
|---|---|---|---|---|---|---|
| QB | 904 | 5.250 | 5.051 | 6.927 | **4.019** | 0/18 |
| RB | 1,839 | 3.891 | 3.792 | 4.272 | **3.535** | 0/18 |
| WR | 3,083 | 3.615 | 3.511 | 4.405 | **3.407** | 1/18 |
| TE | 1,658 | 3.026 | 2.958 | 3.583 | **2.829** | 2/18 |

The models beat the trailing mean at every position and lose to retrospective ESPN at
every position. This does not replicate the Princeton headline.

### 2025, all rows and played-only (no ESPN)

| Position | n all | XGB | LGBM | Trailing | n played | XGB | LGBM | Trailing |
|---|---|---|---|---|---|---|---|---|
| QB | 940 | 5.095 | 4.884 | 6.760 | 664 | 6.248 | 6.279 | 6.838 |
| RB | 1,930 | 3.740 | 3.640 | 4.124 | 1,575 | 4.276 | 4.256 | 4.345 |
| WR | 3,183 | 3.536 | 3.427 | 4.328 | 2,511 | 4.036 | 4.015 | 4.403 |
| TE | 1,753 | 2.894 | 2.813 | 3.426 | 1,287 | 3.419 | 3.430 | 3.607 |

Most of the models' edge over the trailing mean is availability: played-only, it shrinks
to 0.07-0.59 points.

### 2026 week 2 only (one week; our current projection exists only here)

Models fit on 2022-2024. ESPN "frozen" is the week-2 capture of 2026-09-17 22:08Z, before
that week's first kickoff (but up to 3 days before Sunday games).

| Position | n | XGB | LGBM | Trailing | Current (ours) | ESPN frozen | ESPN retro |
|---|---|---|---|---|---|---|---|
| QB | 42 | 6.20 | 6.04 | 7.50 | 7.66 | **5.82** | 6.12 |
| RB | 94 | 3.28 | **3.17** | 5.16 | 4.47 | 3.35 | 3.09 |
| WR | 160 | 4.04 | **4.00** | 5.36 | 4.67 | 4.33 | 3.88 |
| TE | 82 | 3.61 | **3.54** | 5.03 | 4.32 | 3.69 | 3.64 |

One week, no uncertainty estimate: this is a smoke test, not evidence.

### Drift check: retrospective ESPN is not frozen ESPN

For 2026 week 2, only 292 of 538 players' retrospective ESPN values equal the frozen
pre-kickoff capture (mean absolute difference 0.51 points, max 21.2). ESPN keeps
updating after an early capture, and a later fetch cannot tell pre-kickoff updates from
post-kickoff ones. On that week the retrospective values scored better than the frozen
ones at RB (3.09 vs 3.35) and WR (3.88 vs 4.33). Retrospective ESPN is the stronger
comparator, which is why only frozen captures can settle this.

## Selected settings (validation 2024, early stopping)

| Position | XGBoost | LightGBM |
|---|---|---|
| QB | absolute error, depth 3, 251 trees (val 4.925) | l1, 7 leaves, 156 trees (val 4.784) |
| RB | absolute error, depth 5, 215 trees (val 3.692) | l1, 15 leaves, 100 trees (val 3.603) |
| WR | absolute error, depth 4, 162 trees (val 3.859) | l1, 15 leaves, 124 trees (val 3.765) |
| TE | absolute error, depth 3, 176 trees (val 2.877) | l1, 7 leaves, 222 trees (val 2.787) |

Top XGBoost features: last-week snap share, missed last game and injury fields (QB/RB);
trailing-5 receptions, targets and target share (WR/TE).
