# S-19: one hype producer

Unit S-19 (plan item Structure / Trade Machine). Branch `claude/local-s-19-one-hype-producer`.
Base: `origin/main` `3ac59fea`, with PR #183 (TM-09, branch `claude/local-tm-09-market-prices`, head `5a8cb0ad`,
still OPEN when this unit started) merged in. The merge was a fast-forward: #183's head already contained
`3ac59fea`. So this branch carries #183's commits and must merge after it (or with it).

## Audit: extend or build

Producers of "hype / sell high" on this tree (`grep -rn -i 'sellHigh\|heuristicVerdict\|sell_high\|sell-high\|hype' server client/src scripts`):

| Producer | What it computes | Test | Who reads it |
|---|---|---|---|
| `server/routes/players.js:139` `heuristicVerdict` | FantasyCalc 30-day momentum from `player_metrics` sources `fc_value`/`fc_trend30` (writer `syncFantasyCalc`, `server/routes/aggregates.js:88`, upsert `:104`): > +5% = SELL "sell into the hype", < -5% = BUY | none (`grep -rn heuristicVerdict test` = 0 hits) | `POST /api/players/:id/analyze` no-key branch (writes `player_analysis.verdict`) and the AI branch fallback; the page is PlayerCard "Get verdict" (`client/src/components/PlayerCard.tsx:96`) |
| `server/services/waiver-brain.js:452` `sellHigh` | live FantasyCalc value above a per-position log-log value-vs-projection curve, z >= 1 | none (only `test/trade-route-retirement.test.js:84` G7c, which asserts `typeof sellHigh === 'function'`) | nobody: its route is retired (`server/routes/trades.js:193`), and the trades.js comment that it "remains an input to the hype-window tactic" is false: `trade-tactics.js:776-806` reads `manager.gaps` (usage gaps), not `sellHigh` |
| TM-09 (#183) `server/data/trade-market/tm09-market-prices.json`, reader `server/services/trade-market.js` | hype = revealed Sleeper trade price minus consensus value, PAR/g, 2021-2024 player-weeks with n >= 3 trades | pre-registered held-out test (H1 passed: MAE gain 0.073 PAR/g, 90% CI 0.064-0.083; decision win rate 0.560, CI 0.548-0.573) and H2 decay with shuffled-price placebo; ships default-off, "unconfirmed forward" | `GET /api/trades/:leagueId/market/:playerId` (#183) |

Not in the unit row but found by the same grep, named here so nothing is hidden:
- `expectationGaps` (`server/services/talk-vs-model.js:51`, reads table `nfl_ffopportunity_weekly`) feeds the Trade Brain `hype_window` tactic (`trade-tactics.js:776`) and `hype_vs_usage` (`counterparty-pricing.js:78`, via `:253`). It is already one producer, and it is a different concept (actual minus expected points from usage, not price minus value). Not unified here; follow-up named below.
- `playerEvidenceFacts` `market.trend` (`players.js:151`) states the raw FantasyCalc 30-day change as a fact for the AI to pick. It is a datum, not a verdict, and is left as is.

**Decision: extend.** TM-09 is the only producer with a held-out test, so it is the canonical one. The two heuristics have no test (above), so both retire to call it. The new module `server/services/hype.js` `playerHype` is the one producer; it reads TM-09's table through #183's `loadMarketTable`. No new table, no migration.

## Three producers on the same players (local copy, not production)

Command (tree = this branch before any code change, `5a8cb0ad`; DB = `.backup` of `~/gridiron-local/data.sqlite` taken 2026-09-23):
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite node scripts/rnd/s19_hype_compare.mjs`

Players: every rostered player on every team in the 5 synced leagues, 758 league-player pairs.

| Reading | Count |
|---|---|
| `heuristicVerdict` as served (input `player_metrics` fc_value / fc_trend30) | null for 758 of 758: 0 `fc_value` and 0 `fc_trend30` rows. Control: `player_metrics` holds 1,861 rows (sources `sleeper_rank` 1,627, `injury_flag` 234), so the table is read; `sync_log` has no `fantasycalc_values` row at all. On this DB the no-key "Get verdict" always 400s and the AI fallback is always HOLD. |
| the same heuristic rule applied to the league-format FantasyCalc trend (`dynasty_values.redraft_value`/`trend30`, writer `syncDynastyValues`, `aggregates.js:130`) | SELL 188, BUY 342, HOLD 122, no value 106 |
| `sellHigh` flag (run for every team's roster, limit 999) | 89 |
| TM-09 row for the player in any season | 431 (latest season: 2024 366, 2023 56, 2022 3, 2021 6) |
| TM-09 row for the player in 2026 | **0** (the table has no 2026 trade; no 2026 Sleeper trades are in the corpus) |

Disagreements:
- heuristic SELL and sellHigh flag agree on 22 players; heuristic SELL without a sellHigh flag 166; sellHigh flag without heuristic SELL 67, of which **57 are heuristic BUY**. The two live heuristics give the opposite call on 57 of sellHigh's 89 flags (64%).
- TM-09's latest (2021-2024) hype sign vs sellHigh's 2026 flag: flagged and TM-09 hype > 0: 11; flagged and TM-09 hype <= 0: 37; not flagged, hype > 0: 140; not flagged, hype <= 0: 243. These are different seasons, so this is description, not a test of either.

## Commits

| Step | Subject | sha |
|---|---|---|
| audit | docs: S-19 audit and three-producer comparison on the same players | `2a8c0086` |
| RED | test: RED for S-19 one hype producer contract (analyze, sellHigh, TM-09 route) | `bd4e9bb6` |
| GREEN | feat: S-19 one hype producer (hype.js#playerHype); retire heuristicVerdict and sellHigh's curve to call it | `2c12b915` |
| sweep | test: S-19 pin the season gate and no_sleeper_id reason (sweep survivors M1, M4); add mutation sweep | `1f385059` |

No pre-registration: this unit runs no new model number. It picks the producer that already has one (TM-09, `9e405725` on #183) and adds no fit, threshold or grade.

**RED** (`bd4e9bb6`, stub `playerHype` returning `{available:false, reason:'not built'}`, no surface wired): 7 of 7 fail.
Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/hype-one-producer.test.js`, exit 1.
- contract, player 90001: `analyze (no API key) hype` — `+ undefined - { available: false, reason: 'not built' }`;
- retired heuristic: `assert.notEqual(res.body?.verdict, 'SELL')` — actual `'SELL'`: the old heuristic turned a +25% FantasyCalc month into SELL "sell into the hype" and wrote it to `player_analysis`;
- retired sellHigh: `both rostered players are read` — `false`;
- control: `hyped.available` — `false !== true`.

Test edits after RED, before GREEN passed: the AI-branch mock returned a bare string where `parseJson` (`server/services/claude.js:267`) needs `{content:[{type:'text'}]}`, so the AI branch 500'd; fixed the mock and added a JSON error handler and the status/body to that assertion's message. The RED failures above are on assertions before that one.

**GREEN** (`2c12b915`): 7 of 7 pass, exit 0 (same command). Also on this tree, targeted:
- `test/trade-market.test.js` 17/17 (its "names every hype producer" test now asserts `other_hype_producers` is `[]` and the note names `hype.js#playerHype`);
- `test/trade-route-retirement.test.js` 5/5; `test/waiver-brain.test.js` 8/8; `test/legacy-route-security.test.js` 6/6; `test/model-integrity.test.js` 89/89; `test/table-read-but-never-created.test.js` 11/11; `test/wiring-map.test.js` 90/90;
- `test/route-deletion-impact.test.js` 7/8: test 6 ("a call site inside an already-unreached function is a survivor") fails identically on `bd4e9bb6` (before any code change; `git stash` run). It is a fixture-only test of `scripts/route-deletion-impact.mjs`, which this unit does not touch. Pre-existing, reported, not fixed.

## What it does

- `server/services/hype.js` `playerHype({ sleeperId })` is the one producer. It reads TM-09's table (via `trade-market.js#loadMarketTable`) and serves the player's latest row from the current season at or before the current week (`tradeWeekContext()`), else `available:false` with the reason. `verdict` is always null: TM-09 is default-off ("unconfirmed forward", no 2026 trade prices).
- `POST /api/players/:id/analyze` (`server/routes/players.js:175`, call `:184`): `heuristicVerdict` is gone. Both branches return `hype` unchanged. No key: 400 with the reason and `hype` (it used to write a momentum SELL/BUY/HOLD). AI branch: fallback verdict is `hype.verdict ?? 'HOLD'`, which is `'HOLD'` today, as it already was on the local copy (no `fc_*` rows). Page: PlayerCard "Get verdict" (`client/src/components/PlayerCard.tsx:96`) shows the 400 message in its existing error slot.
- `sellHigh` (`server/services/waiver-brain.js:461`, call `:466`): the curve is gone. It reads `playerHype` for each rostered player (rosters from `trade-engine#loadRosters`) and flags only `verdict === 'SELL'`. Still no caller.
- `GET /api/trades/:leagueId/market/:playerId` (`server/routes/trades.js:1007`, call `:1015`): adds `hype` from `playerHype`. `trade-market.js` `OTHER_HYPE_PRODUCERS` is now `[]`, and its note points at the one producer.
- **Scope of "one producer".** It covers the price-minus-value concept (market hype / sell-high): PlayerCard verdict, `sellHigh`, the TM-09 route. It does NOT cover the usage-gap surfaces `hype_window` (`trade-tactics.js:795`) and `hype_vs_usage` (`counterparty-pricing.js:634`), which measure actual minus usage-expected points from `expectationGaps` (`talk-vs-model.js:51`). They are one producer of a different concept. Their served text now names `services/hype.js#playerHype` as the price-hype number they are not (`bb8e06c4`).
- `trade-engine.js` `tagDeal` served a `'Sell High'` tag on trade cards (`client/src/components/TradeCard.tsx:212`, `deal.tags`) from an age rule: `oldest(give) >= 29 && youngest(get) < oldest(give)`. It read no price. Renamed `'Sell the Veteran'` in `bb8e06c4`, so no surface outside `hype.js` claims sell-high. `grep -rn "Sell High" server client/src` then finds only the explanatory comment.
- Stale claims fixed: `trades.js:185-198` said `sellHigh` "remains an input to the hype-window tactic" (served in the retired route's body). It was never read there.

## Liveness (local copy, not production)

`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite node <scratch>/live.mjs` on `1f385059`. The script calls `sellHigh(id)` for each league and `playerHype` for every player with a sleeper id. No route was called, because the local copy may hold an API key and the AI branch costs money.
- 5 leagues, 83 of Nick's rostered-player readings; 0 available; 0 candidates. Reasons: 76 "no revealed trade price for this player in 2026 (table covers 2021-2024)", 7 `no_sleeper_id`.
- Every player with a sleeper id: 0 available. Control: the table holds 2,054 player-week rows, 0 of them from 2026. The zero is the table's coverage, not a dead reader: the contract test's fixture row is served (test 1).

## Mutation sweep

`python3 docs/tdd/sweeps/s19-mutations.py` on `bb8e06c4`: 19 of 19 as designed (69 s). On `1f385059` it was 14 of 14; a skeptic then found mutant MU1 (`r.week > hit.week` flipped to `<`, serving the EARLIEST eligible week) survived all 7 tests, because the fixture had only one eligible current-season row. Fixed in `c884f43d`: `NFL_WEEK=6` and three eligible rows in scrambled order (weeks 3, 6, 2) plus a future week 18, and the control asserts `week === 6`. Now M6 (earliest), M7 (first row) and M8 (last row) are all killed. The first pass on `2c12b915` + sweep had 2 unplanned survivors:
- M1 (season gate removed) survived because the old-season fixture row sat at week 5, so the week gate hid it;
- M4 (no_sleeper_id guard removed) survived because `String(null)` matched nothing and still read unavailable.
Both were closed in `1f385059` (old row at week 1; assert `reason === 'no_sleeper_id'`).

| Mutant | Expected | Got |
|---|---|---|
| M1 season gate removed | killed | killed (control) |
| M2 as-of week gate removed | killed | killed (control: week-18 row) |
| M3 hype made a SELL call | killed | killed (default-off; retired heuristic) |
| M4 no_sleeper_id guard removed | killed | killed (control) |
| M5 served hype = price | killed | killed (control) |
| C1 analyze no-key drops `hype` | killed | killed (contract x3) |
| C2 analyze AI branch drops `hype` | killed | killed (contract x3) |
| C3 analyze keys on player id | killed | killed (contract) |
| C4 market route keys on null | killed | killed (contract) |
| C5 sellHigh keys on player id | killed | killed (contract) |
| C6 sellHigh flags without the producer | killed | killed (retired sellHigh) |
| C7 analyze writes a verdict with no signal | killed | killed (retired heuristic) |
| M6 selection order flipped (earliest eligible week) | killed | killed (control) |
| M7 first eligible row wins | killed | killed (control) |
| M8 last eligible row wins | killed | killed (control) |
| C8 trade-engine tag says 'Sell High' again | killed | killed (scan) |
| C9 hype_window why names the removed sellHigh curve | killed | killed (scan) |
| S1 designed survivor: `>=` week tie-break (weeks unique per player-season) | survives | survives |
| N1 not-applied control | not-applied | not-applied |

## Skeptic round 2 (RED/GREEN)

- RED `c884f43d` (test: S-19 RED for skeptic findings): with `server/` from `f94fb55a` (`git stash push -- server`), `test/hype-one-producer.test.js` is 7 pass / 1 fail: test 8 "no other served string claims sell-high or names the removed sellHigh curve" fails (control `expected: true, actual: false`: trade-engine still pushes `'Sell High'`). The latest-week gap is shown by M6-M8 in the sweep instead: they are killed only with the new fixture.
- GREEN `bb8e06c4`: `hype-one-producer` 8/8; `trade-tactics` 39/39; `valuation-map` 47/47 (the two test files that name `hype_window`/`hype_vs_usage`). Command per file: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`.
- `grep -rn "market-price curve in waiver-brain#sellHigh" server` on `bb8e06c4`: 0 hits (was 2).

## Statistical discipline

- No model result ships ON. Hype is served default-off with `verdict: null`, labelled "unconfirmed forward" (no 2026 trade prices, so no forward holdout exists).
- No decline, so no MDE is owed. Decision win rate: not applicable, because no start/sit, waiver or trade call reads hype. The one call it touched (the no-key SELL/BUY) is withdrawn, not replaced.
- Historical replay: not applicable (no start/sit-facing claim).

## Known defects / follow-ups

- **This branch contains #183.** Merge #183 first (or together). If #183 changes `trade-market.js` or its test, this branch has to merge it again.
- `expectationGaps` (`talk-vs-model.js:51`) is a separate "hype" word: usage gap, used by `hype_window` and `hype_vs_usage`. It is one producer of a different concept, scoped out of this unit (see "Scope" above). Follow-up (not yet a queue row; the coordinator owns WORK-QUEUE): rename the tactic label ("outscoring his usage") so the word "hype" means one thing. The two served strings that named the removed `sellHigh` curve were fixed here (`bb8e06c4`), and a scan test now fails if any server file names `waiver-brain#sellHigh` again.
- `player_metrics` `fc_value`/`fc_trend30` (writer `syncFantasyCalc`, `aggregates.js:88`) have 0 rows on the local copy, and `sync_log` has no `fantasycalc_values` run. The `market.trend` evidence fact in the AI packet is therefore always empty there. Not this unit's surface; reported.
- No-key users lose the momentum SELL/BUY. This is intended: it was untested, and it contradicted `sellHigh` on 57 of 89 flags.
- `sellHigh` still has no caller. It is kept because `test/trade-route-retirement.test.js` G7c asserts it exists. Deleting it is a separate decision.

## Nick's five questions

1. **Well built?** One function, three surfaces pass its value through unchanged, and a contract test proves it per player. 19/19 mutants behave as designed, including one call-site mutant per surface and three week-selection mutants. No migration, no new table.
2. **Stats or made up?** The one producer is TM-09's held-out-tested revealed-price table. The two made-up ones (a 5% momentum cutoff, a z >= 1 curve) are retired. Today it says "no 2026 price" for every player, and that is true.
3. **How do we know?** Contract test `test/hype-one-producer.test.js` (RED `bd4e9bb6`, GREEN `2c12b915`). The same-player comparison above found 57/89 opposite calls between the old two. Liveness on the local copy: 83 readings, all the one producer's.
4. **Pointed elsewhere?** Before: PlayerCard's no-key verdict came from FantasyCalc momentum, `sellHigh` from its own curve, and the TM-09 route from trade prices. After: all three read `hype.js#playerHype`. The trade-card `'Sell High'` tag was an age rule and is now called `'Sell the Veteran'`.
5. **How does it unify?** One concept (price minus value), one producer, one sign, one units field, one default-off flag. The usage-gap "hype window" is named as a separate concept, with the follow-up above.

## Holdout looks

No 2025 row was read by this unit (TM-09's table has none; the comparison reads live 2026 inputs). Nothing appended to `docs/evidence/HOLDOUT-LEDGER.md`.
