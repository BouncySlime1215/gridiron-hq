# TM-09: market prices from real trades, and a hype index

Unit TM-09 (plan item B6/B7, Trade Machine). Branch `claude/local-tm-09-market-prices`, base `origin/main` `131a7ba0`.
All numbers were measured on the local study corpus (local only, not production). The repo holds only the derivation script and aggregate tables.

## Audit: extend or build

- **What exists for "market price" of a player.**
  - FantasyCalc crowd value, table `dynasty_values`, writer `syncDynastyValues` (`server/routes/aggregates.js:130`, upsert at `:149`). This is the Trade Lab's "market value" and fairness word.
  - A 30-day FantasyCalc momentum verdict ("sell into the hype") in `heuristicVerdict` (`server/routes/players.js:139-145`).
  - The counterparty perception layer (`server/services/counterparty-pricing.js`, `hype_vs_usage` at `:78`) is about one manager's view, not a market price.
  - The R&D note `rnd/loop/r4-internal-trade-market-price-frozen.md` covers FantasyCalc staleness (S-10, RL-4-3), not revealed trade prices.
- **What does not exist:** any price revealed by real trades, or any "price minus our value" number. `git grep -n -i "market_price\|marketPrice\|revealed price" origin/main -- server client/src` returns nothing. Control: the same grep with `hype` finds `players.js:143`.
- **Prior study on the same corpus:** `rnd/skill/trades.md` (skeptic sk04 B). Sides that buy hot starts pay paper value but lose no realized lineup points. That study graded sides, not per-player prices, and it opened 2025. This unit does not open 2025.
- **Decision: build.** This is a new, distinct concept: a historical revealed price in our value's units. It sits beside FantasyCalc and does not replace it:
  - it is a new aggregate table read by a new reader and one new route;
  - no served trade number reads it;
  - no migration is needed (a JSON table in `server/data/`, the same pattern as `server/data/nfl-ensemble-rank.json`).
- **One number, one producer.** The route's `note` field says it is not the live FantasyCalc value. Both "hype" producers exist side by side:
  - `players.js:143`: FantasyCalc 30-day momentum, live, 2026;
  - TM-09 `hype`: trade price minus consensus value, 2021-2024.
  - They cannot be compared on the same input: TM-09 has no 2026 prices. Follow-up to unify them: AI-04, the price model.

## Pre-registration

`docs: TM-09 pre-registration for market prices and hype decay` — `9e405725`. It was committed before any price, error or decay number was run (`docs/tdd/2026-09-23-tm-09-market-prices.prereg.md`), and it holds the literature grounding: Rosen 1974; Massey and Thaler 2013; De Bondt and Thaler 1985; Mincer and Zarnowitz 1969.

## Licence / terms

- `rnd/data/public-league-terms/sleeper-docs.html`: the API "is free to use for non-commercial purposes".
- `sleeper-terms2.html` forbids crawling or scraping without Sleeper's consent.
- Nick cleared this corpus with aggregates only in the public repo (WORK-QUEUE section 6, 2026-09-22 ~20:10Z).
- What is committed:
  - cells by position x week bin x size bin;
  - player-week medians with n >= 3 trades, keyed by public Sleeper player id;
  - no league, roster, trade, chain id, username or league name. Test 8 pins this.

## Commits

| Step | Subject | sha |
|---|---|---|
| prereg | docs: TM-09 pre-registration for market prices and hype decay | `9e405725` |
| data | feat: TM-09 derivation script and aggregate market-price table from real trades | `0e0553f2` |
| RED | test: RED for TM-09 market-price reader and route | `3333a9eb` |
| GREEN | feat: TM-09 market-price reader and GET /api/trades/:leagueId/market/:playerId | `b0ef8cb4` |

**RED** (`3333a9eb`, stub reader, no route): 11 of 12 fail. Example failing assertions:
- test 1: `undefined !== '1-4'` (`assert.equal(market.weekBin(4), '1-4')`);
- test 10: `404 !== 200` (`assert.equal(status, 200)`, route not mounted).

Test 12 ("unknown player is a 404") passes on RED because the missing route also 404s. Its liveness comes from mutant C4 below.

**GREEN** (`b0ef8cb4`): 12 of 12 pass.
- Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/trade-market.test.js`, exit 0.
- `test/cross-account-league-access.test.js` walks every GET under `/:leagueId`, now including the new route. It passes 8/8, exit 0, so a non-member is refused.

## Mutation sweep

`python3 docs/tdd/sweeps/tm09-mutations.py` on `b0ef8cb4`: 14 of 14 as designed.

| Mutant | Expected | Got |
|---|---|---|
| M1 weekBin edge `<=4` -> `<4` | killed | killed (bins) |
| M2 sizeBin edge `<=13` -> `<=12` | killed | killed (bins) |
| M3 H1 ship gate removed | killed | killed (test 5) |
| M4 position fallback removed | killed | killed (test 3) |
| M5 missing ratio served as 1.0 | killed | killed (test 4) |
| M6 history order dropped | killed | killed (test 6) |
| M7 no_sleeper_id check removed | killed | killed (tests 7, 11) |
| M8 "unconfirmed forward" label flipped | killed | killed (tests 9, 10) |
| C1 call site: league size ignored (`teams: 10`) | killed | killed (test 10) |
| C2 call site: week hard-coded to 1 | killed | killed (test 10) |
| C3 call site: sleeper_id not selected | killed | killed (test 10) |
| C4 call site: 404 guard removed | killed | killed (test 12) |
| S1 designed survivor: memo cache disabled (same behaviour) | survives | survives |
| N1 not-applied control (search text absent) | not-applied | not-applied |

## What it does

- **Derivation.** `scripts/rnd/tm09_market_prices.py` reads `trade_sides` and `team_seasons` from `rnd/skill/team_seasons.sqlite`, plus the study caches. It works on 2-team, no-pick sides from 2021-2024 with QB/RB/WR/TE only.
  - Each player given with our value v > 0 gets price = his share of the received package's value, in points above replacement per game (PAR/g).
  - hype = price - value. **Sign: positive = the market paid more than our value.**
  - It writes `server/data/trade-market/tm09-market-prices.json`: the H1/H2 results, 45 cells, position ratios, and 2,040 player-week rows (2,737 player-weeks under n=3 suppressed).
- **Reader.** `server/services/trade-market.js`: `loadMarketTable` (:44), `marketPremium` (:62), `playerMarketHistory` (:85), `marketForPlayer` (:97).
  - The ratio is served only if `results.h1.passed === true`.
  - Every absence is named: `table_absent`, `no_sleeper_id`, `no_player_week_with_n_ge_3`, `no_cell_or_position_ratio`.
- **Consumer.** `GET /api/trades/:leagueId/market/:playerId` (`server/routes/trades.js:1005`).
  - It uses the league-membership door `league()` and the league's `team_count` and `leagueCurrentWeek`.
  - It is labelled `status: "unconfirmed forward"`, `default_off: true`.
  - No page change. No trade card reads it.

## The numbers

All numbers come from one run on tree `0e0553f2` (script + table), local corpus: `nice -n 10 python3 scripts/rnd/tm09_market_prices.py --out-json server/data/trade-market/tm09-market-prices.json --obs-csv ~/gridiron-local/rnd/skill/TM-09/obs.csv`. The log is `~/gridiron-local/rnd/skill/TM-09/run1.log` (local).

Intervals are 90% percentile bootstrap over league chains (1,000 resamples, seed 7331). MDE80 = 2.487 x SE.

**Known-nonzero control for our value** (scratch `tm09_control.py`): the script's `pred_ppg` x remaining team games reproduces `trade_sides.exante_give` from the study build. Result: n=231 sides, corr 0.99999999, median |diff| 0.002 pts, all within 0.5 pts.

**Sample:**
- 12,814 sides in, and 13,063 player observations out;
- dropped: 2,761 sides whose given players were all below replacement, 3,599 given players below replacement, 310 sides moving a non-QB/RB/WR/TE player, 468 empty sides.

**H1: held-out price error** (fit 2021-2023, n=10,701; test 2024, n=2,362 in 304 chains). **PASS.**
- Baseline "offer fair value" (price = value): MAE 1.706 PAR/g.
- Model (value x cell ratio): MAE 1.628.
- Gain 0.078 [0.069, 0.088], MDE80 0.015.
- Decision win rate vs the baseline: 0.559 [0.548, 0.572], MDE80 0.018.
- 97.9% of test rows used a cell and 2.1% the position fallback.

**H2: hype decay** (2021-2024, next 4 team games, n=11,658 in 947 chains). **Decay confirmed; the market is also informative.**
- (realized - value) = a + c x hype, with c = 0.257 [0.221, 0.296] and MDE80 0.056 (against 1).
- Per season, c: 2021 0.18, 2022 0.15, 2023 0.30, 2024 0.46. All four are below 1.
- Next 2 team games: c = 0.295 [0.251, 0.336].
- Reading: about a quarter of a price premium over our value shows up in the player's next 4 games. The rest falls back.
- Decision grade: in 791 1-for-1 trades with both players above replacement, the side that got the higher consensus value won the next 4 games 0.548 [0.516, 0.579] of the time vs the 0.50 coin. MDE80 is 0.046.

**Exploratory (not pre-registered; `obs.csv`, local).** These change how the passes should be read:
- **Almost all of H1's gain is one global level, not position/week/size structure.** A single constant ratio 0.904 fit on 2021-23 gives 2024 MAE 1.6287, a position-only ratio gives 1.6306, and the cells give 1.6280.
  - The level below 1 is partly mechanical. Packages are floored at 0, so 1,507 of 13,063 observations have price 0. Below-replacement counterparts are not observed, so the 1-for-1 median ratio is 0.60.
  - So the ratio is a usable price correction. It is **not** evidence that "the market discounts RBs by 10%".
- **Where the market paid above our value (hype > 0 only, n=5,024), c = 0.03.** The premium is almost entirely not realized.
- c = 0.269 when price > 0, 0.201 for 1-for-1s only, and 0.281 for multi-player sides. The decay does not come from the zero-price rows.

## Holdout looks

None. No 2025 row was read, derived or graded: every query filters `season <= 2024` (`tm09_market_prices.py`, `MAX_SEASON`). So no row was added to `docs/evidence/HOLDOUT-LEDGER.md`.

## Forward holdout

Not available: the corpus has no 2026 Sleeper trades. The table therefore ships **default-off, labelled "unconfirmed forward"**, and only the route reads it.

## Known defects

1. "Our value" here is the study's consensus forecast (season ppg shrunk to ADP ppg, k=3), not the app's live value (FantasyCalc / ROS projections). Magnitudes do not carry to the app; direction may.
2. Replacement levels are league season-window (hindsight) values from the study build. The ADP-to-ppg curves are leave-one-season-out, so the 2021-2024 priors were fitted with 2025 among the other seasons. No 2025 trade or outcome is read here.
3. H1 is one held-out fold (2024). The gain is mostly a global level shift (see Exploratory).
4. H2's slope is attenuated by noise in the package valuation (errors-in-variables). The 1-for-1 decision grade (0.548) is the check that does not rely on the slope.
5. Realized counts a missed team game as 0 points, and our value ignores availability. This mostly moves the intercept (a = -1.72), not c.
6. `leg_week` is Sleeper's transaction leg, and every as-of cut uses `t_done_ms`.
7. File allocation: `server/routes/trades.js` is shared. This unit adds one route and one import only, as the unit row named. The coordinator should confirm the grant.

## Nick's five questions

1. **Well built?** Yes, within scope:
   - a pre-registered derivation;
   - a reader with every absence named and a H1 ship gate;
   - one route behind the league-membership check;
   - 12 targeted tests, 14/14 mutants as designed, and the cross-account test passing with the new route.
2. **Stats or made up?** Stats. They come from 13,063 real trade observations (2021-2024) with chain-bootstrap intervals. The bins and the n >= 3 and n >= 30 thresholds are hand-set, as pre-registered.
3. **How we know:**
   - backtest: H1 fit 2021-23, test 2024, MAE 1.706 -> 1.628, win rate 0.559;
   - H2 on 4 seasons: c = 0.257 [0.221, 0.296], below 1 every season;
   - 1-for-1 decision grade 0.548 [0.516, 0.579];
   - no forward holdout.
4. **Pointed anywhere else?** Only `GET /api/trades/:leagueId/market/:playerId`. No page and no trade card reads it.
5. **How it unifies:**
   - It sits beside FantasyCalc `dynasty_values` and does not replace it: the route says so in `note`.
   - `players.js:143` "sell into the hype" (FantasyCalc momentum) is a second hype producer, on different inputs and seasons.
   - The follow-up is AI-04 (price model): one "market price" and one "hype" number, with FantasyCalc as the live input and this table as its historical calibration.

What would make it wrong: the app's live value differing from the consensus forecast by more than the premium, or the Sleeper trade market (mostly casual public leagues) pricing differently from Nick's ESPN leagues.
