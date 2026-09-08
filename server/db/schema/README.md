# Legacy schema fragments

Every `CREATE TABLE` / `CREATE INDEX` / `CREATE TRIGGER` / guarded `ALTER TABLE`
that used to run at import time from 122 service and route files, moved here so
the schema has one home and `server/migrations/000_legacy_schema.js` can apply it
once, at database open, before any service is imported.

**This directory is frozen.** It reproduces the schema exactly as it existed at
the `001_baseline_marker` cutover. Do not add a table or column here — write a
new numbered migration under `server/migrations/`. A fragment edited after the
fact silently does nothing on any database that has already recorded
`000_legacy_schema` as applied, which is every database that matters.

## Fragment contract

One file per batch, `server/db/schema/<batch>.js`, exporting exactly:

```js
export const sources = ['server/services/foo.js', ...];   // provenance, for review

/** ONLY `CREATE TABLE IF NOT EXISTS ...` statements, verbatim. */
export function tables(db) { db.exec(`...`); }

/** Guarded column additions, verbatim guards translated to plain JS. */
export function alters(db) {
  const cols = db.prepare('PRAGMA table_info(foo)').all().map(c => c.name);
  if (!cols.includes('bar')) db.exec('ALTER TABLE foo ADD COLUMN bar TEXT');
}

/** `CREATE INDEX IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS`, verbatim. */
export function indexesAndTriggers(db) { db.exec(`...`); }

/** Default rows that lived inside DDL blocks (`INSERT OR IGNORE ...`), verbatim. */
export function seeds(db) { db.exec(`...`); }
```

Export every function even if empty. The assembler runs **all fragments' `tables`
first, then all `alters`, then all `indexesAndTriggers`, then all `seeds`** — so a
trigger in one fragment may reference a table from another, and an index may
depend on a column an `alters` step added. Within a phase, keep each source
file's statements in their original order.

Rules that keep this a faithful move rather than a rewrite:

- Copy SQL **verbatim** — same column order, same defaults, same constraint
  text. The correctness proof is `scripts/schema-snapshot.mjs`: a fresh
  database built from these fragments must match, byte for byte after
  whitespace normalization, one built the old way.
- A statement that lacked `IF NOT EXISTS` (typically inside a lazily-called
  `ensure*()` function) gets it added, and the manifest records that it did.
- A dynamic column name (e.g. `prop-feeds.js`'s helper that adds whichever
  column a caller asks for) is reproduced as the concrete columns it is
  actually called with, each guarded; note each in the manifest.
- Statements that already use `db/index.js`'s `migrate(name, fn)` keep their
  recorded name — reproduce the DDL under the same guard semantics.
- Never touch the source files in this phase. Removal is a separate, later
  step, done only after the snapshot proof passes.

Each batch also writes `<batch>.manifest.json`:

```json
{ "server/services/foo.js": {
    "tables": ["foo", "foo_history"], "indexes": ["idx_foo_at"], "triggers": [],
    "alters": ["foo.bar"], "seeds": ["foo defaults"],
    "lines": [[12, 48], [301, 309]],
    "notes": ["added IF NOT EXISTS to CREATE TABLE foo_history (was inside ensureFoo())"] } }
```

`lines` are the source ranges the DDL was lifted from, so removal can be checked
against them later.
