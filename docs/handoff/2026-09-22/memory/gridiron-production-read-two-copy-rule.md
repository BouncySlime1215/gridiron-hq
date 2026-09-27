---
name: gridiron-production-read-two-copy-rule
description: Standing rule (Auditor R49, 17:20Z) — every production-snapshot read uses two copies, because importing the server's db module runs migrations against whatever file it opens, so a zero row-count on an imported copy is ambiguous
metadata:
  type: feedback
  modified: 2026-09-22T17:25:00.000Z
---
**Why:** Explorer's READ-B script found the gate-0 limit — importing `server/db/index.js` writes at import time (`:22/:45/:184/:194`: migrations, seeds), so any count taken through the app's own db handle is post-migration and n=0 cannot distinguish "the table was empty in production" from "the migration just created it". The Auditor ruled the limit GENERAL, not a READ-B quirk ([[gridiron-state-1256-2026-09-22]]).

**How to apply, for every read of a production snapshot:**
1. **Pristine copy, never imported.** Copy the snapshot; the pristine copy is opened only by a raw read-only SQLite connection (`?mode=ro` / `readonly: true`), never by the app's db module.
2. **Existence and row-count claims come from the pristine copy** via `sqlite_master` (does the table exist at all) and `schema_migrations` (which migrations had run in production), plus the raw count.
3. **Working copy** may be imported for app-level reads, but every count from it is labelled **post-migration** in the report.
4. A report that cites a count without saying which copy it came from is not evidence (pairs with [[gridiron-bespoke-tool-cross-check-rule]] and [[an-empty-read-must-not-reach-a-written-report]]).
5. Scripts that Nick runs on the live machine must also confirm they are safe with the scheduler brake OFF (jobs writing concurrently) before they are sent.
