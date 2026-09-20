# The odds gate — RED/GREEN evidence

`test/odds-gate.test.js`, `client/src/lib/odds-gate.js`,
`client/src/components/ui/OddsGate.tsx`, and the gating in
`client/src/pages/MyTeam.tsx`.

The RED here is retroactive and produced by mutation, the shape
`docs/tdd/week2-numbers.tdd.md` set: revert one guarded rule in the shipped
source, run the file, confirm the test that claims to guard it goes red,
restore. A test that no mutation can fail proves nothing.

## Why there is a gate

The playoff-odds simulation was graded on 184,959 real team-weeks across 2,500
Sleeper leagues, 2021-2025. Before week 4 it scores **worse than telling every
team its league's base rate** (Brier 0.2855 against 0.2410 at week 2), and at
every week it is overconfident at both ends: teams it gives no chance qualify
about 12% of the time, teams it calls certain miss about 10%.

A number that loses to the base rate is worse than no number, because a manager
acts on it. So the percentage is withheld until the odds stand on enough
results, and what replaces it is a designed state with a sentence.

The grading is the fantasy-plan thread's, on its corpus. This app's own
configuration was **not** among what was graded, and the deep dive says so.

## Part of this is a real unit test, and that is the point

Every other test in this UI vocabulary reads source text, because `node:test`
in this repository has no build step and cannot import a `.tsx` module
(`ERR_UNKNOWN_FILE_EXTENSION`). That limit is acceptable for markup and
unacceptable for a decision: a source-text test cannot tell whether two of the
three states have quietly collapsed into one.

So the decisions live in `client/src/lib/odds-gate.js` — plain JS that node can
import and call — and `OddsGate.tsx` renders what they return. `tsconfig.json`
has `strict: true` and no `allowJs`, so the JS carries a hand-written
`odds-gate.d.ts` rather than the whole client being switched to `allowJs` for
one module.

That split introduces its own way to be wrong: the test could keep passing
against a module the page no longer uses. The test **"the page and this test are
calling the same code"** exists only to close that, and mutation 12 below is its
evidence.

## Mutation runs

Baseline, unmutated: **10 tests, 10 pass, 0 fail.** Every run below is the same
file, one revert at a time, restored after.

| # | Mutation | Result | Test that caught it |
|---|---|---|---|
| 1 | `gateState` drops the `weeks_played === 0` check | 9 pass / **1 fail** | no games played is its own state |
| 2 | `gateState` returns `too_early` when no gate is served | 9 pass / **1 fail** | no games played is its own state |
| 3 | `gateState` checks `published` before `weeks_played` | 9 pass / **1 fail** | no games played is its own state |
| 4 | layer 4 drops the week-by-week walk-forward credit | 9 pass / **1 fail** | layer 4 keeps all four parts |
| 5 | layer 4 drops how much was graded (184,959) | 9 pass / **1 fail** | layer 4 keeps all four parts |
| 6 | layer 4 drops what the grading found ("worse than") | 9 pass / **1 fail** | layer 4 keeps all four parts |
| 7 | layer 4 drops the overconfidence at the two ends | 9 pass / **1 fail** | layer 4 keeps all four parts |
| 8 | layer 4 drops that this app's config was not graded | 9 pass / **1 fail** | layer 4 keeps all four parts |
| 9 | layer 4 drops the early-week score | 9 pass / **1 fail** | a Brier score is explained |
| 10 | layer 4 says "(Brier score)" instead of explaining it | 9 pass / **1 fail** | a Brier score is explained |
| 11 | layer 4 claims a grading with no calibration served | 9 pass / **1 fail** | understates rather than inventing |
| 12 | `OddsGate.tsx` grows its own copy of `gateState` | 9 pass / **1 fail** | the page and this test are calling the same code |
| 13 | the page ungates the playoff percentage | 9 pass / **1 fail** | both percentages are gated |
| 14 | the withheld state stops opening the deep dive | 9 pass / **1 fail** | withholding still opens the deep dive |
| 15 | the withheld state is styled `var(--warn)` | 9 pass / **1 fail** | the withheld state is not styled as an error |

Sixteen reverts were attempted; one (#6) was re-run after its first anchor
missed the template literal's line break, and is counted once.

## One existing test was changed, and why

`test/title-odds-drill.test.js` → "layer 4 does not claim the championship
number was tested" failed after this change. It asserted the **literal**
sentence in `MyTeam.tsx`, and layer 4 is no longer a literal:
`gradedSentence(sim?.odds_gate)` builds it from what the server says was graded.

The test was right about intent and wrong about means, and leaving it alone was
not an option in the other direction either: the sentence it guarded said the
championship number "has never been scored against real finished seasons", and
after this grading that hard-coded claim is **false**.

So it was re-pointed along the same path rather than relaxed. It now asserts
the page still delegates to `gradedSentence`, and checks the claim where it is
now made — calling the function with no calibration (the original claim must
survive) and with one (it must report the grading and still name what the
grading left out), with neither form allowed to say "calibrated".

It bites harder than it did. Two mutations confirm it:

| Mutation | Result | Caught by |
|---|---|---|
| layer 4 stops delegating, back to a hard-coded sentence | 14 pass / **1 fail** | layer 4 does not claim the number was tested |
| the ungraded branch claims a grading it was not given | 13 pass / **2 fail** | that test **and** "understates rather than inventing" |

## The three states, and the one that is live today

| state | when | what the page shows |
|---|---|---|
| `no_results` | `weeks_played === 0` | "Not from this season yet", basis chip `missing` |
| `too_early` | some weeks in, below `min_week` | "Too early to say", basis chip `none` |
| `published` | at or past `min_week` | the percentage, plus the extremes caveat |

`no_results` is checked first and on its own, and it wins even if a payload says
`published: true` — a gate contradicting itself resolves to the reading that
shows less.

**`no_results` is the state League Hub is in right now.** `MyTeam.tsx` requests
the simulation as `/simulate?runs=1500` with no `from_week` at all, so the odds
on that page stand on zero games played. The second test asserts this against
the page's own source and fails the moment a `from_week` is added, which is when
someone should re-read this file.

Withholding the headline does **not** blank the payload: the server still sends
every number, the deep dive still shows what went into them, and the withheld
state is a button that opens it. Declining to show a number is not the same as
pretending there is nothing there.

## What was deliberately not done

The corpus-fitted probability was **not** substituted for the page's number. Its
calibration was measured on other leagues and does not transfer by assumption;
putting it on screen would swap a number known to be weak for one whose
weakness here has not been measured at all.

---

## Addendum: the grading's own as-of

`calibration.measured_on` is now rendered, inside the calibration footnote and
never in the headline: "graded on 184,959 real team-weeks from *corpus*,
measured *date*". It is the as-of of the **grade**, not of the data underneath.
A grading is a measurement like any other in this app — it was taken on a day,
and it can go stale with nothing on screen changing.

A payload without one says nothing rather than filling in today's date.

| Mutation | Result | Caught by |
|---|---|---|
| the grading drops its as-of | 10 pass / **1 fail** | the grading carries its own as-of |
| the as-of is invented when none is served (`?? today`) | 10 pass / **1 fail** | the grading carries its own as-of |

The second matters more than the first. A missing date that is quietly replaced
by today's is the exact shape of the bugs this project keeps finding: a number
that looks healthy, is wrong, and says nothing about it.

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
