# A03 — Decision tape and forward ledgers (read 2026-09-11)

Reader: A03-decision-tape-ledgers. Repo read-only. Every line of the 17 assigned files was read
(5,572 lines incl. the plan doc; 4,825 lines of assigned source/tests). DB inspected read-only via
`node:sqlite` on `server/data.sqlite` (11.2 GB, WAL 3.3 GB, live server writing).

Plan contract read first: `docs/CLAUDE-NEXT-STEPS.md` §3 (C01, C02, C03, C11, C12, C13, C14, C15),
§4.1 (frozen packet contract), §7.1–7.4 (T-60 operation, settlement, CLV), §9.2 (chronology/scoring).

## 0. Live-DB state (2026-09-11 22:36 local, read-only)

| Table | Rows | Note |
|---|---|---|
| `nfl_decision_runs` / `nfl_decision_events` / `nfl_decision_run_invalidations` | **0 / 0 / 0** | The append-only tape has never been written on the live DB. |
| `nfl_execution_opportunities` / `nfl_execution_lifecycle_events` | **0 / 0** | No opportunity, acceptance, settlement or correction has ever been recorded. |
| `forward_picks` | **0** | |
| `nfl_bet_log` | **0** | |
| `shadow_decisions` (NFL) | **189** (128 abstain, 61 observe; 14 settled) | The only ledger with 2026 rows. |
| `nfl_pick_decisions` (2026 wk1) | 16 rows, policy `nfl-spread-v1@1.1.0`, recorded `2026-09-12T02:16:33Z` | Mutable latest-view (UPSERT); this is where the scheduler's `nfl_decision_ledger` job wrote Week 1. |
| `nfl_t60_observations` | 1 row: `nfl|2026-09-10|SF@LAR`, state `frozen`, `schedule_version` NULL, cutoff `2026-09-10T23:35Z`, captured `23:37:32Z` | The only prospective T-60 packet. |
| `nfl_capacity_events` | 0 | |
| `sync_log.nfl_t60_runner` | 137 runs, last `ok`, `opened:0 captured:0 missed:0`; SEA–NE and LAR–SF `cutoff_already_passed`, 14 Sunday/Monday games `beyond_scheduling_horizon` | |
| `nfl_quote_tape` | 1,589,501 rows, 30 books, 2026 rows all `period='full_game'`, `snapshot_at` always millisecond ISO, `commence_time` mixed `Z`/`.000Z` | |
| `game_lines` 2026 | 544 rows, `closing_spread` set on 542, 4 scored | `source='espn'` single feed. |

Triggers present on the live DB: no_update/no_delete on `nfl_decision_events`,
`nfl_decision_run_invalidations`, `nfl_execution_lifecycle_events`; no_update + no_delete on
`nfl_decision_runs`. **None** on `forward_picks`, `shadow_decisions`, `nfl_bet_log`,
`nfl_execution_opportunities`.

Headline: as of tonight, **no 2026 decision is on the append-only tape**. The plan's identity/immutability
machinery (027/031, `nfl-decision-tape.js`) is implemented and well-tested, but the two production
writers for Week 1 bypass it: the scheduled `nfl_decision_ledger` job calls `persistPickDecisions`
(mutable UPSERT, `server/services/scheduler.js:697-703`) and the T-60 runner freezes a packet but never
records a decision (`server/betting/nfl/strategy/t60-runner.js:244-259` calls only
`openObservations`/`captureDueObservations`/`markMissedObservations`). The only caller of
`recordDecisionRun` is `runExecutionPipeline` (`nfl-execution-pipeline.js:128`), reachable from the
manual route `GET …` at `server/routes/nfl-market.js:323` with no observation, which the pipeline
labels `unscheduled-manual-invocation` / `unspecified_on_demand` (`nfl-execution-pipeline.js:119-126`).

## 1. server/services/nfl-decision-tape.js (574 lines)

**Purpose.** Append-only decision tape: one run header per declared observation, one event per
candidate (eligible or abstained). Content hash = board content + policy + horizon/cutoff + schedule
version + code identity + data identity status (lines 184-203). Observation key = experiment, horizon,
cutoff, job, observationId; `attempt` excluded (216-222). Run identity `board_hash = sha256(obsKey:content)`
(445).

**Flow.** `recordDecisionRun` → validate statuses (368-384) → `validateObservation` (238-255) →
`validateDecisionBoard` (266-329, incl. duplicate exact-contract refusal 318-326) → idempotency check by
`observation_key` with completeness verification (398-421) → `BEGIN IMMEDIATE`, header + children, `COMMIT`
(430-484). `invalidateDecisionRun` appends to `nfl_decision_run_invalidations` (500-512).
`findDecisionEvent` requires full contract and refuses ambiguity (559-574).

**Tables.** Writes `nfl_decision_runs`, `nfl_decision_events`, `nfl_decision_run_invalidations`. Reads same.

**Time semantics.** `decided_at` defaults to wall clock (363) and is NOT in the content hash (100-104,
deliberate). `cutoff_at`/`horizon` come from the observation and ARE in the content hash (186, 197). Quote
time `quote_at` is in the fingerprint (122). No check that `decidedAt <= cutoffAt` or that `quote_at <= cutoffAt`
— the tape trusts the caller's declared cutoff.

**Append-only / identity — verdict: YES at the schema and service level.** Header/children atomic
(430-484), UPDATE/DELETE triggers on both tables (027:118-126, 031:227-229), retry idempotent by observation
key, distinct observations with identical numbers coexist (test 247-258), one observation with two answers
refused (401-406). `code_hash` is a real closure hash (`server/platform/code-identity.js:118-169`,
not git-dependent, cached per process 166-169). Tests in `test/nfl-decision-tape.test.js` and
`test/nfl-decision-identity-pipeline.test.js` cover every C01/C02 close-with clause I could match.

**Reproducibility — verdict: NO, and honestly labelled.** `dataIdentityStatus` defaults to
`'unfrozen_live_tables'` (359) and the only production caller hard-codes it
(`nfl-execution-pipeline.js:136`). `feature_snapshot_json` (478) persists forecast OUTPUTS
(margins, model ids, calibration id), not the input rows. Nothing links a run to the one frozen packet in
`nfl_t60_observations.packet_hash`. So a recorded decision cannot be recomputed from stored inputs; it can
only be attributed to a code hash and a forecast-configuration hash (`nfl-forecast-identity.js:36-59`,
which by its own comment excludes fitted parameters and data).

**Defects.**

- D1 (P3) `nfl-decision-tape.js:184-203` — `content_hash` mixes observation fields (`horizon`, `cutoff_at`)
  into the "content" address, so `idx_decision_runs_content` cannot find "same numbers at a different cutoff";
  the content/observation separation the header claims (lines 32-38) is partial.
  ```js
  horizon, cutoff_at: cutoffAt, schedule_version: scheduleVersion,
  ```
- D2 (P2) `nfl-decision-tape.js:361` + `nfl-execution-pipeline.js:128-138` — `scheduleVersion` defaults to
  null and the only production caller never passes one; the T-60 observation row also has
  `schedule_version` NULL on the live DB. Plan §7.1 "Persist the schedule revision that established it" and
  §4.1 "schedule version" are unmet; a reschedule cannot be told apart in the hash.
  ```js
  scheduleVersion = null,
  ```
- D3 (P3) `nfl-decision-tape.js:398-421` — existence check runs outside the write transaction (430); a
  concurrent duplicate falls through to the raw UNIQUE error rather than the named idempotent/refusal path.
  Single-process app, so low severity.

## 2. server/migrations/027_decision_tape.js (370) and 031_decision_identity.js (261)

027 creates the tape tables and update triggers (71-127), adds `decision_event_id` to opportunities
(132-136), widens lifecycle vocab with terminal states, delegating the populated parent rebuild to
`server/db/preflight.js` (42-52, 139-154). `down()` refuses to narrow a populated execution ledger
(262-283) but then **unconditionally drops the whole decision tape** (359-369):
```js
DROP TABLE IF EXISTS nfl_decision_events;
...
DROP TABLE IF EXISTS nfl_decision_runs;
```
031 adds observation/identity columns (67-113), lifts and restores the no_update trigger for a backfill
(148-171), appends invalidations for count-mismatched legacy runs (197-208), adds the unique observation
index and the missing DELETE trigger (215-230). `down()` refuses when any non-legacy run or invalidation
exists (245-254) and leaves columns in place.

- D4 (P2) `027_decision_tape.js:359-369` — destructive downgrade of the tape. 031's guard only fires for
  runs with a real observation key or invalidations; a DB holding only `legacy:` runs rolls 031 back
  cleanly and 027 then drops every decision run/event (DROP TABLE bypasses the row triggers). C03: "Refuse a
  destructive downgrade."
- D5 (P3) `031_decision_identity.js:155` — backfill sets `cutoff_at = COALESCE(cutoff_at, decided_at)`
  while the comment above (117-119) says inventing a cutoff would be fabrication. Harmless today (0 legacy
  rows) but the two disagree.

## 3. server/migrations/023 (123) and 028 (134)

023: opportunities header + lifecycle events, `fill_confirmed CHECK(=0)` (83), partial unique index
excluding `refreshed` (92-94), append-only triggers (101-106). 028: rebuilds events to add
`settlement_correction`, excluded from the single-state index (56-58), refuses downgrade if any correction
exists (84-93). Both sound. 023 `down()` drops both ledger tables without a guard, but 027/028 `down()` run
first and refuse on a populated ledger, so the path is covered in practice.

## 4. server/services/nfl-execution-lifecycle.js (491)

**Purpose.** Event-sourced opportunity ledger: OFFERED→OBSERVED→DECISION→REFRESHED*→ACCEPTED→SETTLED→
SETTLEMENT_CORRECTION*, plus terminal PASSED/EXPIRED/CANCELLED (40-59, 83-103).

**Settlement separated from decision — YES.** Settlement is a separate appended event (320-352),
re-reads the ACCEPTED row for price/stake (332-346), carries a finality basis (67-71, 339-342). Correction
appends a delta event without touching the settled row (381-410); `netRealizedUnits` sums settled +
corrections (417-421). Status column on the header is a materialised cache updated in place (243) — by
design, documented in 023:17-20.

**Time semantics.** `occurredAt` is caller-supplied, must be a timestamp and monotone vs the previous
event (201, 205-208); no kickoff check inside the primitive (the pipeline's `settleExecutionOpportunities`
does it: `nfl-execution-pipeline.js:282-285`).

**Defects.**

- D6 (P2) `nfl-execution-lifecycle.js:470-476` — `lifecycleFunnel` computes wins/losses/`realized_pnl_units`
  from `state='settled'` rows only, ignoring `settlement_correction` deltas. Contradicts §7.3 "every UI/report
  uses net realized units after corrections" and the module's own `netRealizedUnits`. Served at
  `server/routes/nfl-market.js:352`.
  ```js
  JOIN nfl_execution_lifecycle_events e ON e.opportunity_id=o.id AND e.state='settled'
  ...
  const totalPnl = settled.reduce((sum, s) => sum + (s.realized_pnl_units ?? 0), 0);
  ```
- D7 (P3) `nfl-execution-lifecycle.js:443` — `listOpportunities` default `limit=200`, and the CLV/settlement
  callers pass 5000 (`nfl-execution-clv.js:232-234`, pipeline 257). §7.3 asks the hidden 5,000 truncation be
  removed (pagination or explicit coverage limit). Irrelevant at 0 rows; a latent silent-truncation.

## 5. server/services/nfl-execution-clv.js (354) + test (357)

**Purpose.** Read-only CLV projection over accepted/settled opportunities against the immutable
`nfl_quote_tape`. Declared grading version (48), declared book set (59, default = every book in tape),
period pinned to `full_game` (60, 128). `kickoffForEvent` resolves the instant from `game_lines` (78-86).

**Reference book and period — YES, declared.** Predicate: canonical event resolved via `teamCodeFor`
in JS (135-140), `market`, `period='full_game'`, `side_key`, `snapshot_at < kickoff` (124-132);
latest quote per book (147-152); main line = mode across books (160); price only at the exact accepted line
(164); quote IDs returned (175-176). Point CLV vs main line (285-286); price CLV in probability space
(268-271, 295) with the legacy raw-American field version-named (302-304). Economics keep their own
denominator (329-334). Tests cover simultaneous game, first-half, per-book latest, declared/excluded book,
grading version, unresolvable event, missing close, C14 sign.

**Time semantics.** "Close" = last `snapshot_at` strictly before the `game_lines` kickoff; `snapshot_at`
and `commence_time` compared as ISO strings (all 2026 `snapshot_at` carry millis; `commence_time` mixes
`Z`/`.000Z`, which sorts correctly against the bounds used). `commence_time` window is `[kickoff−8h, kickoff+1s)`
(131), while the comment says "one-second range" (118).

**Defects.**

- D8 (P2) `nfl-execution-clv.js:232-354` — nothing is persisted. C13 "Save closing quote IDs and a
  grading-version artifact" and §7.3 "Corrected or newly arrived closing evidence creates a new grading
  version" are not met: the report is recomputed on every GET (`routes/nfl-market.js:391`), so a later tape
  change silently changes past CLV with no version history. Idempotency is argued (351-353) but there is no
  artifact to reconcile against.
- D9 (P3) `nfl-execution-clv.js:59, 350` + `routes/nfl-market.js:391` — default declared reference is
  "all books present in tape", which includes the book the ticket was accepted at; the independent-reference
  exclusion (C13) is only reachable by passing `books`, which the route never does.
- D10 (P3) `nfl-execution-clv.js:118-131` — comment/code mismatch: the kickoff window is 8 hours wide,
  not one second. A same-teams rematch inside 8h is impossible in the NFL, so no wrong-game risk, but a game
  moved later by >8h loses its pre-move tape rows from the close.

## 6. server/services/nfl-clv.js (321)

Legacy per-bet CLV on `nfl_bet_log` graded from `nfl_line_snapshots` (a different table with no `period`
column). 0 rows. `closingConsensus` = all rows at the single latest `captured_at` before kickoff (97-103),
modal line, median raw American price (108-110) — the exact class of C13/C14 defects fixed in
`nfl-execution-clv.js`. Grading writes `graded_at` in place (248-250), no correction path. Still scheduled:
`scheduler.js:275-278` runs `gradeClosingLineValue()` after every `beat_the_close` snapshot, and
`routes/nfl-betting.js:930` exposes it.

- D11 (P3) `nfl-clv.js:97-110, 248-250` — a second, divergent CLV definition (single-instant consensus,
  raw-American median, mutable grade, no period) remains wired into the scheduler and routes alongside the
  C13/C14-corrected one. Harmless at 0 rows; a report consumer cannot tell which definition a number came from.

## 7. server/services/forward-ledger.js (335) + test (148)

**Purpose.** "Football-first" forward picks in `forward_picks`; refuses picks at/after kickoff (100-106);
UNIQUE (season, week, home, away, market, source) (`forward_picks_unique`).

**Flow.** `recordForwardPick` INSERT (110-117) → `settleForwardPicks` UPDATE in place with
`closing_line`, `result`, `clv_points`, `settled_at` (179-181), only for `result IS NULL` (137);
scheduled at `scheduler.js:224-226`.

**Time semantics / reference.** Close = `game_lines.closing_spread ?? spread` (154-156): the last ESPN
line written strictly before kickoff by `syncCurrentLines` (`gamescript.js:145-153`). Single unlabelled feed,
no book, no quote id, no price CLV (`price_at_pick` never used).

- D12 (P2) `forward-ledger.js:81, 99, 108-117` — `recordedAt` is caller-supplied and stored as
  `recorded_at`; the "timestamped before kickoff" guarantee is checked against that supplied clock (100-106),
  not the wall clock. No trigger protects the row. The current route only calls `recordThisWeek` (no
  `recordedAt`), so it is a latent hole, but the module's own claim "cannot be retrofitted" (18-21) is not
  enforced.
  ```js
  const now = recordedAt == null ? new Date() : new Date(recordedAt);
  ```
- D13 (P2) `forward-ledger.js:137, 179-181` — settlement is an in-place UPDATE on the decision row and
  runs only while `result IS NULL`; a later score correction never re-grades, and there is no append-only
  trigger on `forward_picks` (live DB: none). Settlement is not separated from decision and cannot be
  corrected without rewriting history.
- D14 (P3) `forward-ledger.js:154-156, 288-306` — CLV reference is one ESPN column with no book
  identity or quote id; the pick's line is the same column (306), so CLV measures ESPN-vs-ESPN drift, not a
  declared reference book.

## 8. server/services/shadow-ledger.js (122)

**Purpose.** Paper ledger: freezes both champion and challenger boards per game/market/model_version
(11-50); settles in place (57-105); summary (107-122). Called from the evidence daemon at every horizon
(`evidence-daemon.js:125`) and settled by `nfl-model-growth.js:169`. `validationFirewall().forward` counts
its `observe` rows as the project's forward evidence (`nfl-evidence.js:114-123`).

**Defects — this is the only ledger holding 2026 rows, and it has the weakest guarantees.**

- D15 (P1) `shadow-ledger.js:11-44` — no kickoff guard. `recordNflShadowBoard` inserts for every board
  decision whenever `(event_key, market, model_version)` is new; a policy-version bump creates a new
  `model_version` string (24) and re-records already-final games. Live DB: rows 200 and 216 for
  `2026:1:SEA:NE` (policy `1.2.0`) were captured `2026-09-10T23:36:01Z`, ~23h after the `2026-09-10T00:20Z`
  kickoff and after the 13-10 final, then settled `Push`, `clv 0` with `line_at_prediction == closing_line`.
  Compare `forward-ledger.js:100-106`, which refuses exactly this.
  ```js
  const exists = row(`SELECT id FROM shadow_decisions
    WHERE sport='NFL' AND event_key=? AND market=? AND model_version=? LIMIT 1`, ...);
  if (exists) { alreadyFrozen++; modeFrozen++; continue; }
  run(`INSERT INTO shadow_decisions ...
  ```
- D16 (P2) `shadow-ledger.js:71-72, 83, 90` — closing reference is the live `game_lines.spread`/`total`,
  not the frozen `closing_spread`/`closing_total` that `forward-ledger.js:154-156` deliberately prefers
  because ESPN's live odds object can overwrite `spread` with an in-game number after kickoff
  (`forward-ledger.js:149-153`). Two ledgers, two closes for the same game.
- D17 (P2) `shadow-ledger.js:99-100` — settlement is an in-place UPDATE; no trigger; no correction path;
  `settled_at IS NULL` filter (59) means a score correction is never applied.
- D18 (P3) `shadow-ledger.js:28-31` — first capture wins per model_version, so a game whose board moves
  from abstain to eligible later in the week is never re-recorded; the ledger is "first look", not T-60.

## 9. server/services/nfl-execution-attribution.js (205)

Pure functions except `threeWayAttribution`. Decomposition identity is exact by construction (166-204).

- D19 (P2) `nfl-execution-attribution.js:116, 127-128` — `realized_result` reads the single `settled` event's
  `realized_pnl_units`, ignoring `settlement_correction`; same class as D6.
  ```js
  const settled = opportunity.events.find(e => e.state === 'settled');
  ...
  ? { result: settled.result, realized_pnl_units: settled.realized_pnl_units }
  ```

## 10. server/services/nfl-forecast-identity.js (67) and nfl-contract-key.js (243)

Forecast identity = sha256 of a configuration descriptor (fit version, regime, blend, weighting, families,
challengers, neural/reliability versions, devig method) (45-58); explicitly "not yet a frozen T−60 packet or
a hash of each historical dataset / learned parameter" (3-5). Contract key = Eastern game date + canonical
abbrs + market + period + participant + side + half-point line + OT rule + settlement (128-204); fails closed
with typed reasons. Both fine for their stated scope; the consequence for the tape is that `forecast_identity`
cannot distinguish two fits of the same configuration on different data (reproducibility gap, documented).

## 11. Tests read

- `test/nfl-decision-tape.test.js` (483): E6 four criteria + every C01/C02 clause (field-by-field hash
  mutation 167-213, retry idempotency 215-228, two horizons 230-245, ambiguous lines 269-284, rollback on
  second child 323-346, restart 348-369, schema-level duplicate 371-382, empty/populated delete rejection
  384-403, count reconciliation 405-421, invalidation append 423-437, unavailable stays in denominator 439-451).
- `test/nfl-decision-identity-pipeline.test.js` (237): real pipeline with mocked board; confirms
  `data_identity_status='unfrozen_live_tables'`, `data_hash=null` (149-150) and that an undeclared caller
  gets `unspecified_on_demand` (226-237).
- `test/nfl-execution-clv.test.js` (357): E9 + C13/C14 clauses as listed in §5.
- `test/forward-ledger.test.js` (148): kickoff lock, fabricated inputs, spread CLV sign, shadow settlement
  labels; does NOT test post-kickoff shadow capture (D15) or shadow's use of live `spread` (D16).

## 12. Answers to the assigned questions

1. **Append-only with identity?** For `nfl_decision_runs/events`: yes — content hash of the board +
   policy + horizon/cutoff + code closure hash + data-identity status, observation key separate, atomic
   writes, UPDATE/DELETE triggers. But the live tape has **0 rows**; Week 1 decisions went to the mutable
   `nfl_pick_decisions` via the scheduled job, and the T-60 runner never records a decision. `forward_picks`
   and `shadow_decisions` are append-only by convention only (no triggers; UPDATE settlement; caller-supplied
   `recorded_at` in forward).
2. **Settlement separated from decision?** Lifecycle ledger: yes (separate appended event, finality basis,
   delta corrections). Forward/shadow/bet_log: no (UPDATE on the decision row).
3. **CLV against a declared reference book and right period?** `nfl-execution-clv.js`: yes — declared
   book set (default all books incl. our own), `full_game`, per-book latest before the schedule kickoff, quote
   IDs and grading version in the output, but not persisted. Forward/shadow: one unlabelled ESPN column,
   and shadow uses the live (post-kickoff-mutable) column. `nfl-clv.js`: single-instant consensus, no period.
4. **Correction without rewriting history?** Lifecycle: yes (`settlement_correction`, 028 refuses a
   downgrade that would drop them) — but `lifecycleFunnel` and `threeWayAttribution` still read the
   uncorrected settled row. Forward/shadow/bet_log: no.
5. **Reproducible from stored inputs?** No. Every run would carry `data_identity_status='unfrozen_live_tables'`
   and `data_hash=NULL` (pipeline hard-codes it); the tape stores forecast outputs, code manifest and
   configuration hash, not the input rows; the one frozen T-60 packet is not linked to any decision.

## 13. Point-in-time guarantees actually held today

- Tape rows (when written) cannot be updated or deleted at the schema level; retry is idempotent by
  observation; a changed answer for the same observation is refused.
- Lifecycle events cannot be updated or deleted; `fill_confirmed` cannot be 1; settlement re-reads the
  accepted price/stake; corrections are deltas.
- `forward_picks` refuses a pick at/after kickoff (against the supplied clock) and one pick per game/source.
- `nfl_quote_tape` is the sole CLV source for accepted tickets and the close is the last snapshot strictly
  before the schedule kickoff, one per book.
- A run declared `unavailable` is stored with zero events and cannot be deleted (denominator retained) —
  but no production code records one; the T-60 runner's `missed` only covers rows it had already opened
  (`t60-runner.js:157-168`), so SEA–NE (cutoff passed before the first pass) is absent from every ledger.
