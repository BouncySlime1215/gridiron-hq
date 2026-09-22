---
name: gridiron-pre-migration-snapshot
description: NEVER DELETE a /data/data.sqlite.pre-migration-*.bak on gridiron-hq — it is the only copy of the live rows that has ever been taken, an image rollback restores code and not rows, and on a tight disk the fix is fly volumes extend rather than pruning.
metadata:
  type: reference
  modified: 2026-09-19T21:56:00.000Z
---

`backupBeforeMigration` (`server/db/index.js:118`) runs `VACUUM INTO` to
`${databasePath}.pre-migration-${stamp}.bak` whenever migrations are pending.
On Fly that is `/data/data.sqlite.pre-migration-<stamp>.bak`, about **445 MB**.

**Nothing deletes it.** Verified by grep: no cleanup exists anywhere in
`server/` or `scripts/`. Four migrations' own error messages tell the operator
to "restore the pre-migration snapshot instead" of downgrading.

**It is the only ROW-level rollback there is.** `fly image show` plus a
redeploy rolls back CODE; this file is the only way back to the rows a
migration changed. So the half-rename case in
[[gridiron-migration-name-key]] matters more than it first looks: what it
silently skips is not "a backup", it is the sole path back.

**And it is also a future boot blocker.** `assertRoomForSnapshot`
(`db/index.js:147`) demands the database's full size **plus 2 GB** free before
it will take a snapshot, and **throws** when it cannot — which blocks
`runMigrations`, which blocks the boot. Every deploy carrying a pending
migration adds another ~445 MB and nothing reclaims it, so the volume fills
and the app hard-fails rather than degrading. The error message names the
`*.pre-migration-*.bak` pattern, so pruning is expected to be manual.

**The Fly volume has NO scheduled snapshot of any kind.** `nightly-backup.sh`
looks like a counterexample and is not: it runs from a LaunchAgent on Nick's
Mac at 04:30, its `SRC` is `$REPO/server/data.sqlite` in his local clone and
its `DEST` is `$HOME/Documents/gridiron-db-backups`. It never touches `/data`
or the Fly machine, and there is no backup job in `scheduler.js` or the source
registry either. So a pre-migration `.bak` is the ONLY snapshot of the live
rows that has ever existed on that volume. (Release thread, 2026-09-19.)

**Operationally:** never delete the snapshot from the deploy you might still
need to undo. The 20:58Z probe found NO `.bak` files on `/data`; the 22:09Z
boot then wrote **exactly one**, ~445 MB, and that single file is now the only
copy of the live rows in existence. So on a tight `df` the only fix is
**`fly volumes extend`** — "prune to free space" there resolves to "delete the
rollback". From the second migration deploy onward, pruning genuinely old ones
is right.

**Latent hazard, not today's:** that script's prune is
`ls -1t "$DEST/$NAME."*.bak` with `NAME=data`, and a shell `*` matches across
dots, so `data.sqlite.pre-migration-<stamp>.bak` matches it. Point that script
at `/data` and a job written to protect the database rotates the migration
rollbacks away seven at a time. Safe only because `DEST` is a laptop directory.

Paths, retention and the headroom rule verified in `db/index.js` rather than
taken on trust.
