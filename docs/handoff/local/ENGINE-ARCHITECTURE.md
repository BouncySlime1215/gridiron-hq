# ENGINE-ARCHITECTURE: how the ONE ENGINE's layers connect (definitive, 2026-09-23)

Cites are `file:line` on **origin/main `238d31bc`** unless a PR head is named: **#216 = `9e8fc9d0`** (the spine), **#220 = `e9299209`** (LIVING-01a). Numbers come from the local DB copy (`sqlite3 -readonly`), never production. "guess" marks a guess; section 13 lists everything unconfirmed. Web sources are in section 14.

This document decides the contracts. ENGINE-SPECS.md rows that it replaces or amends are named in section 12. Nothing here builds a model; it is the plumbing every model plugs into.

---

## 0. The one page (plain English, precise)

**Seven layers, one loop.** Data (ESPN, Sleeper, Vegas, news, injuries, your texts as counts) → Collect (one event log) → Understand (players, managers, teams as numbers) → Simulate (one simulator, one set of dice) → Decide (trade search, waivers, start/sit, Jev) → Answer (pages and Coach) → Learn (grade everything against what happened, refit, fall back when a model is losing) → back to Understand.

**Every arrow is data landing in one shared place and the next layer reading it from there.** No layer calls another. The shared place is two tables: `engine_events` (what happened, append-only, stamped when it happened *and* when we learned it) and `engine_state` (what we currently believe, one row per number, one owner per number, with the reason chain that made it).

**What "insane" adds to the coordinator's explanation, in seven rules:**

1. **Two clocks on everything.** Every event and every number carries `as_of` (when it was true in the world) *and* `known_by` (when this machine knew it). So the engine can answer "what did we believe on Sunday 1 PM about week 5" exactly, and a backtest can never peek at Friday's injury report on Wednesday.
2. **One snapshot per answer.** Every page load and every Coach answer reads from one snapshot: one `as_of`, one `known_by`, one version of every model, one seed for the dice. Two pages showing different numbers for the same thing becomes impossible by construction, not by discipline.
3. **One set of dice.** The simulator's random draws are *addressed*, not stored: player X, week W, run R under snapshot world S always gets the same football, whoever is asking. The title odds, the trade's impact, the range bar on the Start/Sit page and the trade card's floor/ceiling are all the same draws.
4. **Numbers are distributions.** What moves between layers is a range (quantiles) or a state (engaged/drifting/checked-out with probabilities), never a lone point. The point is the median of the range.
5. **Producers are registered, versioned and graded.** Every number has exactly one producer (enforced at runtime, by object identity, as #216 built it). Every producer version is registered with the code and parameters that made it, runs in a lane (`live`, `shadow`, or `baseline`), and is graded against outcomes on the same schedule. Promotion is a script that refuses unless the grade clears the pre-registered bar. Rollback is a pointer flip. Fallback is automatic when a live producer is losing to its baseline.
6. **Reasons add up.** A reason chain is `baseline + Σ contributions + residual = value`. A blender that merges two producers carries the upstream chains, scaled by its weights, so "P(accept) fell 0.18: declined your 2-for-1 (−0.11), his RB2 returned (−0.07)" is arithmetic, not prose.
7. **The web server never computes.** Only the engine daemon writes engine tables and runs producers. Pages and Coach read; a hand-built trade the engine has not priced is a request the daemon answers in under a second, not a simulation on the request thread.

**Honest status.** #216 builds the log, the state table, the one-writer registry and the as-of reader; it is right in shape and needs seven cheap schema/contract changes *before* merge (section 11). #220 is the first producer and is right in method; it must read only events and write to the shadow lane (section 11). Today every live feature still computes on the request thread from raw tables, and the numbers that disagree across pages are listed with their causes in section 10.

```
   ┌──────────────── 1 DATA ────────────────┐
   │ ESPN leagues · Sleeper · lines · news  │  refresh.sh (every 15 min), unchanged:
   │ injuries · chat COUNTS · nflverse      │  writes the source tables it always wrote
   └───────────────────┬────────────────────┘
                       │ 1→2  engine daemon tick (≤10 min, event-driven inside the tick)
                       ▼      adapters read source tables from a watermark, append events
   ┌──────────────── 2 COLLECT ─────────────┐
   │ engine_events  (append-only)           │  as_of + ingested_at + provenance
   │ engine_event_entities (who it is about)│  content-hash keys: unchanged re-capture = no event
   └───────────────────┬────────────────────┘
                       │ 2→3  dirty-set recompute: a producer reruns only for the entities its
                       ▼      declared inputs touched; topological order; per-producer time budget
   ┌──────────────── 3 UNDERSTAND ──────────┐
   │ proj.* (players)  activity.* clone.*   │  engine_state rows: value (often a distribution),
   │ tells.* avail.* league.week price.*    │  as_of, known_by, producer@version, lane, reason_chain
   └───────────────────┬────────────────────┘
                       │ 3→4  the world: pools per player-week from proj.* + avail.*, dice seed = snapshot
                       ▼
   ┌──────────────── 4 SIMULATE ────────────┐
   │ sim.world  range.week  title.odds      │  one simulator; addressed draws (world, player, week, run)
   │ action_price (RL-19-2 rescore)         │  LIVING-01b: clones act inside the same world
   └───────────────────┬────────────────────┘
                       │ 4→5  reads title.odds, range.week, clone.p_accept, tells.card from state
                       ▼
   ┌──────────────── 5 DECIDE ──────────────┐
   │ search.trades  search.paths  waiver.*  │  every candidate scored on the same dice; Jev answers
   │ lineup.call  jev.<question>  blend.*   │  are producer fields in lane shadow until they earn weight
   └───────────────────┬────────────────────┘
                       │ 5→6  GET /api/engine/snapshot + /view: one snapshot id, one version set
                       ▼
   ┌──────────────── 6 ANSWER ──────────────┐
   │ pages · Coach · status strip           │  typed absence (ok/zero/unknown/stale/fallback/thin);
   │ (read-only; never recompute)           │  every number shows producer@version + reason chain
   └───────────────────┬────────────────────┘
                       │ 6→7  what Nick did (follow/ignore) and what happened land as events
                       ▼
   ┌──────────────── 7 LEARN ───────────────┐
   │ outcome.* events → grade.* fields      │  proper scores per producer×version×window; monitor
   │ nightly refit · weekly autopsy · HYPO  │  flips fallback; promote/rollback scripts; ledgers
   └───────────────────┬────────────────────┘
                       │ 7→3  new producer versions (shadow → active), refits, dead tells, new features
                       └──────────────────────────────────────────────────────────────▶ (back to 3)
```

---

## 1. The design decisions (the ones that matter)

| # | Decision | Why (one line) |
|---|---|---|
| D1 | **Bitemporal by default:** events carry `as_of` + `ingested_at` + `provenance`; state rows carry `as_of` + `known_by`; readers take both cutoffs and replay mode makes both mandatory | #216 has the columns but filters only `as_of` (`state.js:98`, `events.js:101`); the betting side already learned this the hard way (`nfl-bitemporal.js:1-30`: three clocks, `captured` vs `reconstructed`) |
| D2 | **Snapshots are the unit of consistency:** `engine_snapshots` = (as_of, known_by, version set, world seed); every page/Coach read names one | Today four caches with four keys serve title odds (`routes/model.js:120-124` process-lifetime memo, `title-odds-trades.js:47` fetched_at key, `season-sim.js:505` seed from fetched_at, `trade-engine.js:300` fingerprint cache), so surfaces disagree by construction |
| D3 | **Addressed randomness (common random numbers everywhere):** one `world` per snapshot; every draw is `keyedNormal(keyedSeed(world, kind, player, week), run)`; nothing draws from a global stream | Already the design of RL-6-3 inside season-sim (`season-sim.js:338-384`), but `world` is drawn fresh per call (`:338`) and three other samplers roll their own dice (`trade-engine.js:447`, `ceiling-lineup.js:109/:215`, `lineup-posture.js:153`) |
| D4 | **Distributions are the exchange type:** a `dist` value envelope (fixed quantile grid + mean + p_zero + n) for every range-bearing field; the served point is the median | Layers today pass points (`current_week_ppg`, `ros_ppg`) and re-derive ranges independently |
| D5 | **Producer registry + lanes:** `engine_producers` (producer, version, code_sha, params_hash, fit_ref, status); `engine_state.lane ∈ {live, shadow, baseline}`; the reader serves `live` from active versions, or `baseline` under fallback | Makes RULES §2-3 (ratchet, flags, ship-on-benchmark) mechanical; reuses the *rules* of `server/modeling/registry.js:12-27` (rollback must pass the same gates as promotion) without its unused experiment machinery (0 rows in `model_experiments` locally) |
| D6 | **Dependency-driven recompute (Salsa-style):** producers declare inputs (event types, upstream fields) and scope (entity/league/global); the daemon computes the dirty set per tick and reruns in topological order; write-on-change | Replaces "recompute everything on request" and the per-table fingerprint cache (`compute-cache.js`, `trade-engine.js:208-244`) with the same idea at the right grain |
| D7 | **Additive reason chains:** `baseline + Σ delta + residual = value`, validated on write; blenders scale upstream chains by weight | "AND REASONS" needs attribution that adds up; #216's `{source,event_ids,delta,text}` (`state.js:21-43`) is the right seed and gains `baseline`, `residual`, `state_ids`, `kind` |
| D8 | **The daemon is the only writer of engine tables; the web is read-only; the refresh job is unchanged** | The in-process scheduler stalled the server (`local-scheduler-stall-2026-09-22.txt`); node:sqlite is synchronous (`scheduler.js:2181-2186`); WAL allows one writer at a time |
| D9 | **Outcomes are events, grades are fields, monitors are producers** | The Learn loop uses the same spine as everything else; no grading side store (rec_ledger #174 and trade_outcomes become event *sources*, not competitors) |
| D10 | **Jev is a producer in the shadow lane until graded weight is earned; every call is an event with cost; blends are separate producers** | r17: a frozen persona lost to a waiver count (AUC 0.47 vs 0.78); the data decides the weight per question type |
| D11 | **Identity keys are fixed by grammar and enforced on write** | `entity_id` is a free string in #216 (`state.js:64-66`); two current-week producers already disagree (`trade-engine.js:180` vs `league-week.js:12`) |
| D12 | **Holdout discipline is mechanical:** producers refuse to write 2025 entities without a ledger row id; replay snapshots record `reconstructed` share | `docs/evidence/HOLDOUT-LEDGER.md` rule 2 is a contract today, not a check |
| D13 | **No page recomputes, enforced by a ratcheting import test plus a runtime role guard** | RULES §2: automated checks beat reading |
| D14 | **Additive migrations only; retention is by write-on-change and content-hash keys, never deletion** | Public repo rule; triggers already refuse UPDATE/DELETE (`075_engine_spine.js:62-69`) |

---

## 2. The spine, precisely (schema v2 = #216 + the changes in 11.2)

All tables live in `data.sqlite` (WAL, `busy_timeout` 15 s, `db/index.js:24-26`). All are append-only with the #216 triggers, except `engine_state_latest`, `engine_cursors`, `engine_producers.status` and `engine_requests`, which are small mutable bookkeeping tables (they hold pointers, never numbers).

### 2.1 `engine_events` (the log; #216 `075_engine_spine.js:26-36`, plus three columns)

| column | type | meaning |
|---|---|---|
| id | INTEGER PK | monotone; the log's own clock |
| event_type | TEXT | registered name (`registry.js:35`), `family.name` |
| as_of | TEXT ISO ms | **valid time**: when the fact was true or first knowable (`backfill.js:10-22` per source) |
| ingested_at | TEXT ISO ms | **transaction time**: when this log received it (`events.js:73`) |
| **provenance** | TEXT | `captured` (received while current), `reconstructed` (backfilled from an archive: everything the 2026-09-23 backfill wrote), `derived` (computed here). Same closed set as `nfl-bitemporal.js:38-42` |
| league_id, team_id, player_id | | primary scope (kept from #216); **multi-entity events use 2.2** |
| source, source_key | TEXT | UNIQUE; idempotency. **Rule:** for slowly-changing sources (lines, injuries, lineups, signals) `source_key` = natural key + **sha256 of the payload**, so an unchanged re-capture appends nothing (#216 keys lines on `fetched_at`, `backfill.js:113`, which would append ~544 identical events per hourly `nfl_lines` run: guess 13k/day) |
| payload | TEXT JSON | facts only; forbidden keys refused (`events.js:16`) |
| **schema_version** | INTEGER | payload schema per event_type (starts at 1) |

Indexes: (event_type, as_of), (player_id, as_of), (league_id, team_id, as_of) as built; add (ingested_at) for knowledge-time replay.

### 2.2 `engine_event_entities` (who an event is about) — new, additive

`(event_id, entity_type, entity_id, role)` with PK (entity_type, entity_id, event_id). Filled by `appendEvents` from `event.entities[]`. A trade proposal is about two league_teams and N players; today `getEvents({playerId})` misses every multi-player transaction because `player_id` is null when items.length ≠ 1 (`backfill.js:66-67`). Roles: `subject`, `from`, `to`, `counterparty`, `league`.

### 2.3 `engine_state` (the box; #216 `075_engine_spine.js:43-58`, plus three columns and a new key)

| column | meaning |
|---|---|
| entity_type, entity_id, league_id | identity per 2.11; **write rule:** a league-scoped entity's `league_id` must equal the id prefix |
| field | registered, one producer (`registry.js:55-72`) |
| value | JSON per the field's declared `valueType` (2.9) |
| as_of | valid-time cutoff the producer computed *about* |
| **known_by** | transaction-time cutoff: the max `ingested_at` of events and `written_at` of state rows it read. **Part of the unique key.** Same (as_of, known_by, version) twice = no-op (idempotent); a late-arriving event = new known_by = new row |
| producer, producer_version | as built; version resolves to `engine_producers` |
| **lane** | `live` \| `shadow` \| `baseline`; part of the unique key |
| reason_chain | v2 (2.10) |
| event_ids | as built (`state.js:72-82` validates no future leak) |
| **input_state_ids** | state row ids read (lineage across producers; validated `as_of ≤ row.as_of` and `written_at ≤ known_by`) |
| **run_id** | `engine_runs.id` that wrote it |
| written_at | as built |

Unique key: (entity_type, entity_id, field, COALESCE(league_id,−1), lane, as_of, known_by, producer_version). Read index: (entity_type, entity_id, field, league_id, lane, as_of DESC, known_by DESC).

### 2.4 `engine_state_latest` (O(1) reads) — new, additive, mutable pointer table

`(entity_type, entity_id, field, league_id, lane) → state_id, as_of, known_by, producer_version`, maintained by `writeState` in the same transaction. Pages read this; history reads go to `engine_state`. Rebuildable from `engine_state` (a `scripts/engine-rebuild-latest.mjs` proves it).

### 2.5 `engine_producers` (the model registry) — new, additive

| column | meaning |
|---|---|
| producer, version | e.g. `activity`, `living01a-1` |
| code_sha | git sha of the producer file(s) at registration |
| params_hash | sha256 of the fitted constants / weights (e.g. `FITTED_PARAMS`, `activity-model.js:240`) |
| fit_ref | pointer into an existing fit store when one exists (`weekly_ensemble_fits.id`, `fantasy_coordinator_fits.id`, a `docs/evidence/<date>/` path); never a copy |
| fields | JSON list of fields this version writes |
| inputs | JSON: `{events:[types], fields:[upstream fields], scope:'entity'|'league'|'global', schedule:'event'|'tick'|'nightly'|'weekly', budget_ms}` |
| baseline_of | for a live field, the (producer, version) that serves under fallback |
| status | `shadow` → `candidate` → `active` → `fallback` \| `retired`; one `active` per (producer) at a time |
| registered_at, activated_at, retired_at, reason | audit |
| prereg_ref | path of the pre-registration doc naming the metric, MDE and n floor the promotion script checks |

### 2.6 `engine_runs`, `engine_cursors` — new, additive

`engine_runs` (id, tick_id, producer, version, lane, scope_key, started_at, finished_at, ms, rows_written, rows_unchanged, error, dirty_reason). Append-only; the heartbeat and `/api/engine/status` read it.
`engine_cursors` (producer, version, source, watermark) — mutable; per producer the last event id consumed and per upstream field the last state id seen; per adapter the source watermark. Idempotency: rerunning a tick over the same rows changes nothing (`ENGINE-00b-a` RED 2).

### 2.7 `engine_snapshots` — new, additive

| column | meaning |
|---|---|
| id | monotone |
| as_of, known_by | the two cutoffs every row in this snapshot satisfies |
| version_set | JSON `{producer: version}` for every active producer at the time |
| world | uint32 dice seed for 3→4/4→5 (`keyedSeed(snapshot.id, 'world')`) |
| reconstructed_share | fraction of events read with provenance `reconstructed` (0 live; >0 in replay) |
| league_id | null = global snapshot; per-league snapshots are allowed for replay |
| tick_id, created_at | audit |

One snapshot per tick after all producers finish. `GET /api/engine/snapshot?league_id=` returns the latest; every view read passes `snapshot_id`.

### 2.8 `engine_requests` (the only engine table the web process may INSERT into) — new, additive

(id, kind, params_json, snapshot_id, requested_by, requested_at, started_at, done_at, result_state_id, error). Kinds: `rescore` (a hand-built deal → `action_price` row via RL-19-2), `evaluate`, `offer`, `sequences` for a specific target. The daemon polls it every 250 ms between producer runs (9.2). The page shows "pricing…" and polls the result state row; it never simulates.

### 2.9 Value envelope (declared per field in `registerField`)

```
valueType 'number' : 12.4
valueType 'prob'   : 0.31
valueType 'dist'   : { q: [0.05,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.95], v: [..11 numbers..],
                       mean, sd, p_zero, n, world, unit: 'pts'|'pp'|'prob' }
valueType 'state'  : { state: 'engaged', probs: {engaged:0.7, drifting:0.25, checked_out:0.05} }
valueType 'object' : any JSON (search results, cards), with `n` where a sample size exists
absence (any type) : value null + status in {'unknown','not_measured','zero'} + reason (never a default)
```
The grid is fixed so quantiles compose across producers without interpolation and so CRPS is computable from stored rows. `p_zero` carries DNP mass (`sampleWeeks`' `random() > activeProbability` branch, `projections.js:989`).

### 2.10 Reason chain v2

```
{ v: 2, additive: true|false,
  baseline: { value, source, text },                      // the incumbent or prior this number starts from
  contributions: [ { source, kind: 'event'|'state'|'model'|'prior'|'monitor'|'blend',
                     event_ids: [], state_ids: [], delta, weight, text } ],
  residual: number|null,                                  // value − baseline − Σ delta (0 when exact)
  n: number|null }
```
`writeState` validates (as #216 does for citations, `state.js:21-43`): every cited id is in the row's ids; when `additive`, |baseline.value + Σdelta + residual − value| ≤ 1e−6 (for `dist`, on the mean); contributions of `kind:'state'` cite `state_ids`. **Composition through a blender:** value = Σ wᵢ·xᵢ; baseline = the declared incumbent x₀; contribution i = wᵢ·(xᵢ − x₀) with `state_ids:[row_i]`; the page can expand row_i's own chain scaled by wᵢ. Monitor fallbacks add a `kind:'monitor'` contribution with delta = baseline − live and the n behind it.

### 2.11 Identity keys (grammar, enforced by `writeState` and `appendEvents`)

| entity_type | entity_id | source of truth |
|---|---|---|
| player | `players.id` (internal int) | `player-identity.js`; ESPN/gsis/sleeper ids resolve at the adapter, never in a field key |
| player_week | `<player_id>:<season>:<week>` | |
| nfl_team | abbr (`team-codes.js`) | |
| game | `<season>:<week>:<home_abbr>` | `game_lines` convention; cutoff = `game-cutoff.js` |
| week | `<season>:<week>` | NFL week; the field `nfl.week` (one producer) replaces `tradeWeekContext` (`trade-engine.js:180-184`) |
| league | `leagues.id` (internal) | |
| league_week | `<league_id>:<season>:<week>` | the field `league.week` (one producer) replaces `leagueCurrentWeek` (`league-week.js:12`) as the *served* value |
| league_team | `<league_id>:<roster_id>` | #220 already uses this (`activity-model.js:436`) |
| league_team_week | `<league_id>:<roster_id>:<season>:<week>` | |
| matchup | `<league_id>:<season>:<week>:<a>:<b>` (a<b) | |
| offer | `trade_outcomes.id` | |
| rec | `rec_ledger.id` (#174) | |
| hypothesis | sha256 of the spec (HYPO-01a) | |
| producer | `<producer>@<version>` | grades and monitors key on this |
| engine | `events`, `daemon`, `jev` | spine-level fields |

Managers are `league_team` in the public repo. Cross-league person identity (`manager-identity.js`) stays local-only and never becomes a key.

### 2.12 The reader API (web, read-only)

| route | returns |
|---|---|
| `GET /api/engine/state?entity=&field=&as_of=&known_by=&lane=&league_id=` | one row (as #216, `routes/engine.js:25`), plus `status` ∈ ok/zero/unknown/stale/fallback/thin with reason |
| `GET /api/engine/snapshot?league_id=` | latest snapshot (id, as_of, known_by, version_set, world, age) |
| `GET /api/engine/view?view=<name>&league_id=&snapshot_id=` | a declared **view**: a fixed list of (entity, field) rows resolved at one snapshot in one query (e.g. `my_team`, `start_sit`, `trade_lab`, `clone:<team>`); every row carries producer@version, as_of, known_by, status, reason_chain |
| `GET /api/engine/status` | daemon heartbeat, lock holder, per-source watermark and lag, per-producer status/lane/grade, Jev spend and balance (ENGINE-00b-b (4)) |
| `POST /api/engine/request` | inserts an `engine_requests` row; returns its id; the page polls `/state` for the result |

Views are declared in `server/services/engine/views.js` as data (name → rows), not code, so the "no arithmetic on engine values" grep has one file to check.

<!-- CONTINUE-A -->
