/**
 * REPRO-01: the campaign producer is reproducible.
 *   - one run clock (server/services/campaign/run-clock.js) answers every world question;
 *   - --as-of / --seed / --db-snapshot parse, and a snapshot is a frozen copy;
 *   - two builds with the same as-of write the same file apart from generated_at and timing;
 *   - no Date.now() / new Date() in the campaign code bypasses the run clock (grep, with the
 *     justified reads listed below).
 * Made-up four-team league (test/fixtures/campaign-league.mjs) and a throwaway sqlite file; no real data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { runClock, parseAsOf, stopwatch } = await import('../server/services/campaign/run-clock.js');
const { skipWeights } = await import('../server/services/campaign/partners.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { buildPlansFile, fileInputs, args, prepareSnapshot } = await import('../scripts/campaign/produce-plans.mjs');

const AS_OF = '2026-09-20T15:00:00.000Z';

test('run clock: --as-of pins one instant; without it the wall clock is read once', () => {
  const c = runClock('2026-09-20T15:00:00Z');
  assert.equal(c.iso, AS_OF);
  assert.equal(c.explicit, true);
  assert.equal(c.now(), c.ms);
  assert.equal(c.now(), c.now());
  assert.equal(parseAsOf('2026-09-20'), Date.parse('2026-09-20T00:00:00Z'), 'a bare date is UTC midnight');
  assert.equal(parseAsOf('2026-09-20 15:00'), Date.parse(AS_OF), 'an unzoned date-time is UTC');
  assert.throws(() => parseAsOf('yesterday'), /ISO/);
  assert.throws(() => parseAsOf('2026-13-45'), /real date|ISO/);
  const w = runClock(null, 1_000);
  assert.deepEqual([w.ms, w.explicit, w.iso], [1_000, false, '1970-01-01T00:00:01.000Z']);
  assert.ok(Number.isFinite(stopwatch()));
});

test('CLI: --as-of, --seed and --db-snapshot (bare = take one, with a file = read it)', () => {
  const a = args(['node', 'p', '--leagues', '4', '--as-of', AS_OF, '--seed', '7', '--db-snapshot', '--no-finder']);
  assert.deepEqual([a.leagues, a.asOf, a.seed, a.snapshot, a.finder], [[4], AS_OF, 7, { take: true }, false]);
  const b = args(['node', 'p', '--db-snapshot', '/x/snap.sqlite']);
  assert.deepEqual(b.snapshot, { file: '/x/snap.sqlite' });
  const d = args(['node', 'p']);
  assert.deepEqual([d.asOf, d.seed, d.snapshot], [null, null, null], 'defaults unchanged');
  assert.throws(() => args(['node', 'p', '--seed', 'x']), /integer/);
});

test('skip weights read the run clock, never the wall clock', () => {
  const skips = [{ league: 1, player: 5, reason: 'not_now', at: '2026-09-15T00:00:00Z' }];
  assert.equal(skipWeights(skips, 1, Date.parse('2026-09-16T00:00:00Z')).player.has('5'), true, 'inside the week: still skipped');
  assert.equal(skipWeights(skips, 1, Date.parse('2026-09-30T00:00:00Z')).player.has('5'), false, 'a week on: faded');
  assert.throws(() => skipWeights(skips, 1), /run clock/);
  assert.equal(skipWeights([{ league: 1, manager: 3, reason: 'manager', at: 'x' }], 1).manager.get('3'), 0.4,
    'skips that do not fade need no clock');
  const at = Date.parse('2026-09-30T00:00:00Z');
  assert.equal(fileInputs(1, { fileSkips: skips, now: at }).weights.player.has('5'), false, 'the files path passes the clock through');
});

const strip = file => {
  const f = structuredClone(file);
  delete f.generated_at;
  for (const e of f.leagues) if (e._run) { delete e._run.runtime_ms; delete e._run.phases_ms; }
  return JSON.stringify(f);
};

test('two builds at the same as-of are identical apart from generated_at and timing; the as-of is recorded', async () => {
  const run = { as_of: AS_OF, as_of_source: '--as-of', seed: 'tradeImpactSeed', db: 'snapshot (given)' };
  let tick = 0;
  const build = generated_at => buildPlansFile([{ id: 99, load: async () => ({ adapter: makeAdapter() }) }],
    { generated_at, asOf: AS_OF, run, clock: () => (tick += 137), skips: [{ league: 99, player: 1, reason: 'not_now', at: '2026-09-19T00:00:00Z' }] });
  const one = await build('2026-09-24T01:00:00.000Z');
  const two = await build('2026-09-24T02:30:00.000Z');
  assert.equal(validatePlans(one).ok, true, JSON.stringify(validatePlans(one).errors?.slice(0, 3)));
  assert.notEqual(one.generated_at, two.generated_at);
  assert.equal(strip(one), strip(two));
  const e = one.leagues[0];
  assert.deepEqual(e._run.inputs.run, run);
  const asOfs = new Set();
  const walk = x => { if (x && typeof x === 'object') { if (typeof x.as_of === 'string') asOfs.add(x.as_of); Object.values(x).forEach(walk); } };
  walk(e);
  assert.ok(asOfs.size > 0 && [...asOfs].every(v => v === AS_OF), `every value's as_of is the run's: ${[...asOfs]}`);
});

test('without asOf / run the entry is the incumbent shape (the contract fixture stays byte-identical)', async () => {
  const f = await buildPlansFile([{ id: 99, load: async () => ({ adapter: makeAdapter() }) }], { generated_at: AS_OF, clock: () => 0 });
  assert.equal('run' in f.leagues[0]._run.inputs, false);
});

test('--db-snapshot takes a frozen copy: writes to the live DB after the start are not in it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-01-'));
  try {
    const live = path.join(dir, 'live.sqlite');
    const db = new DatabaseSync(live);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2);');
    const snap = await prepareSnapshot({ take: true }, { src: live, dest: path.join(dir, 'snap.sqlite') });
    db.exec('INSERT INTO t VALUES (3)');
    db.close();
    const s = new DatabaseSync(snap.file, { readOnly: true });
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM t').get().n, 2);
    s.close();
    assert.equal(snap.source, 'taken at start');
    snap.cleanup();
    assert.equal(fs.existsSync(snap.file), false, 'a taken snapshot is deleted at exit');
    const before = fs.readFileSync(live);
    const given = await prepareSnapshot({ file: live }, { src: 'unused', dest: path.join(dir, 'work.sqlite') });
    assert.deepEqual([given.source, given.from], ['given', live]);
    assert.notEqual(given.file, live, 'a given snapshot is read through a working copy');
    const w = new DatabaseSync(given.file);
    w.exec('INSERT INTO t VALUES (4)');
    w.close();
    given.cleanup();
    assert.deepEqual(fs.readFileSync(live), before, 'a given snapshot is never written or deleted');
    await assert.rejects(prepareSnapshot({ file: path.join(dir, 'nope.sqlite') }, {}), /not found/);
    assert.equal(await prepareSnapshot(null, {}), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/*
 * The grep metric. Every wall-clock read left in the campaign code, with why it is not a world question:
 *   run-clock.js        the run clock itself: the one read when no --as-of is given.
 *   produce-plans.mjs   generated_at under --as-of: when the replay's file was written (the reader's
 *                       freshness stamp); excluded from reproducibility comparisons.
 *   requests.js (2)     default parameters (leagueInputs `now`, consumeWith `at`) the producer never
 *                       reaches: it passes the run clock and generated_at. requests.js is FIX-07's file,
 *                       left as it is here to keep the change additive.
 * Added by the merge with main (code main brought in that is not the producer's world):
 *   his-screen.js (2)   the web route's in-memory TTL cache for hisScreenFor (entry age); elapsed
 *                       time in the server, not a question the producer asks about the world.
 *   his-screen-probe.mjs (2)  a dev probe timing one hisScreenFor call (elapsed ms in its printout).
 *   negotiate-bench.mjs (2)   a dev bench seeding its own 'bench' thread rows (write stamps and a
 *                       unique idea id); not the producer.
 *   bench-producer.mjs (4)    PRODUCER-FAST's dev benchmark: one wall-clock instant shared by its
 *                       modes (it benchmarks today's league) and its elapsed timings; not the producer.
 */
const JUSTIFIED = new Map([
  ['scripts/campaign/bench-producer.mjs', 4],
  ['scripts/campaign/his-screen-probe.mjs', 2],
  ['scripts/campaign/negotiate-bench.mjs', 2],
  ['scripts/campaign/produce-plans.mjs', 1],
  ['server/services/campaign/his-screen.js', 2],
  ['server/services/campaign/requests.js', 2],
  ['server/services/campaign/run-clock.js', 1],
]);

test('no Date.now() / new Date() in the campaign code bypasses the run clock', () => {
  const found = new Map();
  for (const dir of ['scripts/campaign', 'server/services/campaign']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!/\.(m?js)$/.test(name)) continue;
      const rel = `${dir}/${name}`;
      const n = (fs.readFileSync(path.join(ROOT, rel), 'utf8').match(/Date\.now\(\)|new Date\(\)/g) ?? []).length;
      if (n) found.set(rel, n);
    }
  }
  assert.deepEqual(Object.fromEntries(found), Object.fromEntries(JUSTIFIED));
  const src = fs.readFileSync(path.join(ROOT, 'scripts/campaign/produce-plans.mjs'), 'utf8');
  assert.match(src, /leagueInputs\(id, \{ [^}]*now: asOfMs \}\)/, 'the producer hands the run clock to leagueInputs');
  assert.match(src, /consumeWith\([^]*?\{ at: generated_at \}\)/, 'and generated_at to consumeWith');
  assert.match(src, /file\.generated_at = clock\.iso;[^]*?reasonPlans\(/, 'reasoning stamps its as_of with the run clock');
});

test('the league adapter takes the run clock; it has no wall-clock default', async () => {
  const { buildAdapter } = await import('../scripts/campaign/league-adapter.mjs');
  assert.throws(() => buildAdapter({}, 4), /run clock/);
});

test('the adapter hands sendWindow the run clock as a Date: the send window reads the as-of, not the wall clock', async () => {
  const { buildAdapter } = await import('../scripts/campaign/league-adapter.mjs');
  const tactics = await import('../server/services/trade-tactics.js');
  // Declined 14 hours before the as-of. The wall clock (days later) would say 'now'; the as-of world says 'wait'.
  const tm = { last_decline_at: new Date(Date.parse(AS_OF) - 14 * 3600e3).toISOString(), decisions_n: 1 };
  const seen = [];
  const STOP = new Error('stop after the send window');
  const svc = {
    db: { row: sql => (/FROM leagues/.test(sql) ? { id: 4, my_team_id: 1, season: 2026, payload: '{}' } : null), rows: () => [] },
    sim: { tradeImpactWorld: () => ({ key: { seed: 1 }, base: { teams: [] },
      prep: { assets: new Map(), teams: [{ roster_id: '1', players: [] }, { roster_id: '2', players: [] }] } }),
    tradeImpact: () => ({}), __test: { lineupPoints: () => 0 } },
    week: { leagueCurrentWeek: () => 3 },
    cp: { counterpartyLayer: () => new Map() },
    tactics: { toTime: tactics.toTime, timingRead: () => new Map([['2', tm]]),
      sendWindow: (t, o) => { seen.push(tactics.sendWindow(t, o)); throw STOP; } },
  };
  assert.throws(() => buildAdapter(svc, 4, { now: Date.parse(AS_OF) }), e => e === STOP);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].when, 'wait');
  assert.match(seen[0].why, /declined your last offer 14 hours ago/);
});
