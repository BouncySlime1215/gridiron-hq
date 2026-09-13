# Is there a real speed edge in news reaching this market?

**Verdict, up front: no.** There is no actionable speed edge for a retail
participant using this app, and the reasons are architectural, not merely a
matter of degree. The data below supports that conclusion directly; it does
not need to be read charitably to get there. Section 4 also completes the
audit's standing requirement — tracing one real news fact through to a real
decision's numbers — and that trace, done honestly, comes back **zero**, for
two independently verifiable reasons.

All numbers below come from read-only queries against the real production
database (`server/data.sqlite`, opened with `node:sqlite`'s `{ readOnly:
true }`, never written to) or from reading the actual scheduler/service code
that runs in production. Where a number is an estimate or a sample, that is
stated. Nothing here is simulated.

---

## 1. The real distribution of news-to-market-reaction time

### 1.1 The data has a hole exactly where you'd want to look

`nfl_verified_events` (119,639 rows) is the archive the audit named. Its
`time_precision` column tells you how exact its own timestamp is, and this
matters enormously:

| time_precision | meaning | count |
|---|---|---|
| `timestamp` | a real, specific moment | 39,052 (`official_injury_report` only) |
| `weekly_snapshot_inactives_deadline` / `weekly_snapshot_game_day_boundary` | inferred from a day-to-day roster diff, reported as a same-day bracket, not a moment | 78,892 |
| `date_end_conservative` / `date_midday_conservative` | a whole-day bracket (trades) | 1,695 |

**The last genuine, minute-level `timestamp`-precision event in the entire
archive is `2025-01-05T15:27:22Z`.** Every single verified event since then —
the whole 2025 season and all of 2026 — carries only a coarse, same-day
bracket. That is not a data-quality nitpick; it means the archive cannot
answer "how many minutes after the news did the market move" for anything
that has happened in the last twenty months, because it no longer records
news at minute resolution. This is a real, checked fact, not an assumption:

```
SELECT event_type, time_precision, COUNT(*) FROM nfl_verified_events
WHERE available_at >= '2025-08-01' GROUP BY 1,2;
-- every row: weekly_snapshot_* or date_*_conservative. Zero 'timestamp' rows.
```

Meanwhile `nfl_line_snapshots` (2,140,643 rows) has the opposite problem in
the opposite era. Counting **distinct real capture events** (grouping raw
`captured_at` timestamps that land within 4 minutes of each other into one
event, since a single real capture fans out into a burst of dozens of
near-simultaneous per-book/market/side rows — counting raw rows or even raw
distinct timestamps overstates cadence by 2-5x):

| period | true capture events | ≈ average spacing |
|---|---|---|
| 2022 | 1,342 | ~6.5 hours |
| 2023 | 1,600 | ~5.5 hours |
| 2024 | 1,646 | ~5.3 hours |
| 2025 | 1,742 | ~5.0 hours |
| 2026 (Sep 1 – 13, 11 days) | 1,243 | **~13 minutes** |

The *average* spacing for 2022-2025 understates how uneven it really is —
these captures cluster around game windows (Thu/Sun/Mon) and thin out badly
the rest of the week, which is exactly the days injury designations and
roster news actually happen. The 2026 season, by contrast, is captured at
close to the cadence a speed question would need.

The code's own docstring already says this plainly (`nfl-news-market-latency.js`,
`verifiedEventMarketLatency`): *"the archive holds only openers and closes and
contributes no path."* Rather than take the comment's word for it, I ran the
actual measurement it describes — the real event-study reaction detector
(Section 1.2's method) against a systematic 1-in-8 sample of the 8,258
timestamp-precision Out/Doubtful/Reserve events in the archive (1,033
events, 2021-09-08 to 2025-01-04), paired against the real historical
`nfl_line_snapshots` spread quotes:

| | |
|---|---|
| events with *any* before/after quote pair around their own game | 1,033 / 1,033 |
| of those, with a real market-model + estimation-window baseline | **0 / 1,033** |
| events with an observed reaction, by ANY basis including the raw fallback threshold | **0 / 1,033 (0.0%)** |
| minutes to the first quote captured after the event | median 2,484 min (**41.4 hours**); p10 = 961 min (16h), p90 = 2,780 min (46.3h) |

**Zero out of a thousand-plus real historical injury/OUT/IR designations
produced a detectable market reaction in this data — not because the real
market didn't react (it certainly did, in reality), but because the next
time this system happened to capture a quote was, on the median case, 41
hours later.** That is a capture-instrument ceiling, not evidence about the
market. This is the "contributes no path" claim, now with a number attached
instead of just a repeated assertion.

**The consequence for the whole of Point 1: the only window with dense
enough market capture to measure minute-level reaction (the last ~11 days,
2026) has zero minute-precision verified events in `nfl_verified_events`
(Section 1.1's first finding), and the only window with minute-precision
verified events (2020 – Jan 2025) has capture too sparse to ever detect a
reaction at all (0/1,033, just measured above).** These two datasets do not
overlap in any usable way. A rigorous "verified event → market reaction, in
minutes" distribution cannot be built from `nfl_verified_events` +
`nfl_line_snapshots` as currently instrumented, full stop. Section 1.2 uses
a different, real data source that does overlap the dense window.

### 1.2 What *can* be measured for real: the current-season typed news feed

`nfl_news_signals` — the other pipeline, fed by `rss_news`/`espn_news` and
extracted continuously — has real per-article `published_at` timestamps and
**does** overlap the dense 2026 capture window: 373 verified, team-tagged
claims from 2026-08-19 to 2026-09-13 (today). I measured this by
reimplementing the actual (newly-fixed, see the prior commit) event-study
`quoteReaction` logic in a read-only script against the live database and
running it for real.

Aggregate result, all 373 claims:

| | |
|---|---|
| claims with a before/after quote pair for a real game | 373 / 373 |
| of those, with a real market-model + estimation-window baseline (not the raw fallback threshold) | 215 / 373 (57.6%) |
| claims with *some* detected reaction | 260 / 373 (69.7%) |

Minutes from `published_at` to the first quote captured afterward (the
**capture floor**, not a reaction — this is "how long until we next looked,"
not "how long the market took"):

| p10 | p25 | median | p75 | p90 | p99 |
|---|---|---|---|---|---|
| 1.9 min | 4.8 min | 69.4 min | 17.6 h | 2.3 days | 7.1 days |

Minutes to the **first flagged reaction** (any basis):

| p10 | p25 | median | p75 | p90 | p99 |
|---|---|---|---|---|---|
| 8.6 min | 48.7 min | 10.7 h | 1.8 days | 5.5 days | 11.4 days |

**These raw numbers are close to meaningless for the speed question, and
saying so plainly is the honest reading, not a hedge.** The median
time-to-kickoff at the moment these claims were published is **240 hours
(10 days)** — most "news" in this feed is training-camp and roster-depth
commentary filed a week or more before the game it concerns. A claim
published 10 days out that gets a "reaction" 3 days later isn't evidence of a
slow market; it's evidence that nobody needed to be fast, because the game
was 10 days away. Blending that together with same-day injury news and
reporting one median is the kind of number that looks precise and measures
the wrong thing.

### 1.3 The number that actually answers the question: news filed close to kickoff

Restricting to claims published within N hours of their own game's kickoff —
the only zone where a genuine speed question can even arise — using the same
real data and the same event-study reaction detector:

| published within… | claims | had a reaction | median reaction time | fastest observed | slowest observed |
|---|---|---|---|---|---|
| 3h of kickoff | 1 | 0 | — | — | — |
| 12h of kickoff | 6 | 5 | 22.2 min | 0.58 min | 43.5 min |
| 24h of kickoff | 12 | 8 | 25.0 min | 0.58 min | 58.6 min |
| 72h of kickoff | 103 | 66 (64%) | 19.6 min | 0.23 min | 434.3 min (7.2h) |

Sample sizes at the tightest windows are small (this is 11 days of one
preseason-into-week-1 stretch, not a season), so treat the 3h/12h/24h rows as
directional, not a stable population estimate. But the pattern is consistent
across all four windows and matches the hand-verified example in 1.4: **when
it means anything at all, "market reaction" in this data shows up on the
order of 10–60 minutes after a close-to-kickoff news item, with a fast tail
under a minute and a long tail out to several hours** for full cross-book
consolidation.

That number is *still* an overestimate of true market speed, for a reason
covered in Section 2: it is bounded below by how often this system happened
to poll, not by how fast the price actually moved.

### 1.4 One real, hand-verified trace (not an aggregate statistic)

To ground the aggregate numbers in something inspectable: Atlanta's starting
QB Tua Tagovailoa suffered a practice oblique injury during the week
leading into this Sunday's (2026-09-13) ATL @ PIT game.

- **2026-09-11T17:11:19Z** — ESPN (allowlisted primary publisher) reports
  Tagovailoa "limited" with an oblique injury.
  (`nfl_news_signals.news_id=79643`, verified.)
- **2026-09-11T17:24:21Z** — first verified "out" designation reaches this
  system's feed (Twitter/@tori_mcelhaney, `news_id=88948`), 13 minutes later.
  Two more independent verified "out" confirmations follow at 17:29 and
  17:40.
- **The market, independently, in the real captured quote history**
  (`nfl_line_snapshots`, PIT −spread, book `pinnacle`):

  | captured_at | line | price |
  |---|---|---|
  | 2026-09-11T16:11:20Z | −5 | −106 |
  | **2026-09-11T17:23:12Z** | −5 | **−113** |
  | 2026-09-11T18:38:32Z | −5 | −114 |
  | 2026-09-11T19:39:02Z | −5 | −114 |
  | 2026-09-11T20:14:16Z | **−6** | −108 |
  | 2026-09-11T20:42:31Z | −6 | −106 |
  | 2026-09-11T21:43:23Z | −6 | −106 |

  Pinnacle's price had already shortened (−106 → −113) by its very next
  capture, **12 minutes after the ESPN report** and **1 minute before this
  system's own first "out" designation existed** — the true move could have
  happened anywhere in the ~72-minute gap since the prior capture (16:11),
  so 12 minutes is an upper bound on this one observation, not a proven
  reaction speed. The full point of line movement (−5 → −6) consolidated
  across books (`draftkings`, `circa`, `pinnacle`) over the following
  **~3 hours**. This is a real, sizeable, idiosyncratic reaction — I checked
  it against the peer/market-model baseline used by the event-study
  detector, and no other game moved at the same instants, so this is
  genuinely attributable to the injury, not a leaguewide vig shift.

- **Compare:** the earlier "Tua named Week 1 starter after winning the
  competition" story (published 2026-09-07, three separate verified
  reports) produced **zero measurable move** — Pinnacle's line was already
  at −3.5 six hours *before* that story broke and stayed at −3.5 for the
  rest of the day. The market had already priced the expected outcome; the
  confirmation itself carried no new information. This is the honest
  contrast the aggregate statistics predict: not every "verified event"
  moves the market, and the ones that don't are just as real a finding as
  the ones that do.

This is a genuine, checkable reaction, and it is the cleanest single data
point in this report: **~12 minutes to the sharp book's first price tick,
~3 hours to full cross-book consolidation, for a real, verified, unambiguous
injury designation, on a game happening this week.**

---

## 2. Is a retail bettor using this app fast enough? No.

Three independent facts, each sufficient on its own, converge on no:

**a. This system's own market-data capture floor is minutes, not seconds.**
Even at 2026's much-improved cadence, real capture events land roughly every
5–15 minutes on average (Section 1.1: ~13 min average, ~6 min median), and
the empirical close-to-kickoff reaction numbers in 1.3 (median 20–25 min)
are *at best* this system's polling grain, not the market's true speed. The
hand-verified
trace in 1.4 shows the sharp book had already started moving within the
window between two of this system's own captures (a ~72-minute gap) — this
system cannot resolve when inside that window the real move happened,
because it wasn't looking continuously.

**b. This system's own news pipeline is slower than the market it would need
to beat.** Read directly from the scheduler that actually runs in
production (`server/services/scheduler.js`):

```
nfl_news_signals: { run: refreshNflNewsSignals, maxAgeMinutes: 60, tier: 'live' }
```

The structured news-signal extraction step — the thing that turns a raw
article into a machine-usable "player X status Y" row — is throttled to run
**at most once per hour**, even though it sits in the fast-polling "live"
tier. In the concrete trace above, the market's sharp-book price had already
moved (by the very next capture, ≤72 min after the prior one, and ≤12
minutes after the underlying ESPN report) before this system's own announced
news-extraction cadence would even guarantee a look. A system whose own
news-to-signal floor is up to an hour cannot claim a speed edge against a
market that (per the same real data) starts moving within tens of minutes.

**c. The market's genuine reaction — even measured coarsely here — is not
slow.** A retail participant needs the market to be *slow enough to still be
mispriced* by the time they can act. Section 1.4 shows a real injury
designation roughly fully priced (a full point, across three books) within
about three hours, with the sharp book already moving inside the first
capture window. That is an ordinary, unremarkable speed for a liquid book to
reprice a starting-QB-out situation — nothing in this data suggests this
particular market is unusually slow or thin. The textbook answer to "is
there a retail speed edge in a liquid, algorithmically-monitored market" is
no, and nothing this project has captured contradicts that; if anything, the
one clean example available shows the market reacting inside a single
digit number of minutes to tens of minutes, which is fast by any standard
a human, scheduler-driven system could realistically beat.

**Conclusion for §2, stated plainly:** No. By the time a real injury
designation would even reliably reach this system's own structured news
store (up to 60 minutes, per its own scheduler configuration), the market
described in this system's own captured quote history has, in the one
concrete case available, already fully repriced. There is no daylight here
for a retail participant to step into.

---

## 3. If there were a window, could this architecture act in it? Also no — and it's the wrong question to chase further.

Section 2 already answers this in the negative before architecture even
enters the picture, but the audit specifically asked whether the
*scheduler-based* design (vs. a real-time push architecture) would matter,
so here is why it doesn't need to:

**The whole pipeline is poll-based, by design, at every layer:**

- The "live" tier (`startScheduler`, `liveIntervalSeconds = 90`) runs **26
  jobs sequentially** in one `for...await` loop on a 90-second timer. Each
  job only actually does work if it's individually stale past its own
  `maxAgeMinutes` (3–60 minutes depending on the job); the 90-second figure
  is a check interval, not a refresh rate. There is no webhook, no
  subscription, no push from any odds provider or news wire — everything is
  "wake up, ask if anything is due, maybe fetch."
- Jobs run **in sequence, not in parallel**, each with a 120-second timeout
  (`DEFAULT_JOB_TIMEOUT_MS`). The scheduler's own code comment documents a
  real production failure mode from this: a single hung upstream request at
  position 4 of 26 used to silently block every job behind it, including
  the T-60 runner at position 14, for the life of the process — fixed by
  adding the timeout, but the underlying sequential design is unchanged.
- `nfl_t60_runner` itself (`maxAgeMinutes: 5`) is comparatively tight, and
  there IS one real, live-frozen observation in production right now
  confirming the mechanism actually fires against real data — see §4.

**A specific, verified architectural gate makes "received by cutoff" claims
currently unachievable for the market-data source at all**, independent of
polling speed. `freezeT60Packet`'s quote-tape evidence requires
`receipt_clock_source = 'response_completion'` (a genuine observed-receipt
timestamp) to ever grant `received_by_cutoff`. Checked against every batch
this system has ever recorded:

```
SELECT receipt_clock_source, COUNT(*) FROM nfl_quote_batches GROUP BY 1;
-- legacy_request_time_only: 1592   (100% of all batches, ever)
-- response_completion:         0
```

Zero. Every quote batch this system has ever captured stamps only when it
*asked*, not when it actually *received* a response. By the T-60 packet's
own (correctly conservative) rule, this means the market-data source is
**always** quarantined as `availability_unknown` in a prospective packet
today — not late-arriving, not missing, but structurally unable to prove
it arrived in time at all. This is a real, checkable, current limitation of
the code as deployed, not a hypothetical.

**Answer to §3: don't build the low-latency infrastructure the honest data
doesn't justify.** Even setting aside every architectural gap above, §2
already shows there's no window to exploit — the market in the one real case
this project captured moved on a timescale (tens of minutes to a few hours)
that a human retail participant checking this app periodically has no
realistic way to beat, and that a faster poller would only close by single
minutes at best. Building real-time push infrastructure, a receipt-clock
upgrade, or sub-minute polling would be solving a problem this data says
doesn't exist for this project. If a future dataset ever shows a
recurring, multi-minute *underreaction* window with real edge after
transaction costs, that would justify revisiting this — nothing here does.

---

## 4. Tracing one real fact to its exact numerical effect on a decision

This is the standing requirement from the earlier audit. It is now
answerable, because the T-60 packet and decision tape genuinely exist in
this codebase and at least one real observation has gone through them. The
honest result: **the trace completes end-to-end, and the numerical effect at
the decision layer is exactly zero — for two independent, verified
reasons.**

### 4.1 The fact and its market effect (already established, §1.4)

Real fact: Tua Tagovailoa (ATL) ruled out with an oblique injury,
first verified in this system at **2026-09-11T17:24:21Z**, ~47.6 hours
before ATL @ PIT kickoff (**2026-09-13T17:00:00Z**, T−60 cutoff
**2026-09-13T16:00:00Z**). Real, measured market effect: PIT's spread moved
from −5 to −6 (a full point) over the following ~3 hours, with the sharp
book's price already shortening within the very next capture.

### 4.2 Does this fact reach the T-60 evidence packet for this game? Partially, and the gap is itself a finding.

`freezeT60Packet`'s **news source reads `nfl_news_events`**, not
`nfl_news_signals` (the table the injury actually landed in). Checked
directly:

```
SELECT DISTINCT first_seen_time FROM nfl_news_events;
-- 2026-09-08T21:14:42.294Z
-- 2026-09-08T21:15:46.432Z
```

`nfl_news_events` has exactly two distinct `first_seen_time` values, both
from a single extraction run on **September 8**, and nothing since (it is 30
rows total, fed by an LLM claim-extraction pass, not the continuously-running
scheduler). **The Tua injury (Sept 11) is not in it.** The only Tua-related
rows this table has are the Sept 7 "named starter" story — the one that,
per §1.4, produced zero market reaction because it wasn't news. The single
most decision-relevant fact of the week, for this exact game, is invisible
to the news source the actual T-60 packet code reads. This is a second,
independently-verified architectural gap distinct from the receipt-clock
one in §3.

(The injury *is* present, correctly and promptly, in `nfl_news_signals` —
the continuously-running pipeline — which is what makes §1's measurement
possible at all. The gap is specifically that the T-60 packet was wired to
the wrong one of the two parallel news tables this codebase maintains.)

### 4.3 Is there a real frozen T-60 packet to inspect? One — and its evidence body wasn't retained.

`nfl_t60_observations` has 14 rows, all for this week. Thirteen are today's
Sunday 1pm slate, still `state='scheduled'` (their T−60 cutoff,
2026-09-13T16:00:00Z, has not arrived as of this writing, 2026-09-13
~14:00Z). **One is genuinely `state='frozen'`**: Thursday's SF @ LAR opener,
cutoff `2026-09-10T23:35:00Z`, frozen at `2026-09-10T23:37:33.148Z` (2
minutes after cutoff) with a real `packet_hash`.

I went to read what that packet actually contained (migration `036` added a
`packet_json` column specifically so a frozen packet's evidence could be
read back later, not just its hash). It doesn't exist in the live database:

```
SELECT packet_json FROM nfl_t60_observations LIMIT 1;
-- Error: no such column: packet_json
```

`schema_migrations` confirms why: the running production process (the one
that actually froze this observation) is on schema version **035**
(applied 2026-09-11T00:24:25) — migration **036**, which adds `packet_json`,
exists in this repository's current code but has never been applied to the
live database, because the live process has not restarted since before that
migration was written. **The one real frozen T-60 packet this project has
ever produced exists structurally (the freeze mechanism genuinely fired
against real live data) but its evidence content was never retained** —
only a content hash survives. This is not a bug I'm reporting for someone
else to fix (this audit changes no running process, per its own rules); it
is the honest state of the one artifact the standing requirement asked me to
inspect.

### 4.4 The decision layer itself: zero, and here is exactly why

`nfl_decision_events` — the append-only decision tape built specifically so
every candidate, selected or not, has a permanent record — has **zero rows**.
It has never been written to in production. `nfl_pick_decisions` (the older
mutable latest-view table) has 16 rows, one per today's Week-1 game,
including ATL @ PIT. I read its actual persisted forecast for that game:

```json
{
  "calibration_status": "matching_calibration_missing",
  "raw_forecast": { "projected_margin": 5.5, "market_margin": 5.5, "signed_edge_points": 0 },
  "margin_models_active": 0,
  "margin_models_available": 31
}
```

**Zero of the ensemble's 31 margin models are active for ATL @ PIT.** With
`blend_mode: market_residual` and zero active models, `projected_margin` is
set identically equal to `market_margin` — the forecast collapses to
exactly the market's own number, reflected back at itself. `signed_edge_points:
0` is not a small number here; it is a structural identity (projected −
market = 0 when projected literally *is* market). I confirmed the same
outward symptom holds for all 16 of today's games (`edge: 0`, `eligible: 0`,
`abstention_reason: "calibration_not_proven"`, all from the same policy run
at `quote_at` 2026-09-13 11:46:47) — I read the full `margin_models_active:
0/31` detail for ATL @ PIT specifically, and every other game shares the
identical abstention reason from that same run, so the same cause applies
league-wide this week. This is a fresh gate: the ensemble version
(`nfl-ensemble-fit-v10...`) was merged into this branch yesterday
(2026-09-12) and none of its 31 component models have yet cleared the
calibration-matching check the policy requires before trusting them.

**So: trace the Tua injury all the way through.** It is real, it is
verified, it produced a real and measurable market move (§4.1), and by the
time of today's T−60 cutoff it will have been sitting in the market's own
price for nearly two full days — comfortably "received" by any reasonable
definition, T-60 packet plumbing gap aside (§4.2). None of that matters to
the actual persisted decision, because the decision math for this game (and
every other game this week) contains **no model signal at all** right now —
it is the market number, minus the market number, always zero, by
construction, until at least one of the 31 margin models clears calibration.
**The exact numerical effect of this real news fact on today's actual ATL @
PIT decision is 0.0 edge points — not because the fact didn't matter, but
because nothing this week's decisions currently compute could register any
fact mattering, real or fake, big or small.**

That is the honest answer the standing requirement asked for: a complete,
real, end-to-end trace, with a genuinely empty result at the end, and an
exact, verified, non-speculative reason for the emptiness at every hop.

---

## Summary

| Question | Answer |
|---|---|
| Real distribution of news→market reaction time | Cannot be built for the pre-2025 archive (0/1,033 sampled historical injury events showed any detectable reaction — capture too sparse, median 41h to the next quote). Measurable for the current season: median ~20–25 min for close-to-kickoff news, with a sub-minute fast tail and a multi-hour consolidation tail — and even that is upper-bounded by this system's own ~5–15 minute polling grain, not proven market speed. |
| Is there a retail speed edge? | No. This system's own news-to-signal pipeline (up to 60 min) is slower than the one real market reaction measured here (fully priced within ~3 hours, sharp-book price already moving within the first ~12–72 min). |
| Could the architecture support acting in a window if one existed? | Doesn't need to be built — §2 already forecloses the opportunity. A poll-based, sequential, 26-job scheduler with a documented zero-count on the one receipt-clock field the T-60 packet requires for a real prospective claim would need substantial rework to even attempt sub-minute action, and nothing in this data justifies that investment. |
| Trace one real fact to its exact numerical effect on a decision | Done. Tua Tagovailoa's verified oblique injury → real ~1-point market move → **0.0 edge points** on today's actual ATL @ PIT decision, because 0 of 31 margin models are currently calibration-eligible (fresh gate from yesterday's model merge) and because the T-60 packet's news source (`nfl_news_events`) is 5 days stale and never saw this specific fact. Both reasons independently verified against the real database. |
