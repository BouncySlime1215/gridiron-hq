# A paired comparison that compared different seasons to each other

2026-09-20. `server/services/pooled-arms.js` (new), `server/services/offseason-model.js`,
`server/services/backtest-significance.js`. Tests `test/pooled-arms.test.js` (new) and
`test/offseason-model.test.js`. Off `main` (`791b131`); stacks on nothing.

Found by the model evidence audit on `origin/main`, live by default. It is two defects that are
one defect: a guard that cannot see one direction of a mismatch, and four callers arranged so
the direction it cannot see is the one that happens.

## What was reported

`walkForward` grades several model arms on held-out seasons and pools each arm's per-row
absolute errors across seasons. The overall table then compares each arm against a baseline:

```js
pairedBootstrapDiff(baseP.errs, p.errs, { iterations: 4000, seed: 23, groups: p.groups })
```

That is a paired test, so it needs `baseP.errs[i]` and `p.errs[i]` to describe the same row.
They do while every arm covers every season. The GBM challenger does not: it is fitted inside a
`try` and omitted from a season's predictions when the fit throws (`preds.gbm` is set only
`if (gbmModel)`), and arms are appended lazily — so one throw on one season of three leaves
`pooled.gbm.errs` holding seasons 2 and 3 while `pooled.no_change.errs` holds 1, 2 and 3.

## Why nothing caught it, which is the interesting half

`pairedBootstrapDiff` takes `n = Math.min(valuesA.length, valuesB.length)` — the shorter arm,
the challenger — and `p.groups` was built in lockstep with that same shorter arm. So
`groups.length === n` holds exactly, the clustered path is taken, and it pairs the challenger's
season-2-and-3 rows against the baseline's season-1-and-2 rows. The interval comes back tight,
clean, clustered and flagged significant, on a comparison of nothing.

The exact-length guard at `backtest-significance.js:80` is **the mirror image of this case**. It
was tightened from `>=` to `===` on 2026-09-12 to catch a `groups` array sized to the LONGER
arm, and its own comment names this file's GBM `catch` as the example. It cannot catch this one:
both arrays it is handed really are the same length as each other, and `groups` really does line
up with them index for index. Nothing at that level can tell "these two arrays were built from
the same rows" from "these two arrays are the same length". Only the rows' own identities can,
and they were never passed down.

**The verdict does not blur, it reverses.** On the fixture the challenger is better by 0.5 on
every row it covers. Compared by index it reads 0.5 *worse*, because the baseline's truncated
window is its two easiest seasons. Same two arms, same seed, opposite conclusions — and the wrong
one arrives with a clustered interval and a significance flag. That comparison is its own test,
because a fix whose old and new answers agreed would not be worth making.

## The fix

**Arms are pooled with a row key** (`season|team|player_id`) and compared on the rows they
share. `poolArm` refuses an arm pooled without keys, refuses arrays whose lengths disagree with
the keys, and refuses a key that repeats — a duplicate pairs several of one arm's rows against one
of the other's, which is the by-index defect arriving through a key that looks specific enough to
be deliberate.

**What was compared is served, always.** `comparison_basis` names both arms, each arm's row
count, how many rows were compared, whether they were aligned, and a sentence when they were not.
It is present on an aligned comparison too: if it appeared only on the broken case, a table with
no basis would be ambiguous between "aligned" and "written before this field existed".

**A comparison that cannot be made is refused, and the refusal is served.** Fewer than ten shared
rows returns `{ error, comparison_basis }` and no interval, with the reason on both.

**An arm missing a season is not an error.** A challenger that could not be fitted on 2023 is
still gradeable on 2024 and 2025, so the shared rows are compared and the narrower question they
answer travels with the number. Refusing outright would throw away a real measurement; reporting
it silently is what this fixes.

**`arm_coverage`** on the result names which arms are short and which seasons each is missing, so
a reader does not have to diff row counts to find out.

## The two bare catches

`CLAUDE.md`: errors are handled or they throw, and a `catch {}` that swallows a fault has already
shipped two real bugs in this project. Both GBM catches were that shape, and here the swallowed
fact was *which season the arm is missing* — the input the comparison needed.

Both now record: `gbmError` is the message, served as `gbm_error` on that season's own record and
`null` when there was nothing to record. The challenger stays optional. What changed is that a
failed fit leaves a trace.

**The fitter is injectable** (`gbmFit = fitGbm`; production passes nothing) for one reason: a
`catch` that decides what the comparison may compare, and that no test can reach, is a failure
path nobody has ever seen run. The integration test makes it throw on the first of two seasons
and asserts the recorded message, the coverage entry and the served basis.

## The clustered flag, the other half of the same narrative

Queued separately, and it belongs here: `pairedBootstrapDiff` falls back to an unclustered
resample whenever `groups` does not line up, and the interval it returns is indistinguishable
from a clustered one. A caller that asks for clustering cannot tell it was declined.

- `clustered` is now on every return, including the too-few-rows refusal.
- `clusteredDiff` wraps it for callers that have established their rows line up: a declined
  clustering throws. The fallback is honest but *narrower than the truth* on correlated rows, so
  publishing one as clustered reports a tighter result than was measured. These are offline
  grading paths, not request handlers, so failing the audit beats publishing the number.
- Every call in `offseason-model.js` that passes `groups` goes through it — the per-season
  comparisons and the feature ladder included, where the arms are complete today and the
  assertion is what keeps them that way.

## Mutations

Canonical shape. Each row applied alone from the same clean base, both files' SHA-256 (first 12
characters) recorded, run
`node --test --test-concurrency=1 test/pooled-arms.test.js test/offseason-model.test.js`.

Base: `pooled-arms.js` `308a8a406084`, `offseason-model.js` `360bae562188`. Both restored and
checked after the last row.

| # | file | mutation | state | sha256 before -> after | fail | a test that fails |
|---|---|---|---|---|---|---|
| O1 | pooled-arms | pair the pooled arms by index again (the defect) | APPLIED | `308a8a406084` -> `f53cba49c098` | 2 | the same comparison done by index reports a different number |
| O2 | pooled-arms | the basis is computed but not served | APPLIED | `308a8a406084` -> `22b05c47282b` | 3 | the basis is served even when the arms line up perfectly |
| O3 | pooled-arms | an arm missing rows is reported as aligned | APPLIED | `308a8a406084` -> `91d8bf43ff08` | 2 | a challenger that fails on one season is compared on the seasons it has |
| O4 | pooled-arms | two arms sharing nothing get an interval | APPLIED | `308a8a406084` -> `41e3f9024f17` | 1 | two arms sharing too few rows are refused, and the refusal is served |
| O5 | pooled-arms | poolArm accepts an arm with no row keys | APPLIED | `308a8a406084` -> `2b641bdde10b` | 1 | pooling without row keys throws instead of pooling something unalignable |
| O6 | pooled-arms | clusteredDiff accepts a declined clustering | APPLIED | `308a8a406084` -> `af938d660d57` | 1 | clusteredDiff throws rather than return an unclustered interval as clustered |
| O7 | offseason-model | the bare catch is back: no record of the failed arm | APPLIED | `360bae562188` -> `0fc370775e6d` | 1 | a challenger that fails on one season is compared on the seasons it has |
| O8 | offseason-model | arm coverage is not served on the result | APPLIED | `360bae562188` -> `3f6fdce25aeb` | 1 | a challenger that fails on one season is compared on the seasons it has |
| O9 | offseason-model | row keys drop the player, so teammates collide | APPLIED | `360bae562188` -> `9ebe2fc1995a` | 2 | walkForward never lets a model see the season it is graded on |
| CONTROL | pooled-arms | a comment reworded, no code path touched | APPLIED | `308a8a406084` -> `a9ba9b494c67` | 0 | none, and none should |

**Two rows survived the first sweep and were answered with tests, not weaker mutations.**

- **O6** — deleting the `clustered !== true` throw — failed nothing, because no test reached it.
  That throw is the whole point of `clusteredDiff`. Test added.
- **O9** — dropping `player_id` from the call site's key — failed nothing, and it is the more
  instructive of the two. Alignment reads the first index a key appears at, so every one of the
  baseline's rows for a team would have paired against the challenger's first row for that team.
  The *compared count stays plausible*, so nothing downstream could see it: the by-index defect
  again, through a key specific enough to look deliberate. Answered by making `poolArm` refuse a
  repeated key, which is a stronger guarantee than any assertion on one call site's key format.

**The sweep was re-run on a second base and reproduced hash for hash.** The first run was done on
a branch cut from a stale local `main` (102 commits behind `origin/main`). The three touched files
are byte-identical between the two, which the identical base hashes establish rather than assert —
so the table stands on `791b131`.

## RED

Retroactive RED by mutation, which CLAUDE.md allows, plus a real RED at the integration level:
O1 restores the shipped behaviour exactly and two tests fail, one of them the direct measurement
that the index pairing reverses the verdict.

## Numbers

Targeted: 45 tests, 45 passed, 0 failed across `pooled-arms.test.js`, `offseason-model.test.js`
and `paired-bootstrap-clustering.test.js` (9 new in the first, 1 added to the second, the third
untouched and passing against the new `clustered` field).

Full local check `npm run check` on this tree: exit 0 — 2,960 tests, 2,919 passed, 0 failed, 41
skipped; typecheck, lint and build clean; `start:smoke` passed on an isolated database (32
teams). That total is lower than other branches in this thread report because this one is off
`main` and carries none of their tests.

Run on the whole suite, not the targeted files, because an earlier edit in this session replaced
text between two anchors and deleted a function in the gap: both targeted suites passed while 54
tests in other files failed.

## The five questions

**Is this well built?** The alignment is one small file, one exported verb per job, no model
imports, with the reasoning for each refusal beside it. The four call sites share one shape, so a
fifth cannot reintroduce the defect by pooling its own way.

**Is this based on stats, or is it made up?** It is the statistics themselves: a paired bootstrap
on unpaired rows is not a weaker measurement, it is not a measurement. The fixture is built so
the wrong pairing gives the opposite sign, which is what makes the test a measurement rather than
a restatement.

**How do we know?** Nine mutations and an inert control, each with the file hash before and
after, reproduced on a second base. Two survived the first pass and are named above with the
tests that now kill them. The integration test reaches the `catch` through an injected fitter, so
the failure path is exercised rather than assumed.

**Should this data be pointed anywhere else on the platform?** Yes, and this is the more
important half. Four other modules pass `groups` to `pairedBootstrapDiff`:
`nfl-offseason-change.js`, `nfl-prop-player-heads.js` (three sites, one of them a pooled arm with
the same lazy-append shape at `:273-318`), and `nfl-team-strength.js`. `clustered` is on every
return now, so each can assert it, and `nfl-prop-player-heads.js` should be read against this
finding rather than assumed safe — routed, not fixed here, because those files belong to other
threads.

**How does it unify?** One guard could not express "the same rows", so every caller invented its
own pooling and none could state what it compared. There is one pooling now, one place that knows
what a row is, and the answer says which rows it used — including when it used all of them.
