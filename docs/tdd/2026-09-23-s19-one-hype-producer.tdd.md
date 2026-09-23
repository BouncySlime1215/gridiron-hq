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

## Holdout looks

No 2025 row was read by this unit (TM-09's table has none; the comparison reads live 2026 inputs). Nothing appended to `docs/evidence/HOLDOUT-LEDGER.md`.
