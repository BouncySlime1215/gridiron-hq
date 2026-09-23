# ENGINE-ARCHITECTURE: how the ONE ENGINE's layers connect (v2 after adversarial review, 2026-09-23 22:45Z)

Cites are `file:line` on **origin/main `29ac6bcf`** (= `f403f734` plus #215's study-only files; no cited file changed between them) unless a PR head is named: **#216 = `9e8fc9d0`** (the spine), **#220 = `e9299209`** (LIVING-01a). Numbers come from the local DB copy (`sqlite3 -readonly`), never production. "guess" marks a guess; section 13 lists everything unconfirmed. Web sources are in section 14. **Section 15 is the review log**: every finding of the two adversarial reviews (systems, ML) with accept/reject and where the design changed.

This document decides the contracts. ENGINE-SPECS.md rows that it replaces or amends are named in section 12. Nothing here builds a model; it is the plumbing every model plugs into.

**What v2 changed, in one paragraph.** The reviews found the v1 contracts sound in shape and wrong in six places: a seed per snapshot that would re-roll every number 144 times a day; a `known_by` column with two definitions; a latest-pointer table that could serve half a tick; a field registry that lived only in one process's memory; a decide stage with a cycle (`sim` ↔ `search`) so Jev could never move a ranking; and event-driven recompute that never revisited a silent manager. v2 fixes each with something simpler: the dice seed is fixed per NFL week; transaction time is the row id; a snapshot is a cut in the id sequence (no pointer table); the registry is a table with a trigger; the decide stage is four ordered fields; cheap producers recompute everything every tick and heavy ones use one dirty bit per league. Promotion is a pull request, not a runtime state machine. Health checks (HEALTH-01a) and source coverage (so a collector gap is "unknown", never "0 adds") are folded into the spine.

---

## 0. The one page (plain English, precise)

**Seven layers, one loop.** Data (ESPN, Sleeper, Vegas, news, injuries, your texts as counts) → Collect (one event log) → Understand (players, managers, teams as numbers) → Simulate (one simulator, one set of dice per week) → Decide (trade search, waivers, start/sit, Jev) → Answer (pages and Coach) → Learn (grade everything against what happened, refit, fall back when a model is losing) → back to Understand.

**Every arrow is data landing in one shared place and the next layer reading it from there.** No layer calls another. The shared place is two tables: `engine_events` (what happened, append-only, stamped when it happened *and* when we learned it) and `engine_state` (what we currently believe, one row per number, one owner per number, with the reason chain and the health checks that made it). The layers are labels for people; the machine sees one dependency graph of fields (`clone.motive` in Understand reads `title.odds` from Simulate, and that is fine as long as there is no cycle).

**What "insane" adds to the coordinator's explanation, in nine rules:**

1. **Two clocks, one of them free.** Every event carries `as_of` (when it was true in the world, with a quality tag saying how exact that stamp is) and `ingested_at` (when this machine received it). Every state row's transaction time is its own row id (`written_at` for humans): rows are only ever appended, so "what did we believe at 1 PM Sunday" is exactly "the rows with id ≤ the id we were at then". No second clock column, no replay-mode switch. Backtests that need the past run on database copies and are labelled `history`, never `forward`.
2. **One snapshot per answer.** A snapshot is a cut: (max event id, max state id, the version of every model, the fallbacks in force, the dice seed). Every page load and every Coach answer reads one snapshot. A league's snapshot is published only when every producer for that league finished the tick, so the Title tab and the trade finder cannot disagree with each other or with the injury report they were built on. Two pages on two snapshots say so.
3. **One set of dice per week.** The simulator's seed is `keyedSeed('world', season, nfl_week)`: fixed within an NFL week, fresh each week. Player X, week W, run R gets the same football in every league, every trade candidate and every page. A number moves only when an input moves, never because the dice were re-rolled. The best trade is chosen on the week's dice and *re-priced on an independent set* before it is shown, so the search cannot flatter itself.
4. **What moves between layers is a model or a distribution, never a lone point.** Understand hands Simulate the generative parameters of each player (conditional on playing) plus his chance to play, so the simulator can apply game script, correlation and persistence. Simulate hands Decide draws summarised on a fixed quantile grid. The served point is the **mean** (the right number for expected-points decisions); the median is a tick on the range bar.
5. **Producers are registered, versioned and graded; promotion is a pull request.** Every number has exactly one producer, enforced three ways (a database trigger, a runtime capability, a grep). Every producer version is a code constant with its parameters' hash, its training window and its registration time. Challengers write to the `shadow` lane and are graded on the same outcomes as the incumbent; a promotion is a PR that bumps the active version and carries the grade report, and CI refuses it if the pre-registered bar is not met. Rollback is a revert. Fallback (serving a field's declared `fallback_field` when the live producer is losing) is the one runtime switch, and the daemon's monitor is its only writer.
6. **Reasons add up, in the right space.** A reason chain is `baseline + Σ contributions + residual = value`, validated on write, in the space the number lives in (points for points, log-odds for probabilities). A blender carries its inputs' chains scaled by weight, so "P(accept) fell 0.18: declined your 2-for-1 (−0.11), his RB2 returned (−0.07)" is arithmetic, not prose. For the simulator the contributions are leave-one-out rescores on the same dice.
7. **Coverage, not zeros.** Every collector's successful runs are events too, so a week the collector missed reads `unknown`, never "0 adds"; a manager who did nothing still gets recomputed every tick, so "drifting: 0 adds in 2 weeks" is a statement about him, not about the collector.
8. **Health on every row.** `writeState` runs the field's declared invariant checks (probabilities in [0, 1], title odds summing to the playoff spots, ordered quantiles, no NaN). A failed row is kept for the audit but never served: the reader serves the last good row or the fallback field, labelled. A row built on degraded inputs is degraded automatically.
9. **The web server never computes.** Only the engine daemon writes engine tables and runs producers; writes are refused unless the process says it is the engine. Pages and Coach read; a hand-built trade the engine has not priced is a request the daemon answers from the current world, not a simulation on the request thread.

**Honest status.** #216 builds the log, the state table, the one-writer registry and the as-of reader; it is right in shape and needs fourteen schema/contract changes *before* merge (section 11.2, all in one rewritten migration). #220 is the first producer and is right in method; it must read only events, carry coverage and as-of dead starts, and write to the shadow lane (section 11.5). Today every live feature still computes on the request thread from raw tables, and the numbers that disagree across pages are listed with their causes in section 10.2.

```
   ┌──────────────── 1 DATA ────────────────┐
   │ ESPN leagues · Sleeper · lines · news  │  refresh.sh (every 15 min): writes the source tables
   │ injuries · chat COUNTS · nflverse      │  it always wrote; gains a lock and a sync_log row per capture
   └───────────────────┬────────────────────┘
                       │ 1→2  engine daemon tick (≤10 min; wakes ≤60 s after a sync): adapters read
                       ▼      source tables from a cursor, append events + source.coverage events
   ┌──────────────── 2 COLLECT ─────────────┐
   │ engine_events  (append-only)           │  as_of (+quality) · ingested_at · provenance · natural_key
   │ engine_event_entities (who + aliases)  │  compare-latest dedupe: unchanged re-capture = no event
   └───────────────────┬────────────────────┘
                       │ 2→3  every tick: cheap producers recompute every entity; write-on-change
                       ▼
   ┌──────────────── 3 UNDERSTAND ──────────┐
   │ proj.* (model params)  activity.*      │  engine_state rows: value, as_of, producer@version, lane,
   │ avail.* clone.* tells.* league.* espn.*│  reason_chain, health, run_id (→ the run's input cut)
   └───────────────────┬────────────────────┘
                       │ 3→4  world per league: pools from proj.* × game.script, p_play applied once;
                       ▼      seed = keyedSeed('world', season, nfl_week); rebuilt when a league's inputs moved
   ┌──────────────── 4 SIMULATE ────────────┐
   │ sim.world  range.week  title.odds      │  one simulator; addressed draws (world, player, week, run)
   │ action_price (search + eval seeds)     │  LIVING-01b: clones act inside the same world
   └───────────────────┬────────────────────┘
                       │ 4→5  four ordered fields: candidates → prices + Jev → blend → ranking
                       ▼
   ┌──────────────── 5 DECIDE ──────────────┐
   │ search.candidates → action_price/jev.* │  every candidate priced on the same dice; Jev answers are
   │ → blend.p_accept → search.trades       │  shadow rows until a question type earns weight
   └───────────────────┬────────────────────┘
                       │ 5→6  GET /api/engine/snapshot + /view: one cut, one version set, one fallback set
                       ▼
   ┌──────────────── 6 ANSWER ──────────────┐
   │ pages · Coach · status strip           │  typed status (ok/zero/unknown/stale/fallback/thin/degraded);
   │ (read-only; never recompute)           │  every number shows producer@version, health, reason chain
   └───────────────────┬────────────────────┘
                       │ 6→7  what Nick did (follow/ignore) and what happened land as events
                       ▼
   ┌──────────────── 7 LEARN ───────────────┐
   │ outcome.* events → grade.* fields      │  graded at each field's pre-registered decision time;
   │ decision vs luck · monitor · refits    │  one anytime-valid test per field; promotion = a PR
   └───────────────────┬────────────────────┘
                       │ 7→3  new versions (shadow → active by PR), fallbacks (daemon), dead tells
                       └──────────────────────────────────────────────────────────────▶ (back to 3)
```

---

## 1. The design decisions (the ones that matter)

| # | Decision | Why (one line) |
|---|---|---|
| D1 | **Valid time is a column, transaction time is the row id.** Events: `as_of` + `as_of_quality` + `ingested_at` + `provenance`. State: `as_of` + `id`/`written_at`. No `known_by` column, no replay mode; replays run on copies | v1's `known_by` had two definitions (§2.3 vs §3.2) and would have let replays insert into the live table; ids are exact and free (ML S1, systems S3) |
| D2 | **A snapshot is a cut** `(max_event_id, max_state_id, version_set, fallback_set, world)` published per league when its DAG finishes; views resolve rows with `id ≤ max_state_id`. No latest-pointer table | A pointer table updated row by row mid-tick reproduces the Title-tab-vs-finder disagreement (systems B2, ML I3); an indexed seek per row is ≤ 1 ms |
| D3 | **Addressed randomness with a weekly seed:** `world = keyedSeed('world', season, nfl_week)`; every draw is `keyedNormal(keyedSeed(world, kind, player, week), run)`; an independent `eval` seed re-prices the search's top-k | A seed per snapshot re-rolls every draw 144×/day (p90 sd 0.86 pts vs a 0.05 tolerance) and defeats write-on-change (systems B3, ML I1); the argmax on one set of dice is biased upward (ML I2) |
| D4 | **The exchange types are `model` (generative params, conditional on playing), `dist` (fixed quantile grid + mean + p_zero + n), `prob`, `state`, `number`, `object`.** Points-space fields carry `scoring_key`. Served point = mean | An 11-point grid cannot take a pass/rush multiplier or carry persistence (ML B3); the 5 leagues already use 2 distinct scoring sets (A11); medians are the wrong objective for expected-points decisions (ML I10) |
| D5 | **Registry as a table:** `engine_fields` (field → producer, valueType, entityTypes, maxAgeSec, tolerance, fallbackField, checks, replaces) upserted by the daemon and enforced by a `BEFORE INSERT` trigger; `engine_producers` (versions with code_sha, params_hash, fit_ref, training_window, registered_at); lanes `{live, shadow}` only; `engine_fallback` (field → fallback in force) written by the monitor | In-memory registration leaves the web process unable to read any producer's field and enforces one-writer per process only (systems B1); a `baseline` lane is a second writer (systems I2) |
| D6 | **Whole-tick recompute for cheap producers, one dirty bit per (heavy producer, league)** that sets when the max id of any input field or event type for that league moved; write-on-change with a per-field tolerance | Entity-grain dependency tracking never revisits a silent manager (systems B5) and is heavy for 5 leagues × ~60 teams (systems S1, ML S2) |
| D7 | **Reason chains additive in a declared space** (`space: 'pts' \| 'logit' \| 'prob'`), validated on write; blenders compose in logit space for probabilities; simulator chains are leave-one-out rescores on the same world | Linear pooling of probabilities contradicts logistic stacking (ML I4); rescoring on re-rolled dice makes chains mostly residual (ML I1) |
| D8 | **The daemon is the only writer of engine tables; writes are refused unless the role is explicitly `engine`, `script` or `test`; children never write** | v1's guard was off unless `role=web` was set, which the launcher, Docker and installers do not set (systems I19); `spawnSync` children blocked the loop (systems I5) |
| D9 | **Outcomes are events, grades are fields, monitors are producers; each field has a pre-registered decision time and is graded on the row in force then** | Grading on `known_by ≤ outcome.as_of` counted rows written after kickoff as forecasts (ML B1) |
| D10 | **Jev is a producer in the shadow lane; its arms are averaged into one logit per question type; weights are learned only where volume exists; calls are intent-then-result events with backoff; graded forward only** | r17 (AUC 0.47 vs 0.78); paid calls were at-least-once with no backoff (systems I16); asking about past games leaks (ML I11) |
| D11 | **Identity keys are fixed by grammar and enforced on write; raw source ids are kept as alias entities and resolved at read time** | `entity_id` is a free string in #216 (`state.js:64-66`); 60% of injury events and 46% of transactions had no `players.id` at adapter time and would be lost forever (systems I9) |
| D12 | **Holdout discipline on reads:** in fit and replay roles, `getEvents`/`getState` refuse an `as_of` inside the 2025 window without a ledger id; each version stores its training window; promotion refuses overlap with the grading window | The leak happens on reads in fit scripts, and `player` keys carry no season for a write check to see (ML I9) |
| D13 | **No page recomputes, enforced by a ratcheting import test plus the fail-closed role guard** | RULES §2: automated checks beat reading |
| D14 | **Additive migrations only; one rewritten 075 holds every engine table** (it is unmerged); retention is by write-on-change and compare-latest dedupe, never deletion | Two migrations = two ~0.9 GB pre-migration backups (systems I7, I11) |
| D15 | **Health on every row** (HEALTH-01a folded in): per-field invariant checks run in `writeState`; failed rows are kept, never served; `inputs_health` propagates | Consistency without checks would serve garbage consistently (systems I10) |
| D16 | **Promotion is a PR; the active version is a constant in the producer module; the grade report is committed evidence; CI checks it against the prereg floors** | A runtime status machine with scripts that parse BENCHMARKS.md and call `gh` is heavier than the thing it guards (systems S2, I18); RULES §2 already makes CI the only gate |

---
## 2. The spine, precisely (schema v2 = one rewritten migration 075)

All tables live in `data.sqlite` (WAL, `busy_timeout` 15 s, `db/index.js:24-26`). `engine_events`, `engine_event_entities`, `engine_state`, `engine_runs` and `engine_snapshots` are append-only with the #216 triggers. `engine_fields`, `engine_producers`, `engine_cursors`, `engine_fallback` and `engine_requests` are small mutable bookkeeping tables (they hold specs and pointers, never numbers). 075 refuses to run when an `engine_state` table without a `lane` column already exists (a v1 database, such as #216's TDD copy), because `CREATE TABLE IF NOT EXISTS` would silently keep the old shape (systems M9).

### 2.1 `engine_events` (the log; #216 `075_engine_spine.js:26-36`, plus five columns)

| column | type | meaning |
|---|---|---|
| id | INTEGER PK | monotone; the log's own clock |
| event_type | TEXT | registered name (`registry.js:35`), `family.name` |
| as_of | TEXT ISO ms | **valid time**: when the fact was true or first observed (rules in 3.1) |
| **as_of_quality** | TEXT | `exact` (a source stamp of the fact itself), `first_seen` (the capture that first saw it: an honest upper bound), `date_only` (a bare date, mapped to the end of that day ET), `clamped` (a source stamp later than ingest, clamped to `ingested_at`; the raw stamp stays in `payload.source_as_of`). Grading and replays use `exact` and live `first_seen`; `reconstructed` + `first_seen` rows are excluded from grading (3.7) |
| ingested_at | TEXT ISO ms | **transaction time**: when this log received it (`events.js:73`) |
| **provenance** | TEXT | `captured` (received while current), `reconstructed` (backfilled from an archive: everything the first backfill writes), `derived` (computed here). Same closed set as `nfl-bitemporal.js:38-42` |
| league_id, team_id, player_id | | primary scope (kept from #216; `league_id NOT NULL DEFAULT 0`, 0 = global, so the index is usable); **multi-entity events use 2.2** |
| source, **natural_key**, source_key | TEXT | `natural_key` = the row's identity in its source (`season:week:team` for a line, `season:week:gsis_id` for an injury, `league:season:tx_id:status` for a transaction status, `league:roster:metric:scoring_period` for a signal). `source_key` = `natural_key:payload_hash:prev_event_id` and is UNIQUE with `source`. **Compare-latest rule:** an adapter appends only when the payload hash differs from the latest event with the same `(source, natural_key)`; so an unchanged re-capture appends nothing, and A → B → A appends three events (v1's history-wide hash key would have dropped the second A: systems B7) |
| payload | TEXT JSON | facts only; forbidden keys refused (`events.js:16`); anything a model produced sits under `payload.model` and is stripped for learners (ML M4) |
| **schema_version** | INTEGER | payload schema per event_type (starts at 1) |

Indexes: `(event_type, as_of)`, `(player_id, as_of)`, `(league_id, team_id, as_of)` as built; add `(source, natural_key, id DESC)` for compare-latest and `(ingested_at)` for knowledge-time reads.

### 2.2 `engine_event_entities` (who an event is about) — new, additive

`(event_id, entity_type, entity_id, role)` with PK `(entity_type, entity_id, event_id)` and an index on `(event_id)` (the cursor scan `event_id > ?` needs it: systems M3). Filled by `appendEvents` from `event.entities[]`. Roles: `subject`, `from`, `to`, `counterparty`, `league`. **Aliases:** when a source id has no `players.id` yet, the adapter emits the alias entity (`gsis:<id>`, `espn:<id>`, `sleeper:<id>`) instead of dropping it; `getEvents({entities})` expands a `player:<id>` filter to its aliases through `player-identity.js` at read time, so a mapping added later reaches events already written (systems I9). A trade proposal is about two league_teams and N players; today `getEvents({playerId})` misses every multi-player transaction because `player_id` is null when items.length ≠ 1 (`backfill.js:66-67`, `:73`).

### 2.3 `engine_state` (the box; #216 `075_engine_spine.js:43-58`, plus three columns and a new key)

| column | meaning |
|---|---|
| id | INTEGER PK; **the row's transaction time** (D1) |
| entity_type, entity_id, league_id | identity per 2.11; `league_id NOT NULL DEFAULT 0`; **write rule:** a league-scoped entity's `league_id` must equal its id prefix |
| field | registered in `engine_fields`, one producer (trigger + capability + grep, 4.5) |
| value | JSON per the field's `valueType` (2.9) |
| as_of | valid-time cutoff the producer computed *about* (= the tick's as_of for live runs) |
| producer, producer_version | as built; the version resolves to `engine_producers` |
| **lane** | `live` \| `shadow`; part of the unique key |
| reason_chain | v2 (2.10) |
| event_ids | as built (`state.js:72-82` validates no future leak); **small lists only** (the events a chain cites); bulk lineage goes through `run_id` |
| **health** | JSON `{status: ok\|degraded\|failed, checks:[{id, passed, detail}], inputs_health}` (2.9, D15) |
| **run_id** | `engine_runs.id`; the run row carries the **input cut** (max event id and max state id at run start), which is the row's lineage: "every row of my declared input fields in force at that cut" (systems I7: no 4,500-id lists per `title.odds` row) |
| written_at | as built |

Unique key: `(entity_type, entity_id, field, league_id, lane, as_of, producer_version)`. Live `as_of` is the tick time, so a recompute after a late event lands at the next tick with a new `as_of`; the same key twice is the idempotent no-op it is today. Read index: `(entity_type, entity_id, field, league_id, lane, id DESC)` (a view resolves "latest row with `id ≤ cut`" in one seek); `(producer, producer_version, id)` for grading scans; `(run_id)`.

### 2.4 `engine_fields` (the registry as data) — new, additive, mutable

`(field PK, producer, value_type, entity_types JSON, max_age_sec, tolerance, fallback_field, checks JSON, replaces JSON, space, description, updated_at)`. The daemon upserts every declared field at startup and refuses to start if a field's `producer` differs from the table's (a rename is a migration of the field, never a silent takeover). A `BEFORE INSERT` trigger on `engine_state` raises unless `NEW.producer = (SELECT producer FROM engine_fields WHERE field = NEW.field)`. The web process reads specs from this table and registers nothing (`routes/engine.js:21` stops importing `backfill.js`). `checks` lists invariant check ids from the check registry (`prob_unit`, `probs_sum_1`, `quantiles_ordered`, `no_nan`, `sum_to:<target>`, `in_range:<lo>:<hi>`), run by `writeState`. `replaces` names the legacy functions the field retires, for the ratchet (10.4).

### 2.5 `engine_producers` (versions) — new, additive, mutable only in `status`

| column | meaning |
|---|---|
| producer, version | e.g. `activity`, `living01a-1` |
| code_sha | git sha of the producer file(s) at registration |
| params_hash | sha256 of the fitted constants (e.g. `FITTED_PARAMS`, `activity-model.js:260`) **plus the active fit id** when the producer reads a fit store (`weekly_ensemble_fits.id`), resolved at the start of each run and recorded on `engine_runs` (systems I15) |
| fit_ref | pointer into an existing fit store or a `docs/evidence/<date>/` path; never a copy |
| training_window | JSON `{from, to}` of the data the version was fit on; promotion refuses when it overlaps the grading window (D12) |
| fields | JSON list of fields this version writes |
| inputs | JSON `{events:[types], fields:[upstream fields], scope: entity\|league\|global, schedule: tick\|nightly\|weekly, budget_ms}` |
| status | `active` \| `shadow` \| `retired`; **set from the producer module's constants at daemon start** (D16), never by a script |
| registered_at, prereg_ref | audit; `registered_at` must precede the first decision time a row of this version is graded at (3.7) |

### 2.6 `engine_runs`, `engine_cursors`, `engine_fallback` — new, additive

- `engine_runs` (id, tick_id, producer, version, lane, scope_key, **input_cut_event_id, input_cut_state_id**, started_at, finished_at, ms, rows_written, rows_unchanged, error, dirty_reason, **lease_until**). Append-only. Freshness for the reader comes from here: a field is `stale` when the last successful run of its producer for the row's scope is older than `max_age_sec`, not when the row's `as_of` is old (write-on-change keeps healthy rows unchanged for hours: systems I3). Child processes (nightly/weekly) hold a lease row; the daemon writes their results.
- `engine_cursors` (producer, version, source, watermark, updated_at) — mutable; per adapter the source watermark; per (heavy producer, league) the input cut it last ran at (the dirty bit is "max id of any input moved past it"). Cursors advance only on success, so a skipped or failed run keeps its dirty bit.
- `engine_fallback` (field, league_id, fallback_field, since, reason, n) — mutable; the monitor producer is its one writer; the snapshot records the set in force.

### 2.7 `engine_snapshots` — new, additive

| column | meaning |
|---|---|
| id | monotone |
| league_id | the league (0 = the global snapshot for league-free views) |
| tick_id | audit |
| max_event_id, max_state_id | **the cut** every row in this snapshot satisfies |
| version_set | JSON `{producer: version}` for every active producer |
| fallback_set | JSON `{field: fallback_field}` in force at publish |
| season, nfl_week, world | the dice: `world = keyedSeed('world', season, nfl_week)`; `eval = keyedSeed('eval', season, nfl_week)` |
| created_at | audit |

Published **per league, only when every producer in that league's DAG finished the tick**; a failed or over-budget producer leaves the previous snapshot serving with its age (systems I4, ML I3). `GET /api/engine/snapshot?league_id=` returns the latest; every view read passes `snapshot_id`.

### 2.8 `engine_requests` (the only engine table the web process may INSERT into) — new, additive

(id, kind, params_hash, params_json, snapshot_id, requested_by, requested_at, **lease_until**, started_at, done_at, result_state_id, error). Kinds: `rescore` (a hand-built deal → an `action_price` row via RL-19-2's `rescore(world, overrides)`), `evaluate`, `offer`, `sequences`. Deduped by `(kind, params_hash, snapshot_id)`; a lease expires after 60 s so a daemon crash never leaves a page polling forever (systems I6). The daemon polls it between producer runs. The page shows "pricing…" and polls the result by request id; results never enter views (they are not part of any snapshot cut).

### 2.9 Value envelope (declared per field in `registerProducer`)

```
valueType 'number' : 12.4
valueType 'prob'   : 0.31
valueType 'model'  : { kind: 'player_week_params', params: {...pr.params of projections.js...},
                       cond_on_play: true, n, version }          // Understand → Simulate (D4)
valueType 'dist'   : { q: [0.05,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.95], v: [..11 numbers..],
                       mean, sd, p_zero, n, world, unit: 'pts'|'pp'|'prob' }   // display + grading
valueType 'state'  : { state: 'engaged', probs: {engaged:0.7, drifting:0.25, checked_out:0.05} }
valueType 'object' : any JSON (search results, cards), with `n` where a sample size exists
absence (any type) : value null + status in {'unknown','not_measured','zero'} + reason (never a default)
health (every row) : { status: 'ok'|'degraded'|'failed', checks: [{id, passed, detail}], inputs_health }
```
`proj.week` is a `model` **conditional on playing**; `avail.p_play` is applied exactly once, by the simulator (today `sampleWeeks` bakes it into the pool as zeros at `projections.js:989` *and* the world would have applied it again: ML B3c). `range.week` is the unconditional `dist` from the world's draws, on the fixed grid so quantiles compose without interpolation and the quantile score is computable from stored rows; `p_zero` carries the DNP mass there.

### 2.10 Reason chain v2

```
{ v: 2, additive: true|false, space: 'pts'|'logit'|'prob'|'pp',
  baseline: { value, source, text },                      // the incumbent or prior this number starts from
  contributions: [ { source, kind: 'event'|'state'|'model'|'prior'|'monitor'|'blend'|'rescore',
                     event_ids: [], state_ids: [], delta, weight, text } ],
  residual: number|null,                                  // value − baseline − Σ delta in `space` (0 when exact)
  n: number|null }
```
`writeState` validates (as #216 does for citations, `state.js:21-43`): every cited id is in the row's ids; when `additive`, |baseline + Σdelta + residual − value| ≤ 1e−6 **in the declared space** (a `prob` field with `space:'logit'` checks on log-odds; for `dist`, on the mean). Non-additive chains (`additive:false`, e.g. a posterior state) carry exact counterfactual contributions: `delta_i = value(all) − value(without i)`. **Composition through a blender:** for probabilities the blend is on logits, `logit(p) = b + Σ wᵢ·(logit(xᵢ) − b)` with the incumbent's logit as `b`, so each contribution is `wᵢ·(logit(xᵢ) − b)` with `state_ids:[row_i]` and the page can expand row_i's chain scaled by wᵢ (ML I4). For `blend.week` the blend is on the **mean** (a location shift; the shape comes from `proj.week`), since ESPN's number is a location, not a distribution. Monitor fallbacks add a `kind:'monitor'` contribution. Simulator outputs (`title.odds`, `action_price`) carry `kind:'rescore'` contributions: leave one input change out, rescore on the same world (RL-19-2), difference; the residual is the interaction term.

### 2.11 Identity keys (grammar, enforced by `writeState` and `appendEvents`)

| entity_type | entity_id | source of truth |
|---|---|---|
| player | `players.id` (internal int) | `player-identity.js`; raw ids are alias entities in 2.2, never in a field key |
| player_week | `<player_id>:<season>:<week>` | scoring-free fields (`proj.week` as a model, `avail.p_play`) |
| **player_week_scored** | `<player_id>:<season>:<week>:<scoring_key>` | points-space fields (`espn.week`, `blend.week`, `range.week`); `scoring_key` = sha256 of the league's `scoringSettings.scoringItems` (2 distinct keys across the 5 leagues today, A11) |
| nfl_team | abbr (`team-codes.js`) | |
| game | `<season>:<week>:<home_abbr>` | `game_lines` convention; cutoff = `game-cutoff.js` |
| week | `<season>:<week>` | NFL week; `nfl.week` (one producer) replaces `tradeWeekContext` (`trade-engine.js:180-184`) |
| league | `leagues.id` (internal) | |
| league_week | `<league_id>:<season>:<week>` | `league.week` (one producer) replaces `leagueCurrentWeek` (`league-week.js:12`) as the *served* value |
| league_team | `<league_id>:<roster_id>` | #220 already uses this (`activity-model.js:449`) |
| league_team_week | `<league_id>:<roster_id>:<season>:<week>` | |
| matchup | `<league_id>:<season>:<week>:<a>:<b>` (a<b) | |
| deal | `<league_id>:<deal_hash>` | `action_price`, `blend.p_accept`, `jev.p_accept.*` |
| offer | `trade_outcomes.id` | |
| rec | `rec_ledger.id` (#174) | |
| hypothesis | sha256 of the spec (HYPO-01a) | |
| producer | `<producer>@<version>` | grades and monitors key on this |
| engine | `events`, `daemon`, `jev` | spine-level fields |

Managers are `league_team` in the public repo. Cross-league person identity (`manager-identity.js`) stays local-only and never becomes a key.

### 2.12 The reader API (web, read-only)

| route | returns |
|---|---|
| `GET /api/engine/state?entity=&field=&as_of=&lane=&league_id=` | one row (as #216, `routes/engine.js:25`), plus `status` ∈ ok/zero/unknown/stale/fallback/thin/degraded with reason, `health`, `fresh_at` (from `engine_runs`). A league-scoped entity without `league_id` returns `league_id_required`, not `no_row_as_of` (systems M8) |
| `GET /api/engine/snapshot?league_id=` | latest snapshot (id, cut, version_set, fallback_set, world, age) |
| `GET /api/engine/view?view=<name>&league_id=&snapshot_id=` | a declared **view**: a fixed list of (entity, field) rows resolved at one snapshot (4.6) in one query (e.g. `my_team`, `start_sit`, `trade_lab`, `clone:<team>`); every row carries producer@version, as_of, status, health, reason_chain |
| `GET /api/engine/status` | daemon heartbeat, lock holder, per-source watermark, lag and coverage, per-producer version/lane/grade/fallback, Jev spend and balance |
| `POST /api/engine/request` | inserts an `engine_requests` row; returns its id; the page polls `/request/:id` |

Views are declared in `server/services/engine/views.js` as data (name → rows), not code, so the "no arithmetic on engine values" grep has one file to check. The client pins **one snapshot id per page load** through a context provider; every `useEngineView` on the page reads that id (systems M7).

---

## 3. The arrows: the exact contract for each

Common to every arrow: the object lands in an engine table; the next layer reads it from there at a cut; no layer imports another layer's producer. The process column names the only process allowed to write that arrow's object.

### 3.1 Arrow 1→2: source tables → `engine_events`

| | contract |
|---|---|
| Object | event envelope: `{event_type, as_of, as_of_quality, provenance, league_id?, team_id?, player_id?, entities:[{type,id,role}], source, natural_key, payload, schema_version}`; `source_key` and `ingested_at` are stamped by `appendEvents` |
| Schema | 2.1 + 2.2. Payload schemas per type are registered next to the type (`registerEventType(type, {description, schema_version, payload_keys})`), extending `registry.js:35` |
| Trigger / timing | The refresh job (`~/gridiron-local/refresh.sh` → `scripts/refresh-live-data.mjs --loop 900`) keeps filling the source tables it always has, and gains a lock (two copies are running now, pids 49407 and 74430, A13). The **engine daemon** runs the adapters every tick (default 10 min) and wakes within 60 s of any `sync_log.last_run_at` advancing (`scheduler.js:81 recordSync`). Each adapter reads from its `engine_cursors` watermark, never the whole table. **Real latency from a source to a page is ≤ 15 min (refresh) + ≤ 1 min (wake) + the tick**, not "seconds" (systems M1) |
| **as_of rules (per source)** | transactions: a status row (`TRADE_DECLINE`, `TRADE_ACCEPT`, `TRADE_VETO/UPHOLD`, `FREEAGENT`, `ROSTER`) is stamped `processed_at` when present, else **`first_seen_at`** (`first_seen`), **never `proposed_at`** (all 58 declines have null `processed_at` and v1 dated them at the proposal: systems B8; A9); the proposal event keeps `proposed_at`. Injuries: `modified_at` when present, else the capture time (`first_seen`): every 2025 and 2026 row has an empty `modified_at` (6,238 rows, A8), so v1 had **no injury stream for the season being played** (ML B2). Lines: `fetched_at`, but `gamescript.js:156` rewrites `fetched_at` when scores are written, so the natural key + compare-latest rule decides whether a line moved. News: `min(published_at, ingested_at)` with `clamped` when the source stamp is later (159 rows are, by up to 6.3 h, A10) and `date_only` for bare dates (342 rows, A10). Lineups: `changed_at`. Signals: `computed_at`, natural key includes the scoring period. Every live capture: `as_of := min(source_as_of, ingested_at)` so a producer's id cursor never skips an event whose valid time is ahead of the tick (systems B9) |
| Process | engine daemon only. The refresh job never imports `services/engine/*` (grep test); the web never appends |
| Latency budget | ≤ 5 s per tick for all adapters (the full 42,922-event backfill took 1,759 ms, #216 TDD §4) |
| Failure | per-adapter try/catch → `engine_runs` error row, that source's watermark stays, other adapters proceed; a source whose watermark is older than 3× its cadence renders `stale` in `/api/engine/status`; a row without any usable timestamp is stamped at capture time with `first_seen`, never guessed and never dropped |
| **Coverage** | Each tick the daemon reads `sync_log` (one row per job: `league_transactions` 478 runs, `roster_snapshots`, `nfl_injuries`, `nfl_lines`, `manager_signals`, …; A12) and appends a `source.coverage` event `{job, last_run_at, status}` when it changed (compare-latest). Readers of a stream get its coverage alongside its events; a window without a successful run inside the source's cadence (transactions: ESPN returns only the last ~3 days, `refresh-live-data.mjs:109-110`) is **unknown**, not zero (systems B6) |
| Sources and event types | existing nine (`registry.js:108-118`) plus: `manager.signal` (all `manager_signals` sources, counts only; the chat adapter becomes one case), `source.coverage`, `league.settings` (rules, `tradeSettings.deadlineDate`, `vetoVotesRequired`; DEADLINE-01 becomes a read), `league.matchup_result`, `market.player_value` (`dynasty_values`, hashed), `outcome.player_week` (per scoring key, with `stat_version` in the natural key so a correction is a new event), `rec.shown/considered/graded` (#174), `offer.sent` (OFFER-01), `jev.call` (intent and result), `jev.runaway`, `producer.registered/fallback/recovered`, `hypothesis.registered/tested`, `snapshot.created`, `surprise` |

### 3.2 Arrow 2→3: `engine_events` → Understand fields in `engine_state`

| | contract |
|---|---|
| Object | state row (2.3); for managers a `state` value; for players a `model` (`proj.week`), a `prob` (`avail.p_play`) or a `number` |
| Schema | reads: `ctx.read.events({types, entities, afterId, window})` (2.2-aware; **throws when a result hits its limit** instead of silently keeping the oldest rows: systems I17, ML M2) and `ctx.read.state(field, entity)` (at the run's cut, lane live, active version); writes: `ctx.write({entity, field, value, reasonChain, eventIds})` with `as_of = tick.as_of`, lane and version from the registry, health from the field's checks |
| Trigger / timing | **Cheap producers (calendar, league, gamescript, availability, espn, activity, tells, market) run for every entity every tick**; write-on-change keeps unchanged rows from adding anything, and a manager who did nothing is recomputed like everyone else (systems B5). Schedules: `tick` (≤ 30 s per producer per tick), `nightly` (03:00 local, child process, ≤ 30 min), `weekly` (after the last game of the scoring period is final in `game_lines`, ≤ 2 h). A producer whose output depends on the clock declares `league.week`/`nfl.week` as inputs; `ctx.read` of an undeclared field throws |
| Process | engine daemon; nightly/weekly hooks as **async** child processes with a lease row; the child emits JSON, the daemon writes rows (single writer; the loop never blocks: systems I5) |
| Latency budget | as above; a producer over budget is stopped; its previous rows keep serving; the league's snapshot is not published this tick and the strip shows the age |
| Failure | a throwing producer is recorded against itself (`engine_runs.error`), never swallowed, never blocks others; three consecutive failures → `degraded` in status and the strip; cursors advance only on success |

### 3.3 Arrow 3→4: Understand fields → the simulator's world

| | contract |
|---|---|
| Object | the **world** for one league at one cut: per (player, week) a sorted pool of draws built from `proj.week` (model params) × `game.script` (pass/rush multipliers from `market.game_line`, the `gamescript.js:389 gameScriptFor` logic as a producer) under the league's `scoring_key`, with `avail.p_play` applied once per draw; `proj.ros` for future weeks; `league.rules`, `league.week`, `nfl.week`; (LIVING-01b) `activity.manager`. Seed: `snapshot.world` (per NFL week) |
| Schema | daemon memory keyed `(league_id, cut)` plus a stored `sim.world` row `{pool_hash, players, weeks, POOL, world, input_cut}` so any consumer can prove it used the same world; outputs `range.week` (dist per `player_week_scored`), `title.odds` (per league_team: `{title, playoffs, finals, byes, expected_wins, se}`), `action_price` (per deal: `{title_delta_search, title_delta_eval, se, clears_noise}`) |
| **Missing-input policy** | a player whose `proj.week` row is absent, failed or degraded takes the field's `fallback_field` row (`espn.week`, then `proj.ros` scaled); the world and every output built on it carry `health.inputs_health = degraded` and the status `thin` names the players (ML M7) |
| Trigger / timing | the league's dirty bit: the max id of any declared input (field rows or event types) for that league moved past the cut of the last successful build. No coalescing window: with a fixed weekly seed a rebuild is cheap to skip and honest to run. Expected: about one build per league per hour in season (lines move hourly; guess), ≤ 8 s each |
| Process | engine daemon (`sim` producer). The web never calls `simulateSeason`/`tradeImpact` (today: `routes/model.js:450-462`, `:466-489`, `title-odds-trades.js:68`) |
| Latency budget | world build ≤ 8 s per league (today's 2,000-run `simulateSeason`; RL-19-2 measured 4.2-8.3 s per `tradeImpact`, WORK-QUEUE.md:934); rescore ≤ 150 ms per deal (RL-19-2: 77-145 ms, bit-identical) |
| Failure | a failed build leaves the previous `title.odds` and `range.week` rows serving under the previous snapshot; the strip says "title odds: 22 min old, last build failed: <reason>" |

### 3.4 Arrow 4→5: simulator fields → Decide producers (four ordered fields)

| | contract |
|---|---|
| Object | **(1)** `search.candidates` (`search` producer: generation from `range.week`, `proj.ros`, `price.market`, `clone.price`, `clone.p_accept`, `league.deadline`, `self.bias`; each candidate = `deal_hash` + state ids, never copied numbers) → **(2)** `action_price` (`sim`: every candidate rescored on the search world, the top-k re-priced on the eval world) and `jev.p_accept.<arm>` (`jev`, shadow) → **(3)** `blend.p_accept` (`accept-blend`: `clone.p_accept` and Jev on logits; weight 0 = the clone byte-for-byte) → **(4)** `search.trades` / `search.offers` (`rank`: the final ranking from `action_price.title_delta_eval`, `se`, `blend.p_accept`). Also `waiver.board`, `lineup.call`, `radar.flags`, `search.paths` (CHESS) as their own fields |
| Why four | v1 had `sim` writing `action_price` "for the finder's shortlist" while `search` read `action_price` (a cycle), and Jev after `search` while `search` read `clone.p_accept`, so Jev could never move a ranking and the card showed two P(accept)s (systems B4) |
| Schema | every ranked deal carries `{score, title_delta (eval), se, p_accept: <blend.p_accept row id>, inputs: state_ids}`; no candidate carries a number the state does not hold |
| Trigger / timing | after `sim` for that league (dirty bit); Jev runs on the candidates with a 60 s wall budget; `rank` runs last |
| Process | engine daemon; Jev calls through the one gateway (JEV-01a) inside the daemon |
| Latency budget | finder ≤ 20 s per league (guess; today 1.3-5.0 s per page, `trade-engine.js:190-197`); eval re-pricing of k ≤ 10 deals ≤ 1.5 s; chess ≤ 60 s per league with its node budget; Jev ≤ 60 s |
| Failure | partial results are typed: `{n_scored, n_candidates}`; a Jev outage writes `jev.status` as `no_key` or `error` with a reason and the blend serves the clone with weight 0 (JEV-01c); nothing falls back to a default probability |

### 3.5 Arrow 5→6: state → pages and Coach

| | contract |
|---|---|
| Object | a **view** at a **snapshot** (2.12): rows with value, status, health, producer@version, as_of, reason_chain |
| Schema | `GET /api/engine/snapshot` once per page load (context provider), then `GET /api/engine/view?view=&snapshot_id=` per view; `useEngineView(view)` is the only fetcher of engine numbers (UI-ENG-6) |
| Trigger / timing | on page load and on a 60 s poll of `/snapshot` (a new snapshot id = refetch every view on the page together) |
| Process | web server, read-only (role `web`: `writeState` throws) |
| Latency budget | view resolution ≤ 50 ms server (one indexed seek per row at the cut, ≤ 300 rows), page ≤ 300 ms; Coach ≤ 5 s (LLM-bound), its numbers from the same view |
| Failure | typed absence per row; a snapshot older than 3× the tick interval renders the strip red with the age; a missing row never renders as 0 or "—" (UI-RED 2); a `failed` field renders its fallback or "last good, N min old", never the failed value (HEALTH-01b) |

### 3.6 Arrow 6→7: what Nick and the league did → events

| | contract |
|---|---|
| Object | `league.lineup` (what was set), `espn.transaction` (what was claimed/[redacted]), `trade.proposed/resolved` and `offer.sent` (OFFER-01 "I sent this"), `rec.shown/considered` (SELF-01a follow ledger), `outcome.*` |
| Trigger | same adapters as 1→2; `offer.sent` and `rec.*` are written by the daemon from `trade_outcomes` / `rec_ledger` (the web writes those source tables as today, `routes/trades.js:805 recordProposalSlate`, never engine tables) |
| Failure | as 3.1 |

### 3.7 Arrow 7→3: outcomes → grades → new versions

| | contract |
|---|---|
| Object | `grade.<producer@version>.<field>` rows (proper scores with n and CI, per lane), `monitor.<field>` decisions and the `engine_fallback` table, `autopsy.week` rows, `hypothesis.*` rows, and **new producer versions** registered in `shadow` by PR |
| **Decision time** | each graded field pre-registers when its number is *used*: `proj.week`, `avail.p_play`, `range.week`, `lineup.call` → the player's game cutoff (`game.cutoff`); `title.odds` → the league's first kickoff each week; `p_accept` (`clone`, `blend`, `jev`) → the offer's send time (`offer.sent.as_of`); `waiver.board` → the league's waiver process time; `search.trades` → when shown (`rec.shown`). **The graded row is the one in force at that time** (latest row with `id ≤ the cut at decision time`), its version registered before it, its training window ending before it (ML B1). Rows from `reconstructed` events or `first_seen` stamps far after the fact are excluded |
| Schema | 7.2-7.4 |
| Trigger / timing | per outcome event (offers settle on sync; player-week actuals land when `player_week_usage` is ingested for a finalized week); nightly calibration/refit; weekly autopsy and reweighting |
| Process | engine daemon (grader, monitor, hypo) and its child processes (refits) |
| Latency budget | grades within one tick of the outcome event; fallback decisions nightly (plus a cheap per-tick check); refits ≤ 30 min |
| Failure | a grader error leaves status unchanged and visible; a refit that fails registers nothing; the monitor never flips below the cluster floor (7.4) |

---
## 4. How the producers inside each layer combine

### 4.1 A producer is a declaration plus a pure `run`

```js
// server/services/engine/producers/<name>.js
export const VERSIONS = { active: 'living01a-1', shadow: [] };   // promotion = a PR that edits this line (D16)
const WRITERS = registerProducer({
  name: 'activity',
  versions: {
    'living01a-1': { params: FITTED_PARAMS, training_window: { from: '2021-09-01', to: '2023-01-15' }, run },
  },
  fields: [{ field: 'activity.manager', valueType: 'state', space: 'prob', entityTypes: ['league_team'],
             maxAgeSec: 3600, tolerance: 0.005, fallbackField: 'activity.population',
             checks: ['probs_sum_1', 'no_nan'], replaces: ['counterparty-pricing.js#activityFactor'] }],
  inputs: { events: ['espn.transaction', 'manager.signal', 'source.coverage'], fields: ['league.week', 'league.rules'],
            scope: 'league_team', schedule: 'tick', budget_ms: 2000 },
});
function run(ctx) { /* reads via ctx.read (cut-bound), writes via ctx.write (lane, version, health bound) */ }
```
`registerProducer` wraps #216's `registerField` (`registry.js:55`) so the writer capability stays module-private (the grep test of #216 stays), upserts `engine_fields`/`engine_producers` when the process is the daemon, and computes `params_hash` from `params` plus the active fit id. `ctx` = `{snapshot:{as_of, cut, world, season, nfl_week}, dirty:{leagues, reasons}, read:{events, state, coverage}, write}`; `ctx.write` stamps `as_of`, `run_id`, lane and version, and runs the field's checks. `ctx.read.state` records the health of every row it returns, and `ctx.write` sets `inputs_health` to the worst of them (HEALTH-01a's lineage propagation, with the producer doing nothing). A producer cannot pick its own lane, version or cutoffs. A module may register more than one version; the daemon runs the active one in lane `live` and each shadow one in lane `shadow` on the same inputs.

### 4.2 The producer DAG (target inventory, who reads whose fields)

| layer | producer | fields it owns | reads events | reads fields | replaces today |
|---|---|---|---|---|---|
| 3 | `calendar` | `nfl.week` (week:), `game.cutoff` (game:) | market.game_line | | `trade-engine.js:180 tradeWeekContext`, `game-cutoff.js` |
| 3 | `league` | `league.week`, `league.rules` (incl. `scoring_key`), `league.deadline` (league:) | league.settings, league.matchup_result | nfl.week | `league-week.js:12`, `league-rules.js:71`, DEADLINE-01 |
| 3 | `gamescript` | `game.script` (game: pass/rush multipliers, win prob) | market.game_line | nfl.week | `gamescript.js:389 gameScriptFor` (its caller `season-sim.js:360-361`) |
| 3 | `availability` | `avail.p_play` (player_week: prob + designation) | nfl.injury, league.lineup (ESPN status), news.item, source.coverage | nfl.week, game.cutoff | `contingency.js:934 weeklyAvailability` |
| 3 | `espn` | `espn.week` (player_week_scored: number) | (adapter from the ESPN weekly archive) | league.rules | the ESPN candidate inside #164 |
| 3 | `projections` | `proj.week` (player_week: **model**), `proj.ros` (player: number now; a calibrated dist is its own versioned change with a PRE), `proj.links` (PROJ-02) | outcome.player_week, nfl.injury | nfl.week | `player-week-engine.js:256`, `ros-projection.js:364`, `projections.js:504`, the assetUniverse fields `current_week_ppg`/`ros_ppg`/`adj_ppg` (`trade-engine.js:506-518`) |
| 3 | `weekly-blend` (blender) | `blend.week` (player_week_scored: dist, mean blended, shape from proj.week) | | proj.week, espn.week, game.script, `blend.week.weights` (written by `blend-learner`) | #164/#166 `weekly-blend.js`, BLEND-02 |
| 3 | `market` | `price.market` (player: number + trend) | market.player_value | | `assetUniverse.value`/`trend30` (`trade-engine.js:494-502`), `trade-market.js:109`, `hype.js:37` |
| 3 | `activity` (#220) | `activity.manager` (league_team: state), `activity.population` (league: state prior, the fallback) | espn.transaction, manager.signal, source.coverage | league.week, league.rules | `counterparty-pricing.js:521 activityFactor` / `:548 checkedOutFactor` (reads stay; the number moves; PREVIEW-01's `activityPreview` at `:284` is retired by `replaces`) |
| 3 | `tells` | `tells.card`, `tells.prior_trades`, `tells.checkout_risk` (league_team) | espn.transaction, league.lineup, manager.signal | activity.manager | TELLS-01b |
| 3 | `clone` | `clone.price` (league_team × player: number), `clone.p_accept` (deal: prob), `clone.motive`, `clone.p_complete` | trade.*, espn.transaction, offer.sent | activity.manager, tells.card, price.market, title.odds (motive) | `counterparty-pricing.js:674 playerValuation`, `:1016 readDeal`, `trade-acceptance.js:142 acceptanceBand`, CLONE-01a/b, VETO-01 |
| 3 | `self` | `self.follow`, `self.bias` (league_team = Nick) | rec.*, league.lineup, trade.* | clone.* | SELF-01a/b |
| 4 | `sim` | `sim.world` (league), `range.week` (player_week_scored: dist), `title.odds`, `title.odds_frozen` (league_team), `action_price` (deal), `lineup.ceiling`, `lineup.posture` (from the same pools) | league.lineup (rosters) | proj.week (model), blend.week (mean, when BLEND-02 ships), proj.ros, game.script, avail.p_play, league.rules, league.week, nfl.week, search.candidates, activity.manager (LIVING-01b) | `season-sim.js:290/:525`, `trade-engine.js:447 weekDist`, `ceiling-lineup.js:185`, `lineup-posture.js:250`, `title-odds-trades.js:41`, CE-09-a/b, RL-19-2, RL-17-3 |
| 5 | `search` | `search.candidates` (league_team) | | range.week, proj.ros, price.market, clone.*, league.deadline, self.bias | the generation half of `trade-engine.js:1783 findTrades`, `:2490 offerFor`, `:2649 offerForMany`, RADAR-01 (`radar.flags`) |
| 5 | `jev` | `jev.<qtype>.<arm>` (shadow) | | the snapshot pack (8.1), search.candidates | JEV-01a |
| 5 | `accept-blend`, `avail-blend`, `startsit-blend` (blenders) | `blend.p_accept` (deal), `blend.p_play`, `blend.startsit` | | clone.p_accept / avail.p_play, jev.*, jev_weight.* | JEV-01c |
| 5 | `rank` | `search.trades`, `search.offers`, `search.paths` (league_team) | | search.candidates, action_price, blend.p_accept, clone.p_complete | the ranking half of `findTrades` (`:2264 acceptanceBand` call, `:1631 myPlayoffOdds`), `:2314 findTradeSequences`, CHESS-01 |
| 5 | `waivers` | `waiver.board`, `waiver.streams` (league_team) | espn.transaction (claims) | blend.week, range.week, avail.p_play, league.rules | `waiver-wire.js:147`, `streaming-board.js:139` |
| 5 | `lineup` | `lineup.call`, `lineup.dead_starts`, `lineup.diff` (league_team_week) | league.lineup | blend.week, range.week, avail.p_play, title.odds | `lineup-brain.js:419`, `dead-starters.js:97`, `lineup-signals.js:132`, `trade-engine.js:3115 lineupDiff`, `command-center.js:213` (dead starters, streams, injury alerts, no-move nudges; #186) |
| 7 | `grader` | `grade.<producer@version>.<field>` (producer), `luck.<rec>` | outcome.*, trade.resolved, rec.graded, offer.sent | every graded field, all lanes | `gates/baseline-gate.js:106 gradeDecisions` (reused as the decision scorer), JEV-01b (2) |
| 7 | `monitor` | `monitor.<field>` (producer) + `engine_fallback` | | grade.* | ENGINE-00b-b (2)-(3) |
| 7 | `autopsy` | `autopsy.week` (league_team_week), `autopsy.player` (player_week) | outcome.player_week | proj.links, blend.week (the row in force at the cutoff) | `week-postmortem.js:44`, PROJ-04-a |
| 7 | `blend-learner`, `jev-grader`, `tells-refit`, `clone-refit` | `blend.week.weights`, `jev_cal.*`, `jev_weight.*`, tells/clone params (as new versions, by PR) | outcome.* | grade.* | PROJ-04-b, JEV-01b, TELLS-01a nightly, CLONE-01b b2 |
| 7 | `hypo` (deferred, 7.5) | `hypothesis.*`, `surprise` events | | served fields + grade.* | HYPO-01a/b |
| 2 | `engine-backfill` | `engine.ingest` | | | as built (#216 `backfill.js:33`) |

Edges are declared, so the daemon can print the DAG (`scripts/engine-dag.mjs`) and a cycle is a registration error at start. `sim` reads `search.candidates` and `rank` reads `action_price`: no cycle. `clone.motive` reads `title.odds` and `sim` reads `activity.manager`, not `clone.*`: no cycle; LIVING-01b must keep it that way.

### 4.3 The tick (what reruns when an input changes)

Per tick, in order:
1. **Adapters** append events (3.1) and `source.coverage`, and record per-source watermarks.
2. **Cheap producers** (`schedule: tick`, scope entity or league, budget ≤ 30 s each) run for **every** entity in dependency order; `ctx.read` is bound to the cut taken at the start of the run. Write-on-change (step 4) keeps this from adding rows.
3. **Heavy producers** (`sim`, `search`, `jev`, blenders, `rank`, `waivers`, `lineup`) run per league **only when that league's dirty bit is set**: the max id of any declared input field's rows or input event type's events for that league moved past the cut of the last successful run. Urgency needs no special path: the next tick is ≤ 10 min away and a wake-on-sync tick follows every ESPN sync within 60 s.
4. **Write-on-change.** `writeState` compares `(value, reason_chain)` with the latest row for the same key, lane and version; equal within the field's `tolerance` (0.1 pp for odds, 0.05 pts for ranges: display precision, since within one world the dice do not move) → `rows_unchanged`, nothing written. A changed value is a new row.
5. **Publish.** For each league whose DAG finished without a failed or over-budget producer, one `engine_snapshots` row with the cut. A league whose DAG did not finish keeps its previous snapshot; its dirty bits stay set.
6. **Cursors** advance per (producer, league) only on success.

This is Salsa's red-green idea (a revision counter; rerun only when a dependency's revision moved) with SQLite row ids as the revision counter, at league grain rather than entity grain, because 5 leagues and ~60 teams do not pay for entity-grain bookkeeping (systems S1, ML S2). Entity cursors are added only if a full cheap run exceeds its budget (measured in `engine_runs`). The existing fingerprint cache (`compute-cache.js`, keyed on table counts and max stamps) is the same idea at table grain; it goes away once a surface reads state instead of calling the producer.

Worked example: the injury collector marks player 9001 Out on Friday; the refresh job lands the row by 5:00 PM; the daemon wakes on the `nfl_injuries` sync row by 5:01 and ticks. `availability` recomputes every player (2 s; one row changes: 9001's `avail.p_play`); `proj.week` for 9001 (`model` unchanged: it is conditional on playing); the dirty bit is set for the two leagues rostering him; `sim` rebuilds both worlds (≈ 16 s) and rewrites the `range.week` rows that moved (his, plus his teammates' if `game.script` moved), `title.odds` for those leagues' teams, `action_price` for their candidates; `search`, `accept-blend`, `rank`, `lineup.call`, `waiver.board` for the two leagues. Two snapshots are published; the other three leagues keep theirs. The page shows one new snapshot id with every number consistent with the Out, by 5:02 PM.

### 4.4 Blenders are producers

A blender declares only upstream fields as inputs, never events or raw tables, and never a number it did not receive. Its weights are a field written by a learner producer (`blend.week.weights` by `blend-learner`), so "who decided the weights" has its own reason chain and version. Its chain is additive in its declared space (2.10). The ablation `zero:[source]` that `acceptanceBand` supports today (`trade-acceptance.js:142`) becomes a property of every blender: with a source's weight at 0 the output equals the incumbent byte-for-byte, and that is a RED test for each.

### 4.5 One writer per field

Three layers, all cheap: (1) the `engine_fields` trigger (2.4: a row whose `producer` is not the field's registered producer cannot be inserted by any process); (2) runtime capability by object identity (#216 `registry.js:55-77`, `state.js:49-62`); (3) the static test that each field literal is declared once and no writer is exported (#216 `test/engine-spine.test.js` grep). Blend outputs are separate fields from their inputs (`blend.week` ≠ `proj.week`), and a fallback is a *different field* (`fallbackField`), so there is never a second writer of a number, only a new number with its own owner (systems I2).

### 4.6 A consistent snapshot

A page or Coach answer names one `snapshot_id`. Row resolution for a view: for each (entity, field): the latest row with `lane = live`, `producer_version = snapshot.version_set[producer]`, `id ≤ snapshot.max_state_id`, `health.status ≠ failed` (one seek on the read index); if `snapshot.fallback_set[field]` names a fallback, the fallback field's row is served with status `fallback`. Because the cut is taken after the league's whole DAG finished, no row in the snapshot is newer than the rows it was built on, and no page can see league A's new `title.odds` beside old `search.trades` (systems B2, I4; ML I3). Two surfaces reading the same snapshot id cannot disagree; two surfaces reading different snapshots say so (the strip shows the id and age). Older snapshots resolve by the same query with their own cut, so "what did the Title tab show at 1 PM" is answerable forever.

### 4.7 Distributions and one set of draws (common random numbers)

- **Exchange type:** `proj.week` is a `model` (what the projection engine believes, conditional on playing); `range.week` is the *simulator's* draw pool summarised on the fixed grid, and it is what every page shows as floor/ceiling (UI-ENG-1's "the bar's ends equal the state's `week_range.p10/p90`"). They differ by design once game script, correlation (PROJ-03-b), spells (CE-03) and persistence add structure; the page always shows `range.week`.
- **Addressing rule (the CRN contract):** `world = keyedSeed('world', season, nfl_week)` and `eval = keyedSeed('eval', season, nfl_week)`; pool draws `keyedSeed(world, 'pool', player, week)` (as `season-sim.js:363`); copula normals `keyedNormal(keyedSeed(world, 'copula', player, week), run)` (as `:384`); availability paths `keyedSeed(world, 'avail', player)` (CE-03); persistence `keyedNormal(keyedSeed(world, 'talent', player), run)` when a `sim` version adds it (ML B3b, its own PRE); manager actions `keyedSeed(world, 'act', league_team, week)` (LIVING-01b); game paths `keyedSeed(world, 'game', game_id)` (PROJ-03-b). Nothing in the engine calls `random()` from a global stream (`season-sim.js:338` today draws `world` fresh per call; `trade-engine.js:447-457` seeds `weekDist` from a cache-key string; `ceiling-lineup.js:215` passes no keys; `player-week-engine.js:795-797` hashes its cache key). A grep test pins it: `random()` appears in `services/engine/**` only inside `withRandomSeed(keyedSeed(world, …))`.
- **Consequence:** the title odds, every trade's `action_price` (paired on the same world, so the paired SE of `season-sim.js:483-497` is unchanged), the start/sit range, the trade card's floor/ceiling, the waiver board's gain and the ceiling-lineup view are one set of football, and a number moves only when an input moves. The week's seed change is expected and labelled: every `range.week` row rewrites once a week; a trade compared across two worlds is labelled, never differenced.
- **Winner's curse:** `search` picks on `world`; `sim` re-prices the top-k on `eval` (a second world per league, built when the shortlist changed, ≤ 8 s); `action_price.title_delta_eval` is what the page shows and the grader scores (ML I2).
- **Sizing (guess):** a league world = its rostered + finder universe (~300 players) × ≤ 15 weeks × POOL 2,000 draws × 4 B (Float32) ≈ 36 MB per league, 180 MB for five plus the eval worlds when built (≤ 360 MB), held in daemon memory per cut and dropped on the next; `sim.world` stores only the pool hash and parameters. If memory bites, POOL 1,000 halves it at the cost of range noise (RL-5-3's note: p90 sd 0.86 at 2,000 vs 1.84 at 400).

---

## 5. Bitemporality: valid time vs knowledge time

**Definitions on this spine.** `as_of` = valid time: the instant the fact was true or first observed, with `as_of_quality` saying which. `ingested_at` (events) and `id`/`written_at` (state) = transaction time: when this machine held it. `provenance` says whether the transaction time is honest (`captured`) or a reconstruction (`reconstructed`: the first backfill's events all have `ingested_at` = that day and historical `as_of`).

**The four questions and the query for each:**

| question | query |
|---|---|
| What do we believe now? | latest live row at the latest snapshot's cut (4.6) |
| What did we believe at T about week W? | rows for `player_week`/`league_team_week` entities of W with `id ≤ the cut at T` (the snapshot published before T), version from that snapshot |
| What was true by T, with hindsight? | events with `as_of ≤ T` regardless of `ingested_at` (includes reconstructed rows) — for research, labelled `history` |
| Replay decision D | D's row (`rec_ledger`, `trade_outcomes`, `offer.sent`) carries `snapshot_id`; the rows it saw are the rows at that cut (exact, no recompute needed). Rerunning a producer over them is a **test on a database copy** (`GRIDIRON_DB_PATH` must not be the live file, the `living01a-fit.mjs:47-50` guard generalised) that compares rows and inserts nothing into a live table |

**Can #216 answer them?** Q1 yes. Q2 partially: `getState` filters `as_of` only (`state.js:98-104`) and picks the newest row of any version or lane (`:101-102`). Q3 yes for events. Q4 no: no snapshot, no version registry, no world seed. After 11.2: yes to all four with no new clock column: the cut does the work.

**Rules that make the backtests honest:** (1) a grade computed on any `reconstructed` event, or on a `first_seen` stamp more than one capture cadence after the fact, is labelled `history`, never `forward` (the HOLDOUT-LEDGER distinction). (2) In roles `script` and `test`, `getEvents`/`getState` refuse an `as_of` inside the 2025 season window unless `HOLDOUT_LEDGER_ROW=<id>` names the ledger row (D12; a write-side check cannot see the season in a `player` key). (3) Upserted source tables (`league_roster_snapshots`, `game_lines`, `manager_signals`, `nfl_injuries`) lost their pre-log history; from the first daemon tick on, every change is an event, so the honest replay window for those sources starts on the day the daemon starts. (4) Wrapped legacy producers (wave 1) read raw tables through today's code (`weeklyAvailability` reads the whole week's `nfl_injuries` and the live ESPN status, `contingency.js:939-941`); their rows are honest **forward** (they ran live, and the row id is the knowledge time) and are never replayed over the past for promotion.

---

## 6. Versioning, lineage, reasons, rollback, shadow/challenger

### 6.1 Producer versions
`producer_version` on every row (as built) resolves to an `engine_producers` row with `code_sha`, `params_hash` (constants + active fit id), `fit_ref`, `training_window`, `registered_at`. A test recomputes `params_hash` from each producer module's fitted constants and fails when the active version's registered hash differs: "you changed the model, bump the version" becomes mechanical. Fits that already live in versioned stores are referenced, not copied: `weekly_ensemble_fits` (`weekly-weight-store.js:28` already enforces a training cutoff), `fantasy_coordinator_fits`, `docs/evidence/<date>/` outputs. A fit store promotion by the legacy `nfl_weekly_learning` job (`scheduler.js:1445`, run inside `refresh-live-data.mjs`) changes the hash and therefore the version on the next run; that job moves into the daemon's weekly hook when `blend.week` moves onto the spine (EA-07).

### 6.2 Lifecycle: three states, changed by PR
`shadow` (declared in the module's `VERSIONS.shadow`, writes lane shadow, graded) → `active` (the module's `VERSIONS.active`, writes lane live) → `retired` (removed from the module). A promotion PR changes the constant, commits the grade report (`scripts/engine-grade-report.mjs --producer P --version V`, aggregates only, from the local DB) under `docs/evidence/<date>/`, and updates the BENCHMARKS.md row. The daemon picks the new version up on restart (the merge-batch checklist gains "restart engine.sh" beside "restart run.sh"). Nothing at runtime moves a version; the only runtime switch is `engine_fallback`.

### 6.3 Promotion made mechanical (RULES §2-3)
CI runs `scripts/check-promotion.mjs` on any PR that changes a `VERSIONS.active` line. It refuses unless: (1) the committed grade report names the version, the pre-registered metric, n ≥ the prereg floor **in clusters** (weeks × entities, 7.2), and the anytime-valid interval (7.4) clear of 0 in the right direction; (2) the BENCHMARKS.md row holds or improves; (3) the prereg doc named in `prereg_ref` was committed before the first graded row (the `check-prereg-order.mjs:68-95` idea on events, checked against the report's first-graded timestamp); (4) the version's `training_window` ends before the grading window starts. A flag (`GRIDIRON_PREVIEW_UNCONFIRMED`, PREVIEW-01) may *display* shadow rows locally; it never changes lanes.

### 6.4 Rollback
A revert PR (the constant goes back; the prior version's rows still exist and serve after the daemon restarts, because rows are never deleted). For an incident, the monitor's fallback (7.4) is the instant path: the daemon writes `engine_fallback` between ticks, the next snapshot's `fallback_set` names it, and every served row carries the `kind:'monitor'` contribution. No script rewrites pointers, no version changes mid-tick.

### 6.5 Lineage
From any state row: `run_id → engine_runs` (tick, version, ms, dirty_reason, **input cut**) → the rows of the declared input fields in force at that cut (one query per input field) and the events of the declared types with `id ≤ input_cut_event_id`; `event_ids → engine_events → (source, natural_key)` → the source row. `scripts/engine-lineage.mjs --state <id>` prints the tree with clocks. The columns map onto OpenLineage's run/job/dataset facets, so an exporter is a script later; no OpenLineage JSON is emitted now because nothing consumes it.

### 6.6 Reasons that compose
Section 2.10. Pages render the chain as signed rows (UI-ENG `ReasonChain.tsx`) in the chain's space, converted for display (a logit contribution shows as its probability-point effect at the served value); a blender row expands into its inputs' rows scaled by weight; a monitor contribution reads "serving ESPN: ours trails by 0.04 log loss (n=61 player-weeks, 5 weeks)". The Coach writer turns the chain into words and `coach/verify.js` refuses any number not in a cited cell (as today).

### 6.7 Shadow / champion-challenger, graded side by side
Every version in every lane is graded by the same `grader` on the same outcomes at the same decision times, so the status strip can say "P(accept): clone-2 (shadow) trails active by 0.03 log loss (n=41)". Promotion (6.3) is the only way into lane live. Every served field declares a `fallbackField` (ESPN's `espn.week` for `blend.week`; `activity.population` for `activity.manager`; `clone.p_accept` for `blend.p_accept`; `title.odds_frozen` for `title.odds` once LIVING-01b ships) so the monitor always has something to compare against and fall back to; the fallback is a field with its own owner, never a second writer (systems I2).

---
## 7. The Learn loop

### 7.1 Outcomes are events

| event type | source → adapter | as_of (valid) | entities | payload (facts only) |
|---|---|---|---|---|
| `outcome.player_week` | `player_week_usage` finalized rows scored per distinct `scoring_key` (`scoring.js`); one event per (player_week, scoring_key, **stat_version**): a stat correction is a new event, and the grade rule below re-grades against the latest (systems M5, ML M5) | game end (`game-cutoff.js`) | player_week, game | `{season, week, player_id, scoring_key, stat_version, points, line:{...}}` |
| `league.matchup_result` | league payload / `league_week_scores` | week end | matchup, both league_teams | scores, winner |
| `trade.resolved`, `espn.transaction` | as built, with the 3.1 as_of rules | `processed_at` else `first_seen_at` | league_team(s), players (2.2) | as built |
| `offer.sent` | `trade_outcomes` rows the app logged (OFFER-01 b1) | proposed_at | offer, league_teams, deal | deal ids, band, pitch arm, **snapshot_id**, **the before-the-fact distribution of the deal's title delta** (7.3) |
| `rec.shown` / `rec.considered` / `rec.graded` | `rec_ledger` (#174, migration 071) | made_at / graded_at | rec, league_team | predicted, baseline call, **snapshot_id**, horizon, score, the predicted delta distribution |
| `outcome.lineup` (derived) | daemon: `league.lineup` at lock × `outcome.player_week` | week end | league_team_week | set-lineup points, best-possible points, engine-call points |
| `outcome.season` | payload at season end | final | league_team | playoffs, seed, title |

The `snapshot_id` on `offer.sent` and `rec.*` is what makes "replay any decision exactly" (5) real; #174's `inputs_hash` stays as the dedupe key, the snapshot id is added to `predicted_json` (no schema change to 071). **Pre-registered outcome:** the weekly strip grades against the latest `outcome.player_week` as of the grading run; the season roll-up and every promotion report use the outcome in force 7 days after the game (after stat corrections).

### 7.2 The grader (one producer, `grade.<producer@version>.<field>`)

Grading rule (D9, 3.7): a prediction row is graded only if it was **the row in force at the field's decision time** (`id ≤ the cut at that time`, its version registered before it, its training window ending before it); one grade per (prediction row, outcome entity), re-graded when a newer outcome event arrives. Scorers by `valueType`:

| valueType | proper scores stored | comparison |
|---|---|---|
| `dist` | **quantile score** (pinball sum over the 11 levels: an approximation of CRPS, named as such: ML M6) plus explicit `p_zero` and tail bins, log score of the realised bin, 80% coverage per position × week band | paired delta vs the fallback field or the incumbent, clustered by week and player |
| `prob` | log loss, Brier, calibration slope/intercept, isotonic map (Platt below n=200) | paired log-loss delta, manager- or player-clustered |
| `state` | next-period emission log-likelihood (the LIVING-01a grade), checkout AUC | vs `activity.population` |
| `model` (`proj.week`) | graded through the `range.week` it produces and through the lineup decisions it changes (below) | idem |
| decisions (`lineup.call`, `search.trades`, `waiver.board`) | `gradeDecisions` (`gates/baseline-gate.js:106`): points per decision, win rate, player/week-clustered CIs; `baselineGateVerdict` (`:176`) | vs the baseline call (ESPN's higher number; do nothing; most-added) |
| `title.odds` | **weekly matchup win probability** log loss (about 30 matchups a week across 5 leagues) and `range.week` quantile score are the primary grades; playoff Brier and the season log score are reported, not gated (about 60 team-seasons is too few: ML I6) | vs `title.odds_frozen` (LIVING-01b) |

**Floors are counted in clusters, never raw pairs:** a promotion or fallback needs ≥ 4 distinct weeks and ≥ 20 distinct entities (players, managers or matchups) in the window; thirty player-weeks from one Sunday are one cluster. `p_accept` has no promotion lane this season (37 labelled decisions, 14 `trade_outcomes` rows): the served number is the hierarchical population prior with Bayesian per-manager updates, status `thin` until the floor is met (ML I6).

Rows are keyed by producer entity `<producer>@<version>`, lane, window (`week`, `season_to_date`, `forward`, `history`), with `{n, clusters, metrics, vs_incumbent:{delta, interval}, label: fit|test|holdout|forward}`. The status strip, the promotion check (6.3) and the monitor read them.

### 7.3 Decision vs luck, mechanical (ML I8; TRADE-INSANE-RND §6)
Every recommendation row (`rec.shown`, `offer.sent`) stores the **before-the-fact distribution** of its delta (title delta or points delta) drawn on the same world, not just the point. At settlement the grader scores the counterfactual with realised player points: it solves both lineups (or both rosters, for trades, with the rest of the league held fixed) on actual points. Player outcomes do not depend on Nick's choices, so this works for every recommendation shown, including trades never sent. **Decision grade** = expected value at decision time (was the call right given what was knowable); **luck** = where the realised delta fell in the forecast distribution (its PIT); the grader checks that PITs are uniform per stream. Jev's recommended actions are graded with `gradeDecisions` on the weeks where Jev disagrees with the engine. A projection version is promoted only if it also passes the lineup decision gate with the challenger's inputs.

### 7.4 Drift monitor and automatic fallback (`monitor` producer)

Per served field with a `fallbackField`: the monitor reads `grade.*` for live vs fallback on the same settled outcomes and keeps **one anytime-valid confidence sequence** on the paired score differences (a mixture-martingale e-process, the same object for promotion and fallback, so checking every night does not inflate the false-flip rate: ML I7). Pre-registered rule: fallback when the sequence's upper bound is below 0 with the cluster floor met; recovery when a fresh window's lower bound is above 0 (hysteresis). A system-wide false-flip budget (one expected false flip per season across all fields) sets each field's error level. Validation before the rule goes live: simulate paired differences at the observed variance and cluster structure (not a 2024 replay, which the wrapped producers cannot run as-of: ML I7). Every flip is a `producer.fallback`/`producer.recovered` event, an `engine_fallback` row, and a line in the strip; it never degrades silently.

### 7.5 The hypothesis loop (HYPO-01a/b, deferred)
Wiring as before (surprise = −log p(outcome) under the served row at the outcome's decision time; specs compile to as-of queries over `engine_events` + `engine_event_entities`; `hypothesis.registered` precedes any test read; a survivor becomes a shadow version by PR; HYPO never writes a served field). **Start:** after the grader holds ≥ 6 graded weeks of the surprise streams (guess: week 10), because online FDR state (LORD++) over a handful of surprises is bookkeeping without power (ML S3).

### 7.6 Learners are versioned and prequential (ML I5)
The nightly weight learners (`blend-learner`, `jev-grader`) are producers whose **learning rule** (step size, forgetting factor, prior) is the version; a rule change is a shadow version graded like any other. Their weight rows are prequential by construction: a learner reads outcomes at its run's cut and writes the weight row after, so no weight is fit on an outcome that arrived later; a RED test pins it. Each update is bounded (a maximum step per night). The monitor grades the *blended output* against its fallback, so a weight drift that hurts is caught the same way as a model that hurts.

### 7.7 Holdout discipline, mechanical
D12 (reads in `script`/`test` roles refuse 2025 without a ledger row id), `training_window` per version and the overlap refusal in 6.3, window labels on every grade row, and the prereg-before-result event order. The `HOLDOUT-LEDGER.md` row count becomes a number the strip can show ("2025 looks: 14").

---

## 8. Jev in the loop (amends JEV-01a/b/c wiring; their facts and RED tests stand)

### 8.1 The snapshot Jev receives
`server/services/jev/state.js` builds the pack from **one snapshot** through the same view resolver pages use (2.12): per question type a declared `reads` list of (entity, field) rows — e.g. `p_accept` for a deal: `clone.p_accept`, `clone.price` for each player in the deal, `tells.card`, `activity.manager` for the counterparty, `range.week` and `proj.ros` for the players, `action_price` for the deal, `league.deadline`, counts of recent `trade.*` events for that league_team, and each row's reason chain. **Managers are pseudonymised** (the `jevStateFor` pattern named in ENGINE-SPECS JEV-01a; not re-verified on `29ac6bcf`); **players are named**, because a model that cannot see who the player is has no more information than the stats model and r17 predicts its weight goes to 0 (ML I11). Names of people never appear (RED 7). The pack's state ids become the answer row's `state_ids`, so lineage runs through Jev like any producer.

### 8.2 Questions, arms, outputs
The JEV-01a registry stands: `plays_sunday`, `role_change`, `p_accept`, `pitch_framing`, `startsit_tiebreak`, `sim_contradiction`, each with a schema version, ≥ 2 Jev phrasings plus the Claude cross-check arm (coordinator ruling 1). Every answer is a row `jev.<qtype>.<arm>` on the entity it is about, **lane `shadow` always** (raw answers are never served). `jev-grader` writes `jev_cal.<qtype>.<arm>` and `jev_weight.<qtype>`; **the arms are averaged into one calibrated logit per question type before stacking** (the phrasings and the cross-check are strongly correlated, so per-arm stacking weights would be unstable: ML I4), and the stack is one weight per question type on logits, ridge toward 0, prequential (7.6). **Weights are learned only where volume exists this season:** `plays_sunday`, `role_change`, `startsit_tiebreak`; `p_accept`, `pitch_framing` and `sim_contradiction` are logged, calibrated and shown as display-only until their cluster floors are met (ML I6). The blenders (`accept-blend` → `blend.p_accept`, `avail-blend` → `blend.p_play`, `startsit-blend`) write what pages show with the logit-space chain of 2.10, so "Jev moved it +0.06 (weight 0.4)" is arithmetic. Weight starts at 0 (ruling 3).

### 8.3 Spend, logged; no cap; runaway alert; exactly-once accounting
Every call appends **two** `jev.call` events: an intent row `{phase:'intent', prompt_hash, qtype, schema_version, models}` before the gateway call and a result row `{phase:'result', input_tokens, cost_usd, latency_ms, ai_usage_id, ok}` after, plus a row in `ai_usage` via `recordUsage` (`claude.js:90`) with feature `jev:<qtype>`; `PRICING` gains the gateway model (`llm-budget.js:37`); `reserveBudget` is skipped (no cap, Nick). An intent without a result at restart is a known unresolved call, retried once and reconciled against `ai_usage`, so a crash between the call and its event never re-issues a paid call blindly (systems I16). A gateway error is retried with exponential backoff per prompt hash (1, 2, 4 … min, capped at 6 h), never every tick; the retry count feeds the runaway alert. The `engine.jev` field `{balance, total_used, daily_spend, calls_today, runaway}` is written at daemon start, hourly (`getCredits()`) and after each call from `ai_usage`. Runaway (JEV-01a (7)): calls/hour > 5× the trailing-7-day hourly median, or one prompt hash > 3 times in 10 min or > 20 times in a day, or balance projected to reach 0 within 24 h → `jev.runaway` event + strip alert; **nothing is blocked**. Dedupe: the same prompt hash within the current snapshot is served from state.

### 8.4 Timing, grading and failure
Jev runs on `search.candidates` for a league (before `accept-blend` and `rank`: 3.4) as an async stage with a 60 s wall budget; a missing key writes `jev.status='no_key'` (typed, never a default probability); a gateway error writes the result event with `ok=0` and no state row; a weight of 0 makes every blend equal its incumbent byte-for-byte (RED tests in JEV-01c). **Grading is forward only:** an answer is graded only when its call time precedes the outcome's `as_of` and is within one tick of its pack's snapshot; replays of Jev over past games are never graded (Jev may know the result: ML I11).

---

## 9. Processes and performance

### 9.1 Three processes, one writer of engine tables

| process | role env | writes | never |
|---|---|---|---|
| web server (`run.sh`, `SCHEDULER_DISABLED=1`) | `web`, **set in code at the top of `server/index.js` before any import** | sessions, league sync, `trade_outcomes`, `rec_ledger` (as today), **`engine_requests` only** | runs a producer; `writeState`/`appendEvents` throw |
| engine daemon (`scripts/engine-daemon.mjs --loop 600`, **in the repo**) | `engine` | every engine table; nightly/weekly children run as `engine-child` and write nothing (they emit JSON) | calls ESPN or any fetcher (one fetcher per source stays in the refresh job) |
| refresh job (`refresh.sh` → `refresh-live-data.mjs --loop 900`) | `refresh` | the source tables it always wrote; gains `~/gridiron-local/refresh.lock` | imports `services/engine/*` |
| R&D scripts, tests | `script`, `test` | DB copies only (`.backup`) | `~/gridiron-local/data.sqlite` |

**Fail closed:** `writeState`/`appendEvents` refuse unless `GRIDIRON_PROCESS_ROLE` is explicitly `engine`, `script` or `test`; an unset role is refused (v1 threw only when the role was `web`, and the launcher, Docker and the installers set nothing: systems I19). **Supervision:** the daemon exists today only as `~/gridiron-local/engine.sh`; the repo's `Dockerfile:25` (`CMD ["node","server/index.js"]`), `fly.toml:35` (`min_machines_running = 1`), the installers and `scripts/launcher.mjs:124` (the launchd KeepAlive process, pid 65561 now, A13) start only the web server. `launcher.mjs` and a repo `scripts/start-all.mjs` supervise web, daemon and refresh as three OS processes with restart-on-exit; Docker's CMD becomes that script; on Fly the three run on one machine because the SQLite volume cannot be shared (a Fly change is a deploy: Nick, RULES §7). Until the daemon runs in an environment, migrated numbers there read `unknown` with the reason "engine daemon not running", never a stale recompute (systems I14). Locks: the daemon takes `~/gridiron-local/engine.lock` (O_EXCL; pid, start, host; stale-pid takeover) as ENGINE-00b-a (5); the refresh loop takes its own `refresh.lock` (two copies are running now, A13). Heartbeat: `recordSync('engine_daemon', …)` each tick, plus `engine_runs`.

### 9.2 The daemon loop
Set `SCHEDULER_DISABLED=1` before any server import (`refresh-live-data.mjs:40` pattern). Loop: wait for the earlier of the tick interval, a `sync_log` advance (polled every 60 s), or an `engine_requests` row (polled every 250 ms); serve requests between producer runs (a rescore is ≤ 150 ms from the current world); then the tick of 4.3; then hooks due (nightly/weekly) as **async** children with lease rows; SIGTERM finishes the current producer, releases the lock, exits 0 (RED 7 of ENGINE-00b-a). **Honest request budget:** ≤ 1.5 s while idle; while a producer is running, up to that producer's remaining budget (≤ 8 s in a world build, ≤ 20 s in the finder), because node:sqlite and the producers are synchronous on one thread. The page shows "pricing… engine busy" with the elapsed time. A worker thread for ticks is the upgrade if the measured p95 exceeds 5 s (systems I6; deferred).

### 9.3 SQLite: contention, WAL, growth, indexes, retention
- **Writers:** refresh (source tables), daemon (engine tables), web (its own tables). WAL (`db/index.js:24`) allows one writer at a time and unlimited readers; `busy_timeout` 15 s (`:25`) absorbs the refresh collectors' multi-second writes. The daemon keeps every write transaction short: `BEGIN IMMEDIATE`, ≤ 500 rows, ≤ 50 ms, and **computes outside transactions**; the sim's world build touches no transaction. Web reads never wait on writers.
- **Checkpoint starvation:** the daemon holds no long read transactions; `journal_size_limit` 64 MB (`:26`) and report-cache's TRUNCATE checkpoint stay.
- **Node 22 (CI):** `DatabaseSync.isTransaction` is absent (#216 tdd §6); the daemon's `withWriteTx` tracks depth in JS.
- **Growth (guesses until EA-00 measures bytes/row; a BENCHMARKS.md size row ratchets it):** events ≤ ~2.5k/day in season (lineups ~100-800, real line moves ≤ 544, injuries ~200, news ~50, transactions ~30, signals ~100, coverage ~100, outcomes ~2,000/week with 2 scoring keys, jev ~200) → ≤ 500k/season. State rows are real changes only, and the world is fixed within a week, so `range.week` rewrites are per moved player (a line move: ~10 players × 1 week × 2 scoring keys; an injury: 1 player × remaining weeks × 2) plus one full rewrite per week per scoring key (~300 × 15 × 2 = 9,000). Guess ≤ 10k rows/day. `search.trades` objects change on most rebuilds; if the measured bytes/row make them the dominant writer, a content-addressed `engine_blobs` table is a later additive migration (systems I7; deferred behind the measurement). The DB is 927 MB today (page_count 226,404 × 4,096), dominated by betting feature tables (dbstat: `nfl_team_feature_vectors` 192 MB); every migration writes a ~0.9 GB pre-migration backup, one more reason for a single 075.
- **Retention:** nothing is deleted (triggers). If a season must be archived, that is a new DB copy plus a migration that moves rows to a side file, and it needs Nick (RULES §7). No automatic VACUUM.
- **Indexes:** `engine_events(event_type, as_of)`, `(source, natural_key, id DESC)`, `(ingested_at)`, `(player_id, as_of)`, `(league_id, team_id, as_of)`; `engine_event_entities` PK `(entity_type, entity_id, event_id)` + `(event_id)`; `engine_state(entity_type, entity_id, field, league_id, lane, id DESC)`, `(producer, producer_version, id)`, `(run_id)`; `engine_runs(tick_id)`, `(producer, scope_key, finished_at)`; `engine_snapshots(league_id, id DESC)`.

### 9.4 Latency targets per page (served from state; today's path for contrast)

| surface | target (p95) | today (request-thread compute) |
|---|---|---|
| My team (twin, scout, lineup diff, ceiling) | ≤ 300 ms | `simulate?runs=1500` per league + `scout` + `lineup-diff` + `ceiling-lineup?trials=3000`, each a full `assetUniverse` build and/or simulation on the request thread; the 9/22 stall log shows first page load firing these for several leagues and the watchdog killing the process at 60 s (`loop-watchdog.js:128`) |
| Start/Sit | ≤ 300 ms | `lineup` × 3 objectives + waivers + posture + streams, each rebuilding from `assetUniverse` (cached per fingerprint, `trade-engine.js:300`) |
| League Hub command center | ≤ 300 ms | `command-center.js` with its own 10-min `CACHE_MS` (`:48`) and `leagueCurrentWeek` read (`:213`) (#186) |
| Trade Lab list (find) | ≤ 500 ms | 1.3-5 s per page (`trade-engine.js:190-197`) |
| Title tab | ≤ 300 ms | shortlist × ~7 s of paired sims cold (`title-odds-trades.js:36-39`) |
| TradeCard title impact | ≤ 100 ms, no click | 4-8 s POST per click (`routes/model.js:466`) |
| hand-built deal (evaluate/rescore via request) | ≤ 1.5 s idle; ≤ 20 s while the engine is busy, shown | seconds |
| Trade Brain | ≤ 300 ms | `managerProfiles` + `lineupSignals` per open |
| Coach | ≤ 5 s | LLM-bound (unchanged), numbers now from one snapshot |
| status strip | ≤ 100 ms | n/a |

### 9.5 RL-19-2 as the engine's primitive
RL-19-2 (#225: 0 diffs on 41 deals, median 4,336 → 89 ms with a shared world) splits `simulateSeason` into a world built once and a rescore of only the two changed lineups. In this design it is the `sim` producer's `rescore(world, overrides)` and it serves: `action_price` for the candidates (search world) and the top-k (eval world), chess leaf evaluation (CHESS-01-a's node budget becomes "≤ 600 rescores per league per minute"), the CE-09-a odds ladder rungs (do nothing / claim / trade / trade+claim on one world), the leave-one-out reason chains, and `engine_requests` for hand-built deals. Requirement on RL-19-2: the rescore must take a **world object** (pools + schedule + rules + seed) as its argument, not `lg`, so the daemon can hold the world across calls; and `rescore(world, overrides) ≡ simulateSeason(world, overrides)` is the RED test (ML B3d), not equality with today's `tradeImpact` once the projection basis changes.

### 9.6 CPU and memory on the 8-core Mac
Daemon: one core steady, two during world builds (Node is single-threaded; nightly/weekly refits run as children), ≤ 1 GB RSS (five league worlds ≈ 180 MB at POOL 2,000, plus eval worlds when built, 4.7 guess). Web: ≤ 300 MB, no compute. Refresh: unchanged. R&D loops elsewhere (RULES §4, load under ~20).

---

## 10. Migration off today's scattered producers

### 10.1 Every served number today (fantasy surfaces), its producer, and where it goes

Route lines are `server/routes/trades.js` unless another file is named; producer lines are on origin/main `29ac6bcf`.

| # | number (surface) | client call | route | producer today | target field (owner) | wave |
|---|---|---|---|---|---|---|
| 1 | title / playoff odds (My team twin; Model page) | `MyTeam.tsx:66` `/model/:id/simulate?runs=1500`; `Model.tsx:242` | `routes/model.js:450` | `simulateSeason` `season-sim.js:290`; projections = `buildProjections({through: SEASON−1})` `:304`; `world` drawn per call `:338`; process-lifetime `memo` `routes/model.js:120-124`, cleared only by `/model/sync` `:530` and league sync `routes/leagues.js:236-237` | `title.odds` (`sim`) | 1 |
| 2 | a trade's title impact (TradeCard button) | `TradeCard.tsx:186` `/model/:id/trade-impact` | `routes/model.js:466` | `tradeImpact` `season-sim.js:525`, `buildProjections` again `:548`, seed `tradeImpactSeed` `:504` (`lg.fetched_at`) | `action_price` (`sim`) | 1 |
| 3 | title-ranked deals (Trade Lab Title tab) | `TradeLab.tsx:265` `/trades/:id/title-trades?shortlist=6` | `:660` | `titleOddsTrades` `title-odds-trades.js:41`, cache key on `fetched_at` `:47`, `findTrades` `:50` + `tradeImpact` `:68` | `search.trades` + `action_price` | 1 |
| 4 | this week's points per player (`current_week_ppg`) | inside every roster read | — | `buildAssetUniverse` `trade-engine.js:308`: `buildPlayerWeekEngine` `:321` × coordinator × availability `:400`, served `:507`; consumers Start/Sit (`lineup-brain.js:357` × `vegasLift`), waivers, finder `adj_ppg` `:432/:506` | `proj.week` (model) → `blend.week` (dist) | 1 (inputs first, 10.3) |
| 5 | rest-of-season per player (`ros_ppg`) | idem | — | `buildRosProjections` `ros-projection.js:364` via `:333`, served `:406-407/:518` | `proj.ros` | 1 |
| 6 | chance to play (`active_probability`) | idem | — | `weeklyAvailability` `contingency.js:934`; defaults `?? 0.92` at `trade-engine.js:387`, `:3198` and `season-sim.js:359` | `avail.p_play` (prob + designation) | 1 |
| 7 | weekly floor / ceiling / boom / bust per player | trade cards, Start/Sit rows | — | `playerWeekDistribution` `player-week-engine.js:784` from `trade-engine.js:447-448`, seed hashed from its cache key `:795-797`; served `:493-497` | `range.week` (dist, from the world) | 1 |
| 8 | ceiling lineup (My team) | `MyTeam.tsx:456` `/trades/:id/ceiling-lineup?trials=3000` | `:643` | `ceilingLineup` `ceiling-lineup.js:185`: its own `sampleWeeks` `:109` and un-keyed `correlatedSampler` `:215` | `lineup.ceiling` (from the world) | 1 |
| 9 | current week (season, week) | everywhere | — | `tradeWeekContext` `trade-engine.js:180-184` vs `leagueCurrentWeek` `league-week.js:12` vs `simStartWeek` `season-sim.js:190` | `nfl.week` (`calendar`), `league.week` (`league`) | 1 |
| 10 | lineup weekly spread (a deal's floor/ceiling delta) | Trade Lab, scout | — | `lineupSpread` `trade-engine.js:926`, own `sampleWeeks` `:904` + copula | carried on `search.trades` from the world | 2 |
| 11 | finder deals (`/find`) | `TradeLab.tsx:429` | `:733` | `findTrades` `trade-engine.js:1783`; `counterpartyLayer` `:1855`, `readDeal` `:1932`, `acceptanceBand` `:2264`, `myPlayoffOdds` `:1631`, `vetoClimate` `:2184`, `selfRead` `:2186`; fingerprint cache `:1797` | `search.candidates` + `search.trades` | 2 |
| 12 | trade sequences | `TradeLab.tsx:613` | `:817` | `findTradeSequences` `:2314` | `search.paths` | 3 |
| 13 | offer / offer-many / player outlook | `TradeLab.tsx:649/:767/:651` | `:830/:841/:1022` | `offerFor` `:2490`, `offerForMany` `:2649`, `playerOutlook` `:2925` | `search.offers`; outlook = `proj.*` + `range.week` view | 2 |
| 14 | evaluate a hand-built deal | `TradeLab.tsx:1035` | `:858` | `evaluate` `:1227` + `lineupValueContext` `:1493` | `engine_requests` kind `evaluate` → `action_price` | 2 |
| 15 | sense-check (Claude second opinion) | `TradeCard.tsx:174` | `:1104` | `callClaude` on `playerEvidence` `:1043` + sim | writer reads the view; no sim on request | 3 |
| 16 | start/sit call | `Lineup.tsx:45` `/trades/:id/lineup?objective=` | `:223` | `lineupCall` `lineup-brain.js:419` (`assetUniverse` `:425`, `startSitWeekPoints` `:357` = `current_week_ppg × vegasLift`) | `lineup.call` | 2 |
| 17 | waiver board | `Lineup.tsx:50` | `:680` | `waiverBoard` `waiver-wire.js:147` | `waiver.board` | 2 |
| 18 | defense streams | `Lineup.tsx:53` | `:696` | `streamingBoard` `streaming-board.js:139` | `waiver.streams` | 2 |
| 19 | matchup posture / win probability | `Lineup.tsx:51` | `:714` | `lineupPosture` `lineup-posture.js:250`, `lineupMoments` `:153` (normal approximation: a fourth range producer) | `lineup.posture` (from the world) | 2 |
| 20 | lineup diff card | `MyTeam.tsx:61` | `:723` | `lineupDiff` `trade-engine.js:3115` | `lineup.diff` | 2 |
| 21 | self scout (weekly range, strengths, depth) | `MyTeam.tsx:59` `/trades/:id/scout` | `:101` | `selfScout` `:2782` (`lineupSpread`) | `team.scout` | 2 |
| 22 | manager profiles, receptiveness, lineup signals (Trade Brain) | `TradeBrain.tsx:49` | `:233` | `managerProfiles` `league-brain.js:126` + `lineupSignals` `lineup-signals.js:132`; `counterpartyLayer` `counterparty-pricing.js:279`; **under preview a second "checked out" number** (`activityPreview` `:284`, `checkedOutFactor` `:374/:548`; `run.sh` sets `GRIDIRON_PREVIEW_UNCONFIRMED=1`) beside #220's `activity.manager` | `clone.*`, `tells.card`, `activity.manager` (`replaces` retires the preview term) | 2 |
| 23 | P(accept) band | inside 11, 13 | — | `acceptanceBand` `trade-acceptance.js:142` | `clone.p_accept` → `blend.p_accept` | 2 |
| 24 | their price / deal read | inside 11, 22 | — | `playerValuation` `:674`, `readDeal` `:1016`, `valuationMap` `:1081` | `clone.price` | 2 |
| 25 | market value and trend, market premium, hype | asset `value/trend30`; `/trades/:id/market/:playerId` `:1047` | — | `dynasty_values` join in `buildAssetUniverse`; `marketForPlayer` `trade-market.js:109`; `playerHype` `hype.js:37` | `price.market` | 2 |
| 26 | league analysis (League Hub) | `Leagues.tsx:49` `/leagues/:id/analysis` | `routes/leagues.js:346` | `analyzeLeague` `routes/tradelab.js:99` → `vorBoard` `routes/edge.js:50`: `player_season_stats kind='projected'` (a **preseason season-total** basis, a third projection basis on the hub) | `proj.season` + `league.analysis` | 2 |
| 27 | command center (moves this week, dead starters, streams, injury alerts, no-move nudge) | League Hub (#186) | `/api/command-center` | `command-center.js`: own `CACHE_MS` 10 min `:48`, `MOVES_FRESH_MS` 24 h `:46` (withholds "0 moves" when collection is stale: the coverage idea, done once by hand), `leagueCurrentWeek` `:213` | `lineup.dead_starts`, `waiver.streams`, `avail.p_play`, `activity.manager` via one view | 2 |
| 28 | news edge | `TradeLab.tsx:182` | `:627` | `newsOpportunities` `news-lag-trader.js:113` | `radar.flags` | 3 |
| 29 | AI proposals | `ProposalSlate.tsx` (api) `/trades/:id/proposals` | `:764` | `proposalsFor` + `recordProposalSlate` `:805` (Claude) | writer reads the view; `offer.*` events | 3 |
| 30 | start/sit gate verdict | `StartSitGate.tsx:215` `/gates/start-sit` | `routes/gates.js:15` | `start_sit_gate` job → `gates/start-sit-gate.js` | `grade.lineup@v.lineup.call` (`grader`) | 3 |
| 31 | data freshness banner | `DataFreshnessBanner.tsx:100` | `routes/data-freshness.js` | `dataFreshness` `data-freshness.js:357` | stays; the strip adds `/api/engine/status` | 1 (UI-ENG-6) |
| 32 | Coach answers | `/coach/ask` `routes/coach.js:44` | — | tools `coach/tools.js:122-230`: `sql_select` over catalog tables (any number by SQL), `who_plays`, `team_tendencies`, `coaching_profile`, `football_context`, `source_trust` | `engine_read` tool over views; `sql_select` limited to fact tables | 2 |
| 33 | player card / detail facts, LLM analysis | `PlayerCard.tsx:74/:96`, `PlayerDetail.tsx:29` | `routes/players.js:41/:165` | game logs (facts), Claude | facts stay on raw routes (Data layer); analysis reads the view | 3 |
| 34 | pregame projection ledger | — | — | `weekly_prediction_snapshots` (2,379 rows) written by `weekly-learning.js:49` inside the refresh job's `nfl_weekly_learning` | redundant with `blend.week` rows in force at the cutoff; the job's retrain (`:224`) moves to the daemon's weekly hook when `blend.week` ships (EA-07) | 3 |
| 35 | draft surfaces | `DraftRoom/LiveDraft/DraftHub` | `routes/drafts.js`, `routes/edge.js:73` | draft engines | out of scope (season underway) | — |

### 10.2 Where numbers disagree across pages today, and why (the first targets)

| disagreement | cause (cited) | fixed by |
|---|---|---|
| **A.** Title tab vs finder (RL-17-3, Spearman 0.796) | the sim prices players with last season's `buildProjections` (`season-sim.js:304`, `:548`) while the finder uses `buildRosProjections` (`trade-engine.js:333`) | `sim@2` reads `proj.ros` from state (a versioned change with a PRE, 10.3); no second projection call exists |
| **B.** Title odds differ between the My team twin, the Title tab and the TradeCard button | three caches with three keys (`routes/model.js:120` process-lifetime; `title-odds-trades.js:47` `fetched_at`; `tradeImpact` uncached) and a fresh `world` per `simulateSeason` call (`season-sim.js:338`) | one `title.odds`/`action_price` per snapshot; one `world` per week (4.6-4.7) |
| **C.** Four weekly ranges for one player-week | `trade-engine.js:447` (seed from a cache key), `season-sim.js:363` (per-call world), `ceiling-lineup.js:109/:215` (unkeyed), `lineup-posture.js:153` (normal approximation) | `range.week` from the one world (4.7) |
| **D.** Three "current week"s | `trade-engine.js:180` vs `league-week.js:12` vs `season-sim.js:190`; drafts #57/#60/#64 fix callers one at a time | `nfl.week` + `league.week` fields (2.11) |
| **E.** Chance to play differs by caller | same function, different args (`through`, `espn`), plus `?? 0.92` substitutions at `trade-engine.js:387`, `:3198` and `season-sim.js:359`; and no live injury events at all until 3.1's `first_seen` rule (A8) | `avail.p_play` with typed absence; no default |
| **F.** Three player values | FantasyCalc `value` (finder), preseason VOR (`routes/edge.js:50`, League Hub), clone price (Trade Brain) | `price.market`, `proj.season`, `clone.price` as three named fields; pages label which |
| **G.** Three "this week" numbers | `current_week_ppg` (`:507`), `week_points` = × full `vegasLift` (`lineup-brain.js:357-365`), `adj_ppg` = 0.25/0.75 (`:432`) | `blend.week` is the one number; horizon blends are derived fields with their own names |
| **H.** Two "checked out" numbers under preview | `activity.manager` (#220) beside `checkedOutFactor` (`counterparty-pricing.js:374/:548`, on under `GRIDIRON_PREVIEW_UNCONFIRMED=1` via `:284`) | `replaces` on `activity.manager` + the ratchet (10.4) |

### 10.3 Order and mechanics

Waves (each shrinks the allowlist in 10.4):

- **Wave 0 (spine + runner):** EA-00 … EA-03 (section 12): the #216/#220 fixes in one migration, the daemon, snapshots/views/hook.
- **Wave 1, inputs first (systems I13):** `calendar`, `league`, `gamescript`, `availability`, `espn`, `projections` producers wrap today's code, run by the daemon with cutoffs (`buildPlayerWeekEngine`, `buildRosProjections`, `coordinateFantasy`, `weeklyAvailability`, `gameScriptFor`); **`buildAssetUniverse` (`trade-engine.js:308`) then reads `proj.week`, `proj.ros` and `avail.p_play` from state**, so every old consumer (finder, Start/Sit, waivers, TradeCard) shares one set of inputs at once, on the request thread for now, instead of one card showing numbers from different projections for weeks. Then `sim` (EA-06): first `sim@1`, a **byte-equal port** (old inputs, a fixed seed, `simulateSeason` unchanged) proven equal to today's numbers; then `sim@2` (state inputs, weekly seed, p_play once), a shadow version promoted on its PRE (walk-forward weekly matchup log loss and range coverage on 2023 and 2024). Pages: My team twin, TradeCard impact (UI-ENG-3), Title tab, ceiling lineup, range bar (UI-ENG-1), command center; the status strip (UI-ENG-6). Closing disagreements A-E and H changes numbers by definition, so the page test is "renders exactly its view's values on a fixture snapshot", and a one-off diff report attributes every changed number to a named cause (systems I12, ML I10).
- **Wave 2:** `search.candidates`/`search.trades`, `search.offers`, `lineup.call`, `lineup.posture`, `lineup.diff`, `team.scout`, `waiver.board`, `waiver.streams`, `clone.*`, `price.market`, `proj.season`/`league.analysis`; pages: Start/Sit, Trade Lab find/offer, Trade Brain, League Hub; Coach `engine_read`.
- **Wave 3:** `search.paths` (CHESS), `radar.flags`, proposals/sense-check writers on the view, `autopsy.*`, Jev blends served, gates as grades.

Moving one number = (1) wrap the existing function as a producer `run` that takes the cut and reads engine inputs through `ctx.read` (raw tables only for Data-layer facts, through adapters); (2) declare the field (`valueType`, `space`, `fallbackField`, `tolerance`, `checks`, `replaces`); (3) add it to a view; (4) switch the page to `useEngineView` with the fixture-snapshot render test; (5) make the old endpoint a thin reader of the field (or 410); (6) delete the producer import from the route: the allowlist shrinks.

### 10.4 The "no page recomputes" enforcement (ratchet)

1. **Static import test** `test/engine-no-recompute.test.js`: walks `server/routes/**` and `server/services/coach/**` with `scripts/wiring-map.mjs`'s ESM walker; any import of a producer module (`season-sim.js`, `projections.js`, `trade-engine.js`, `counterparty-pricing.js`, `trade-acceptance.js`, `waiver-wire.js`, `lineup-brain.js`, `ceiling-lineup.js`, `lineup-posture.js`, `contingency.js`, `player-week-engine.js`, `ros-projection.js`, `title-odds-trades.js`, `news-lag-trader.js`, `league-brain.js`, `week-postmortem.js`, `streaming-board.js`, `lineup-signals.js`, `command-center.js`, `gamescript.js`) must appear in `docs/wiring/engine-allowlist.json`. The test asserts the allowlist **only shrinks**, the same ratchet as BENCHMARKS.md. **Concepts, not only tables:** once a field with `replaces` is live, the test fails while any named legacy function is reachable from a route (systems M6).
2. **Runtime role guard:** fail-closed (9.1); the heavy entry points (`simulateSeason`, `tradeImpact`, `findTrades`, `buildAssetUniverse`, `lineupCall`, `waiverBoard`, `ceilingLineup`) call `assertRole(['engine','script','test'])` unless their route is still on the allowlist. A boot test runs the server as `web` and asserts migrated endpoints return view rows and never call a producer (mocked producer call count = 0, as COACH-01b RED 4).
3. **Client:** `client/src/engine/useEngineView.ts` is the only fetcher of engine numbers; the snapshot provider pins one id per page; a grep test forbids `useApi(`/`api(` inside `client/src/components/engine/**`; a render test mounts each migrated page on a fixture snapshot and asserts every displayed number is byte-equal to a fixture value after formatting (UI-RED 1, 4); a lint rule flags arithmetic on `.value` in engine components (approximate, documented).
4. **Coach:** `sql_select` refuses tables listed in `docs/wiring/engine-owned-tables.json` once their wave lands; `engine_read` (views) is the tool for numbers; `coach/verify.js` keeps refusing uncited numbers and gains HEALTH-01c's checks (a number cited without its health, or a degraded number used without saying so).

---
## 11. Audit of PR #216 (spine) and PR #220 (LIVING-01a) against this design

Both PRs are stacked (#220 contains #216's files), so #216 merges first. Line numbers are on the PR heads (#216 `9e8fc9d0`, #220 `e9299209`).

### 11.1 #216: what is right (keep)
- Append-only as a database property: four triggers, `075_engine_spine.js:62-69`.
- One writer per field by object identity, not label: `registry.js:55-77` (`registerField` hands the capability out once), `state.js:49-62` (`writeState` refuses anything else); the grep test pins one literal declaration per field and no exported writer.
- As-of safety in both readers (`events.js:102` refuses a read without `asOf`; `state.js:98-104`) and on citations (`state.js:72-82`: a row may not cite an event stamped after its own `as_of`).
- Idempotent adapters: deterministic `source_key` + `ON CONFLICT (source, source_key) DO NOTHING` (`events.js:74-78`); run 2 inserted 0 (#216 tdd §4).
- Privacy: forbidden payload keys at any depth (`events.js:16-21`, `:38-44`); the chat adapter copies counts and rates from `manager_signals` and never opens the chat DB (`backfill.js:158-165`).
- The reader route is GET-only, behind `legacyAuthenticated`, with league membership when scoped (`routes/engine.js:25`, `:42`; `server/index.js:158`), and names its absences (`:47-49`).
- A reason chain is required on every row and validated (`state.js:21-43`).
- Lineups never carry the game result (`backfill.js:12-13`); PENDING transactions are stamped at proposal time (`:68-72`).

### 11.2 #216: must change BEFORE merge (one PR on the #216 branch = EA-00; cheap now, expensive after 42,922 events and the first producer)

| # | change | where | why now |
|---|---|---|---|
| 1 | **One migration 075 with every engine table** (`engine_events`, `engine_event_entities`, `engine_state`, `engine_fields`, `engine_producers`, `engine_runs`, `engine_cursors`, `engine_fallback`, `engine_snapshots`, `engine_requests`); it aborts when `engine_state` exists without `lane`; `league_id NOT NULL DEFAULT 0` on both big tables | `075_engine_spine.js` | Two migrations = two ~0.9 GB backups; `CREATE TABLE IF NOT EXISTS` would silently keep a v1 shape (systems I11, M3, M9) |
| 2 | **`engine_state`: `lane` (NOT NULL DEFAULT 'live'), `health` JSON, `run_id`**; unique key `(entity_type, entity_id, field, league_id, lane, as_of, producer_version)`; **no `known_by`**; `getState` takes `{asOf, lane='live', version, maxId}`, orders by `id DESC`, and skips `health.status='failed'` rows | `075_engine_spine.js:43-58`; `state.js:49`, `:84-90`, `:98-104` | Today a shadow producer's rows would be served because the reader picks the newest row of any version (`:101-102`); the row id is the transaction clock (D1); changing a unique key later means rewriting every row |
| 3 | **`engine_fields` table + `BEFORE INSERT` trigger** on `engine_state` enforcing `producer`; the daemon upserts specs at startup; the web reads specs from the table; `routes/engine.js` stops importing `backfill.js` | `075`; `registry.js:22-24` (in-memory Maps stay as the second layer); `routes/engine.js:21` | The registry lives only in one process's memory, so `GET /api/engine/state?field=activity.manager` returns `field_not_registered` from the web (nothing under `server/` imports `activity-model.js`), and one-writer is enforced per process only (systems B1) |
| 4 | **`engine_events`: `provenance`, `as_of_quality`, `natural_key`, `schema_version`**; indexes `(source, natural_key, id DESC)`, `(ingested_at)`; the **as_of rules of 3.1**: status rows at `processed_at` else `first_seen_at`, never `proposed_at`; injuries with empty `modified_at` at capture time (`first_seen`); live captures clamped to `ingested_at` with `payload.source_as_of`; bare dates → end of day ET | `075:26-36`; `events.js:24-36`, `:46-63`; `backfill.js:44` (`firstTime`), `:71-72`, `:100`, `:124-125`, `:198` | All 58 `TRADE_DECLINE` rows have null `processed_at` and 30 share the proposal's `proposed_at`, so every decline is dated at the proposal and P(accept) grading is biased toward accepts (systems B8, A9); all 6,238 rows of 2025-26 injuries have no `modified_at`, so the season being played has no injury events (ML B2, A8); 159 news rows are stamped after ingest, up to 6.3 h (systems B9, A10) |
| 5 | **Compare-latest dedupe by natural key** (2.1) for lines, injuries, lineups and signals: append only when the payload hash differs from the latest event of the same `(source, natural_key)`; `source_key = natural_key:hash:prev_event_id` | `backfill.js:87`, `:113`, `:125`, `:162`; `events.js:71-95` | A key on `fetched_at` appends ~544 identical line events per hourly `nfl_lines` run (all 544 2026 rows share one `fetched_at`; `gamescript.js:156` rewrites it on score writes: A5); a history-wide hash key drops A → B → A (systems B7) |
| 6 | **`engine_event_entities`** with `role`, alias entities (`gsis:`, `espn:`, `sleeper:`) for unresolved ids, index `(event_id)`; adapters emit every party (both teams, every item's player) | new table in 075; `events.js:46-56`; `backfill.js:60-77`, `:123-128`, `:135-155` | `player_id` is set only when exactly one player is involved (`backfill.js:73`), so a per-entity reader misses every trade; 60% of injury events and 46% of transactions have no `players.id` and are lost forever if resolved only at the adapter (#216 tdd §4; systems I9) |
| 7 | **`getEvents`: `afterId`, a season/as-of window, `entities`, and it throws when a result hits its limit** (an explicit `allowTruncated` returns `truncated:true`); **`appendEvents` does not dispatch by default** (`onEvent` stays for tests) | `events.js:101-113`; `:93`; `registry.js:87-103` | It orders `as_of, id` with `LIMIT ≤ 10,000`, so a large result keeps the oldest rows and silently drops the current week (systems I17, ML M2); a throwing handler aborts delivery to the remaining handlers and later chunks (systems M11) |
| 8 | **Reason chain v2** (`space`, `baseline`, `residual`, `kind`, `state_ids`, `additive` check in the declared space) | `state.js:21-43`; 075 | The first blender needs additive chains in the right space; validating later would leave un-composable rows |
| 9 | **Field spec gains `valueType`, `space`, `maxAgeSec`, `tolerance`, `fallbackField`, `checks`, `replaces`**; `registerProducer` with `versions` and `training_window`; the route returns typed `status` (`ok`/`zero`/`unknown`/`stale`/`fallback`/`thin`/`degraded`) with reason, `health`, `fresh_at`; `league_id_required` for league-scoped entities without a league | `registry.js:55-72`; `routes/engine.js:47-58` | ENGINE-SPECS' cross-cutting rule and UI-RED 2: the reader must type absence or every page guesses; freshness from `as_of` misreads write-on-change (systems I3) |
| 10 | **Health checks in `writeState`** (HEALTH-01a): the check registry (2.4); a failed check writes the row with `health.status='failed'` and the reader never serves it; `inputs_health` set from `ctx.read` | `state.js:49-92`; new `server/services/engine/health.js` | Consistency without invariants serves garbage consistently; the schema is cheap now (systems I10; ENGINE-SPECS HEALTH-01a) |
| 11 | **Role guard, fail-closed**: writes only under `GRIDIRON_PROCESS_ROLE ∈ {engine, script, test}`; `server/index.js` sets `web` in code before any import; `scripts/engine-backfill.mjs` sets `script` | `state.js`, `events.js`; `server/index.js:1`; `scripts/engine-backfill.mjs` | D8: the web never holds a writer; a guard that is off unless `web` is set is off in the launcher, Docker and the installers (systems I19) |
| 12 | **Entity key grammar** enforced in `writeState` (2.11): league-scoped types carry `league_id` equal to the id prefix; `entity_type` must be registered; points-space fields use `player_week_scored` with `scoring_key` | `state.js:64-66` | Free-string keys are how a second "current week" creeps in; the 5 leagues already use 2 distinct scoring sets (A11) |
| 13 | **`manager.signal` adapter** (all `manager_signals` sources, counts only, scoring period in the natural key) and **`source.coverage` adapter** (from `sync_log`, per tick, compare-latest) | `backfill.js:157-165` (generalised); new adapter | #220 needs the signal; `manager_signals` has PK `(league_id, roster_id, metric)` and no week column, so weeks of "0 dead starts" collapse into one event without the period in the key (systems B7, A6); without coverage a collector gap reads as 0 adds (systems B6) |
| 14 | **`payload.model`** for model outputs in events (`trade.proposed`'s `model_p_accept*`), stripped for learners; **bytes/row measured** after the backfill and a `BENCHMARKS.md` size row added | `backfill.js:140-144`; `scripts/engine-backfill.mjs` | A learner must not use a model's own output as a feature (ML M4); growth estimates are guesses until measured (systems I7) |

### 11.3 #216: can follow in later PRs
The `/snapshot`, `/view`, `/status`, `/request` routes (EA-03); the `league.settings`, `market.player_value`, `outcome.*`, `rec.*`, `offer.sent` adapters (EA-04); `scripts/engine-lineage.mjs`, `scripts/engine-dag.mjs`, `scripts/engine-grade-report.mjs`, `scripts/check-promotion.mjs` (EA-02/EA-04); OpenLineage export (never, unless a consumer appears).

### 11.4 #220: what is right (keep)
- The method: an as-of filter (`filterSeason`, `activity-model.js:54`; test 1 proves week t's prediction ignores week t), null ≠ zero, EM fit on Sleeper 2021-22 with 2023 and 2024 graded separately and stress-tested (evidence doc), shrinkage to the population, and a checkout score that is a real probability.
- The spine discipline: the writer is module-private (`:280`, test 12), the producer reads events through `getEvents` with the cutoff (`:428`), re-runs are no-ops, the entity key is `league_team` `<league>:<team>` (`:449`), rates carry typed absence (`:353-361`), the reason chain names the state, the move per week and the shrinkage (`:381-403`), and no name reaches a row.
- The fit script refuses the live DB (`living01a-fit.mjs:47-50`), the guard this design generalises (5).

### 11.5 #220: must change BEFORE merge (= EA-01)

| # | change | where | why |
|---|---|---|---|
| 1 | **Read events only.** Dead starts come from `manager_signals` by direct SQL (`:430-433`) — an Understand producer reading a Collect table. Fix: EA-00's `manager.signal` adapter (period in the key); the producer reads `manager.signal` events through `ctx.read` | `:430-433` | Structure lens (Build rule in TRADE-INSANE-RND.md): a unit reads `engine_events`/`engine_state` only |
| 2 | **As-of dead starts.** The value for week t comes from the signal event for period t, never the latest row. **RED:** an as-of run at week t with a later dead start present gives `err=null` for week t | `:432`, `:441-443` | The query has no cutoff and pins "last week" relative to `computed_at` to week `through`: a point-in-time leak, not only a structure problem (ML I12) |
| 3 | **Coverage → null.** A week without a successful `source.coverage` for transactions reads `adds: null`. **RED:** a 4-day collector gap gives `adds = null` for that week, not 0 | `:442` (`act.collected ? (cell?.n ?? 0) : null`) | ESPN returns only the last ~3 days (`refresh-live-data.mjs:109-110`); once any event exists for the season a missed week reads as 0 adds and produces false "drifting" states (systems B6) |
| 4 | **Season window in SQL and no silent truncation**: `getEvents({leagueId, types, afterId or window: season, asOf})`; the `limit: 10000` call goes | `:428` | As seasons accumulate the current week's adds vanish at the limit (systems I17) |
| 5 | **Compute always; write lane shadow when not promoted.** Today the flag gates the write (`:421-422` returns `off` and writes nothing), so a default-off producer produces no rows to grade. With lanes, the registry decides `live` vs `shadow`; the preview switch affects display only | `:291-300`, `:421-422`; test "the producer is default-off and writes nothing" → "writes shadow rows and serves nothing" | RULES §3 flags gate *serving*; grading needs rows |
| 6 | **Declare the producer** (`registerProducer`: `VERSIONS.active = 'living01a-1'`, inputs `espn.transaction`, `manager.signal`, `source.coverage`, fields `league.week`, `league.rules`; scope `league_team`; schedule `tick`; `training_window` Sleeper 2021-22; checks `probs_sum_1`, `no_nan`; `replaces` the preview `checkedOutFactor` term) and take `season`, `through`, `weeksLeft` from `ctx` (caller-supplied by the fit script's `--live` until EA-02's `league` producer exists, marked as such) | `:280-284`, `:419-420` | Otherwise the daemon must compute the week itself: a second week producer |
| 7 | **Reason chain v2** fields: `space:'prob'`, `additive:false` with counterfactual contributions (posterior moves are not additive deltas), `kind:'event'` on the weekly contributions, `baseline` = the prior `pi` | `:381-403` | 2.10 |
| 8 | **Idempotency test on `(as_of, producer_version, lane)`**; `params_hash` of `FITTED_PARAMS` (`:260`) recorded in the version; the `activity.population` fallback field written by the same producer | `:449-451`; test ("`again.skipped === 3`") | 11.2 items 2 and 9 |

### 11.6 #220: can follow
`lineup.dead_starts` from `league.lineup` × `outcome.player_week` (EA-11b) replacing the signal path; `p_no_more_adds` from `league.rules` weeks; grades through the `grader` instead of the fit script; the `receptiveness` consumer in `counterparty-pricing.js:521` reading `activity.manager` from state (CLONE-01a's job).

---

## 12. Build units (launch order) and what they replace or amend

House format. Migration numbers: **075** = EA-00 (inside #216; unmerged, so the file is rewritten in place and holds every engine table); ENGINE-SPECS' 076/077/078 (PROJ-04-a, CE-09-b, CLONE-01b) stay as listed there, except CE-09-b's tables are not built (they are fields); recheck at PR time.

| ID | goal | metric / acceptance | files | deps | replaces / amends |
|---|---|---|---|---|---|
| **EA-00** spine v2 | Apply 11.2 items 1-14 to #216 in one PR on its branch | **RED:** (1) a `shadow` row is never returned by a default read and a `failed` row never; (2) a two-team, four-player trade is returned for every party through `engine_event_entities`, and a `gsis:` alias resolves after a mapping is added; (3) re-capturing an unchanged line appends 0 events, a moved line 1, and A → B → A appends 3; (4) a 2026 injury row with empty `modified_at` produces 1 event stamped `first_seen`; (5) a `TRADE_DECLINE` with null `processed_at` is stamped `first_seen_at`, not `proposed_at`; (6) a news row with `published_at > ingested_at` is clamped and keeps `source_as_of`; (7) a chain whose deltas do not sum in its space is refused when `additive`; (8) the route returns each of the seven statuses on a fixture, `league_id_required` included; (9) a write with the role unset or `web` throws; a write of a field by a second producer is refused by the trigger even from raw SQL; (10) `appendEvents` calls no handler by default; `getEvents` throws at its limit; (11) a probability of 1.3 writes a `failed` row and the reader serves the last good one; (12) `sync_log` advancing appends one `source.coverage` event; (13) bytes/row after the backfill is printed and recorded in BENCHMARKS.md. Not statistical | `server/migrations/075_engine_spine.js`, `server/services/engine/{events,state,registry,backfill,health,fields,role}.js`, `server/routes/engine.js`, `server/index.js:1`, `scripts/engine-backfill.mjs`, `test/engine-spine.test.js`, `BENCHMARKS.md` | none (#216 branch) | **amends ENGINE-00a (#216)**; folds **HEALTH-01a**; merge gate for #216 |
| **EA-01** LIVING-01a on spine v2 | Apply 11.5 items 1-8 to #220 | **RED:** `git grep manager_signals server/services/engine/activity-model.js` = 0; as-of dead-start test (`err=null` at week t with a later dead start present); coverage test (4-day gap → `adds=null`); with the flag off, shadow rows exist and a default read serves none; producer declaration present with `VERSIONS.active`; `(as_of, version, lane)` idempotency; `probs_sum_1` check passes on every row; the LIVING-01a PRE gates unchanged | `server/services/engine/activity-model.js`, `scripts/living01a-fit.mjs`, `test/living-01a.test.js` | EA-00 | **amends LIVING-01a (#220)**; merge gate for #220 |
| **EA-02** engine daemon | 9.1-9.2 + 4.3: `scripts/engine-daemon.mjs` in the repo, `engine.lock` + `refresh.lock` (a 5-line change in `refresh-live-data.mjs`), incremental adapters with cursors and coverage, whole-tick cheap producers, dirty bit per (heavy producer, league), write-on-change with tolerance, snapshot published per league on DAG completion, requests with lease/dedupe, heartbeat, SIGTERM, wake-on-sync, async nightly/weekly children with lease rows; the tiny `calendar`, `league` and `gamescript` producers; `launcher.mjs` + `scripts/start-all.mjs` supervise web, daemon, refresh; `scripts/engine-dag.mjs`, `scripts/engine-lineage.mjs` | **RED:** ENGINE-00b-a (1)-(7) as written, plus (8) the injury worked example (4.3) produces run rows for exactly the declared producers and publishes exactly two snapshots; (9) a declaration cycle refuses to start; (10) unchanged inputs write 0 rows and publish no new snapshot; (11) a failed producer leaves the league's previous snapshot serving and its dirty bit set; (12) a second refresh loop exits non-zero; (13) a child that hangs past its lease is killed and the tick continues; (14) grep: nothing under `server/index.js`/`server/routes/` imports `engine/daemon/`; (15) the launcher restarts a killed daemon. **Measured, not gated:** cheap-producer tick time on the local copy | `scripts/engine-daemon.mjs`, `scripts/start-all.mjs`, `scripts/launcher.mjs`, `scripts/refresh-live-data.mjs` (lock only), `server/services/engine/daemon/{tick,lock,cursors,dag,hooks,requests,snapshots}.js`, `server/services/engine/producers/{calendar,league,gamescript}.js`, tests | EA-00 | **replaces ENGINE-00b-a**; replaces ENGINE-00b-b (1)'s rollback script with 6.2-6.4 |
| **EA-03** snapshot + views + status + the client hook | `GET /api/engine/snapshot`, `/view`, `/status`, `/request/:id`; `views.js` (data); `client/src/engine/{useEngineView.ts,SnapshotProvider.tsx}`, `EngineValue.tsx`, `ReasonChain.tsx`, `EngineStatusStrip.tsx` (health chip included) | UI-ENG-6 RED as written, plus: two views at one snapshot id agree byte-for-byte on shared rows; a view at an older snapshot resolves that cut's versions and fallbacks; two views on one page use one snapshot id (mocked fetch: one `/snapshot` call); a `failed` field renders its fallback or "last good, N min old"; freshness comes from `engine_runs` (an unchanged row recomputed 5 min ago reads `ok`) | `server/routes/engine.js`, `server/services/engine/{views,status}.js`, the five client files, tests | EA-02 | **amends UI-ENG-6** (view-based hook; one snapshot per page; the strip ships here); folds **HEALTH-01b** |
| **EA-04** outcomes as events + the grader | Adapters `outcome.player_week` (per scoring key, `stat_version`), `league.matchup_result`, `league.settings`, `market.player_value`, `rec.*` (#174), `offer.sent`; `grader` producer with the 7.2 scorers, per-field decision times, cluster floors, decision-vs-luck (7.3), window labels; `scripts/engine-grade-report.mjs`, `scripts/check-promotion.mjs` | **RED:** a row written after its decision time is never graded; a version registered after the decision time is never graded; a stat correction re-grades the same prediction once (one grade per prediction × outcome entity); the quantile score on a fixture matches the pinball closed form; `gradeDecisions` reused unchanged; both lanes graded on the same outcomes; PIT on a calibrated fixture is uniform (KS p > 0.05); floors count clusters (30 player-weeks from one Sunday do not meet the floor). **PRE:** none (it grades; it ships nothing) | `server/services/engine/adapters/{outcomes,league,market,rec}.js`, `server/services/engine/producers/grader.js`, the two scripts, tests | EA-02; #174 for `rec.*` (ships without it) | **replaces JEV-01b (1)-(2) generality**; feeds PROJ-04-a, RADAR-01-b, SELF-01a/b, the start/sit gate |
| **EA-05** monitor + fallback | 7.4: the `monitor` producer, `engine_fallback`, the anytime-valid sequence, the system-wide false-flip budget | ENGINE-00b-b RED (2)-(5) as written (with the cluster floor), plus: checking the same feed nightly for 20 weeks under the null flips ≤ the budget in simulation; **PRE:** false-flip rate by simulation at the observed variance and cluster structure, committed before the rule goes live (replaces the 2024 null replay) | `server/services/engine/producers/monitor.js`, `server/services/engine/stats/confseq.js`, `docs/evidence/<date>/monitor-preregistration.md`, tests | EA-04, EA-07 (something to monitor) | **replaces ENGINE-00b-b (2)-(4)** |
| **EA-06** one world | `sim` producer: **`sim@1`** wraps `simulateSeason` byte-equal (old inputs, fixed seed); **`sim@2`** builds the world from state (`proj.week` model × `game.script`, `avail.p_play` once, `proj.ros`, `league.rules`, `league.week`, `nfl.week`), weekly `world`/`eval` seeds, `sim.world`, `range.week` (per scoring key), `title.odds`, `action_price` (search + eval) via `rescore(world, overrides)` (RL-19-2 as a world function), requests for hand-built deals, ceiling and posture from the same pools, leave-one-out chains | **Contract RED:** (a) `sim@1` equals today's `simulateSeason` output on a fixed seed to 1e-9; (b) `rescore(world, overrides) ≡ simulateSeason(world, overrides)` on RL-19-2's 41-deal fixture; (c) `range.week` p10/p90 equal the pool quantiles the title odds index (one-simulator contract, PROJ-03-c); (d) RL-6-3 null tests pass; (e) `random()` in `services/engine/**` only inside `withRandomSeed(keyedSeed(world, …))`; (f) rebuilding on unchanged inputs writes 0 rows; a one-player input change rewrites only that player's `range.week` rows; (g) the eval-seed delta of the search's top deal is reported beside the search delta; (h) world ≤ 8 s and rescore ≤ 150 ms on the local copy (measured, not gated). **PRE for `sim@2`** (RL-17-3's fix, promoted by PR): walk-forward weekly matchup win-probability log loss and `range.week` 80% coverage on 2023 and 2024 not worse than `sim@1`, and the sim per-player means vs `proj.ros` Spearman ≥ 0.95 (currently 0.796) | `server/services/engine/producers/sim.js`, `season-sim.js` (reads pools/world passed in; no projection call in `sim@2`), `correlation.js:212` (keys always), tests, `docs/evidence/<date>/sim-2-preregistration.md` | EA-03, EA-04, EA-07's input producers; RL-19-2 merged (#225) | **folds RL-19-2, RL-17-3, CE-09-a/b** (no `sim_state`/`action_price` tables, no `/odds-ladder` route: fields + views); **amends PROJ-03-c** (its serving site is `range.week`), **LIVING-01b** (uses `keyedSeed(world,'act',…)`), **CE-03** (`keyedSeed(world,'avail',…)`) |
| **EA-07** wave-1 inputs, then pages | `availability`, `espn`, `projections`, `weekly-blend` producers wrapping today's code (`contingency.js:934`, `player-week-engine.js:256`, `ros-projection.js:364`, `fantasy-coordinator.js:457`, `weekly-blend.js`) with the cut; **`buildAssetUniverse` (`trade-engine.js:308`) reads `proj.week`, `proj.ros`, `avail.p_play` from state**; the `nfl_weekly_learning` retrain moves to the weekly hook; views `my_team`, `start_sit`, `trade_lab`, `player`, `command_center`; pages switched (My team twin, TradeCard impact, Title tab, ceiling, range bar, command center); old endpoints become thin readers; the diff report | **RED:** each page renders exactly its view's values on a fixture snapshot; disagreements 10.2 A-E and H closed as tests (the twin, the Title tab and the card cite the same `title.odds`/`action_price` row ids; one `range.week` row per player-week-scoring across pages; one `league.week`; no `?? 0.92` reachable from a route); the finder, Start/Sit and the card read one `proj.week` row id per player; allowlist shrinks by the wave-1 entries; `docs/evidence/<date>/wave-1-diff-report.md` attributes every changed number to a cause. **PRE:** none for the wrapped producers (same code, one owner); `sim@2` carries its own (EA-06) | `server/services/engine/producers/{availability,espn,projections,weekly-blend}.js`, `trade-engine.js:308-520`, `server/services/engine/views.js`, `routes/model.js:450/:466`, `routes/trades.js:660/:643`, `routes/command-center` (#186), `TradeCard.tsx:183-196`, `TradeLab.tsx:262-301`, `MyTeam.tsx:58-67/:456`, tests | EA-03; EA-06 for the sim pages | **amends UI-ENG-1/-3** (serving), **PROJ-01-b/BLEND-02** (serve into `blend.week`; the tournament code is unchanged), **#186 command center** (reads a view) |
| **EA-08** Jev stage on snapshots | JEV-01a with the 8.1 pack builder over views (managers pseudonymised, players named), `jev.*` in lane shadow, intent/result `jev.call` events with backoff, `engine.jev` spend field, arms averaged per question type, blends as producers (JEV-01c), forward-only grading | JEV-01a RED (1)-(8) as written, plus: the pack's state ids equal the answer row's `state_ids`; an intent without a result at restart is reconciled once and never re-issued blindly (mocked gateway); a 5xx is retried with backoff, not every tick; a blend with weight 0 equals the incumbent byte-for-byte; an answer whose call time is after the outcome is never graded | `server/services/jev/{gateway,questions,state,stage}.js`, `server/services/engine/producers/{accept-blend,avail-blend,startsit-blend,jev-grader}.js`, `llm-budget.js:37`, tests (gateway mocked) | EA-03, EA-04 | **amends JEV-01a (3),(5),(7), JEV-01b (3) and JEV-01c** (blends are producers; no page computes a blend; weights only where volume exists) |
| **EA-09** the no-recompute ratchet | 10.4 (1)-(4): static import test, allowlist, `replaces` reachability, role guard, client fetcher test, Coach denylist | **RED:** adding a producer import to a route fails CI; the allowlist count only decreases; a `web`-role boot serves migrated views with 0 producer calls; a live field with `replaces` fails the test while the legacy function is reachable | `test/engine-no-recompute.test.js`, `docs/wiring/engine-allowlist.json`, `docs/wiring/engine-owned-tables.json`, `server/services/engine/role.js`, `scripts/wiring-map.mjs` (walker reuse) | EA-07 (first allowlist) | new; makes RULES §2 mechanical for this layer |
| **EA-10** Coach reads state | `engine_read` tool over views; `sql_select` refuses engine-owned tables; the writer cites state row ids; HEALTH-01c's verify checks | COACH-01b RED (1)-(5) as written, plus the denylist test and HEALTH-01c's RED (no digit from a failed row; degraded named; a tool error becomes a plain sentence, HTTP 200) | `coach/tools.js:122-230`, `coach/select.js`, `coach/verify.js`, `coach/ask.js`, tests | EA-03 | **amends COACH-01b** (tool reads views); folds **HEALTH-01c** |
| **EA-11a-d** wave-2 producers | a: `search` (`search.candidates`) + `rank` (`search.trades`, `search.offers`) split from `trade-engine.js:1783/:2490/:2649`; b: `lineup` + `waivers` (`lineup-brain.js:419`, `waiver-wire.js:147`, `streaming-board.js:139`, `lineup-posture.js:250`, `lineupDiff` `:3115`, `selfScout` `:2782`, `dead-starters.js:97`); c: `clone` + `market` (`counterparty-pricing.js:279/:674/:1016`, `trade-acceptance.js:142`, `trade-market.js:109`); d: `league.analysis`/`proj.season` (`routes/tradelab.js:99`, `routes/edge.js:50`) | per sub-unit: fixture-snapshot page test; allowlist shrinks; disagreements F-G closed as tests; (a) the card shows one P(accept), the `blend.p_accept` row | the named producer files wrapped, views, pages (Start/Sit, Trade Lab find/offer, Trade Brain, League Hub) | EA-07; c after CLONE-01a/b and TELLS-01b on `counterparty-pricing.js` (loop-3 lane) | **amends CLONE-01a/b, TELLS-01b, RADAR-01-a** (they write fields via `registerProducer`, lane shadow until their PRE passes, instead of a flag) |
| **EA-12** wave-3 | CHESS-01-a (`search.paths` via the rescore budget), RADAR-01 (`radar.flags`), PROJ-04-a (`autopsy.*` reading `proj.links` rows in force at the cutoff), HYPO-01a/b (after ≥ 6 graded weeks), gates as grades, proposals/sense-check writers on views, HEALTH-01d chaos drills, HEALTH-01e daily canary | their own rows' acceptance, plus: no route imports the producer; every number cited to a state row; the four chaos drills pass in CI | as in their rows | EA-11; the named rows | **amends CHESS-01-a, RADAR-01-a/b, PROJ-04-a, HYPO-01a/b, SELF-01a, HEALTH-01d/e** (events via adapters; fields via producers; no side routes) |

**Launch order:** EA-00 → EA-01 and EA-02 in parallel (both depend only on EA-00; disjoint files) → EA-03 → EA-04 → EA-07 (inputs) → EA-06 → EA-07 (pages) → EA-05 → EA-09 → EA-08 → EA-10 → EA-11a-d → EA-12. EA-02..EA-05 touch only new files and can run beside PROJ-01-a, TELLS-01a, CLONE-01a (disjoint lanes). Sizes (guesses): EA-00 2 days (the largest, because everything after it is cheap), EA-01 0.5, EA-02 2, EA-03 1, EA-04 1.5, EA-05 1, EA-06 2, EA-07 2.5, EA-08 1.5, EA-09 0.5, EA-10 1, EA-11 4 (four units), EA-12 as their rows.

---

## 13. Unconfirmed, and guesses

- Latency figures (world build ≤ 8 s, finder ≤ 20 s, view ≤ 50 ms, cheap-producer tick ≤ 30 s), growth (≤ 2.5k events/day, ≤ 10k state rows/day), memory (180-360 MB of pools) are guesses; RL-19-2's 77-145 ms and 4.2-8.3 s are quoted from WORK-QUEUE.md:934 and #225's summary, not re-run.
- "About one world build per league per hour in season" assumes lines move roughly hourly; measured in `engine_runs` once EA-02 runs.
- Whether `league_roster_snapshots.changed_at` moves only on a real change is unconfirmed (compare-latest makes it harmless: an unchanged payload appends nothing).
- `jevStateFor` at `manager-archetypes.js:1254` is cited from ENGINE-SPECS on `3c13f508`; not re-read on `29ac6bcf`.
- `vorBoard`'s basis was read from its query (`routes/edge.js:52-60`); which job fills `player_season_stats` was not traced.
- The Coach catalog's table list could not be extracted by grep; the "any number by SQL" claim rests on `sql_select` existing (`coach/tools.js:144-160`).
- Node 22 lacking `DatabaseSync.isTransaction` is #216's TDD claim (§6), not re-verified.
- Whether the mixture-martingale sequence's power at ~30 matchups/week is enough to promote a `title.odds` challenger within a season is unknown until EA-05's simulation; if not, the honest answer is "no promotion this season", not a looser test.
- The confirmed facts that v1 listed as guesses: the ESPN line writer does rewrite `game_lines.fetched_at` (`gamescript.js:156`) and all 544 2026 rows share one `fetched_at` (A5); the injury stream is empty for 2025-26 (A8); the decline stamps are proposal stamps (A9).

---

## 14. Sources and commands

**Web sources used for the state-of-the-art review** (read 2026-09-23; unchanged from v1):
- Event sourcing / CQRS, projections, idempotent handlers, snapshots, log growth: [Microsoft Azure Architecture Center — Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing); [System Design: Event Sourcing and CQRS](https://www.techinterview.org/post/3233465463/system-design-event-sourcing/); [CQRS + Event Sourcing in practice](https://hosseinnejati.medium.com/cqrs-event-sourcing-together-how-they-work-in-practice-a3e9193a0e54).
- Bitemporal data (valid vs transaction time): [XTDB — Bitemporality](https://v1-docs.xtdb.com/concepts/bitemporality/); [Jensen & Snodgrass, The TSQL2 Data Model](https://people.cs.aau.dk/~csj/Thesis/pdf/chapter12.pdf); [XTDB — The DIY Bitemporality Challenge](https://xtdb.com/blog/diy-bitemporality-challenge).
- Feature stores and point-in-time-correct joins: [Point-in-time correctness](https://theneuralbase.com/feature-store/learn/advanced/point-in-time-correctness/); [Solving training-serving skew with Feast](https://medium.com/@scoopnisker/solving-the-training-serving-skew-problem-with-feast-feature-store-3719b47e23a2); [Tecton vs Chronon](https://theneuralbase.com/data-pipeline-for-ml/learn/advanced/tecton-chronon/); [feature-store-point-in-time-joins](https://github.com/RaghavBanuni/feature-store-point-in-time-joins).
- Model registry, lineage, champion/challenger, gated promotion: [MLflow Model Registry](https://mlflow.org/docs/latest/ml/model-registry/); [Aliases: champion, challenger](https://theneuralbase.com/mlflow-advanced/learn/beginner/aliases-champion-challenger/); [Model lineage and reproducibility (OpenLineage/Marquez)](https://agility-at-scale.com/ai/governance/model-lineage-and-reproducibility/); [Model registry & promotion](https://datarekha.com/mlops/model-registry/).
- Incremental computation: [Adapton](http://matthewhammer.org/adapton/adapton-pldi2014.pdf); [When incremental computation beats recomputing everything](https://www.mrlatte.net/en/research/2026/08/25/incremental-computation-propagation/); [Incremental Live Programming via Shortcut Memoization](https://arxiv.org/html/2603.19560).
- Uncertainty propagation: [Beyond Point Estimates](https://arxiv.org/html/2501.16931); [IBM — Uncertainty quantification](https://www.ibm.com/think/topics/uncertainty-quantification); [A survey of probabilistic uncertainty propagation](https://www.osti.gov/servlets/purl/1412084).
- Common random numbers, paired comparisons: [Wikipedia — Variance reduction](https://en.wikipedia.org/wiki/Variance_reduction); [KSL — Variance Reduction Techniques](https://rossetti.github.io/KSLBook/ch9VRTs.html); [When Does Pairing Seeds Reduce Variance?](https://arxiv.org/pdf/2512.24145); [CRN in cost-effectiveness simulation](https://pmc.ncbi.nlm.nih.gov/articles/PMC3725537/).
- Shadow / champion-challenger deployment, rollback: [Model deployment strategies](https://dagshub.com/blog/model-deployment-types-strategies-and-best-practices/); [Deployment evaluation strategies in MLOps](https://medium.com/@fraidoonomarzai99/deployment-evaluation-strategies-in-mlops-c208585aa3bd); [MLflow — ML lifecycle management](https://mlflow.org/articles/ml-lifecycle-management-explained-for-engineers/).
- Calibration monitoring, drift, fallback: [MLflow — Why monitor model drift](https://mlflow.org/articles/why-monitor-model-drift-production/); [Production monitoring: drift, regression & alerting](https://dev.to/beefedai/production-monitoring-drift-regression-alerting-for-models-31fh); [A monitoring framework for deployed ML models](https://arxiv.org/pdf/2211.06239).
- LLM-in-the-loop grading: [LLMs-as-Judges survey](https://arxiv.org/pdf/2412.05579); [Calibrating LLM-as-judge](https://www.langchain.com/resources/llm-as-a-judge); [LLM-as-a-judge done right](https://www.kinde.com/learn/ai-for-software-engineering/best-practice/llm-as-a-judge-done-right-calibrating-guarding-debiasing-your-evaluators/).
- SQLite WAL, single writer, `BEGIN IMMEDIATE`: [SQLite concurrent writes and "database is locked"](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/); [Abusing SQLite to handle concurrency](https://blog.skypilot.co/abusing-sqlite-to-handle-concurrency/); [SQLite forum — multiple writers](https://sqlite.org/forum/info/b4e8b29ae409cd198652c6b7e70b53b702f269e67e1d2573d627feeba37bbf85).

**Commands behind the numbers (A-ids):**
- A1 `cd ~/gridiron-local/wt/handoff && git fetch origin && git log origin/main --oneline -3` → `29ac6bcf` (#215 study files only), `f403f734` (#186), `e1a85114`; `git diff --stat f403f734 29ac6bcf` → no server file cited here changed.
- A2 `gh pr view 216 --json headRefOid` → `9e8fc9d0`; `gh pr view 220 --json headRefOid` → `e9299209`; `gh pr diff 216 --name-only`, `gh pr diff 220 --name-only`; `git show 9e8fc9d0:<file>` / `git show e9299209:<file>` for every PR line cited.
- A3 `sqlite3 -readonly ~/gridiron-local/data.sqlite "SELECT count(*) FROM <t>"` → league_transactions_raw 1,615; league_roster_snapshots 2,310; news_items 1,574; game_lines 15,096; nfl_injuries 28,438; trade_outcomes 14; manager_signals 1,414; weekly_prediction_snapshots 2,379; players 8,640; model_experiments 0; weekly_ensemble_fits 2 (1 promoted). No `engine_*` table exists in the live DB (`SELECT name FROM sqlite_master WHERE name LIKE 'engine%'` → none).
- A4 `PRAGMA page_size; PRAGMA page_count;` → 4,096 × 226,404 (≈ 927 MB); dbstat top: nfl_team_feature_vectors 192 MB, nfl_player_week_features 99, nfl_blind_input_mutations 90.
- A5 `SELECT count(*), count(DISTINCT substr(fetched_at,1,16)) FROM game_lines WHERE season=2026` → 544 | 1; `git show origin/main:server/services/gamescript.js | grep -n fetched_at` → `:141` upsert, `:156` `fetched_at=datetime('now')` on score writes.
- A6 `.schema manager_signals` → PRIMARY KEY (league_id, roster_id, metric), no week column.
- A7 `SELECT feature, model, count(*), round(sum(cost_usd),3) FROM ai_usage GROUP BY 1,2` → negotiation_profile 35 calls $2.26; nfl-news-typed-extraction 47 calls $0.011; no Jev feature rows (the server never calls Jev).
- A8 `SELECT season, count(*), sum(modified_at IS NULL OR modified_at='') FROM nfl_injuries GROUP BY season` → 2021-24: 0 empty; 2025: 5,783/5,783; 2026: 455/455 (= #216's 6,238 `no_timestamp`). `.schema nfl_injuries` → no capture timestamp column at all (PK season, week, gsis_id).
- A9 `SELECT type, count(*), sum(processed_at IS NULL OR processed_at='') FROM league_transactions_raw GROUP BY type` → TRADE_DECLINE 58/58 null, TRADE_ACCEPT 29/17, TRADE_PROPOSAL 168/168, FREEAGENT 89/89, ROSTER 347/347, TRADE_UPHOLD 11/11, TRADE_VETO 7/7; declines' `first_seen_at` spans 2026-09-17T21:17 → 2026-09-23T18:16.
- A10 `SELECT count(*) FROM news_items WHERE published_at > ingested_at` → 159; midnight-truncated `published_at` (`T00/T04/T07:00:00`) → 342.
- A11 `SELECT count(DISTINCT json_extract(payload,'$.settings.scoringSettings.scoringItems')), count(DISTINCT json_extract(payload,'$.settings.rosterSettings.lineupSlotCounts')), count(*) FROM leagues` → 2 | 2 | 5.
- A12 `SELECT job, last_run_at, last_status, runs FROM sync_log ORDER BY last_run_at DESC` → league_transactions (478 runs, ok), roster_snapshots (102), manager_signals (61), nfl_injuries (25), nfl_lines (132), … (one row per job; `PRIMARY KEY job`).
- A13 `ps aux | grep -E "refresh-live-data|launcher.mjs"` → two refresh loops (pids 49407, 74430) and `launcher.mjs` (pid 65561) starting only `server/index.js` (`scripts/launcher.mjs:124`); `Dockerfile:25`, `fly.toml:35`.
- A14 #216 TDD §4 (local copy): 42,922 events after backfill, run 1 1,759 ms, run 2 inserted 0; injuries `no_timestamp` 6,238; player ids resolved: transactions 874/1,615, injuries 8,948/22,200.

---

## 15. Review log (every finding of the two adversarial reviews; accepted unless marked)

Systems review (S-) and ML review (M-). "→ §" names where the design changed.

| id | finding (short) | decision |
|---|---|---|
| S-B1 | field registry in one process's memory; web cannot read producer fields | accepted → §2.4, §4.5, 11.2 #3 (`engine_fields` table + trigger; web registers nothing) |
| S-B2 | latest-pointer table moved mid-tick breaks the one-snapshot guarantee | accepted, by removal → §2.7, §4.6 (snapshot = cut; no pointer table; publish per league on DAG completion) |
| S-B3 | seed from the snapshot id is unbuildable and defeats write-on-change | accepted → §0 rule 3, §4.7 (weekly seed). The league-scoped seed variant is **rejected**: one world across leagues keeps the same player's football identical everywhere (rule 3); scoring changes points, not draws |
| S-B4 | Decide stage has cycles; Jev cannot move a ranking; two P(accept)s on a card | accepted → §3.4 (four ordered fields; candidates carry state ids) |
| S-B5 | event-driven dirty sets never revisit a silent manager | accepted → §3.2, §4.3 (cheap producers run for every entity every tick; clock fields declared) |
| S-B6 | collection gaps become zeros | accepted → §3.1 coverage, 11.5 #3 (`source.coverage` events; unknown, not zero) |
| S-B7 | history-wide hash keys lose A→B→A; signals lack a week | accepted → §2.1 (compare-latest by natural key), 11.2 #5, #13 |
| S-B8 | backdated status events leak outcomes and bias P(accept) grading | accepted → §3.1 as_of rules, 11.2 #4 (`first_seen_at`, `as_of_quality`) |
| S-B9 | id cursors skip events whose valid time is ahead; clock skew throws | accepted → §3.1 (`as_of := min(source_as_of, ingested_at)`, `clamped`) |
| S-I1 | `known_by` has two definitions; replays would write the live table | accepted → D1, §2.3, §5 (no `known_by`; ids; replays on copies) |
| S-I2 | baseline lane contradicts one writer per field | accepted → D5, §4.5, §6.7 (`{live, shadow}` + `fallbackField`) |
| S-I3 | write-on-change makes healthy rows look stale | accepted → §2.6 (freshness from `engine_runs`) |
| S-I4 | a derived number can be stale relative to its inputs inside one snapshot | accepted → §2.7, §4.3 step 5 (publish only on DAG completion; skipped runs keep their dirty bit) |
| S-I5 | `spawnSync` children block the daemon loop | accepted → §3.2, §9.2 (async children with lease rows; the daemon writes their results) |
| S-I6 | ≤ 1.5 s request budget cannot be met while a tick runs | accepted in part → §9.2 (honest budget; lease + dedupe). The worker-thread + `SharedArrayBuffer` half is **rejected for now**: two threads sharing pools is real complexity with no measurement behind it; revisit if measured p95 > 5 s |
| S-I7 | growth and row-size estimates do not hold (4,500-id lineage lists) | accepted for lineage and measurement → §2.3 (`run_id` → input cut), §9.3 (bytes/row measured, size ratchet). The `engine_blobs` table is **deferred**: an additive migration later if the ratchet trips; adding it unmeasured is the over-engineering the review warns against |
| S-I8 | player keys have no scoring dimension | accepted → §2.11 (`player_week_scored`; 2 distinct scoring sets today, A11) |
| S-I9 | identity frozen at the adapter loses 60% of injury events forever | accepted → §2.2 (alias entities; resolution at read time) |
| S-I10 | HEALTH-01a missing | accepted → D15, §2.4 `checks`, §2.9 `health`, 11.2 #10 (folded into EA-00) |
| S-I11 | launch order unbuildable (EA-01 needs EA-02's registry and EA-08's producers) | accepted → §12 (one migration holds every table; `calendar`/`league`/`gamescript` in EA-02; EA-01 takes `through` from the caller until then) |
| S-I12 | "byte-equal vs the old endpoints at one snapshot" cannot be built | accepted → §10.3, EA-07 (fixture-snapshot render tests + a diff report; `sim@1` byte-equal port, `sim@2` versioned) |
| S-I13 | number-by-number migration leaves cards with mixed sources for weeks | accepted → §10.3 wave 1 (`buildAssetUniverse` reads state inputs first) |
| S-I14 | the daemon exists only on Nick's [redacted] | accepted → §9.1 (`engine-daemon.mjs` in the repo; supervisor; Docker/Fly; `unknown` with reason where no daemon runs) |
| S-I15 | the refresh job is itself a producer and a learner; two loops; lock | accepted → §6.1 (fit id in `params_hash`), EA-07 (retrain moves to the weekly hook), EA-02 (`refresh.lock`) |
| S-I16 | paid Jev calls are at-least-once with no backoff | accepted → §8.3 (intent/result events; backoff; reconciliation). The "daily same-hash **limit**" is **rejected** as a block: Nick's rule is no cap and no blocking; the count feeds the runaway alert instead |
| S-I17 | `getEvents` silently drops the newest events | accepted → 11.2 #7, 11.5 #4 (throw at the limit; `afterId`; season window) |
| S-I18 | scripts write engine tables from outside the daemon | accepted, by removal → D16, §6.2-6.4 (no promote/rollback scripts; `engine_fallback` written by the monitor only) |
| S-I19 | role guard permissive by default | accepted → D8, §9.1, 11.2 #11 (fail closed) |
| S-M1 | worked-example latency unrealistic | accepted → §3.1, §4.3 |
| S-M2 | date-only timestamps map to midnight UTC | accepted → §2.1 `date_only` (end of day ET) |
| S-M3 | missing `(event_id)` index; `COALESCE(league_id,-1)` defeats the index | accepted → §2.2, §2.3 (`league_id NOT NULL DEFAULT 0`) |
| S-M4 | latest-pointer key lacks the shadow version | moot: the pointer table is gone (S-B2); shadow versions are distinct by the unique key's `producer_version` |
| S-M5 | stat corrections double-count grades | accepted → §7.1 (`stat_version` in the key; one grade per prediction × outcome entity, re-graded) |
| S-M6 | §10.1 inventory stale (command center, preview activity term); one-writer guards tables not concepts | accepted → §10.1 rows 22, 27, §10.2 H, §10.4 (`replaces` reachability test) |
| S-M7 | two views on one page can resolve different snapshots | accepted → §2.12, §3.5 (one snapshot id per page via a provider) |
| S-M8 | `no_row_as_of` for a league-scoped entity without a league is misleading | accepted → §2.12 (`league_id_required`) |
| S-M9 | rewriting 075 in place is unsafe if a v1 DB applied it | accepted → §2 (075 aborts when `engine_state` lacks `lane`) |
| S-M10 | the layer diagram overstates "the next layer reads it" | accepted → §0 (fields form a dependency graph; layers are labels) |
| S-M11 | stale trade-engine line numbers; dispatch-loss reasoning slightly off | accepted → cites refreshed on `29ac6bcf` (+8 after :2175); 11.2 #7 wording |
| S-S1 | whole-tick recompute + league dirty bits instead of entity-grain tracking | accepted → D6, §4.3 |
| S-S2 | promotion is a PR, not a runtime status machine | accepted → D16, §6.2-6.4 |
| S-S3 | drop `known_by` from the unique key | accepted → §2.3 |
| M-B1 | knowledge time set too early; grades and promotions leak | accepted → D1, D9, §3.7 decision times, §7.2, §6.3 (4) |
| M-B2 | no injury stream for the live season (empty `modified_at`) | accepted → §3.1, 11.2 #4, EA-00 RED (4); confirmed A8 |
| M-B3 | the `dist` envelope cannot carry what the simulator needs; p_play double-counted; rescore test inconsistent | accepted for (a), (c), (d) → D4, §2.9 (`model`, conditional on playing), §3.3, §9.5. (b), the per-player persistent factor and `proj.ros` as a calibrated distribution, is **deferred**: it is new modelling with its own PRE (a `sim`/`projections` version), and this document builds no model; the contract (`model` params + keyed `talent` draws) makes it possible |
| M-I1 | a new seed per snapshot turns Monte Carlo noise into changes | accepted → §4.7 (weekly seed; tolerance = display precision within a world because the dice do not move; cross-world comparisons labelled, never differenced; chains by leave-one-out rescoring) |
| M-I2 | the search overstates its best deals (winner's curse) | accepted → §4.7, §3.4 (eval seed re-pricing; `title_delta_eval` shown and graded) |
| M-I3 | one snapshot can hold numbers that do not agree | accepted → §2.7, §4.6 (cut; publish per league on completion; requests outside views) |
| M-I4 | blender algebra contradicts itself; `espn.week` is a number blended into a dist; correlated Jev arms | accepted → §2.10 (logit space; counterfactual contributions; mean blend for `blend.week`; arms averaged) |
| M-I5 | online weight learners change served numbers without promotion | accepted → §7.6 (the rule is the version; prequential; bounded steps; the blend is monitored) |
| M-I6 | promotion and fallback floors unreachable this season | accepted → §7.2 (matchup win prob + quantile score for the sim; cluster floors; `p_accept` thin, no promotion lane; Jev weights only for volume types) |
| M-I7 | repeated checking inflates false flips; the 2024 null replay cannot be built | accepted → §7.4 (one anytime-valid sequence; system-wide budget; validation by simulation) |
| M-I8 | the Learn loop cannot separate decisions from luck | accepted → §7.3 |
| M-I9 | the holdout is enforced on the wrong side | accepted → D12, §5 rule 2, §2.5 `training_window`, §6.3 (4) |
| M-I10 | wave 1 unbuildable as written; median is the wrong point | accepted → D4 (mean served), §10.3 (byte-equal port, then a versioned change with a PRE) |
| M-I11 | Jev leakage on past games; pseudonymising players kills its information | accepted → §8.1, §8.4 |
| M-I12 | #220 reads `manager_signals` with no as-of cutoff | accepted → 11.5 #2, #3 (two RED tests) |
| M-S1 | row ids as knowledge time | accepted → D1 |
| M-S2 | coarser dirty tracking | accepted → D6 |
| M-S3 | defer HYPO and online FDR state | accepted → §7.5 (after ≥ 6 graded weeks) |
| M-M1 | date-only strings stamped too early | accepted → §2.1 (same as S-M2) |
| M-M2 | `getEvents` silently drops the newest events | accepted → 11.2 #7 (same as S-I17) |
| M-M3 | scoring key missing on player-week distributions | accepted → §2.11 (needed now: 2 distinct scoring sets, A11) |
| M-M4 | model outputs inside "facts only" events | accepted → §2.1, 11.2 #14 (`payload.model`, stripped for learners) |
| M-M5 | pre-register which outcome counts after stat corrections | accepted → §7.1 |
| M-M6 | "CRPS" from 11 quantiles is a pinball approximation | accepted → §7.2 (quantile score, explicit `p_zero` and tail bins) |
| M-M7 | fallback ownership ambiguous; simulator needs a missing-input policy | accepted for the policy → §3.3. "Each field's own producer writes all three lanes" is **rejected**: it contradicts one writer per field and S-I2; a fallback is a different field with its own owner |
