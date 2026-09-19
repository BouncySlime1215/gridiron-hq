# Execution status snapshot — 2026-09-15

Where the betting-model work stands on branch
`cursor/betting-model-audit-fixes-1c85` (PR #6). The September 15 Codex continuation
below is locally implemented and verified; this update does not claim a remote push.

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

## WP12 — JS half DONE, Python half BLOCKED (2026-09-15)
Most of WP12 was already built and was verified rather than rebuilt:
`forecast-combination.js` already refits **weekly** by default (`refit: 'week'`,
matching what `ensembleLine` actually does in production), already refits the
component reduction on the training block only at every cutoff, already treats
equal-weight and inverse-MSE as first-class candidates rather than straw men,
and already gates every comparison on Diebold-Mariano with the
Harvey-Leybourne-Newbold correction clustered by week. The acceptance criterion
"a held-out outcome mutation does not change its model" already had tests at
both season and week cadence.

What was genuinely missing were WP12's two named lineage deliverables, now
added: (1) **immutable split manifests** — every fitted cutoff records the
content-addressed identity of its own train/test split (sha256 over the sorted
row-id list, so reordering the same rows hashes identically and one row moving
across the boundary does not), with full row-id lists behind
`includeSplitRowIds` so the cheap "is this the split I recorded" check never
needs the expensive payload; and (2) an **active same-game straddle guard** that
refuses — throws, not filters — a cutoff with one game's rows on both sides,
because silently dropping the row would hide that the fit and every score past
it are contaminated.

One design correction worth recording: the guard first derived game identity
from `season|home|away`, which the module's own synthetic fixtures immediately
falsified — they recycle sixteen matchups through a season, so a derived key
reported every recycled matchup as a leak. Game identity is now **read, never
inferred** (`game_id`), and when rows do not state one the manifest says
`not_verifiable_no_game_id` rather than reporting a clean pass (R28).
`componentPredictionStream` now states `game_id`, so the real production stream
reports `verified_by_game_id`.

**Python half: unblocked, but mind the interpreter.** This was briefly recorded
as blocked because `python3` could not import `sklearn`. The cause was not a
missing install but the WRONG INTERPRETER being first on `PATH`:

- `/opt/homebrew/bin/python3` → Python **3.14**, no sklearn. This is what a bare
  `python3` resolves to, and what made the research modules look broken.
- `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3` (also
  `/usr/local/bin/python3`) → Python **3.12** with **sklearn 1.9.1, numpy
  2.2.2, joblib** installed. This is the one that works.

Verified with that interpreter: `market_lab` and `tree_lab` both import, and
`python3 -m unittest test_tree_lab test_market_lab test_dataset` runs **42 tests,
all passing**. `lightgbm` is NOT installed, and `tree_lab` imports fine without
it (it uses sklearn's own `HistGradientBoostingRegressor`); anything that needs
lightgbm specifically would still need it added.

Worth pinning this interpreter explicitly (a venv, or an absolute path in the
research entry points) before the bridge work — the failure mode is silent and
looks exactly like "the library isn't installed."

## WP13 — totals contract DONE, serving path still open (2026-09-15)
Also mostly already built, and verified: `spread-probabilities.js` already owns
push-aware win/push/loss triples, exact-price EV, key-number behaviour,
opposite-side reconciliation and fail-don't-clip validation; calibration is
already bound to `forecastIdentity` (R15); and `predictiveDistribution()`'s
undefendable `1 + min(0.25, disagreement/30)` interval inflation has already
been replaced by a **split-conformal, Mondrian-binned** interval, which is
ADD#15/#18's actual content.

The genuinely open item was C12 — totals were not a first-class contract at all,
only a spread one. Added `server/betting/nfl/contracts/total-probabilities.js`:
a complete Over/Push/Under path with its own semantics, explicitly NOT a renamed
spread. The differences that a rename would have broken, and which the tests
pin: a total line is the **same number for both sides** (the side picks the
direction of comparison, not the number — unlike a spread handicap, which is
side-relative and which the spread module converts by negating the margin); the
push condition is `T = L`; the outcome variable is a **non-negative sum**, so a
margin distribution handed to the totals path is refused outright rather than
priced; and reconciliation happens at the same line, one level down, in each
side's own win/push/loss frame (comparing two over/push/under triples would be
vacuous, since that partition is side-neutral — caught by a failing test, not
by inspection). Price arithmetic is imported from the spread module rather than
re-derived, so there is still exactly one implementation of the economics.

**Still open:** the totals contract is not yet wired into a serving path — a
totals DECISION needs the WP15-17 board/settlement work, and this package
deliberately stops at the contract rather than renaming the spread board.

## Immediate front (order)
WP15/D3 (done) -> WP08 (done) -> WP14 (done) -> FIX#28 (done) -> FIX#14 (investigated,
no change) -> WP12 (JS done, Python imports/tests available; full weekly pipeline still open) -> WP13 (totals contract done,
serving path open) -> **unity: family adapters -> gated comparison + tree_lab -> Node
bridge — the single biggest remaining item, and the one that finally lets the ALREADY
TRAINED Stage 3 model be scored by the app instead of sitting on the shelf.** Each
behind the gates, registered as a trial, no staking authority.

### Python runtime reconciliation — September 15 continuation
The original research venv still exists and works, including LightGBM. The
previous `pip install` blocker was caused by checking the wrong interpreter.
The original venv has sklearn 1.7.2, numpy 2.5.3, joblib 1.6.0 and LightGBM 4.7.0,
matching the saved ridge artifact's recorded dependencies. The newer framework
Python is useful for new fits but does not match that artifact's sklearn/numpy
versions. The new adapter uses an explicit `GRIDIRON_RESEARCH_PYTHON` or the
project's `research/.venv` and refuses incompatible saved-model runtimes.

### What unity will and will not buy
It makes the trained model **servable and judgeable**. It does not make it profitable:
Stage 3 already ran on 6,499 real games and lost to the close (market MAE 10.249 vs
ridge 10.675 / LightGBM 10.738), and the corpus's own literature explains why
(Lopez-Matthews-Baumer: the closing line already encodes team strength;
Claeskens: more components make an estimated combination worse, not better). Unity is
what turns "we think it loses" into "we measured it losing, forward, under gates."

## Codex continuation — first Python scoring connection (September 15)

Recovered Claude session `c174766b-2011-40dd-b469-744caef3a0e5` and its six
unfinished WP12/WP13 files at base `ace62c8`. Its final background suite had
finished successfully after the session limit. Preserved those edits and
continued the next serving-boundary work.

- **Implemented:** Node calls the original saved Stage 3 ridge pipeline through
  `server/betting/nfl/forecast/python-artifact.js`, Python `score_artifact.py`,
  `trainedMarginFamilyForecast` and `scripts/score-nfl-artifact.mjs`. Requests
  retain actual features and exact model/metadata hashes. No model reimplementation.
- **Verified:** exact Node/Python parity on the existing artifact for all 16
  completed 2026 Week 1 games; maximum absolute difference 0. This is historical
  reconstruction and engineering evidence, not prospective T-60 or profit evidence.
- **Corrected:** adapter output no longer rounds a valid probability triple back
  into an invalid sum. New training identities include actual feature/label contents,
  package versions, target and preprocessing; corrected source rows cannot reuse
  stale `_features`. Old artifacts are preserved unchanged.
- **Remaining:** upcoming-game feature freeze and receipt lineage, weekly fitting,
  calibrator/combiner identities, scheduled candidate scoring and all-game recording.
  The separate `tree_lab` cover classifier remains unconnected. The served ridge
  margin model has no cover-probability calibrator and receives no betting authority.
- **Scope:** this first bridge deliberately accepts reconstructed research requests
  only. WP15 and the complete learned shadow path are still **partial**.

See [scoring instructions and limits](../../../research/betting/nfl/SCORING.md).

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
