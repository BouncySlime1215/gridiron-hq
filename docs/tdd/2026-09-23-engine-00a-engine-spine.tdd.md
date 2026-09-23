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

## 2. RED / GREEN

All runs: `GRIDIRON_DB_PATH=$(mktemp -u /tmp/gridiron-test-XXXXXX).sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap test/engine-spine.test.js`

| Step | Commit | Result |
|---|---|---|
| RED | b5e0461c `test: RED for the ONE ENGINE spine (event log, one-writer state, as-of reader, backfill, reader API)` | 10 tests, 0 pass, 10 fail. First failing assertion: `assert.ok(files.some(f => /^075_engine_spine\.js$/.test(f)), 'no migration 075_engine_spine.js')`; the rest fail on `need(...)`: `'events.js does not exist: the engine spine is not built'`. |
| GREEN | c611393f `feat: ONE ENGINE spine - engine_events log, one-writer engine_state, as-of reader, GET /api/engine/state, backfill adapters (migration 075)` | 10 / 10 pass |
| RED 2 (found by the real-data run, section 4) | 5027bd69 `test: RED - a pending ESPN transaction must not be stamped at its scheduled (future) processing time` | 9 pass, 1 fail: `assert.equal(pending.as_of, '2026-09-22T22:56:28.850Z', ...)` got `'2026-09-23T07:00:00.000Z'` |
| GREEN 2 | 95cb4e63 `fix: stamp pending ESPN transactions at proposal time in the engine backfill` | 10 / 10 pass |
| Test strengthened (mutant M14 survived) | 0d6b1508 `test: pin the chat-signal event's as_of and team to the source row (kills the stamp-at-now mutant)` | 10 / 10 pass on the fixed code; M14 now killed (section 5) |

The RED commit was amended once before GREEN: the append-only test first ran an
`UPDATE engine_state` against an empty table, which a row trigger never sees. The
amended RED (b5e0461c) was re-run against the unbuilt tree: 0 pass, 10 fail.

## 3. What it does

- **Migration `075_engine_spine`** (additive: 2 tables, 5 indexes, 4 triggers; nothing
  existing altered). `engine_events` (id, event_type, as_of, league_id, team_id,
  player_id, source, source_key, payload JSON, ingested_at; UNIQUE(source, source_key)).
  `engine_state` (entity_type, entity_id, league_id, field, value JSON, as_of, producer,
  producer_version, reason_chain JSON, event_ids JSON, written_at). Triggers refuse
  UPDATE and DELETE on both, so append-only is a database property.
- **Registry** `server/services/engine/registry.js`: event types and fields are open
  strings validated by registration. `registerField` (:49) throws when a second producer
  claims a field. `onEvent` (:79) is the hook for ENGINE-00b's learners; the spine
  registers no handler. The spine's own field: `engine.ingest`, producer `engine-backfill`.
- **Writers** (one file each, pinned by the grep test): `engine_events` <-
  `appendEvents` server/services/engine/events.js:71; `engine_state` <- `writeState`
  server/services/engine/state.js:49. `writeState` throws on a foreign producer, an
  unregistered field, a missing or malformed reason_chain, a contribution citing an event
  the row does not cite, an unknown event id, and an event stamped after the row's as_of.
  `appendEvents` refuses payload keys that could hold private text or credentials
  (text, body, message, msg, content, espn_s2, swid, cookie, password, token) at any depth.
- **As-of readers**: `getEvents` (events.js:101) refuses to run without asOf and returns
  only as_of <= asOf; `getState` (state.js:94) returns the latest row with as_of <= asOf.
- **Route** `GET /api/engine/state?entity=<type>:<id>&field=&as_of=&league_id=`
  (server/routes/engine.js:25, mounted server/index.js:159 behind legacyAuthenticated).
  GET only. A league-scoped read needs league membership (`assertLeagueMember`). Absence
  is named: `field_not_registered` or `no_row_as_of`.
- **Backfill** `server/services/engine/backfill.js` + `scripts/engine-backfill.mjs`
  (off-server; does not migrate, so it never triggers the pre-migration snapshot). One
  adapter per stream; deterministic source keys; a changed source row appends a new event.
  Chat: reads `manager_signals` rows with `source='chat'` (counts/rates per roster id),
  never the private chat DB, never names or text.

## 4. Numbers (local copy, not production)

Copy: `.local-db/data.sqlite` made by `sqlite3 ~/gridiron-local/data.sqlite ".backup ..."`
(2026-09-23 15:47). Migration 075 applied to the copy with `migrate()` (no snapshot).
Code tree: HEAD 95cb4e63, tree 765832d0.
Command: `GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite node scripts/engine-backfill.mjs` twice.

| Stream | Table | Source rows | Run 1 inserted | Run 2 inserted | No timestamp (skipped) |
|---|---|---|---|---|---|
| transactions | league_transactions_raw | 1615 | 1615 | 0 | 0 |
| lineups | league_roster_snapshots | 2310 | 2310 | 0 | 0 |
| news | news_items | 1559 | 1559 | 0 | 0 |
| game_lines | game_lines | 15096 | 15096 | 0 | 0 |
| injuries | nfl_injuries | 28438 | 22200 | 0 | 6238 |
| trade_outcomes | trade_outcomes | 2 | 2 | 0 | 0 |
| chat_signals | manager_signals (source=chat) | 140 | 140 | 0 | 0 |
| **total events** | | | **42922** | **42922** (unchanged) | |

Run 1 took 1759 ms, run 2 473 ms. Control for the 6238 skipped injuries:
`sqlite3 .local-db/data.sqlite "select count(*) from nfl_injuries where modified_at is null or modified_at=''"` = 6238.

Future-stamp check: `select count(*) from engine_events where as_of > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
= 0 after the fix. Before it (tree c611393f) the same query found 1 event and
`max(as_of)` for `espn.transaction` was `2026-09-25T07:00:00.000Z`: PENDING rows carry
ESPN's scheduled processing time (7 rows have processed_at > first_seen_at). That is the
defect RED 2 pins. The copy's engine tables were dropped and re-migrated (scratch copy
only) before the table above was produced.

Player id resolution (`select event_type, count(*), sum(player_id is not null) ... group by 1`):
transactions 874 / 1615 (multi-player and DST moves stay null, ids kept per item in the
payload), lineups 2310 / 2310, news 576 / 1559 (one resolved player only), injuries
8948 / 22200 (players table lacks most 2021-2024 gsis ids), lines and chat 0 by design
(team-level).

Reader on real rows: `getState('engine','events','engine.ingest',{})` returns producer
`engine-backfill` v1, per-stream counts equal to the table above, and 7 reason-chain
contributions (e.g. `{source:'league_transactions_raw', event_ids:[], delta:0, text:'0 new events this run from 1615 rows; 1615 in the log'}`).
The same read with `asOf: '2026-01-01T00:00:00Z'` returns null.

Holdout looks: none (no model, no 2025 read).

## 5. Mutation sweep

Script: scratchpad `mut.py` (mutates the LAST occurrence of each pattern, so a doc
comment cannot absorb the mutant; the first sweep hit a comment for M6 and reported a
false survivor, fixed). Tree 0d6b1508.

| Mutant | Result | Killed by |
|---|---|---|
| M1 registry: a second producer may claim a field | KILLED | test 3 |
| M2 writeState: skip the one-writer check | KILLED | test 3 |
| M3 writeState: allow citing a future event | KILLED | test 5 |
| M4 getState: drop the as_of cutoff | KILLED | tests 5, 10 |
| M5 getEvents: drop the as_of cutoff | KILLED | test 5 |
| M6 appendEvents: upsert instead of dedupe | KILLED | test 8 (trigger raises append-only) |
| M7 appendEvents: dispatch duplicates too | KILLED | test 8 |
| M8 lineup adapter copies actual points | KILLED | test 8 |
| M9 call site: route ignores as_of | KILLED | test 10 |
| M10 call site: route skips membership | KILLED | test 10 |
| M11 reason chain optional | KILLED | test 6 |
| M12 privacy guard off | KILLED | test 7 |
| M13 pending transaction uses processed_at | KILLED | test 8 |
| M14 call site: chat event stamped at copy time | KILLED (survived before 0d6b1508) | test 8 |
| Designed survivor: CHUNK 2000 -> 1 | SURVIVED (behaviour-equivalent, as designed) | none |
| Not-applied control: pattern absent | not applied, 10/10 pass | none |

## 6. Known defects / follow-ups

- **Bitemporal gap.** Backfilled events carry the source's as_of (when the fact
  happened) but were ingested 2026-09-23. A replay that must see only what was on disk
  at time T needs `ingested_at <= T` too; `getEvents` does not filter on it yet. Same for
  state rows (`written_at`). Follow-up for the first walk-forward consumer.
- **Upserted source tables lose history before the log existed.** `league_roster_snapshots`,
  `game_lines` and `manager_signals` overwrite in place, so the backfill sees only each
  row's latest version. From now on, re-running the backfill (or ENGINE-00b) appends each
  change. `game_lines` rows are stamped at `fetched_at`, so historical lines captured in
  2026 are as-of 2026, not their game week (honest, but useless for past-season replay).
- Injuries: 6238 of 28438 rows have no `modified_at` and are skipped (counted, not guessed);
  60% of injury events have no players.id (historical gsis ids missing from `players`).
- `getEvents` has no HTTP route; engine_events reaches the route only through the
  `engine.ingest` counts. The unit spec names only /api/engine/state.
- Node 22 (CI) has no `DatabaseSync.isTransaction`; `appendEvents` then always opens its
  own transaction, so it must not be called inside a caller's open transaction on Node 22.
- ENGINE-00b (the daemon that runs the backfill every 5-15 min and calls learners) is
  not built here, by design.

## 7. Nick's five questions

1. **Well built?** Yes for the contract: 10 targeted tests, 14 of 14 real mutants killed,
   append-only enforced by database triggers, one writer enforced at runtime and by grep.
2. **Stats or made up?** Neither: no number is modelled. The only state value is a count
   of rows in the log.
3. **How we know:** tests on a fixture DB plus a real run on the local copy (42922 events,
   second run adds 0). No backtest applies.
4. **Pointed anywhere else?** `GET /api/engine/state` (server/routes/engine.js:25,
   server/index.js:159). No page or Coach call reads it yet; the first stage (PROJ-01 /
   COACH-*) is the first consumer.
5. **How it unifies:** every later stage appends to `engine_events` with a registered type
   and writes only its own registered fields to `engine_state`, with a reason chain and
   the event ids behind it. Jev calls and grades fit the same shape (new event types, new
   fields with producer `jev-*`).

Defect/gap fixed: no unified event log or state store existed (`grep -rn engine_events server` empty on b0862ffc).
Incumbent: none, by that grep. Not covered: the daemon, any model, any page reading the route.
What would make it wrong: a stage that writes engine tables with raw SQL outside the two
writer files (the grep test catches this in server/ and scripts/ only, not client or tests).
