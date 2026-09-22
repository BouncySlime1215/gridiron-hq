# "No local row count" was one sentence for two opposite facts

RED `2578fa2` · GREEN this commit · `scripts/inventory.mjs`, `test/inventory-table-locality.test.js`

## What was wrong

This container's dev database is a migrated shell holding **218** of the **327**
tables the map knows. Fifty tables that a live surface reads are not in it, and
every one carried the same reason:

> table `X` is read by a live surface; no local DB row count available

That says what the generator could not read. It does not say why, so a reader
cannot separate an absence caused by this container from an absence caused by
the code — which is the entire question the honest inventory exists to answer.

Split by creation bucket, the fifty are **48 `migration`** and **2 `import`**,
and those mean opposite things:

| bucket | what the absence means |
| --- | --- |
| `migration` | this shell is behind the migration list. Says nothing about production, where the migration has run. |
| `import` | no migration creates the table at all. It exists as a side effect of importing the module that owns it, so it is absent wherever that import has not happened. A fact about the code, which survives this container. |

The two `import` tables are `manager_archetypes` and `manager_archetype_jev`,
created at `server/services/manager-archetypes.js:74` and `:86` — the file says
so itself: *"These mirror manager-signals.js, which also creates its own tables
at import. A migration in server/db/schema/ would be the tidier home."*

They are **not** phantoms in this inventory's sense and the status does not
move. `referenced_but_never_created` is for a table whose only `CREATE TABLE`
is a test fixture or a hand-run script; here the creator is production code.
The one cross-module reader guards: `manager-signals.js:272` checks
`tableExists('manager_archetypes')` before reading. Recorded, not escalated.

## Effect

50 reasons rewritten, **0 statuses moved**, 873 rows unchanged. Measured by
diffing the generated file against the previous one by id.

## Defect injection

Tree sha256 is the first 16 hex of `sha256sum scripts/inventory.mjs`. Baseline
green `42dfda05bd1b4f9e`, 3 pass / 0 fail.

### T1 — always take the migration branch · `7a6ff981c5d029c1` · **KILLED** (2/1)
```
-      const why = t.created_by === 'migration'
+      const why = true
```
KILLED BY: *an import-created table missing from this shell says no migration creates it*

### T2 — never take it · `6f5d12b9a830570b` · **KILLED** (2/1)
```
-      const why = t.created_by === 'migration'
+      const why = false
```
KILLED BY: *a migration-created table missing from this shell says the shell is behind*

### T3 — drop the creation-site citation · `3598b3f6bf8d7d8b` · **KILLED** (2/1)
```
-          + `${t.created_at_site || 'an unrecorded site'}, so it exists only in a database where `
+          + `an unrecorded site, so it exists only in a database where `
```
The sentence still reads correctly in English and names the right bucket; what
it loses is the `file:line`, which is the only part a reader can check. Pinned
deliberately: this branch's whole claim is that a citation is a promise.
KILLED BY: *an import-created table missing from this shell says no migration creates it*

### T4 — control, comment text only · `1eaac976f971c566` · **SURVIVED** (3/0)
```
-      // Not a phantom either way: the creator is production code
+      // CONTROL. Not a phantom either way: the creator is production code
```

A third test asserts only that the two sentences differ from each other after
the table name is normalised away. It exists because both branches producing
the same prose would pass the two wording tests if the wording were generic
enough, and a distinction the reader cannot see is not a distinction.

## The five questions

**Well built?** Three tests over `buildRows` with a one-table fixture, no I/O.
The fixture tables are named `zz_fixture_*` because this repository's scanner
reads its own test files and a realistic name would appear in the next census.

**Stats or made up?** Measured. 218 of 327 tables present locally; 50 absent and
read by a live surface; 48 migration, 2 import; 0 statuses moved.

**How do we know?** `node --test test/inventory-table-locality.test.js` — 0/3 at
RED `2578fa2`, 3/0 at GREEN. Four injections, three killed with the killing test
named, one control.

**Pointed anywhere else on the platform?** Yes. `manager_archetypes` is read by
`manager-signals.js` and `scheduler.js`, and it is the same family as
`league_transactions_raw`, which has no creator in production at all. The
difference is that this one's creator is real and its reader guards, which is
why it is a note here and a `referenced_but_never_created` row there.

**How does it unify?** It is the LOCAL rule stated once more: a 0 or a blank in
this container is "unverifiable here", never "empty in production" — and now the
row says which of the two kinds of unverifiable it is.
