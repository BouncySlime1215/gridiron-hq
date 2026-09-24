/**
 * The drift monitor and its fallback (ENGINE-SPECS.md "EA-05 monitor + fallback", run as
 * cloud unit EA-06; ENGINE-ARCHITECTURE.md §7.4; ENGINE-00b-b RED (2)-(5)).
 *
 * RED, in the row's order:
 *   (2) live worse than its fallback by a fixed amount flips at the first check where the
 *       cluster floor is met and the bound clears 0, and not before
 *   (3) the served value then equals the fallback's, and its reason chain names the monitor
 *   (4) live better than its fallback never flips
 *   (5) recovery takes a full fresh window
 *   (N) 20 weeks of checks under the null flip at most the budget (simulation)
 * plus this unit's own: per-field freshness, the last healthy snapshot when there is no
 * fallback row, a HEALTH-01 row in the Number health card's table (#237), failed rows.
 * Fixtures only: players 9401-9430, league 94. Tests share one database and run in order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-monitor-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const { db, run, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

async function optionalImport(specifier) {
  try { return await import(specifier); } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  }
}
const registry = await import('../server/services/engine/registry.js');
const { writeState } = await import('../server/services/engine/state.js');
const { makeContext } = await import('../server/services/engine/daemon/context.js');
const { publishSnapshot } = await import('../server/services/engine/daemon/snapshots.js');
const { recordRun } = await import('../server/services/engine/fields.js');
const producersMod = await import('../server/services/engine/producers/index.js');
const graderMod = await import('../server/services/engine/producers/grader.js');
const confseq = await optionalImport('../server/services/engine/stats/confseq.js');
const monitorMod = await optionalImport('../server/services/engine/producers/monitor.js');
// FIX-281-2: the served read is the one fallback reader, engine/views.js#readServed (#257/#250);
// served.js is folded into it and deleted.
const servedMod = await optionalImport('../server/services/engine/views.js');
const need = (mod, name) => assert.ok(mod, `${name} does not exist: the drift monitor is not built`);

/* ------------------------------------------------------------------ helpers */
const wk = (i, d, { n = 30, entities = 30, sd = 1 } = {}) => ({ key: `2026:${i}`, d, n, entities, sd });
const RULE = () => monitorMod.RULE;

/** Walk a feed one week at a time the way the nightly check sees it; returns each week's decision. */
function walk(feed, { alpha = 0.1, start = { status: 'ok' } } = {}) {
  const out = [];
  let state = start;
  for (let i = 1; i <= feed.length; i++) {
    const r = monitorMod.decideDrift({ weeks: feed.slice(0, i), prev: state, alpha });
    out.push(r);
    state = r.state;
  }
  return out;
}

/* ---------------------------------------------------------- the statistics */
test('N: 20 weekly checks under the null flip at most the budget (simulation)', () => {
  need(confseq, 'stats/confseq.js');
  const sim = confseq.simulateNull({ seasons: 2000, weeks: 20, alpha: 0.1, sd: 1, priorVar: 1, seed: 'ea06-null' });
  assert.equal(sim.seasons, 2000);
  assert.ok(sim.rate <= 0.1, `false-flip rate ${sim.rate} above alpha 0.1`);
  // the system budget: one expected false flip per season across every monitored field
  need(monitorMod, 'producers/monitor.js');
  for (const k of [1, 5, 10, 20, 40]) {
    const a = monitorMod.alphaFor(k);
    assert.ok(a > 0 && a <= RULE().alphaMax, `alpha ${a} for ${k} fields`);
    assert.ok(k * a <= RULE().flipsPerSeason + 1e-12, `${k} fields x alpha ${a} exceeds the budget`);
  }
});

test('N1: the whole rule under the null with week-to-week swings (clusters) stays within its alpha', () => {
  need(monitorMod, 'producers/monitor.js');
  // week effect sd 3/sqrt(30) on top of 30 players of sd 1: the within-week sd alone understates the weekly variance
  let a = 20260924;
  const u = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return (a + 0.5) / 4294967296; };
  const z = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  const alpha = monitorMod.alphaFor(20);
  let flips = 0;
  const seasons = 1000;
  for (let s = 0; s < seasons; s++) {
    const weeks = []; let state = { status: 'ok' };
    for (let w = 1; w <= 20; w++) {
      const b = (3 / Math.sqrt(30)) * z();
      const xs = Array.from({ length: 30 }, () => b + z());
      const m = xs.reduce((t, x) => t + x, 0) / 30;
      const sd = Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / 29);
      weeks.push({ key: `2026:${w}`, d: m, n: 30, entities: 30, sd });
      const r = monitorMod.decideDrift({ weeks, prev: state, alpha });
      state = r.state;
      if (r.flip === 'fallback') { flips += 1; break; }
    }
  }
  assert.ok(flips / seasons <= alpha, `null flip rate ${flips / seasons} above alpha ${alpha}`);
});

test('N2: the confidence sequence is two-sided, shrinks with n and is centred on the mean', () => {
  need(confseq, 'stats/confseq.js');
  const a = confseq.confidenceSequence([0.2, 0.4, 0.3, 0.1], { alpha: 0.1, priorVar: 0.04 });
  assert.equal(a.n, 4);
  assert.ok(Math.abs(a.mean - 0.25) < 1e-12);
  assert.ok(a.lower < a.mean && a.mean < a.upper);
  assert.ok(Math.abs((a.upper - a.mean) - (a.mean - a.lower)) < 1e-12);
  const b = confseq.confidenceSequence(Array.from({ length: 16 }, (_, i) => [0.2, 0.4, 0.3, 0.1][i % 4]),
    { alpha: 0.1, priorVar: 0.04 });
  assert.ok(b.upper - b.lower < a.upper - a.lower, 'more weeks, narrower sequence');
  // the closed form, by hand: predictable variances .04, .08/3, .1/4, .1/5; rho = 6 x .04
  const V = 0.04 + 0.08 / 3 + 0.1 / 4 + 0.1 / 5; const rho = 0.24;
  const radius = Math.sqrt((V + rho) * Math.log((V + rho) / (rho * 0.1 * 0.1))) / 4;
  assert.ok(Math.abs((a.upper - a.mean) - radius) < 1e-12, `radius ${a.upper - a.mean}, closed form ${radius}`);
  assert.throws(() => confseq.confidenceSequence([1], { alpha: 0, priorVar: 1 }), /alpha/);
  assert.throws(() => confseq.confidenceSequence([1], { alpha: 0.1, priorVar: 0 }), /priorVar/);
});

test('2: live worse by a fixed amount flips at the first check with the floor met and the bound above 0, not before', () => {
  need(monitorMod, 'producers/monitor.js');
  const feed = Array.from({ length: 10 }, (_, i) => wk(i + 1, 0.5, { sd: 0.3 }));
  const steps = walk(feed);
  const first = steps.findIndex(s => s.state.status === 'fallback');
  assert.ok(first >= 0, 'never flipped');
  assert.equal(first, RULE().floorWeeks - 1, 'flips at the first week the floor is met (week 4)');
  for (const s of steps.slice(0, first)) assert.equal(s.state.status, 'ok', 'no flip before the floor');
  assert.equal(steps[first].flip, 'fallback');
  assert.ok(steps[first].cs.lower > 0);
  for (const s of steps.slice(first + 1)) assert.equal(s.flip, null, 'one flip, not one per week');
  // the floor counts entities too: 5 weeks of 3 players are not 20 players
  const thin = walk(Array.from({ length: 5 }, (_, i) => wk(i + 1, 0.5, { sd: 0.3, n: 3, entities: 3 })));
  assert.ok(thin.every(s => s.state.status === 'ok'), 'flipped below the entity floor');
  // and a big effect that is still noisy waits for the bound
  const noisy = walk([wk(1, 0.5, { sd: 5 }), wk(2, -0.2, { sd: 5 }), wk(3, 0.9, { sd: 5 }), wk(4, 0.1, { sd: 5 })]);
  assert.ok(noisy.every(s => s.state.status === 'ok'));
  // tight weeks that disagree with each other: the cross-week spread is the variance, not the within-week sd
  const swing = walk([2, -1.5, 2.5, -1, 1.8, -1.2].map((d, i) => wk(i + 1, d, { sd: 0.3 })));
  assert.ok(swing.every(s => s.state.status === 'ok'), 'flipped on weeks that disagree');
});

test('4: live better than its fallback never flips', () => {
  need(monitorMod, 'producers/monitor.js');
  const steps = walk(Array.from({ length: 17 }, (_, i) => wk(i + 1, -0.4, { sd: 0.3 })));
  assert.ok(steps.every(s => s.state.status === 'ok' && s.flip === null));
});

test('5: recovery takes a full fresh window; the weeks before the flip do not count', () => {
  need(monitorMod, 'producers/monitor.js');
  const bad = Array.from({ length: 4 }, (_, i) => wk(i + 1, 0.5, { sd: 0.3 }));
  const flipped = walk(bad).at(-1);
  assert.equal(flipped.state.status, 'fallback');
  assert.equal(flipped.state.flipped_after, '2026:4');
  const good = [5, 6, 7, 8].map(i => wk(i, -0.5, { sd: 0.3 }));
  const steps = walk([...bad, ...good], { start: flipped.state }).slice(4);
  for (const s of steps.slice(0, 3)) assert.equal(s.state.status, 'fallback', '3 fresh weeks are not a window');
  assert.equal(steps[3].flip, 'recovered');
  assert.equal(steps[3].state.status, 'ok');
  assert.equal(steps[3].fresh.n, 4, 'only the weeks after the flip are the fresh window');
  // a fresh window that meets the floor but is not clearly better stays on the fallback
  const unclear = [5, 6, 7, 8, 9].map((i, j) => wk(i, [-0.3, 0.2, -0.4, 0.1, -0.2][j], { sd: 1 }));
  const held = walk([...bad, ...unclear], { start: flipped.state }).slice(4);
  assert.ok(held.every(s => s.state.status === 'fallback' && s.flip === null), 'recovered without the upper bound below 0');
});

test('G: the grader pairs each week against the fallback field (delta, entities, sd)', () => {
  assert.equal(typeof graderMod.pairedVsFallback, 'function', 'grader.pairedVsFallback does not exist');
  const mine = [
    { entity_id: '1:2026:3:aaaaaaaaaaaaaaaa', entity: '1', primary: 3 },
    { entity_id: '2:2026:3:aaaaaaaaaaaaaaaa', entity: '2', primary: 5 },
    { entity_id: '3:2026:3:aaaaaaaaaaaaaaaa', entity: '3', primary: 4 },
  ];
  const theirs = [
    { entity_id: '1:2026:3:aaaaaaaaaaaaaaaa', entity: '1', primary: 2 },
    { entity_id: '2:2026:3:aaaaaaaaaaaaaaaa', entity: '2', primary: 2 },
  ];
  const p = graderMod.pairedVsFallback(mine, theirs, 'x.base');
  assert.equal(p.field, 'x.base');
  assert.equal(p.n_pairs, 2);
  assert.equal(p.entities, 2);
  assert.equal(p.delta_mean, 2);
  assert.ok(Math.abs(p.delta_sd - Math.SQRT2) < 1e-6);
  // season to date: one player in two weeks is two pairs but one entity
  const w4 = k => k.replace(':3:', ':4:');
  const season = graderMod.pairedVsFallback([...mine, ...mine.map(i => ({ ...i, entity_id: w4(i.entity_id) }))],
    [...theirs, ...theirs.map(i => ({ ...i, entity_id: w4(i.entity_id) }))], 'x.base');
  assert.equal(season.n_pairs, 4);
  assert.equal(season.entities, 2);
});

test('G2: the grader writes the weekly vs_fallback the monitor reads (grade.week)', () => {
  graderMod.registerGraded('mtest.g2', { kind: 'dist' });
  graderMod.registerGraded('mtest.g2base', { kind: 'dist' });
  registry.registerProducer({ name: 'mtest-g2', active: 'g1', versions: { g1: {} }, inputs: { scope: 'global' },
    fields: [{ field: 'mtest.g2', valueType: 'dist', entityTypes: ['player_week_scored'], fallbackField: 'mtest.g2base', description: 'fixture' }] });
  registry.registerProducer({ name: 'mtest-g2base', active: 'h1', versions: { h1: {} }, inputs: { scope: 'global' },
    fields: [{ field: 'mtest.g2base', valueType: 'dist', entityTypes: ['player_week_scored'], description: 'fixture' }] });
  const key = pid => `${pid}:2026:3:cccccccccccccccc`;
  const q = m => ({ levels: [0.1, 0.5, 0.9], values: [m - 4, m, m + 4] });
  const pred = (field, producer, version, pid, m, id) => ({ id, entity_type: 'player_week_scored', entity_id: key(pid), league_id: 0,
    field, value: q(m), producer, producer_version: version, lane: 'live', as_of: '2026-09-12T00:00:00.000Z', written_at: '2026-09-12T00:00:00.000Z' });
  const versions = v => [{ version: v, status: 'active', registered_at: '2026-01-01T00:00:00.000Z', training_window: null }];
  const reads = {
    'mtest.g2': { producer: 'mtest-g2', versions: versions('g1'), rows: [9411, 9412, 9413].map((p, i) => pred('mtest.g2', 'mtest-g2', 'g1', p, 20, i + 1)) },
    'mtest.g2base': { producer: 'mtest-g2base', versions: versions('h1'), rows: [9411, 9412].map((p, i) => pred('mtest.g2base', 'mtest-g2base', 'h1', p, 10, i + 11)) },
  };
  const outcome = (pid, i) => ({ id: 500 + i, payload: { player_id: pid, season: 2026, week: 3, scoring_key: 'cccccccccccccccc',
    points: 10, kickoff: '2026-09-13T17:00:00.000Z' } });
  const writes = [];
  const ctx = { tick: { id: 't', as_of: '2026-09-15T00:00:00.000Z' },
    read: { graded: f => reads[f] ?? { producer: null, versions: [], rows: [] },
      events: () => [9411, 9412, 9413].map(outcome) },
    write: (_w, row) => { writes.push(row); return { written: true }; } };
  graderMod.graderProducer.run(ctx);
  const week = writes.find(w => w.field === 'grade.week' && w.entityId === 'mtest-g2@g1');
  assert.ok(week, 'no grade.week row for the live version');
  const vs = week.value.by_field['mtest.g2'].vs_fallback;
  assert.ok(vs, 'grade.week carries no vs_fallback');
  assert.equal(vs.field, 'mtest.g2base');
  assert.equal(vs.n_pairs, 2);
  assert.equal(vs.entities, 2);
  assert.ok(vs.delta_mean > 0, 'live (centred 20) is worse than the fallback (centred 10) on an outcome of 10');
});

/* ---------------------------------------------------------- on a database */
// The Number health card's table (#237, migration 077), created here as that migration does,
// so the monitor's HEALTH-01 rows are checked against the shape the card reads.
db.exec(`CREATE TABLE IF NOT EXISTS number_audit (
  league_id INTEGER NOT NULL, check_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'broken')),
  inventory_row TEXT, title TEXT NOT NULL, detail TEXT NOT NULL, cause TEXT, trust TEXT,
  pages_affected TEXT NOT NULL DEFAULT '[]', values_json TEXT NOT NULL DEFAULT '{}', as_of TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, check_id))`);

const SCORED = pid => `${pid}:2026:3:bbbbbbbbbbbbbbbb`;
const LIVE = registry.registerProducer({
  name: 'mtest', active: 'v1', versions: { v1: {} },
  fields: [{ field: 'mtest.range', valueType: 'dist', entityTypes: ['player_week_scored'], fallbackField: 'mtest.base',
    maxAgeSec: 3600, description: 'fixture: the live range' },
  { field: 'mtest.fresh', valueType: 'number', entityTypes: ['player'], maxAgeSec: 3600, description: 'fixture: freshness only' },
  { field: 'mtest.solo', valueType: 'dist', entityTypes: ['player_week_scored'], fallbackField: 'mtest.none',
    description: 'fixture: a fallback field with no rows' }],
  inputs: { scope: 'global' },
});
const BASE = registry.registerProducer({
  name: 'mtest-base', active: 'b1', versions: { b1: {} },
  fields: [{ field: 'mtest.base', valueType: 'dist', entityTypes: ['player_week_scored'], description: 'fixture: the baseline' },
    { field: 'mtest.none', valueType: 'dist', entityTypes: ['player_week_scored'], description: 'fixture: empty baseline' }],
  inputs: { scope: 'global' },
});
const chain = { contributions: [] };
const dist = m => ({ levels: [0.1, 0.5, 0.9], values: [m - 5, m, m + 5], mean: m });
const put = (writers, field, entityType, entityId, value, asOf, version) => writeState({ entityType, entityId, field, value,
  asOf, writer: writers[field], producerVersion: version, reasonChain: chain }, db);

run(`INSERT INTO engine_events (event_type, as_of, as_of_quality, ingested_at, provenance, league_id, source, natural_key,
  source_key, payload) VALUES ('source.coverage', '2026-09-01T00:00:00.000Z', 'exact', '2026-09-01T00:00:00.000Z', 'captured',
  94, 'fixture', 'k1', 'k1', '{}')`);

const T0 = '2026-09-20T12:00:00.000Z';
put(LIVE, 'mtest.range', 'player_week_scored', SCORED(9401), dist(12), '2026-09-20T11:00:00.000Z', 'v1');
put(BASE, 'mtest.base', 'player_week_scored', SCORED(9401), dist(10), '2026-09-20T11:00:00.000Z', 'b1');
put(LIVE, 'mtest.solo', 'player_week_scored', SCORED(9402), dist(7), '2026-09-20T11:00:00.000Z', 'v1');
put(LIVE, 'mtest.fresh', 'player', '9401', 1, '2026-09-20T11:30:00.000Z', 'v1');
recordRun({ producer: 'mtest', version: 'v1', startedAt: '2026-09-20T11:30:00.000Z', finishedAt: '2026-09-20T11:30:00.000Z' }, db);
const HEALTHY_SNAPSHOT = publishSnapshot({ leagueId: 0, versionSet: {}, now: T0 }, db);
// after the healthy snapshot the live producer keeps writing: these are what a fallback must NOT serve
put(LIVE, 'mtest.solo', 'player_week_scored', SCORED(9402), dist(40), '2026-09-20T12:30:00.000Z', 'v1');

const gradeRow = (weeks, field, fallbackField) => weeks.map((w, i) => ({
  id: 100000 + i, entity_id: 'mtest@v1',
  value: { season: 2026, week: Number(w.key.split(':')[1]),
    by_field: { [field]: { lane: 'live', vs_fallback: { field: fallbackField, n_pairs: w.n, entities: w.entities,
      delta_mean: w.d, delta_sd: w.sd } } } },
}));

/** One monitor run at `asOf`, the week's grade rows injected (they are the grader's rows in production). */
function monitorTick(asOf, gradeWeeks = []) {
  const entry = producersMod.producerEntry(monitorMod.monitorProducer);
  const cut = row('SELECT (SELECT MAX(id) FROM engine_events) AS event, (SELECT MAX(id) FROM engine_state) AS state');
  const made = makeContext({ database: db, producer: entry, version: entry.active, lane: 'live',
    tick: { id: `t-${asOf}`, as_of: asOf }, cut: { event: Number(cut.event ?? 0), state: Number(cut.state ?? 0) }, runId: null });
  return monitorMod.runMonitor(made.ctx, { gradeRows: gradeWeeks });
}
const monitorRow = field => {
  const r = row(`SELECT value FROM engine_state WHERE field = 'health.monitor' AND entity_type = 'engine_field'
    AND entity_id = ? ORDER BY id DESC LIMIT 1`, field);
  return r ? JSON.parse(r.value) : null;
};
const audit = (field, league = 94) => row('SELECT * FROM number_audit WHERE league_id = ? AND check_id = ?', league, `engine:${field}`);

test('M1: a healthy tick writes a monitor row per field and no fallback', () => {
  need(monitorMod, 'producers/monitor.js');
  monitorTick(T0);
  const m = monitorRow('mtest.range');
  assert.ok(m, 'no health.monitor row for mtest.range');
  assert.equal(m.status, 'ok');
  assert.equal(monitorRow('mtest.fresh').status, 'ok');
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_fallback`).n, 0);
});

test('3: on drift the served value is the fallback field, labelled, and its chain names the monitor; the card gets a HEALTH-01 row', () => {
  need(monitorMod, 'producers/monitor.js');
  need(servedMod, 'views.js');
  const weeks = Array.from({ length: 4 }, (_, i) => wk(i + 1, 0.5, { sd: 0.3 }));
  monitorTick('2026-09-20T12:20:00.000Z', gradeRow(weeks, 'mtest.range', 'mtest.base'));
  const m = monitorRow('mtest.range');
  assert.equal(m.status, 'fallback');
  assert.equal(m.fallback.target, 'field');
  assert.equal(m.fallback.field, 'mtest.base');
  const fb = row(`SELECT * FROM engine_fallback WHERE field = 'mtest.range'`);
  assert.ok(fb, 'no engine_fallback row');
  assert.equal(fb.fallback_field, 'mtest.base');
  const served = servedMod.readServed('player_week_scored', SCORED(9401), 'mtest.range',
    { asOf: '2026-09-20T12:25:00.000Z' }, db);
  assert.equal(served.fallback_used, true);
  assert.deepEqual(served.value, dist(10), 'serves the baseline value');
  assert.equal(served.fallback.kind, 'field');
  assert.ok(served.reason_chain.contributions.some(c => c.source === 'health_monitor' && /fell back/.test(c.text)));
  const a = audit('mtest.range');
  assert.ok(a, 'no Number health row for the league');
  assert.equal(a.status, 'broken');
  assert.equal(a.inventory_row, 'HEALTH-01');
  assert.match(a.detail, /mtest\.base/);
  assert.ok(JSON.parse(a.pages_affected).length >= 0);
});

test('S: a fallback field with no row for the entity serves the last healthy snapshot', () => {
  need(monitorMod, 'producers/monitor.js');
  const weeks = Array.from({ length: 4 }, (_, i) => wk(i + 1, 0.6, { sd: 0.3 }));
  monitorTick('2026-09-20T12:40:00.000Z', gradeRow(weeks, 'mtest.solo', 'mtest.none'));
  const m = monitorRow('mtest.solo');
  assert.equal(m.status, 'fallback');
  assert.equal(m.healthy_snapshot_id, HEALTHY_SNAPSHOT, 'the snapshot published while the field was healthy');
  const served = servedMod.readServed('player_week_scored', SCORED(9402), 'mtest.solo', { asOf: '2026-09-20T13:00:00.000Z' }, db);
  assert.equal(served.fallback_used, true);
  assert.equal(served.fallback.kind, 'snapshot');
  assert.equal(served.fallback.snapshot_id, HEALTHY_SNAPSHOT);
  assert.deepEqual(served.value, dist(7), 'the row as of the healthy snapshot, not the drifted 40');
  // a field not on fallback is served as is
  const plain = servedMod.readServed('player', '9401', 'mtest.fresh', { asOf: '2026-09-20T13:00:00.000Z' }, db);
  assert.equal(plain.fallback_used, false);
  assert.equal(plain.value, 1);
});

test('W: GET /api/engine/state serves the snapshot fallback, labelled; not before the flip', async () => {
  need(servedMod, 'views.js');
  const { default: express } = await import('express');
  const { default: engineRouter } = await import('../server/routes/engine.js');
  const app = express();
  app.use((req, _res, next) => { req.auth = { userId: 1 }; next(); });
  app.use('/api/engine', engineRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/engine/state`;
  const get = async q => (await fetch(`${base}?${q}`)).json();
  try {
    const r = await get(`entity=player_week_scored:${SCORED(9402)}&field=mtest.solo&as_of=2026-09-20T13:00:00Z`);
    assert.equal(r.status, 'fallback', JSON.stringify(r));
    assert.deepEqual(r.state.value, dist(7));
    assert.equal(r.fallback.kind, 'snapshot');
    assert.match(r.reason, /last healthy snapshot/);
    assert.equal(r.state.reason_chain.contributions[0].source, 'health_monitor');
    assert.match(r.state.reason_chain.contributions[0].text, /^fell back: /);
    assert.equal(r.fallback_used, true);
    // before the flip (12:40) the field is not on its fallback: the row then is served as it was
    const before = await get(`entity=player_week_scored:${SCORED(9402)}&field=mtest.solo&as_of=2026-09-20T12:35:00Z`);
    assert.notEqual(before.status, 'fallback');
    assert.deepEqual(before.state.value, dist(40));
    const early = servedMod.readServed('player_week_scored', SCORED(9402), 'mtest.solo', { asOf: '2026-09-20T12:35:00.000Z' }, db);
    assert.equal(early.fallback_used, false);
  } finally {
    server.close();
  }
});

test('FIX-281-2: one fallback reader: served.js is gone, the route reads views.js#readServed only', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.equal(fs.existsSync(path.join(root, 'server/services/engine/served.js')), false, 'served.js is still a second reader');
  const route = fs.readFileSync(path.join(root, 'server/routes/engine.js'), 'utf8');
  assert.doesNotMatch(route, /engine\/served\.js/);
  assert.match(route, /import\s*\{[^}]*\breadServed\b[^}]*\}\s*from\s*'[^']*engine\/views\.js'/);
  // The snapshot read uses the same monitor rule: with the fallback in the snapshot's fallback_set and
  // no fallback-field row, the view serves the field as of the last healthy snapshot, labelled.
  const snap = publishSnapshot({ leagueId: 0, versionSet: { mtest: 'v1' }, now: '2026-09-20T13:05:00.000Z' }, db);
  const s = servedMod.snapshotById(snap, db);
  assert.equal(s.fallback_set['mtest.solo'], 'mtest.none', 'fixture: the snapshot recorded the fallback in force');
  const v = servedMod.resolveRow({ entityType: 'player_week_scored', entityId: SCORED(9402), field: 'mtest.solo' }, s, null, db);
  assert.equal(v.status, 'fallback', JSON.stringify(v));
  assert.deepEqual(v.value, dist(7));
  assert.equal(v.fallback_used, true);
  assert.equal(v.reason_chain.contributions[0].source, 'health_monitor');
  assert.match(v.reason, /last healthy snapshot/);
});

test('F: a field older than its max age is stale: a warn row on the card, no fallback', () => {
  need(monitorMod, 'producers/monitor.js');
  monitorTick('2026-09-20T14:00:00.000Z'); // 2.5 h after mtest's last run, max age 1 h
  const m = monitorRow('mtest.fresh');
  assert.equal(m.status, 'stale');
  assert.equal(m.freshness['0'].status, 'stale');
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_fallback WHERE field = 'mtest.fresh'`).n, 0);
  const a = audit('mtest.fresh');
  assert.equal(a.status, 'warn');
  assert.match(a.detail, /max age/i);
  // a new run makes it fresh again, and the card row turns ok
  recordRun({ producer: 'mtest', version: 'v1', startedAt: '2026-09-20T14:05:00.000Z', finishedAt: '2026-09-20T14:05:00.000Z' }, db);
  monitorTick('2026-09-20T14:10:00.000Z');
  assert.equal(monitorRow('mtest.fresh').status, 'ok');
  assert.equal(audit('mtest.fresh').status, 'ok');
});

test('R: recovery clears the fallback and the card row, only after a fresh window', () => {
  need(monitorMod, 'producers/monitor.js');
  need(servedMod, 'views.js');
  const bad = Array.from({ length: 4 }, (_, i) => wk(i + 1, 0.5, { sd: 0.3 }));
  const good = [5, 6, 7, 8].map(i => wk(i, -0.5, { sd: 0.3 }));
  monitorTick('2026-09-20T14:20:00.000Z', gradeRow([...bad, ...good.slice(0, 3)], 'mtest.range', 'mtest.base'));
  assert.equal(monitorRow('mtest.range').status, 'fallback');
  assert.ok(row(`SELECT 1 AS x FROM engine_fallback WHERE field = 'mtest.range'`));
  monitorTick('2026-09-20T14:30:00.000Z', gradeRow([...bad, ...good], 'mtest.range', 'mtest.base'));
  assert.equal(monitorRow('mtest.range').status, 'ok');
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_fallback WHERE field = 'mtest.range'`).n, 0);
  assert.equal(audit('mtest.range').status, 'ok');
  const served = servedMod.readServed('player_week_scored', SCORED(9401), 'mtest.range', { asOf: '2026-09-20T14:35:00.000Z' }, db);
  assert.equal(served.fallback_used, false);
  assert.deepEqual(served.value, dist(12));
});

test('X: a field whose latest row failed its checks is broken on the card; the last good row is still served', () => {
  need(monitorMod, 'producers/monitor.js');
  need(servedMod, 'views.js');
  const P = registry.registerProducer({ name: 'mtest-prob', active: 'p1', versions: { p1: {} },
    fields: [{ field: 'mtest.p', valueType: 'prob', entityTypes: ['player'], checks: ['prob_unit'], description: 'fixture' }],
    inputs: { scope: 'global' } });
  put(P, 'mtest.p', 'player', '9403', 0.4, '2026-09-20T14:40:00.000Z', 'p1');
  put(P, 'mtest.p', 'player', '9403', 1.3, '2026-09-20T14:41:00.000Z', 'p1');
  monitorTick('2026-09-20T14:45:00.000Z');
  const m = monitorRow('mtest.p');
  assert.equal(m.status, 'failed');
  assert.equal(m.failed_rows, 1);
  assert.equal(audit('mtest.p').status, 'broken');
  const served = servedMod.readServed('player', '9403', 'mtest.p', { asOf: '2026-09-20T14:50:00.000Z' }, db);
  assert.equal(served.value, 0.4);
  // the healthy snapshot is pinned when the field leaves ok; a later snapshot does not move it
  const pinned = m.healthy_snapshot_id;
  publishSnapshot({ leagueId: 0, versionSet: {}, now: '2026-09-20T14:46:00.000Z' }, db);
  monitorTick('2026-09-20T14:47:00.000Z');
  assert.equal(monitorRow('mtest.p').healthy_snapshot_id, pinned);
});

test('D: the daemon runs the monitor after the grader', () => {
  need(monitorMod, 'producers/monitor.js');
  const names = producersMod.daemonProducers().map(p => p.name);
  assert.ok(names.includes('monitor'));
  assert.ok(names.indexOf('monitor') > names.indexOf('grader'));
  const spec = registry.producerSpec('monitor');
  assert.ok(spec.inputs.fields.includes('grade.week'));
  assert.equal(spec.inputs.monitor, true);
  assert.deepEqual(rows(`SELECT COUNT(*) AS n FROM engine_state WHERE field = 'health.monitor' AND lane <> 'live'`)[0].n, 0);
  assert.equal(monitorRow('health.monitor'), null, 'the monitor does not monitor itself');
});
