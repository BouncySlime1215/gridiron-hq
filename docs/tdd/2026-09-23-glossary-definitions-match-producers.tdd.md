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

## Round 2 — skeptic review fixes (2026-09-23)

Commits: `b43c467e` (tests, RED, tree `a3ea6ffe`), `3d2f8163` (fix, tree `18a90913`).
Command for every result below:
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test --test-reporter=tap test/glossary-definitions-match-producers.test.js [test/glossary-and-basis.test.js]`

| Skeptic finding | Change | Proof |
|---|---|---|
| expected_wins test passed a sentence denying the fact | added `doesNotMatch(/remaining\|not counting\|excluding\|rest of/i)` | skeptic's exact mutant on `b43c467e`: test fails (was 15/0 on `ba4a5324`) |
| title_delta test passed "all about the move and never luck" | require `/noise/`; forbid `/never luck\|not luck\|no luck\|all (about )?the move\|purely\|entirely\|only the move/i` | skeptic's exact mutant on `b43c467e`: test fails |
| points_allowed_to_position claimed shrinkage | sentence now "with recent seasons counting more"; comment cites matchups.js:186 (`allowed = b.wpts / b.w`, unshrunk) vs :193 (`mult` shrunk); test forbids a shrink claim unless the `const allowed =` line calls `shrink(` | RED on `b43c467e`; mutant restoring "pulled toward the league average" on `3d2f8163`: 6 pass / 1 fail |
| week_floor raw `projection.p10` is not served; field has two producers | raw → `asset.floor` / `asset.ceiling` (trade-engine.js:462); sentence states the fallback (edge.js:145 `volatility(season = SEASON - 1)`, :164 `q(0.2)`, :165 `q(0.8)`: last season's played weeks, one in five); test forbids any `raw: 'projection.` and requires "last season" + "one in five" while the `?? w?.floor` fallback exists | RED on `b43c467e`; mutants on `3d2f8163` (raw reverted; fallback sentence removed): each 6 pass / 1 fail |
| start_score duplicated projected_points | start_score removed; projected_points → `lineup.week_points` (lineup-brain.js:356 `startSitWeekPoints`, :363); new test: no two entries share a raw | RED on `b43c467e` |
| Branch carries PR #75's unimported files | not code. Confirmed: `git grep -ln "lib/glossary" -- client/src` → exit 1 (no importer); `git grep -ln BasisChip -- client/src` → only BasisChip.tsx, index.css. `git merge-base --is-ancestor origin/claude/project-thread-xiezr0-basis-chip HEAD` → true. This branch must NOT merge to main; it fast-forwards onto #75's branch, or is held until C-13/C-15 wires glossary.ts into a page. No PR to main opened. |

Result on `3d2f8163`: both files, **16 pass / 0 fail**. On `b43c467e` (tests only):
13 pass / 3 fail (week_floor/ceiling, projected_points dedupe, points_allowed shrink).

Fallback frequency (how many trade assets serve the last-season floor) is
unmeasured — no DB copy was made; the sentence covers both cases instead.
Known remaining gap: `stats.projected_points` (a season total on PlayerCard /
StatTable) shares the name but has no glossary entry; noted in the entry's comment.
