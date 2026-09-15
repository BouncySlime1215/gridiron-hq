# G02 adversarial verification — lens: materiality

Gap under test: "Frozen packet content is discarded; hash is non-canonical and embeds a wall clock; section 4.1 contract unwired."

## 1. The description is accurate (not refuted on fact)

- `server/betting/nfl/strategy/t60-runner.js:127-129` — `UPDATE nfl_t60_observations SET state='frozen', packet_hash=?, ...` with `packetHash(packet)`; no payload written.
- `t60-runner.js:141-143` — `crypto.createHash('sha256').update(JSON.stringify(packet))` — no canonicalization.
- `server/services/nfl-t60-packet.js:332` — `computation_started_at: computationStartedAt`, fed from `t60-runner.js:112,118` (`new Date().toISOString()`), so the hash changes on every re-freeze of identical evidence.
- `server/migrations/034_t60_runner_ledger.js:33-58` — columns are id/experiment/season/week/event_key/home/away/kickoff_at/schedule_version/cutoff_at/horizon/state/decision_run_id/packet_hash/capture_*/last_error/note. No payload column.
- `t60-runner.js:249-258` — `runT60Pass` returns `captured: captured.captured.length`; the `captured[].packet` objects from `:130` go out of scope.
- `server/betting/nfl/contracts/forecast-packet.js:193-197` canonical `packetHash`, `:206-217` `sealForecastPacket` — grep over `server/` finds no importer other than its own test (`test/forecast-packet-contract.test.js:18-20`).

All five CURRENT claims hold.

## 2. Materiality: would closing it change a number, a decision, or record validity today?

### 2a. No number Nick reads depends on it
- Only reader of `packet_hash` is `t60Coverage` (`t60-runner.js:266-295`), whose only caller is `test/t60-runner.test.js:86,97`. No route exposes `nfl_t60_observations` (grep `server/routes/*.js`: only `/t60/packet` at `nfl-betting.js:1434-1449`, which re-freezes live and never touches the ledger). No client file references t60/packet_hash (grep of client/src: zero hits).
- Scheduler job `nfl_t60_runner` (`scheduler.js:785-799`) returns `runT60Pass`'s counts; nothing persists or displays them.

### 2b. No decision depends on it
- `nfl_decision_runs` has **0 rows** (read-only query); `nfl_t60_observations.decision_run_id` is NULL on the single frozen row; `nfl_capacity_events` has **0 rows**. The runner explicitly "does not place bets, and it does not grant a forecast authority" (`t60-runner.js:22-25`). Plan register `docs/CLAUDE-NEXT-STEPS.md:69` — "No forecast consumes it yet."
- The decision tape refuses `frozen_packet` without a hex64 hash (`nfl-decision-tape.js:374-378`), but nothing calls it with one.

### 2c. The discarded payload was decision-empty, so "validity of the record" is unaffected in substance
Reconstruction of the one frozen row (`nfl|2026-09-10|SF@LAR`, cutoff `2026-09-10T23:35:00Z`, hash `e2bcd98f…`) from the live tables:
- Quote tape: 18,810 full-game spread rows for that kickoff, 18,692 with `received_at <= cutoff` — but **every** one of the 1,336 batches in the DB is `receipt_clock_source='legacy_request_time_only'`. `nfl-t60-packet.js:214-216` admits only `response_completion`, so `receivedByCutoff = []`, `values: []` (`:236-240`), and the claim falls to `availability_unknown` (`:124-127`).
- Injuries: 167 rows, `modified_at` NULL on all → `availability_unknown`, no `values` (`:244-255` never passes values).
- News: 30 rows all `first_seen_time <= cutoff` → `received_by_cutoff`, but global (no game scope, `:261-270`) and no `values`.
- Forecast history: 0 rows → `missing`. Realized weather: `oracle_excluded`. Team-week features: week 1 → `missing`.
So the persisted payload, had it been kept, would contain no quote line, price or feature value — only claim labels and counts. Persisting it changes nothing a forecast could consume, because the upstream receipt-clock defect (A04 headline 3, `book-feeds.js:417`) empties the packet first.

### 2d. The content is re-derivable anyway
`freezeT60Packet` is a pure read over `nfl_quote_tape` + `nfl_quote_batches` (`:182-189`), both protected by no-update/no-delete triggers (live DB: `nfl_quote_tape_no_update`, `nfl_quote_tape_no_delete`, `nfl_quote_batches_no_update`, `nfl_quote_batches_no_delete`). Re-running with the stored `cutoff_at` reproduces the quote section exactly; only the mutable side tables (injuries, news) could drift, and those carry no values in any case.

## 3. What would make it material
It becomes material the moment (a) batches start carrying `response_completion` receipts so `values` is non-empty, and (b) a forecast/decision run claims `data_identity_status='frozen_packet'` against `packet_hash`. At that point the hash must be canonical and the payload retained or the decision tape's C01/C11 guarantees are hollow. That is the correct ordering: fix the receipt clock (A04 P1) and wire a consumer, and land G02's persistence + canonical hash in the same slice.

## 4. Verdict
Not refuted as a defect; **refuted as P1 on materiality**. Downgrade to P2 with a dependency note: "no consumer, no decision, no displayed number, and the discarded content is empty until the receipt clock is fixed."
