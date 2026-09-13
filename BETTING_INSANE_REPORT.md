# Insane batch 2026-09-13 — integration report

Integration branch `insane-2026-09-13-integration`, based on
`model-2026-09-12-integration`, built in
`/tmp/gridiron-insane-worktrees/integration`. All six feature branches merged
with `git merge --no-ff`. No conflicts anywhere, including the two files
(`nfl-shopping-board.js`, and the general area around execution-edge pricing)
that `e1` and `e4` both touch. **Not merged into `main`. No write, ever, to
the live `server/data.sqlite` or its `-wal`/`-shm`/`.bak` files — every claim
below that cites the real database was produced by a read-only
`node:sqlite {readOnly:true}` connection, most re-verified independently by
this integrator directly against the live file.** The live server process was
never started, stopped, or signaled.

---

## The two open questions this batch was built to answer

### Verdict: props → spread (Giant Plan Step 4a/4b) — **unproven, honestly negative on the data available now**

Both stages did what a validation is supposed to do: build the real
mechanism, then let real data say yes or no rather than assume yes.

- **Stage 1 (props-vs-total consistency).** The clean version of the idea —
  sum anytime-TD props into points, no model needed — **cannot run at all**.
  Verified directly against the live database: all 100,944 captured prop
  quotes are `player_pass_yds` / `player_rush_yds` / `player_reception_yds` /
  `player_receptions`, 100% from Underdog, across exactly 16 games, and
  **zero** are an anytime-TD market. The only fallback that can run (summing
  captured yardage props) leans "Under" on all 16 of 16 real games this week
  regardless of matchup — a unanimous direction that is the signature of a
  coverage bias in the proxy (it only sums players who happened to get a
  captured line), not a market inconsistency. n=2 graded games, both correct,
  explicitly and correctly reported as not meaningful.
- **Stage 2 (bottom-up team total from player projections).** A real,
  correctly-built mechanism — correlation-aware via the already-fitted
  182-archetype table, calibrated on 1,052 real 2021-2022 team-weeks
  (R²=0.75), walk-forward tested against 269 real 2023-2025 team-observations
  with real final scores. **It does not beat the existing top-down ensemble**
  (RMSE 10.806 vs. 10.058, ~7.4% worse) **and does not improve a blend with
  it either** (best blend weight found: pure ensemble, w=1). A real bug (a
  variance clamp inflating the simulated mean ~6.6 points on average) was
  found by the module's own consistency check and fixed, verified down to a
  0.199-point residual gap, with a regression test added — this did not
  change the RMSE/blend results, which use separate deterministic arithmetic.

**Independently re-verified by this integrator**, read-only against the live
`server/data.sqlite`: prop-quote market/provider breakdown (100,944 rows, 4
markets, `underdog` only, 16 games, 0 anytime-TD rows) matches exactly. Both
new test files pass in isolation (13 + 6 = 19 tests, 0 failures).

**Bottom line: do not ship either mechanism as a live signal today.** Stage 1
needs a real anytime-TD feed (this app doesn't have one) or a materially
better full-team yardage estimate before its fallback is trustworthy for
anything beyond mechanism-testing. Stage 2 is a real, working, correctly
built model that a genuine walk-forward test says isn't better than what
already exists — that is the honest, valuable answer, not a failure of the
exercise. Concrete reusable output either way: the bias diagnosis in Stage 1,
and the usage-vs-efficiency ablation in Stage 2 (efficiency carries ~1.7x the
skill usage does for a team total — a real, separately useful finding about
how `teamVolume()`-anchored pace works, independent of the total's own
predictive value).

### Verdict: news timing (does speed create a retail edge?) — **no, and the report shows exactly why, with a real end-to-end trace**

**No actionable speed edge exists for a retail participant using this app —
architecturally, not just by degree.** Three independent facts converge:

1. This system's own market-data capture lands roughly every 5-15 minutes on
   average even at 2026's much-improved cadence — a hard floor on what any
   analysis of "reaction time" here can resolve.
2. This system's own news-signal extraction is throttled to at most once per
   hour by its own scheduler config (`nfl_news_signals: maxAgeMinutes: 60`),
   which is slower than the one real, hand-verified market reaction measured
   in this report (a starting-QB-out injury fully repriced across three
   books within about three hours, with the sharp book's price already
   moving by the very next capture, ~12 minutes after the underlying
   report).
3. The market's real reaction, even measured coarsely, is not slow — nothing
   captured here suggests this particular market is unusually slow or thin.

The report also completes the standing requirement — tracing one real fact
through to a real decision's numbers — and the honest result is **zero**,
for two independently verified reasons: the T-60 packet's news source reads
the wrong one of two parallel news tables (misses the injury entirely), and
separately, 0 of 31 margin models are currently calibration-eligible
league-wide this week, so `projected_margin` is identically `market_margin`
by construction regardless of any news fact.

**Independently re-verified by this integrator**, read-only against the live
database, exact or near-exact matches (small differences consistent with the
live capture process having ingested a few more rows between report-writing
and this check, which is expected of a live system and not a discrepancy):
the `nfl_verified_events` time-precision gap (zero minute-precision events
since 2025-08-01; last one 2025-01-05T15:27:22Z, exact match); the
`nfl_quote_batches` receipt-clock split (0 `response_completion` rows ever,
100% `legacy_request_time_only`); `schema_migrations` at version 035 (exact
match); `nfl_decision_events` at 0 rows and `nfl_pick_decisions` at 16 rows
(exact match); `nfl_news_events` at exactly 2 distinct `first_seen_time`
values from Sept 8 (exact match); the ATL@PIT decision row itself
(`margin_models_active: 0`, `signed_edge_points: 0`, `abstention_reason:
calibration_not_proven`, and all 16 of this week's games sharing that same
reason — exact match).

**Bottom line: don't build low-latency infrastructure for this.** The
report's own recommendation — don't chase sub-minute polling or push
infrastructure the data doesn't justify — is the correct call given what was
actually measured, not a hedge.

---

## Everything built, with its real measured result

| Piece | Branch | Real result | Ready to merge? |
|---|---|---|---|
| Props-vs-total consistency (Stage 1) | props-to-spread | Mechanism works; real data cannot validate the idea (0 anytime-TD props exist); yards fallback shows a coverage-bias artifact, not a signal | Code yes (dependency-free, writes nothing); **not** as a live signal |
| Bottom-up team total (Stage 2) | props-to-spread | Real, correct, correlation-aware model; walk-forward RMSE 10.806 vs. ensemble's 10.058 (worse); no additive blend value found | Code yes; **not** as a live signal (negative result) |
| beat-the-close.js exact-equality join fix | e1-shopping-board-join | Real bug fixed (mirrors the fix already applied to nfl-shopping-board.js); on tonight's live capture, book count is byte-identical old vs. new in all 288 real combos checked — the true blocker is a 14-50+ min cross-tier polling cadence gap the join fix cannot bridge | Yes — genuine correctness fix, honestly labeled as not solving the original ask |
| Fill-aware execution sim vs. naive fill | e2-fill-aware-sim | Naive "full stake fills at posted price" overstates achievable size by 13.7% ($50) up to 73.8% ($5000) on 65,624+ real two-sided Polymarket snapshots | Yes — evidence-only branch (docs + a read-only measurement script), nothing wired into a live path yet |
| Unbounded quote-tape query bound + book-key fixes | e3-sharp-lag-unbounded | Bounded `bookLagDistribution`'s query (was unbounded and growing every season) and de-duplicated an aggregator/direct-feed double-count of the same book at different cadences; new index migration file (045, not applied to any live DB) | Yes — real fixes, migration file only |
| Season-bounded margin distribution + edge_vs_median | e4-execution-edge-seasons | Bounds the margin/teaser distribution to the same 1999-2024 window `margin-distribution.js` already uses (was silently including corrupted 2025-2026 spread data); replaces the shopping board's cross-side leaderboard field with one that cancels the known underdog reference-line bias | Yes — real correctness fixes to number consistency and ranking validity |
| News-timing verdict | news-timing | See above — a complete, real, honest "no" with an end-to-end trace | Yes — report + the underlying event-study fixes (entity extraction, multi-player status, event-study reaction model) it needed to be able to answer the question at all |

---

## Full suite results (after all six merges, in this integration worktree)

- `npm test`: **1924 tests, 1884 pass, 1 fail, 39 skipped.** The one failure
  (`test/nfl-execution-pipeline.test.js:62`, `resolveQuoteBasis`) is
  **pre-existing** — confirmed present on `model-2026-09-12-integration`
  *before any of the six branches were merged*, by running the full suite on
  the bare integration branch first (baseline: 1897 tests, 1857 pass, 1 fail,
  39 skipped — same single failure, same file, same line). **None of the six
  branches introduced a new failure.** The net +27 tests (1897→1924) is the
  sum of new regression tests added across the six branches.
- `npm run typecheck`: clean, no output, no errors.
- `npm run lint`: clean — "Syntax checked 659 JavaScript files."

## Conflicts encountered during merge

**None.** All six `git merge --no-ff` calls completed with no conflict
markers, verified by grepping the whole tree for `<<<<<<<` after every merge
and again at the end. The one file both `e1` and `e4` touch
(`nfl-shopping-board.js`) merged via git's own auto-merge (non-overlapping
hunks: `e1` only changed one `const` to `export const`; `e4` reworked the
rest of the file's ranking logic) — I read the full merged diff by hand to
confirm both changes are semantically present and coherent together, not
just textually non-conflicting: `CAPTURE_WINDOW_MS` is exported and imported
correctly by `beat-the-close.js`, and `edge_vs_median` / the season-bounded
ranking are intact. No migration-number collisions: only `e3` adds a
migration (`045_line_snapshots_market_captured_index.js`), and the base
branch's last migration was `044`.

## What needs review before anything here goes further

1. **Props-to-spread Stage 1** needs either a real anytime-TD prop feed or a
   materially better full-team yardage estimate before its fallback proxy is
   trustworthy for anything beyond mechanism-testing (unanimous 16/16 Under
   lean is a bias signature, not a finding).
2. **Props-to-spread Stage 2**'s walk-forward sample (9 explicit season/week
   cutoffs, 269 team-observations) is smaller than a full 54-cutoff sweep
   because `ensembleLine`'s cold walk-forward fit costs ~4 minutes per
   cutoff — the negative result is real and stated honestly, but a larger
   sample would be worth running before treating it as fully conclusive.
3. **e1**'s join fix is a genuine correctness fix but does **not** achieve
   the original stated goal (making BetRivers/FanDuel newly visible on
   tonight's board) — that requires polling the slow-tier books more
   frequently, which is out of scope for a join fix and is a real follow-up.
4. **e2** is evidence-only (a report + a script); nothing from it is wired
   into `execution-fill.js`'s live path yet — that integration, if wanted,
   is a separate piece of work.
5. One pre-existing, unrelated test failure
   (`test/nfl-execution-pipeline.test.js` `resolveQuoteBasis`) remains
   unfixed — it predates this entire batch and none of the six branches
   touch the code path it exercises.

## Ready to merge into `model-2026-09-12-integration` (pending Nick's review of the above)

All six branches: `insane-2026-09-13-props-to-spread`,
`insane-2026-09-13-e1-shopping-board-join`,
`insane-2026-09-13-e2-fill-aware-sim`,
`insane-2026-09-13-e3-sharp-lag-unbounded`,
`insane-2026-09-13-e4-execution-edge-seasons`,
`insane-2026-09-13-news-timing` — every one merges cleanly, breaks nothing
in the full suite, typechecks clean, and lints clean. "Ready to merge" here
means ready as *code*; per the verdicts above, the props-to-spread and
news-timing findings are **negative/null results to be read, not live
signals to be turned on**, and e1/e2 are explicitly partial (real fixes that
don't yet achieve their original stated goals).

This report was not merged into `main` and touches no running process or
live database — it exists only in
`/tmp/gridiron-insane-worktrees/integration` on branch
`insane-2026-09-13-integration`.
