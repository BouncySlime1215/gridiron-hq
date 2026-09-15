# G01 adversarial verification — lens: practice-truth

Gap under test: "Forward packet is price-blind: the only prospective-capable source can never be admitted."
Should-be under test: "Receipt = response-completion timestamp on every live batch so the packet admits real quotes."

Verdict: NOT refuted. The should-be is a genuine point-in-time / bitemporal principle, not an opinion, and it
is a per-row eligibility rule that is independent of NFL sample size. One material refinement to the gap's
CURRENT description (below, §3): the live callers already stamp a post-completion clock; the defect is that
they do not *declare* it, so the packet quarantines rows the system genuinely held.

All paths relative to /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard.

## 1. The CURRENT claim, verified line by line

- `server/services/book-feeds.js:380` `await Promise.all(providers.map(async name => {` ... `:390` `const at = new Date().toISOString();`
  ... `:417` `tape = ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at,` — no `receivedAt`, no `receiptClockSource`.
- `server/services/line-shopping.js:39` `const data = await gameOdds({ markets, ttlMs: 0 });` ... `:42` `const at = new Date().toISOString();`
  ... `:66` `ingestQuoteSnapshot(data, { requestedAt: at, markets, sourceRef: 'snapshot_lines' });` — same.
- `server/services/nfl-quote-tape.js:64-65`
  `const receipt = receivedAt ?? requestedAt;`
  `const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only');`
  → both live callers land as `legacy_request_time_only` with `received_at = requested_at`.
- `server/services/nfl-t60-packet.js:214-216`
  `const realClock = scopedQuotes.filter(q => q.receipt_clock_source === 'response_completion');`
  `const legacyClock = scopedQuotes.filter(q => q.receipt_clock_source !== 'response_completion');`
  `const receivedByCutoff = realClock.filter(q => beforeOrAt(q.received_at, cutoffAt));`
  and `:222-226`: `receivedAt: latestReceipt ?? (realClock.length ? ... : null)` → null when every row is legacy,
  so `sourceEntry` (`:111-119`) falls through to `claim: 'availability_unknown'` (rowsTotal > 0, receivedAt null, publishedAt null).
- Only producer that passes `response_completion`: `nfl-quote-tape.js:127-138` `captureCurrentQuoteTape` (metered Odds API), whose
  sole caller is `server/services/nfl-prospective-collection.js:101` — a module that says of itself `:15` "DELIBERATELY NOT A SCHEDULED JOB".
  The scheduler runs `captureBookFeeds` (`scheduler.js:320-327`, jobs `nfl_book_feeds_fast`/`_slow` at `:755-758`) and
  `snapshotLines` (`scheduler.js:267-273`, job `nfl_line_snapshots` at `:742`, tier `metered`).
- The C11 commit `1bbe43d` (2026-09-10 13:02 -0400) changed `nfl-quote-tape.js` (`git show 1bbe43d -- server/services/nfl-quote-tape.js`
  lines +144..+148, +156..+165 add `receivedAt`/`receiptClockSource` to the two in-module producers) and did NOT touch
  `book-feeds.js` or `line-shopping.js` (`git show 1bbe43d --stat -- <both>` is empty).

## 2. Live DB (read-only, `server/data.sqlite`)

- `nfl_quote_batches`: 1,336 rows, all `legacy_request_time_only`, all with `requested_at = received_at`:
  free-book-feeds 1,168 (2026-09-02T10:56:58Z .. 2026-09-12T06:42:28Z); the-odds-api 168 (historical backfill, all 2026-09-09T01:51-01:54Z).
  (Gap text said 1,323; the count is 1,336 today — same conclusion, the tape is still growing on the legacy label.)
- Batches written AFTER the C11 commit instant (requested_at > 2026-09-10T17:02:03Z): 205, all free-book-feeds, all legacy.
  The live path was never updated.
- `nfl_t60_observations`: exactly 1 row, `state='frozen'`, `event_key nfl|2026-09-10|SF@LAR`, `cutoff_at 2026-09-10T23:35:00.000Z`,
  `capture_started_at 2026-09-10T23:37:32.161Z`, `decision_run_id null`, `packet_hash e2bcd98f…` (matches docs/evidence/2026-09-11/RETURN-TO-CODEX.md:256-266).
- For that game (spreads, full_game): 18,810 tape rows joined to batches, 18,692 with `requested_at <= cutoff`, 12 distinct books.
  Latest pre-cutoff batch: `requested_at = received_at = 2026-09-10T23:34:23.882Z`, `source_ref book_feeds`, `legacy_request_time_only`
  — 36.1 s before the cutoff. Under `nfl-t60-packet.js:214-216` every one of those rows is `legacyClock`, so the packet's
  quote-tape entry is `availability_unknown` with `rows: 0`, `rows_now: 18,810`. "No eligible price" — confirmed.
- Secondary (outside G01 but material to "practice-truth"): `server/betting/nfl/strategy/t60-runner.js:127-129` persists only
  `packetHash(packet)`; the packet body (`values`, claims) is returned in memory (`:130`) and not stored. The frozen observation's
  contents cannot be re-inspected from the database; the "no eligible price" finding above is reconstructed from the tape, not read from a stored packet.

## 3. Refinement to CURRENT: the live clock already IS a completion clock, unlabelled

`book-feeds.js:390`'s `at` is taken after `:380`'s `await Promise.all(...)` resolves for every provider; `line-shopping.js:42`'s `at`
is taken after `:39`'s `await gameOdds(...)`. Both are therefore response-completion instants (for a multi-provider batch, the
completion of the *last* provider — the conservative bound for every row in it). Git history shows this ordering in every revision
of both files (book-feeds: 3abb065 278→282, 8b04128 245→249, a9a0d9a 269→273, c4a61ba 317→327, d89c729 380→390;
line-shopping: 6868168.. c039d8c always `gameOdds` await then `at`).

So the request-before/receipt-after look-ahead that C11 describes (`nfl-quote-tape.js:46-57`, test `test/nfl-t60-packet.test.js:320-328`)
cannot actually occur on these two paths: what is stored as `requested_at` is in fact a receipt. The defect is a mislabel in the
*opposite* (conservative) direction, and its cost is the gap: rows genuinely held 36 s before cutoff are quarantined.
`requested_at` on these batches is, strictly, wrong (it is later than the true request instant); harmless for admission, but it should be
stamped before the await once the receipt is passed separately.

Consequence for the fix: it is a declaration, not a new clock. `requestedAt` stamped before the await; `receivedAt: <post-await stamp>`,
`receiptClockSource: 'response_completion'` on `book-feeds.js:417` and `line-shopping.js:66`. Whether the 1,168 existing
free-book-feeds batches may be relabelled is a separate governance call: the code archaeology above evidences that their stored clock
is a completion clock, but migration 032's stated policy (`server/db/schema/nfl-n-to-z.js:373-376`, commit message of 1bbe43d:
"deliberately, does NOT backfill") was to refuse inference. A relabel would need that evidence recorded as its justification; it is
not required for the forward packet to start admitting quotes from the next batch onward.

## 4. Is the should-be a genuine, widely-held principle?

Yes. It is the bitemporal "transaction time" / point-in-time "as-known" rule, stated independently in:
- Bitemporal data modelling (Snodgrass, *Developing Time-Oriented Database Applications in SQL*, 1999; Jensen & Snodgrass, IEEE TKDE 1999):
  valid time = when true in the world; transaction time = when the system *recorded* the fact (i.e. when the write completed, not when it was requested).
  The packet's own taxonomy (`nfl-t60-packet.js:12-19` EFFECTIVE / PUBLISHED / RECEIVED) is this triple.
- Point-in-time datasets in quant finance (Compustat PIT, Bloomberg as-first-reported; López de Prado, *Advances in Financial Machine Learning*, 2018,
  on look-ahead bias): each value carries the time it became knowable to the decision-maker, and backtests join on that clock, never on the later-corrected one.
- ML feature stores (e.g. Feast's point-in-time-correct joins): features are joined at the *created/ingested* timestamp, and when two clocks exist
  the later (conservative) one bounds availability.
- Leakage literature (Kaufman, Rosset, Perlich, "Leakage in Data Mining", KDD 2011): legitimacy of a feature is a property of its availability time.
- In-repo statements of the same rule, predating this gap: `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:225` ("source time and receipt time"),
  `:517` ("Capture first_received_at when ingesting source"); `docs/CLAUDE-NEXT-STEPS.md:276` ("true immutable first receipt/response completion
  separate from request time"), `:506` ("never reconstruct it with later receipts and call it prospective"), `:530` ("Backfill ... cannot recreate
  this system's first receipt months earlier"); `nfl-t60-packet.js:1-9` quoting plan §6.1-6.3.
(No web lookups were made in this run; the external sources are cited by name from prior knowledge, not fetched.)

The specific choice "response completion" rather than "request issue" is the conservative member of the two candidate clocks
(`requested_at <= received_at`, `nfl-quote-tape.js:50`), which is what every source above prescribes when a value's knowability is uncertain.

## 5. Sample-size objection

Not applicable. The rule is a per-row admissibility predicate (`beforeOrAt(q.received_at, cutoffAt)`, `nfl-t60-packet.js:216`), not a
statistical estimate; it has the same content at n=1 and n=272. Sample size bears on what the *packet's consumers* can infer
(CLV power, clustered errors), not on which rows may enter the packet. The n=1 frozen observation (RETURN-TO-CODEX.md:277-284) is
exactly the case where the rule is cheapest to apply and the mislabel costs 100 % of the evidence.

## 6. Magnitude objection considered and rejected

One might argue the request→response gap (≈1 s: capture 23:37:32.161→23:37:33.148; provider timeouts 25 s at `book-feeds.js:96`, 180 s at
`nfl-quote-tape.js:147`) is immaterial against a 60-minute lead, so labelling is pedantry. Two answers: (a) the principle's material case is
the historical backfill, where receipt is years after kickoff (`nfl-t60-packet.js:40-43`; the 168 the-odds-api batches received 2026-09-09
for 2020-2023 games), and a label that cannot distinguish 1 s from 3 years is no label; (b) the runner's own cadence lag (2 m 32 s on the
only real freeze) shows minute-scale clocks are already decision-relevant here.

## 7. Files read in full
- server/services/book-feeds.js (442 lines), server/services/line-shopping.js (248), server/services/nfl-quote-tape.js (234),
  server/services/nfl-t60-packet.js (459), server/services/nfl-t60-protocol.js (197), server/services/nfl-prospective-collection.js (138).
- Partial: scheduler.js:700-810, 940-965; t60-runner.js:95-140; test/nfl-t60-packet.test.js:40-70, 110-160, 320-360;
  server/db/schema/nfl-n-to-z.js:365-383; docs/evidence/2026-09-11/RETURN-TO-CODEX.md:225-300.
- DB script: scratchpad/audit-system/g01-db.cjs (readOnly:true).
