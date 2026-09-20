# The championship number's drill-down — TDD evidence

Retroactive RED by mutation, the shape set by `docs/tdd/week2-numbers.tdd.md`.

## Why this number first

It is the number My Team exists to show, and every one of the deep dive's five
layers already existed in the payload — rendered as small grey prose beneath the
card, or not at all. Nothing new had to be computed. What changed is that a
reader can now ask.

## Layer 4 is the whole point, and it was the tempting one to get wrong

There is a real pull toward writing "tested" on this number, because its
**inputs** were tested. `server/services/weekly-backtest.js` replays past
seasons walk-forward — at week W the model may use prior seasons plus weeks
1..W-1, and is graded on week W alone — which is thousands of player-weeks per
season and grades the decision the app actually makes.

The championship probability itself has never been scored against finished
seasons. Nothing in this repository checks how often a team given 20% actually
won; `simulateSeason` has callers and tests, and none of them grade its output
against a real outcome. Writing "tested" because the inputs were tested is
exactly the overstatement this layer exists to prevent, and it is the kind that
survives review *because it is nearly true*.

So layer 4 says both halves, and both are pinned: the weekly projections
underneath were checked by replaying seasons week by week; this number has never
been scored against real finished seasons. A test also asserts the word
"calibrated" never appears there.

## Layer 2 carries the two assumptions that change the number

An assumed playoff bracket produces a different championship number from the
league's real schedule, and a reader cannot see that anywhere else. Likewise the
projection fit: with one active, the simulator runs on **fitted efficiency
constants and hand-set volume constants at the same time**, because
`activeKVectorFor` withholds the volume entries from every caller not on weekly
role recency and the simulator never is — and volume is what moves most when a
role changes. So that input is marked `pooled`, not `fitted`, with the reason on
it.

## The mutations

Control after restoring: **5 pass, 0 fail**.

| # | Mutation | Result |
|---|---|---|
| d1 | Layer 4 says the number is calibrated | **4 pass, 1 fail** |
| d2 | Layer 4 drops the credit for the backtest that did happen | **4 pass, 1 fail** |
| d3 | An assumed playoff bracket is marked measured | **4 pass, 1 fail** |
| d4 | The fit input stops admitting its volume half is hand-set | **4 pass, 1 fail** |
| d5 | The method sentence says "correlated" | **4 pass, 1 fail** |
| d6 | The drawer opens on first paint | **4 pass, 1 fail** |
| d7 | The page formats the number by hand again | **4 pass, 1 fail** |

d2 is there because honesty runs both ways: understating work that really was
done is its own kind of wrong, and a layer 4 that only ever says "untested"
stops being read.

## A test bug found and fixed while writing this

The first version of `test/title-odds-drill.test.js` sliced the layers object
with `page.indexOf('method:')`. `method:` appears twice in `MyTeam.tsx` as a
`fetch` option, hundreds of lines before the drawer, so the slice silently
produced the wrong region — one assertion was checking a string that did not
contain what it was looking for, and passed anyway by failing to fail. The
slices are now anchored on `layers={{`, which occurs once. This is the same
lesson as `served-field-tested-at-the-wrong-layer`: a test that cannot fail
proves nothing, and the mutation run is what surfaces it.

## Honest limit

`node:test`, no DOM, source text only. These pin the words in the source, not
what a browser renders — a layer whose text is correct and whose element is
hidden by CSS passes every one of them.

## Commands

```
GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr-XXXXXX).sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/title-odds-drill.test.js
```
