# Three wrong rows in the deletion report — RED, GREEN, and a third answer

Branch `claude/wiring-map-8f96ur`, pushed to `claude/wiring-map-8f96ur-census-hold`.
RED `cf42c12`. GREEN = the commit this file arrives in.

All three were found by feature audit, running `scripts/route-deletion-impact.mjs`
from a clean detached worktree at `23ed6da` with `console.error` probes at its
decision points. None was found by this repository's tests, and the reason is worth
more than the defects: every test the file had asserted the shape of a regex in the
script's own **source text**. A source-text assertion cannot see a walk that records
the wrong thing. The three tests added here run the script against a fixture tree
and read what it wrote.

## The defects

**1. A call site inside an already-unreached function counted as going away.** The
fixpoint records already-unreached symbols into the same `falls` map that
`insideFalling()` reads. So any symbol whose last live caller sat inside a
kept-but-unreached function had that caller deleted on paper and was promoted from
"decide separately" to "delete it in the same commit as its route".
`horizonValue()` (`waiver-brain.js:85`) printed under **Falls with the deletion** at
depth 3 while holding live sites at `roster-risk.js:190` and `waiver-brain.js:155`,
`:181`, `:401`, `:434` — and `:401` and `:434` are inside `sellHigh`, which
`routes/trades.js:203` keeps deliberately. Acting on that row deletes live code.

**2. A symbol two dying routes reach named only one of them.** `walk()` returns
early on `falls.has()`, so the reason recorded is whichever route happened to be
walked last, and the section's instruction is "delete it in the same commit as its
route". `freeAgents()` printed one route and is reached by four.

**3. A local closure listed as a module symbol.** `walk()` recurses without the
cross-module check the top-level loop applies, and `functionBody`'s regex matches
`const countAt =` anywhere in the file. `countAt`, a closure inside `waiverUpgrades`
used at `:242` and `:334` and nowhere else, printed as a row of its own.

## The third answer, which came out of fixing 1

Excluding already-unreached rows from `insideFalling` and stopping there made
`positionLiquidity()` — **the case this whole report was written for** — vanish from
the report entirely. Its other call site is inside `shoppingGuidance()`, which
nothing calls, so once that site stopped being treated as doomed it became a
surviving caller and the symbol dropped out.

Three answers, not two:

- **Falls with the deletion** — every caller goes when these routes go.
- **Reached only from code that is itself unreached** — a caller survives this
  deletion, and that caller is reached by nothing. Not falling, not already dead.
  Each row names what holds it up, so the reader knows which question to ask first.
- **Already unreached, before any of this** — no production caller at all, with or
  without the deletions.

Collapsing the middle one into the first deletes live code. Collapsing it into the
third is a lie about why. Dropping it prints nothing at all, which is the one answer
a deletion report must never give.

## Fixes

| # | fix |
|---|---|
| 1 | `insideFalling` and the fixpoint's `viaFn` consider only rows in the `falls` bucket |
| 1b | a new `insideDeadCode` and a `dead-callers` bucket, with its own section |
| 2 | an attribution pass after the fixpoint settles: for every row, which dying handlers contain a call site, and which other falling functions do, spread to a fixpoint |
| 3 | `walk()` requires a name it did not import to be a **top-level** declaration |

Fix 2 is a separate pass rather than a merge at `record()` time because merging as the
walk goes cannot work: `freeAgents` is reached directly by the free-agents handler and
through `byePatches()` by bye-risk, the free-agents route is walked FIRST, and at that
moment `freeAgents` still has surviving callers so nothing is recorded at all. By the
time the bye-risk chain makes it fall, that route has been and gone. The question has
to be asked again from the other end.

## Mutations

Baseline GREEN `scripts/route-deletion-impact.mjs` sha256 `43de9bf8fec9`, 8 tests,
8 pass.

| id | mutation | sha256 | pass/fail | killed by |
|---|---|---|---|---|
| N1 | `insideFalling` counts every row again, not only the falling ones | `b8928c999c65` | 7 / 1 | 6 |
| N2 | drop the multi-route line from the attribution pass | `72ec9bd1cc88` | 7 / 1 | 7 |
| N3 | `walk()` recurses without the top-level-declaration check | `ff8506e7d4f3` | 7 / 1 | 8 |
| N4 | NO-OP CONTROL: one word of a comment changed | `fb3eea46c583` | 8 / 0 | none, correctly |
| N5 | the third section prints nothing | `6d32982e4427` | 7 / 1 | 6 |

N2 is the row that earned its keep. The first version of test 7 used two handlers
that both call the symbol directly; the merge at `record()` time satisfied it, and
dropping the attribution pass left it green. The fixture was rewritten so the direct
route is walked first and the symbol only falls later through a chain — which is the
actual `freeAgents` shape — and N2 then kills it.

## Effect on the report

```
before  24 falling, 26 already unreached
after   18 falling, 4 reached only from unreached code, 26 already unreached
```

Six rows left **Falls with the deletion**, and none of them silently:

| symbol | where it went | why |
|---|---|---|
| `horizonValue` | third bucket | held by `sellHigh`, kept deliberately |
| `positionLiquidity` | third bucket | held by `shoppingGuidance` |
| `positionRequirements` | third bucket | same shape |
| `playoffWeight` | third bucket | same shape |
| `countAt` | gone | a closure inside `waiverUpgrades`, defect 3 |
| `decorate` | gone | a closure at `td-regression.js:321`, defect 3 |

`decorate` was not one of the three reported and is the same defect. It is also a
name collision the old report could not see: `td-regression.js:321` is
`const decorate = list => ...` inside a function, and `trend-watch.js:221` is a
different, module-level `decorate`. One row stood for both.

`freeAgents()` now reads: reached through the bye-risk chain, **and by 4 dying routes
in total** — bye-risk, free-agents, waivers and trends — "so it survives until the
LAST of them goes, and no single owner deletes it alone".

## One thing the suite could not have caught, and now can

The three tests passed alone and failed in `npm test`. The suite runs with
`NODE_OPTIONS='--import ./test/offline-guard.mjs'`, a path relative to the repository
root, and the fixture child runs with its cwd inside a temporary directory where that
does not resolve, so the child died and `execFileSync` threw. The harness now drops
`NODE_OPTIONS` for the child. Measured both ways: `3029 tests, 2988 pass, 0 fail,
41 skipped`, exit 0, build clean, `start:smoke` passed.

## The five questions

**Well built?** Three small fixes and one new bucket. The bucket is the part worth
arguing about, and it exists because the alternative made the report's own flagship
case disappear.

**Stats or made up?** Neither: every row is a call site at a file and a line.

**How do we know?** Five mutations with checksums and a control, plus a before/after
on the real report naming every row that moved and where it went.

**Pointed anywhere else on the platform?** This report is what the route deletions are
cut from. Until this landed, the "Falls with the deletion" section was not safe to act
on, and `horizonValue` is the proof.

**How does it unify?** One question — "what else goes when this route goes" — with
three honest answers instead of two, and each row naming what it depends on.
