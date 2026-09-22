# 597 unresolved rows are six questions, not one pile

RED `2095e57` · GREEN this commit · `scripts/inventory.mjs`, `test/inventory-blockers.test.js`

## What was missing

The inventory said 541 `unclassified` and 56 model-blank and stopped there.
That number is unreadable in both directions. Read as a score it says the
inventory failed. Read as a to-do list it says grind harder at the source.
Neither is true, and a reader with no other information cannot tell which rows
are anybody's to move.

## What the rows actually are

| rows | waiting on | kinds |
| --- | --- | --- |
| 416 | a production row count | pipeline, table |
| 61 | a run: static analysis cannot say whether a job writes rows | job |
| 56 | the model-evidence audit thread | model |
| 31 | a deployment question: whether the image ships the file | table |
| 19 | the UI thread | page |
| 13 | adjudication between two threads | pipeline, route |
| 1 | a file that exists only on the owner's Mac | table |
| 0 | unsorted: no bucket claims these yet | — |

**416 of 597 turn on one fact**, and it is not a judgement or a design
question: a row count from the production database. `server/data.sqlite` in
this container is a migrated dev shell holding 218 of 327 tables, so a LOCAL
count of 0 means "cannot be confirmed here" and never "empty in the app".
Nothing in this repository moves those rows. Effort spent classifying them
from source is wasted, and the point of printing the number is to stop that
effort being spent.

## The invariant

Every unresolved row lands in **exactly one** bucket, and the buckets sum to
the unresolved total. A breakdown that silently drops rows is worse than no
breakdown, because it reads as complete.

The catch-all is returned and printed **even at zero**. A bucket that
disappears when empty is a bucket nobody checks; keeping it visible is what
makes a reason string nobody has bucketed show up as a number instead of going
quietly missing.

## Where the order is load-bearing, and where it is not

The first draft of this comment said "ORDER MATTERS" about every bucket. That
was a guess dressed as a warning, and the mutation table below caught it.

Measured: **11 of the 13 CONTESTED rows also carry the LOCAL-0 wording**,
because a contested reason quotes this map's own reading verbatim. Testing the
row count first moves all 11, and the disagreement with the other thread
disappears into the largest bucket — which is exactly the kind of quiet loss
this breakdown exists to prevent.

The job and satellite buckets do **not** overlap the LOCAL-0 wording on the
current tree: 0 rows each. Their position ahead of it is defensive, not
load-bearing, and the comment in the source now says which is which. A blanket
"order matters" teaches nobody where to be careful.

## Defect injection

Tree sha256 is the first 16 hex of `sha256sum scripts/inventory.mjs`.
Baseline green `87ef1377963e3d87`, 11 pass / 0 fail.

| # | injection | tree | result | killed by |
| --- | --- | --- | --- | --- |
| I1 | drop the catch-all from the returned list | `88384412a59e0294` | KILLED 8/2 | *the catch-all is reported even when it is empty* |
| I2 | let a resolved row into the breakdown | `23a3a47b4c9a34d0` | KILLED 9/1 | *a resolved row is not in the breakdown at all* |
| I3 | test LOCAL-0 before the job and satellite buckets | `af20c1f76175dc7c` | **SURVIVED 10/0**, then `e4ad54872e585d32` KILLED 10/1 | *a contested row that also reads LOCAL 0 tables is contested, not a row count* |
| I4 | drop the absent-from-local-shell half of the production bucket | `0cad8a8cc8736934` | KILLED 9/1 | *a table absent from the local shell is the same blocker, not a new one* |
| I5 | send an unrecognised reason nowhere instead of to the catch-all | `8668a7347c08783d` | KILLED 8/2 | *every unresolved row lands in exactly one bucket* |
| I6 | sort lightest first | `191acc3e52477fe5` | KILLED 9/1 | *buckets come back heaviest first, with the catch-all last* |
| I7 | control, one word of the doc comment | `a394a623a9649d5d` | SURVIVED 11/0 | — |

**I3 is the row worth reading**, and it is the second time on this branch that
a surviving mutation was a finding about the test rather than a clean bill for
the code. It survived because every fixture job row had an empty reason and no
fixture was both contested and LOCAL-0 — the overlap that actually exists in
the data. Checking the real rows is what produced the 11-of-13 figure, and the
figure is what made the test worth writing.

## The five questions

**Well built?** One pure function over rows, seven buckets and a catch-all,
with the summing invariant as its own test rather than as a comment.

**Stats or made up?** Measured, every number from the generated rows:
416/61/56/31/19/13/1/0 summing to 597 of 880, and 11 of 13 for the overlap
that fixes the order.

**How do we know?** `node --test test/inventory-blockers.test.js` 0/10 at RED,
11/0 at GREEN; `node scripts/inventory.mjs --check` passes. Whole tree:
`npm run check` exit 0, `npm test` **3130 tests / 3089 pass / 0 fail / 41
skipped**, up from 3119 / 3078 — the 11 tests here. Tree `61d3b7f4` and the
`node_modules` mtime identical either side of the run; that tree is this
file's parent commit, which the commit adding this paragraph does not change
in any way the suite reads. Six injections
killed with the killing test named, one control, and one survivor recorded and
then closed.

**Pointed anywhere else on the platform?** Yes, and it is the reason to print
it: two of the three largest blocks — 416 rows and 61 rows — are answered by
reading production and by running the scheduler, neither of which is this
thread's to do. The table is what lets somebody else pick them up.

**How does it unify?** Being brutally honest about what is built means being
equally honest about what cannot be known from here. An inventory that reports
597 unknowns without saying what would resolve them has described its own
limits as if they were the product's.
