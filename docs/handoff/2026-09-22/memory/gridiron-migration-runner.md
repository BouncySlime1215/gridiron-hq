---
name: gridiron-migration-runner
description: How gridiron-hq's migration runner works, why the NNN prefix means nothing, and the silent trap where a half-rename skips the pre-migration backup.
metadata:
  type: reference
---

`server/migrations/NNN_name.js`, named exports `name`/`up`/`down`. `migrate()`
already wraps `up()` in BEGIN IMMEDIATE, so `up()` must NOT open its own
transaction. `server/db/schema/` is FROZEN.

## The NNN prefix conveys nothing

061 and 062 are each used by two or three branches in the 2026-09-19 release
train. Harmless: distinct `name` exports, disjoint tables, and
`readdirSync().filter().sort()` is lexicographic and deterministic (the order
is fixed and reproducible, NOT arbitrary).

**Do not fix a collision by renumbering.** `schema_migrations` stores the NAME,
so renaming a migration that has already run live makes the runner see it as
unapplied and call `up()` again, and 4 of the 32 `ALTER TABLE` migrations have
no idempotency guard. The scheduler thread owns a follow-up PR for timestamp
prefixes with existing files exempt forever.

## The trap: two different keys (verified 2026-09-19, currently unfired)

- `db/migrate.js:37` computes `pendingCount` from the FILENAME.
- `db/migrate.js:50` applies under `mod.name`; `db/index.js:70` is the real
  apply-once guard, keyed on that.

So **`mod.name` decides whether a migration RUNS, and the filename decides
whether a pre-migration `VACUUM INTO` backup is taken.** All 62 files agree
today, which is the only reason this has never fired.

The dangerous direction: a file whose basename IS in `schema_migrations` but
whose `mod.name` is NOT → `pendingCount` is 0 → `backupBeforeMigration` is
skipped → `migrate()` still runs `up()`. A live schema change with no snapshot
and nothing in the output saying so. Losing the snapshot is worse than the
re-run it enables, because it removes the thing you would use to undo the
re-run.

A rename that updates BOTH halves is loud and survivable instead.
**Always change the filename and the `name` export together.**

Written into the repo as `server/migrations/README.md` (PR #39). Becomes a
lint assertion later: duplicate `name`, duplicate number prefix, and
basename equals `name`.

See also [[gridiron-multi-user-gaps]], [[gridiron-google-sign-in]].
