---
name: gridiron-disk-gate-fired-2026-09-19
description: The 2026-09-19 Gridiron HQ deploy failed for 35 minutes because the Fly volume was 1 GB — the snapshot disk gate refused, and the df check that would have caught it was written into the plan and never run.
metadata:
  type: project
---

**The volume was 1 GB and nobody had looked.** The release-train deploy went
ahead without the `df -h /data` that its own plan made a hard precondition. See
[[gridiron-migration-snapshot-disk-gate]] for the mechanism.

Machine log, 22:00Z: `Refusing to migrate: a pre-migration snapshot of 0.4 GB
needs about 2.4 GB free, and 0.4 GB is available of 1.0 GB`, through
`assertRoomForSnapshot` (`db/index.js:163`) → `backupBeforeMigration` (`:123`)
→ `runMigrations` (`migrate.js:43`) → `index.js:23`. Then `Main child exited
normally with code: 1`, repeating, until `machine has reached its max restart
count of 10`. Fixed with
`fly volumes extend vol_40oxk076jmqlelm4 -s 5 -a gridiron-hq`.

**Over HTTP this was 35 minutes of 502 with an empty body** — identical to a
slow boot, to a wedged app and to no machine at all. `fly deploy` reported only
`timeout reached waiting for health checks to pass`, which is downstream of
every boot failure and names none of them. **Only the machine log distinguishes
them.** flyctl's trailing `net/http: request canceled` is its own poll being
cancelled by its wait deadline, not a second fault.

**A refused deploy leaves nothing to undo.** No migration ran and no `.bak` was
written, because the refusal is before the `VACUUM INTO`. The retry is a clean
first attempt, never a resumption.

**No step between `extend` and `deploy`.** Fly's init sizes the filesystem to
the volume when it mounts `/data`; the deploy boots the machine. The log line
`Resized /data to 1056964608 bytes` is that init, and the same line on the next
boot is a free check that the extend took — 1,056,964,608 bytes is a 1 GB
volume.

**A retry after an extend boots slower than the attempt that failed**, because
the snapshot then actually runs. Expect flyctl to report a health-check timeout
against a healthy boot: `fly.toml` has `grace_period = "60s"` against a 60-180s
cold start plus a 445 MB `VACUUM INTO`. A failing check evicts from routing and
does not kill the machine, so the app serves once it listens. **The log decides,
not the clock.** PR #49 raises it to 300s.

**The lesson is duller than the failure modes this project collects.** The check
existed, was correct, named the right number, and sat in two places in the
document. It was written and not run. A precondition nobody runs is not a
precondition.
