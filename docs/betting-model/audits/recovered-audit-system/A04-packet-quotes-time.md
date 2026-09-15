# A04 — Packet, quotes and time semantics (reader A04-packet-quotes-time)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Date of read: 2026-09-11.
Plan contract read first: docs/CLAUDE-NEXT-STEPS.md sections 3 (C11, C12, C13), 4.1, 7.1–7.4, 9.2.
Every assigned file read in full (wc -l covered): 4,964 lines across 20 files, plus supporting reads of
migration 032/034, scheduler.js:770-810, routes/nfl-betting.js:1425-1460, book-feeds.js:400-425,
line-shopping.js:55-72, odds-archive.js:1-40 and grep lines, nfl-replay.js:80-110/186-210, date-util.js:17-50,
research/market_lab.py + tree_lab.py grep lines. DB facts come from `node:sqlite` `readOnly:true` against
server/data.sqlite (never the .bak files).

## Headline answers to the assigned questions

1. **Receipt vs book vs kickoff.** The code now carries four clocks per quote: `requested_at` (stamped before
   the HTTP request), `received_at` (meant to be response completion), `snapshot_at` (provider's snapshot
   instant; for live free feeds it is simply `requested_at` — nfl-quote-tape.js:36), and `book_updated_at`
   (the book's own last-update claim). Kickoff comes from `game_lines.gameday/gametime` in US Eastern, converted
   DST-correctly by `nflKickoffDate` in the runner and CLV, but with a **fixed −04:00 offset** in the packet's
   manifest and representative-packet helpers. The decision instant is kickoff − 60 min (`decisionCutoff`).
   The packet admits a quote only when `receipt_clock_source === 'response_completion'` AND
   `received_at <= cutoff` (nfl-t60-packet.js:214-216).

2. **The frozen packet contract and hash.** Two hash authorities exist and neither is used on the durable path
   in a reproducible way. The runner stores `sha256(JSON.stringify(packet))` — uncanonicalized, and the packet
   includes the wall-clock `computation_started_at` — and stores **only the hash**; there is no packet payload
   column (migration 034) and the `captured[].packet` array is discarded by `runT60Pass`. The section-4.1
   contract module `forecast-packet.js` has a canonical `packetHash` and a validator, but **no production
   code imports it** (grep: only its own test). "A hash without retained content cannot reconstruct a decision"
   (plan 4.1) describes the live ledger exactly.

3. **Production reality of the receipt clock.** In the live DB every one of the 1,321 quote batches carries
   `receipt_clock_source = 'legacy_request_time_only'`, including all 1,153 `book_feeds` batches captured
   2026-09-02 → 2026-09-12 (the Week 1 capture running right now). Cause: `book-feeds.js:417` and
   `line-shopping.js:66` call `ingestQuoteSnapshot` with only `requestedAt`, and nfl-quote-tape.js:65 defaults
   the source to legacy when `receivedAt` is absent. Consequence: `realClock` at nfl-t60-packet.js:214 is empty
   for every real game, so `received_by_cutoff` is unreachable for the quote tape in production. The single
   frozen observation (SF@LAR, cutoff 2026-09-10T23:35Z) therefore froze with **no eligible price**. The
   forward prospective ledger is structurally price-blind until the two free-feed producers pass a real
   `receivedAt`.

4. **Python dataset builder cutoff safety** (research/betting/nfl/dataset.py). It enforces: strict `<`
   comparisons for history and features (`history_before`, `features_before`), a 3-day publication proxy on
   gameday at week granularity (`week_end` = last game of the week + 3d), unparseable stamps → `None` → row
   dropped (never defaulted), fold cutoff = min(decision) − 7d with `label_at` strictly earlier, and
   `season < before_season`. It does NOT: check that `decision_at` precedes the row's own kickoff, call the
   leakage scanner (only tree_lab does), or build labels. There is no T-60 lab yet (research/betting/nfl holds
   only dataset.py + test_dataset.py). Labels in market_lab/tree_lab are against the OddsTrader **opening**
   line with the **closing** line as the movement target — both recorded per-book pairs, not the nflverse
   consensus.

5. **Historical tape timestamps: honest, but not decision-time.** Two distinct historical stores:
   - `nfl_quote_tape` 2020-25 rows come from **the-odds-api historical endpoint** (168 snapshot dates, batches
     received 2026-09-09T01:51-01:54Z, `mode='historical'`), NOT OddsTrader. Coverage: 1–4 provider snapshots
     per event (60/607/559/52 events), and of 3,159 event-snapshots 2,877 (91%) are >24h before kickoff, 73
     within 90 min, 9 after kickoff. So it is neither "last pre-kickoff" nor a decision-time path — it is a
     sparse weekly-ish set of provider snapshots whose `snapshot_at` is the provider's claim and whose
     `received_at` is honestly 2026-09-09. The packet correctly reports these as `late_arrival_excluded` in
     BOTH modes because no `publishedAt` is passed for quotes.
   - `nfl_odds_archive` / `nfl_line_snapshots(provider='archive:oddstrader')` 2022-26 (135,930 snapshot rows,
     2,310 events, fetched 2026-09-02T12:01-12:10Z) hold exactly two phases per book per event: `open` and
     `close` (OddsTrader `openingLines`/`currentLines`), stamped with the book's own `book_updated_at`
     (0 nulls). `close` rows: 33,202 within 60 min of kickoff, 16,241 ≤6h, 3,525 ≤24h, 5,117 >24h, and
     **9,785 (14%) after commence_time**. `open` rows: 29,070 >7d, 38,900 ≤7d, 90 ≤24h. So the archive IS
     "opening + last-posted-before-kickoff" only, with honest book timestamps but a receipt clock of
     2026-09-02. A `captured_at`-bounded reader at T-60 will mostly see the *open* row (and the close row only
     when the book's last change was earlier than T-60 — a selection effect: lines that stopped moving early).

6. **Does any historical audit use closing lines as if available at decision time? Yes, and it says so.**
   `nfl-replay.js:193/203` reads `game_lines.spread` as the market line for the 2021-25 replay; for those
   seasons `source='nflverse'`, `closing_spread` is NULL and `spread` is nflverse's closing consensus (differs
   from `open_spread` by ≥0.5 in 255/272, 229/267, 231/285, 203/285, 218/285 games per season). The file's own
   comment (nfl-replay.js:83-85) calls it "a number that does not exist yet at any point a real bet could have
   been placed" and adds opener regrades as separate fields — but notes those "still use a model number computed
   with the full closing-time feature set" (:108-109). `nfl-ensemble.js:1317` feeds `market_spread: g.home_spread`
   (same closing column) as the market-residual anchor. This is disclosed, not hidden, but it means the entire
   2021-25 "historical replay" CLV/ROI record is a beat-the-close exercise with closing-time features, and the
   −2.28 CLV figure should be read in that light (other readers own the CLV file; flagged here as leakage risk).

## Per-file notes

### server/services/nfl-t60-packet.js (459 lines) — `freezeT60Packet`, `decisionTimeManifest`, `representativePackets`
- Purpose: freeze a claim-labelled view of what six sources held at kickoff−60. Reads only; writes nothing.
- Tables read: nfl_quote_tape ⋈ nfl_quote_batches, nfl_injuries, nfl_news_events,
  nfl_game_weather_forecast_history, nfl_game_weather (oracle), nfl_team_week_features, game_lines (manifest).
- Time semantics: `beforeOrAt` (:81) uses Date parse; the quote predicate is a 1-second kickoff range +
  market/period (:185-191) then canonical-team scoping in JS (:204-207); receipt gate `response_completion`
  + `received_at <= cutoff` (:214-216). Injuries gated on `modified_at` (a mutation clock, not a receipt);
  news on `first_seen_time`; weather forecast on `fetched_at`; features have no clock → quarantined.
- Defects:
  - P1 (production-dead receipt gate): :214 `q.receipt_clock_source === 'response_completion'` — zero live
    batches satisfy it (see headline 3). Every prospective packet's quote entry is `late_arrival_excluded` or
    `availability_unknown` with the legacy note (:232-237).
  - P2 (scope): injuries by season/week only (:250-255); news **global** — no WHERE at all (:264-270);
    features whole-league (:308). `values` are supplied only for the tape (:240-243); all other sources
    persist counts (`values: null`). C11's "scope every input to the applicable event/team/player" and
    "persist actual rows" are done for one of six sources. The test at test/nfl-t60-packet.test.js:131-139
    encodes the defect: one news row about nobody makes `nfl_news_events` eligible for ATL–CAR.
  - P3 (silent mode fallback): :315 `ELIGIBLE_BY_MODE[mode] ?? ELIGIBLE_BY_MODE.prospective` while :323 echoes
    the bogus mode and :327 prints the PROSPECTIVE claim. Plan C11 close-with: "invalid mode/time fails
    explicitly". Test :379-383 accepts either behaviour.
  - P3 (two kickoff clocks): :378 and :434 build `${gameday}T${gametime}:00-04:00`; the runner uses
    DST-correct `nflKickoffDate` (t60-runner.js:51). A November game gets two different cutoffs an hour apart.
    Disclosed in `decisionTimeManifest.caveats` (:413-415); NOT disclosed in `representativePackets` output.
  - P3 (historical mode gives quotes nothing): no `publishedAt` is passed for the tape (:222-244), so
    `published_by_cutoff_evidenced` can never apply to prices; `snapshot_at` goes to `effective_at` instead.
    Defensible (a provider snapshot time is a third-party claim), but it means "historical" mode cannot ever
    reconstruct a priced packet from the 2020-25 tape.
- Verdict: the taxonomy and the quote predicate are correct and tested; the module is honest about what it
  cannot claim. But its one prospective-capable source is unreachable in production and five of six sources
  are still counts.

### server/services/nfl-t60-protocol.js (197 lines) — `decisionCutoff`, `cutoffBatches`, `sequentialCapacity`
- Pure functions, no DB. Cutoff = kickoff − 60 min (:40-50); batches keyed by cutoff ISO string (:60-70);
  capacity judged per batch with `released_at > batch.cutoff_at` string compare (:126-131); unknown release
  time = still held (:129). Ranking by `edge_points` desc then id (:136-138).
- Defects: none material. P3: `retrospectiveWeeklyCapacity` is kept as a comparison baseline and labelled
  NOT T-60-reproducible (:194-195) — good. `sequentialCapacity` is re-exported by the runner but the runner
  never calls it (no candidates flow into it yet).

### server/betting/nfl/strategy/t60-runner.js (298 lines) — the durable pass
- Tables: writes nfl_t60_observations (INSERT :87-92, UPDATE :121-134, :163-166), nfl_capacity_events
  (INSERT :188-218); reads game_lines (:48-49).
- Flow: `runT60Pass` = open (cutoff in [now, now+24h]) → capture (`state='scheduled' AND cutoff_at <= now`)
  → mark missed (`cutoff_at < now − 10min`). Registered as scheduler job `nfl_t60_runner` every 5 min
  (scheduler.js:785-799) for `currentNflWeek()` only.
- Time semantics: `now` is injectable; capture clocks recorded separately (:127-129); capacity events carry
  `occurred_at` distinct from `recorded_at` (migration 034:73-74).
- Defects:
  - P1 (hash without content): :127-129 stores `packet_hash` only; migration 034:33-58 has no payload column;
    :249-258 returns counts and drops `captured[].packet`. The frozen SF@LAR row (hash e2bcd98f…) has no
    reconstructible content anywhere. Violates plan 4.1 verbatim and C11 "persisted exact input payload".
  - P2 (non-reproducible hash): :141-143 `sha256(JSON.stringify(packet))` — no canonicalization, and the
    packet embeds `computation_started_at` (nfl-t60-packet.js:332 from :118). Re-freezing identical evidence
    yields a new hash; the hash cannot identify content. The canonical `packetHash` in forecast-packet.js is a
    second, unused authority.
  - P2 (`missed` is unreachable through the pass): :249 captures every `scheduled` row with `cutoff_at <= now`
    with no upper bound, THEN :250 marks missed. After a 3-hour outage the next pass "freezes" every overdue
    observation from stored receipts and none is ever `missed`. The packet contents remain cutoff-bounded (so
    this is not look-ahead), but plan 7.1's "declared processing/acceptance window" is not enforced and the
    10-minute `graceMinutes` is dead code on the durable path. test/t60-runner.test.js:74-83 only exercises
    `markMissedObservations` in isolation.
  - P3: `slotsHeldAt` string-compares `occurred_at <= at` (:231) — fine while all writers emit ISO-Z.
- Verdict: correct ledger shape and idempotency; the two P-level defects mean the durable path today records
  that a capture happened and nothing of what it captured.

### server/betting/nfl/contracts/forecast-packet.js (227 lines) — section 4.1 schema
- Validator lists all problems, refuses prospective + legacy clock (:127-130), refuses `received_at > cutoff`
  (:131-134), requires values not counts (:153-161), sorted-key canonical hash excluding `attempt` (:193-197).
- Defects: P2 (unwired): no producer or consumer in server/ (grep). The contract is a spec with a test, not a
  gate; `nfl-t60-packet.js` output does not conform to it (different shape: `sources[]` vs eight groups), so
  the two "one schema authority" modules cannot yet meet. P3: `feature_lineage.values` accepts any object
  (:154), so `{count: 3}` would pass the "not a count" rule.

### server/services/nfl-quote-tape.js (234 lines) — ingestion + readers
- Writes nfl_quote_batches, nfl_quote_tape (transactional, :101-122). `quote_id` = sha of the record incl.
  batch_id (:96) so identical prices in two batches are distinct rows (correct for a tape).
- Time semantics: `receipt = receivedAt ?? requestedAt`; source defaults to legacy when no receivedAt (:64-65);
  refuses receipt < request (:69-71); `unwrap` for current payloads sets `snapshotAt = requestedAt` (:36).
  `captureCurrentQuoteTape` (:127-138, paid Odds API only) is the ONLY producer that passes a real
  `receivedAt`; `backfillHistoricalQuoteTape` (:152-169) passes one too but marks rows historical.
- Defects:
  - P1 (shared with book-feeds/line-shopping): the two free producers never pass `receivedAt` — see headline 3.
    The fix is one argument at book-feeds.js:417 and line-shopping.js:66 (stamp `new Date()` after the awaits).
  - P3: readers `quoteSurface`/`closingQuotes`/`bestExecutableQuote` bound by `snapshot_at` (:181, :198, :213)
    which for live feeds is the request clock — the C11 defect in reader form. `closingQuotes` ignores
    market/period and matches by `provider_event_id` only (:193-202); no production caller found.
  - P3: `quoteTapeCoverage` hardcodes `production_eligible:false` (:232) — honest.
- Verdict: ingestion is correct when called correctly; it is not.

### server/services/nfl-quote-clock.js (10 lines) + test/quote-clock.test.js (14 lines)
- `captured <= now`, age ≤ 15 min, `kickoff > now`. Operates on `captured_at` (nfl_line_snapshots shape).
  No defects; note the 15-minute shopping age is a policy constant with no link to the T-60 cutoff.

### server/services/nfl-bitemporal.js (154 lines)
- Three clocks (published/observed/valid_from), closed provenance vocabulary, refuses observed < published
  (:68), read = newest with `published_at <= decision − 15min AND observed_at <= decision` (:99-104).
- Defects: none in code. P2 (coverage): `nfl_feature_revisions` is **empty** in the live DB (0 rows), so the
  "value as known" store the plan relies on for injury/news revision histories has never been fed. Every
  injury/news read in the packet still goes to mutable latest-value tables.

### server/services/nfl-postgame-truth.js (657 lines)
- Downstream-of-prediction truth packets; writes nfl_game_variance and nfl_postgame_truth_packets. Reads
  game_lines.spread as `market_margin` (:494) — the closing consensus, appropriate for a POSTGAME residual.
- Time semantics: `carryoverForTeam` uses `targetKickoff` (kickoff, or 23:59 ET if no time) as the news cutoff
  (:566) — a pregame read inside a postgame module. `frozenExpertComparison` (:374-402) prefers
  `nfl_expert_forward_predictions` (forward frozen) and falls back to `nfl_weekly_expert_examples` labelled
  `historical_algorithmic_replay` — good labelling.
- Defects: P3: module-level mutable `let driveShortField` (:472) shared across calls to
  `residualDecomposition` — a re-entrancy hazard, not a time defect. P3: `gameInjuryCarryover` marks
  `production_eligible:false` (:621) — honest.

### server/services/nfl-evidence-dataset.js (239 lines) + test (139 lines)
- Builds a quarantine-counted dataset from the tape; freezes under a content hash of filters+rows (:198-202).
- Time semantics: `snapshot_at > decision` → future_snapshot; `!(snapshot_at < commence_time)` → after_kickoff;
  `book_updated_at > snapshot_at` → book_ahead (:95-99). Uses `snapshot_at`, never `received_at`.
- Defects: P3: provenance `batch.mode==='historical' ? 'reconstructed' : 'captured'` (:140) labels every
  legacy-clock free-feed batch "captured", a stronger word than the bitemporal module's definition permits.
  P3: string comparison of mixed ISO spellings (`…43.112Z` vs `…43Z`) can misorder equal seconds. Test covers
  future_snapshot and after_kickoff only.

### server/services/nfl-evidence-provenance.js (62 lines)
- Walks frozen expert payloads for `*_at` stamps later than `evidence_cutoff`.
- Defects: P2: `evidence_cutoff` is the game's **kickoff** (:4-5), and `captured_at > evidence_cutoff` (:54)
  is also against kickoff — so a T-60 row that consumed T-15 evidence passes as "every stamped input predates
  its kickoff". The verifier cannot detect a horizon breach, only an in-play one. P3: `s.at > cutoff` string
  compare across formats (:36); STAMP_KEY also matches bare `at` and `created_at`-like keys, so a payload's own
  write timestamp can be flagged.

### server/services/nfl-evidence.js (179 lines)
- Registry/firewall. Runs INSERT … ON CONFLICT on import (:50-66) — a side effect at module load. Rules text
  is correct ("Import timestamps do not prove that a quote existed before kickoff", :175). `seasonCoverage`
  labels 2021-25 `development_only` and quote provenance `import_only` unless nfl_line_snapshots has rows —
  with the OddsTrader archive present those seasons now read `preserved_snapshots`, which overstates: the
  archive is open/close only (headline 5). P3.

### server/services/evidence-daemon.js (198 lines)
- Plans windows open/T-24h/T-6h/T-60m/T-15m/close per game; captures per NFL **week** (one capture serves
  every due window in that week, :106-146); marks `captured_at = now` (:81-84). Never backfills; reports
  missed windows (:179-195). Note the T-60m window here is a *capture* horizon unrelated to the T-60 runner's
  observation ledger — two independent T-60 notions with no link. P3. `eventDate` for NFL is DST-correct.

### server/services/game-cutoff.js (24 lines)
- "The one cutoff" = kickoff (not T-60), with a 23:59 ET fallback when gametime is unknown (:23) — admits a
  full day of injury news for time-unknown games; disclosed in the header. P3. There are therefore three
  cutoff notions in the tree: kickoff (`gameCutoff`), kickoff−60 (`decisionCutoff`), horizon windows (daemon).

### research/betting/nfl/dataset.py (278 lines)
- See headline 4. `stamp()` treats naive datetimes as UTC (:86) while `gameday` is an Eastern date — the 3-day
  lag swamps the 4-5 hour error. `load_games` reads `spread` but does not label. Read-only `mode=ro` + BEGIN
  snapshot (:97-100) is correct against the live writer. No defect above P3; the module has no T-60 consumer
  yet.

### research/leakage.py (97 lines)
- Single-feature out-of-fold R²≥0.98 / AUC≥0.985 scan. P2 (overclaim): the docstring names "the closing line
  captured as a feature" as the leak class it catches (:7-8), but a closing spread explains ~15-25% of margin
  variance and would never trip 0.98. It catches label copies only; it is called only from tree_lab.

### Tests
- test/nfl-t60-packet.test.js (399): strong on predicate/clock/claim taxonomy. Gaps: asserts the global-news
  defect as correct (:131-139); accepts silent mode fallback (:379-383); no DST/kickoff-conversion test; no
  test that a packet can be rebuilt from what the runner stored.
- test/t60-runner.test.js (159): exercises `markMissedObservations` alone (:74-83), never `runT60Pass` after an
  overdue cutoff — so the unreachable-`missed` ordering defect is untested. No test reads back a packet.
- test/forecast-packet-contract.test.js (193): thorough for the validator; nothing wires it to a producer.
- test/evidence-dataset.test.js (139): bitemporal + dataset happy paths; does not test `received_at`.

## Verdict
The clock taxonomy is right and the code says true things about itself. The forward ledger nevertheless
records nothing usable today: every live quote batch is legacy-clocked so the packet's only prospective source
is dead; the runner keeps a non-canonical hash and discards the content; the 4.1 contract is unwired; and the
historical replay's market line is the nflverse close by disclosed design. None of this changes the settled
negative-CLV conclusion — if anything the historical CLV was measured against the close with closing-time
features, so it is not evidence about T-60 at all.
