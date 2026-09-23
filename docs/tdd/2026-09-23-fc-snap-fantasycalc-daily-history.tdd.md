# FC-SNAP: FantasyCalc values refresh daily, keep their history, and say how old they are

Unit FC-SNAP = RL-3-1 + RL-4-3 (plan items C12 FantasyCalc disagreement test, S-10 one value store,
TM-09 / AI-04 market price, F3 freshness). R&D packages: `rnd/loop/r3-external-fantasycalc-history-gap.md`,
`rnd/loop/r4-internal-trade-market-price-frozen.md` (both outside the repo).

Tree for every "before" figure below: origin/main `89f69b3b`.

## 1. Audit: what exists, extend or build

| Surface | What is on main (`89f69b3b`) | Command | Decision |
|---|---|---|---|
| Current value store | `dynasty_values` (PK `format_key, player_id`, `server/db/schema/core-and-fantasy.js:205`), written only by `syncDynastyValues` (`server/routes/aggregates.js:130`), upsert at `:149-155` | `git grep -n syncDynastyValues origin/main -- server client scripts` → aggregates.js:130/191/319, leagues.js:220-221, a comment in dynasty-age-curve.js | **Extend**: same writer, same fetch, no second producer |
| Value history | none | `git grep -il dynasty_value_history origin/main \| wc -l` → 0 (control: `dynasty_values` → 27 files) | **Build**: `dynasty_value_history`, written in the same loop as the upsert |
| Timer | none; three manual callers only (league sync button, `/aggregates/sync`, `/aggregates/refresh-all`). `fantasycalc_dynasty` sits in `MANUAL_SOURCES` (`server/services/source-registry.js:178-184`) with a declared daily cadence nothing enforces | `git grep -n -i "fantasycalc\|syncDynasty" origin/main -- server/services/scheduler.js \| wc -l` → 0 (control: `syncSleeper` → 4) | **Build**: daily `fantasycalc_dynasty` job beside `sleeper_players`; move the source from `MANUAL_SOURCES` to `JOBS` (allSources() does not dedupe) |
| Join | Sleeper id, then name key; FantasyCalc's `espnId` never read | `git grep -n espnId origin/main -- server/routes/aggregates.js \| wc -l` → 0 (control: `sleeperId` → 4) | **Extend**: ESPN id, then Sleeper id, then name |
| Rows FantasyCalc stops returning | kept at their old price forever | `git grep -n "retired_at\|in_latest_pull" origin/main -- server \| grep -i dynasty \| wc -l` → 0 | **Build**: additive `dynasty_values.retired_at`; readers skip retired rows. Values are kept, not nulled or deleted |
| Freshness | `FALLBACK_REGISTRY` (the live registry: source-registry.js exports no `servedTables()`) covers `player_week_usage` only | `git grep -n dynasty_values origin/main -- server/services/data-freshness.js \| wc -l` → 0 (control: `player_week_usage` → 3) | **Extend**: second entry, `dynasty_values`, stale after 24 h, matching source-registry.js:182 |
| Asset cache stamp | `{ table: 'dynasty_values', stamp: 'player_id' }` (`server/services/trade-engine.js:204`): an in-place re-sync keeps the row count and the max player id, so the trade cache never sees new prices | read of `compute-cache.js:48-69` (`COUNT(*)` + `MAX(stamp)`) | **Fix**: stamp `fetched_at` (found in this audit; a daily sync makes it bite every day) |
| Attribution | the client names FantasyCalc 5 times and links it 0 times; FantasyCalc's terms ask for a visible link to FantasyCalc.com | `git grep -n -i fantasycalc.com origin/main -- client \| wc -l` → 0 (control: `fantasycalc` → 5) | **Extend** F-08's `DataCredit` line (on every page) plus the Trade Lab "market as of" line |
| Second producer of the same concept | `player_metrics.fc_value` from `syncFantasyCalc` (`aggregates.js:88-122`), one global redraft set priced off the first league's shape, read by leagues.js:262, rankings.js, nfldata.js, players.js, edge.js | `git grep -n "fc_value" origin/main -- server` | **Named, not unified here**: that is the rest of S-10 (`value` vs `redraft_value`, leagues.js). See Known defects |

Licence: FantasyCalc's terms and API docs were read by R3 (2026-09-23, from the site bundle; the pages
are client-rendered): documented endpoints only (`GET /values/current`, `GET /players`), non-commercial
use, caching "ideally ... once per day" encouraged, a visible link to FantasyCalc.com required. The
per-player history endpoint is explicitly off-limits. This unit calls only `/values/current`, at most
once per format per day from the timer, and every test mocks `fetch` (no network, nothing paid).

Not statistical: no model number is produced, so no pre-registration; no 2025 look (no Holdout-ledger
row). Decision grading does not apply: this changes which price the trade surfaces read, not a decision
rule. The forward disagreement test (C12) that this history enables is a separate, pre-registered unit.

## 2. RED / GREEN

- **RED** `3886672c` "test: RED — FantasyCalc history, id-first join, retirement, daily job, freshness, attribution (FC-SNAP)".
  `test/dynasty-value-history.test.js` on the unfixed code: 15 of 17 fail, 2 pass. The 2 that pass are
  regression guards, not REDs: the Sleeper-id join (main already reads Sleeper id first, so RL-4-3's
  "RED 2" is a guard here) and the endpoint allow-list. Failing assertions, verbatim:
  - history: `expected: '2026-09-21 12:00:00'  actual: '2026-09-23 06:33:09'` (main ignores the injected clock and upserts; no history table)
  - ESPN-id join: `Marvin Harrison Jr. has no price: the name collision dropped him  expected: 690`
  - id beats name: `the price follows the id FantasyCalc sent  expected: 2000`
  - retirement: `retired by the pull that no longer returned him  expected: '2026-09-21 12:00:00'`
  - timer: `no scheduled job refreshes FantasyCalc: the price is whatever the last button press fetched`; RL-4-3 RED 1: `the job failed: unknown job`
  - freshness: `the freshness registry never looks at dynasty_values`
  - cache: `expected: 'fetched_at'  actual: 'player_id'`
  - reader route: `expected: 200  actual: 404`; rosters: `expected: 'rd_sf1_t10_ppr1'` (no `market_as_of`)
  - attribution: `FantasyCalc's terms ask for a visible link to FantasyCalc.com; the credit line has none`; `client/src/components/MarketAsOf.tsx does not exist`
- **GREEN** `7bd8eaaf` "feat: FantasyCalc values refresh daily, keep a day-by-day history, join by id, retire dropped rows (FC-SNAP)". 17/17 pass.
  The GREEN commit also changed one RED test (test 10 now resets the mocked payload and asserts
  `sync_log.last_status = 'ok'`). Liveness re-checked after that change: the GREEN-commit test file
  run against the RED-commit code gives the same 15 fail / 2 pass.
- **RED 2** `62e8209d` "test: RED — a truncated FantasyCalc pull must not retire the players it left out (FC-SNAP)".
  It fails on `7bd8eaaf` with `one player back out of five is a broken pull, not four retirements  1 !== 5`.
- **GREEN 2** `5fe81224` "fix: a truncated FantasyCalc pull retires nobody (FC-SNAP)". 18/18 pass.

Command for every test run: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`.

## 3. What it does (file:line on `5fe81224`)

- **Writer, one fetch, three writes**: `syncDynastyValues` (`server/routes/aggregates.js:148`).
  - Table `dynasty_values`: upsert at `:174`. It now also clears `retired_at`.
  - Table `dynasty_value_history`: `INSERT ... ON CONFLICT DO NOTHING` at `:180`, same loop, same response. The day's first capture wins.
  - `dynasty_values.retired_at` stamped at `:233-236` for rows this pull did not return. The value stays on the row. A pull that matched 0 players (`:218`), or that left out more live players than it returned (`:228`, "truncated"), retires nobody and reports an error for that format.
  - Join at `:204`: FantasyCalc `espnId` → `players.espn_id`, then `sleeperId` → `players.sleeper_id`, then the name key.
  - The league read at `:150-151` now names only the columns `deriveFormat` uses. It used `SELECT *`, which read the ESPN cookie columns.
- **Migration** `server/migrations/073_dynasty_value_history.js` (additive): new table `dynasty_value_history` (PK `format_key, player_id, captured_on`) + index, and a new nullable column `dynasty_values.retired_at`. Numbered 073 because 068 (#93), 071 (queued RL-1-1) and 072 (#164) are claimed. 069 is unclaimed on every remote branch and local worktree, but it would sort before 070, which is on main.
- **Timer**: job `fantasycalc_dynasty` (`server/services/scheduler.js:1270`, run fn `refreshFantasyCalcValues` `:1189`). It is daily (`MARKET_MAX_AGE_MINUTES` = 1440), growth tier, off-thread. It skips when no league is connected. It was removed from `MANUAL_SOURCES` (source-registry.js). It shares its `sync_log` row with the league-sync button, so a press counts as that day's run.
- **Reader**: `server/services/dynasty-value-history.js`. `currentMarket` (`:45`) returns live rows only. `marketAsOf` (`:59`) returns fresh / stale / empty / table_absent plus the age in hours. `marketHistory` (`:85`).
  - `currentMarket` is read by `trade-engine.js:335` and `routes/tradelab.js:28` (both used to query `dynasty_values` directly).
  - `marketAsOf` and `marketHistory` are read by `GET /api/trades/:leagueId/market-history/:playerId` (`routes/trades.js:904`).
  - `marketAsOf` is also read by `GET /api/trades/:leagueId/rosters` (`market_as_of`, `:874`).
  - Wiring map (`node scripts/wiring-map.mjs --out <scratch>`): `dynasty_value_history` read_by `dynasty-value-history.js:87`, route family `/api/trades` at 1 hop.
- **Freshness**: second `FALLBACK_REGISTRY` entry `dynasty_values` (`data-freshness.js:386`), grain `static`, current when fetched within `MARKET_MAX_AGE_MINUTES`. The banner now lists it.
- **Cache**: `ASSET_INPUT_TABLES` stamps `dynasty_values.fetched_at` (`trade-engine.js:207`).
- **Page**: Trade Lab shows `<MarketAsOf>` under the intro (`client/src/pages/TradeLab.tsx:114`, component `client/src/components/MarketAsOf.tsx`). It reads "Market as of Sep 23 (3 hours old), trade values from FantasyCalc.com", turns amber past 24 h, and says so when no price has been fetched. The data-credit line under every page now ends "Trade values from FantasyCalc.com" with the link (`DataFreshnessBanner.tsx:259`).

## 4. Numbers (each with its command and tree)

**Local copy, not production.** `sqlite3 ~/gridiron-local/data.sqlite ".backup .local-db/data.sqlite"` taken 2026-09-23 02:38 ET.

Before, tree `89f69b3b` schema:
- `select format_key,count(*),min(fetched_at),max(fetched_at) from dynasty_values group by 1` → `rd_sf1_t10_ppr1|213|2026-09-03 18:38:23|2026-09-19 01:01:54` and `rd_sf1_t8_ppr1|212|…|2026-09-19 01:01:54`.
- Marvin Harrison Jr. (player 4) stored 1463 (t8) / 1478 (t10), fetched 2026-09-03. Mike Washington Jr. (463) stored 602 / 607, fetched 2026-09-03.
- `sync_log.fantasycalc_dynasty.last_run_at` = 2026-09-19T01:01:54Z.

Replay on `7bd8eaaf`: `.local-db/replay.mjs` runs `syncDynastyValues` with `fetch` mocked to serve the two pulls R4 saved from the documented endpoint (`rnd/loop/data/r4i/fc_rd_t{8,10}_20260923T0605Z.json`, 2026-09-23 06:05Z). No network. The output is in the session scratchpad.
- Replay tree is `7bd8eaaf`. `5fe81224` only adds the truncation branch, which this replay does not reach (15-16 missing vs 199 returned).
- Migration applied: `073_dynasty_value_history`. Outbound URLs: 2, both `https://api.fantasycalc.com/values/current?…`.
- Per format: 199 fetched, **199 matched by id, 0 by name**, 0 picks, 199 history rows. Retired: 15 (t8), 16 (t10).
- Marvin Harrison Jr. now 708 / 715 and Mike Washington Jr. 157 / 158, both fetched 2026-09-23 06:05, both live. On main's join these two were the 2 of 199 unjoined entries (R4 `fc_match.out`, a replay of main's join logic on the same pull; not re-run here).
- `marketAsOf` one hour after the pull: `state fresh, age_hours 1, live_rows 199, retired_rows 15/16`.
- Retired rows' last stored values, t10 (`select … where retired_at is not null order by value desc`): max 195, then 88, 86, 79 …, all rostered (16 distinct rostered players across both formats), 24 of the 31 fetched before 09-19. Under `m?.value ?? 0` they now price at 0 instead of a stale ≤195. That is the direction R4 asked for, though R4 preferred "unknown" (Known defects).

Second producer of the same concept: `select source,count(*) from player_metrics where source like 'fc_%'` on the copy → 0 rows (control: `select count(*) from player_metrics` → 1861). So on the local copy `player_metrics.fc_value` (from `syncFantasyCalc`) is empty, and there is no same-input pair of values to compare. It stays the S-10 follow-up.

Related targeted suites on the GREEN tree: all pass except `data-freshness-route` test 5, which needed updating. The registry's second entry makes `all_fresh` also require a price fetched today, so the test now seeds one and asserts it reads fresh. Suites run (34 files): asset-cache-stamps, asset-universe-fingerprint, b-01-real-record-odds, cross-account-league-access, data-credit-line, data-freshness(-banner-swap/-evaluator-delegation/-grain/-route/-rule-contract), find-trades, growth-jobs-off-thread, hand-fed-registry-wins, hand-fed-table-states, inventory-route-callers, league-brain, legacy-route-security, manager-data-pipeline, nfl-prospective-collection, nflverse-attribution, post-draft-plan, ros-projection(-failure)-wiring, scheduler-fantasy-sources, scheduler-job-modules, scheduler-off-thread, trade-engine-correctness, trade-evidence, trade-route-retirement, trade-tactics, valuation-map, valuation-panel, waiver-*, wiring-map. The 9 suites that open the database without running migrations (trade-brain-surface, trade-proposals, trade-risk-strip-unreadable, trade-season-span, lineup-spread, fantasy-workflows, coach-verify, lineup-posture-scope, data-credit-line) also pass after `currentMarket` learned that a database without `retired_at` has no retired rows. `node scripts/wiring-map.mjs --check` → exit 0.

## 5. Mutation sweep (M1-M13, S1, C1 on tree `7bd8eaaf` in a scratch worktree; M14 on `5fe81224`; `test/dynasty-value-history.test.js`; line numbers are those trees')

| Mutant | Where | Result | Killed by |
|---|---|---|---|
| M1 history row overwritten on same day | unit, aggregates.js:180 | killed | test 1 (later tests cascade from the aborted reset) |
| M2 name key before id | unit, :205 | killed | test 4 |
| M3 ESPN-id join removed | unit, :204 | killed | tests 2, 4 |
| M4 no retirement | unit, :227 | killed | test 5 |
| M5 empty pull allowed to retire | unit, :219 | killed | test 7 |
| M6 reader ignores `retired_at` | unit, dynasty-value-history.js:31 | killed | test 5 |
| M7 job cadence ×7 | call site, scheduler.js:1271 | killed | test 9 |
| M8 /rosters asks the wrong format | call site, trades.js:874 | killed | test 14 |
| M9 Trade Lab line not mounted | call site, TradeLab.tsx:114 | killed | test 17 |
| M10 cache stamp back to `player_id` | call site, trade-engine.js:207 | killed | test 12 |
| M11 freshness window 100000 min | unit, data-freshness.js | killed | test 11 |
| M12 tradelab reads `dynasty_values` directly | call site, tradelab.js:28 | killed | test 6 |
| M13 credit link removed | unit, DataFreshnessBanner.tsx:259 | killed | test 16 |
| M14 truncation guard removed (`if (false)`) | unit, aggregates.js:228 on `5fe81224` | killed | test 8 (truncated pull) |
| **S1 designed survivor**: retire UPDATE drops its `AND retired_at IS NULL` | aggregates.js:225 | **survived**, as designed | equivalent mutant: the loop at :227 only visits rows with `retired_at IS NULL`, so the guard is redundant. Kept as belt-and-braces; recorded, not a test gap |
| **C1 not-applied control**: pattern absent | aggregates.js | not applied, suite green | shows the harness reports "not applied" separately from "survived" |

14 of 14 real mutants killed, including 6 call-site mutants.

## 6. Known defects / not covered

- **Retired or unpriced = 0, not unknown.** `buildAssetUniverse` (`trade-engine.js`, `value: m?.value ?? 0`) and `tradelab.js` still price a missing market row at 0. R4 asked for a null to mean unknown. Follow-up: make an unpriced asset unknown on trade cards (touches the deal score, so it goes to the Independent Auditor).
- **S-10 remainder.** `player_metrics.fc_value` (`syncFantasyCalc`, one global redraft set on the first league's shape) is still a second producer, read by leagues.js / rankings.js / nfldata.js / players.js / edge.js. It is empty on the local copy, so there is no same-input disagreement to show. Unifying it on `dynasty_values.redraft_value` is S-10's `value` vs `redraft_value` decision.
- **`syncSleeper` still joins name before ESPN id**, so the 5 collided current players still miss `sleeper_id` and the Sleeper injury flag (R4 §2). Not in this unit's files.
- **History starts today.** Weeks 1-3 of 2026 are gone. C12's forward FantasyCalc disagreement test needs its own pre-registration and about 6 weekly cutoffs (W4-W9) before it can be read (R3 §5).
- **Public launch.** FantasyCalc's API docs ask public apps to email them before launch. That is Nick's call and is not done here.
- The history keeps the first capture of each UTC day. An intraday move after that capture is in `dynasty_values` but not in the history.

## 7. Nick's five questions

1. **Well built?** One fetch per format feeds all three writes. The migration is additive only. Every SQL statement is parameterised (the one spliced clause is a code constant). There is no bare catch. The league read no longer selects the cookie columns. 18 tests, 14/14 mutants killed.
2. **Stats or made up?** No model number. The 24 h window is FantasyCalc's own "once per day" caching guidance plus the cadence source-registry already declared. It is a hand-set constant, and it is a guess only in the sense that a 20 h or 30 h window would be just as defensible.
3. **How we know:** tests on a fixture (section 2) and a local-copy replay on R4's saved pulls: 199/199 joined by id, Marvin Harrison Jr. 1478 → 715. No backtest applies. No 2025 look (no Holdout-ledger row).
4. **Pointed anywhere else?** Trade Lab and the trade engine now read `currentMarket`. The freshness banner lists `dynasty_values`. The credit line on every page links FantasyCalc.com. The new route serves the history.
5. **How it unifies:** one writer (`syncDynastyValues`), one reader module (`dynasty-value-history.js`), one freshness budget (`MARKET_MAX_AGE_MINUTES`, used by the job, the registry and the page). The remaining second producer (`player_metrics.fc_value`) is named above as S-10's follow-up.

- Defect fixed: `server/routes/aggregates.js:149-155` on `89f69b3b` (upsert-only, name-then-Sleeper join, no retirement, no timer).
- Incumbent: `git grep -n syncDynastyValues origin/main -- server/services/scheduler.js` returns nothing, so there was no timer.
- Not covered: the unknown-vs-0 price, S-10's `fc_value`, and `syncSleeper`'s join.
- What would make it wrong: FantasyCalc changing its `espnId` field or ids (the name fallback still runs), or a partial pull that still returns more than half of the live board. That would retire the missing players until the next good pull. A pull returning less than half is already refused (`aggregates.js:228`), and the daily job heals the rest the next day.
