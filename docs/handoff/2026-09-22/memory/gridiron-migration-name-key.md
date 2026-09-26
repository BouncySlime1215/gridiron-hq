---
name: gridiron-migration-name-key
description: Migrations are identified by their name export, not their number — which makes a duplicate name a silent skip and a half-rename a schema change with no backup behind it.
metadata:
  type: reference
  modified: 2026-09-19T21:30:00.000Z
---

Everything here follows from `server/db/index.js:70`:

```js
if (database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) return;
```

`schema_migrations` records applied migrations **by name** — the module's
`name` export, falling back to the basename. Not the number, not a hash. The
number is the thing that looks like the identity and is not.

**Three failure modes, two of them silent.**

1. **Rename an applied migration** → the runner sees one it has never seen and
   `up()` runs again. Three files would not survive that:
   `008_model_actor_foreign_keys.js` (six bare `ADD COLUMN`; throws
   `duplicate column name`, and `migrate()` wraps `up()` in a transaction, so
   it aborts the boot), `015_manager_profiles.js` (guards on `sqlite_master`,
   but the table exists again after the first run), and
   `028_settlement_corrections.js` (rename-swap; operates on the wrong table
   rather than throwing). Read each, not grepped — an earlier count of "4 of
   32 unguarded" was wrong, `001_baseline_marker.js` only mentions ALTER TABLE
   in a comment.
2. **Two files sharing a `name`** → the second is recorded as applied and
   SILENTLY SKIPPED. Clean boot, one schema change missing, nothing in the
   output. Easiest to hit by copying a migration as a template and editing
   `up()` without editing `name`.
3. **The half-rename, the worst one.** `migrate.js:36-38` computes
   `pendingCount` from the FILENAME, and that count gates
   `backupBeforeMigration`. `:50` applies under `mod.name ?? basename` and
   `db/index.js:70` guards on THAT. Rename both halves and it is loud. Rename
   only the `name` export and **no backup is taken** while `up()` still runs
   against the live database, with nothing saying the snapshot was skipped.
   Losing the `VACUUM INTO` snapshot is worse than the re-run it enables,
   because it removes the thing you would use to undo the re-run.

`000_legacy_schema.js` is pinned hardest: `db/index.js:5` imports it by path
and `LEGACY_SCHEMA_MIGRATION = '000_legacy_schema'` is a row in every deployed
database.

Found 2026-09-19: (1) by the scheduler thread, (3) by the Google sign-in
thread, (2) by the release thread's sweep of the merged tree. All three are
documented in `server/migrations/README.md` and enforced by `npm run lint`
(PR #39). See [[gridiron-migration-number-collisions]] for why the numbers
collide.
