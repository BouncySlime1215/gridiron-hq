---
name: deploy-654ff93-applies-no-schema
description: Deploying 654ff93 over the 791b131 image applies zero migrations, so the 445 MB pre-migration VACUUM INTO and the 2 GiB headroom guard do not fire on that boot.
metadata:
  type: project
---

Measured 2026-09-22: `git ls-tree --name-only server/migrations/` is byte-identical
between **791b131** (the image deployed on Fly) and **654ff93** (main after Nick
squash-merged #63, #52, #49). 63 files either side, highest still the two 062s.
#49 touches only fly.toml, #52 only the NFL_SEASON env line, #63 only the scheduler.

**Why it matters:** `backupBeforeMigration` (server/db/index.js:118) is gated on
prior schema history AND a pending migration. With nothing pending there is no
`VACUUM INTO` of the ~445 MB database ahead of `app.listen`, so
`SNAPSHOT_HEADROOM_BYTES = 2 GiB` (db/index.js:144) never runs, and boot is the
plain 60-180 s cold start -- inside the `grace_period = "300s"` that #49 set.
The biggest hazard the older deploy plan carried simply is not present.

**How to apply:** treat this as conditional, not settled. It holds only while no
migration rides along. 065 (fantasy plan's outlook fit store) and 066 (the ESPN
transaction collector, on 9c7cf68) are both in flight; if either lands on main
first, the snapshot and headroom hazard returns and the runbook must be re-read
before any deploy. This is why 9c7cf68 was deliberately kept off the deploy
branch. Re-run the `ls-tree` diff against whatever main is at the time rather
than quoting this file. See [[brake-not-in-fly-toml]] for the other deploy hazard
and [[gridiron-live-tier-offthread-branch]] for step 4 of the sequence.
