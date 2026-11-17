# KALSHI-EDGE: a standalone study of who is on the other side of Kalshi sports trades

Unit: KALSHI-EDGE, asked for directly by Nick on 2026-11-17 ("any project as it relates
to sports betting"). It is not a ONE-PLAN unit. ONE-PLAN marks betting objectives as
ignored for the fantasy product, and this work does not touch that product: nothing under
`server/`, `client/` or `scripts/` is changed, no served number moves, no route or table
is added. It is a statistical unit, so it has its own pre-registration and its own holdout
ledger inside the directory (`research/kalshi-edge/PREREGISTRATION.md`,
`HOLDOUT-LEDGER.md`). It makes no look at the 2025 NFL holdout that
`docs/evidence/HOLDOUT-LEDGER.md` guards, so nothing is appended there.

## 1. Audit: what already existed (tree `dc62712e`)

- `scripts/model-lab/kalshi_calibration.py`, `kalshi_chain_vs_margin_model.py`,
  `polymarket_ladder_coherence.py`, `ingame_kalshi_vs_espn.py`: NFL only, read
  `data/line-history/line_history.sqlite` (not in a cloud clone), and by their own
  docstrings are limited to tens of games.
- `scripts/line-history/kalshi_backfill.py`: pulls `KXNFLGAME` / `KXNFLSPREAD` /
  `KXNFLTOTAL` trades one market at a time.
- `docs/HISTORICAL-TESTS.md`: about twenty pre-registered NFL tests against the close,
  one small positive (opener-CLV) that vanished when placeholder openers were repaired.

**Extend or build: build.** The question here (every sport, the whole public tape, flow
classified by order size) needs data none of those scripts load, and extending them would
have meant writing into the fantasy repo's research code paths. New directory, no imports
in either direction.

## 2. RED / GREEN

Command for every row: `cd research/kalshi-edge && source .venv/bin/activate && python -m pytest tests -q`.
Each RED commit fails on import or on the named assertions; each GREEN commit passes the
whole suite.

| what | RED | GREEN | suite after GREEN |
|---|---|---|---|
| fee model; fills → parent orders → flow classes → 5-minute bars | `c50d69a5` | `4546a023` | 20 |
| decision snapshots (feature / entry clock) | `4f07a76f` | `c459b70a` | 34 |
| bet accounting, game-clustered inference, taxonomy | `08ca2964` | `7834dd61` | 84 |
| holdout guard | `063f65d7` | `f9cd1f9e` | 90 |
| strategy simulator | `597a033f` | `964b9cff` | 101 |
| snapshot window after the decision | `33780d37` | `98080fec` | 105 |
| one-minute bars with first prints | `56408fa4` | `84103914` | 109 |
| in-game marketable orders | `b6819f6b` | `6d5da208` | 122 |
| in-game resting orders, tick-exact | `3df50fca` | `f0dd81b9` | 129 |
| resting price on a whole cent | `806d0e87` | `6c9b328a` | 130 |
| frozen rules | `9fa9d3ef` | `b471faeb` | 135 |
| live order tickets | `21ed876e` | `47e609cb` | 142 |
| live tickets before the start only | `efdd966f` | `e9ce3f13` | 144 |
| forward ledger: one order per market | `7bc84c8c` | `ab03d71f` | 154 |
| the before-kickoff offer (S11) as a library rule | `2b306c4d` | `a8fd1a83` | 158 |
| flow-to-price on quote midpoints | `9291b1c6` | `503d5496` | 163 |

Final suite: 163 tests, 163 pass, about 5 seconds, no network.

**Not RED/GREEN, said plainly:**

- `kalshi_edge/features.py` and `tests/test_features.py` were committed together (`c4a5038a`).
- `tests/test_holdout_helpers.py` (6 tests) was written **after** the holdout run. It
  characterises `flow_gap`, `ingame_calibration` and `summ` in `scripts/run_holdout.py`,
  which computed A1 and S12 without tests of their own. All six passed on first run, so
  the holdout numbers were not re-run.
- `kalshi_edge/hypotheses.py` (P1–P3) has no test of its own; it is two thin calls into
  the tested `stats.logit_fit`.
- **S11, the one positive lead, was computed by an untested helper when the holdout was
  run.** It has since been moved into `rules.static_longshot_offer` with tests written
  first (`2b306c4d` → `a8fd1a83`). On train and validation the tested rule returns the
  recorded positions, orders posted and return exactly, for both fill variants, so the
  holdout figure (same logic, same inputs) was left as recorded and the holdout was not
  read again.
- `flow_price_regression` in `scripts/run_holdout.py` (S13 as registered) and the
  download / orchestration scripts are untested. S13 as registered turned out to be
  measured wrongly (section 4, third item); its replacement, `flowprice.fit`, is tested.

## 3. Mutations

Hand-written, one textual change each, run against the tests of the module changed.
A survivor is either closed with a new test or shown to be equivalent code.

| module | killed | survivors |
|---|---|---|
| `fees.py`, `tape.py` (parent orders, bars) | 17 / 17 | first pass 16 / 17: a dust order near $0 was classed as a dollar order; closed by `test_dust_order_near_zero_dollars_is_not_a_dollar_order` |
| `snapshots.py` clock | 16 / 18 | 2 equivalent (a redundant pre-filter; DuckDB's `arg_max` already skips NULL). First pass 13 / 18: three real gaps closed (the $2,500+ retail bucket, an unfinished bar as the earlier price, an entry bar crossing the start at a short horizon) |
| `snapshots.py` window | 6 / 6 | |
| `backtest.py`, `stats.py`, `taxonomy.py` | 18 / 18 | |
| `strategy.py` | 20 / 20 | first pass 19 / 20: the summary interval was not shown to be clustered by game; closed by `test_summary_interval_is_clustered_by_game_not_by_bet` |
| `tape.py` minute bars | 8 / 8 | |
| `ingame.py` marketable orders | 12 / 13 | 1 equivalent (a NaN quote already fails the band comparison) |
| `ingame.py` resting orders | 12 / 12 | |
| `rules.py` in-game rules | 9 / 9 | |
| `rules.py` before-kickoff offer | 14 / 14 | |
| `live.py` tickets | 13 / 13 | |
| `flowprice.py` | 5 / 5 | first pass 4 / 5: clustering of the standard errors was not shown; closed by `test_standard_errors_are_clustered_by_game` |

## 4. Three mistakes the tests exist because of

- **Single-precision prices.** An exploratory maker test stored prices as 32-bit floats.
  `float32(0.94)` is `0.9399999976`, which compares as *below* a 0.94 bid, so "touched"
  and "traded through" gave identical tables and the result flipped sign from one price
  bin to the next. The library now compares on integer ticks, and
  `test_touch_and_through_are_exact_on_the_tick_grid_even_with_single_precision_prices`
  pins it. The exploratory tables that had the bug were discarded and re-run.
- **A five-minute bar is not an execution clock.** Filling an in-game limit order against
  the *last* print of the next five-minute bar conditions the fill on five more minutes of
  the game, and made every in-game rule look like it lost between 1% and 19%. The tape was
  re-read into one-minute bars that keep the *first* print per side
  (`tape.minute_bars_sql`), and `test_the_decision_minute_is_never_the_fill` pins the rule.

- **Bid-ask bounce read as information.** S13 regressed the change in each minute's
  average trade price on signed flow and found retail buying followed by a 0.3c fall
  (t = −24). Buying prints at the offer and selling at the bid, so a minute of net buying
  has a high average and the next minute looks lower with no information involved. On
  quote midpoints the retail coefficient is +0.02c to +0.12c and the integer coefficient
  is +0.3c, not +1.0c. The claim was published in the report and the README before it was
  caught; both now carry the correction. `test_bounce_alone_makes_average_trade_prices_look_like_reversal`
  reproduces the artefact on simulated data with no informed group at all, and
  `test_midpoints_report_nothing_when_there_is_nothing` pins the measure that replaced it.

## 5. How do we know?

- The money arithmetic is checked twice: scalar functions in `backtest.py` with hand-worked
  cases (a $100 stake at 60c buys 162.11 contracts, not 162.12, once the fee rounds up),
  and the vectorised simulator against them bet for bet on 400 random rows.
- The clock is the part that would silently manufacture profit. Fourteen snapshot tests are
  about which bar may be a feature and which may be a fill, and
  `test_features_do_not_depend_on_anything_after_the_decision` asserts features are
  unchanged when every post-decision column is altered.
- The holdout was read through `guard.open_holdout`, which will not issue a token without
  the frozen file and writes the ledger row first. Row 1 is the pre-registered run. Row 2
  is a post-hoc look, labelled as such.
- What the tests cannot show: that simulated fills match what a real account would get.
  That needs real orders, which this unit does not place.
