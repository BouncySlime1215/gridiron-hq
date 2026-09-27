---
name: gridiron-fly-volume-has-no-backup
description: Nothing backs up the live Gridiron HQ database on Fly — nightly-backup.sh covers Nick's laptop clone, not /data — so a pre-migration .bak is the only snapshot of live rows that has ever existed.
metadata:
  type: project
---

**There is no scheduled backup of `/data/data.sqlite` on the Fly machine.**
Verified against `origin/main` at `791b131`, 2026-09-19.

`scripts/nightly-backup.sh` reads as coverage and is not:

- installed via a **LaunchAgent on Nick's Mac** (`com.gridironhq.nightly-backup.plist`, 04:30 daily)
- `SRC` is `$REPO/server/data.sqlite` — the **local clone**
- `DEST` is `$HOME/Documents/gridiron-db-backups`

It never touches `/data` and never touches the machine. `grep -i backup` over
`server/services/scheduler.js` and `source-registry.js` returns **nothing**, so
there is no in-app job either.

**Consequence.** The pre-migration `VACUUM INTO` snapshot that
`backupBeforeMigration` writes is not one restore point among several — see
[[gridiron-migration-snapshot-disk-gate]]. On that volume it is the **only**
snapshot of the live rows that has ever existed. The image tag rolls back code;
only that file rolls back rows.

So on a tight `df -h /data`, **"free up space by pruning old `.bak` files"
resolves to "delete the rollback"** whenever there is only one. The volume was
clean of `.bak` files at 20:58Z on 2026-09-19, so tonight's is the first. The
fix for tight disk is `fly volumes extend`. Pruning becomes a real option only
from the second migration deploy onward, and then: keep the newest, and keep any
taken before a migration whose undo needs rows rather than code.

**Latent hazard, not live.** That script prunes with
`ls -1t "$DEST/$NAME."*.bak` where `NAME=data`, and a shell `*` matches across
dots — so `data.sqlite.pre-migration-<stamp>.bak` **does** match it. Point that
script at `/data` and a job written to protect the database rotates the
migration rollbacks away seven at a time. Safe today only because `DEST` is a
directory on a laptop.

**Why it is worth a file.** This is the house failure mode in its purest form:
a backup that exists, runs nightly, writes a log saying `ok`, and covers a
different database from the one anyone would assume. Nothing fails. See
[[gridiron-release-train-2026-09-19]].
