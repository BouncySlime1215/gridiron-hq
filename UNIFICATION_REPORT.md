# Unification report — nfl-clv.js / replay engines / decision writer

Branch: `unify-2026-09-12-unify-systems`, worktree `/tmp/gridiron-unify-worktrees/unify-systems`.
This report covers both stages as instructed. Stage 1 predates this session; stage 2 is the work
done in it, on 2026-09-13.

## Stage 1 (as found, not redone)

The worktree's branch tip when this session started was `15aa5e9 "Make the forecast actually
consume the frozen T-60 packet"`, one commit past `model-2026-09-12-integration`'s tip
(`e7662e7`). That commit's own subject does not match "collapse duplicate engines" — it's a T-60
packet-consumption fix, not CLV/replay/decision-tape prep. I'm reporting this rather than papering
over it: whatever prior session ran "stage 1" of this specific unify-systems task did not leave a
commit here whose message matches that scope.

What the task's stage-2 instructions assumed as already true, I verified independently by reading
the code rather than trusting the commit log:

- **clv-core.js already existed** as "the one shared CLV convention" (its own header dates this to
  an earlier "Giant Plan 8.1 / audit-consolidation stage 3" pass, `938da92` in the base branch's
  history) — `signedClvPoints`, the fair-probability math, `noVigProbability`, and
  `recordClvGrade`/`nfl_clv_grades` were all real and already in place. `nfl-sharp.js` and
  `nfl-execution-clv.js` already depended on it. This part of the task's premise held.
- **nfl-clv.js was still live**, exactly as the task said: scheduled via `scheduler.js`'s
  `refreshNflLineSnapshots` job (dynamic import at the old line ~275) and routed to directly from
  `nfl-betting.js` (`recordBet`/`listBets`/`gradeClosingLineValue`/`clvReport`/`clvBySource`, old
  lines 38 and ~869-931). It had NOT been folded into clv-core.js — only its math had been, three
  stages earlier, leaving nfl-clv.js alive as a thin-plus-ledger wrapper.
- **The replay engine importer counts were confirmed as described**: nfl-replay.js has 16
  importers; nfl-neural-replay.js has exactly one (`nfl-diagnostic.js`, static import); one
  correction — nfl-props-replay.js is not zero-importer in the strict sense, it has one live
  caller via `nfl-betting.js`'s dynamic-dispatch diagnostics route (`case 'prop-replay'`), which a
  static-import-only importer count would miss. It is still, functionally, orphaned from any
  "engine" wiring the way nfl-replay.js is wired.
- **The decision-writer duplication was confirmed and found worse than described**: not only did
  `scheduler.js`'s `refreshNflDecisionLedger` call both `persistPickDecisions` and
  `recordDecisionRun` independently from the same board, `nfl-market.js`'s `/sync-and-pick` route
  called `persistPickDecisions` **alone**, with no tape write at all — a second, undocumented
  independent write path to `nfl_pick_decisions`.

## Stage 2 — what was actually done this session

### 1. Deleted `server/services/nfl-clv.js`

Its math (`americanToProb`, `americanToDecimal`, `noVigProbability`,
`proportionalNoVigProbability`, `fairProbabilityOfOurBet`, `signedClvPoints`) already lived in
`clv-core.js`. Its genuinely unique code — the `nfl_bet_log` ledger (`recordBet`,
`closingConsensus`, `gradeClosingLineValue`, `clvReport`, `listBets`, `clvBySource`, plus the
`median`/`modal`/`opposingSide` helpers they need) — was moved into `clv-core.js` verbatim, along
with the two imports it needs (`./line-shopping.js` for its `nfl_line_snapshots` side effect, and
`isFreshQuote` from `book-feeds.js`). `clv-core.js`'s header docstring now documents this second
merge explicitly.

Every importer repointed at `clv-core.js`:
- `server/routes/nfl-betting.js` (static import)
- `server/services/scheduler.js` (`refreshNflLineSnapshots`'s dynamic import)
- `server/services/nfl-sharp.js` (one static import, one dynamic import)
- `test/model-integrity.test.js` (the CLV test section's dynamic import)

Prose-only comment references in `gamescript.js`, `forward-ledger.js`, `nfl-execution-clv.js`,
`nfl-execution-clv-downsize.js`, and `nfl-devig.js` were updated to point at `clv-core.js` instead
of the deleted file. `nfl-execution-clv.js`'s `CLV_GRADING_VERSION` string
(`'nfl-clv-v2-c13-c14-canonical-event-full-game'`) was deliberately left unchanged — it is a
persisted version identifier, not a file reference, and changing it would be a data-identity
change, not a rename.

**Not touched**: `server/db/schema/nfl-a-to-m.js` and its `.manifest.json`. That directory's own
README declares it frozen — "reproduces the schema exactly as it existed at the
`001_baseline_marker` cutover... do not add a table or column here" — and its `sources` arrays are
historical provenance for a byte-for-byte snapshot proof (`scripts/schema-snapshot.mjs`), not a
live import list. `nfl-clv.js` doesn't even define the DDL attributed to it there anymore (a
comment in the old file said `nfl_bet_log`/`idx_betlog_event` come from
`migrations/000_legacy_schema.js`) — the manifest is simply stale-by-design, and editing a frozen
snapshot file to "fix" that would violate its own contract.

### 2. Replay/backtest engines

**nfl-neural-replay.js → merged into nfl-replay.js, then deleted.** This settles the flagged
archive-vs-merge dispute in the direction the task specified: merge, not archive. Its one importer
(`nfl-diagnostic.js`) and one test (`test/model-integrity.test.js`) now import
`fitNeuralDecisionCalibrator`/`calibratedNeuralProbability`/`latestHistoricalNeuralReplay` from
`nfl-replay.js`. The merge is a straight move, not a rewrite: nfl-replay.js's own `replaySeason`
loop (ensemble + policy engine) and the neural engine's loop (an evolving online network trained
week-over-week with its own ridge-logit cover calibrator) are genuinely different mechanisms, so
the neural code keeps its own helpers rather than being forced onto `replaySeason`'s. Only one
real collision existed (`unitsFor`, different signatures in each file) — the neural version's
internal helpers were renamed with a `neural`/`r3` prefix (`neuralUnitsFor`, `neuralNoVig`,
`neuralPhase`, `neuralVector`, `neuralSolve`, `neuralSummarize`) to avoid silently shadowing or
colliding with `nfl-replay.js`'s own `r2`/`unitsFor`/`noVigProb`. Two loop-local variables named
`row` inside the ported `solve` function were renamed (`mrow`/`r`) since `nfl-replay.js` now also
imports the real `row()` db helper the neural code never needed before.

**nfl-props-replay.js — confirmed distinct, not merged.** Player-prop replay against a synthetic
proxy line (no historical prop market exists) at fixed -115 juice with its own permutation-test
null, versus nfl-replay.js's game-sides/totals replay against the real stored closing number at
stored historical prices under the production policy engine. Different inputs, different line
source, different grading math, different validation method. A cross-reference note was added to
its header recording this conclusion in code, not just in this report.

**weekly-walkforward.js vs. `server/modeling/walk-forward.js` — investigated, not merged.** This
is the "sibling script" the task's own count of seven replay/backtest engines implies (the six
`*-replay.js`/`weekly-walkforward.js` files plus this one make seven). I looked for a literal
duplicate CLI script across `scripts/`, `server/scripts/`, and `research/` before concluding this
was the intended pair — none exists; the only thing sharing "walk forward" semantics with
weekly-walkforward.js's hand-rolled season/week loop is this generic module-lab contract.
Investigated and declined:
- **Different observation shape.** `createWalkForwardSplits` requires a timestamped
  `player_id`/`season`/`week`/`as_of` row (enforced by `assertTimestampedObservation`);
  weekly-walkforward.js's rows are per-GAME with no player identity and no `as_of`.
- **Different holdout semantics.** `createWalkForwardSplits` permanently seals the LATEST season —
  it never appears in `splits`, only via an explicit, authorized `openFinalHoldout`.
  weekly-walkforward.js's entire purpose is to walk and grade EVERY season it's given, including
  the latest one, to show whether accuracy rises with training size across the full history.
  Routing it through the sealed-holdout contract would mean fabricating a fake later "holdout"
  season just to unlock grading the real one, or losing the final-season grade the whole report
  depends on.

A shared name is not shared logic here. Cross-reference notes were added to both files' headers
recording the investigation and the reasoning, so a future reader doesn't have to redo it.

### 3. One decision writer

`persistPickDecisions` (`nfl-auto-picks.js`) is deleted outright — it was an independent UPSERT
into `nfl_pick_decisions` straight from a caller-supplied board, unrelated to whatever the tape
had recorded. In its place, `nfl-decision-tape.js` gained `refreshPickDecisionsCache(runId)`,
which reads a run's own `nfl_decision_events` rows back and UPSERTs `nfl_pick_decisions` from
*that* — never from a raw board. `recordDecisionRun` calls it internally on both return paths
(a freshly-written run and an idempotent-retry of an existing one), so every caller of
`recordDecisionRun` gets the cache for free without knowing it exists.

Three call sites changed:
- **`scheduler.js`'s `refreshNflDecisionLedger`** used to call `persistPickDecisions` AND
  `recordDecisionRun` from the same board — two writes, one derived from nothing. Now it calls
  only `recordDecisionRun`.
- **`nfl-market.js`'s `/sync-and-pick` route** used to call `persistPickDecisions` ALONE — the
  worst case, a write to `nfl_pick_decisions` with no tape record backing it at all. It now calls
  `recordDecisionRun` with its own observation identity (`experimentId:
  'nfl-sync-and-pick-manual'`, `horizon: 'manual_weekly_workflow'`), wrapped in the same
  try/catch-and-report-error pattern the scheduler already used, so a tape-write failure (e.g. a
  genuinely conflicting retry) surfaces in the response instead of silently blocking the rest of
  the button's work (line sync, pick locking).
- **`t60-runner.js` and `nfl-execution-pipeline.js`** already called only `recordDecisionRun` and
  never `persistPickDecisions` — they now populate `nfl_pick_decisions` too, which they never did
  before. Net new coverage, not a regression.

Verified with three new tests in `test/nfl-decision-tape.test.js` (all passing): the cache is
populated correctly from tape events for both an eligible and an abstained decision, a later run
for the same (season, week, policy, matchup, market, selection) key overwrites the cache row while
both runs remain intact on the append-only tape underneath, and `nfl-auto-picks.js` no longer
exports `persistPickDecisions` at all.

## Resulting architecture

- **CLV**: one module, `clv-core.js` — shared math, the `nfl_clv_grades` opportunity ledger, and
  now the `nfl_bet_log` manual/model bet ledger too. `nfl-prop-clv.js` remains separate by design
  (a probability-delta measurement against player-prop lines, not a duplicate).
- **Replay/backtest**: `nfl-replay.js` is now the ensemble-policy engine AND the online-neural
  prequential engine, offered as two distinct exported entry points in one file rather than two
  files with one real importer between them. `nfl-props-replay.js` and `weekly-walkforward.js`
  remain separate engines, each now documented as deliberately separate rather than silently
  divergent. `nfl-ai-replay.js` and `nfl-execution-replay.js` (the other two of the "seven") were
  out of this task's explicit scope and untouched.
- **Decision writer**: the append-only tape (`nfl_decision_runs`/`nfl_decision_events`, written
  only by `recordDecisionRun`) is the sole writer of everything, including the
  `nfl_pick_decisions` latest-view cache, which is now purely derived and never written on its
  own. `nfl_pick_decisions`'s row shape and UPSERT key are unchanged, so nothing reading it (e.g.
  `nfl-expert-council.js`) needed to change.

## Engine disputes resolved with judgment (stated reasoning)

1. **nfl-neural-replay.js: merge, not archive.** The task named this as a flagged dispute and
   specified the resolution outright ("resolve it here by actually doing the merge"); I executed
   it as a same-file merge rather than trying to unify its training loop with `replaySeason`'s
   policy loop, since they model genuinely different things (a static ensemble evaluated against
   a fixed policy, vs. an online network that changes every week) and forcing one onto the other's
   shape would have been a rewrite, not a merge.
2. **weekly-walkforward.js vs. `server/modeling/walk-forward.js`: investigated, left separate.**
   My own call, reasoned above — the two share a name and a surface concept but not a data shape
   or a holdout contract, and forcing them together would cost weekly-walkforward.js the one
   property (grading every season, including the latest) its own report exists to provide.
3. **nfl-props-replay.js: confirmed genuinely distinct, not merged**, per the task's own
   instruction to confirm-or-merge based on investigation. One correction to the task's framing:
   it is not literally zero-importer — `nfl-betting.js`'s diagnostics route dispatches to it
   dynamically by string (`case 'prop-replay'`), which a static-import count would miss.

## Validation

Full suite: `GRIDIRON_DB_PATH=<fresh /tmp path> SCHEDULER_DISABLED=1 npm test` —
**1904 tests, 1864 pass, 1 fail, 39 skipped.**

The one failure (`test/nfl-execution-pipeline.test.js`, "resolveQuoteBasis: prefers the real
multi-book quote tape when this event is actually covered by it") was confirmed **pre-existing**:
it fails identically on the unmodified branch tip (`15aa5e9`), verified by stashing every change
in this session and re-running that file alone before restoring. It is unrelated to CLV, replay
engines, or the decision tape, and this session made no changes to
`nfl-execution-pipeline.js` or `nfl-execution-pipeline.test.js`.

No code path writes to `nfl_pick_decisions` independently of the tape: `persistPickDecisions` no
longer exists (asserted by test), and every remaining writer of `nfl_decision_runs` — the
scheduler's forward ledger, the T-60 runner, the execution pipeline, and the manual
`/sync-and-pick` route — goes through `recordDecisionRun`, which is now the only code that touches
`nfl_pick_decisions`.

No dangling imports: grepped the full repo (`server/`, `client/`, `scripts/`, `test/`) for any
remaining `from '.../nfl-clv.js'` or `from '.../nfl-neural-replay.js'` after both deletions —
zero hits outside historical prose comments and the frozen schema-snapshot files (left
untouched, see above).
