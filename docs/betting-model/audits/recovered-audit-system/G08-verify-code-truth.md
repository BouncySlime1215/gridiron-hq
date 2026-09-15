# G08 adversarial verification (lens = code-truth) — NOT REFUTED

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Date: 2026-09-12.
Files read in full: server/services/nfl-execution-pipeline.js (302 lines), server/services/nfl-decision-tape.js (574),
test/nfl-decision-identity-pipeline.test.js (237), server/betting/nfl/strategy/t60-runner.js (298),
server/migrations/034_t60_runner_ledger.js (105). Partial: server/services/scheduler.js:770-805,
server/routes/nfl-betting.js:1430-1450, server/routes/nfl-market.js:315-330.

## Claim 1: nfl-execution-pipeline.js:136 hard-codes dataIdentityStatus 'unfrozen_live_tables', data_hash NULL — ACCURATE
server/services/nfl-execution-pipeline.js:128-138
    const tape = recordDecisionRun(season, week, board, {
      observation: observationIdentity,
      policyId: policy.id, policyVersion: policy.version, decidedAt: decisionAt,
      computationStartedAt, computationEndedAt: decisionAt,
      // ... C11 replaces this with a real frozen packet hash.
      dataIdentityStatus: 'unfrozen_live_tables',
      note: `execution pipeline ${EXECUTION_PIPELINE_VERSION}`
    });
No dataHash key and no scheduleVersion key are passed at all. The tape's own guard at
server/services/nfl-decision-tape.js:377-378 would THROW if a dataHash were passed with this status
("only a frozen_packet run may carry a data hash"), so data_hash NULL is enforced, not incidental.
The code comment itself concedes it (line 133-135: "no artifact can reproduce exactly what it saw. C11 replaces this").

## Claim 2: nfl-decision-tape.js:361 scheduleVersion defaults null — ACCURATE
server/services/nfl-decision-tape.js:354-367
    export function recordDecisionRun(season, week, decisionBoard, {
      ...
      dataIdentityStatus = 'unfrozen_live_tables',   // :359
      dataHash = null,                                // :360
      scheduleVersion = null,                         // :361
The only production caller is the pipeline (:128), which omits scheduleVersion (see Claim 1), so the
default null is what reaches the INSERT at nfl-decision-tape.js:447 (`... dataHash, scheduleVersion,`).
Other recordDecisionRun callers: only test/nfl-decision-tape.test.js (grep). The route callers of
runExecutionPipeline (server/routes/nfl-market.js:323 `res.json(runExecutionPipeline(season, week))`) pass
neither an observation nor a schedule version.

## Claim 3: nfl_t60_observations.schedule_version NULL on the live row — ACCURATE (verified against live DB, read-only)
node:sqlite readOnly on server/data.sqlite:
  nfl_t60_observations (1 row): id bfa3e970-…, experiment nfl-spread-t60-prospective-v1, 2026 wk1,
    event nfl|2026-09-10|SF@LAR, schedule_version: null, state: frozen,
    packet_hash: e2bcd98ffa8c863488a37ce2ee8ac3c2bd1aa34cc48e861e8348f6ef772259f4, decision_run_id: null
  nfl_decision_runs: 0 rows (count 0, hashed null, sched null)
Cause of NULL: the scheduler job passes no scheduleVersion —
server/services/scheduler.js:795 `return m.runT60Pass({ season, week, experimentId: T60_EXPERIMENT_ID });`
and server/betting/nfl/strategy/t60-runner.js:245 `runT60Pass({ ..., scheduleVersion = null, ...})` → :69 openObservations
scheduleVersion = null → :92 INSERT writes `scheduleVersion` (null). Only the diagnostic GET route
(server/routes/nfl-betting.js:1444) ever forwards a schedule_version, and it does not persist anything.

## Claim 4: frozen packet never linked to a decision — ACCURATE
- t60-runner.js:127-129 UPDATEs the observation row to state='frozen' with packet_hash, and NEVER writes
  decision_run_id. grep for `decision_run_id` in server/ (excluding tape/pipeline/migrations) hits only the
  read-out at t60-runner.js:292. grep for `recordDecisionRun|nfl-decision-tape` in t60-runner.js and
  nfl-t60-packet.js: zero hits. nfl-t60-packet.js imports only db rows + nfl-t60-protocol (lines 39-40).
- Conversely the pipeline never reads a packet: nfl-execution-pipeline.js imports (lines 6-20) include no
  nfl-t60-packet / t60-runner / forecast-packet module; `board = autoPickDecisionBoard(season, week, policy)`
  (:99) reads live tables.
- Migration 034 says this by design: server/migrations/034_t60_runner_ledger.js:26-28 "The observation row is
  deliberately NOT the decision tape." The `decided` state and `decision_run_id` column exist in the schema
  (:46-49) but nothing transitions to `decided` or sets the column.
- The tape is READY to accept the link: nfl-decision-tape.js:374-375 validates a frozen_packet run must carry a
  64-hex packet hash, and DATA_IDENTITY_STATUSES (:94) includes 'frozen_packet'. The plumbing is simply never
  invoked with it from production code.
- Side note (not part of G08 but relevant to a future fix): t60-runner.js:141-143 defines its OWN
  `packetHash` = sha256(JSON.stringify(packet)) while server/betting/nfl/contracts/forecast-packet.js:193 exports a
  separate canonicalized `packetHash`. If the tape's data_hash is later set to the observation's packet_hash, the two
  hash definitions must be reconciled or the "packet_hash = data_hash" join will silently not match.

## Test evidence
test/nfl-decision-identity-pipeline.test.js:148-150
    // The data provenance is recorded honestly: this board read mutable tables.
    assert.equal(recorded.data_identity_status, 'unfrozen_live_tables');
    assert.equal(recorded.data_hash, null);
The test asserts the current (weak) state as correct — i.e. the suite would FAIL if someone wired the packet hash
in without updating it. Consistent with the gap.

## Docs corroborate (data, not instructions)
docs/CLAUDE-NEXT-STEPS.md:59 — "Every run records data_identity_status: unfrozen_live_tables — no decision is yet
reproducible from stored inputs. C11 closes that."
docs/evidence/2026-09-10/DECISION-RECORD.md:33 — "A decision is reproducible from its stored inputs | No".

## Refutation attempts that failed
1. "Maybe the T-60 runner records a tape run with frozen_packet" — no: zero imports of the tape from the runner/packet.
2. "Maybe the scheduler passes a schedule version" — no: scheduler.js:795 omits it.
3. "Maybe a different pipeline caller passes scheduleVersion/dataHash" — no: the only non-test caller is
   nfl-market.js:323 with two positional args.
4. "Maybe the live DB already has a linked row" — no: decision_run_id null, schedule_version null, 0 decision runs.

## Verdict
The CURRENT description is accurate at every cited path:line. SHOULD BE is not implemented anywhere. Not refuted.
Minor precision note: the pipeline does not literally pass `data_hash NULL`; it OMITS dataHash and the tape defaults
it to null (:360) — same observable result, and the tape would reject a non-null hash under this status anyway.
