---
name: gridiron-orphan-client-pages
description: Model.tsx and Edge.tsx are imported by nothing and cannot be opened; findings about their dead fetches are not user-facing, and model.js forbids re-adding their routes.
metadata:
  type: project
  modified: 2026-09-22T17:54:21.230Z
---

**Measured 2026-09-22 on `f620a120`, with a control in the same scan.**

`client/src/pages/Model.tsx` and `client/src/pages/Edge.tsx` are imported by
**nothing** — not by `App.tsx`'s `lazy()` list, not by any hub page, not by a
dynamic import. No `<Route>` declares them. **A user cannot open either page.**

Control that makes the scan worth something: the same search finds
`TeamDetail` in `App.tsx:17`, `MyTeam` in `LeagueHub.tsx:4`, `Leagues` in
`LeagueHub.tsx:3` and `Drafts` in `DraftHub.tsx:3`. So the scan does find
reachable pages, including ones reached through a hub rather than a route.
An earlier version of this scan reported `MyTeam` and `TradeLab` as orphans
too — its regex missed both `lazy(() => import(...))` and hub imports. **Do not
repeat a page-reachability claim from a scan that has no passing control.**

## Why this matters for findings

`server/routes/model.js:1-26` records that **18 routes were deleted from it on
2026-09-20**, 16 of them `Model.tsx`'s read endpoints — `/accuracy`,
`/correlations`, `/gamescript`, `/handcuffs`, `/availability`, `/status` —
precisely because the page was unreachable. Its header then says, in capitals:

> DO NOT re-add a route here to give Model.tsx something to call. The page was
> removed from the navigation deliberately and the eight-tab nav is the decision.

That matches Nick's standing rule: **nav is 8 tabs, never rebuild deleted
pages.**

So a finding of the shape *"Model.tsx:31 fetches /model/status which 404s, so
the strip never renders"* is **true as a code fact and empty as a user-facing
one**, and acting on it by adding the route breaks both the in-file prohibition
and Nick's rule. Release raised exactly that finding at 17:51Z 2026-09-22 and
UI declined to build it for this reason. `/setup-status` is not a substitute
either: it returns `{needs_setup, missing, checked}` while the strip renders
`players_with_gsis`, `usage_seasons[]`, `correlations_fitted`, `lines[]`.

**The open question is whether the two orphan files should be deleted.** That is
a navigation decision and therefore Nick's, not a thread's.

## The lesson, not the entry

Before acting on "this surface is broken", check the surface is reachable. A
dead fetch on a page nobody can open is housekeeping, not a bug, and the fix
that makes it "work" may be the thing a previous decision deliberately removed.
See also [[gridiron-file-allocation]] — `routes/model.js` is Wiring map's, not
UI's, so even the tempting half was never UI's to write.
