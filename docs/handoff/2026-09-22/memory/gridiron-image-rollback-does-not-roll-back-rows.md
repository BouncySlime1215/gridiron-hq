---
name: gridiron-image-rollback-does-not-roll-back-rows
description: Rolling Gridiron HQ back to a previous Fly image restores code only — three of the 053-062 migrations write rows in up(), and two of those writes no down() can undo.
metadata:
  type: project
---

**`fly deploy --image <old tag>` rolls back code. It does not roll back rows.**
Checked against `origin/main` at `791b131`, 2026-09-19, after an earlier claim
that the batch was additive turned out to be asserted rather than read.

Three of the eleven migrations in the 2026-09-19 train write in `up()`:

| Migration | What `up()` does beyond adding |
| --- | --- |
| `053_nfl_news_signals_versioning.js:55` | `DROP TABLE nfl_news_signals`, then renames a rebuilt table into its place |
| `055_repair_pinnacle_placeholder_openers.js:84` | `UPDATE game_lines SET open_spread…` / `…open_total…` over existing rows |
| `061_sync_log_consecutive_failures.js:19` | `UPDATE sync_log SET consecutive_failures = 1 WHERE last_status = 'error'` |

**Neither `UPDATE` is recoverable by the migration's own `down()`.** `055`'s
`down()` drops the `open_*_source` columns it added and leaves the overwritten
`open_spread` / `open_total` values in place; `061`'s drops its column. A
`down()` undoes a *schema* change. It cannot remember what a value was before
something overwrote it. Do not read the presence of a `down()` as reversibility.

**How to apply.** The complete rollback is the image **plus**
`/data/data.sqlite.pre-migration-<stamp>.bak` (see
[[gridiron-fly-volume-has-no-backup]]). That second half discards everything
written since the snapshot, so it is a decision for Nick with the failing
migration *named*, never a command prepared in advance. For one named migration
the question is usually small and the image alone is usually enough — the
general case is what is unsafe.

`npm run db:rollback` takes one migration at a time, newest first, and **pass
the name explicitly**: bare, it takes the last-sorted file, which is
`062_league_payload_season`.

**Why this earned a file.** The false sentence was not in a chat message, it was
in the deploy plan's *rollback section* — the one page a person reads while
rolling back, at the moment they are least able to check it. This project's
recurring failure mode arriving through documentation, same as
[[gridiron-designated-band-occupied]]. The tell both times: a property of a set
of files claimed without opening them. **Open the files.**
