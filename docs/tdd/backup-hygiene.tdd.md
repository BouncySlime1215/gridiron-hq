# 55 BACKUP HYGIENE: old pre-migration snapshots go to the Trash

RED `f623ca8e` · GREEN follows · `test/backup-hygiene.test.js`, 11 cases.

## The problem

`server/db/index.js#backupBeforeMigration` writes
`data.sqlite.pre-migration-<stamp>.bak` beside the database before every schema
upgrade and never prunes them. On 2026-09-10 eight of them held 57.3 GB and the
disk guard had to refuse the next migration. The code is right that giving up a
recovery point is a person's call, so this is a hand-run tool for that person,
not a job: nothing imports it, no scheduler runs it.

## What the tests pin (the pre-registered bar)

- B1 the newest 3 snapshots are always kept, however old.
- B2 nothing younger than 14 days moves, by the name's stamp OR the file's mtime.
- B3 only regular files named exactly `<db>.pre-migration-<ISO stamp>.bak` in the
  database's own folder are candidates; the live file, `-wal`, symlinks, other
  databases' snapshots, unreadable stamps and other `.bak` names are left alone.
- B4 files are renamed into the Trash, never deleted: each moved file is in the
  Trash at its full size, an existing Trash name is never overwritten, the Linux
  Trash gets a `.trashinfo` so it can be restored, and the source names no
  deleting call (`unlink`, `rmSync`, `fs.rm(`, `rm -`).
- B5 a file on another volume (EXDEV) stays in place and is reported; it is not
  copied then deleted.
- B6 the reported space equals the bytes actually moved.
- B7 the default is a dry run, and `--apply` without `GRIDIRON_BACKUP_HYGIENE=1`
  exits 2 with the directory byte-identical.

## RED

`ERR_MODULE_NOT_FOUND: scripts/backup-hygiene.mjs`: the file fails to load.

## GREEN

`scripts/backup-hygiene.mjs`: `planPrune` (pure decision), `applyPrune`
(rename only), `formatReport`, `main`. 11 of 11 pass. One test expectation was
corrected on a trial run before RED was committed: `data.sqlite.pre-migration-garbage.bak` is reported as
`unreadable_stamp`, not `not_a_snapshot_name`; the behaviour (left alone) is
what the bar asks for.
