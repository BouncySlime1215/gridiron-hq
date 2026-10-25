---
name: gridiron-v2-outage-version-bump
description: Bumping WEEKLY_FEATURE_STORE_VERSION took the app down for 4+ minutes and wrote 684 player / 32 team v2 rows into production; v2 is quarantined because of that incident, not caution.
metadata:
  type: project
---

Verbatim from `server/services/nfl-weekly-feature-store-v2.js:6-16`, read at
source on origin/main **654ff93**, 2026-09-22:

> Why it is separate, 2026-09-17: v2 was built for the
> feature-store-as-substrate study and landed by editing the production module
> in place. The server's nfl_model_growth job freezes weekly vectors at
> WEEKLY_FEATURE_STORE_VERSION, so on the next restart it found no v2 rows and
> began rebuilding every 2026 player vector synchronously on the main thread —
> the app stopped answering requests for 4+ minutes and wrote 684 player / 32
> team v2 rows into the production database before it was stopped.

**Why this matters beyond v2.** The failure was not in the features. It is the
shape of the growth job: vectors are frozen at a version constant, so **any**
change to that constant makes the next restart rebuild every vector
synchronously on the request thread. A one-line constant bump is a latent
outage in this codebase.

**How to apply.**
1. Never bump `WEEKLY_FEATURE_STORE_VERSION` as part of a feature change.
   Treat it as a migration with its own backfill, run off the request path,
   before anything reads the new version.
2. Any proposal that touches v2 must answer the restart question first, before
   the feature question. "The columns are free" is not an answer.
3. **Open item nobody has closed:** 684 player and 32 team v2 rows were written
   into the production database and the note does not say they were removed.
   Confirm whether they are still there before a second attempt — stale rows at
   a version the code no longer builds are exactly what made the first restart
   rebuild everything.
4. This is also why the study copy exists at all. Editing the production module
   in place was the proximate cause; the STUDY-ONLY split is the fix, and it
   holds only while nobody re-merges them.

Scope and the study's no-ship verdict: [[gridiron-v2-satellites-absent]].
Related: this project ships restart bugs of exactly this family — see the
restart-cycle history in [[gridiron-restart-cycle-2026-09-19]].
