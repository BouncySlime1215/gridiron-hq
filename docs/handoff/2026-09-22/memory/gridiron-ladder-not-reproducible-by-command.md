---
name: gridiron-ladder-not-reproducible-by-command
description: The inventory ladder's 116/53/67/183 come out of no committed command; only 319, 228 and 14 regenerate. Also the squash-safe evidence-citation rule (#N + subject + sha, RED output inline).
metadata:
  type: project
---

**Measured by the auditor, 2026-09-22 R51.3**, on `b0c1616d` (write-tree `500bab36`, the
ladder's own tree): population `git ls-files server/services server/modeling` minus
`server/modeling/ARCHITECTURE.md` = **319**. `node scripts/reach-grade.mjs --json <319>`
gives **wired 228**, betting-only 55, mlb-only 3, offproduct-only 2, hand-run 10, unreached
21. Of the 228, 214 have a non-betting route entry and **14** are script-only. The grader
needs `typescript` (locked 5.9.3), so `npm ci` first.

**UPDATE R54.1:** the EDGE bracket IS reproducible with the grader's own exports:
`classifyImportEdges(...).request` then `dropRouteBootEdges`, `reachableEntries` and `gradeReach` on
500bab36 give request-only **172**/65/6/18/11/47 = 319 (request+job 228/55/3/2/10/21).
main's `CONTRACT.md:160-166` prints the request column as **178**/65/6/18/11/47 "= 319",
which actually sums to **325**: a false total, and a +6 with no source. The CLI never calls
classifyImportEdges. CONTRACT's "job reach" means deferred (in-function) imports, NOT
package.json scripts. Entry-type (route vs script) is a different axis from the edge bracket.
**Reproducible by command: 319, 228, 172, 14.** **NOT reproducible: 116, 53, 67, 183, 178.** 116 is an
in-session per-row confirmation partition (static request edges + handler-callback edges,
114/9, then R30's move of 7), never committed as a script. main's `docs/inventory/` has no
183. `CONTRACT.md:126-135` on main reads 178–228 and defines "228 = request + job reach".
**Quote 116/53/67/183 only with "500bab36, not reproducible by command"** until the
partition is a committed script. Open conflict: the Phase-A bracket's "250 including
job-only reach" against CONTRACT.md:134's 228 for the same definition (and main's
INVENTORY.md:87 has an unrelated 250 = inventory rows of kind `pipeline`).
Lesson: R30's "three independent methods" cross-checked the 7-file MOVE, not the total. A
cross-check covering a delta does not certify a total. See [[gridiron-bespoke-tool-cross-check-rule]].

**Evidence-citation rule (R52.2, adopted 2026-09-22):** this repo SQUASH-merges, so every
RED/GREEN sha becomes unreachable from main after merge. Cite **`#N`, commit subject, sha**
(`git fetch origin pull/N/head` recovers them). The evidence file carries the RED's
**failing assertion message inline**. Before merge, check
`git merge-base --is-ancestor <sha> <head>` for both. A rebase updates the shas in the
same push. Fix existing files before merge only where a sha is unreachable from the head.

**Also:** `pairedBootstrapDiff`'s `mean_diff` (backtest-significance.js:114) is the mean
over bootstrap iterations, NOT the observed difference, and the function returns no
observed difference. A figure off `mean_diff` is seed-dependent in the 4th decimal.
