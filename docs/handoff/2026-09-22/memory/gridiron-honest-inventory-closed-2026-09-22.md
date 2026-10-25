---
name: gridiron-honest-inventory-closed-2026-09-22
description: Item 5 (honest inventory) — wiring map + model-audit merge landed at 6dc964c; 873-row breakdown with contested rows left unclassified honestly rather than forced to a verdict; Opportunity's availability-basis.js finding resolved as out-of-scope (own branch only).
metadata:
  type: project
  modified: 2026-09-22T02:55:45.606Z
---

Supersedes the "Wiring map phantom-table detail" entry in
[[gridiron-thread-detail-2026-09-22]] (that was the pre-merge, 872-row pass
at 0c13654).

## The merge

Wiring map's merge with model-audit landed at commit **6dc964c**, tree
**cc99671b754edfdce8eecffa6814b8ce6c5fc3dd**, in the shape the coordinator
adjudicated:

- **15 rows agreed** — took model-audit's status+evidence, since
  model-audit's row carried the actual consumers.
- **13 rows genuinely contested** — left `unclassified` with both readings
  named **verbatim** in the row itself (not paraphrased). Example:
  `route:aggregates` names both "wired" (this map: mounted + script caller)
  and "half_done" (model-audit: page callers exist but outside App.tsx's
  import closure), without adopting either definition project-wide.
- Model-audit's evidence file
  (`docs/inventory/model-audit-rows-654ff93.json`, sha256
  `f08e3fd3288e2b046cc5011d25eccade22ba159c70a411c284c4d1055a1b6fd4`) is now
  **vendored into the repo**, not just held on the shared mount.

## Corrected final breakdown — 873 rows total

| status | count |
|---|---|
| wired | 72 |
| half_done | 182 |
| dead | 15 |
| silently_broken | 3 |
| referenced_but_never_created | 7 |
| model-blank | 56 |
| unclassified | 538 |

Of the 538 unclassified: **378** are "reachable but LOCAL-0" — blocked on
the freshness-registry/live-count work, which is item 5's own stated
dependency, not a generator failure. **13** are the contested rows above.

Evidence: `npm run check` exit 0, suite 3077/3036/0/41; `inventory --check`
exit 0 on 873 rows; `wiring --check` exit 0. Two TDD files:
`docs/tdd/job-citations-off-by-one.tdd.md`,
`docs/tdd/route-callers-script-is-not-a-page.tdd.md`.

## Opportunity's availability-basis.js finding — resolved, out of scope

Opportunity reported 4 of 6 exports of `availability-basis.js` as
unconsumed. That does **not** apply to the main tree: the file exists only
on Opportunity's own local branch as new code (+135 lines, per Opportunity's
own diff-stat vs origin/main), not on 654ff93.

Wiring map's read of the real file at that path/import
(`player-availability.js`, imported at `contingency.js:21`) shows 4 of 6
exports **are** consumed.

Resolution: single-scope rule applies (same precedent as
`/api/model/status`) — no inventory row until Opportunity's branch actually
merges. Opportunity's finding was accurate about its own branch, just out of
scope for tonight's tree-wide inventory. Both threads were told this by the
coordinator.

## Status

Item 5 (honest inventory) reads as **effectively CLOSED for Phase 0**
purposes: the wiring map + model-audit merge is done, contested rows are
honestly marked `unclassified` rather than forced to a verdict, and the
remaining open piece (378 rows needing live counts) is explicitly gated on
the DB-copy trip — a known, already-communicated dependency, not a new gap.
