# TDD evidence: fantasy-coordinator-head (2026-09-20)

Source: `fantasy-coordinator.js:571` was handed to this thread as the remaining
half of the same defect feature-audit is fixing in `trade-engine.js`, with the
contract stated as "pass the structural head, null when absent, no ensemble
fallback". Verified by reading before writing anything. No live database was
written, no deploy, no migration.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u /tmp/gridiron-XXXXXX).sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test --test-concurrency=1 test/fantasy-coordinator-head.test.js

## RED, then GREEN

A real RED commit, not a retroactive mutation: the rule was written first and
both tests failed against the unmodified source at `791b131`.

| | |
|---|---|
| RED | `dce4665` — 2 tests, `# pass 0`, `# fail 2` |
| GREEN | this commit — `# pass 10 # fail 0` across `fantasy-coordinator-head.test.js` + the pre-existing `fantasy-coordinator.test.js` |

RED output, both failures:

    not ok 1 - with no fit persisted, corrected_ppg is null rather than the ensemble number
      error: 'there is nothing to correct with, so a number here would be the ensemble wearing the corrected name'
      actual: 14   expected: null

    not ok 2 - the correction is added to the structural head, not to the ensemble
      actual: 14.129   expected: 11.129

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| `coordinateFantasy` (`:457`) | Third parameter is named `structuralPpg` and the return is `r3(structuralPpg + clamp(correction, -10, 10))`. The correction it blends was fitted with `target: actualPoints - projection.structural_ppg` (`:324`), and the header's TARGET line says the same. So the head is not a free choice; it is fixed by what the model was fitted against. | **Correct in place.** The function is right; both of its callers passed the wrong argument. |
| `weeklyProjectionFor` (`:571`) | Passed `projection.ppg`, the ensemble number. The gap between the two is `projection.ensemble_shift`, which is **itself one of the three experts** (`:32-34`, `weeklyExpertValues:415`). So `corrected_ppg` added the ensemble shift once outright and a learned multiple of it again through the fit. Both numbers are plausible fantasy-point figures — nothing threw, nothing looked wrong. | **Fixed**: pass `projection.structural_ppg`. |
| `weeklyProjectionFor`'s return (`:576`) | `corrected_ppg: coordinated?.ready ? coordinated.corrected_ppg : projection.ppg`. Unfitted — which is the live app's state until the background refit has run — the plain ensemble number is published under the name of a corrected one, beside `ensemble_ppg` holding the identical value. | **Fixed**: `null`. A caller's own fallback is its business; the field named `corrected_ppg` is not the place to keep it. |
| `routes/drafts.js:1050` (the only reader of the field) | `corrected_ppg ?? structural_ppg`. With `corrected_ppg` now null while unfitted, the draft sheet's "Our model, week 1" line would have silently dropped from the calibrated ensemble figure it prints today to the uncalibrated structural one. | **Widened to `corrected_ppg ?? ensemble_ppg ?? structural_ppg`**, so the printed number is byte-identical to today's in every state. Honest field, unchanged page. |
| `trade-engine.js:354` | Identical defect: `coordinateFantasy(fantasyFit, expertValues, weeklyPpg)` where `weeklyPpg` is `weekProjection?.ppg ?? (proj / GAMES)`. | **Not touched** — feature-audit's file. Routed to them through the coordinator with the line number. |
| `draft-assist.js:976`, `routes/players.js:94` | Both call this function inside `try { … } catch { return null; }`, the bare swallow CLAUDE.md forbids: a real fault in the projection engine reads as "no projection". | **Reported, not fixed.** Neither file is this thread's, and widening the change to two more owners' files under a GitHub freeze is worse than naming it. |

## Mutation: each changed line, shown failing on its own

Each row is one edit to the fixed source, the test file re-run, then a restore
from a pristine copy. Both were RUN at this commit.

| Mutation | Result |
|---|---|
| head back to `projection.ppg` | `# pass 1 # fail 1` — `not ok 2 - the correction is added to the structural head, not to the ensemble` |
| unfitted `corrected_ppg` back to `projection.ppg` | `# pass 1 # fail 1` — `not ok 1 - with no fit persisted, corrected_ppg is null rather than the ensemble number` |

Two guarded lines, two mutations, one dedicated failure each — neither test
covers for the other.

## Why the fixture is 11 and 14

`structural_ppg: 11`, `ppg: 14`. A fixture whose ensemble equals its structural
head produces the same `corrected_ppg` under either implementation and would
have passed against the defect. This is the vacuous-fixture shape the retroactive
mutation sweep on #38/#40/#44 turned up three times, so the fitted test asserts
`STRUCTURAL !== ENSEMBLE` before asserting anything else, and asserts the wrong
answer is *not* produced (`notEqual(corrected_ppg, round3(ENSEMBLE + correction))`)
as well as that the right one is.

`player-week-engine.js` is mocked by spreading the real module and overriding
three functions, because `boom-bust.js` and `trade-engine.js` import it too and
a bare mock would hand them an empty module.

## What this does NOT do

- It does not change `coordinateFantasy`, the fit, or any published Phase 3
  number. The gate result (p ~0.0005, MAE 4.28-4.40 vs 4.41-4.52) was measured
  by `gradeFantasyCoordinator` with `structuralPpg = 0` (`:521`), which grades
  the correction alone — the head bug never touched it. Nothing needs re-running.
- **The `routes/drafts.js` line is not covered by a test.** It is inline in a
  long text-sheet template inside a route handler with no existing harness, and
  building one for a single `??` chain in another thread's area is not worth the
  restructuring. Stated rather than implied: a mutation of that line passes the
  whole suite today.
- It does not wire `context`/regimes into anything. That experiment failed its
  own walk-forward gate and stays opt-in and uncalled.

## The five questions

Nick's standing rule of 2026-09-20 01:21Z: every evidence file answers these.

1. **Is it well built?** It removes a claim rather than adding a mechanism. One
   argument, one field, one consumer's fallback chain and a corrected module
   header. No new model, no new table, no new dependency.
2. **Is it based on stats or made up?** Stats, and specifically it is the *fit*
   that decides the answer rather than anyone's preference. `coordinateFantasy`'s
   third parameter is the head the correction is added to, and the correction was
   trained with `target: actualPoints - projection.structural_ppg`
   (`fantasy-coordinator.js:324`), graded as `|target - correction|` with
   `structuralPpg = 0` (`:519`), and described that way in the file's own header
   ("TARGET: actual_weekly_points - structural_ppg"). There is no reading of that
   contract under which the ensemble is the head.
3. **How do we know?** Three independent places in the file agree (the header, the
   example builder at `:324`, the grader at `:519`), and `ensemble_shift` is listed
   at `:32-34` as one of the three experts, which is what makes the ensemble head a
   double count rather than merely a different choice. The correction magnitude in
   the fixture is small (0.129 points), so the defect's size in production depends
   on the fitted correction, which nobody has measured on the live database —
   **and whether `activeFantasyCoordinatorFit()` returns a ready fit there at all is
   unconfirmed.** If it does not, this path is inert today and the fix matters from
   the first `fly secrets set AUTO_HEAVY_SYNC=1`, which is when
   `fantasy_coordinator_refit` (heavy tier) first runs.
4. **Should this data be pointed anywhere else?** It already is, and that is the
   other half of the finding: `trade-engine.js:354` had the identical defect on
   `current_week_ppg`. Every future caller of `coordinateFantasy` faces the same
   choice, which is why the argument's meaning is now stated at the call site
   rather than only in the header.
5. **How does it unify?** Both callers now pass the same quantity into the same
   parameter, so "the coordinated projection" means one thing across the app. The
   display question — what to show when there is nothing to correct — is answered
   separately and openly in each caller, instead of being smuggled into a field
   named `corrected_ppg`.

## Consumers, checked rather than assumed

`weeklyProjectionFor` has exactly two callers: `draft-assist.js:976`
(`week1_projection`) and `routes/players.js:94`, which serves `weekly_projection`
in an API response. A search of `server/`, `client/` and `scripts/` for
`corrected_ppg` finds only `routes/drafts.js` (fixed here) and `trade-engine.js`'s
own unrelated field, and no client code reads `weekly_projection` at all. So on
that route `corrected_ppg` goes null where it used to carry the ensemble, **no
surface changes**, and the payload stops labelling an uncorrected number
corrected. (Reported independently by the release thread's own search and
confirmed against these two call sites.)

## Why no `basis` field here

A `current_week_basis` field of `'coordinated' | 'ensemble'` was proposed for
`trade-engine.js`, where the not-ready path serves the ensemble as a real price
and one field therefore carries two quantities. This function is not in that
position: it returns `structural_ppg`, `ensemble_ppg` and `corrected_ppg` as three
separate named fields, so "which quantity is this" is already answered by which
field a caller read, and `corrected_ppg === null` says plainly that nothing
corrected it. A basis string would restate what the field names carry. If a
consumer ever wants one flag to branch on, it is a one-line addition and no
behaviour changes with it.

## Mutation bookkeeping

Both mutations above were verified **applied**, not assumed: the driver asserts
the anchor string occurs exactly once before editing and fails loudly otherwise, so
a silent no-op cannot be read as a green sweep. Each was restored from a pristine
copy of the file before the next ran.
