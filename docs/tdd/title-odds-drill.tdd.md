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

---

## Mutation re-run at the stack tip

Re-run against **one tree**, the tip of this stack at `af7f01a`, so every row
below is measured on the same code rather than on the tree each commit had when
it was written. Each entry records the mutated file's SHA-256 before and after,
which is what proves the mutation was APPLIED: a pattern that does not match
leaves the file unchanged, and the run is then the baseline wearing a
mutation's name. Each entry names the **test title** that turned red, not the
rule it was meant to check — a mutation that lands and kills a different test is
unfinished, not a result. And each quotes the **exact before and after text**,
not a description of the edit, so the mutation can be reproduced from this file
rather than taken on trust.

Files mutated: `client/src/components/ui/OddsGate.tsx`, `client/src/index.css`, `client/src/lib/odds-gate.js`, `client/src/pages/MyTeam.tsx`.

**gateState: fold zero-results into too-early** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `4b83f4b32535` — **RED**, 1 failing · killed by *no games played is its own state, not folded into "too early"*

```diff
-  if ((gate.weeks_played ?? 0) === 0) return 'no_results';
-
+  (the text is removed)
```

**gateState: no gate served blanks the page** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `54d42df91db3` — **RED**, 1 failing · killed by *no games played is its own state, not folded into "too early"*

```diff
-  if (!gate) return 'published';
+  if (!gate) return 'too_early';
```

**gateState: published wins over zero results** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `f39da088d62c` — **RED**, 1 failing · killed by *no games played is its own state, not folded into "too early"*

```diff
-  if (!gate) return 'published';
-  if ((gate.weeks_played ?? 0) === 0) return 'no_results';
-  return gate.published ? 'published' : 'too_early';
+  if (!gate) return 'published';
+  if (gate.published) return 'published';
+  return (gate.weeks_played ?? 0) === 0 ? 'no_results' : 'too_early';
```

**layer 4: drop the week-by-week walk-forward credit** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `bc931c730257` — **RED**, 2 failing · killed by *layer 4 keeps all four parts of what the grading found*

```diff
-by replaying past '
-    + 'seasons week by week and grading each prediction on the week it was for.
+against past seasons.
```

**layer 4: drop how much was graded** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `dda9d7f13a26` — **RED**, 2 failing · killed by *layer 4 keeps all four parts of what the grading found*

```diff
-on ${weeks} `
+on many `
```

**layer 4: drop what the grading found** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `2bcfafdf453c` — **RED**, 1 failing · killed by *layer 4 keeps all four parts of what the grading found*

```diff
-Before week ${w} it did worse than `
-    + `simply telling every team the same number.
+It has been graded directly.
```

**layer 4: drop the overconfidence at the two ends** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `a01f7ec14090` — **RED**, 1 failing · killed by *layer 4 keeps all four parts of what the grading found*

```diff
-  const ends = e?.no_chance_qualify_rate != null && e?.certain_miss_rate != null
+  const ends = false && e?.no_chance_qualify_rate != null && e?.certain_miss_rate != null
```

**layer 4: drop that this app's own configuration was not graded** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `b231af6011af` — **RED**, 2 failing · killed by *layer 4 keeps all four parts of what the grading found*

```diff
-  const notGraded = c.not_graded ?
+  const notGraded = false ?
```

**layer 4: drop the early-week score** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `8a3a0991b48d` — **RED**, 1 failing · killed by *a Brier score is explained wherever one is shown*

```diff
-  const score = early?.brier != null && early?.base_rate != null
+  const score = false && early?.brier != null && early?.base_rate != null
```

**layer 4: name the Brier score instead of explaining it** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `3f5750658875` — **RED**, 1 failing · killed by *a Brier score is explained wherever one is shown*

```diff
-— ${BRIER_IN_WORDS}.`
+(Brier score).`
```

**layer 4: claim a grading with no calibration served** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `08358c2a3557` — **RED**, 2 failing · killed by *with no calibration served, layer 4 understates rather than inventing*

```diff
-  if (!c?.graded_team_weeks) {
+  if (false) {
```

**layer 4: drop the as-of of the grading** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `d39191756485` — **RED**, 1 failing · killed by *the grading carries its own as-of, beside the grade and not in the headline*

```diff
-const measured = c.measured_on ? `, measured ${c.measured_on}` : '';
+const measured = '';
```

**layer 4: invent an as-of when none is served** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `13c1e855bd3f` — **RED**, 1 failing · killed by *the grading carries its own as-of, beside the grade and not in the headline*

```diff
-const measured = c.measured_on ? `, measured ${c.measured_on}` : '';
+const measured = `, measured ${c.measured_on ?? new Date().toISOString().slice(0, 10)}`;
```

**the component grows its own copy of gateState** (`client/src/components/ui/OddsGate.tsx`) — APPLIED `06404d403447` → `776e844689a5` — **RED**, 1 failing · killed by *the page and this test are calling the same code*

```diff
-import { gateState, withheldReason } from '../../lib/odds-gate.js';
+import { withheldReason } from '../../lib/odds-gate.js';
+function gateState(g: OddsGate | null | undefined) { return g?.published ? 'published' : 'too_early'; }
```

**the page ungates the playoff percentage** (`client/src/pages/MyTeam.tsx`) — APPLIED `98c171e444ff` → `b34938213977` — **RED**, 1 failing · killed by *both percentages are gated, not just the headline*

```diff
-<WithheldOdds gate={sim.odds_gate} label="Make playoffs" />
+<span>{pct(sim.playoff_odds)}</span>
```

**the withheld state becomes a dead end** (`client/src/pages/MyTeam.tsx`) — APPLIED `98c171e444ff` → `1ed423225c65` — **RED**, 1 failing · killed by *withholding the headline still opens the deep dive*

```diff
-className="odds-withheld-open" onClick={() => setDrill(true)}
+className="odds-withheld-open"
```

**the withheld state is styled as a warning** (`client/src/index.css`) — APPLIED `4aabd9008a92` → `95f7f5783d89` — **RED**, 1 failing · killed by *the withheld state is not styled as an error*

```diff
-.odds-withheld { display: grid;
+.odds-withheld { color: var(--warn); display: grid;
```

**layer 4 stops delegating, back to a hard-coded sentence** (`client/src/pages/MyTeam.tsx`) — APPLIED `98c171e444ff` → `9ae6c9f33490` — **RED**, 1 failing · killed by *layer 4 does not claim the championship number was tested*

```diff
-tested: gradedSentence(sim?.odds_gate),
+tested: 'This number has been tested.',
```

**the ungraded branch claims a grading it was not given** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `18389a938144` — **RED**, 2 failing · killed by *with no calibration served, layer 4 understates rather than inventing*

```diff
-This championship number itself has not been scored against real finished `
-      + 'seasons here.
+This championship number has been scored. `
+      + '
```

**NO-OP CONTROL: a comment word is changed and nothing else** (`client/src/lib/odds-gate.js`) — APPLIED `04cf78d7bbc0` → `4b982d71f139` — **green — survived, as intended**

```diff
-export const BRIER_IN_WORDS =
+export const BRIER_IN_WORDS = /* control */
```

19 mutations applied and red, 1 applied and green. The green
row is the deliberate no-op control — an edit that is real (the SHA changes) but
touches nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database, **measured on commit `6a8df0d`** — the commit this
section lands in, whose parent is `af7f01a`. The source was restored after the
mutation run and verified clean with `git status` rather than assumed clean
because the runner said so.
