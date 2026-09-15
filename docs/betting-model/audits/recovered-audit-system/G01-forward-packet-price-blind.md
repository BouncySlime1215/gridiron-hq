# G01 verifier (lens=code-truth): Forward packet is price-blind

Verdict: NOT REFUTED. Every cited path:line is accurate; the mechanism is exactly as described.
One framing correction (below) sharpens the fix but does not weaken the gap.

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). All four assigned files read
in full (book-feeds.js 442 lines, line-shopping.js 248, nfl-quote-tape.js 234, nfl-t60-packet.js 459).

## 1. Cited lines, verified verbatim

server/services/book-feeds.js:417-418
    tape = ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at,
      markets: 'spreads,totals,h2h', sourceRef: 'book_feeds' });
  -> no receivedAt, no receiptClockSource.

server/services/line-shopping.js:66
    ingestQuoteSnapshot(data, { requestedAt: at, markets, sourceRef: 'snapshot_lines' });
  -> no receivedAt, no receiptClockSource.

server/services/nfl-quote-tape.js:64-65
    const receipt = receivedAt ?? requestedAt;
    const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only');
  -> with neither option passed, every batch is written legacy_request_time_only (INSERT at :103-110).

server/services/nfl-t60-packet.js:214-216
    const realClock = scopedQuotes.filter(q => q.receipt_clock_source === 'response_completion');
    const legacyClock = scopedQuotes.filter(q => q.receipt_clock_source !== 'response_completion');
    const receivedByCutoff = realClock.filter(q => beforeOrAt(q.received_at, cutoffAt));
  -> only response_completion rows can enter receivedByCutoff; :219-236 builds the source entry from
     receivedByCutoff (values, rows) and receivedAt = latestReceipt ?? (realClock.length ? ... : null).
     With zero realClock rows receivedAt is null, rowsTotal>0, publishedAt null -> sourceEntry (:112-120)
     returns claim 'availability_unknown' (quarantined). ELIGIBLE_BY_MODE.prospective = ['received_by_cutoff']
     (:76-79), so the quote tape never reaches summary.eligible for a prospective packet.

Second gate, same effect: server/betting/nfl/contracts/forecast-packet.js:127-129 rejects any prospective
packet whose lineage.receipt_clock_source !== 'response_completion'.

## 2. Who actually produces batches (scheduled vs. not)

Producers that DO pass a completion clock:
  - nfl-quote-tape.js:127-138 captureCurrentQuoteTape -> receivedAt stamped after await (:134),
    receiptClockSource 'response_completion' (:137). Called ONLY from
    nfl-prospective-collection.js:101 (runProspectiveCollection), which is reachable only from
    routes/nfl-market.js:408 and is explicitly "NOT a scheduled" job (routes/nfl-market.js:402).
    Requires ODDS_API_KEY (:98-99). No batch with source_ref 'current_odds_endpoint' exists in the live DB.
  - nfl-quote-tape.js:164-166 backfillHistoricalQuoteTape -> response_completion, but historical only;
    the 168 the-odds-api historical batches in the DB are labeled legacy (ingested pre-migration-032 and
    relabeled by 032:93-97).

Producers that are scheduled and pass requestedAt only:
  - captureBookFeeds (book-feeds.js:417): scheduler.js:320-327 nfl_book_feeds_fast/slow (:755-757),
    evidence-daemon.js:124, routes/nfl-market.js:101, routes/wong.js:183, scripts/fanduel-lines.mjs:59.
  - snapshotLines (line-shopping.js:66): scheduler.js:267-273 refreshNflLineSnapshots,
    evidence-daemon.js:115, nfl-capture-dispatch.js:84-85, routes/nfl-betting.js:850.

## 3. Live DB (node:sqlite readOnly:true, server/data.sqlite)

  SELECT receipt_clock_source, COUNT(*) FROM nfl_quote_batches GROUP BY 1
    -> legacy_request_time_only: 1336 (gap said 1,323/1,323; count has grown since, still 100% legacy)
  by provider: free-book-feeds 1168 (last 2026-09-12T06:42:28Z), the-odds-api 168 (last 2026-09-09).
  SUM(received_at=requested_at)=1336, diff=0, null=0.
  No 'response_completion' batch has ever been written.

Frozen observation: nfl_t60_observations has 1 row: id bfa3e970-..., experiment nfl-spread-t60-prospective-v1,
event_key nfl|2026-09-10|SF@LAR, cutoff_at 2026-09-10T23:35:00.000Z, state 'frozen',
packet_hash e2bcd98f..., capture 23:37:32-23:37:33Z. Frozen by t60-runner.js:114-118 with mode:'prospective';
only packet_hash is persisted (:127-129), not the body, so "no eligible price" was re-derived from the tape:

  SF@LAR full_game spreads rows (Rams home / 49ers away, commence 2026-09-11T00:35:00Z):
    legacy, received <= cutoff : 18,692 rows, 12 books, first 2026-09-02T10:56:58Z, last 2026-09-10T23:34:23.882Z
    legacy, received  > cutoff :    118 rows
    response_completion AND received <= cutoff (the packet's rule) : 0
  i.e. 12 books quoted the game 37 seconds before the cutoff and all of it was refused on the label alone.

## 4. Framing correction (does not refute)

In BOTH live producers the `at` stamp is taken AFTER the provider await resolves:
  line-shopping.js:39  const data = await gameOdds({ markets, ttlMs: 0 });
  line-shopping.js:42  const at = new Date().toISOString();
  book-feeds.js:380-388 await Promise.all(providers.map(async ... await PROVIDERS[name]() ...));
  book-feeds.js:390    const at = new Date().toISOString();
So the VALUE stored in received_at (= requested_at = at) is already a response-completion instant
(for book-feeds, after the slowest provider -- the conservative direction). What is wrong is the LABEL:
the callers do not pass receivedAt/receiptClockSource, so nfl-quote-tape.js:65 defaults to
legacy_request_time_only and the packet gates on that label. The fix is therefore a one-line option
change at each call site ({ requestedAt: at, receivedAt: at, receiptClockSource: 'response_completion' }
or better: a true pre-request stamp for requestedAt and `at` for receivedAt), not a new clock. The gap's
"CURRENT" wording ("requestedAt only") is literally accurate; the underlying `at` is not a request time.

Also noteworthy: migration 032_quote_receipt_clock.js:46 promises "New captures record the true clock from
the moment this ships." The two scheduled producers were never updated, so that promise is not kept by the
code -- which is the gap.

## 5. Bottom line
Not refuted. Code at every cited line does what the gap says; the only prospective-capable source is
quarantined as availability_unknown in every prospective packet; the one real frozen observation refused
18,692 pre-cutoff quotes from 12 books. Confidence high.
