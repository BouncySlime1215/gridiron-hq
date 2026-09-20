# TDD evidence (retroactive): the availability basis payload, PR #54

**Item:** every chance-to-play figure served by `server/routes/model.js` says what
produced it, and says it per player rather than per process.

**Files owned and changed:** `server/routes/model.js`,
`test/availability-basis-payload.test.js`, this document. `server/services/contingency.js`
is read and cited, never edited — it belongs to another thread.

**Origin:** not a bug report. The TDD sweep of open PRs on 2026-09-20 found that `b6f72e6`
changed 61 lines of a route and added no test of its own, on my own branch. This file is
the repair of that, written before reporting anyone else's.

---

## Why there are no RED commits

Same reason as `docs/tdd/boot-restart-cycle.tdd.md`, and the same instrument as
`docs/tdd/week2-numbers.tdd.md`, which this repository already accepts: the code shipped
first, so a test written now passes at HEAD. A RED commit manufactured after the fact
would be theatre — I would be writing the test knowing the answer and reverting the fix to
make it red.

The RED evidence here is **defect injection against the shipped code**: for each rule the
tests claim to guard, the source is edited to reintroduce the specific defect, the suite is
run, and the output recorded. A test that no injection can fail proves nothing. That
standard caught two weak assertions in the first draft of the test file itself, which is
recorded below rather than quietly fixed, because it is the part that shows the instrument
working.

The one non-test change in the RED commit is `export` on `availabilityPayload`. It is
scaffolding, not the fix: the helper was already the unit under test, it just had no way to
be reached.

## The two claims under test

1. **`basis` is claimed per player, not per process.** The fit can be on the `role` path
   globally while this particular player has no in-scope role cell and falls through to the
   pooled chain. Reporting `role` for him would be the same class of error as the field
   name the change exists to fix.
2. **The bare `GET /availability` branch does not serve the fit, and every row says so.**
   The `?week=N` branch serves the fit; the bare one serves a four-season attendance rate.
   They were told apart only by the caller remembering which it had asked for.

## What writing the test found

Two lines on the bare branch that could not be observed on the wire — both the same shape
as the confusion the change removes, source asserting a distinction the data cannot show.

| Line | Why it could not fire | Resolution |
|---|---|---|
| `basis: covered.has(meta?.position) ? 'durability_prior' : 'unfitted_position'` | `availability()` selects `WHERE p.position IN ('QB','RB','WR','TE')` (`contingency.js:43`), so its map can never hold a K or a DEF. The `unfitted_position` arm was readable in the source and unreachable in fact. | Unconditional `basis: 'durability_prior'`, with the population and its citation in the comment. `unfitted_position` is a real basis and stays on `/projections/:playerId`, which is asked about one named player and can therefore be asked about a kicker. |
| `position: meta?.position ?? null` | `availability()` already stamps `position` on every row it returns (`contingency.js:79`), from the same `players` table `names` reads. The restatement shadowed the field with itself. | Removed. Test 7 now guards the real source. |

**The first draft of the test would have caught neither.** Its fixture gave the K and the
DEF no `player_week_usage` rows, so they were absent from the bare branch for want of data,
and injection A below passed 8/8 against a widened position filter. The fixture now seeds
attendance for all four positions, so that filter is the only thing keeping them off the
wire. The restatement was found only by deleting it and watching nothing break.

## RED -> GREEN, by defect injection

Each row: the edit made to the shipped source, the output, then restore. Run at 01:2xZ on
2026-09-20 against the tip of this branch.

| # | Injected defect | Result |
|---|---|---|
| A | `contingency.js:43`: widen the filter to `IN ('QB','RB','WR','TE','K')` | 7 pass, 1 fail — test 8, the population assertion. **Against the first fixture this passed 8/8**, which is why the fixture changed. |
| B | `model.js`: drop `fitted: false` from the bare branch rows | 7 pass, 1 fail — test 7 |
| C | `model.js`: `const basis = global` in place of the per-player role/pooled resolution | 7 pass, 1 fail — test 3, the claim this whole file exists for |
| D | `model.js`: the `!weeklyAvail` arm returns `active_probability: prior, basis: availabilityBasis().basis, fitted: true` | 7 pass, 1 fail — test 1. A kicker comes back as a bare number reading like a low chance of playing, which is the original defect restated exactly. |
| E | `model.js`: `weeklyAvail.durability_prior ?? null` in place of `?? prior` | 7 pass, 1 fail — test 6 |
| F | `model.js`: drop `position` from the bare branch rows | **8 pass, 0 fail.** The injection that did not bite, because the field was a restatement. It is why that line is gone. |
| F' | `contingency.js:79`: `availability()` stops stamping `position` on its rows | 6 pass, 2 fail — tests 7 and 8, after the restatement was removed |
| G | `model.js`: `fitted: true` in place of `fitted: basis !== 'constants'` | 7 pass, 1 fail — test 5 |

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/availability-basis-payload.test.js` | 8 | A player with no fitted weekly row is `unfitted_position` with a null probability, not a bare low number; `role` is claimed only for a player with an in-scope role cell; a role-path process reports `pooled` for a player it could not price at role level; a pooled process never reports `role`; no fit on file means `constants` and `fitted: false`; the durability prior falls back to the four-season rate; every bare-branch row says `fitted: false` and carries a position; the bare branch serves only the fit's own four positions. |

The global basis is a live closure over a `mock.module` of `contingency.js` with
`namedExports` spreading the real module — the form the SDK actually takes. Everything else
in `contingency.js` stays real and reads the temp database.

## What this does NOT do

It does not test the `?week=N` branch, which serves the fit and belongs with the fit's own
evidence. It does not test `/projections/:playerId` end to end — that route needs a league,
a scoring config and the projection engine, and the payload logic it delegates to is the
unit tested directly here. Neither route has a caller in the repository: the only reference
to `GET /availability` is `client/src/pages/Model.tsx:397`, which nothing routes, so the
readers are people checking the app by hand during a deploy. That is the whole reason the
labels have to be right in the payload rather than in a caller's memory.
