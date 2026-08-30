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
delete process.env.ODDS_API_KEY;
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

const trainer = { id: trainerUserId, permissions: ['model:train', 'model:promote'] };
const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
const { default: modelRouter } = await import('../server/routes/model.js');
const { default: nflBettingRouter } = await import('../server/routes/nfl-betting.js');
const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use('/api/nfl/betting', nflBettingRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
async function request(url, { token, roleHeader, body, method = 'POST' } = {}) {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const headers = { ...(encoded ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) } : {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (roleHeader) headers['x-gridiron-role'] = roleHeader;
  const req = new Readable({ read() { this.push(encoded || null); if (encoded) this.push(null); } });
  req.url = `/api/model${url}`; req.method = method; req.headers = headers;
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null }); };
    app.handle(req, res, reject);
  });
}
async function nflRequest(url, { token, roleHeader, body, method = 'POST' } = {}) {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const headers = { ...(encoded ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) } : {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (roleHeader) headers['x-gridiron-role'] = roleHeader;
  const req = new Readable({ read() { this.push(encoded || null); if (encoded) this.push(null); } });
  req.url = `/api/nfl/betting${url}`; req.method = method; req.headers = headers; req.socket = new PassThrough(); req.connection = req.socket;
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

test('registry snapshot requires an authenticated persisted grant', async () => {
  assert.equal((await request('/registry', { method: 'GET' })).status, 401);
  assert.equal((await request('/registry', { method: 'GET', roleHeader: 'admin' })).status, 401);
  assert.equal((await request('/registry', { method: 'GET', token: 'real-model-token' })).status, 200);
});

test('projection HTTP route rejects missing and unresolved active league context', async () => {
  const missing = await request('/projections', { method: 'GET', token: 'real-model-token' });
  assert.equal(missing.status, 400);
  assert.match(missing.payload.error, /active league is required/);

  const unresolved = await request('/projections?league_id=2147483647', { method: 'GET', token: 'real-model-token' });
  assert.equal(unresolved.status, 404);
  assert.match(unresolved.payload.error, /no league found for the active league id/);
});

test('NFL operational mutations require execute rather than training permission', async () => {
  run(`INSERT INTO users (subject) VALUES ('model:executor')`);
  const executorId = row(`SELECT id FROM users WHERE subject='model:executor'`).id;
  run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`, executorId, hashSessionToken('execute-token'));
  run(`INSERT INTO model_permissions (user_id,permission) VALUES (?, 'model:execute')`, executorId);
  assert.equal((await nflRequest('/ai-replay', { roleHeader: 'admin' })).status, 401);
  assert.equal((await nflRequest('/ai-replay', { token: 'real-model-token' })).status, 403);
  assert.equal((await nflRequest('/bets', { token: 'real-model-token' })).status, 403);
  assert.notEqual((await nflRequest('/ai-replay', { token: 'execute-token' })).status, 403);
  assert.notEqual((await nflRequest('/bets', { token: 'execute-token' })).status, 403);
  assert.equal((await nflRequest('/replay/train', { token: 'execute-token' })).status, 403);
});

test('NFL training analysis GET requires a persisted training or wildcard grant', async () => {
  assert.equal((await nflRequest('/replay/train', { method: 'GET' })).status, 401);
  assert.equal((await nflRequest('/replay/train', { method: 'GET', token: 'execute-token' })).status, 403);
  assert.notEqual((await nflRequest('/replay/train', { method: 'GET', token: 'real-model-token' })).status, 401);
  assert.notEqual((await nflRequest('/replay/train', { method: 'GET', token: 'real-model-token' })).status, 403);
});

test('model wildcard grant works at middleware and registry service layers', () => {
  const wildcard = { id: trainerUserId, permissions: ['model:*'] };
  const registry = new ModelRegistry(new SqliteModelStore(db));
  const experiment = registry.create({ model: 'wildcard', nonce: 100 }, wildcard);
  registry.transition(experiment.id, 'completed', { result: { gates } });
  assert.equal(registry.promote(experiment.id, wildcard).active, experiment.id);
  const cancellable = registry.create({ model: 'wildcard-cancel', nonce: 101 }, wildcard);
  assert.equal(registry.cancel(cancellable.id, wildcard).cancellation_requested, true);
  assert.throws(() => registry.cancel(experiment.id, trainer), /model:cancel required/);
});

test('persisted wildcard grant authorizes exact HTTP permissions', async () => {
  run(`INSERT INTO users (subject) VALUES ('model:wildcard')`);
  const wildcardId = row(`SELECT id FROM users WHERE subject='model:wildcard'`).id;
  run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`, wildcardId, hashSessionToken('wildcard-token'));
  run(`INSERT INTO model_permissions (user_id,permission) VALUES (?, 'model:*')`, wildcardId);
  for (const permission of ['model:train', 'model:promote', 'model:execute', 'model:cancel']) {
    let advanced = false;
    requireModelPermission(permission)({ get: name => name === 'authorization' ? 'Bearer wildcard-token' : null }, {
      status() { return this; }, json() {}
    }, () => { advanced = true; });
    assert.equal(advanced, true, permission);
  }
  assert.notEqual((await nflRequest('/replay/train', { method: 'GET', token: 'wildcard-token' })).status, 401);
  assert.notEqual((await nflRequest('/replay/train', { method: 'GET', token: 'wildcard-token' })).status, 403);
});

test('NFL resource-spending GET routes require execute or wildcard permission', async () => {
  assert.notEqual((await nflRequest('/props', { method: 'GET' })).status, 401);

  const spendingRoutes = [
    '/props?market=1',
    '/lines/shop',
    '/lines/disagreement',
    '/sharp/board',
    '/sharp/divergence'
  ];
  for (const url of spendingRoutes) {
    assert.equal((await nflRequest(url, { method: 'GET' })).status, 401, url);
    assert.equal((await nflRequest(url, { method: 'GET', token: 'real-model-token' })).status, 403, url);
  }

  for (const token of ['execute-token', 'wildcard-token']) {
    const response = await nflRequest('/props?market=1', { method: 'GET', token });
    assert.notEqual(response.status, 401, token);
    assert.notEqual(response.status, 403, token);
  }
});

test('server-run backtest persists verified metrics and gates promotion', async () => {
  // A single position/player so volume_efficiency's shrinkage reduces to the
  // plain observed rate (no other bucket to shrink toward) — makes the
  // candidate's edge over the real mean_baseline candidate easy to verify by hand.
  const observations = [
    { player_id: 'p1', season: 2023, week: 1, as_of: '2023-09-01T00:00:00.000Z', outcome_available_at: '2023-09-02T00:00:00.000Z',
      outcome: 20, features: { position: 'WR', expected_opportunities: 10 } },
    { player_id: 'p1', season: 2024, week: 1, as_of: '2024-09-01T00:00:00.000Z', outcome_available_at: '2024-09-02T00:00:00.000Z',
      outcome: 33, features: { position: 'WR', expected_opportunities: 15 } },
    { player_id: 'p1', season: 2025, week: 1, as_of: '2025-09-01T00:00:00.000Z', outcome_available_at: '2025-09-02T00:00:00.000Z',
      outcome: 40, features: { position: 'WR', expected_opportunities: 20 } }
  ];
  const datasetResponse = await request('/registry/datasets', { token: 'real-model-token', body: {
    name: 'verified-observations', content_hash: configurationHash(observations), cutoff_at: '2025-09-03T00:00:00.000Z',
    row_count: observations.length, metadata: { observations }
  } });
  assert.equal(datasetResponse.status, 201);
  const dataset = datasetResponse.payload;
  const contract = { name: 'single-position-volume-shape', features: { position: { required: true, type: 'string' }, expected_opportunities: { required: true, type: 'number', minimum: 0 } } };
  const featureResponse = await request('/registry/features', { token: 'real-model-token', body: {
    name: 'volume-shape', version: '1', content_hash: configurationHash(contract), contract
  } });
  assert.equal(featureResponse.status, 201);
  const feature = featureResponse.payload;
  const experimentResponse = await request('/registry/experiments', { token: 'real-model-token', body: {
    dataset_version_id: dataset.id, feature_version_id: feature.id,
    spec: { candidate: 'volume_efficiency', holdout_season: 2025, min_validation_rows: 1 }
  } });
  assert.equal(experimentResponse.status, 201);
  const experiment = experimentResponse.payload;
  const backtestResponse = await request(`/registry/experiments/${experiment.id}/backtests`, { token: 'real-model-token', body: { status: 'completed', result: { gates } } });
  assert.equal(backtestResponse.status, 201, JSON.stringify(backtestResponse.payload));
  const backtest = backtestResponse.payload;
  assert.equal(backtest.result.verified_by, 'server:walk-forward:v1');
  // volume_efficiency: trained on 2023 (10 opportunities -> outcome 20, rate 2/opp),
  // predicts 2024's 15 opportunities as 30; actual is 33 -> |30-33| = 3.
  assert.equal(backtest.result.mae, 3);
  // mean_baseline: trained on 2023 only, predicts the flat mean (20) for 2024;
  // actual is 33 -> |20-33| = 13. This is a real registered model run through the
  // same splits, not a "predict zero" strawman.
  assert.equal(backtest.result.baseline_mae, 13);
  assert.equal(backtest.result.dataset_content_hash, dataset.content_hash);
  assert.equal(backtest.result.feature_content_hash, feature.content_hash);
  const persistedResult = JSON.parse(row('SELECT result_json FROM model_backtests WHERE id=?', backtest.id).result_json);
  assert.equal(persistedResult.dataset_content_hash, dataset.content_hash);
  assert.equal(persistedResult.feature_content_hash, feature.content_hash);
  assert.equal(row('SELECT value FROM model_metrics WHERE backtest_id=? AND metric=?', backtest.id, 'mae').value, 3);

  // Promotion requires the sealed final-season holdout to have been opened and
  // evaluated first — a walk-forward pass alone (which never touches 2025) isn't
  // blind evidence that the model works on genuinely unseen data.
  const blocked = await request(`/registry/experiments/${experiment.id}/promote`, { token: 'real-model-token' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.payload.error, /sealed/);

  const holdout = await request(`/registry/experiments/${experiment.id}/holdout`, { token: 'real-model-token' });
  assert.equal(holdout.status, 201, JSON.stringify(holdout.payload));
  assert.equal(holdout.payload.protocol, 'sealed_holdout');
  assert.equal(holdout.payload.result.season, 2025);
  assert.equal(row('SELECT value FROM model_metrics WHERE backtest_id=? AND metric=?', holdout.payload.id, 'mae').value, holdout.payload.result.mae);

  const reopened = await request(`/registry/experiments/${experiment.id}/holdout`, { token: 'real-model-token' });
  assert.equal(reopened.status, 409);

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

test('registry/candidates lists mean_baseline and volume_efficiency and marks weather unavailable', async () => {
  const res = await request('/registry/candidates', { method: 'GET', token: 'real-model-token' });
  assert.equal(res.status, 200);
  const names = res.payload.candidates.map(c => c.name);
  assert.ok(names.includes('mean_baseline'));
  assert.ok(names.includes('volume_efficiency'));
  assert.equal(res.payload.feature_contract.features.weather.available, false);
  assert.equal(res.payload.feature_contract.features.weather.status, 'unavailable');
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
  for (const [table, column] of [['model_experiments', 'created_by_user_id'], ['model_dataset_versions', 'created_by_user_id'],
    ['model_feature_versions', 'created_by_user_id'], ['model_promotion_history', 'actor_user_id'], ['model_audit_log', 'actor_user_id']]) {
    assert.ok(db.prepare(`PRAGMA foreign_key_list(${table})`).all().some(fk => fk.from === column && fk.table === 'users'));
  }
  assert.throws(() => run(`INSERT INTO model_audit_log
    (actor_id,actor_user_id,action,entity_type,details_json,created_at) VALUES ('missing',999999,'x','x','{}','now')`), /persisted user|FOREIGN KEY/);
  assert.throws(() => run(`INSERT INTO model_audit_log
    (actor_id,actor_user_id,action,entity_type,details_json,created_at) VALUES ('missing',NULL,'x','x','{}','now')`), /persisted user/);
  assert.throws(() => run(`INSERT INTO model_dataset_versions
    (id,name,content_hash,row_count,cutoff_at,created_at,created_by,created_by_user_id)
    VALUES ('missing-actor','x','missing-actor',0,'now','now','missing',NULL)`), /persisted user/);
  const unpromoted = new ModelRegistry(new SqliteModelStore(db)).create({ model: 'promoter-guard', nonce: 102 }, trainer);
  assert.throws(() => run(`UPDATE model_experiments SET promoted_at='now', promoted_by='missing', promoted_by_user_id=NULL WHERE id=?`, unpromoted.id), /persisted user/);
  assert.throws(() => run(`INSERT INTO model_experiments
    (id,spec_json,status,created_at,updated_at,promoted_at,promoted_by,created_by_user_id,promoted_by_user_id)
    VALUES ('missing-promoter','{}','completed','now','now','now','missing',?,NULL)`, trainerUserId), /persisted user/);
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
  assert.equal(registrySnapshot(db).audit_log[0].actor_user_id, trainer.id);
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

test('volume_efficiency candidate is position-aware and beats the frozen baseline on separable data', async () => {
  // Large, realistic opportunity counts so shrinkage weight (n) dominates the
  // prior-strength constant (40) and the per-position rate is barely pulled
  // toward the league blend — otherwise a real historical-mean baseline (which
  // predicts the flat average of these two widely separated positions) can
  // out-score a heavily-shrunk position model on a single training fold.
  const rowsForSeason = (season, wr, rb) => ([
    { player_id: 'wr1', season, week: 1, as_of: `${season}-09-01T00:00:00.000Z`,
      outcome_available_at: `${season}-09-02T00:00:00.000Z`, outcome: wr,
      features: { position: 'WR', expected_opportunities: 200 } },
    { player_id: 'rb1', season, week: 1, as_of: `${season}-09-01T00:00:00.000Z`,
      outcome_available_at: `${season}-09-02T00:00:00.000Z`, outcome: rb,
      features: { position: 'RB', expected_opportunities: 200 } }
  ]);
  const observations = [
    ...rowsForSeason(2023, 40, 100), // training fold
    ...rowsForSeason(2024, 42, 95), // evaluated fold
    ...rowsForSeason(2025, 44, 90) // sealed holdout, unused by this backtest
  ];
  const dataset = await request('/registry/datasets', { token: 'real-model-token', body: {
    name: 'volume-efficiency-observations', content_hash: configurationHash(observations), cutoff_at: '2025-09-03T00:00:00.000Z',
    row_count: observations.length, metadata: { observations }
  } });
  assert.equal(dataset.status, 201);
  const contract = { features: { position: { required: true, type: 'string' }, expected_opportunities: { required: true, type: 'number', minimum: 0 } } };
  const feature = await request('/registry/features', { token: 'real-model-token', body: {
    name: 'volume-efficiency-inputs', version: '1', content_hash: configurationHash(contract), contract
  } });
  assert.equal(feature.status, 201);
  const experiment = await request('/registry/experiments', { token: 'real-model-token', body: {
    dataset_version_id: dataset.payload.id, feature_version_id: feature.payload.id,
    spec: { candidate: 'volume_efficiency', holdout_season: 2025, min_validation_rows: 1, nonce: 'separable-two-position' }
  } });
  assert.equal(experiment.status, 201);
  const backtest = await request(`/registry/experiments/${experiment.payload.id}/backtests`, { token: 'real-model-token' });
  assert.equal(backtest.status, 201, JSON.stringify(backtest.payload));
  assert.equal(backtest.payload.result.gates.schema, true);
  assert.equal(backtest.payload.result.gates.leakage, true);
  // A position-aware model should out-predict the real mean_baseline candidate
  // (run through the identical splits) on data where WR and RB efficiency are
  // cleanly separable by opportunity volume.
  assert.equal(backtest.payload.result.mae, 1.5);
  assert.equal(backtest.payload.result.baseline_mae, 26.5);
  assert.ok(backtest.payload.result.mae < backtest.payload.result.baseline_mae);
});

test('unsupported candidate name is rejected and lists what is actually supported', async () => {
  const observations = [2023, 2024].map((season, index) => ({
    player_id: 'p1', season, week: 1, as_of: `${season}-09-01T00:00:00.000Z`,
    outcome_available_at: `${season}-09-02T00:00:00.000Z`, outcome: index + 1, features: {}
  }));
  const dataset = await request('/registry/datasets', { token: 'real-model-token', body: {
    name: 'unsupported-candidate-observations', content_hash: configurationHash(observations), cutoff_at: '2024-09-03T00:00:00.000Z',
    row_count: observations.length, metadata: { observations }
  } });
  // content_hash has its own UNIQUE constraint independent of id — an empty contract
  // {} was already registered by an earlier test, so this needs a distinct contract.
  const contract = { features: { nonce: { type: 'string', required: false } } };
  const feature = await request('/registry/features', { token: 'real-model-token', body: {
    name: 'empty-2', version: '1', content_hash: configurationHash(contract), contract
  } });
  const experiment = await request('/registry/experiments', { token: 'real-model-token', body: {
    dataset_version_id: dataset.payload.id, feature_version_id: feature.payload.id,
    spec: { candidate: 'not_a_real_model', holdout_season: 2024, min_validation_rows: 1 }
  } });
  const backtest = await request(`/registry/experiments/${experiment.payload.id}/backtests`, { token: 'real-model-token' });
  assert.equal(backtest.status, 400);
  assert.match(backtest.payload.error, /mean_baseline/);
  assert.match(backtest.payload.error, /volume_efficiency/);
});

test('latest migration down and re-up are transactional and reproducible', async () => {
  assert.equal(await rollbackMigration('015_manager_profiles'), '015_manager_profiles');
  assert.equal(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='manager_profiles'`), undefined);
  assert.equal(await rollbackMigration('014_profit_execution_triggers'), '014_profit_execution_triggers');
  assert.equal(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='nfl_capture_triggers'`), undefined);
  assert.equal(await rollbackMigration('013_news_read_path_indexes'), '013_news_read_path_indexes');
  assert.equal(row(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_news_items_published_priority'`), undefined);
  assert.equal(await rollbackMigration('012_teaser_execution_ledger'), '012_teaser_execution_ledger');
  assert.equal(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='nfl_teaser_executions'`), undefined);
  assert.equal(await rollbackMigration('011_league_connection_integrity'), '011_league_connection_integrity');
  assert.equal(await rollbackMigration('010_news_provenance_and_dedup'), '010_news_provenance_and_dedup');
  assert.equal(row(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_news_items_duplicate_group'`), undefined);
  assert.ok(!db.prepare(`PRAGMA table_info(news_items)`).all().some(c => c.name === 'duplicate_group_id'));

  assert.equal(await rollbackMigration('009_authoritative_actor_and_ownership_guards'), '009_authoritative_actor_and_ownership_guards');
  for (const trigger of ['model_experiments_promoter_required_insert', 'model_experiments_promoter_required_update',
    'validate_draft_team_owner_update', 'validate_draft_ownership_parent_update']) {
    assert.equal(row(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`, trigger), undefined, trigger);
  }
  assert.deepEqual(await runMigrations(), ['009_authoritative_actor_and_ownership_guards', '010_news_provenance_and_dedup', '011_league_connection_integrity', '012_teaser_execution_ledger', '013_news_read_path_indexes', '014_profit_execution_triggers', '015_manager_profiles']);
  for (const trigger of ['model_experiments_promoter_required_insert', 'model_experiments_promoter_required_update',
    'validate_draft_team_owner_update', 'validate_draft_ownership_parent_update']) {
    assert.equal(row(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`, trigger).name, trigger);
  }
  assert.ok(db.prepare(`PRAGMA table_info(news_items)`).all().some(c => c.name === 'duplicate_group_id'));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_news_items_duplicate_group'`));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_news_items_published_priority'`));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='nfl_capture_triggers'`));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='manager_profiles'`));

  assert.equal(await rollbackMigration('015_manager_profiles'), '015_manager_profiles');
  assert.equal(await rollbackMigration('014_profit_execution_triggers'), '014_profit_execution_triggers');
  assert.equal(await rollbackMigration('013_news_read_path_indexes'), '013_news_read_path_indexes');
  assert.equal(await rollbackMigration('012_teaser_execution_ledger'), '012_teaser_execution_ledger');
  assert.equal(await rollbackMigration('011_league_connection_integrity'), '011_league_connection_integrity');
  assert.equal(await rollbackMigration('010_news_provenance_and_dedup'), '010_news_provenance_and_dedup');
  assert.equal(await rollbackMigration('009_authoritative_actor_and_ownership_guards'), '009_authoritative_actor_and_ownership_guards');
  assert.equal(await rollbackMigration('008_model_actor_foreign_keys'), '008_model_actor_foreign_keys');
  assert.equal(await rollbackMigration('007_model_permissions_and_upgrade_guard'), '007_model_permissions_and_upgrade_guard');
  assert.equal(await rollbackMigration('006_identity_and_draft_authorization'), '006_identity_and_draft_authorization');
  assert.equal(await rollbackMigration('005_model_registry_integrity'), '005_model_registry_integrity');
  assert.equal(await rollbackMigration('004_model_lab'), '004_model_lab');
  assert.equal(await rollbackMigration('003_draft_state_machine'), '003_draft_state_machine');
  assert.equal(await rollbackMigration('002_platform_audit_log'), '002_platform_audit_log');
  assert.equal(await rollbackMigration('001_baseline_marker'), '001_baseline_marker');
  assert.equal(row(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='model_dataset_versions'`).n, 0);
  assert.deepEqual(await runMigrations(), ['001_baseline_marker', '002_platform_audit_log', '003_draft_state_machine', '004_model_lab', '005_model_registry_integrity', '006_identity_and_draft_authorization', '007_model_permissions_and_upgrade_guard', '008_model_actor_foreign_keys', '009_authoritative_actor_and_ownership_guards', '010_news_provenance_and_dedup', '011_league_connection_integrity', '012_teaser_execution_ledger', '013_news_read_path_indexes', '014_profit_execution_triggers', '015_manager_profiles']);
  assert.ok(row(`SELECT name FROM schema_migrations WHERE name='005_model_registry_integrity'`));
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('representative legacy provenance upgrade quarantines unmatched actors and enforces new writes', async () => {
  const upgradeDb = new (await import('node:sqlite')).DatabaseSync(':memory:');
  upgradeDb.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE leagues (id INTEGER PRIMARY KEY);
    CREATE TABLE drafts (id INTEGER PRIMARY KEY, team_count INTEGER, league_row_id INTEGER);`);
  for (const file of ['004_model_lab', '005_model_registry_integrity', '006_identity_and_draft_authorization',
    '007_model_permissions_and_upgrade_guard']) {
    const migration = await import(`../server/migrations/${file}.js`);
    migration.up(upgradeDb);
  }
  upgradeDb.exec(`INSERT INTO model_audit_log
    (actor_id,action,entity_type,details_json,created_at) VALUES ('legacy-subject','legacy','experiment','{}','now')`);
  (await import('../server/migrations/008_model_actor_foreign_keys.js')).up(upgradeDb);
  (await import('../server/migrations/009_authoritative_actor_and_ownership_guards.js')).up(upgradeDb);
  assert.equal(upgradeDb.prepare(`SELECT actor_value FROM model_actor_provenance_quarantine
    WHERE source_table='model_audit_log'`).get().actor_value, 'legacy-subject');
  assert.equal(upgradeDb.prepare(`SELECT actor_id FROM model_audit_log`).get().actor_id, 'legacy-subject');
  assert.throws(() => upgradeDb.prepare(`INSERT INTO model_audit_log
    (actor_id,actor_user_id,action,entity_type,details_json,created_at) VALUES ('new',NULL,'x','x','{}','now')`).run(), /persisted user/);
  assert.deepEqual(upgradeDb.prepare('PRAGMA foreign_key_check').all(), []);
  upgradeDb.close();
});
