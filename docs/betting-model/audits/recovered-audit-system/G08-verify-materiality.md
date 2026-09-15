# G08 adversarial verification (lens = materiality) — REFUTED AS STATED (downgrade + reword)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Date: 2026-09-12.
Question: would closing G08 change a number Nick reads, a decision, or the validity of the historical/forward record?

Files read in full: server/services/nfl-execution-pipeline.js (302), server/services/nfl-decision-tape.js (574),
test/nfl-decision-identity-pipeline.test.js (237), server/betting/nfl/strategy/t60-runner.js (298),
server/services/nfl-t60-packet.js (459), server/migrations/034_t60_runner_ledger.js (105).
Partial: server/services/nfl-t60-protocol.js:1-80, server/services/scheduler.js:760-830, server/routes/nfl-market.js:300-335,
server/routes/nfl-betting.js:1400-1500, server/betting/nfl/contracts/forecast-packet.js:185-227,
client/src/pages/betting/NflExecutionDesk.tsx:115-155, docs/CLAUDE-NEXT-STEPS.md:55-62, docs/evidence/2026-09-10/DECISION-RECORD.md:28-36.
Prior code-truth note (G08-verify-code-truth.md) accepted: every CURRENT path:line is accurate. This note does not re-litigate that.

## Live DB state (node:sqlite readOnly, server/data.sqlite)
- nfl_decision_runs: 0 rows. nfl_decision_events: implied 0. nfl_execution_opportunities: 0 rows. nfl_capacity_events: 0 rows.
- nfl_t60_observations: 1 row — nfl|2026-09-10|SF@LAR, state frozen, packet_hash e2bcd98f…, decision_run_id NULL, schedule_version NULL.
- nfl_pick_decisions 2026 wk1: 16 rows, policy nfl-spread-v1, eligible = 0.
So the forward record contains ZERO decisions that a packet could be linked to. Closing G08 today would change 0 rows.

## Test 1 — does any number Nick reads depend on data_hash / data_identity_status / schedule_version / decision_run_id?  NO
- grep client/src for `data_identity_status|schedule_version|decision_run|packet_hash|t60`: zero hits (the only content_hash/data_hash hits are
  FantasyLab dataset registry and ResearchLab/Training research runs — unrelated tables).
- The one UI that touches the pipeline, client/src/pages/betting/NflExecutionDesk.tsx:125 types the result as
  `{ candidates_selected: number; results: unknown[] }` and renders only :153
  `{runResult.candidates_selected} policy-selected candidate…`. `decision_run` (returned at nfl-execution-pipeline.js:297) is never read.
- Server-side readers of nfl_decision_runs / nfl_decision_events outside the tape module: none (grep; only server/db/preflight.js:80 comment).
- `t60Coverage` (t60-runner.js:264) has NO route or client caller (grep server/routes for t60: only the GET /t60/packet diagnostic at nfl-betting.js:1434).
  And even if it were surfaced, its headline number is unaffected: t60-runner.js:282-283
  `captured_rate: … ((byState.frozen ?? 0) + (byState.decided ?? 0)) / scheduled.length` — a row moving frozen→decided changes nothing.

## Test 2 — would it change a decision?  NO
- The board is computed BEFORE and INDEPENDENT of the tape: nfl-execution-pipeline.js:99 `const board = autoPickDecisionBoard(season, week, policy);`
  then :128 `recordDecisionRun(season, week, board, {...})`. dataIdentityStatus/dataHash/scheduleVersion enter only
  `contentHash` (nfl-decision-tape.js:184-201: `schedule_version: scheduleVersion, … data_identity_status: dataIdentityStatus, data_hash: dataHash`)
  — i.e. run IDENTITY/dedup — and the INSERT columns (:435,:447). They are never read back into selection, opening, accept/pass or settlement.
- nfl-auto-picks.js has zero references to packet/T60/cutoff (grep). The pipeline imports no packet module (nfl-execution-pipeline.js:6-20).
- scheduleVersion is a pass-through label, not an input to any computation: nfl-t60-protocol.js:40-49
  `cutoff_at: new Date(at - leadMinutes * 60000).toISOString(), … schedule_version: scheduleVersion,`.
  The cutoff itself is reproducible from the row's own stored kickoff_at + cutoff_at (t60-runner.js:88-92), and observation identity is
  UNIQUE(experiment_id, event_key, cutoff_at) (034_t60_runner_ledger.js:57) — a reschedule already yields a new row without schedule_version.

## Test 3 — would it change the validity of the historical/forward record?  NO — and the SHOULD-BE as written would make it WORSE
- Historical (2021–2025) record: untouched by construction. DECISION-RECORD.md:35 "The 2021–2025 record is preserved unchanged: 153 spread bets, −11.85 units".
  nfl_decision_runs has 0 rows, so no historical run carries the field at all.
- Forward record: the tape currently tells the truth. 'unfrozen_live_tables' is an accurate description of what the board read
  (nfl-execution-pipeline.js:132-135 comment; nfl-decision-tape.js:88-93 doc). Nick has already been told this in plain words:
  CLAUDE-NEXT-STEPS.md:59 "no decision is yet reproducible from stored inputs. C11 closes that." and DECISION-RECORD.md:33
  "A decision is reproducible from its stored inputs | No | … The packet exists and is correct; no forecast consumes it yet."
- The SHOULD-BE ("tape run carries data_hash = packet_hash, data_identity_status 'frozen_packet'") would, if implemented literally, stamp a
  board computed from live tables as a frozen-packet decision. The tape's own guard (nfl-decision-tape.js:374-378) only checks the hash SHAPE
  (HEX64), not that the board consumed the packet. That is a false provenance claim — strictly less valid than today's honest label — because:
  (a) the forecast does not consume the packet (DECISION-RECORD.md:33; grep above), and
  (b) the packet does not contain the model's inputs anyway. nfl-t60-packet.js:222-231 freezes quote rows; :234-296 record only COUNTS and clocks
      for injuries/news/weather/team-week features (`rows`, `rows_now`, `received_at`) — no ratings, weights, or feature values.
      Even a true link gives "which quotes were received by cutoff", not reproducibility of the forecast.
- Additionally the two `packetHash` definitions differ (t60-runner.js:141-143 sha256(JSON.stringify(packet)) vs
  forecast-packet.js:193-197 canonicalized with `attempt` stripped), so a naive data_hash = packet_hash join would not even match the sealed contract hash.

## Test 4 — is there any path today by which a decision run would be written at all?
- Scheduler runs only the freeze: scheduler.js:795 `return m.runT60Pass({ season, week, experimentId: T60_EXPERIMENT_ID });`
  runT60Pass (t60-runner.js:245-259) opens/captures/marks and never imports the tape.
- The only tape writer is manual: nfl-market.js:323 `res.json(runExecutionPipeline(season, week));` behind `requireModelPermission('model:train')`,
  with the route comment :309-314 "There is no scheduled job calling `/execution/run` automatically". It has never been invoked on this DB (0 runs).
  And with 0 eligible picks in wk1 it would record 16 abstentions and open nothing.

## Refutation attempts that FAILED (i.e. points in the gap's favour)
1. "The identity fields are observational only" — true today, but the tape's dedup DOES depend on them (contentHash). If a future run were
   recorded twice with different scheduleVersion it would be two runs. No production caller varies it, so no effect now.
2. "The T-60 observation row could be reconciled later" — no: decision_run_id is never written anywhere; a later linkage would be a
   retrospective join, which section 7.1's own rule forbids calling prospective. The gap is real as a design debt.

## Verdict — REFUTED on materiality; downgrade to P3 / prerequisite-blocked under C11, and reword
G08 is a true code-truth statement but closing it changes no displayed number, no decision, and no record validity. Worse, the stated
SHOULD-BE would convert an honest 'unfrozen_live_tables' label into a false 'frozen_packet' claim unless the board is first refactored to
compute from the packet (C11 proper), and the packet would first need to carry real model inputs. Correct framing: G08 is a symptom of C11,
not a standalone defect; the actionable pre-work is (1) reconcile the two packetHash definitions and (2) make autoPickDecisionBoard consume
the frozen packet. Only after that does passing data_hash/scheduleVersion into recordDecisionRun become meaningful.

Side observation (outside G08): as of 2026-09-12 only ONE Week-1 observation exists (SF@LAR); no rows for SEA@NE (Wed 9/9) or the Sunday/Monday slate
despite the 24h horizon (t60-runner.js:38 SCHEDULE_HORIZON_MINUTES = 24*60). That is a coverage question for the live runner, not G08.
