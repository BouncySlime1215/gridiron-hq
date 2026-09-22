---
name: gridiron-db-local-name-false-finding-lesson
description: Fleet lesson (Coach #90, 18:10Z) — wiring-map.mjs:384 resolves ANY local named `db` to the app database, so a module that names a different handle `db` gets false wiring findings; rename the local (Coach used `chatDb`) rather than baseline the findings
metadata:
  type: project
  modified: 2026-09-22T18:11:00.000Z
---
**Why:** Coach's #90 carried 19 wiring findings on its old base that survived the rebase onto c90d2834. None were real: the wiring map's resolver (`wiring-map.mjs:384`) treats every local variable named `db` as the application SQLite handle, so Coach's chat-store handle — also called `db` — made the map think six files wrote app tables they never touch. Renaming the local to `chatDb` took the branch to wiring exit 0 (head 4b7f49ec) with no code behaviour change; the six remaining entries were baselined under `_NEWLY_BASELINED_2026_09_22_COACH` with owner + RETIRES WHEN.

**Rule:** a wiring finding on a module whose DB handle is not the app DB is checked against the resolver first, not baselined. If the finding comes from the `db` name, rename the local; a baseline entry for a false finding hides the resolver defect from the next thread. Follow-up for Wiring map (now its next unit, 19:12Z): the collector checks `foreign.has(name)` before the `db` convention and should already resolve `chatDb` — collector defect, evidence 2 [[gridiron-gate-pr-merge-main-first-lesson]]. The takeaway is NOT "name your handle db". Pairs with [[gridiron-name-the-table-rule]] and [[wiring-map-annotations-live-in-the-out-dir]]. Origin [[gridiron-state-1286-2026-09-22]].
