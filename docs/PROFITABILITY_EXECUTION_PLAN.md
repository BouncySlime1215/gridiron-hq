# Profitability execution plan — the active queue

Started 2026-09-08, against `main` at `c749a4e` (verified clean, no divergent local work).
This is the queue the execution brief asked for: one status table with implementation,
integration, evaluation and authority as separate fields, one critical path, one place that
says what genuinely ran. It supersedes the *queue* sections of `docs/PROFITABILITY_PLAN.md`
and `docs/AI_MODEL_OPERATING_MANUAL.md` §7 — their evidence and historical record stay where
they are; this file is where "what do we do next" lives from here on.

Every row below was checked against the live database or the committed source on this date,
not carried forward from a prior document. Where a number could go stale, it says how to
recheck it rather than asserting a fixed count as current health.

---

## Two things verified first, because they gate trusting everything else

### 1. Does any audit leak future data into a decision?

**No feature-construction leak found.** `nfl-ensemble.js`'s `featureAggregates()` filters
team-week history to `t.season === season ? t.week < week : t.season === season - 1` —
strictly-prior-week-or-strictly-prior-season, enforced in code, not by convention, and every
feature source in `nfl-ensemble.js` carries its own `cutoff_rule` string
(`server/services/nfl-ensemble.js:583,588,593`) stating exactly what "before target week"
means for that source. The blind-audit controller (`nfl-blind-audit.js`) opens weeks strictly
in schedule order (`spec.schedule[record.next_ordinal]`, incremented one at a time — never
random access), freezes code and input-table content hashes at preregistration
(`repositoryState()`, `inputDataState()`), and re-checks both while holding the write lock
immediately before sealing each week (`assertFrozen()` called twice in `openNextWeek`, the
second time inside the transaction). `inputDataState()` additionally bounds every season-keyed
table to `season <= maxSeason` and every timestamped table (`news_items`, `nfl_line_snapshots`,
`nfl_quote_tape`, roster events) to a fixed post-season cutoff, so a table can carry rows from
after the audited seasons in the live database without silently entering an earlier week's
frozen state. This machinery already existed at the reviewed commit; nothing in this
session's merges touched it.

**A real, but already-disclosed, gap: the historical replay's "edge" is measured against the
closing line, not an obtainable one.** `nfl-replay.js`'s `replaySeason()` computes
`marketMargin = -g.home_spread` from `game_lines.spread`, which `nfl-prop-clv.js`'s own
comment identifies as "15,096 closing spreads" — and settles bets at `g.home_spread_odds`,
the price attached to that same closing line. A forecast built from strictly-prior data is
being compared against, and paid out at, a price that did not exist until kickoff. That is
not a temporal leak in the OOF-1 sense (no future *game outcome* or *post-decision news*
enters a feature), but it does mean historical ROI in this path cannot be read as "what a
bettor could have obtained" — only as "did the model's forecast diverge from where the market
eventually settled." The audit's own spec already labels this: `betting_policy` rules include
*"Historical ROI is reported but cannot establish production profitability without real
archived quotes and forward CLV"* and *"the genuinely untouched gate is the 2026 forward
shadow ledger"* (`nfl-blind-audit.js:182-183`). **This is exactly Execution Phase 1's job**
(replay freshness/availability, below) — fixing it means threading `game_lines.open_spread`
(or the multi-book archive open price, where available) through as the decision-time
reference, and reporting both numbers rather than one.

**Verify this yourself, any time:** `node -e` against a live run's `spec_json.provenance`
shows the exact table hashes and row scopes frozen for that run; `nfl_blind_audit_retries`
records every rejected reopen attempt with its error, so a leak attempt that got caught would
be visible there, not silently swallowed.

### 2. Do we have the historical line data this needs?

Checked directly against the live 6.4GB database (not the gitignored, unpopulated worktree
stubs used earlier this session):

| Source | Coverage | Real gap found |
|---|---|---|
| `game_lines` closing spread/total | 1999–2026, essentially 100% (267–285 games/season) | None — this is solid and always has been. |
| `game_lines` **opening** spread | 0% before 2013; ~96% 2013–2022; 100% 2023–2026 | Pre-2013 has no opening line at all. 2013–2022 has scattered nulls. |
| `game_lines` **opening** total | 0% before 2021; 100% 2021–2026 | Pre-2021 has no opening total at all. |
| `nfl_odds_archive` (11-book open+close, Pinnacle/Bovada/Unibet/etc.) | **2022–2026 only**, ~6.8K rows/book | **2021 was never fetched — not a vendor limit, a code default.** `backfillOddsArchive()`'s default `seasons` list was `[2022, 2023, 2024, 2025]`; the blind audit's default season list is `[2021, 2022, 2023, 2024, 2025]`. 2021 has been running with strictly less price-archive support than every other audited season. |
| `nfl_quote_tape` (fine-grained multi-book live tape, the substrate Package B and the Package F/drift work run on) | **752,954 rows spanning a single week**, 2026-09-02 to 2026-09-07 | This is the real constraint on Package B and everything downstream of it. One week cannot support a chronological, purged evaluation — see the collection blocker below. |
| `nfl_nfelo_games` | 2020–2026, 1,709 rows | Fine. |
| `nfl_external_ratings` | `teamrankings_predictive` 2022–2026 (2,336 rows); `espn_fpi` **2026 only** (32 rows) | FPI is not usable for any historical comparison; nothing currently depends on it for that. |

**Fixed this session, verified against the real database:**
`backfillOddsArchive()`'s default season list and the `/nfl-market/odds-archive/backfill`
route's own independent default (it did not import the module's default — a second place the
same magic list had to be kept in sync by hand) both now include 2021
(`server/services/odds-archive.js:164`, `server/routes/nfl-market.js:172`). The actual 2021
backfill is running against OddsTrader's public odds service — the same free, unauthenticated,
already-integrated source `book-feeds.js` uses for live prices, not a new paid dependency — 62
distinct game days, 1.2s-paced requests, writing only to `nfl_odds_archive`,
`nfl_line_snapshots`, and filling `game_lines.open_spread`/`open_total` where they are
currently null. It never overwrites a settled result or existing non-null price. Result
recorded in the "What ran" section below once it completes.

**The one real, unresolved data-collection blocker — needs your decision:**
`.env` sets `SCHEDULER_DISABLED=1`. Reading `server/services/scheduler.js:977-988`, this was
added 2026-09-07 as an explicit, dated, hand-operated brake — *"hours before the Matta-Kodsi
draft... the safe move for a night that has to work is to stop paying that cost... Unset (or
remove from .env) to resume normal syncing once nothing depends on the app being maximally
responsive."* It is still set. This means every scheduled job — quote-tape capture, odds-archive
refresh, news ingestion, forward settlement — has not run since that night, which is the
direct reason the quote tape is stuck at one week instead of growing by one week every week.
**I have not unset this.** It changes live operating behavior and resumes real (if free/
low-cost) network polling against your machine, which is the kind of decision this brief asks
me to identify and leave inactive rather than flip on my own judgment. Phase 3 (prospective
collection, below) cannot start until this is resolved one way or another — either unset for
normal operation, or replaced with a narrower flag that re-enables only the collection jobs
this phase needs while leaving the fantasy-facing live-odds polling that caused the original
slowdown off.

---

## Status table

Columns: **Impl** = built and correct in isolation. **Integ** = reachable from a route, job,
or the UI a person actually uses. **Eval** = has a completed, trustworthy evaluation.
**Auth** = what it is currently allowed to do to real money or the live app.

| Package | Impl | Integ | Eval | Auth | Evidence | Next action |
|---|---|---|---|---|---|---|
| **A** — exact contracts, bitemporal evidence | ✅ | ⚠️ partial | n/a (infra) | none | `nfl-contract-key.js`, `nfl-bitemporal.js` exist and are unit-tested; grep confirms zero callers of `nfl-bitemporal.js`'s `recordRevision`/`valueAsKnown` outside its own module and tests | Adopt inside Phase 2's single strategy path rather than building a second contract system |
| **B** — book response / price advantage | ✅ pilot | ❌ | ⚠️ inconclusive | research only | One-week pilot (commit `047703f`): next-move probability improved over baseline, magnitude did not; delay-survival modeled from coarse snapshots. `nfl_quote_tape` is still one week — cannot be re-evaluated chronologically until it's several | Primary experiment (Phase 5) — blocked on collection (see scheduler above), not on model work |
| **C** — trees/TPOT lab | ✅ extended | n/a (research tool) | ⚠️ no executable edge shown | research only | Multiple targets/families verified in this session's own work (model-discipline + drift merges, `a3d59a6`/`eaf9a0b`) | Shared tool. Not a target for new expansion per the brief's 10%-maintenance cap |
| **D** — player roles (targets+carries) | ✅ | ❌ | ⚠️ conservation gap | research only | Reviewed finding (~27% of checked starters show excess beneficiary gains) not yet re-verified this session | Secondary experiment, gated on the conservation repair the brief specifies, and on choosing one real prop contract — not "targets+carries" as if it were a settleable market |
| **E** — typed news → price impact | ✅ extraction | ⚠️ | ✅ (honest null) | research only | Verified live this session's predecessor work: 30 typed events, 24 verified, 0 provenance violations, 0 paired claims (every claim stamped after the one-week quote tape ends — see B) | Collect prospectively alongside B once the scheduler question is resolved; the extractor itself needs no further work |
| **F** — expert selector | ✅ | ✅ (reported in Research Lab) | ✅ complete, negative | research only | Built and run this session (`74db0ac`): lost to the market on all 3 substrates, 7/7 gate configs. Preserved, not reopened | No action unless a materially new hypothesis is proposed |
| **G** — cross-market consistency | ❌ | ❌ | n/a | none | Speculative, per the brief explicitly deferred | Deferred |
| **H** — execution lifecycle/replay/attribution/risk | ✅ | ✅ **connected** (`/betting/nfl/ledger`, Phase 2, commit `3de0cb0`) | partial (corridor + CLV-downsize out-of-fold; the connected pipeline itself has run live only against zero real candidates — see below) | paper only — a route and a UI exist to run the pipeline and to accept, but `attemptAcceptance` still requires a real human-supplied stake, and ACCEPTED still cannot become a confirmed fill (`fill_confirmed` schema-pinned to 0) | Phase 1 (`cadcb40`) fixed the four source-level replay findings; Phase 2 (`3de0cb0`) wired `nfl-execution-pipeline.js` to the real `autoPickDecisionBoard`, added accept/settle/funnel routes and the Execution Desk UI. Verified live: the production policy currently selects **zero** spread candidates (every one abstains `calibration_not_proven`), so the pipeline has run clean against real data but processed nothing yet — an honest, current state, not a stub | Nothing further until a real candidate exists; then verify one real opportunity moves offered→observed→decision→(accept)→settled by hand |
| **I** — research product / status | ✅ | ✅ (Research Lab page) | n/a | none | This document + the Research Lab page are now the two sources of status; `RESEARCH_PACKAGES` badges in `nfl-research-lab.js` still read `next`/`planned` for A/H/D — stale against this table | Update `RESEARCH_PACKAGES` state strings to match this table in the same commit that starts Phase 2 |

**Forward/paper ledgers, checked live (pre-Phase-2 snapshot):** `forward_picks` — 0 rows.
`shadow_decisions` — 89 rows. `nfl_expert_forward_predictions` — 672 rows, one unplayed week,
zero settlements. `nfl_execution_opportunities`/`nfl_execution_lifecycle_events` — 0 rows each
at the time this was written. **They are still 0 rows now** — Phase 2 built and verified the
connector (live browser round-trip, 9 unit tests against real primitives), but the production
policy has had zero eligible candidates for it to open all session. The pipe is built and
proven; nothing has flowed through it yet because nothing eligible exists to flow. That is a
finding about calibration (see B and the operating manual §2.2), not a gap in Phase 2's work.

---

## Critical path

1. ~~Fix the two-place magic-number drift in `backfillOddsArchive` defaults and run the 2021
   backfill.~~ **Code fixed** (`bfe7f4d`); **the actual data backfill did not complete** —
   OddsTrader was returning Cloudflare 502s when tried. Needs a re-run once the vendor recovers
   (see below); no code work remains.
2. ~~**Resolve `SCHEDULER_DISABLED`**~~ — **resolved: staying set, by your explicit decision.**
   Phase 3 (prospective collection) stays blocked on this by design, not by omission — do not
   re-raise it as an open question. `nfl_quote_tape` will not grow past its current one real
   week until this changes.
3. ~~**Phase 1 — replay freshness/availability.**~~ **Done** (`cadcb40`). All four source-level
   findings fixed and tested: real versioned staleness/book-limit policy instead of `Infinity`
   defaults; the freshness param threaded through every replay entry point; genuine `removed`
   detection from sibling-row quote-tape evidence instead of every retained record reading as
   `quote`; `attemptAcceptance` now derives identity from the persisted opportunity rather than
   trusting a caller-supplied `eventKey`/`participant`.
4. ~~**Phase 2 — wire Package H into one route and one UI screen**~~ **Done** (`3de0cb0`).
   `nfl-execution-pipeline.js` connects `autoPickDecisionBoard`'s existing frozen-policy output
   to Package H's ledger; `/betting/nfl/ledger` is a real, working screen (Desk / Positions &
   Results) verified live in a browser with zero console errors. **Currently processes zero
   candidates** because the production policy currently selects zero (calibration not proven,
   verified live) — the pipe is proven, not yet fed.
5. **Phase 3 — prospective collection.** Blocked on step 2's decision, which is final for now.
   Not attempted this session; would need to be built as an on-demand action (matching the
   pipeline's own pattern) rather than a scheduled job, the same way `/execution/run` is a
   button press, not a cron entry.
6. **Phases 4–5** — economics dashboard and the bounded B/D research follow-ons. Phase 2 already
   built the funnel/scorecard primitive (`GET /execution/funnel`, `lifecycleFunnel()`) the
   economics dashboard would extend; a full nav reorganization (Desk / Positions & Results /
   Research / Data Health as the top-level betting structure the plan describes) is a much
   larger, more invasive change to information architecture people already use daily, and was
   deliberately not attempted without a checkpoint. Phase 5's B/D research needs real collected
   weeks (see 5) or a real prop-market data source (D) neither of which exist yet — reported
   here as blocked on data, not attempted with fabricated inputs.

## What ran, this session, on this document

- Verified `main` at `c749a4e`, clean, matches the reviewed snapshot exactly — nothing newer
  to reconcile.
- Read and traced: `nfl-blind-audit.js` (994 lines, full), `nfl-replay.js` (through the betting
  decision loop), `nfl-ensemble.js` (feature-cutoff sites), `odds-archive.js` (full),
  `scheduler.js` (disable path and its dated justification), `nfl-market.js` (route defaults).
- Live-queried the real database for every coverage number in the tables above — none are
  carried forward from a prior document or from this session's earlier worktree checks (those
  worktrees had a 2MB stub `data.sqlite`, not the real 6.4GB one).
- Code change: `server/services/odds-archive.js` and `server/routes/nfl-market.js`, adding
  2021 to two independent default-season lists. Committed (`bfe7f4d`) with lint clean and the
  two relevant `odds-archive.test.js` tests passing.
- Data change attempted: ran `backfillOddsArchive({ seasons: [2021] })` against the live
  database. **Did not complete — OddsTrader's origin is currently returning Cloudflare 502s**
  (verified directly: a single request for 2021-09-09 took 12.8s and came back
  `Error 502: Bad gateway ... the origin is overloaded or unavailable`, not a code or query
  error). At that latency a full 62-day run would take up to ~45 minutes against a vendor
  that is currently down, so the run was killed after 7 minutes with zero rows landed rather
  than left to fail slowly. The code fix (both default-season-list sites) is correct and
  tested independently of this — `node --check` and the two `odds-archive.test.js` tests
  pass. **Re-run `backfillOddsArchive({ seasons: [2021] })` (or `POST
  /nfl-market/odds-archive/backfill` with `{"seasons":[2021]}`) once OddsTrader is responding
  normally** — no code changes needed, just a healthy origin. Quick health check before
  re-running: a single `fetch` to the archive endpoint for any 2021 date should return
  `200` in well under a second if the vendor has recovered.

## What ran, Phases 1–2

- **Phase 1** (`cadcb40`): fixed all four source-level replay findings in `nfl-execution-replay.js`
  and `nfl-execution-decision.js`, caught and fixed one real interaction with an existing stress
  scenario along the way (`nfl-execution-stress.js`'s intentional unbounded-trust comparison arm),
  added settlement-rule disclosure to the OFFERED event. 16 new tests, 117 pre-existing Package H
  tests unchanged. Full suite after: 1127/1126/1/0.
- **Phase 2** (`3de0cb0`): built `nfl-execution-pipeline.js`, found and fixed a real team-name-format
  bug while writing its own tests (quote-tape stores full names, contracts store abbreviations —
  a naive string match would have silently never found real coverage), wired 7 new routes and one
  new UI page, verified live in a browser (round-trip through the real API, zero console errors).
  9 new tests. Full suite after: 1136/1135/1/0.
- Both phases' work was verified against the real 6.4GB database, never a worktree stub.

## Unresolved, going into the next session

- The 2021 odds-archive backfill needs to actually run — blocked on OddsTrader's origin
  recovering from Cloudflare 502s it was returning when tried, not on anything in this
  codebase. Re-run command is in the Phase 0 section above.
- Phase 3 stays inactive by your explicit decision (`SCHEDULER_DISABLED` remains set). Do not
  re-open this as a question in a future session without a new instruction to do so.
- The production spread policy has selected zero candidates all session
  (`calibration_not_proven`) — Phase 2's pipeline is proven correct against real live ensemble
  output but has never yet opened a real opportunity. The first real verification of the full
  offered→observed→decision→accept→settle path end to end, on a real candidate, is still ahead
  and cannot be forced — it depends on the calibration gate clearing on its own evidence.
- Phase 4's full UI reorganization (Desk / Positions & Results / Research / Data Health as the
  top-level betting structure) was not attempted — it is a much larger, more invasive change
  than anything else in this document and deserves an explicit go-ahead rather than being
  bundled into an already-large session.
- Phase 5's research follow-ons (B's forward re-evaluation, D's conservation repair) are
  genuinely blocked on data this session could not manufacture: more collected weeks (Phase 3)
  and a real prop-market data source (D), respectively.
