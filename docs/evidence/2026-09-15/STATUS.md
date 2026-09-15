# Execution status snapshot — 2026-09-15

Where the betting-model work stands, pushed to GitHub on branch
`cursor/betting-model-audit-fixes-1c85` (PR #6).

## Done and pushed
- Live-code audit + §0.1 reconciliation to `main`: `docs/evidence/2026-09-15/BETTING-MODEL-AUDIT-AND-PROFIT-PLAN.md`.
- Unified plan (M0-M5 / WP01-20 mapped to live status): `docs/evidence/2026-09-15/BETTING-MODEL-UNIFIED-PLAN.md`.
- Master implementation plan (papers/methods integrated, FIX/ADD per WP, R01-R28 gates): `docs/evidence/2026-09-15/BETTING-MODEL-MASTER-PLAN.md`.
- Research corpus shipped in-repo: `docs/betting-model/` (481 files).
- Ready-to-paste Linear import (Epic + M0-M5 + WP01-20 w/ acceptance): `docs/evidence/2026-09-15/LINEAR-IMPORT.md`.
- Repo-managed Cloud env: `.cursor/environment.json` (npm ci && npm run build; server terminal on 5177; scheduler off by default). Validated: install/build/typecheck/lint all pass here.
- Per-phase model assignment (fable Tier A / sonnet Tier B / grok Tier C) recorded in the plan.

## Phase 0 test triage — CLOSED (2026-09-15)
Full `npm test` (2,089 tests) now completes clean in a fresh isolated temp DB.
The interim "19 failures" above did not survive triage as real:
- **Missing `fast-check` devDependency.** Declared in `package.json` but absent from
  `node_modules` in this checkout — this alone failed every test in a file that imports
  it at module load (e.g. `nfl-ensemble-authority.test.js`) before a single assertion
  ran. `npm install fast-check@4.9.0` (matching the pinned version) resolved it;
  worth an `npm ci` on a fresh clone to confirm it isn't a lockfile drift.
- **One real regression, now fixed:** `docs/CLAUDE-NEXT-STEPS.md` had a navigation
  banner prepended above its required `# Gridiron HQ` H1 (from this branch's own
  earlier docs-reorg work), breaking `test/platform-paths.test.js`'s two tests that
  pin line 1 — and, more importantly, the real contract `nfl-research-lab.js` and its
  consumers rely on. Fixed by reordering (H1 first, banner second); both tests pass.
- **Everything else** (news/claim extraction, AI `POST /explain/page`, C05
  shopping/distribution) did not reproduce in a clean, complete run at all — the
  original 19 were most likely a combination of the fast-check failures cascading
  into unrelated-looking file names in the TAP summary, and a run that never actually
  finished (STATUS.md's own note: "still finishing/slow on a heavy file at snapshot
  time"). No skip dispositions needed; nothing here is being carried forward as
  accepted debt.

## WP15/D3 — DONE (2026-09-15)
Full frozen packet: `freezeT60Packet` (`server/services/nfl-t60-packet.js`) now
freezes real `game_context` values (weather/rest/division/neutral/opener, from the
game's own `game_lines` row) and the full league-wide `team_features` aggregate map
(`nfl-ensemble.js`'s `featureAggregates`, exported for this), plus a totals quote as
disclosed-but-unwired evidence (`nfl_quote_tape_totals`; no margin model consumes a
totals quote, and a real totals decision is gated on WP13). `ensembleLine` gained
`gameContextOverride`/`teamFeaturesOverride`; `autoPickDecisionBoardForPacket`
(`nfl-auto-picks.js`) now supplies both from the packet instead of re-reading
`game_lines`/`nfl_team_week_features` live. `PACKET_BOARD_INPUT_COVERAGE` updated
honestly (`total_market: 'in_schema_not_wired'`, not overclaimed as wired). Acceptance
test (freeze → flip live game_lines to the opposite rest/division state → force a full
ensemble cache invalidation → re-score → decision unchanged, while the live board
demonstrably would have moved) passes in `t60-packet-sourced-board.test.js`. C05's
frozen-packet retry/recovery is untouched (separate, already-partial concern).

## WP08 — DONE (2026-09-15), both R1 and R2
**R2:** `playerNewsSignal`/`teamNewsSignals` (`server/services/nfl-news-signal.js`)
compared `nfl_news_signals.created_at` (written by the table's own
`DEFAULT (datetime('now'))`, SQLite's space-separated format) directly against an ISO
`cutoff` parameter as TEXT. Confirmed empirically (node:sqlite, this project's own
driver): because `' '` (0x20) sorts before `'T'` (0x54), a row whose `created_at` was
the literal current instant still compared `<=` a cutoff from an hour earlier, for any
same-calendar-date pair — silently defeating the one look-ahead guard that comparison
exists for. Every existing test had hand-supplied `created_at` in ISO format, which
never exercises the real DEFAULT and is why this survived. Fixed by wrapping both
sides in SQLite's `datetime()` (same pattern already used for `draft_at` in
`draft-ingest.js`); no data migration needed since stored values were never wrong,
only compared incorrectly. New regression tests write `created_at` in the real format
directly and were confirmed to fail without the fix.

**R1:** `nfl_news_signals` is now genuinely append-only (migration
`053_nfl_news_signals_versioning.js`). Rebuilt with a surrogate
`id INTEGER PRIMARY KEY AUTOINCREMENT` (replacing
`PRIMARY KEY (news_id,player_key,signal_type)`, which forced the old overwrite-in-
place), `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)` (same pattern as
`nfl_feature_revisions`), and the mutation-journal triggers recreated verbatim (they'd
otherwise silently vanish — migration 000, which installed them originally, never runs
again on an existing database). `syncStructuredNewsSignals`/`syncAiNewsSignals` now
insert a new version only when content genuinely differs from the current one
(`upsertVersionedSignal`); an unchanged re-sync is a no-op, matching this WP's own
acceptance ("repeating the same fetch does not duplicate versions"). `playerNewsSignal`/
`teamNewsSignals` resolve the version that was actually current **as of their own
cutoff** (a `NOT EXISTS` filter, not just "the latest version") — confirmed with a
direct test: a cutoff between two versions sees the older one, a later cutoff sees the
correction.

Discovered mid-implementation and handled: 7 other files read `nfl_news_signals`
directly assuming one row per key (`news-lag-trader.js`, `nfl-capture-dispatch.js`,
`nfl-news-market-latency.js`, `nfl-rookie-ingest.js`, `signal-latency.js`,
`polymarket.js`, `who-plays.js`, plus `routes/news.js`) — all repointed at a new
`nfl_news_signals_current` view (one row per key: the latest version, same column
shape as before) so "the current claim" keeps meaning what it always meant for them.
`signal-latency.js`'s `pipelineHealth()` row-count diagnostic deliberately still reads
the raw table (write-activity monitoring, not current-state).

## WP14 — DONE (2026-09-15)
Investigation first: WP14's own dependencies (WP11-13, the trained Python candidate)
don't exist yet, but re-reading C09-C11 against the current code found most of the
underlying infrastructure already built by earlier work — C09 (`<3 seasons` reported
`robust:true`) was already fixed (`nfl-replay.js`'s `robustAcrossSeasons` correctly
returns `insufficient_data`); C11's "no numerical consumer" labeling already exists
(`nfl-family-contribution.js`'s `familyConsumers()`); and `nfl-decision-tape.js`
already saves **every** game each week — eligible or abstained, with frozen
`feature_snapshot_json` context — via `recordDecisionRun`, called weekly by
`scheduler.js`'s `refreshNflDecisionLedger`. What neither existing error-analysis tool
actually did was READ that: `analyzeErrors` only ever sees settled bets (needs a price,
a stake, a result), and `nfl-slice-diagnostic.js` reads a different, older table
(`nfl_weekly_expert_examples`) tied to the expert-council family, not the production
ensemble's own decisions.

Added to `nfl-replay.js`: `decisionTapeForecastRecords({seasons})` — row-level forecast
records sourced from the decision tape, one row per game per week that has both a
recorded decision AND a final score, whether or not the policy ever bet it (a no-bet
game still carries a real frozen `projected_margin`, gradeable against the final score
exactly like a bet's can). `forecastAccuracyReport(records)` — a descriptive MAE/
beat-market summary, deliberately NOT a second significance-test implementation
(`analyzeErrors`/`nfl-family-contribution.js` already own that); explicit
`insufficient_data` below the read floor (C09/R28), and `by_season` kept structurally
separate from the pooled cohort so a single season can never pass as a multi-season
result (this WP's own acceptance).

Explicitly NOT done, and named as blocked rather than faked: C11's "verify full refits
and upstream lineage for the new Python candidate" and totals wiring both require
WP11-13's actual trained candidate and totals contract, neither of which exist yet.

## FIX#28 (one CLV module) — DONE (2026-09-15)
The ORIGINAL "four independent CLV calculators" the corpus named (`nfl-clv.js`,
`nfl-execution-clv.js`, `forward-ledger.js`, `shadow-ledger.js`) were already
consolidated into `clv-core.js`'s `signedClvPoints()` by earlier work (`nfl-clv.js`
deleted outright; see that module's own docstring) — re-verified, not re-fixed.
Investigation found the SAME disease had regrown since: `sharp-lag.js` and
`beat-the-close.js` had each grown their own independent inline CLV-points formula,
never wired to `clv-core.js`. Verified both were mathematically identical to
`signedClvPoints()` (worked through the sign algebra for home/away and spread/total
before touching either), then replaced both with real calls to it —
`beat-the-close.js` converts its home-perspective stored lines to backed-side
perspective at the one call site that needs it; `sharp-lag.js` needed no conversion
(its rows are already keyed per side). All 33 existing tests for both files pass
unchanged. `nfl-drive-sim.js`'s `clvReport()` was investigated and deliberately left
alone: its `clv_points` grades a hypothetical bet at the OPEN against the CLOSE for
walk-forward model validation, a genuinely different measurement from a real settled
decision's CLV — the same kind of exception `clv-core.js` already carved out for
`nfl-prop-clv.js`'s probability-delta metric.

## FIX#14 (ridge team strength) — investigated, real-data-confirmed NO CHANGE (2026-09-15)
`nfl-ensemble.js`'s Massey rating already had the ridge machinery built
(`MASSEY_RIDGE_LAMBDA`, closed-form, `lambda` parameter) but shipped at `lambda=0`
(OLS) because an earlier sweep against a SYNTHETIC fixture found the ridge-shrunk
component improved (13.823→13.583 RMSE) but the full ensemble did not (WORSE in 4/5
seeds) — with an explicit caveat that real NFL schedules are more unbalanced than the
fixture's round-robin, so "this measurement may understate the ridge." This session
finally ran that real-data check the prior work flagged it couldn't: copied
`server/data.sqlite` to a scratch location (never touched the real file), read
`game_lines` directly (bypassing an unrelated old-schema migration snag in that
snapshot), and re-ran the identical lambda sweep {0,1,2,5,10,20,50,100,200,500}
against 3,028 real games (2015-2025), held out on 2021-2025 (1,424 graded games).
Result: lambda=50 is again the pooled optimum, and the real-data improvement is
genuinely bigger than the fixture's null result (13.8385→13.7842 RMSE, 0.39%) —
confirming the caveat's direction. But it is not robust enough to promote: only 3 of
5 seasons individually improve (2022/2023/2024 better, 2021/2025 worse), below the
same "≥2/3 of seasons must agree" bar this codebase applies elsewhere
(`nfl-replay.js`'s `robustAcrossSeasons`). No ensemble-level re-check was run — no
point re-fitting 20+ models' weights across a lambda grid to chase a benefit whose
own component-level input already fails the season-robustness bar the synthetic
result also failed at the ensemble level. **Decision: keep `lambda=0`.** The finding
is now real-data-confirmed rather than a fixture-only hypothesis, and written into
the code's own docstring so the numbers exist the next time this comes up.

## Immediate front (order)
WP15/D3 (done) -> WP08 (done) -> WP14 (done) -> FIX#28 (done) -> FIX#14 (investigated,
no change) -> WP12-13 walk-forward + conformal -> unity (family adapters -> gated
comparison + tree_lab -> Node bridge). Each behind the gates, registered as a trial,
no staking authority.

## Time / effort read
- Engineering, full 20-WP scope: the corpus's own estimate is ~41-78 engineer-days of
  focused work (`docs/betting-model/plans/archive/MASTER-PLAN-2026-09-14.md`). These are
  engineer-days, not calendar time, and parallelize across the model-tier assignments.
- First complete frozen-shadow spread path (the immediate front above): the ~15-30
  engineer-day slice within that.
- **Profit/qualification is NOT bounded by engineering.** Promotion needs ~250 settled
  forward decisions with positive CLV (currently 0). Those accrue only as the 2026 season
  is actually played (one week settles at a time), so the binding clock is the season,
  not development. Realistically most/all of a season before any promotion is even askable.
- Honest expected outcome remains: a trustworthy, reproducible, unified pipeline that
  most likely shows **no robust spread edge** - proven forward, not asserted.
