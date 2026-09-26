---
name: gridiron-a-tombstone-is-earned
description: Project rule adopted 2026-09-20 for gridiron-hq route removal — a deleted route gets a 410 tombstone only when the capability moved somewhere to point at, otherwise a plain 404.
metadata:
  type: project
  modified: 2026-09-20T07:37:22.885Z
---

**Adopted as the project rule on 2026-09-20 (coordinator ruling), in the wiring
map's legend.** When a route is cut from gridiron-hq:

- **410 tombstone with a pointer** when the capability still exists somewhere —
  the caller deserves to be told where it went, and a silent 404 reads like a bug.
  `retired(use, why)` in `server/routes/trades.js` is the shape.
- **Plain 404** when nothing dials it and nothing serves a string naming it. A
  tombstone is code that must keep working, so it is earned by having somewhere
  to point. A capability that was abandoned rather than moved has nowhere.

Documents that list a route as an orphan to retire are a record of the decision
to remove it, not a pointer telling anyone to call it, so they do **not** earn a
tombstone.

**Worked example, the sixteen-handler cut in `routes/trades.js` (ef3164e).**
Fifteen to 404. One 410: `GET /api/trades/splits/:playerId` points at
`GET /api/trades/:leagueId/player/:id`, because `playerOutlook` calls the same
`relevantSplits()` and Trade Lab renders the result. Kept as live: the two
existing 410s (`/brain/plan`, `/brain/sell-high`, pinned by
`test/trade-route-retirement.test.js`) and `POST /managers/rebuild`.

**Two rules that travel with it.**

1. **A route's death and its service's death are two different findings**, and a
   sweep that conflates them is wrong in both directions. `/splits/:playerId` had
   zero callers while `relevantSplits()` was alive. `/brain/liquidity`'s
   `positionLiquidity()` looked alive because `shoppingGuidance()` calls it — and
   `shoppingGuidance` has no consumer either. **A one-level consumer grep keeps
   two-level orphans alive forever.**
2. **Prune the import in the same commit as the route.** A dead import makes a
   service look consumed, so it puts a phantom consumer into the next
   reachability report. `byeOutlook` had been such a phantom in `trades.js`
   before this cut.

**How to apply.** Read every grep hit rather than counting them — a name in a
comment, a doc line or a served note string is a mention, not a dial. Evidence
table for this cut: `/mnt/project-files/trades-routes-evidence-2026-09-20.md`.

Related: [[gridiron-import-graph-orphans-are-not-dead]],
[[assertion-must-name-the-thing-it-guards]].
