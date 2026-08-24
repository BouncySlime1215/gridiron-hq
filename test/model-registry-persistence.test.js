import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-registry-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, row, run } = await import('../server/db/index.js');
const { runMigrations, rollbackMigration } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { ModelRegistry } = await import('../server/modeling/registry.js');
const { SqliteModelStore, recordModelAudit, registrySnapshot } = await import('../server/modeling/sqlite-store.js');
const { requireModelPermission } = await import('../server/modeling/authz.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
await runMigrations();

const trainer = { id: 'trainer-1', permissions: ['model:train', 'model:promote'] };
const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };

test('spoofed role headers cannot authenticate model mutations', () => {
  const middleware = requireModelPermission('model:promote');
  let status = null, payload = null, advanced = false;
  middleware({ headers: { 'x-gridiron-role': 'admin' }, get: () => 'admin' }, {
    status(code) { status = code; return this; }, json(body) { payload = body; }
  }, () => { advanced = true; });
  assert.equal(status, 401);
  assert.match(payload.error, /authentication/);
  assert.equal(advanced, false);
});

test('authenticated principals still need the requested model permission', () => {
  const middleware = requireModelPermission('model:promote');
  let status = null, advanced = false;
  middleware({ principal: { id: 'member', permissions: ['model:train'] } }, {
    status(code) { status = code; return this; }, json() {}
  }, () => { advanced = true; });
  assert.equal(status, 403);
  assert.equal(advanced, false);
});

test('fresh install applies model registry migration and enforces foreign keys and constraints', () => {
  assert.ok(row(`SELECT name FROM schema_migrations WHERE name='005_model_registry_integrity'`));
  assert.equal(row('PRAGMA foreign_keys').foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => run(`INSERT INTO model_metrics
    (experiment_id,split,metric,value,sample_size,recorded_at) VALUES ('missing','validation','mae',1,-1,'now')`));
});

test('registry persists across store reconstruction and blocks failed promotion gates', () => {
  const first = new ModelRegistry(new SqliteModelStore(db));
  const blocked = first.create({ model: 'blocked', nonce: 1 }, trainer);
  first.transition(blocked.id, 'completed', { result: { gates: { ...gates, leakage: false } } });
  assert.throws(() => first.promote(blocked.id, trainer), /leakage gate failed/);

  const eligible = first.create({ model: 'eligible', nonce: 2 }, trainer);
  first.transition(eligible.id, 'completed', { result: { gates } });
  first.promote(eligible.id, trainer);
  const restarted = new SqliteModelStore(db);
  assert.equal(restarted.get(eligible.id).status, 'completed');
  assert.equal(restarted.production().experiment_id, eligible.id);
  assert.equal(row('SELECT COUNT(*) n FROM model_promotion_history').n, 1);
});

test('rollback is gated, persisted, and audit entries require authenticated actors', () => {
  const registry = new ModelRegistry(new SqliteModelStore(db));
  const older = registry.create({ model: 'older', nonce: 3 }, trainer);
  registry.transition(older.id, 'completed', { result: { gates } });
  registry.rollback(older.id, trainer);
  assert.equal(new SqliteModelStore(db).production().experiment_id, older.id);
  assert.equal(row(`SELECT action FROM model_promotion_history ORDER BY id DESC LIMIT 1`).action, 'rollback');
  assert.throws(() => recordModelAudit(db, null, 'x', 'experiment'));
  recordModelAudit(db, trainer, 'experiment.test', 'experiment', older.id);
  assert.equal(registrySnapshot(db).audit_log[0].actor_id, trainer.id);
});

test('partial seed reconciliation is transactional and independently idempotent', () => {
  seedIfEmpty();
  const before = row('SELECT COUNT(*) n FROM players').n;
  const defense = row(`SELECT id FROM players WHERE position='DEF' ORDER BY id LIMIT 1`);
  run('DELETE FROM players WHERE id=?', defense.id);
  run(`UPDATE nfl_teams SET name='corrupt' WHERE abbr='ARI'`);
  seedIfEmpty();
  assert.equal(row(`SELECT name FROM nfl_teams WHERE abbr='ARI'`).name, 'Arizona Cardinals');
  assert.equal(row(`SELECT COUNT(*) n FROM players WHERE position='DEF'`).n, 32);
  seedIfEmpty();
  assert.equal(row('SELECT COUNT(*) n FROM players').n, before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('latest migration down and re-up are transactional and reproducible', async () => {
  assert.equal(await rollbackMigration('005_model_registry_integrity'), '005_model_registry_integrity');
  assert.equal(row(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='model_dataset_versions'`).n, 0);
  assert.deepEqual(await runMigrations(), ['005_model_registry_integrity']);
  assert.ok(row(`SELECT name FROM schema_migrations WHERE name='005_model_registry_integrity'`));
});
