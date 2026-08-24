import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-registry-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, row, run } = await import('../server/db/index.js');
const { runMigrations, rollbackMigration } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { ModelRegistry } = await import('../server/modeling/registry.js');
const { SqliteModelStore, recordModelAudit, registrySnapshot } = await import('../server/modeling/sqlite-store.js');
const { requireModelPermission } = await import('../server/modeling/authz.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { configurationHash } = await import('../server/modeling/contracts.js');

await runMigrations();

run(`INSERT INTO users (subject) VALUES ('model:trainer')`);
const trainerUserId = row(`SELECT id FROM users WHERE subject='model:trainer'`).id;
run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`, trainerUserId, hashSessionToken('real-model-token'));
run(`INSERT INTO model_permissions (user_id,permission) VALUES (?, 'model:train'), (?, 'model:promote')`, trainerUserId, trainerUserId);

const trainer = { id: 'trainer-1', permissions: ['model:train', 'model:promote'] };
const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
const { default: modelRouter } = await import('../server/routes/model.js');
const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
async function request(url, { token, roleHeader, body } = {}) {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const headers = { ...(encoded ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) } : {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (roleHeader) headers['x-gridiron-role'] = roleHeader;
  const req = new Readable({ read() { this.push(encoded || null); if (encoded) this.push(null); } });
  req.url = `/api/model${url}`; req.method = 'POST'; req.headers = headers;
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null }); };
    app.handle(req, res, reject);
  });
}
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('spoofed role headers cannot authenticate model mutations', () => {
  const middleware = requireModelPermission('model:promote');
  let status = null, payload = null, advanced = false;
  middleware({ headers: { 'x-gridiron-role': 'admin' }, get: name => name === 'authorization' ? null : 'admin' }, {
    status(code) { status = code; return this; }, json(body) { payload = body; }
  }, () => { advanced = true; });
  assert.equal(status, 401);
  assert.match(payload.error, /authentication/);
  assert.equal(advanced, false);
});

test('persisted bearer session with the requested grant is authorized', () => {
  const middleware = requireModelPermission('model:promote');
  let status = null, advanced = false;
  middleware({ get: name => name === 'authorization' ? 'Bearer real-model-token' : null }, {
    status(code) { status = code; return this; }, json() {}
  }, () => { advanced = true; });
  assert.equal(status, null);
  assert.equal(advanced, true);
});

test('deployed HTTP route rejects spoofing and caller-supplied experiment outcomes', async () => {
  const spoofed = await request('/registry/datasets', { roleHeader: 'admin', body: {} });
  assert.equal(spoofed.status, 401);
  const registry = new ModelRegistry(new SqliteModelStore(db));
  const experiment = registry.create({ model: 'http-result-block', nonce: 99 }, trainer);
  const fabricated = await request(`/registry/experiments/${experiment.id}/result`, { token: 'real-model-token', body: { result: { gates } } });
  assert.equal(fabricated.status, 410);
  assert.equal(new SqliteModelStore(db).get(experiment.id).status, 'queued');
});

test('server-run backtest persists verified metrics and gates promotion', async () => {
  const observations = [2023, 2024, 2025].map((season, index) => ({
    player_id: 'p1', season, week: 1, as_of: `${season}-09-01T00:00:00.000Z`,
    outcome_available_at: `${season}-09-02T00:00:00.000Z`, outcome: index + 1, features: {}
  }));
  const datasetResponse = await request('/registry/datasets', { token: 'real-model-token', body: {
    name: 'verified-observations', content_hash: configurationHash(observations), cutoff_at: '2025-09-03T00:00:00.000Z',
    row_count: observations.length, metadata: { observations }
  } });
  assert.equal(datasetResponse.status, 201);
  const dataset = datasetResponse.payload;
  const featureResponse = await request('/registry/features', { token: 'real-model-token', body: {
    name: 'empty', version: '1', content_hash: configurationHash({}), contract: {}
  } });
  assert.equal(featureResponse.status, 201);
  const feature = featureResponse.payload;
  const experimentResponse = await request('/registry/experiments', { token: 'real-model-token', body: {
    dataset_version_id: dataset.id, feature_version_id: feature.id,
    spec: { candidate: 'mean_baseline', holdout_season: 2025, baseline_mae: 999999, min_validation_rows: 1 }
  } });
  assert.equal(experimentResponse.status, 201);
  const experiment = experimentResponse.payload;
  const backtestResponse = await request(`/registry/experiments/${experiment.id}/backtests`, { token: 'real-model-token', body: { status: 'completed', result: { gates } } });
  assert.equal(backtestResponse.status, 201, JSON.stringify(backtestResponse.payload));
  const backtest = backtestResponse.payload;
  assert.equal(backtest.result.verified_by, 'server:walk-forward:v1');
  assert.equal(backtest.result.mae, 1);
  assert.equal(backtest.result.baseline_mae, 2);
  assert.equal(row('SELECT value FROM model_metrics WHERE backtest_id=? AND metric=?', backtest.id, 'mae').value, 1);
  const promoted = await request(`/registry/experiments/${experiment.id}/promote`, { token: 'real-model-token' });
  assert.equal(promoted.status, 200);
});

test('feature provenance, validation thresholds, and schema gates cannot be forged', async () => {
  const contract = { features: { usage: { required: true, type: 'number', minimum: 0, maximum: 1 } } };
  const forged = await request('/registry/features', { token: 'real-model-token', body: {
    name: 'forged', version: '1', content_hash: configurationHash({}), contract
  } });
  assert.equal(forged.status, 400);

  const observations = [2023, 2024, 2025].map((season, index) => ({
    player_id: 'schema-player', season, week: 1, as_of: `${season}-09-01T00:00:00.000Z`,
    outcome_available_at: `${season}-09-02T00:00:00.000Z`, outcome: index + 1,
    features: { usage: index === 0 ? 'banana' : 2 }
  }));
  const dataset = await request('/registry/datasets', { token: 'real-model-token', body: {
    name: 'schema-observations', content_hash: configurationHash(observations), cutoff_at: '2025-09-03T00:00:00.000Z',
    row_count: observations.length, metadata: { observations }
  } });
  const feature = await request('/registry/features', { token: 'real-model-token', body: {
    name: 'required-usage', version: '1', content_hash: configurationHash(contract), contract
  } });
  assert.equal(feature.status, 201);
  const invalidThreshold = await request('/registry/experiments', { token: 'real-model-token', body: {
    dataset_version_id: dataset.payload.id, feature_version_id: feature.payload.id,
    spec: { candidate: 'mean_baseline', holdout_season: 2025, min_validation_rows: 0, nonce: 'invalid-threshold' }
  } });
  assert.equal(invalidThreshold.status, 400);
  const experiment = await request('/registry/experiments', { token: 'real-model-token', body: {
    dataset_version_id: dataset.payload.id, feature_version_id: feature.payload.id,
    spec: { candidate: 'mean_baseline', holdout_season: 2025, min_validation_rows: 1, nonce: 'schema-gate' }
  } });
  const backtest = await request(`/registry/experiments/${experiment.payload.id}/backtests`, { token: 'real-model-token' });
  assert.equal(backtest.status, 201, JSON.stringify(backtest.payload));
  assert.equal(backtest.payload.result.gates.schema, false);
  const promotion = await request(`/registry/experiments/${experiment.payload.id}/promote`, { token: 'real-model-token' });
  assert.notEqual(promotion.status, 200);
});

test('persisted bearer session without a grant is forbidden', () => {
  run(`INSERT INTO users (subject) VALUES ('model:unprivileged')`);
  const userId = row(`SELECT id FROM users WHERE subject='model:unprivileged'`).id;
  run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`, userId, hashSessionToken('unprivileged-token'));
  let status = null;
  requireModelPermission('model:promote')({ get: n => n === 'authorization' ? 'Bearer unprivileged-token' : null }, {
    status(code) { status = code; return this; }, json() {}
  }, () => assert.fail('must not advance'));
  assert.equal(status, 403);
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
  assert.equal(row('SELECT COUNT(*) n FROM model_promotion_history WHERE experiment_id=?', eligible.id).n, 1);
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
  assert.equal(await rollbackMigration('007_model_permissions_and_upgrade_guard'), '007_model_permissions_and_upgrade_guard');
  assert.equal(await rollbackMigration('006_identity_and_draft_authorization'), '006_identity_and_draft_authorization');
  assert.equal(await rollbackMigration('005_model_registry_integrity'), '005_model_registry_integrity');
  assert.equal(row(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='model_dataset_versions'`).n, 0);
  assert.deepEqual(await runMigrations(), ['005_model_registry_integrity', '006_identity_and_draft_authorization', '007_model_permissions_and_upgrade_guard']);
  assert.ok(row(`SELECT name FROM schema_migrations WHERE name='005_model_registry_integrity'`));
});
