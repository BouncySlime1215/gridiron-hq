---
name: gridiron-name-the-tree-rule
description: "Every line number and count in a package must carry the commit it was read on. main moves several times an hour in this project, so an unanchored file:line is wrong within the hour."
metadata:
  type: feedback
---
**Rule:** a figure without a tree is not evidence. Every `file:line`, every
count of call sites, consumers or feature keys, carries the commit it was read
on — `read on 654ff93` — in the package, not just in the handoff message.

**Why:** `main` in this repository moves several times an hour. On 2026-09-22
Explorer published counts and anchors from `654ff93`; within the hour Planner
re-read the same file on `4a8085c` and found the writer had moved from `:539` to
`:563`, the feature block from `:440-545` to `:447-559`, and the suffix count
from 88 to 91. Neither reading was wrong. The package was, because it presented
the numbers as if they were properties of the code rather than of a commit.

**How to apply:**
1. Print or record the commit before measuring, and put it in the package header
   AND beside any table of figures.
2. When a figure is corrected on a newer tree, keep both rows with their trees
   rather than overwriting — the disagreement is usually movement, not error.
3. Prefer a symbol name to a line number where one exists: `writeTeamWeeks` is
   stable, `:539` is not. Give both (R54.5 requires the function verbatim with
   file:line).
4. Some counts must not be quoted at all. `drop_` cannot be grep-counted in this
   repo because it matches `drop_table` and similar; a count of it is noise
   whatever the tree.

Related: [[gridiron-name-the-table-rule]], [[gridiron-bespoke-tool-cross-check-rule]],
[[gridiron-charting-never-reaches-team-week]].
