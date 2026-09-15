# G08 — practice-truth verification (adversarial, 2026-09-12)

Gap under test: "Decisions are not reproducible from stored inputs; the frozen packet is never linked to a
decision; schedule_version never passed." Should-be: "Tape run carries data_hash = packet_hash,
data_identity_status 'frozen_packet', schedule_version."

Question for this lens: is the should-be a genuine, widely-held backtest/ledger principle, or an opinion
dressed as a standard? Does it survive NFL sample sizes (272 games/season)?

**Verdict: NOT refuted.** The should-be is an instance of the point-in-time-inputs / reproducible-decision
principle, which is (a) declared by this repo as its own governance standard, (b) the standard practice in
the forecast-evaluation literature held locally, and (c) a per-decision provenance property with no
dependence on sample size. One correction: as phrased, the should-be is necessary but not sufficient —
the packet body is never retained, there are two non-identical packet hash functions, and the board never
consumes the packet, so writing `data_hash = packet_hash` alone would not make a decision reproducible.

## 1. Current state — re-confirmed on code and live DB (all files read end to end)

Assigned files fully read: `server/services/nfl-execution-pipeline.js` (302 lines),
`server/services/nfl-decision-tape.js` (574), `test/nfl-decision-identity-pipeline.test.js` (237).
Supporting: `server/betting/nfl/strategy/t60-runner.js` (298), `server/services/nfl-t60-packet.js` (459),
`server/betting/nfl/contracts/forecast-packet.js` (120-227), migrations 031 (261) and 034 (105).

- `server/services/nfl-execution-pipeline.js:130-136` — status hard-coded, no hash, no schedule version:
  ```js
  computationStartedAt, computationEndedAt: decisionAt,
  // The board reads mutable tables at compute time; no artifact can
  // reproduce exactly what it saw. ... C11 replaces
  // this with a real frozen packet hash.
  dataIdentityStatus: 'unfrozen_live_tables',
  ```
- `server/services/nfl-decision-tape.js:359-361` — defaults:
  ```js
  dataIdentityStatus = 'unfrozen_live_tables',
  dataHash = null,
  scheduleVersion = null,
  ```
- `server/services/nfl-decision-tape.js:374-378` — the tape already REFUSES a `frozen_packet` claim
  without a hex64 hash and refuses a hash on a non-frozen run, i.e. the contract exists, only the caller
  never satisfies it.
- `test/nfl-decision-identity-pipeline.test.js:148-150`:
  ```js
  // The data provenance is recorded honestly: this board read mutable tables.
  assert.equal(recorded.data_identity_status, 'unfrozen_live_tables');
  assert.equal(recorded.data_hash, null);
  ```
- Only production caller of the pipeline is `server/routes/nfl-market.js:323`
  `res.json(runExecutionPipeline(season, week));` — no observation, no schedule version, so it lands on
  the `'unscheduled-manual-invocation'` identity at `nfl-execution-pipeline.js:118-125`.
- The T-60 runner freezes a packet but never calls the tape or the pipeline. `t60-runner.js:127-129`:
  ```js
  run(`UPDATE nfl_t60_observations SET state='frozen', packet_hash=?, capture_started_at=?,
       capture_finished_at=? WHERE id=?`,
  packetHash(packet), startedAt, new Date().toISOString(), observation.id);
  ```
  `grep -rn decision_run_id server test` finds exactly one reference, a READ at `t60-runner.js:292`;
  nothing ever writes it. No test in `test/t60-runner.test.js` mentions `decided`/`decision_run_id`.
- Scheduler job passes no schedule version: `server/services/scheduler.js:795`
  `return m.runT60Pass({ season, week, experimentId: T60_EXPERIMENT_ID });` → `openObservations` at
  `t60-runner.js:69` defaults `scheduleVersion = null` → inserted NULL at `:88-92`.
- Live DB (`node:sqlite`, readOnly): `nfl_t60_observations` has one row, `SF@LAR` 2026-09-10,
  `state='frozen'`, `packet_hash='e2bcd98f…'`, `schedule_version=null`, `decision_run_id=null`.
  `nfl_decision_runs` has 0 rows. So there is no decision at all yet, let alone a linked one.

## 2. Is the should-be a genuine, widely-held principle?

### 2a. The repo declared it as its own standard before this gap was raised
- `docs/reference/model-governance-manual.md:1020-1022` (Evidence lifecycle):
  "2. Pregame inputs are written as immutable, content-addressed evidence manifests.
   3. Predictions, abstentions, model version, quote, and feature snapshot are recorded before the event."
- `docs/CLAUDE-NEXT-STEPS.md:506` (§7.1): "Freeze 60 minutes before the then-known kickoff. Collect ahead
  of that time. Persist the schedule revision that established it. Record actual computation/emission times
  separately."
- `docs/CLAUDE-NEXT-STEPS.md:369-383` (§4.1 packet contract) — Event group requires "schedule version";
  Integrity group requires "Canonical payload hash"; and line 383: "A hash without retained content cannot
  reconstruct a decision."
- `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:263` acceptance: "Same frozen packet gives the same raw
  prediction, calibrated distribution, side and stake decision in live and replay."
- `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:477`: "append-only decision-run/event layer with run ID,
  precise cutoff, model/policy/data hashes, quote ID ... Connect the execution opportunity by decision ID."
- The tape module itself: `nfl-decision-tape.js:86-88` "`frozen_packet` is the target state (C11): an
  immutable, content-addressed input packet whose hash goes in `data_hash`."
So this is not an auditor's taste imposed from outside; the code's own comments, its own migration
(`031_decision_identity.js:83-88`), and its own governance manual name it as the target.

### 2b. It is the standard practice in the forecast-evaluation literature held locally
- `scratchpad/pdf/timmermann2010.plain.txt:390-392` (Aiolfi, Capistrán, Timmermann, "Forecast
  Combinations", 2010): "Actual values ... are taken from the Federal Reserve Bank of Philadelphia's
  real-time database. Following Corradi, Fernandez and Swanson (2009) we use first release data." and
  `:1442-1443` cites "Information in the Revision Process of Real-time Datasets, JBES 27(4)".
  Real-time (vintage) databases exist precisely so an evaluation uses the data as it stood at decision
  time rather than later revisions — the same principle as freezing a packet at the cutoff and binding the
  decision to it.
- `scratchpad/pdfs/nexcp.txt:1348-1352`: training on rows "whose votes have already been reported"
  "violates exchangeability" — the same look-ahead argument for point-in-time cuts in a sequential
  conformal setting.
- From memory, not verified by URL in this run (no web allowed): point-in-time fundamentals databases
  (e.g. Compustat PIT) and MiFID II RTS 6 record-keeping for algorithmic trading both require that the
  inputs a decision was made on be reconstructible after the fact. Treat as supporting context only.

### 2c. The mechanism named (hash link + status + schedule version) is one legitimate implementation
The principle is "a decision is reproducible from, and bound to, the point-in-time snapshot it consumed."
`data_hash = packet_hash` + `data_identity_status='frozen_packet'` + `schedule_version` is a
content-addressed implementation of that principle; the repo already chose it (tape enforces it at
`nfl-decision-tape.js:374-378`, packet contract enforces it at `forecast-packet.js:146-148`). Naming the
mechanism does not turn the principle into an opinion.

## 3. Does it fail at NFL sample sizes? No.
Provenance/reproducibility is a per-decision property, not a statistical estimate; it has no n in it.
If anything, 272 games/season makes it MORE important: with a small evaluation set, a handful of
decisions contaminated by post-cutoff data (a late injury row, a revised line) can flip a marginal
result, and without a bound input packet the contamination cannot be detected afterwards. The repo's
own packet module makes the same point at `nfl-t60-packet.js:35-38`: pre-2026 weather rows were all
fetched 2026-09-02; counting them as knowable "would be the single largest look-ahead available here."
Sample size is an argument about inference on outcomes (CLV, clustered errors), not about whether a
decision record should cite its inputs.

## 4. Refutation attempts that failed
1. "The should-be is the auditor's preference" — refuted by §2a: the repo declared it first.
2. "Content-addressing is over-engineering; a timestamp suffices" — refuted by the repo's own defect
   history: `nfl-decision-tape.js:16-51` documents a tape that "could not tell two different decisions
   apart" because identity was not content-addressed; and `nfl-t60-packet.js:35-38` shows a timestamp on
   the row (`fetched_at`) is exactly what the receipt-clock discipline exists to distrust.
3. "The board already records feature_snapshot, so decisions are reproducible" — `feature_snapshot_json`
   is persisted per event (`nfl-decision-tape.js:461-475`) but it is the model's OUTPUT summary
   (forecast identity, margins, active model ids), not the input rows; `nfl-execution-pipeline.js:97`
   `autoPickDecisionBoard(season, week, policy)` reads live tables and never receives a packet.
4. "Sample size" — see §3.

## 5. Correction to the should-be (necessary, not sufficient)
Writing `data_hash = packet_hash` today would produce a link that still cannot reproduce anything:
- **Packet body is not retained.** `t60-runner.js:127-129` stores only the hash; the packet object is
  returned in `captured` and discarded. No `nfl_t60_packets` table exists (live DB table list checked;
  the only `packet_json` column is `nfl_ai_replay_reviews.packet_json`, `server/db/schema/nfl-a-to-m.js:80`,
  an unrelated AI-replay store). Plan §4.1 line 383 says this directly.
- **Two different hash functions.** `t60-runner.js:141` `sha256(JSON.stringify(packet))` — key-order
  sensitive and hashes a packet that contains `computation_started_at: startedAt` (`t60-runner.js:116-118`,
  `nfl-t60-packet.js:328`), so a retry cannot reproduce the stored hash; versus the canonical
  `forecast-packet.js:193-197` `packetHash` which sorts keys and excludes `attempt`. A tape link must use
  the canonical one, or the link is to a value nobody can recompute.
- **Packet contains inputs for only one source.** `nfl-t60-packet.js:250-253` carries actual quote rows
  in `values`; injuries (`:256-265`), news (`:270-282`), weather (`:288-298`), team-week features
  (`:305-311`) carry counts and clocks only (`values: null`, `sourceEntry` default at `:104`). The
  model's actual feature inputs are not in the packet, so hashing it does not bind the forecast's inputs.
- **The board does not consume the packet.** `nfl-execution-pipeline.js:97` calls
  `autoPickDecisionBoard` on live tables; `runT60Pass` (`t60-runner.js:245-259`) never invokes the tape or
  pipeline; `decision_run_id` is never written; the observation state machine
  (`034_t60_runner_ledger.js:47-49`) has a `decided` state nothing reaches.

Corrected should-be: the T-60 runner (or a step it triggers) computes the board FROM the frozen packet,
records the run with `dataIdentityStatus:'frozen_packet'`, `dataHash: packetHash(packet)` using the
canonical `forecast-packet.js:193` function over a RETAINED packet body that carries values for every
consumed source, `scheduleVersion: observation.schedule_version` (which the scheduler must actually
supply at `scheduler.js:795`), and then sets `nfl_t60_observations.decision_run_id` and `state='decided'`.

## 6. Confidence
0.9 that the gap stands as a genuine principle violation. Residual 0.1: the principle's mechanism is
under-specified in the gap text (see §5), and the literature grounding is from local PDFs plus recalled
regulatory practice rather than URL-verified sources.
