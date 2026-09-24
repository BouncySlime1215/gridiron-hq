# TM-09: market prices from real trades, and a hype index

Unit TM-09 (plan item B6/B7, Trade Machine). Branch `claude/local-tm-09-market-prices`, base `origin/main` `131a7ba0`.
All numbers were measured on the local study corpus (local only, not production). The repo holds only the derivation script and aggregate tables.

## Audit: extend or build

- **What exists for "market price" of a player.**
  - FantasyCalc crowd value, table `dynasty_values`, writer `syncDynastyValues` (`server/routes/aggregates.js:130`, upsert at `:149`). This is the Trade Lab's "market value" and fairness word.
  - A 30-day FantasyCalc momentum verdict ("sell into the hype") in `heuristicVerdict` (`server/routes/players.js:139-145`).
  - `sellHigh` (`server/services/waiver-brain.js:452`): live FantasyCalc value above the league's per-position value-vs-projection curve. Same concept (market price minus our value). It feeds the trade-finder hype-window tactic (`server/routes/trades.js:186-196`) and is cited as "the market-price curve" at `trade-tactics.js:803` and `counterparty-pricing.js:634`. Missed in the first pass (my grep was by name, not concept); found by `grep -rn sellHigh server` (skeptic, STRUCTURE lens).
  - The counterparty perception layer (`server/services/counterparty-pricing.js`, `hype_vs_usage` at `:78`) is about one manager's view, not a market price.
  - The R&D note `rnd/loop/r4-internal-trade-market-price-frozen.md` covers FantasyCalc staleness (S-10, RL-4-3), not revealed trade prices.
- **What does not exist:** any price revealed by real trades, or any "price minus our value" number. `git grep -n -i "market_price\|marketPrice\|revealed price" origin/main -- server client/src` returns nothing. Control: the same grep with `hype` finds `players.js:143`.
- **Prior study on the same corpus:** `rnd/skill/trades.md` (skeptic sk04 B). Sides that buy hot starts pay paper value but lose no realized lineup points. That study graded sides, not per-player prices, and it opened 2025. This unit does not open 2025.
- **Decision: build.** This is a new, distinct concept: a historical revealed price in our value's units. It sits beside FantasyCalc and does not replace it:
  - it is a new aggregate table read by a new reader and one new route;
  - no served trade number reads it;
  - no migration is needed (a JSON table in `server/data/`, the same pattern as `server/data/nfl-ensemble-rank.json`).
- **One number, one producer.** The route's `note` field says it is not the live FantasyCalc value. Three "hype" producers exist side by side, and the route lists the other two in `other_hype_producers` (`trade-market.js` `OTHER_HYPE_PRODUCERS`):
  - `players.js:139` `heuristicVerdict`: FantasyCalc 30-day momentum, live, 2026;
  - `waiver-brain.js:452` `sellHigh`: FantasyCalc value above the league's per-position value-vs-projection curve, live, 2026;
  - TM-09 `hype`: trade price minus consensus value, 2021-2024.
  - They cannot be put side by side on one input: the two live producers price 2026 rosters from today's FantasyCalc snapshot, and TM-09 has no 2026 row (no 2026 Sleeper trades in the corpus), so no player-week exists in both. Follow-up to unify all three: AI-04, the price model.

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
| evidence | docs: TM-09 evidence file and mutation sweep | `c7bf740e` |
| RED 2 (skeptic fixes) | test: RED for TM-09 skeptic fixes | `429ad650` |
| GREEN 2 + rerun | fix: TM-09 2025-free value curves, H2 placebo, hype = price - value per row, all hype producers named | `fb0a4406` |

**RED** (`3333a9eb`, stub reader, no route): 11 of 12 fail. Example failing assertions:
- test 1: `undefined !== '1-4'` (`assert.equal(market.weekBin(4), '1-4')`);
- test 10: `404 !== 200` (`assert.equal(status, 200)`, route not mounted).

Test 12 ("unknown player is a 404") passes on RED because the missing route also 404s. Its liveness comes from mutant C4 below.

**GREEN** (`b0ef8cb4`): 12 of 12 pass.
- Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/trade-market.test.js`, exit 0.
- `test/cross-account-league-access.test.js` walks every GET under `/:leagueId`, now including the new route. It passes 8/8, exit 0, so a non-member is refused. (`server/routes/trades.js` is unchanged since `b0ef8cb4`, so this was not re-run.)

**RED 2** (`429ad650`, skeptic fixes, old table and reader): 5 of 17 fail (log `~/gridiron-local/rnd/skill/TM-09/red2.tap`, local):
- "every committed player-week row keeps hype = price - value": `1772 !== 0` rows broke it (tolerance 0.0006);
- "value curves were fit without 2025": `meta.value_curves_fit_seasons present`;
- "H2 carries the placebo": `decay_confirmed` still published (`true !== false`);
- marketForPlayer: `c_placebo` undefined `!== 0.15`; hype producers: `Cannot read properties of undefined (reading 'map')`.
- The two new mutant-killing tests (size-bin key; route premium pos/available/ratio) pass on RED because the code was already right; their liveness is mutants U-A and C-A below.

**GREEN 2** (`fb0a4406`): 17 of 17 pass, exit 0, same command (log `green2.tap`, local).

## Mutation sweep

`python3 docs/tdd/sweeps/tm09-mutations.py` on `fb0a4406` (+ the 4 new mutant rows): 18 of 18 as designed (log `~/gridiron-local/rnd/skill/TM-09/mutations2.out`, local). First pass on `b0ef8cb4` was 14/14; skeptics then showed U-A and C-A survived the old tests.

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
| C4 call site: 404 guard removed | killed | killed (404 test) |
| U-A premium ignores league-size bin (skeptic) | killed | killed (size-bin key test) |
| U-B placebo dropped from payload | killed | killed (marketForPlayer test) |
| U-C sellHigh dropped from hype producers | killed | killed (hype producers test) |
| C-A call site: position not selected (skeptic) | killed | killed (route test) |
| S1 designed survivor: memo cache disabled (same behaviour) | survives | survives |
| N1 not-applied control (search text absent) | not-applied | not-applied |

## What it does

- **Derivation.** `scripts/rnd/tm09_market_prices.py` reads `trade_sides` and `team_seasons` from `rnd/skill/team_seasons.sqlite`, plus the study caches. It works on 2-team, no-pick sides from 2021-2024 with QB/RB/WR/TE only.
  - Each player given with our value v > 0 gets price = his share of the received package's value, in points above replacement per game (PAR/g).
  - hype = price - value. **Sign: positive = the market paid more than our value.** In each player-week row, price and value are medians over that week's trades and `hype` = round(price - value, 3) from those stored medians (writer `aggregates()` in `scripts/rnd/tm09_market_prices.py`). The first pass stored median(per-trade hype), which broke the stated identity in 1,571 of 2,040 rows (skeptics, WIRING + STRUCTURE lenses); now 0 of 2,054 break it and a test on the committed table pins that. `cells.median_hype` stays the median of per-trade hype and `meta.sign` says so.
  - Our value's ADP-to-ppg curves and k are refit by `rebuild_ev()` leave-target-season-out on 2021-2024 only. `adp_ev.pkl`'s own curves and `K_BY_SEASON` were fit with 2025 outcomes and are no longer used (skeptic, claims lens).
  - It writes `server/data/trade-market/tm09-market-prices.json`: the H1/H2 results, 45 cells, position ratios, and 2,054 player-week rows (2,732 player-weeks under n=3 suppressed).
- **Reader.** `server/services/trade-market.js`: `loadMarketTable` (:44), `marketPremium` (:62), `playerMarketHistory` (:85), `marketForPlayer` (:97).
  - The ratio is served only if `results.h1.passed === true`.
  - Every absence is named: `table_absent`, `no_sleeper_id`, `no_player_week_with_n_ge_3`, `no_cell_or_position_ratio`.
- **Consumer.** `GET /api/trades/:leagueId/market/:playerId` (`server/routes/trades.js:1005`).
  - It uses the league-membership door `league()` and the league's `team_count` and `leagueCurrentWeek`.
  - It is labelled `status: "unconfirmed forward"`, `default_off: true`.
  - No page change. No trade card reads it.

## The numbers

All numbers come from one run on tree `fb0a4406` (script + table; the run happened on the working copy of `429ad650` with the `fb0a4406` script, which was then committed with its output), local corpus, not production: `nice -n 10 $PY scripts/rnd/tm09_market_prices.py --out-json server/data/trade-market/tm09-market-prices.json --obs-csv ~/gridiron-local/rnd/skill/TM-09/obs2.csv` with `PY=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3` (needs scikit-learn). Log `~/gridiron-local/rnd/skill/TM-09/run2.log` (local). The first-pass numbers (run1, tree `0e0553f2`) used 2025-fitted value curves and are superseded.

Intervals are 90% percentile bootstrap over league chains (1,000 resamples, seed 7331). MDE80 = 2.487 x SE.

**Known-nonzero control for the value-curve refit** (scratch `tm09_ev_control.py`, log `ev_control.log`, local): `rebuild_ev()` run with seasons 2021-2025 reproduces `adp_ev.pkl` exactly: 30 curves, max |ppg diff| 0.0, k 3 for every season, same as the pickle. The 2025-free fit (2021-2024) then changes the curves by up to 0.91-1.32 ppg per target season (e.g. target 2024, 1QB ppr, pick 12: 17.647 vs 17.629); k stays 3 for 2021-2024. The first-pass control (`pred_ppg` reproduces `trade_sides.exante_give`, corr 0.99999999, n=231) was on the 2025-fitted curves; `exante_give` itself uses them, so it no longer applies.

**Sample:**
- 12,814 sides in, and 13,135 player observations out;
- dropped: 2,736 sides whose given players were all below replacement, 3,560 given players below replacement, 310 sides moving a non-QB/RB/WR/TE player, 468 empty sides.

**H1: held-out price error** (fit 2021-2023, n=10,754; test 2024, n=2,381). **PASS.**
- Baseline "offer fair value" (price = value): MAE 1.727 PAR/g.
- Model (value x cell ratio): MAE 1.654.
- Gain 0.073 [0.064, 0.083], MDE80 0.014.
- Decision win rate vs the baseline: 0.560 [0.548, 0.573], MDE80 0.019.

**H2: hype decay** (2021-2024, next 4 team games, n=11,729).
- Pre-registered slope: (realized - value) = a + c x hype, c = 0.252 [0.215, 0.290], MDE80 0.056. Per season: 2021 0.17, 2022 0.16, 2023 0.30, 2024 0.42. The pre-registered "decay confirmed" rule (CI below 1, below 1 in >= 3 seasons) passes, **but the rule is not diagnostic** and is published as `prereg_rule_c_below_1` with `prereg_rule_diagnostic: false`, not as "decay confirmed":
  - **Shuffled-price placebo** (skeptic's null, added here, not pre-registered): price permuted across observations with value kept, 200 permutations, gives c = 0.154 [5-95%: 0.137, 0.173]. hype and the outcome share the -v term and v over-predicts, so a price with no market information already gets c well below 1. Reported c minus placebo c = 0.098.
  - **Price coefficient given value** (OLS realized = b0 + b1 x value + b2 x price, chain bootstrap): b2 = 0.137 [0.096, 0.178], MDE80 0.060. Per season 0.08, 0.09, 0.15, 0.26. So the trade price does carry some information beyond our value (CI above 0), and one PAR/g of price above what our value implies moves next-4-game PAR/g by about 0.14.
  - Next 2 team games: c = 0.290 [0.247, 0.330], placebo 0.163, b2 = 0.171 [0.124, 0.215].
- **Plain reading:** the market's price is not pure noise (b2 > 0), and most of a premium over our value does not show up in the next 4 games. The "about a quarter of the premium is realized" sentence from the first pass is withdrawn: about 60% of that c appears with zero market information. The route no longer serves that reading or `decay_confirmed`; it serves c, c_placebo, c_minus_placebo and price_coef_given_value with a reading that says so.
- Decision grade: in 792 1-for-1 trades with both players above replacement, the side that got the higher consensus value won the next 4 games 0.553 [0.519, 0.584] of the time vs the 0.50 coin. MDE80 0.048. This check does not use the slope.

**Exploratory (not pre-registered; `obs2.csv`, local, `python3` one-liners in the session):**
- **H1's gain is one global level, not position/week/size structure.** A single constant ratio 0.9086 fit on 2021-23 gives 2024 MAE 1.6513, slightly better than the cells (1.6540). The ratio is a usable price correction, **not** evidence that "the market discounts RBs by 10%". Part of the level is mechanical: packages are floored at 0, so 1,498 of 13,135 observations have price 0.
- Where hype > 0 only (n=5,056), c = 0.045 (no placebo run on this subset).

## Holdout looks

`docs/evidence/HOLDOUT-LEDGER.md` does not exist on `origin/main`, so the looks are recorded here.

| Unit | Date | Hypothesis | Metric | Result |
|---|---|---|---|---|
| TM-09 (first pass, `0e0553f2`) | 2026-09-23 | H1, H2 | our value v used `adp_ev.pkl` EV curves and `K_BY_SEASON`, fit on 2025 outcomes (`build_02_adp_ev.py:23, 235-248, 275-278`) | 2025 outcomes entered every 2021-2024 value, including the 2024 H1 test fold. No 2025 trade was read and no metric was graded on 2025. Found by the claims skeptic. The first pass's "Holdout looks: none" was wrong. |
| TM-09 (fix, `fb0a4406`) | 2026-09-23 | H1, H2 | value curves and k refit on 2021-2024 only (`rebuild_ev`) | No 2025 trade or outcome is read. All numbers above are from this run. |

Residual (not 2025): value curves for target season s are fit on the other 2021-2024 seasons, so e.g. 2021 values use 2022-2024 outcomes. That is future relative to 2021 but inside the non-holdout seasons, the same leave-one-out design as the study build.

## Forward holdout

Not available: the corpus has no 2026 Sleeper trades. The table therefore ships **default-off, labelled "unconfirmed forward"**, and only the route reads it.

## Known defects

1. "Our value" here is the study's consensus forecast (season ppg shrunk to ADP ppg, k=3), not the app's live value (FantasyCalc / ROS projections). Magnitudes do not carry to the app; direction may.
2. Replacement levels are league season-window (hindsight) values from the study build. The ADP-to-ppg curves and k are leave-target-season-out over 2021-2024 (fixed in `fb0a4406`; the first pass used 2025-fitted curves, see Holdout looks).
3. H1 is one held-out fold (2024). The gain is mostly a global level shift (see Exploratory).
4. H2's pre-registered slope is not diagnostic (placebo c = 0.154). The price-given-value coefficient (0.137) is the better read; it is still attenuated by noise in the package valuation. The 1-for-1 decision grade (0.553) is the check that does not rely on a slope.
5. Realized counts a missed team game as 0 points, and our value ignores availability. This mostly moves the intercept, not c.
6. `leg_week` is Sleeper's transaction leg, and every as-of cut uses `t_done_ms`.
7. File allocation: `server/routes/trades.js` is shared. This unit adds one route and one import only, as the unit row named. The coordinator should confirm the grant.

## Nick's five questions

1. **Well built?** Yes, within scope:
   - a pre-registered derivation;
   - a reader with every absence named and a H1 ship gate;
   - one route behind the league-membership check;
   - 17 targeted tests, 18/18 mutants as designed (4 added after the skeptics), and the cross-account test passing with the new route.
2. **Stats or made up?** Stats. They come from 13,135 real trade observations (2021-2024) with chain-bootstrap intervals. The bins and the n >= 3 and n >= 30 thresholds are hand-set, as pre-registered.
3. **How we know:**
   - backtest: H1 fit 2021-23, test 2024, MAE 1.727 -> 1.654, win rate 0.560 (2025-free values);
   - H2: pre-registered c = 0.252 but the shuffled-price placebo gives 0.154, so the rule is not diagnostic; price coefficient given value 0.137 [0.096, 0.178];
   - 1-for-1 decision grade 0.553 [0.519, 0.584];
   - no forward holdout.
4. **Pointed anywhere else?** Only `GET /api/trades/:leagueId/market/:playerId`. No page and no trade card reads it.
5. **How it unifies:**
   - It sits beside FantasyCalc `dynasty_values` and does not replace it: the route says so in `note`.
   - Two other hype producers exist: `players.js:139` "sell into the hype" (FantasyCalc momentum) and `waiver-brain.js:452` `sellHigh` (FantasyCalc value above the league's value-vs-projection curve), both live 2026; the route names both in `other_hype_producers`.
   - The follow-up is AI-04 (price model): one "market price" and one "hype" number, unifying all three, with FantasyCalc as the live input and this table as its historical calibration.

What would make it wrong: the app's live value differing from the consensus forecast by more than the premium, or the Sleeper trade market (mostly casual public leagues) pricing differently from Nick's ESPN leagues.
