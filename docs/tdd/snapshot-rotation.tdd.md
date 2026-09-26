# 54 SNAPSHOT ROTATION: verified read-only nightly copy, 7-day Trash-only retention

RED `193e1eaa` · GREEN follows · `test/snapshot-rotation.test.js`, 14 cases.

## The problem

`scripts/nightly-backup.sh` copies the database at 04:30 with `VACUUM INTO` and
prunes by count with a hard delete. It never opens the copy it just made, so a
bad copy can push out the last good one. Plan item 54 asks for a nightly
read-only snapshot with 7-day retention, an integrity check and a size report
(extending the Mac-side `bin/make-snapshot.sh`, which is not in this repository).

## What the tests pin (the pre-registered bar, PR #506)

- B1 the copy has the same tables and row counts as the source, has no write bit,
  and neither the source file nor its WAL changes.
- B2 a corrupted copy, or one missing a source table, fails verification; while
  the newest copy is failed, nothing old moves, on this run and on later runs
  (read back from the recorded verdict). Control: set the bad copy aside and the
  day-15 copy would move.
- B3 verified copies from the last 7 days (name stamp or mtime) stay; the newest
  verified copy stays however old; older verified copies move; unverified copies,
  other databases' snapshots and `.bak` files never move.
- B4 moves are `rename()` into the Trash with the verdict file; an existing Trash
  name is never overwritten; the script source names no deleting call. A copy on
  another volume (EXDEV) stays and is reported.
- B5 short of 1.5 x (main + WAL) free: exit 1, nothing written.
- B6 dry run by default; `--apply` without `GRIDIRON_SNAPSHOT_ROTATION=1` exits 2
  and the folder is byte-identical.
- B7 a full apply night: snapshot, verify, rotate, size report.
- B8 the size report adds up and shows growth since the previous verified copy.

## RED

`ERR_MODULE_NOT_FOUND: scripts/snapshot-rotation.mjs`: the file fails to load.

## GREEN

`scripts/snapshot-rotation.mjs`: `checkRoom`, `takeSnapshot`, `verifySnapshot`,
`planRotation` (pure decision), `applyRotation` (rename only), `sizeReport`,
`main`. 14 of 14 pass.

One test was corrected after RED, and the reason is the test's, not the code's:
B1 compared the source's mtime after closing the fixture's writer connection.
Closing the last writer checkpoints the WAL into the main file, which changes its
mtime whatever the snapshot did. The check now runs before the writer closes and
also pins the WAL's size.
