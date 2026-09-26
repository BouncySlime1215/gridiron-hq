/**
 * PRODUCER-SPEED (plan item 32): the planner under 60 s with SEARCH-WIDE on, measured before -> after,
 * the same plan. Behind GRIDIRON_PRODUCER_SPEED=1 only (scripts/campaign/points-memo.mjs), on top of
 * PRODUCER-FAST's lineups:
 *   1. a roster's lineup totals are memoised per world (every rescore solved each changed roster twice);
 *   2. season-sim.js regular seasons on index arrays (tradeImpactWorld `fastSeasons`).
 * Contract: the whole planner result byte-equal with the flag off, SEARCH-WIDE on, on a fixed seed.
 * Six-team fixture so the suite stays fast; the ten-team numbers are in the TDD record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-producer-speed-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { setupLeague } = await import('./fixtures/producer-speed-league.mjs');
const { db, svc, buildAdapter, leagueId } = await setupLeague({ teams: 6, perTeam: 12, regularWeeks: 9, currentWeek: 5, playoffTeams: 4 });
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { leagueCache } = await import('../scripts/campaign/rescore-cache.mjs');
const { planPrint } = await import('../scripts/campaign/bench-producer.mjs');
const { producerSpeedEnabled, pointsMemo, PRODUCER_SPEED_ENV } = await import('../scripts/campaign/points-memo.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const objective = normaliseObjective({}, { leagueGoal: 'title' });
const NOW = Date.UTC(2026, 9, 1);
const lg = () => db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);
// A made-up blue-chip board (score by value rank), so SEARCH-WIDE's lateral rule has tiers to read and
// the wide search actually scores extra paths; the same board in both arms.
const withBoard = adapter => {
  const vs = [...adapter.players.values()].map(p => Number(p.value) || 0).sort((a, b) => a - b);
  adapter.scoreOf = id => {
    const v = Number((adapter.players.get(id) ?? adapter.players.get(Number(id)))?.value);
    return Number.isFinite(v) ? { score: Math.round(50 + 45 * vs.filter(x => x <= v).length / vs.length) } : null;
  };
  return adapter;
};
const env = { GRIDIRON_GETS_FLOOR: '0', GRIDIRON_SEARCH_WIDE: '1' };
const plan = speed => {
  const t0 = performance.now();
  const adapter = withBoard(buildAdapter({ now: NOW, fast: true, rescoreCache: leagueCache({}), searchWide: 'on', speed }));
  const res = planLeague(adapter, { objective, env });
  return { res, adapter, ms: performance.now() - t0 };
};
const before = plan(false);
const after = plan(true);

test('control: SEARCH-WIDE is on and scores extra paths in both arms', () => {
  assert.ifError(before.res.error);
  assert.equal(before.res.search_wide?.flag, 'on');
  assert.ok(before.res.search_wide.used.rescores > 0, `wide rescores ${before.res.search_wide.used.rescores}`);
  assert.ok(before.res.rescores > 100, `the planner rescored the league (${before.res.rescores})`);
});

test('the flag plans the same league to the same plan (whole result, SEARCH-WIDE on)', () => {
  assert.equal(after.res.seed, before.res.seed);
  assert.equal(after.res.rescores, before.res.rescores);
  assert.equal(planPrint(after.res), planPrint(before.res), 'same next move, deck, playbook, flip map, wide sink, confirm');
});

test('the memo is used with the flag and absent without it', () => {
  assert.equal(before.adapter.speedStats(), null);
  const s = after.adapter.speedStats();
  assert.ok(s.hits > 0 && s.misses > 0, JSON.stringify(s));
});

test('speed: the flag cuts the plan time', () => {
  // Measured here about 2x (ten-team fixture 20.1 s -> 9.0 s); asserted at 1.3x so the check is about the change.
  console.log(`# before ${Math.round(before.ms)} ms, after ${Math.round(after.ms)} ms`);
  assert.ok(after.ms * 1.3 < before.ms, `after ${Math.round(after.ms)} ms vs before ${Math.round(before.ms)} ms`);
});

test('regular seasons on index arrays: the same result as the Map loop, median game and team offsets too', () => {
  const { playSeasons } = svc.sim.__test;
  const w = svc.sim.tradeImpactWorld(lg(), { fastLineups: true });
  assert.ifError(w.fail?.error);
  const reader = (t, run, week) => w.points.get(t.roster_id).get(week)[run];
  const variants = [{}, { medianGame: true }, { teamMeanSd: 6 }, { medianGame: true, teamMeanSd: 6 }];
  for (const v of variants) {
    const prep = { ...w.prep, ...v };
    const slow = playSeasons(prep, prep.teams, w.runs, true, reader);
    const fast = playSeasons(prep, prep.teams, w.runs, true, reader, w.points);
    const flat = r => JSON.stringify(r, (k, x) => (x instanceof Map ? [...x] : ArrayBuffer.isView(x) ? Array.from(x) : x));
    assert.equal(flat(fast), flat(slow), `variant ${JSON.stringify(v)}`);
  }
  // A fixture naming a team the table lacks falls back to the Map loop (same result, no throw).
  const partial = new Map([...w.points].slice(1));
  const slow = playSeasons(w.prep, w.prep.teams, w.runs, true, reader);
  assert.deepEqual(playSeasons(w.prep, w.prep.teams, w.runs, true, reader, partial).teams, slow.teams);
});

test('a fastSeasons world rescores every deal to the same numbers', () => {
  const league = lg();
  const w = svc.sim.tradeImpactWorld(league, { fastLineups: true });
  const f = svc.sim.tradeImpactWorld(league, { fastLineups: true, fastSeasons: true, projections: w.projections });
  assert.deepEqual(f.base.teams, w.base.teams);
  const [a, b] = w.prep.teams;
  for (const [give, get] of [[[a.players[0].id], [b.players[0].id]], [[a.players[2].id, a.players[5].id], [b.players[1].id]]]) {
    const deal = { myTeamId: a.roster_id, theirTeamId: b.roster_id, iGive: give, iGet: get };
    const x = svc.sim.tradeImpact(league, { ...deal, world: w }), y = svc.sim.tradeImpact(league, { ...deal, world: f });
    assert.deepEqual(y.me, x.me); assert.deepEqual(y.them, x.them);
  }
});

test('pointsMemo: a repeat roster returns the first solve, per world, bounded', () => {
  let solves = 0;
  const solve = (w, players) => { solves++; return new Map([[1, new Float64Array([players.length])]]); };
  const memo = pointsMemo(solve, { max: 2 });
  const w1 = { draws: new Map() }, w2 = { draws: new Map() };
  const p = ids => ids.map(id => ({ id }));
  const first = memo(w1, p([1, 2]));
  assert.equal(memo({ ...w1, prep: {} }, p([1, 2])), first, 'a spread copy of the world shares its memo');
  assert.notEqual(memo(w2, p([1, 2])), first, 'another world solves again');
  assert.notEqual(memo(w1, p([2, 1])), first, 'roster order is part of the key');
  memo(w1, p([3]));
  assert.equal(solves, 4);
  memo(w1, p([1, 2]));
  assert.equal(solves, 5, 'the least recently used roster was evicted at max 2');
  assert.deepEqual(memo.stats, { hits: 1, misses: 5, evicted: 2 });
});

test('the flag: on only with GRIDIRON_PRODUCER_SPEED=1; preview mode does not turn it on', () => {
  assert.equal(PRODUCER_SPEED_ENV, 'GRIDIRON_PRODUCER_SPEED');
  assert.equal(producerSpeedEnabled({ GRIDIRON_PRODUCER_SPEED: '1' }), true);
  assert.equal(producerSpeedEnabled({}), false);
  assert.equal(producerSpeedEnabled({ GRIDIRON_PRODUCER_SPEED: 'true' }), false);
  assert.equal(producerSpeedEnabled({ GRIDIRON_PREVIEW: '1', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
});

test('the flag needs fast lineups: speed without PRODUCER-FAST changes nothing', () => {
  const adapter = buildAdapter({ now: NOW, fast: false, speed: true });
  assert.equal(adapter.speedStats(), null);
});
