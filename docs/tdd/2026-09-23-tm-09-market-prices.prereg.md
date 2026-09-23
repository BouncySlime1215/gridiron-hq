# TM-09 pre-registration: market prices from real trades, and a hype index

Unit TM-09 (plan item B6/B7, Trade Machine). Written and committed before any
price, error or decay number is computed. Trade counts below are the only
figures looked at so far; they are sample sizes, not outcomes.

## Question

1. What does a player fetch in a real trade, in the same units as our value,
   by position, week and league size?
2. Hype index = market price minus our value. When the market pays above our
   value, does the player's production fall back to our value over the next
   2-4 weeks (the "why did I do that" mechanism, plan RS-04)?

## Literature (2-3 sentences)

A trade is a revealed-preference price: the package one side accepts for a
player is an implicit price for that player's attributes (Rosen 1974, "Hedonic
prices and implicit markets", *J. Polit. Econ.* 82:34-55). Sports-asset
markets systematically overpay for salient recent performance and top
assets (Massey and Thaler 2013, "The loser's curse", *Management Science*
59:1479-1495; De Bondt and Thaler 1985, "Does the stock market overreact?",
*J. Finance* 40:793-805), which predicts positive hype that decays. Whether a
premium is information or noise is tested with a forecast-efficiency
regression of the outcome on the forecast gap (Mincer and Zarnowitz 1969,
NBER "The evaluation of economic forecasts").

## Data (local only, never committed)

- `~/gridiron-local/rnd/skill/team_seasons.sqlite`: `trade_sides` (per-side
  trade rows, Sleeper player ids, `leg_week`, `t_done_ms`, `has_picks`,
  `n_partners`) and `team_seasons` (league size, scoring, superflex,
  league-specific replacement ppg `repl_qb/rb/wr/te`, bootstrap `chain`).
- Per-player weekly points, kickoffs, ADP pools and ADP-to-ppg curves from the
  study caches `rnd/skill/cache/points.pkl` and `adp_ev.pkl` (the same inputs
  `trade_sides.exante_*` was built from, `rnd/skill/build_03_leagues.py:346-365`).
- League id order from `sleeper_history.sqlite` `sh_leagues` (read-only,
  immutable) only to rebuild `lg` -> league id for the leave-own-league-out ADP.
- **Seasons: 2021-2024 only. 2025 is not read, derived or graded** (holdout
  ledger: zero looks). 2026 has no Sleeper trade corpus.
- Terms: Sleeper API docs (`rnd/data/public-league-terms/sleeper-docs.html`)
  say the API is free for non-commercial use; the Sleeper ToS forbids
  scraping without consent. Nick cleared this corpus for use with aggregates
  only in the public repo (WORK-QUEUE section 6, 2026-09-22 ~20:10Z). So the
  repo gets only the derivation script and aggregate tables: no league ids,
  roster ids, usernames or league names; per player-week rows only where
  n >= 3 trades.

Sample (counted, `sqlite3 -readonly team_seasons.sqlite`): 15,977 sides;
2-team sides without picks, 2021-2024: 12,814 (1-for-1: 4,702).

## Units and definitions

- **Our value** v_i(t): per-game points above replacement at trade time t,
  v = pred_ppg - repl_pos, where pred_ppg = (n x season-to-date ppg +
  k x EV_ppg(ADP)) / (n + k), k = K_BY_SEASON (the study's consensus
  forecast, `build_03_leagues.py:346-365`, leave-own-league-out ADP), and
  repl_pos is the league's `team_seasons.repl_<pos>`. League scoring applies.
  Positions QB/RB/WR/TE only; a trade side that moves a K or DEF is dropped.
  This is the historical stand-in for "our value": the app's live values
  (FantasyCalc `dynasty_values`, ROS projections) do not exist for 2021-2024.
- **Observation**: a 2-team, no-pick trade side S at time t, and a player X
  that S gives with v_X > 0. Package P = players S receives.
  price_X = w_X x sum_{j in P} max(v_j, 0), w_X = v_X / sum_{i in S.give} max(v_i, 0).
- **Hype** h_X = price_X - v_X (PAR per game). **Sign convention: positive =
  the market paid more than our value** (priced above value).
- Keys: season, week = `leg_week`, Sleeper player id, position, league size
  bin (<=10, 12, >=14), week bin (1-4, 5-8, 9-12, 13+).

## H1: held-out price error (fit 2021-2023, test 2024)

- Model: price_hat = v_X x r[pos, week bin, size bin], r = median(price/v)
  among training observations in the cell; a cell with n < 30 falls back to
  r[pos], then to 1.
- Baseline ("offer fair value"): price_hat = v_X.
- Metric: MAE of price (PAR/g) on 2024. Decision win rate: share of 2024
  observations where the model's error is smaller than the baseline's (ties
  dropped).
- Interval: 90% percentile bootstrap over league chains (`team_seasons.chain`),
  1,000 resamples, seed 7331. MDE80 = 2.487 x bootstrap SE.
- **Ship rule H1**: the premium table is served as a number only if
  (baseline MAE - model MAE) > 0 with the 90% CI above 0 AND decision win rate
  > 0.50 with the 90% CI above 0.50. Otherwise the route serves it with
  `premium_available: false` and the reason.

## H2: hype decay (2021-2024 pooled; per season for consistency)

- Outcome: realized PAR/g over X's next 4 team games after t (a team game with
  no stat row counts 0 points; realized = total / games - repl_pos).
  Observations with fewer than 4 remaining regular-season team games are
  dropped. Secondary horizon: next 2 team games.
- Regression: (realized - v_X) = a + c x h_X, OLS, CI by the same chain
  bootstrap.
- Reading: c = 1 means the premium is fully realized (the market was right);
  c = 0 means the premium is pure hype (production falls back to our value).
- **Decay confirmed** if the 90% CI of c lies below 1 AND the point estimate
  of c is below 1 in at least 3 of the 4 seasons. "Market informative" is
  reported separately: 90% CI of c above 0.
- Decision grade: in 1-for-1 no-pick trades where both players have v > 0,
  the side receiving the player with the higher v (consensus-favored side)
  wins if its received player's realized PAR/g over the next 4 team games
  beats the given player's. Report that win rate vs the 0.50 coin (the
  market's own verdict, "offer fair value"), 90% CI, MDE80.
- Known threat named in advance: noise in our package valuation enters h and
  attenuates c toward 0 (errors-in-variables), so "c < 1" alone does not prove
  a psychological premium; the 1-for-1 decision grade is the check that does
  not rely on the regression slope.

## Ship rule (overall)

No 2026 Sleeper trade prices exist, so no forward holdout is possible: the
table ships default-off, labelled "unconfirmed forward". It feeds no served
trade number in this unit; it reaches only
`GET /api/trades/:leagueId/market/:playerId`. A failed H1 or H2 is reported
as a decline with its MDE80, not as "no effect".

## What would make this wrong

- The consensus forecast is a poor proxy for "our value" (the app's live
  value differs); magnitudes do not carry to the app, direction may.
- `leg_week` is the Sleeper transaction leg, not always the NFL week a trade
  was priced in; t_done_ms is used for every as-of cut.
- Replacement levels are season-window (hindsight) league values from the
  study build; ADP-to-ppg curves are leave-one-season-out, so the 2021-2024
  priors were fitted with 2025 outcomes among the other seasons (no 2025
  trade or outcome is read by this unit).
