# G02 adversarial verification (lens = practice-truth)

Gap: "Frozen packet content is discarded; hash is non-canonical and embeds a wall clock; section 4.1 contract unwired."
Question: is the SHOULD-BE a genuine, widely-held ledger/backtest principle, or opinion? Verdict: NOT refuted.
Repo read-only; DB via node:sqlite readOnly:true. All four assigned files read in full
(t60-runner.js 298, nfl-t60-packet.js 459, forecast-packet.js 227, 034 migration 105).

## 1. CURRENT state — every claim re-verified

| Claim | Evidence |
|---|---|
| Only the hash is stored | t60-runner.js:127-129 `UPDATE nfl_t60_observations SET state='frozen', packet_hash=?, capture_started_at=?, capture_finished_at=?` — no payload bound |
| Hash is non-canonical | t60-runner.js:141-143 `crypto.createHash('sha256').update(JSON.stringify(packet))` — raw insertion order, no sort |
| Hash embeds a per-attempt wall clock | t60-runner.js:112 `const startedAt = new Date().toISOString()` → :118 `computationStartedAt: startedAt` → nfl-t60-packet.js:332 `computation_started_at: computationStartedAt` lands inside the hashed object |
| Hash embeds post-cutoff-mutable counts | nfl-t60-packet.js:95 `rows_now: rowsTotal`; :223 `rowsTotal: scopedQuotes.length` counts every row in the kickoff window regardless of receipt time; :264-270 news query has NO WHERE at all |
| No payload column | 034_t60_runner_ledger.js:33-58 — columns are id…note; `packet_hash TEXT` at :52, nothing JSON |
| Runner drops the packet | captureDueObservations returns `captured.push({... packet})` at :130, but runT60Pass :254 keeps only `captured.captured.length`; scheduler.js:795 `return m.runT60Pass(...)` — the only production caller, so the object dies there |
| 4.1 contract has no producer/consumer | grep: forecast-packet.js imported only by test/forecast-packet-contract.test.js:20; `sealForecastPacket`/`validateForecastPacket` called only in that test; nfl-t60-packet.js output shape (`sources[]`, :319-345) is not the eight-group shape CONTRACT_GROUPS expects (:39-73) |
| The hash has no consumer | grep `frozen_packet` outside the tape/contract/migration: none. nfl-decision-tape.js:374-378 is the only thing that would ever check a data_hash, and `nfl_decision_runs` has 0 rows (DB). The hash is read back only into t60Coverage detail (:292) |

## 2. The live row proves the hash is unverifiable, not merely unstored

DB (readOnly): one row, state=frozen, event `nfl|2026-09-10|SF@LAR`, cutoff 2026-09-10T23:35:00Z,
capture_started_at 2026-09-10T23:37:32.161Z, packet_hash e2bcd98f…, decision_run_id NULL.

Could a verifier re-freeze and recompute e2bcd98f…? No:
- The clock is recoverable (capture_started_at is the same `startedAt` value, :118 and :129), BUT
- The spreads/full_game quote rows in that kickoff window now number 18,810 with received_at up to
  2026-09-11T00:39:27Z — i.e. rows arrived AFTER the 23:35 cutoff and after the 23:37 capture. `rows_now`
  (packet.js:95, :223) therefore differs today from what it was at capture, so the recomputed hash differs.
- News (`nfl_news_events`, unscoped :264-270) and weather/injury `total` counts move the same way.
So the stored hash cannot be reproduced, cannot be checked, and addresses content that no longer exists.
It is a write-once opaque string. This is stronger than "content discarded": the one integrity property a
hash-only store could still offer (tamper-evidence via recompute) is also absent.

## 3. Is the SHOULD-BE a genuine principle? (practice-truth)

(a) "Persist the payload" — this is the point-in-time-input principle of any prospective ledger:
a decision must be reconstructible from what was held at the cutoff, not from what the tables say later.
It is not the auditor's opinion; it is the project's own governing text at three levels:
- Plan §4.1 (CLAUDE-NEXT-STEPS.md:384): "A hash without retained content cannot reconstruct a decision."
- Plan §4.1 Integrity row (:382): "Canonical payload hash … Content integrity and repeated observation
  identity are separate fields."
- Plan §7.1 (:504): "`nfl-t60-packet.js` should inspect its persisted packet."
- Plan C11 fix (:276): "a persisted exact input payload or immutable row references with content hashes."
- The repo's own decision tape comment (nfl-decision-tape.js:86-87): "`frozen_packet` is the target state
  (C11): an immutable, content-addressed input packet whose hash goes in `data_hash`."
Outside the repo the same rule is what point-in-time databases, append-only decision logs, and reproducible-
research standards require: a hash is a commitment/tamper seal, not a record. Git, Nix, and any
content-addressed store keep the object AND its address; the address alone is useless.

(b) "Canonical sorted-key hash excluding per-attempt clocks" — content addressing requires a canonical
serialization (RFC 8785-style JSON canonicalization; git tree hashing; reproducible-builds' exclusion of
build timestamps via SOURCE_DATE_EPOCH). The repo already holds this as settled doctrine, not opinion:
- forecast-packet.js:166-181 canonicalize() "Key order is sorted recursively so that two packets with
  identical content hash identically"; :183-197 excludes `attempt` because "a retry of one observation is
  the same evidence"; the tests assert both (test/forecast-packet-contract.test.js:133-152).
- nfl-decision-tape.js:147 sorts `active_model_ids` before hashing for the same reason (C01).
The runner's packetHash (:141-143) contradicts the repo's own already-tested authority.

(c) "Validate against the single contract before sealing" — plan §10.3 (:668): forecast-packet.js is
"Shared versioned packet schema/canonicalization used by source freeze, family adapters, decision tape and
execution. One schema authority." Sealing without validation is exactly what forecast-packet.js:24-27 and
:199-205 say must not happen ("Every caller of this is about to make or record a decision from the result").

## 4. Sample-size objection (272 games/season)

Does not apply. These are identity/ledger properties (what was held, addressed canonically, validated at the
boundary) and hold at N=1. The current live ledger IS N=1 (one frozen row), and that single observation is
already unreconstructible — the smaller the sample, the more each observation must be reconstructible,
because there is no redundancy to average over. No statistical power is invoked by the SHOULD-BE.

## 5. Nuances / small corrections to the gap text (not refutations)

1. Plan C11 (:276) accepts EITHER a persisted payload OR immutable row references + content hashes. The
   quote tape rows carry `quote_id` (packet.js:240) and the tape has receipt clocks, so a reference-based
   design is a legitimate alternative to a JSON column — but the runner stores neither.
2. forecast-packet.js's packetHash (:193-197) excludes only `observation.attempt`; it does not exclude clocks.
   Plan §4.1 Observation row (:377) wants "collection and computation start/end, emission time" IN the packet.
   The reconciliation is C01's separation: clocks travel in the packet, but the CONTENT hash must exclude
   per-attempt clocks and mutable now-counts (`rows_now`), or keep them outside the hashed content. The
   SHOULD-BE should say "per-attempt clocks and post-cutoff-mutable counts", not just "clocks".
3. `rows_now` (packet.js:95) is a second, independent non-reproducibility source the gap text does not name;
   it is what makes the live hash unverifiable even after recovering the clock from capture_started_at.

## Verdict
refuted = false. The SHOULD-BE is the project's own written contract (4.1, 7.1, 10.3, C01, C11) and standard
content-addressing / point-in-time practice; the CURRENT state is confirmed line-by-line and worsened by a
live row whose hash can no longer be recomputed.
