# F05 — Bitemporal / point-in-time data engineering, for the receipt-clock bug

Researcher: F05-bitemporal-pit (bucket: fix). Phase: ResearchFix.

## 1. The defect, confirmed by reading the code tonight

Tonight's finding says: "every quote batch defaults to a request timestamp, not
a response timestamp, so the forward evidence packet can never admit a real
price." I read `book-feeds.js`, `nfl-quote-tape.js`, migration
`032_quote_receipt_clock.js`, and the live schema in `nfl-n-to-z.js` to find
out exactly where this is still true, because a Codex correction (C11) already
landed on 2026-09-10 and I needed to know what it actually fixed.

**What C11 (migration 032) actually fixed:** it added `received_at` and
`receipt_clock_source` to `nfl_quote_batches` (the batch/manifest table) and
taught `ingestQuoteSnapshot()` in `nfl-quote-tape.js:61-72` to accept an
explicit `receivedAt` distinct from `requestedAt`, with a `receiptClockSource`
enum (`'response_completion'` vs `'legacy_request_time_only'`). The T-60
packet (`nfl-t60-packet.js:176-227`) joins back to `b.received_at` /
`b.receipt_clock_source` and refuses `received_by_cutoff` for any batch not
marked `response_completion`. That part is real and correct.

**What is still broken, in the two files this brief named:**

1. **`book-feeds.js:390-419` — the live path never sets `receivedAt`.**
   `captureBookFeeds()` awaits `Promise.all(providers.map(...))` (line 380-388,
   the actual network round-trips to Pinnacle/FanDuel/Kambi/Bovada/OddsTrader),
   *then* computes `const at = new Date().toISOString()` (line 390) — which is
   genuinely a post-response receipt timestamp. But at line 417 it calls
   `ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, ... })`
   — passing the receipt-quality timestamp in as `requestedAt` and never
   supplying `receivedAt` at all. `ingestQuoteSnapshot`'s default
   (`receivedAt = null` → `clockSource = 'legacy_request_time_only'`) then
   fires, so **every batch this feed has ever written, including the batches
   capturing this weekend's live Week 1 games, is permanently labeled
   `legacy_request_time_only`** and the T-60 packet's `realClock` filter
   (`nfl-t60-packet.js:214`) throws every one of its quotes into
   `availability_unknown`. The free-book-feeds path is the one actually
   running right now (the paid Odds API credits are gone — see book-feeds.js's
   own header comment) — so this is not a cold, historical bug, it is actively
   discarding the live evidence stream's eligibility for any prospective
   claim, for a reason that has nothing to do with when the data really
   arrived.
   - One-line-shaped fix: capture `requestedAt` *before* the `Promise.all`,
     keep `at`/`receivedAt` as the post-await timestamp, and pass both plus
     `receiptClockSource: 'response_completion'` into `ingestQuoteSnapshot`.
   - Secondary, smaller defect in the same block: `at` is one shared instant
     for all 5 providers dispatched in the same `Promise.all`, so a provider
     that resolves in 200ms (Pinnacle) is stamped with the same receipt time
     as one that resolves after a 25s timeout (a slow scrape) or a provider
     that failed and backed off. This under-states freshness for fast
     providers rather than over-stating it (safe direction), but it still
     means no per-provider receipt clock exists — see candidate F05-N3 below.

2. **`nfl-quote-tape.js`'s `unwrap()` (lines 35-41) — the per-quote clock
   used by every query in the file is still `requestedAt`, never `receivedAt`,
   regardless of migration 032.** `ingestQuoteSnapshot` calls
   `unwrap(payload, requestedAt)` (line 72) — note: `requestedAt`, not
   `receivedAt`, is threaded through, even in a call that *did* supply a good
   `receivedAt` (e.g. `captureCurrentQuoteTape` at line 130-137, which computes
   its own well-formed pre/post pair). For a "current" (array) payload —
   which is what both the free-book-feeds path and the live Odds API
   `gameOdds()` call produce — `unwrap` returns
   `snapshotAt: requestedAt` unconditionally (line 36). That `snapshot_at`
   value is what gets written to every row in `nfl_quote_tape`
   (`nfl-quote-tape.js:87`) and is the *only* clock that
   `quoteSurface()` (line 176-190, `at: atTime` filters on
   `snapshot_at<=?`), `closingQuotes()` (line 192-206, the closing-window
   query), and `bestExecutableQuote()` (line 208-221, `at: atTime` filter)
   ever look at. Migration 032's fix lives one join away, at the batch level;
   these three exported functions — the natural point-in-time query surface
   for this table — silently still operate on request time. (They currently
   have zero callers elsewhere in the repo — `grep -rl` found none outside
   `nfl-quote-tape.js` itself — so today this is a latent defect in an
   unwired API surface rather than one actively corrupting a decision, but it
   is exactly the surface anything doing real point-in-time execution
   analysis would reach for next, and it would silently reintroduce the
   look-ahead C11 was written to remove.)
   - Fix: thread `receivedAt` (defaulting to `requestedAt` only when no better
     value exists, exactly as migration 032 already does for the batch table)
     into `unwrap()`, and — better — add `received_at` /
     `receipt_clock_source` columns to `nfl_quote_tape` itself (currently
     absent from the schema at `nfl-n-to-z.js:390-413`) so each row, not just
     each batch, carries the honest clock and the three PIT query functions
     can filter on it directly without a join back to `nfl_quote_batches`.

3. **The table is already append-only/immutable** —
   `nfl_quote_tape_no_update` / `nfl_quote_tape_no_delete` triggers exist
   (`nfl-n-to-z.js:811-814`) and abort any UPDATE/DELETE. This is *already*
   the append-only correction pattern the brief asks about, applied correctly
   at the DDL level — Gridiron did not need to be told to avoid mutating
   quote history. What it lacks is a way to formally link a corrected/re-fetched
   row back to what it corrects (see F05-N1).

## 2. Sources read

### Read in full (the relevant sections)

1. **Akidau et al., "The Dataflow Model: A Practical Approach to Balancing
   Correctness, Latency, and Cost in Massive-Scale, Unbounded, Out-of-Order
   Data Processing"** — VLDB 2015 (Proc. VLDB Endowment 8(12):1792-1803).
   https://www.vldb.org/pvldb/vol8/p1792-Akidau.pdf
   Read pages 1-4 (abstract, intro, and all of §1.3 "Time Domains") in full.
   **Exact definitions (their §1.3):** *"Event Time, which is the time at
   which the event itself actually occurred, i.e. a record of system clock
   time (for whatever system generated the event) at the time of
   occurrence,"* vs *"Processing Time, which is the time at which an event is
   observed at any given point during processing... according to the current
   [system] clock."* This is precisely Gridiron's `book_updated_at` (event
   time — when the book actually moved the line) vs `received_at`/`snapshot_at`
   (processing time — when Gridiron's process observed it) vs the bug's
   `requestedAt` (neither — an artifact of when the HTTP call was issued, not
   when anything happened or was observed). Their watermark concept — *"a
   lower bound (often heuristically established) on event times that have
   been processed by the pipeline"* (§1.3, footnote 6) — is the production
   analogue of what a "coverage watermark" per quote batch would give
   Gridiron (candidate F05-N3): an honest, monotonic answer to "how much of
   the market's evidence do we actually have as of decision time D," instead
   of silently treating a failed/backed-off provider poll as equivalent to
   "no line exists." Sample (their Figure 2 caption paraphrase, not verbatim
   quote): real production watermarks lag and catch up in bursts, never
   moving smoothly with wall-clock time — exactly what would show up in
   Gridiron's own OddsTrader-staleness numbers (book-feeds.js:56-70, median
   288h stale for Unibet). This is a Google production-system paper
   (Cloud Dataflow / MillWheel / FlumeJava lineage), not a toy model —
   evaluated against real deployed pipelines at Google, not a benchmark suite.

2. **Kulkarni & Michels, "Temporal features in SQL:2011"** — ACM SIGMOD
   Record 41(3), Sept. 2012, pp. 34-43.
   https://cs.ulb.ac.be/public/_media/teaching/infoh415/tempfeaturessql2011.pdf
   Read pages 1-5 (through the start of §2.3) in full. Exact mechanism:
   SQL:2011 does **not** add a period data type; it adds `PERIOD FOR
   <name> (<start_col>, <end_col>)` metadata to an ordinary pair of
   datetime columns (§2.1) — i.e., exactly the retrofit shape Gridiron needs:
   no new column type, no table rewrite, just declaring what two existing (or
   two new) columns mean. Two independent period kinds: **application-time
   period tables** (valid time — user sets start/end, e.g. "when was this
   line actually posted") via `PERIOD FOR EPeriod (EStart, EEnd)`, and
   **system-versioned tables** (transaction time — the *system*, never the
   user, sets start/end, on every UPDATE/DELETE the old row is preserved
   with its period closed rather than overwritten) via the reserved
   `SYSTEM_TIME` period name. Concrete syntax sample from the paper:
   `UPDATE Emp FOR PORTION OF EPeriod FROM DATE '2011-02-03' TO DATE
   '2011-09-10' SET EDept = 4 WHERE ENo = 22217` — the DBMS automatically
   splits the existing row into up to three contiguous rows so no historical
   period is silently destroyed (p.36-37). A table can have *both* period
   kinds at once — that is the formal name for "bitemporal." Honest
   limitation the paper is explicit about: valid time and transaction time
   are *independent* and near-universally differ for the same fact (an
   insurance policy inserted long before or after it takes effect, §2 p.35) —
   which is exactly the shape of Gridiron's bug: `book_updated_at` (valid/event
   time) and `received_at` (transaction/system time) are allowed to differ,
   but `requestedAt` was being smuggled in as a stand-in for the wrong one.

3. **Snodgrass, *Developing Time-Oriented Database Applications in SQL***
   (Morgan Kaufmann, 1999), freely hosted at the University of Arizona.
   http://www.cs.arizona.edu/~rts/tdbbook.pdf — read pp. 9-14 (end of ch.1,
   start of ch.2, "Fundamental Concepts / Valid-Time State Tables") in full.
   This is the canonical academic textbook the SQL:2011 authors and every
   later bitemporal implementation (including the two repos below) cite.
   Concrete real-world cost example given (p.11): the 1997 Hudson Foods
   E. coli recall of 25 million pounds of beef — traced back to *"the lack of
   a database that could track the [beef] patties back to the slaughterhouses"*
   — cost the company $25 million, precisely because no time-varying (valid-
   time) record existed to say which lots of meat were coresident with which
   at what interval. Fundamental definition used throughout: a valid-time
   state table adds `FROM_DATE`/`TO_DATE` (or equivalent) to record when a
   fact was true *in the modeled reality* — this is Gridiron's missing
   "when did the book actually publish this line" as a first-class column,
   as opposed to only recording when Gridiron's scraper happened to see it.
   Also gives the three-way query taxonomy (current / sequenced /
   nonsequenced) that maps directly onto what a T-60-style "as of" query
   needs to support.

### Read for practical grounding (not academic, engineering docs)

4. **Databricks, "Point-in-time feature joins" (feature store docs).**
   https://docs.databricks.com/aws/en/machine-learning/feature-store/time-series
   Read in full. Key mechanism: an `AS OF` join filters a feature table to
   the latest row with `timestamp <= label_timestamp`, i.e. exactly
   Gridiron's `bestExecutableQuote`/`quoteSurface` shape. **Honest finding
   for the do-not-do list:** this widely-used production feature-store
   pattern makes *no distinction whatsoever* between an event timestamp and
   an ingestion/receipt timestamp — it treats the single "timestamp" column
   as authoritative for both purposes. That is the *exact* failure mode
   Gridiron's bug reproduces (collapsing two clocks into one), which is why
   naively copying a feature-store's AS-OF join pattern into Gridiron without
   the SQL:2011-style two-clock discipline would just re-create the bug in a
   new place — a caution worth stating explicitly (see do_not_do).

## 3. Real GitHub bitemporal implementations found

| repo | stars | last push | license | what it is |
|---|---|---|---|---|
| `arkhipov/temporal_tables` | 1,050 | 2026-01-12 (active; CI green) | BSD-2-Clause | Postgres C extension. Adds a `versioning(system_period_col, history_table, adjust)` trigger fired `BEFORE INSERT OR UPDATE OR DELETE`. Retrofit recipe, verbatim from its README: `ALTER TABLE employees ADD COLUMN sys_period tstzrange NOT NULL;` then `CREATE TABLE employees_history (LIKE employees);` then attach the trigger — **no rewrite of the existing table**, old rows migrate to the history table only on their first UPDATE/DELETE after the trigger is attached. |
| `scalegenius/pg_bitemporal` | 163 | 2022-04-20 (stale — last real commit 2021-07-06) | BSD-3-Clause | PL/pgSQL framework for *full* bitemporal tables (both valid-time and system-time together, with correction functions like `ll_bitemporal_correction_hist.sql`). More complete than `temporal_tables` (handles corrections, not just versioning) but unmaintained for 4+ years — read for the correction-pattern *idea* (a correction is a new row with a new system-time period that logically supersedes, never mutates, the old one), not as something to depend on. |
| `xtdb/xtdb` | 3,061 | active | MPL-2.0 | Full bitemporal Datalog/SQL database (valid-time + system-time queryable independently, "time-travel" queries built in). Too large a dependency to adopt for one table, but its core idea — query results are always parameterized by *both* a valid-time-as-of and a system-time-as-of — is the right mental model for what `quoteSurface(..., at: atTime)` should mean, and currently doesn't, since `atTime` filters `snapshot_at` which conflates the two. |

Gridiron uses `node:sqlite` (`server/db/index.js:1`, `DatabaseSync`), not
Postgres, so none of these ports directly — `adopt: borrow-idea` /
`reference-only` for all three. The pattern (add columns, don't rewrite;
attach a trigger; archive-on-write, never mutate-in-place) is exactly what
Gridiron's own migration 032 and its existing `nfl_quote_tape_no_update`
trigger already do by hand — the gap is completeness (per-row receipt clock,
formal correction linkage), not the absence of the underlying technique.

## 4. Candidates

See structured output. 4 "fix" candidates tied to the exact receipt-clock
defect in `book-feeds.js` / `nfl-quote-tape.js`; 4 "new" candidates
(per-row receipt clock as a first-class PIT contract module, formal
correction/supersession chain, provider-level coverage watermark, and a
bitemporal-aware backtest join) that Gridiron has no equivalent of today.

## 5. Do not do

- Do not backfill `received_at` on existing `nfl_quote_tape` rows from
  `snapshot_at`/`requested_at`. Migration 032's own comment explains why:
  *"It would be one line to set received_at = requested_at for every
  existing batch... That is precisely the defect, written into the data
  instead of the query."* The same argument applies one level down, at the
  quote-row grain — a per-row backfill would be the identical mistake in a
  new column.
- Do not adopt a Postgres bitemporal extension (`temporal_tables`,
  `pg_bitemporal`) as a dependency. Gridiron runs `node:sqlite`; there is no
  migration path onto Postgres in scope, and pulling in a C extension for a
  database engine the project doesn't use is pure risk for zero benefit —
  borrow the *pattern* (trigger + shadow/history table, ADD COLUMN not
  rewrite) in plain SQLite DDL instead.
- Do not copy a feature-store-style single-timestamp `AS OF` join
  (Databricks/Feast pattern) verbatim. It does not distinguish event time
  from receipt time and would silently reintroduce exactly the collapse
  that caused tonight's bug.
- Do not touch `nfl_quote_batches` or `nfl_quote_tape`'s immutability
  triggers to "fix" the clock retroactively by allowing an UPDATE. The
  correction pattern is: insert a new, correctly-clocked row/batch that
  supersedes the old one; never lift the append-only guarantee that's
  already correctly enforced.
- Do not run any of this against the live database tonight — Week 1 games
  are being captured through Sunday; `fantasy-football-dashboard` is
  read-only for this research pass.
