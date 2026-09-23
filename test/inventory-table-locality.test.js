/**
 * "No local row count" has two causes and they mean opposite things.
 *
 * This container's dev database is a migrated shell holding 218 of the 327
 * tables the map knows. Fifty tables that a live surface reads are absent from
 * it, and every one of them was getting the same sentence: "no local DB row
 * count available". That is true and useless — it says what the generator
 * could not read, not why, so a reader cannot tell which absences are an
 * artefact of this container and which are a property of the code.
 *
 * Split by creation bucket, the fifty are 48 created by a migration and 2
 * created at module import. Those are not the same fact:
 *
 *   migration  — the shell is simply behind. Says nothing about production,
 *                where the migration has run. Unverifiable here, full stop.
 *   import     — no migration creates it at all. It comes into existence as a
 *                side effect of importing the module that owns it, so it is
 *                absent in any database where that import has not happened.
 *                That is a fact about the code and it survives this container.
 *
 * The two import-created ones are manager_archetypes and manager_archetype_jev
 * (server/services/manager-archetypes.js:74 and :86). Not a phantom — the
 * creator is production code, not a test fixture or a hand-run script — and
 * their cross-module reader guards with tableExists at manager-signals.js:272.
 * Recorded rather than escalated for exactly that reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildRows } = await import('../scripts/inventory.mjs');

const LOCAL_EMPTY = { readable: true, dbPath: '/dev/null', tables: 0, nonEmpty: 0, counts: new Map() };

const mapWith = (table) => ({
  generated_at: '2026-09-22T00:00:00Z',
  modules: [], surfaces: [], findings: [],
  tables: [{ read_by: ['server/routes/teams.js'], wiring: { route_families: ['GET /api/teams'], jobs: [], scripts: [], pages: [] }, ...table }],
});
const rowFor = (table) => buildRows(mapWith(table), LOCAL_EMPTY).find((r) => r.kind === 'table');

test('a migration-created table missing from this shell says the shell is behind', () => {
  const row = rowFor({ table: 'zz_fixture_migrated', created_by: 'migration',
    created_at_site: 'server/migrations/061_x.js:4' });
  assert.equal(row.status, 'unclassified');
  assert.match(row.reason, /migration/);
  // The point of the sentence: this is about the container, not about production.
  assert.match(row.reason, /not evidence that it is absent in production/);
});

test('an import-created table missing from this shell says no migration creates it', () => {
  const row = rowFor({ table: 'zz_fixture_lazy', created_by: 'import',
    created_at_site: 'server/services/zz-fixture-owner.js:74' });
  assert.equal(row.status, 'unclassified');
  assert.match(row.reason, /no migration creates it/);
  assert.match(row.reason, /server\/services\/zz-fixture-owner\.js:74/);
  // And it must NOT claim production is fine, which is the migration wording.
  assert.doesNotMatch(row.reason, /not evidence that it is absent in production/);
});

test('the two sentences are actually different', () => {
  const a = rowFor({ table: 'zz_fixture_a', created_by: 'migration', created_at_site: 'server/migrations/061_x.js:4' });
  const b = rowFor({ table: 'zz_fixture_b', created_by: 'import', created_at_site: 'server/services/zz-fixture-owner.js:74' });
  assert.notEqual(a.reason.replace(/zz_fixture_a/g, 'T'), b.reason.replace(/zz_fixture_b/g, 'T'));
});
