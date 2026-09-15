# G02 adversarial verification (lens = code-truth) — 2026-09-12

Gap G02: "Frozen packet content is discarded; hash is non-canonical and embeds a wall clock; section 4.1 contract unwired"

Verdict: NOT REFUTED. Every clause of the CURRENT description is accurate at the cited path:line. Repo root: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard

## Clause 1 — content discarded, only hash stored

server/betting/nfl/strategy/t60-runner.js:127-129
    run(`UPDATE nfl_t60_observations SET state='frozen', packet_hash=?, capture_started_at=?,
         capture_finished_at=? WHERE id=?`,
    packetHash(packet), startedAt, new Date().toISOString(), observation.id);
Only the hash is written. `captured.push({ ..., packet })` at :130 keeps the payload in memory only.

server/betting/nfl/strategy/t60-runner.js:245-258 (runT60Pass) returns `captured: captured.captured.length` — a count — so the in-memory packets are dropped at the boundary. The only production caller, server/services/scheduler.js:786-795 (`nfl_t60_runner` job), returns that result directly; nothing persists `captured[].packet`.

server/migrations/034_t60_runner_ledger.js:33-58: columns are id, created_at, experiment_id, season, week, event_key, home, away, kickoff_at, schedule_version, cutoff_at, horizon, state, decision_run_id, packet_hash, capture_started_at, capture_finished_at, last_error, note. No payload/json column. No later migration (035 is the last) touches this table (`grep -l nfl_t60_observations server/migrations/*.js` -> only 034).

Live DB confirms (readOnly node:sqlite): sqlite_master SQL matches migration verbatim; 1 row state='frozen' (event nfl|2026-09-10|SF@LAR, packet_hash e2bcd98f...59f4, capture_started_at 2026-09-10T23:37:32.161Z) with no payload anywhere. Only tables matching %packet%/%t60% are nfl_postgame_truth_packets and nfl_t60_observations.

## Clause 2 — non-canonical hash embedding a wall clock

server/betting/nfl/strategy/t60-runner.js:141-143
    function packetHash(packet) {
      return crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex');
    }
Plain JSON.stringify, no key sorting, no exclusions. This is a private local function, NOT the contract's packetHash.

The wall clock enters via :112 `const startedAt = new Date().toISOString();` -> :118 `computationStartedAt: startedAt` -> server/services/nfl-t60-packet.js:332 `computation_started_at: computationStartedAt,`. So two captures of byte-identical evidence hash differently.

Additional non-determinism beyond the clock (strengthens the gap): nfl-t60-packet.js:96 `rows_now: rowsTotal` is embedded in every source entry and counts rows that exist NOW (e.g. :248 `rowsTotal: scopedQuotes.length`), so a late-arriving quote row changes the hash of a packet whose eligible content did not change.

## Clause 3 — section 4.1 contract unwired

server/betting/nfl/contracts/forecast-packet.js:175-179 canonicalize (sorted keys), :193-197 packetHash (excludes observation.attempt), :206-217 sealForecastPacket (validate then hash). Grep across the repo: the ONLY importer is test/forecast-packet-contract.test.js:20. Neither t60-runner.js (imports at :27-33) nor routes/nfl-betting.js (/t60/packet at :1433-1449) nor scheduler.js reference it.

Shape incompatibility: freezeT60Packet's return (nfl-t60-packet.js:318-346) is flat (packet_version, season, week, matchup, kickoff, cutoff_at, mode, claim, computation_*, sources[], summary). CONTRACT_GROUPS (forecast-packet.js:39-73) requires top-level groups event/market/observation/source_lineage/feature_lineage/forecast/decision/integrity. validateForecastPacket(freezeT60Packet(...)) would fail on every group with "<group>: missing entirely" (:95-99). So even wiring the call as-is would reject every real packet — the two modules do not agree on a schema.

## Attempts to refute, and why each fails
- "Maybe the decision tape retains packet content keyed by hash": migrations 027/031 add board_hash/content_hash/data_hash on nfl_decision_runs; 031:83-84 comment says "Until C11's frozen packet exists, decisions read mutable tables". t60-runner never writes decision_run_id (only t60Coverage reads it at :292). No link from packet_hash to any stored payload.
- "JSON.stringify is deterministic for one builder, so 'non-canonical' is unfair": true that property order is fixed within freezeT60Packet, but the contract's own packetHash sorts keys and excludes attempt precisely so the address survives builder edits; the runner's hash would change if the builder reordered a property write (forecast-packet.js:169-173 states this as the C01-class defect). The description's wording is accurate.
- "nfl_ai_replay_reviews.packet_json retains packets": that is a different packet (AI replay, server/services/nfl-ai-replay.js:310), unrelated to T-60 observations.

## Line-number accuracy of the CURRENT description
- t60-runner.js:127-129 packet_hash only — exact.
- :142 sha256(JSON.stringify(packet)) — exact.
- nfl-t60-packet.js:332 computation_started_at — exact.
- 034:33-58 no payload column — exact (CREATE TABLE spans 33-58).
- runT60Pass :249-258 drops captured[].packet — :249 is the capture call, :251-258 the return with counts. Exact.
- forecast-packet.js packetHash/validator :193-227 — packetHash is :193-197, sealForecastPacket :206-217, contractDescription :219-227; validateForecastPacket is actually :89-166. Minor mis-range for "validator" but the substantive claim (no producer/consumer) is correct.
