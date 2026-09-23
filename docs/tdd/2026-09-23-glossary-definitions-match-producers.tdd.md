# The glossary described six numbers the code no longer makes

RED `48e9e776` "test: pin the six glossary meanings against their producers (RED)" ·
GREEN `9577a1ca` "fix: correct the six glossary definitions to match their producers" ·
`test/glossary-definitions-match-producers.test.js`, 6 tests.

## What already existed (audit)

PR #75 (`claude/project-thread-xiezr0-basis-chip`, based on #73) added
`client/src/lib/glossary.ts` — one record per quantity — and
`test/glossary-and-basis.test.js`, which checks that every entry has
`name/plain/raw/unit/precision` present and that the two `floor` quantities
stay separate. It does not check that `raw` resolves to a field any producer
serves, or that the sentence's horizon/unit words match the served
construction.

R&D's round-7 internal package
(`rnd/loop/r7-internal-glossary-defines-numbers-code-no-longer-makes.md`,
read-only against `origin/main` `287e36b1` and the PR branch `64420d39`)
found six of the fifteen entries wrong against main this way: a different
horizon, a different unit, or a `raw` field that does not exist. That
presence-only test passes on all six, since nothing it checks depends on
what `raw` names or what the sentence claims.

This unit: extend-not-build. `glossary.ts` and `glossary-and-basis.test.js`
already existed and are the right place for this; the gap was a second test
file that checks meaning, plus fixing the six entries themselves.

## RED — the failing assertions

`node --experimental-test-module-mocks --test --test-reporter=tap
test/glossary-definitions-match-producers.test.js` on `48e9e776` (glossary.ts
unfixed): 6 tests, 0 pass, 6 fail.

- `week_floor`: `AssertionError: the sentence promises the floor is never a
  total bust, but the p10 draw includes the games he does not play at all`
- `season_floor`: `AssertionError [ERR_ASSERTION]` on
  `assert.equal(field(b, 'raw'), 'evidence.preseason.p20', ...)` —
  actual was `'career.p20'`.
- `expected_wins`: `AssertionError: expected_wins is a season total including
  games already played (season-sim.js:126,364), not a rest-of-season count`
- `start_score`: `AssertionError [ERR_ASSERTION]: lineup.score is not a field
  any route serves` (`notStrictEqual` on the literal `'lineup.score'`).
- `title_delta`: `AssertionError: the paired seed does not guarantee this
  while the draw order can shift with the trade (season-sim.js:313-356) —
  the sentence must not promise it`
- `points_allowed_to_position`: `AssertionError [ERR_ASSERTION]:
  matchups.dvp.ppg_allowed is not a field matchups.js emits`
  (`notStrictEqual` on the literal `'matchups.dvp.ppg_allowed'`).

## What it does

Each test in `test/glossary-definitions-match-producers.test.js` does two
things per entry: (1) a contract check that the cited producer line still
exists in the shape the test expects (so a future refactor that removes it
fails loud, not silently), and (2) a meaning check that the entry's `raw`
and `plain` sentence describe what that line actually computes, with a
control that fails if the "wrong" fact were somehow already true (e.g. a
`career.p20` control asserting `lineup-brain.js` never defines that field —
if it ever did, the old raw path would have been defensible).

`client/src/lib/glossary.ts` fix, per entry, with the producer cited inline
as a comment next to it:

| Entry | Producer file:line | Fix |
|---|---|---|
| `week_floor` | `server/services/trade-engine.js:462` (`floor: weekDist?.p10 ?? ...`) | sentence now says the floor can be a week he does not suit up at all |
| `season_floor` | `server/services/lineup-brain.js:187` (`p20: r1(preseason.p20)`) | raw `career.p20` -> `evidence.preseason.p20`; unit `points_per_game` -> `points`; name -> "Preseason band (low)" |
| `expected_wins` | `server/services/season-sim.js:126,364` (`initialRecords` seeds `startingRecords`) | sentence now says the total counts games already played |
| `start_score` | `server/services/lineup-brain.js:363,474` (`week_points`, solved by default) | raw `lineup.score` -> `lineup.week_points` |
| `title_delta` | `server/services/season-sim.js:313,356,476` (roster-order-dependent draw, paired seed) | sentence no longer claims the difference is purely the move; states residual noise |
| `points_allowed_to_position` | `server/services/matchups.js:189` (`allowed`), `:9-14,94-102` (multi-season blend, tested, did not predict) | raw `matchups.dvp.ppg_allowed` -> `matchups.dvp.allowed`; sentence -> multi-season blend, tested and did not help |

Also fixed in the same commit: `test/glossary-and-basis.test.js`'s
availability-basis test matched an inline ternary in `contingency.js` that
main's merge had already replaced with a shared canonical list,
`AVAILABILITY_FIT_BASIS` in `server/services/availability-basis.js`
(`contingency.js:610-611` now destructures it). The test failed after
merging main for a reason unrelated to this unit's six entries; re-pointed
it at the canonical source rather than the consumer, which is what that
file's own header says every reader should do.

## GREEN — the numbers

Commands run from `/Users/nick_matta/gridiron-local/wt/UX-14`, tree at
`9577a1ca`, `SCHEDULER_DISABLED=1`, no `GRIDIRON_DB_PATH` needed (these
tests read source files only, no database):

```
node --experimental-test-module-mocks --test --test-reporter=tap \
  test/glossary-definitions-match-producers.test.js \
  test/glossary-and-basis.test.js
```
`1..15 / # pass 15 / # fail 0`

**Liveness proof.** `git stash push -- client/src/lib/glossary.ts` (reverting
only the glossary, keeping the new tests) against the same tree reproduces
`# pass 0 / # fail 6` on `glossary-definitions-match-producers.test.js` —
the tests fail on the unfixed code and pass on the fixed code, not on
either unconditionally.

**Mutation sweep**, each applied and reverted individually, full targeted
suite re-run after each:

| Mutation | Where | Result |
|---|---|---|
| Unit mutant: `raw: 'lineup.week_points'` reverted to `'lineup.score'` | `client/src/lib/glossary.ts` | 5 pass / 1 fail — killed |
| Call-site mutant: `week_points:` renamed to `weekPointsX:` | `server/services/lineup-brain.js:363` | 5 pass / 1 fail — killed (proves the check reads the producer's real field name, not a copy of it) |
| Wording mutant: `points_allowed_to_position.plain` reverted to the old "so far" sentence | `client/src/lib/glossary.ts` | 5 pass / 1 fail — killed |
| Not-applied control (no mutation) | — | 15 pass / 0 fail |

## Known defects / what this does NOT cover

- Read as source text (same stated limit as `glossary-and-basis.test.js`):
  this pins what the `.ts` files SAY, not what a route actually returns at
  runtime or what React renders. A component importing the glossary and
  then writing its own label beside it passes everything here.
- `title_delta`'s underlying pairing bug (`season-sim.js:313-356`, the
  per-player draw order depending on each team's own roster order) is NOT
  fixed by this unit — only the sentence is corrected to stop overclaiming
  what the paired seed guarantees. The bug itself is R6/R7's finding
  (`rnd/loop/r7-internal-glossary-defines-numbers-code-no-longer-makes.md`
  #4, assessed from `r6-internal-title-odds-pairing-broken.md`); fixing it
  is a separate unit (sort `roster` into a canonical, e.g. id-sorted, order
  before the per-week draw).
- `season_floor`'s "Preseason band (low)" only fixes the low end already in
  the glossary; it does not add a `season_floor_high` (`preseason.p80`)
  entry — none was in the original 15, so none was added here.
- Nothing yet imports `GLOSSARY.start_score`, `.season_floor`, `.title_delta`
  or `.week_floor` outside the two test files (`grep -rln` of `client/src`
  confirms `TradeCard.tsx`/`TradeLab.tsx` read the server's own
  `title_delta` field, not the glossary entry of the same name) — adopting
  the four provenance renderings onto `BasisChip`/`glossary` is PR #75's own
  stated next step, unchanged by this unit.
- No model, projection or number changed. This is a documentation/contract
  correction inside an already-open, not-yet-merged PR; no new statistical
  claim is made, so no pre-registration or holdout look applies.

## Nick's five questions

1. **Well built?** The new test file's own contract checks (asserting the
   cited producer line still has the exact shape being read) mean a future
   refactor that moves or renames the underlying field fails this test
   instead of leaving the glossary quietly wrong again — which is the same
   failure mode the R&D package found in the original presence-only test.
2. **Stats or made up?** Not a stat — a correctness fix on what a docs/label
   file says a served field is and means. The `title_delta` caveat's "roughly
   a couple of points" figure is qualitative language carried over from R6's
   assessed finding (not a magnitude this unit re-measured).
3. **How we know:** grep + `git show`/`git grep` against `origin/main` merged
   into this branch (see the file:line table above), not a backtest. No
   season data was opened.
4. **Pointed anywhere else on the platform?** `grep -rln` of `client/src` for
   the six changed entry ids found only the glossary file and the two test
   files reading it — see "known defects" above.
5. **How it unifies:** this keeps `glossary.ts` as the one place labels and
   plain-words sentences come from (PR #75's own stated purpose); it does
   not introduce a second source of truth or a second glossary.

## Defect / gap fixed

`client/src/lib/glossary.ts` on PR #75's branch, six entries wrong against
`origin/main` `287e36b1` (this branch merged to `76363dfd`) per
`rnd/loop/r7-internal-glossary-defines-numbers-code-no-longer-makes.md`.
Incumbent: `test/glossary-and-basis.test.js` (checks presence only, passes
on all six wrong entries — confirmed by running it unmodified against the
unfixed glossary before this change).
