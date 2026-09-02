# Beat the close — the program layered on top of the current model

Written 2026-09-02. The current model stays exactly as it is: it keeps
forecasting the score, capturing evidence, freezing decisions and grading
them. This program does not replace it; it reads the model's outputs as
features and asks a different question of them.

**The question.** Does anything we hold before a line moves predict where the
line goes from open to close? If yes, which signals, how far ahead, and how
much of the move is left to capture when we can act?

**Why this is the question.** Every role we have re-derives the closing line
from the closing line's own inputs, so its error is the market's error
(`/api/nfl-betting/specialists/audit`). The only edge measurable inside a
season is closing line value: taking a number that is better than the close.
That is a forecast of the LINE, not the game, and we have never fitted one.
We now hold the data to try: per-book opening and closing quotes for
2022–2025 (`nfl_odds_archive`, Pinnacle plus ten soft books), the verified
event archive with availability timestamps, and hourly live captures with
Polymarket every fifteen minutes from 2026 on.

Three phases, three clocks: one session for "is there anything here", about
six weeks of the season for "is it still there live", the season for "does it
pay".

---

## Phase 1 — the historical study (one session)

### Dataset: one row per game, 2022–2025, ~1,100 games

From `nfl_odds_archive` (home perspective, spread and total separately):

| column | definition |
|---|---|
| `open_pin`, `close_pin` | Pinnacle opening and last pre-kickoff line |
| `open_soft`, `close_soft` | median opening and closing line across the soft books |
| `move` | `close_pin − open_pin` (the target) |
| `move_sign` | sign of `move`, zero excluded |
| `opener_at`, `close_at` | Pinnacle's own timestamps for both |
| `dispersion_open`, `dispersion_close` | max − min across books |
| `key_cross` | whether the move crossed 3 or 7 (spread) |

Games with fewer than three books at both ends are dropped, not imputed.

### Features, each stamped with WHEN it was knowable

The archive holds only the opener and the close, so every feature is labelled
by the decision time it belongs to. Features at T0 are a clean test. Features
at T1/T2 are a bounded test: part of the move may already have happened
before the news, and only the live phase can resolve that.

- **T0 = at the opener** (Pinnacle `opener_at`):
  - sharp-versus-soft opener gap: `open_pin − open_soft`
  - model-versus-opener disagreement: the current ensemble line, the rulebook
    priors, the four matchup-role forecasts, and nfl-market's fitted line,
    each minus the opener
  - public-side markers: home favourite, primetime, favourite size, key
    number proximity, division game, rest and travel differential
  - recency-bias markers: each team's prior-week cover margin and ATS streak,
    prior-week margin of victory (blowout overreaction)
  - last season's tendency for this team's lines to move toward or away from it
- **T1 = Wednesday noon ET, T2 = Friday noon ET:**
  - verified event archive change since T0 (v2 timestamps): injury burden
    delta per team, quarterback status change, roster team changes, trades
  - the ensemble's Wednesday and Friday numbers where the forward captures
    exist; for 2022–2025 the archive gives none, so T1/T2 rely on events only

Nothing published after `close_at` enters any feature. The cutoff test
pattern from `test/verified-events-cutoff.test.js` applies.

### Models and evaluation

- Walk-forward by week: fit on every earlier game, predict the next week;
  additionally hold out 2024–2025 entirely for the headline number.
- Sign model: regularised logistic on `move_sign`. Magnitude model: ridge on
  `move`. Report each feature's coefficient with a week-clustered bootstrap
  interval, and the multiplicity-corrected p-values across the feature set
  (the plan's promotion rule already requires this).
- **The number that matters: CLV in points.** For every game, "bet the opener
  on the predicted side" and record `close − open` in the predicted
  direction. Mean CLV, its bootstrap interval, and the share of games with
  positive CLV, on the held-out seasons. Direction accuracy is reported
  beside it but CLV is the gate.
- Secondary: ATS result at the OPENER price versus at the close, to show
  what CLV was worth in units on this sample (not a promotion signal).
- Slices: by market (spread, total), favourite size, primetime, key-number
  crossings, and by decision time T0/T1/T2.

### Deliverables

- `server/services/line-move-study.js`: dataset builder, fits, report;
  registered in `report-cache.js` so it runs in a worker and is served from
  the store (`line_move_study`).
- `GET /api/nfl-market/line-move-study` and a tab on the Diagnostics page
  ("Beat the close").
- `test/line-move-study.test.js`: synthetic archive where one feature moves
  the line and the others do not; the study must find it, hold out
  correctly, and refuse to read a slice under thirty games.
- `DIAGNOSTIC_2026_09_02.md` §9 with the results table.

### Gate for Phase 1

Proceed to a live rule only for a signal that shows, on the held-out
2024–2025 games, mean CLV ≥ +0.3 points with a bootstrap interval that
excludes zero on ≥ 300 games, at a single decision time. Anything weaker is
recorded and NOT carried forward. A clean "nothing predicts the move" is a
complete, valuable result: it means the money is in price and speed, not
prediction, and Phase 2 narrows to those.

---

## Phase 2 — the live test (2026 Weeks 1–6)

Captures already run: free multi-book feeds hourly, Pinnacle direct,
Polymarket implied lines every fifteen minutes, verified events, the
ensemble's scheduled and open horizons. Add:

1. **Signal snapshots.** At every capture, store each Phase 1 feature's
   current value per game (`nfl_signal_snapshots`: captured_at, game, feature,
   value). This is the path between open and close that the archive lacks.
2. **Shadow rule, zero units.** For each signal that passed Phase 1: when
   its predicted move exceeds its threshold, freeze a shadow decision
   `strategy = 'beat_the_close'` at the best reachable price across the
   feeds at that moment (the price shopper's board), with the signal value
   and decision time on the row. `NFL_MODEL_STAKE_UNITS` stays 0.
3. **Grade by CLV, not by result.** `closingLineValue()` already exists; add
   the per-decision `clv_points` and `clv_probability` (line and price versus
   Pinnacle's close) to the settlement and to the weekly look-back's
   `reads`.
4. **Measure the window.** For every verified event with a timestamp, the
   time to the first book move and to Pinnacle's move (the news-latency
   service does this for the typed feed; extend it to the event archive).
   The distribution of that window is the speed budget for any news rule.
5. **Weekly read.** After each week: direction accuracy of each live signal,
   mean CLV, window distribution, and whether the historical coefficient
   still holds. Two consecutive weeks where a signal's live CLV interval sits
   below zero retire the signal's rule (recorded, not deleted).

By Week 6 (about 60–100 games) the direction question is answerable live;
CLV significance is not yet, and the reads must say so.

---

## Phase 3 — the season (through the 200-decision gate)

- The forward gates in `PROFITABILITY_PLAN.md` §2 apply unchanged: positive
  mean CLV with a week-clustered bootstrap interval above zero on at least
  200 settled shadow decisions, calibration within tolerance, and the
  reachable-price rule (a decision counts only at a price a listed book
  actually offered at that time).
- Only then does staking (§8 of the plan) become a conversation. Even a
  genuine 54% edge needs hundreds of bets to separate from luck; the gate is
  the sample size, not caution for its own sake.

---

## What this does NOT change

- The score model, the sixteen roles, the coordinator fix and the postgame
  decomposition in `NEXT_SESSION_PLAN.md` continue. Their outputs are Phase 1
  features; if any of them predicts the line's movement, that is where the
  coordinator's weight should come from.
- Nothing is staked, no rule is promoted on historical evidence, and every
  number is reported with its sample and its decision time.

---

## Checklist

```
Phase 1 (one session)
[ ] dataset builder from nfl_odds_archive + verified events + model outputs, T0/T1/T2 stamped
[ ] walk-forward + 2024–25 holdout; CLV-in-points as the gate; slices; multiplicity
[ ] line-move-study.js in the worker report store; route; Diagnostics tab; test
[ ] results in DIAGNOSTIC §9; signals that pass the gate listed with thresholds

Phase 2 (Weeks 1–6)
[ ] nfl_signal_snapshots at every capture
[ ] beat_the_close shadow decisions at zero units at the best reachable price
[ ] CLV per decision in settlement and look-back; event-to-move window measured
[ ] weekly read; retire rules whose live CLV interval sits below zero twice

Phase 3 (season)
[ ] 200 settled decisions; bootstrap CLV interval; reachable-price rule; then staking discussion
```

---

## Execution map for Phase 1 — start here when told to go

Every step names its file, its inputs, its check, and its commit. Steps 1–4
are server work and must be done in one batch between server restarts; step 5
is client-only; step 6 is docs.

### Step 0 — preflight (5 minutes)

```
git status --short            # must be clean on phase3-live-draft-reliability
npm test | tail -3            # 384 pass
curl -s localhost:5178/api/nfl-market/odds-archive | head -c 400
```
Expect `by_season` with 2022–2025 and 10–11 books each. If the archive is
thin, run the backfill first (`POST /api/nfl-market/odds-archive/backfill`)
and wait for `/odds-archive/progress` to report `running: false`.

### Step 1 — dataset builder (`server/services/line-move-study.js`, ~1.5 h)

`buildLineMoveDataset({ seasons = [2022, 2023, 2024, 2025] })` returns one
row per game and market:

1. Games: `game_lines WHERE home=1 AND season IN (...) AND team_score IS NOT NULL`,
   joined to `nfl_odds_archive` on `(season, week, home)`.
2. Pinnacle open/close: rows with `book='pinnacle'`, `market='spreads'`,
   `side=home`, `phase in ('open','close')` → `open_pin`, `close_pin`,
   `opener_at`, `close_at` (the book timestamps). Totals: `side='Over'`.
3. Soft books: every other book, same side; `open_soft`/`close_soft` = median,
   `dispersion_open/close` = max − min, `books_open/close` = count.
4. Drop rows with fewer than 3 books at either end or a missing Pinnacle
   line; record the drop counts in the report.
5. `move = close_pin − open_pin`; `move_sign` (0 excluded from the sign
   model); `key_cross` for spreads (crossed 3 or 7 in either direction).
6. Features (each with a `known_at` stamp):
   - T0: `sharp_soft_gap = open_pin − open_soft`; `dispersion_open`;
     `home_fav`, `fav_size = |open_pin|`, `primetime` (gametime ≥ 20:00 ET or
     Thursday/Monday), `div_game`, `rest_diff`, `key_proximity`
     (distance of `open_pin` to nearest of 3/7);
     `prior_cover_home/away` (last week's cover margin from game_lines
     spread and scores, strictly earlier week), `ats_streak_home/away`
     (consecutive covers, prior weeks), `prior_mov_home/away`;
     model disagreement: `nfl_market_vs_open` (`predictGame(home, away, season).spread` − open), and the four
     matchup roles via `matchupOpinion(role, season, week, home, away).forecast`
     (already cutoff-safe, cached per week);
     `team_move_tendency_prev_season` (mean signed move toward the home
     side for each team last season, from the archive itself).
   - T1/T2: `injury_burden_delta_home/away` = `teamEventVector(team, {before: T})`
     minus the same at `opener_at`; `qb_change_home/away` (event archive
     `weekly_roster_status_change` or injury report for the snap-leading QB
     between `opener_at` and T); `trades_since_open`.
     T1 = Wednesday 16:00Z, T2 = Friday 16:00Z of game week, computed from
     `gameday`. Never later than `close_at`.
   - Optional, only if time remains: `ensemble_vs_open` from `ensembleLine`
     (seconds per game; run once, cache in the report).
7. Persist nothing except through the report store; the dataset is
   recomputed by the worker. Return `{ rows, dropped, seasons, built_at }`.

Check: `node -e` printing row counts per season and market (expect ≈ 260–285
per season per market) and a spot check of one game against
`/api/nfl-market/odds-archive` raw rows.

### Step 2 — models (`line-move-study.js`, ~1.5 h)

Reuse `ridge()` from `nfl-matchup-specialists.js` (export it) for magnitude;
add a small L2-regularised logistic (Newton, 25 iterations) for `move_sign`.

- Standardise features on the training fold only.
- **Walk-forward:** for each (season, week) from 2022 W5 on, fit on all
  earlier rows, predict that week. **Holdout:** fit on 2022–2023, predict
  2024–2025 once.
- Per feature set (T0 only; T0+T1; T0+T2) and per market: direction
  accuracy, Brier of the sign model, magnitude RMSE versus predicting zero
  move, and **CLV in points** = `move` in the predicted direction, averaged,
  with a week-clustered bootstrap (1,000 resamples of weeks) 95% interval
  and the share of games with positive CLV.
- Per single feature: the same CLV number using that feature alone
  (sign of its standardised coefficient on the training fold), so the
  report says which signal carries it. Holm correction across the feature
  list for the "beats zero" p-values.
- Slices on the holdout: spread/total, `fav_size` buckets (≤3, 3.5–7, >7),
  primetime, `key_cross`; any slice under 30 games is `readable: false`.
- Secondary: ATS units at the opener price versus at the close for the
  predicted side, stated as "what CLV was worth here", not as evidence.

Output shape: `{ dataset: {...counts}, headline: { by_decision_time: [...], by_market: [...] },
features: [{ name, known_at, coefficient, interval, clv_alone, p_holm }],
slices: {...}, gate: { passed: [...signals], rule } , rule }`.

Gate written into the report: a signal passes only with holdout mean CLV
≥ +0.3 points, interval excluding zero, ≥ 300 games, one decision time.

### Step 3 — worker store, route (~20 min)

- `report-cache.js` `REPORTS.line_move_study`: deps `nfl_odds_archive`,
  `game_lines`, `nfl_verified_events`; module `./line-move-study.js`;
  fn `lineMoveStudy`; args `[{}]`; label "Beat the close: open-to-close study".
- `server/routes/nfl-market.js`: `GET /line-move-study` → `serveReport('line_move_study')`;
  it is refreshed by the existing `nfl_reports` job and by
  `POST /reports/line_move_study/refresh`.

### Step 4 — test (`test/line-move-study.test.js`, ~45 min)

Seed a temp database: 4 seasons × 18 weeks × 8 synthetic games with
Pinnacle and three soft books; make `sharp_soft_gap` move the line with a
coefficient of 0.5 and every other feature pure noise; add verified events
that change burden after the opener for a subset. Assert:
- the builder drops games with < 3 books and reports the count;
- the holdout report ranks `sharp_soft_gap` first with a positive CLV
  interval and no noise feature passes the gate after Holm;
- a slice with under 30 games is `readable: false`;
- no feature uses a timestamp after `close_at` (assert on `known_at`).

Then `npm test`, `npm run lint`, commit:
"Beat-the-close study: open-to-close dataset, walk-forward and holdout fits, CLV gate".

### Step 5 — Diagnostics tab (client only, ~30 min)

`client/src/pages/betting/Diagnostics.tsx`: tab "Beat the close" reading
`/nfl-market/line-move-study`; pending state like the others; headline
cards (holdout games, mean CLV with interval, direction accuracy, signals
passing the gate), a feature table (coefficient, interval, CLV alone,
Holm p, decision time), and the slice tables greyed under the read floor.
`npm run typecheck`, commit.

### Step 6 — results into the docs (~20 min)

`DIAGNOSTIC_2026_09_02.md` §9: the headline table by decision time and
market, the passing signals with thresholds, and the plain conclusion —
either "these signals predict the move; Phase 2 rules are X" or "nothing
predicts the move; Phase 2 is price and speed only". Tick the Phase 1
checklist. Commit, push.

### Time and sequencing

About five hours of work; the worker's first run takes a few minutes. Steps
1–4 change server files: do not open an audit week during them. Start the
report worker (`POST /api/nfl-market/reports/line_move_study/refresh`) right
after the step-4 commit so the numbers are in the store by the time the tab
is built.
