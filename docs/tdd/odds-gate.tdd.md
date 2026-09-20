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
