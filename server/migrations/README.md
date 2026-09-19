# Migrations

Read this before renaming anything in this directory, or before copying a
migration as a template.

Everything below follows from one line in `server/db/index.js`:

```js
if (database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) return;
```

`schema_migrations` records applied migrations **by name** — the module's
`name` export, falling back to the filename without `.js`. It does not record
the number, a hash, or anything about the file's contents. The name is the
identity. Two failure modes fall out of that, and they are opposites.

## 1. Never rename a migration that has already run

Renaming an applied migration does not tidy it. It presents the runner with a
migration it has never seen, and `up()` runs a second time against a database
that already has the change.

Whether that is survivable is per-file, not a property of the system. Most
migrations here guard their own work — `PRAGMA table_info` before an
`ALTER TABLE ... ADD COLUMN`, `CREATE TABLE IF NOT EXISTS` — and a second run
is a no-op. Three do not, and they are why this rule has no exceptions:

- `008_model_actor_foreign_keys.js` — six bare `ADD COLUMN` statements. A
  second run throws `duplicate column name`, and because `migrate()` wraps
  `up()` in a transaction, the failure aborts the whole boot.
- `015_manager_profiles.js` — guards on `sqlite_master`, but the table exists
  again after the first run, so a second run tries to rename the live table to
  `manager_profiles_legacy` on top of the one already there.
- `028_settlement_corrections.js` — rebuilds `nfl_execution_lifecycle_events`
  through a rename-swap. A second run does not throw so much as operate on the
  wrong table.

`000_legacy_schema.js` is pinned harder still: `server/db/index.js` imports it
by path, and `LEGACY_SCHEMA_MIGRATION = '000_legacy_schema'` is a row already
in every deployed database.

## 2. Never reuse a `name` export

The same line, read the other way. If two files export the same `name`, the
first to sort is applied and recorded, and the second is **silently skipped** —
no error, no warning, nothing in `schema_migrations` to show it was passed
over. The application boots cleanly and one migration's schema change simply
never happened.

This is the dangerous one. A duplicate number is cosmetic; a duplicate name is
silent data loss. It is easiest to hit by copying a nearby migration as a
template and editing `up()` without editing `name`.

## Duplicate numbers are expected, and are not a bug to fix

Several files share a number, `062` among them. That is not damage and does
not need cleaning up.

Numbers are assigned by hand against whatever the author can see, which is
merged history plus their own branch — never the other branches in flight. In
September 2026 `main` sat at `052` while five branches numbered independently
into `053`-`062`. Two of them picked `061`; one renumbered to `062`, which two
others had already taken. Git merges files with different names without
reporting a conflict, the runner applies each one exactly once under its own
name, nothing errors, and no test shows anything.

The collisions that exist are harmless: distinct `name` exports, one
`schema_migrations` row each, disjoint schema, and no migration reading a table
another one creates. The ordering is not even unpredictable — the runner sorts
filenames lexicographically, which is deterministic. What is lost is the
number's meaning, not the correctness of the result.

Renumbering is not a fix for this. It is a re-roll against the same incomplete
information, which is how `062` ended up with three claimants. And per rule 1,
it stops being available at all once a file has been deployed.

## Adding a migration

Each file default-exports `{ name, up(db) }`, optionally `down(db)` for
`rollbackMigration`. Discovery is `/^\d+_.+\.js$/` over this directory, applied
in lexicographic filename order.

- Give it a `name` nothing else in this directory uses. Check, do not assume.
- Write `up()` so that running it twice is a no-op, even though it should never
  happen. Guard column additions with `PRAGMA table_info`, create with
  `IF NOT EXISTS`, and make backfills idempotent. That is cheap on the way in
  and is the only thing standing between a mistake here and a boot that cannot
  complete.
