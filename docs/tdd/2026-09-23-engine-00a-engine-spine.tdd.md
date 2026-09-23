# ENGINE-00a: the ONE ENGINE spine (event log, state store, as-of reader, backfill)

Unit ENGINE-00a (WORK-QUEUE section 3; brief: TRADE-INSANE-RND.md "ONE ENGINE" / "ENGINE-00").
Not statistical: it builds no model and produces no model number, so there is no
pre-registration and no holdout look (nothing in the 2025 season was read).

## 1. Audit: extend or build

Tree: origin/main b0862ffc.

| Question | Command | Result |
|---|---|---|
| Does an event log or state store exist? | `grep -rn "engine_events\|engine_state\|/api/engine" server client/src test docs` | 0 hits. `server/services/engine/` does not exist. |
| Highest migration number | `ls server/migrations` | `073_dynasty_value_history.js`; 074 is held by PROJ-00, so this unit takes **075**. |
| Existing streams to backfill (local copy, not production) | `sqlite3 -readonly .local-db/data.sqlite "select count(*) from <t>"` | `league_transactions_raw` 1615, `league_roster_snapshots` 2310, `news_items` 1559, `game_lines` 15096, `nfl_injuries` 28438, `trade_outcomes` 2, `manager_signals` (source `chat`) 140 |
| Where the Coach chat variables already live as numbers | `server/services/manager-signals.js:151` `chatSignals` reads `manager_chat_profile` (keyed by a person's NAME, private chat DB) and `buildManagerSignals` (:478) writes them into `manager_signals` keyed by `roster_id`, `source='chat'` | The adapter reads `manager_signals` (counts/rates, roster ids, no names, no text) and never opens the chat DB. |
| Writers of the source tables | `league_transactions_raw`: `scripts/collect-league-transactions.mjs`; `manager_signals`: `buildManagerSignals` server/services/manager-signals.js:478 | read-only here |

Decision: **build**. Nothing to extend: no table, service or route for a unified event
log or state store exists. The streams stay where they are and keep their writers; the
spine only copies them (as events) into one append-only log.

One number, one producer: the spine adds no number for any concept that already has a
producer. The only state field it registers is `engine.ingest` (per stream: events in
the log and the watermark), a count about the log itself, which nothing else produces.
