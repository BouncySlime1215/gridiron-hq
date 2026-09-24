/**
 * HEALTH-01b: fallback, never fake (ENGINE-SPECS.md HEALTH-01).
 *
 * Every served engine field names a stand-in: its declared fallbackField, else its own last
 * good row. The reader (engine/state.js#readServed) returns {value, health, fallback_used,
 * reason}; a failed or degraded field serves the stand-in, labelled, and a failed value is
 * never returned by the reader or the route, not even inside the reason.
 *
 * RED rows: a failed field -> the reader serves the fallback with fallback_used=true and a
 * reason; no page renders a failed value (a grep over client reads, plus the route itself).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-health-fb-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await (await import('../server/db/migrate.js')).runMigrations();
const registry = await import('../server/services/engine/registry.js');
const state = await import('../server/services/engine/state.js');
const { default: engineRouter } = await import('../server/routes/engine.js');
const express = (await import('express')).default;

const need = () => assert.equal(typeof state.readServed, 'function', 'engine/state.js#readServed does not exist');

// A probability field whose declared stand-in is the market's number, and one with no stand-in.
const W = registry.registerProducer({ name: 'producer-hfb', active: '1', versions: { 1: {} },
  fields: [
    { field: 'test.hfb_prob', valueType: 'prob', space: 'prob', entityTypes: ['player'], checks: ['prob_unit'],
      fallbackField: 'test.hfb_market' },
    { field: 'test.hfb_market', valueType: 'prob', space: 'prob', entityTypes: ['player'], checks: ['prob_unit'] },
    { field: 'test.hfb_solo', valueType: 'prob', space: 'prob', entityTypes: ['player'], checks: ['prob_unit'] },
  ],
});
const put = (field, entityId, value, asOf, extra = {}) => state.writeState({ entityType: 'player', entityId, field, value,
  asOf, writer: W[field], producerVersion: '1', eventIds: [], reasonChain: { contributions: [] }, ...extra });
const AT = { asOf: '2026-09-10T00:00:00Z' };
const FAILED = 1.37; // fails prob_unit: must never be served, and never appear in a reason

// 9101: good 0.3, then failed; the declared fallback has 0.42.
put('test.hfb_prob', '9101', 0.3, '2026-09-01T00:00:00Z');
put('test.hfb_market', '9101', 0.42, '2026-09-01T00:00:00Z');
put('test.hfb_prob', '9101', FAILED, '2026-09-02T00:00:00Z');
// 9102: no fallback field declared; good 0.25, then failed.
put('test.hfb_solo', '9102', 0.25, '2026-09-01T00:00:00Z');
put('test.hfb_solo', '9102', FAILED, '2026-09-02T00:00:00Z');
// 9103: only ever failed, no stand-in anywhere.
put('test.hfb_solo', '9103', FAILED, '2026-09-02T00:00:00Z');
// 9104: degraded, fallback present. 9105: degraded, nothing healthy.
put('test.hfb_market', '9104', 0.51, '2026-09-01T00:00:00Z');
put('test.hfb_prob', '9104', 0.6, '2026-09-02T00:00:00Z', { inputsHealth: 'degraded' });
put('test.hfb_solo', '9105', 0.6, '2026-09-02T00:00:00Z', { inputsHealth: 'degraded' });

test('RED (b1): a failed field serves its declared fallback, fallback_used=true, with the reason', () => {
  need();
  const s = state.readServed('player', '9101', 'test.hfb_prob', AT);
  assert.equal(s.status, 'fallback');
  assert.equal(s.value, 0.42);
  assert.equal(s.fallback_used, true);
  assert.equal(s.fallback.kind, 'field');
  assert.equal(s.fallback.field, 'test.hfb_market');
  assert.match(s.reason, /failed its checks \(prob_unit\)/);
  assert.match(s.reason, /test\.hfb_market/);
  assert.equal(s.health.status, 'failed', 'the health reported is the field\'s own: failed');
  assert.doesNotMatch(JSON.stringify(s), /1\.37/, 'the failed value leaked into the served read');
});

test('RED (b2): with no fallback field, a failed field serves its last good row, labelled', () => {
  need();
  const s = state.readServed('player', '9102', 'test.hfb_solo', AT);
  assert.equal(s.status, 'fallback');
  assert.equal(s.value, 0.25);
  assert.equal(s.fallback_used, true);
  assert.equal(s.fallback.kind, 'last_good');
  assert.match(s.reason, /last good row/);
});

test('RED (b3): a failed field with nothing healthy serves no value, never the failed one', () => {
  need();
  const s = state.readServed('player', '9103', 'test.hfb_solo', AT);
  assert.equal(s.status, 'failed');
  assert.equal(s.value, null);
  assert.equal(s.row, null);
  assert.equal(s.fallback_used, false);
  assert.match(s.reason, /failed its checks/);
  assert.doesNotMatch(s.reason, /1\.37/);
});

test('RED (b4): degraded serves the fallback when there is one, else the degraded value labelled', () => {
  need();
  const fb = state.readServed('player', '9104', 'test.hfb_prob', AT);
  assert.equal(fb.status, 'fallback'); assert.equal(fb.value, 0.51); assert.equal(fb.fallback_used, true);
  assert.match(fb.reason, /degraded inputs/);
  const deg = state.readServed('player', '9105', 'test.hfb_solo', AT);
  assert.equal(deg.status, 'degraded'); assert.equal(deg.value, 0.6); assert.equal(deg.fallback_used, false);
  assert.match(deg.reason, /degraded/);
  const ok = state.readServed('player', '9101', 'test.hfb_market', AT);
  assert.equal(ok.status, 'ok'); assert.equal(ok.fallback_used, false); assert.equal(ok.reason, null);
});

test('RED (b5): the route serves the fallback, labelled, and never the failed value', async () => {
  const app = express();
  app.use((req, _res, next) => { req.auth = { userId: 1 }; next(); });
  app.use('/api/engine', engineRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/engine/state`;
  const get = async q => (await fetch(`${base}?${q}&as_of=2026-09-10T00:00:00Z`)).text();
  try {
    const fbText = await get('entity=player:9101&field=test.hfb_prob');
    const fb = JSON.parse(fbText);
    assert.equal(fb.status, 'fallback', fbText);
    assert.equal(fb.fallback_used, true);
    assert.equal(fb.state.value, 0.42);
    assert.equal(fb.state.field, 'test.hfb_market');
    assert.match(fb.reason, /failed its checks/);
    const failedText = await get('entity=player:9103&field=test.hfb_solo');
    const failed = JSON.parse(failedText);
    assert.equal(failed.status, 'failed', failedText);
    assert.equal(failed.state, null);
    assert.equal(failed.fallback_used, false);
    const ok = JSON.parse(await get('entity=player:9101&field=test.hfb_market'));
    assert.equal(ok.status, 'ok'); assert.equal(ok.fallback_used, false);
    // The failed value is nowhere in what a page receives: not as the value, not in the reason.
    for (const text of [fbText, failedText]) {
      assert.doesNotMatch(text, /1\.37/, 'a page received the failed value');
    }
  } finally {
    server.close();
  }
});

test('RED (b6): no page renders a failed value: client engine reads go through the served route only', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(tsx?|jsx?)$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const clientFiles = walk(path.join(root, 'client', 'src'));
  for (const file of clientFiles) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/\/api\/engine\//.test(src)) continue;
    const rel = path.relative(root, file);
    assert.doesNotMatch(src, /includeFailed|include_failed/, `${rel} asks for failed rows`);
    assert.match(src, /fallback_used/, `${rel} reads engine values without reading fallback_used`);
  }
  // No server route reads engine_state around the served reader, and none asks for failed rows.
  const routes = fs.readdirSync(path.join(root, 'server', 'routes')).filter(f => f.endsWith('.js'));
  for (const f of routes) {
    const src = fs.readFileSync(path.join(root, 'server', 'routes', f), 'utf8');
    assert.doesNotMatch(src, /includeFailed\s*:\s*true/, `server/routes/${f} serves failed rows`);
    if (f !== 'engine.js') assert.doesNotMatch(src, /FROM\s+engine_state/i, `server/routes/${f} reads engine_state raw`);
  }
  assert.match(fs.readFileSync(path.join(root, 'server', 'routes', 'engine.js'), 'utf8'), /readServed\(/,
    'the engine route does not serve through readServed');
});
