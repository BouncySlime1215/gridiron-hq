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
