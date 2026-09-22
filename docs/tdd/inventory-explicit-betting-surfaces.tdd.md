# The betting surface test is a list, not a prefix

Auditor R17/R18: **a mount prefix is evidence for adding a surface to the list,
never the test.** The grader now carries the six files explicitly, each with the
reason it is on the list, and derives a route family's label from the files
actually mounted under it.

## What the prefix rule got wrong

Three prefixes — `/api/nfl-market`, `/api/nfl-betting`, `/api/betting` — matched
with a `/` boundary.

- **Right by accident:** `server/routes/wong.js` is mounted at
  `/api/betting/wong`, so the prefix caught it. Nothing about the URL made that
  true; it is true because wong.js is a betting route that happens to have been
  mounted under the hub.
- **Wrong on the merits:** `server/routes/execution-slate.js` is mounted at
  `/api/execution-slate`. No betting prefix matches it, so a module served only
  by bet-execution slates graded `wired` and counted inside the fantasy total.
- **Inexpressible:** `server/routes/mlb.js` is a third label. A module whose only
  request reach is `/api/mlb` is not betting-only *by definition*, and it is not
  part of the fantasy product either. A two-way prefix test has nowhere to put it.

A defect of my own turned up while rewriting the tests: one case asserted a route
family named `/api/betting/wong`. The map never emits that — `surfaceFamilies`
folds a mount to `/api/` + the second path segment, so wong.js's family is
`/api/betting`. The case passed under the prefix rule and pinned a shape that
does not exist.

## The rule now

`SURFACE_LABELS` is six entries with a comment each. `familyLabels(mounts)` gives
a family a label only when **every** file mounted under it carries that same
label; a family with one unlisted route mounted under it goes unlabelled, and
every module it reaches counts inside the fantasy total again. That is the safe
direction for a rule whose effect is to remove rows from the product's total.
`BETTING_ROUTE_FILES`, which grades the route rows themselves, is now derived
from the list rather than repeated beside it.

## Measured on this tree

| | prefix rule | explicit list |
|---|---|---|
| `wired` | 55 | **53** |
| `wired-betting-only` | 17 | **19** |

Both moves are `/api/execution-slate` and nothing else:
`pipeline:execution-slate-reasoning` (`["/api/execution-slate"]`) and
`pipeline:staking` (`["/api/nfl-betting", "/api/execution-slate"]`). Every other
row is unchanged, which is what should happen — the list is the three old
prefixes plus execution-slate, and no family on this map mixes labels.

**The mlb label moves nothing, and an earlier figure of mine was wrong.** I
reported a bracket of "mlb 0–1", from `pipeline:conformal`, whose only
non-betting *request* reach is `/api/mlb`. That measurement looked at route
families alone. `conformal.js` also carries **10 jobs and 37 scripts**, so it is
not betting-only under any reading and never was. The right figure is **0**.

## Bracket

- **53 / 19** as graded.
- **51 / 21** if the package.json-script default falls. Two rows turn on it:
  `pipeline:nfl-passing-diagnostic` (sole disqualifier
  `scripts/diagnose-passing-components.mjs`) and `pipeline:pick-reasoning`
  (`scripts/nfl-blind-audit.mjs`). That rule is with the Auditor and is unchanged
  here.
- **mlb-labelled: 0.** No row's reach is confined to betting plus `/api/mlb`.
- **job-reach only: 0.** No graded row has jobs as its only surface bucket.
- **no-surface-reach: 0.**

## Tests

`test/inventory-explicit-betting-surfaces.test.js`, seven cases (RED at the
commit before the rule existed): the list is the six named files with labels;
every listed file is really mounted, so the list cannot go stale in silence;
labels come from what is mounted, not from the family name; a family with an
unlisted file mounted under it takes no label; execution-slate reach alone is
betting-only; mlb reach alone is not; a betting family plus an unlabelled one is
not.

`test/inventory-betting-only-grade.test.js` was updated rather than replaced: it
now supplies the mounts its labels are read off, adds `/api/execution-slate` to
the "every betting family counts" sweep and `/api/mlb` to the negative side, and
the broken `/api/betting/wong` case is rewritten as the rule it was groping for —
a prefix is evidence, never the test, and one unlisted route under the hub
unlabels the whole family.

## Where the family rule and a file-level rule differ

Opportunity's grader labels route FILES, so the family hazard above cannot arise
there; they added a test that goes red when a route mounted under a betting
prefix is absent from the list, proved by commenting `wong.js` out. Measured on
this map's mounts: every route file has exactly one mount path, and `/api/betting`
has exactly two mounts, `betting-hub.js` and `wong.js`, both listed.

The residual hazard is the mirror image, named in their `CONTRACT.md` §2c: a
single route file serving both betting and fantasy endpoints would be labelled
wholly betting. None exists today. **The family rule fails safe on exactly that
case** — a family whose mounted files do not agree takes no label, so the module
stays inside the fantasy total. Two rules with opposite unsafe directions, which
is why the set diff between them is worth keeping.

## The five questions

- **Well built?** The list is data with a reason per entry, the labels are derived
  from the map's own mounts, and the only way a family becomes betting is that
  every route under it is on the list. 24 tests across the three inventory files.
- **Stats or made up?** Measured: 55/17 → 53/19, the two moving rows named, the
  mlb figure corrected from 1 to 0 by looking at the buckets I had skipped.
- **How do we know?** The move was predicted from the map before the code changed
  (4 candidate rows, 2 of them the package.json pair) and the regenerated artifact
  produced exactly those 2.
- **Pointed anywhere else on the platform?** Yes: any rule keyed on a URL shape.
  A mount prefix is a deployment detail, and `/api/execution-slate` is the proof —
  the same product, one path segment away from being counted correctly.
- **How does it unify?** Three reachability rules on this branch have now been
  wrong in the same way: a constant or a string pattern chosen for one question
  and applied to a second. `boot:` made the answer always yes, `CLOSE_HOPS` made
  it no at the tail, and a prefix made it depend on where a route happened to be
  mounted.
