# s1-news — news, information timing, and whether a speed edge actually exists

Reader: sweep s1-news. Repo read-only. Date 2026-09-12. All DB observations via `node:sqlite` `readOnly:true`.
Baseline read in full: `scratchpad/WHAT_NEXT.md` (244 lines) and `scratchpad/audit/G12-news.md` (185 lines).

## 0. The one-paragraph answer

**There is no news-speed edge available from this architecture, and the data says so unambiguously.** Measured
end to end: a story reaches `nfl_news_signals` a median of **19.8 hours after publication** (Schefter's own
tweets: 8.7h median; only 14.1% of all signals inside an hour). A paid odds capture triggered by that news fires
a median of **24 hours after publication** (p90 91h, max 297h). Meanwhile the market's own catch-up window —
the time between the first book moving and the rest following — is about **100 minutes**. The pipeline is an
order of magnitude too slow, and no amount of tuning closes a 20-hour gap against a 2-hour window. Say this
plainly and stop investing in news *latency* as an edge.

**But the measurement that produced that verdict found something else worth having.** The ~100-minute cross-book
catch-up lag is real, is visible at 5-minute resolution in data already on disk, and **requires no news at all** —
the trigger is "book A moved, book B hasn't," observable directly. The codebase currently treats this as a data-
quality defect to be filtered out (`nfl-shopping-board.js:21-24` makes discarding it the module's cardinal rule;
`book-feeds.js:72` sets the staleness threshold at 72 hours, roughly 40× coarser than the effect). That is a
structural/execution question of exactly the kind this project has actually found edges in — and it is not in
the plan in any form. It is **not yet an edge**: my own 10-wave CLV check came back 0/10 positive. It is a cheap,
well-posed research question with the data already captured.

Everything else below is defects in the instruments that were supposed to answer these questions.

---

## 1. Q1 — What exists, what is dead

Confirmed G12-news's inventory; I will not restate it. Three corrections/additions to that audit:

- **`nfl_verified_events` is NOT only weekly-roster observations.** G12-news:10 says it "is not news verification
  at all — it is ... nflverse weekly-roster observations." In fact **39,052 rows are `official_injury_report`
  with `time_precision='timestamp'`**, built by `nfl-event-archive.js:81-96 materializeInjuryEvents()` from
  `nfl_injuries.modified_at`. 8,258 of them are the line-moving statuses (`Out%`/`Doubtful%`/`%Reserve%`). That is
  the richest timestamped-fact set in the database and the audit wrote it off.
- **`nfl-news-market-latency.js` has a second exported function the audit never mentions**:
  `verifiedEventMarketLatency()` (line 96), which runs the same latency study over that injury archive. It has a
  live consumer: `beat-the-close.js:364`.
- **Dead in practice, not in wiring**: `verifiedEventMarketLatency` is wired but structurally returns zero (§3).

## 2. Q2 — The known defects: status and additions

**Both P1s are UNFIXED in the working tree, and neither appears anywhere in `WHAT_NEXT.md`.**

- **D1** (every player inherits the story's first-matching status) — still present verbatim at
  `server/services/nfl-news-signal.js:144-163`: `text` is the whole headline+body (line 136), `text.match(rule.re)`
  is evaluated once per story inside the per-player loop, and `STATUS_RULES[0]` is still the
  `/\b(?:waived|released|cut|terminated)\b/i` transaction rule at line 69.
- **D2** (WAS/NO matching the English words) — still present: `server/news/normalize.js:20` still includes
  `entity.abbr` in the alias list, and `server/news/ingest.js:48-49` still passes `abbr` for every team.

Plan sections checked for these: Step 1 (close out what's built — lists the 16-piece fix build and the model
build, no news items), Step 5b (architecture refinement, NFL betting — engine disputes and merge verdicts only),
Step 6 item 18 (the four under-verified subsystems: fantasy draft/trade, props, drive simulator, betting routes —
**news is not among them**). No news defect appears in the plan at all.

**Three additions to D1 the audit did not name:**

1. `nfl-news-signal.js:139` computes `bodyPart` **once per story** and attaches it to every player in that story.
   Same root cause as D1, a different column: a story naming three players and one ankle stamps "ankle" on all three.
2. `teamForEntity()` (`nfl-news-signal.js:96-102`) resolves a player's team from `players.team_id` — the player's
   **current** team, not his team at publication. For any backtest over stored news this is a lookahead.
3. **D1's wrong claims are dispatched with the highest priority.** `nfl-capture-dispatch.js:52` sets
   `priority = signal.confidence`, and the `released` rule carries the table's top confidence (0.95). Of 157
   news-signal triggers, **19 sit at priority 0.95** — the exact fingerprint of the fictional-release rule. The
   dispatcher orders `ORDER BY priority DESC` (line 60), so the fiction is spent on first.

## 3. Q3 — FIX #29 verified, characterized, and quantified

**Confirmed: not in the plan.** Sections checked: Step 5 (items 11-15, remaining betting/simulation), Step 5b,
Step 5c (GitHub/research leftovers), Step 6. Nothing touches news latency or `nfl-news-market-latency.js`.

The defect, exactly (`server/services/nfl-news-market-latency.js:49`):

```js
reacted: Boolean(prior && ((lineMove != null && Math.abs(lineMove) >= 0.5) || (priceMove != null && Math.abs(priceMove) >= 5))),
```

An absolute threshold on a single (event, book, market, side) pair, with **no reference to what the rest of the
board was doing in the same window**. Nothing upstream or downstream supplies that baseline: `nflNewsMarketLatency`
(line 56) reports `claims_with_observed_reaction` and `median_news_to_reaction_minutes` as raw counts, and
`research_eligible` (line 80) gates on sample size only. `next_gate` (line 82) does say "run direction and placebo
audit" — so the author knew; it was never built.

**I measured the null it is missing**, on the live tape (`nfl_line_snapshots`, 2026-09-05..09-12, 1.45M rows,
2,712 series). Applying the exact line-49 rule at 90 randomly chosen pivot times with the next quote inside an hour:

| pivot percentile | share of the board flagged `reacted` |
|---|---|
| median | 1.4% |
| p75 | 3.4% |
| p95 | 5.6% |
| p99 / max | 7.0% |

And per capture-minute (2026-09-09..09-11, 568K rows, 354 minutes with ≥300 comparisons):

| | share of every (event,book,market,side) moving in that minute |
|---|---|
| median minute | 0.35% |
| p90 | 4.34% |
| p99 | 8.39% |
| **worst minute (2026-09-09T21:40)** | **17.0%** |

So a claim whose first post-claim quote lands in a leaguewide repricing minute gets `reacted: true` on up to
**17% of its pairs versus a 0.35% median baseline — a ~48× inflation with zero causal content.** That is precisely
the failure Nick described: a leaguewide vig shift reads identically to real news.

**Also worth naming: 56% of the false positives are price-only.** In the placebo run, 807 of 1,439 flagged pairs
moved on price alone with no line change — a ≥5-cent juice wiggle, which for American odds is a routine vig
adjustment, not a market reacting to information. The 0.5-point line threshold and the 5-cent price threshold are
being OR'd as if they were the same kind of evidence.

**The fix is small and exact**: compute the identical rule over every event *not* involving the claim's team in the
same window and report the excess (claim rate minus control rate) with a bootstrap interval, instead of the count.
Everything needed is already in the query at line 60.

## 4. Q4 — THE REAL QUESTION: is there a timing edge?

### 4a. How fast does this system actually learn things — measured

`nfl_news_signals`, all 498 rows, `created_at` minus `published_at`:

| percentile | hours from publication to the system having a typed signal |
|---|---|
| p10 | 0.32 |
| p25 | 7.60 |
| **p50** | **19.79** |
| p75 | 43.18 |
| p90 | 97.62 |
| max | 315.5 |

Share inside 1 hour: **14.1%**. Inside 15 minutes: **9.8%**.

By source (median hours): ESPN RSS **0.75** (n=131, the one fast lane) · ESPN Transactions 16.97 (n=66) ·
**Twitter/AdamSchefter 8.71** (n=19) · Twitter/RapSheet 21.34 (n=18) · Twitter/jamisonhensley 19.79 (n=20) ·
Twitter/MikeTriplett 56.91 (n=14).

The Twitter numbers are the direct consequence of G12-news D7 (108 handles at 5 per 4h ⇒ each handle every ~3.6
days, `twitter-ingest.js:119,195`). Schefter is read on the same rotation as a 64th-ranked beat writer.

And the money follows even later. Joining `nfl_capture_triggers` (source `news_signal`, n=157) back to the signal's
`published_at`: median **23.98 hours** from publication to the paid capture trigger, p75 48.85h, p90 91.23h, max
297.48h. The module's own header claims it exists to "spend metered odds credits only after free evidence says the
market moved" (`nfl-capture-dispatch.js:1-4`). It is spending them on day-old news. Root cause is at line 37:
the query filters `created_at>=datetime('now','-120 minutes')` — the **row-insertion** clock, not the publication
clock — so a five-day-old tweet ingested today is treated as breaking.

*(Side observation, in passing: `nfl_capture_triggers` holds 601 pending + 185 deferred `espn_move` rows against
exactly 1 captured. The free-movement detector is producing triggers that are essentially never dispatched.)*

### 4b. How fast does the market actually move — measured

`nfl_line_snapshots`, spreads, 2026-09-04..09-12, 510,070 rows → 570 (event, book, side) series → 796 distinct line
transitions. Grouping same-direction transitions across books within 6 hours gives **38 move waves with ≥4 books**:

| | median book's lag behind the first mover | slowest book's lag |
|---|---|---|
| p25 of waves | 32.6 min | 146.6 min |
| **median wave** | **102.0 min** | **220.4 min** |
| p75 | 174.8 min | 258.1 min |
| p90 | 259.3 min | 311.1 min |

Capture resolution supports this: ~200 distinct capture minutes/day during active windows (roughly every 5-7
minutes), not the "roughly twice daily" the code still tells Claude at `nfl-tweet-line-correlation.js:122` and not
the "hourly" in `nfl-news-market-latency.js:123`. Both comments are stale.

### 4c. The verdict, stated plainly

**No.** A retail bettor running this pipeline is not fast enough and cannot be made fast enough by tuning. The
system learns about a Schefter tweet ~9 hours after he sends it; the slowest book in a wave has fully caught up in
under 4. Polling ingestion (4-hour sweeps, 15-60 minute extractor runs) cannot compete with a market that finishes
repricing in under two hours. Competing on news *speed* would require push/streaming ingestion, a different
architecture and a different cost structure, and would still be racing people whose entire business is that race.
**Do not build it.**

### 4d. What the same measurement did turn up

The wave study needs no news. The observable is "book A moved, book B hasn't," and the window is a median 102
minutes. The repo has the data at 5-minute resolution and currently throws the signal away on purpose:

- `nfl-shopping-board.js:21-24`: *"THE ONE RULE THIS MODULE MUST NOT BREAK: only ever compare quotes captured at
  the same instant. Comparing a stale book against a fresh one measures latency and reports it as dispersion,
  which would manufacture edges that do not exist."* Correct for measuring dispersion. But a stale book is not a
  measurement artifact when you can actually bet it — it is the opportunity.
- `book-feeds.js:72`: `STALE_BOOK_HOURS = 72`, with a well-documented rationale (aggregator caching, Unibet's
  median 288h stamps). At 72 hours it passes a 3-hour-stale quote through as fresh — roughly 40× too coarse to
  see the effect measured above.

**Skeptical caveats, all of which must be tested, not waved through:**

1. **The direction is unproven and my one attempt was negative.** Of the 38 waves, only 10 had a usable closing
   consensus; taking the lagging book's stale line scored **0/10 positive, mean −0.30 points of CLV**. Sample far
   too small to conclude either way, and my sign convention may be inverted — but it is not support, and I will
   not present it as such.
2. **Closing coverage is thin.** Only 4 of the 9 events in the tape whose kickoff has passed had any capture inside
   60 minutes of kickoff; the other 5 were last captured days before. CLV measurement on the live tape is
   currently ~44% covered. This matters for the whole CLV program, not just this idea.
3. **The lag ranking is not yet trustworthy.** Measured average lag behind the first mover, waves ≥5: bodog 69.5min ·
   sportsbetting 72.1 · betrivers 72.3 · unibet 79.5 · betonlineag 84.2 · gtbets 88.2 · everygame 93.6 · bovada 93.9 ·
   lowvig 115.6 · heritage 121.6 · **pinnacle 201.2**. Pinnacle appearing slowest is almost certainly an artifact:
   this study detects *line-level* transitions, and Pinnacle expresses moves in juice. A half-point study is the
   wrong instrument for a book that reprices in cents — which is the same conflation as FIX #29's OR'd thresholds.
4. **The laggards are mostly offshore/low-limit books** (bodog, betonlineag, bovada, everygame, lowvig, heritage).
   Limits and account longevity are a real constraint on anything built here.
5. **38 waves in one week** — about two spread waves per game. A season accumulates enough; one week does not.

## 5. Q5 — The never-delivered "trace one news fact to a numerical effect"

**The packet records the wrong news table.** `nfl-t60-packet.js:271` adds a source entry for `nfl_news_events` —
the Package E table, **30 rows total**, manual-extraction-only, never consumed by any forecast.
`nfl_news_signals` — the 498-row table that actually feeds the online-neural features, the council's
`news_reaction` expert, postgame-truth's carryover probability, the fantasy news-edge actions, and the paid capture
triggers — **is not in the packet at all.** So even once a forecast consumes a frozen packet, the news fact it acted
on will not be in that packet.

The good news is that the gap is small. `nfl_news_signals` already carries both clocks the packet contract wants:
`published_at` (the fact's clock) and `created_at NOT NULL DEFAULT (datetime('now'))` (this system's receipt clock).
One `sourceEntry({ source: 'nfl_news_signals', ... })` alongside the existing injuries and news-events entries makes
it packet-legal.

**One trap to avoid when doing it.** `created_at` is written by SQLite's `datetime('now')`, i.e. space-separated
(`'2026-09-13 01:08:20'`) — all 498 rows. The packet compares `<= cutoffAt` where `cutoffAt` is ISO-T with a `Z`.
Because `' '` (0x20) sorts before `'T'` (0x54), `'2026-09-05 23:59:00' <= '2026-09-05T00:01:00Z'` evaluates **true**.
A naive string comparison admits up to a full day of future rows into the packet — a real lookahead, not a cosmetic
one. Normalize to ISO on read or on write. (This is the same string-form hazard G12-news flagged as cosmetic in
D13 and D10; here it would be load-bearing.)

Then the full trace is: packet row (fact + receipt clock) → `teamNewsSignals()` burden → the council's
`news_reaction` forecast `clamp(burdenEdge*0.75, ±4)` → the decision. Every link exists; only the first is missing.

## 6. Instrument defects the audit and the plan both missed

### 6a. The news-latency instrument's two halves do not overlap in time — it can never return a number

- `verifiedEventMarketLatency()` requires `time_precision='timestamp'`. Those events exist: 8,258 line-moving ones.
  **They all end 2025-01-04** (`MIN 2021-09-08`, `MAX 2025-01-04T19:53:37Z`).
- The intraday price path exists only in **2026-09** (1,902,536 of 2,041,217 snapshot rows). Every prior month holds
  7-8K rows — openers and closes, exactly as `nfl-news-market-latency.js:123` admits ("the archive holds only
  openers and closes and contributes no path").
- `beat-the-close.js:364` calls it as `verifiedEventMarketLatency({ limit: 400, since: '2026-08-01T00:00:00Z' })`.
  I ran that exact predicate: **0 rows.** The `event_to_move_window` panel on the one live betting-execution
  surface is permanently empty and reports no error.
- The other half, `nflNewsMarketLatency()`, *does* overlap the tape — its 368 verified claims run 2026-08-19 to
  2026-09-13 — but it is fed by the D1/D2-defective rules extractor, so its inputs are polluted with fictional
  "released" claims and WAS/NO misattributions.

**One instrument, two halves: the half with good inputs has no price path; the half with a price path has bad inputs.**

### 6b. The cause is a silent column break, and the monitor built to catch it reports healthy

`nfl_injuries.modified_at` by season: 2021 **5,348/5,348** · 2022 **5,449/5,449** · 2023 5,451/5,599 ·
2024 5,952/6,213 · **2025 0/5,783** · **2026 0/182**.

`nfl-advanced.js:325` reads `r.date_modified` from the nflverse injuries CSV. For 2025 and 2026 it is always null —
the rows ingest fine, the timestamp silently does not. `materializeInjuryEvents()` then drops them at
`nfl-event-archive.js:85` (`AND modified_at IS NOT NULL`) with no error, which is why the event archive has zero
`official_injury_report` rows for 2025 and 2026.

**And the purpose-built blackout detector is blind to it.** `nfl-offseason-cycle.js:144-165` exists precisely for
this class of gap (its own comment: *"the exact class of gap this module exists to fix was only found tonight by
accident"*). It does:

```js
present = rows(`SELECT DISTINCT strftime('%Y-%m', ${column}) ym FROM ${table} ORDER BY ym`).map(r => r.ym);
const trackedFrom = present[0];
gaps[table] = [...seasonMonths].filter(ym => ym >= trackedFrom && ...)
```

With NULLs present, SQLite sorts NULL first, so `present[0] === null`, and in JS every `ym >= null` is false.
I ran it: `present[0] = null`, `'2025-09' >= null → false`. **`gaps.nfl_injuries` comes back `[]` and
`healthy: true` while two full seasons of timestamps are missing.** Two-character fix (`WHERE ${column} IS NOT NULL`),
but the consequence is that nothing has flagged a 20-month data break.

Practical note: 2025 is only worth backfilling for completeness — its price side is openers/closes only. **2026 is
the one that matters**, because it is the only season with both a live intraday tape and a growing injury feed, and
every week it stays broken is a week where the instrument cannot be built.

### 6c. The tweet→line instrument takes its "pre-tweet" baseline *after* the tweet, 97% of the time

`nfl-tweet-line-correlation.js:51-53` baselines a tweet against
`WHERE captured_at = (SELECT MAX(captured_at) FROM nfl_line_snapshots)` — the newest capture in the whole table at
the moment of ingestion. It never compares that to the tweet's `published_at`. Because the sweep reads each handle
only every ~3.6 days, the "baseline" is routinely taken days after the news it claims to precede.

Measured over all **21,564** `nfl_tweet_line_watch` rows (`baseline_captured_at − tweet_published_at`):

| percentile | hours |
|---|---|
| p10 | +15.5 |
| p25 | +40.5 |
| **p50** | **+121.8 (5.1 days)** |
| p75 | +264.5 |
| p90 | +478.1 |

**97.1% of baselines are taken after the tweet; 97.0% more than an hour after.** The instrument is measuring line
drift over an arbitrary window that opens, on median, five days after the event it attributes the drift to. The
baseline already contains any real reaction, which biases the measured move rate toward zero.

Downstream: 2,926 watches resolved, 401 flagged as "moved", and **401 Claude explanations were billed** asking the
model to connect a tweet to a move it could not have caused. The prompt (line 122) tells Claude *"line snapshots are
captured roughly twice daily"* — false now (~5-7 minutes) and it makes the model more willing to attribute.
`tweetLineCorrelationSummary()` reports `move_rate` with a `sample_sufficient` gate at n≥30, which is satisfied, so
this will read as a meaningful number the moment anyone looks at it.

This is a different defect from G12-news D6, which notes the fan-out's row volume and cost but not the ordering.

### 6d. The news→market pipeline is structurally blind to ~89% of the roster

`server/news/ingest.js:48`: `SELECT id, name FROM players WHERE fantasy_relevant = 1`. That is **994 of 8,720
players** — WR 353, RB 239, TE 156, QB 131, K 83, DEF 32. **Zero offensive linemen. Zero defensive players by name.
No coaches.** Entity extraction is exact-full-name only (`normalize.js:20`; `loadIdentity` supplies no player
aliases), so a nickname or bare surname does not match either.

For fantasy this is the right population. For spreads it is close to the wrong one: after the quarterback, the
biggest non-QB line movers are starting tackles and premier pass rushers, and this pipeline cannot see any of them —
so `teamNewsSignals().unavailable_burden`, the online-neural `home_verified_news_burden` feature, and the council's
`news_reaction` expert are all computed on skill positions only. The news pipeline was built fantasy-first (correct,
given Nick's priority) and was never widened when it was pointed at the betting model.

G12-news:112 notes the filter exists; it does not draw this consequence. Not in the plan.

## 7. What I checked and did NOT propose, because the plan has it

- **Prop CLV measurement and the prop/total consistency check** — Step 4a/4d. My prop-tape observations add nothing.
- **Deflated Sharpe / effective trial count / purged walk-forward** — Step 2 (5a-5e). The FIX #29 baseline problem is
  a *different* correction (a within-window market control, not a multiple-testing haircut) and is not covered there.
- **Retention policy for quote tables** — Step 6 item 16. The 1.9M September rows I leaned on are that exact table;
  nothing new to say.
- **The frozen-packet-to-forecast gap** — Step 5b names it precisely ("no forecast has yet consumed a frozen packet
  in production"). My §5 finding is narrower and additive: the packet is recording the wrong news table, which the
  plan does not say.
- **Shadow-run window before promotion / registry-and-gate layer unproven** — Step 5 item 14, Step 5b.
- **Cross-venue arbitrage, social sentiment** — explicitly rejected; §4d is neither. It is single-market temporal
  staleness between books you already poll, not cross-venue price arbitrage, and involves no sentiment.
- **The seven-method implied-probability dispatcher, nflfastR EP/WP** — Step 5c.
- **Two ESPN leagues failing to sync** — the open-decisions list.

## 8. If only three things get done

1. **Restore `date_modified` ingestion for 2026** (`nfl-advanced.js:325`) and fix the NULL-blind gap detector
   (`nfl-offseason-cycle.js:157`). Hours. Unblocks the only honest news-timing instrument, and every week it waits
   is a week of paired data that cannot be recovered later.
2. **Give `reacted` a market-wide control** (`nfl-news-market-latency.js:49`). Hours. Without it every latency number
   this project ever produces is uninterpretable; the measured null is 0.35%/min against bursts of 17%.
3. **Run the cross-book catch-up study properly** — 38 waves is one week; accumulate a season, split line-moves from
   price-moves, and score against the close. Days. This is the only thing in the news area that looks like the kind
   of edge this project has actually found, and it does not depend on news at all.

And one thing to stop: **do not invest further in news-latency-as-an-edge.** 19.8 hours against a 100-minute window
is not a tuning problem.
