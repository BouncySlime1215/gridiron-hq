---
name: migration-numbering-gridiron-mechanics
description: migrate.js mechanics behind Gridiron HQ migration numbering — the name-export/filename hazard, the permanent-old-numbers rule, and the discovery regex. Split out of migration-numbering-gridiron.md for its byte cap.
metadata:
  type: reference
  modified: 2026-09-22T04:41:19.956Z
---

Split from [[migration-numbering-gridiron]] (numbering/authorship history lives there).

**`migrate.js` has a latent hazard worth knowing before writing any
migration:** `pendingCount` derives a migration's name from the FILENAME to
decide whether to take the pre-migration `VACUUM INTO` snapshot, while the
apply-once guard keys on the `name` EXPORT. A file whose two disagree runs
`up()` against the live database with no backup taken and nothing in the
output saying so. Always make the `name` export exactly the basename; #39's
lint checks it. The scheduler thread holds the fuller account of this in
[[gridiron-migration-name-key]] — all three failure modes, and the point that
what a half-rename skips is not "a backup" but the only row-level rollback
that exists, since nothing snapshots the Fly volume on a schedule.

The switch to timestamps, when it comes, is **new files only and the old
numbers stay permanently** (settled by #39, 2026-09-19): renaming an applied
migration re-runs `up()`, and `008_model_actor_foreign_keys.js` has six bare
`ADD COLUMN`s that would throw `duplicate column name` inside `migrate()`'s
transaction and abort the boot.

`migrate.js` discovery is `/^\d+_.+\.js$/` and the runner sorts filenames
lexicographically, so both forms are *accepted*; the problem is only mixing
them. #39's lint accepts either form and checks that the `name` export equals
the basename.
