---
name: gridiron-a-column-that-does-not-add-up
description: CONTRACT.md printed a hand-adjusted wired figure (178) in a column of measured cells, so the column summed to 325 under a printed total of 319; print the sum, and keep adjustments out of columns.
metadata:
  type: project
---

2026-09-22. `docs/inventory/CONTRACT.md`'s request-reach column read `wired` =
**178** while its other five cells read the **172** measurement they came from.
178 was 172 plus a §2b hand-adjustment (+6 files, from adding back 12
function-body import edges in route-reached modules), applied to one cell
without taking those six files out of whatever they had been graded before.
The column summed to **325** under a printed total of **319**, and nobody has
ever named which six files move or what they stop being.

**Why it mattered:** the Phase A plan reads this bracket before it reads
anything else, and a column that does not add up is the kind of thing a plan
quotes without checking.

**How to apply:** an adjustment that cannot be applied to a whole column does
not belong in one — it goes in prose with its reasoning. Print the column sum
next to the column. Pin a measurement to the **population's** subtree hashes
(`server/services`, `server/modeling`), not a whole-tree write-tree hash, which
moves when anything in the repository moves. And a figure measured on a tree
that is not reachable from the repository — the 172/228 pair came from tree
`500bab36`, commit `b0c1616d`, neither of which exists here — can only be
quoted as not reproducible.

Fixed in PR #137 (`3a770c6`): 169/225 on `c90d2834`, both columns summing to
321, each with its command printed beside it.

Related: [[gridiron-evidence-citation-rule]], [[gridiron-cite-the-shipping-tree]].
