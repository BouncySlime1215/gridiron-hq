/**
 * PRODUCER-FAST: the target-league producer fast enough to replan every refresh
 * and on every event, with the same plan.
 *
 * Profiled on a made-up ten-team league (test/fixtures/producer-speed-league.mjs,
 * real season simulator, 1200 runs): ~85% of every rescore was lineupPoints
 * re-picking each lineup once per run, though who starts depends only on the
 * week's expected points. Two changes, both behind GRIDIRON_PRODUCER_FAST (on
 * under preview mode):
 *   1. season-sim.js#teamPointsFast picks each week's starters once and sums the
 *      runs in the same slot order: the same doubles, not close ones.
 *   2. scripts/campaign/rescore-cache.mjs keeps last run's rescores, keyed by a
 *      content hash of the world, so a replan with nothing new skips values and
 *      the flip map entirely, and a changed world can never read a stale entry.
 *
 * The contract is the same plan: the whole planner result (next move, deck,
 * playbook, flip map, confirm) byte-equal with the flag off, cold and warm.
 * This file runs a smaller league (six teams) so the suite stays fast; the
 * ten-team numbers are in the TDD record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-producer-fast-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { setupLeague } = await import('./fixtures/producer-speed-league.mjs');
const { db, svc, buildAdapter, leagueId } = await setupLeague({ teams: 6, perTeam: 12, regularWeeks: 9, currentWeek: 5, playoffTeams: 4 });
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { producerFastEnabled, PRODUCER_FAST_ENV } = await import('../scripts/campaign/league-adapter.mjs');
const { leagueCache, worldPrint, stateKey, readRescoreCache, writeRescoreCache } = await import('../scripts/campaign/rescore-cache.mjs');
const { planPrint } = await import('../scripts/campaign/bench-producer.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const objective = normaliseObjective({}, { leagueGoal: 'title' });
const NOW = Date.UTC(2026, 9, 1);
const plan = opts => {
  const t0 = performance.now();
  const adapter = buildAdapter({ now: NOW, ...opts });
  const res = planLeague(adapter, { objective });
  return { res, adapter, ms: performance.now() - t0 };
};

// One run of each mode, shared by the tests below (each is a full planner run).
const off = plan({ fast: false });
const coldCache = leagueCache({});
const cold = plan({ fast: true, rescoreCache: coldCache });
const warmCache = leagueCache(JSON.parse(JSON.stringify(coldCache.next)));
const warm = plan({ fast: true, rescoreCache: warmCache });

test('control: the fixture league plans a real next move off real rescores', () => {
  assert.ifError(off.res.error);
  assert.ok(off.res.best, 'a next move was found');
  assert.ok(off.res.rescores > 100, `the planner rescored the league (${off.res.rescores})`);
  assert.ok(off.res.flip.pairs > 0 && off.res.candidates_scored > 0);
});

test('teamPointsFast is lineupPoints summed per run, to the last bit', () => {
  const { lineupPoints } = svc.sim.__test;
  const w = svc.sim.tradeImpactWorld(db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId));
  assert.ifError(w.fail?.error);
  // Every team, every team minus its best player, and a mixed roster across two teams.
  const rosters = w.prep.teams.flatMap(t => [t.players, t.players.slice(1)]);
  rosters.push([...w.prep.teams[0].players.slice(0, 5), ...w.prep.teams[1].players.slice(3)]);
  for (const players of rosters) {
    const fast = svc.sim.teamPointsFast(w, players);
    for (const [week, { byRun, expected }] of w.draws) {
      const arr = fast.get(week);
      for (let run = 0; run < w.runs; run++) {
        const want = lineupPoints(players, w.prep.slots, byRun[run], expected);
        if (!Object.is(arr[run], want)) assert.fail(`week ${week} run ${run}: ${arr[run]} != ${want}`);
      }
    }
  }
});

test('fast lineups plan the same league to the same plan on a fixed seed', () => {
  assert.equal(cold.res.seed, off.res.seed);
  assert.equal(JSON.stringify(cold.res.best.steps[0]), JSON.stringify(off.res.best.steps[0]), 'same next move');
  assert.equal(planPrint(cold.res), planPrint(off.res), 'same whole plan: deck, playbook, flip map, confirm');
  assert.equal(cold.res.rescores, off.res.rescores);
});

test('a warm cache replans with no rescores and the same plan', () => {
  assert.deepEqual({ hits: warmCache.stats.hits, misses: warmCache.stats.misses }, { hits: coldCache.stats.misses, misses: 0 });
  assert.equal(warmCache.stats.worlds, 2, 'the planning world and the confirm world');
  assert.equal(planPrint(warm.res), planPrint(off.res));
  assert.ok(warm.res.phases_ms.values + warm.res.phases_ms.flip < cold.res.phases_ms.values + cold.res.phases_ms.flip,
    'values and the flip map come out of the cache');
});

test('speed: the fast producer is several times faster, the warm one faster still', () => {
  // Measured here about 4-5x cold and 10x+ warm; asserted at 2x and 4x so the check is about
  // the change, not the machine.
  assert.ok(cold.ms * 2 < off.ms, `cold ${Math.round(cold.ms)} ms vs off ${Math.round(off.ms)} ms`);
  console.log(`# off ${Math.round(off.ms)} ms, cold ${Math.round(cold.ms)} ms, warm ${Math.round(warm.ms)} ms`);
  assert.ok(warm.ms * 4 < off.ms, `warm ${Math.round(warm.ms)} ms vs off ${Math.round(off.ms)} ms`);
});

test('a changed world is a different cache key, never a stale hit', () => {
  const lg = db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);
  const w = svc.sim.tradeImpactWorld(lg, { fastLineups: true });
  const same = svc.sim.tradeImpactWorld(lg, { fastLineups: true, projections: w.projections });
  const reseeded = svc.sim.tradeImpactWorld(lg, { seed: 99, fastLineups: true, projections: w.projections });
  assert.equal(worldPrint(same, lg), worldPrint(w, lg), 'the same league state hashes the same');
  assert.notEqual(worldPrint(reseeded, lg), worldPrint(w, lg), 'another seed is another world');
  // A roster move (the payload a sync writes) is another world even on the same seed.
  const moved = JSON.parse(lg.payload);
  moved.teams[0].roster.entries.push(moved.teams[1].roster.entries.shift());
  const lg2 = { ...lg, payload: JSON.stringify(moved) };
  assert.notEqual(worldPrint(svc.sim.tradeImpactWorld(lg2, { fastLineups: true, projections: w.projections }), lg2), worldPrint(w, lg));
  // Roster order is part of the key (lineup ties break on it); team order is not.
  const s1 = new Map([['1', [1, 2]], ['2', [3]]]), s2 = new Map([['2', [3]], ['1', [1, 2]]]), s3 = new Map([['1', [2, 1]], ['2', [3]]]);
  assert.equal(stateKey(s1, '1', '2'), stateKey(s2, '1', '2'));
  assert.notEqual(stateKey(s1, '1', '2'), stateKey(s3, '1', '2'));
  assert.notEqual(stateKey(s1, '1', '2'), stateKey(s1, '1', '3'));
});

test('the cache file round-trips; a bad or old file is ignored with its reason', () => {
  const file = path.join(temp, 'rescore-cache.json');
  assert.equal(readRescoreCache(file).status, 'absent');
  writeRescoreCache(file, { [leagueId]: coldCache.next });
  const back = readRescoreCache(file);
  assert.equal(back.status, 'ok');
  assert.deepEqual(back.leagues[String(leagueId)], coldCache.next);
  fs.writeFileSync(file, '{"version":0,"leagues":{}}');
  assert.match(readRescoreCache(file).status, /^ignored/);
  fs.writeFileSync(file, '{not json');
  assert.match(readRescoreCache(file).status, /^unreadable/);
});

test('the producer reports the cache on each league (and nothing without one)', async () => {
  const run = async (fast, cache) => (await buildPlansFile([{ id: leagueId,
    load: async () => ({ adapter: buildAdapter({ now: NOW, fast, rescoreCache: cache }) }) }],
  { generated_at: '2026-10-01T00:00:00.000Z', budget: {} })).leagues[0];
  const onEntry = await run(true, leagueCache(JSON.parse(JSON.stringify(coldCache.next))));
  assert.ifError(onEntry.error);
  assert.equal(onEntry._run.inputs.rescore_cache.misses, 0);
  assert.ok(onEntry._run.inputs.rescore_cache.hits > 0);
  const offEntry = await run(true, null);
  assert.equal('rescore_cache' in offEntry._run.inputs, false, 'no cache, no field: the FIX-03 contract fixture is unchanged');
});

test('flag: off by default, on with GRIDIRON_PRODUCER_FAST=1 or under preview mode; =0 vetoes preview', () => {
  assert.equal(producerFastEnabled({}), false);
  assert.equal(producerFastEnabled({ [PRODUCER_FAST_ENV]: '1' }), true);
  assert.equal(producerFastEnabled({ [PRODUCER_FAST_ENV]: 'true' }), false);
  assert.equal(producerFastEnabled({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), true);
  assert.equal(producerFastEnabled({ GRIDIRON_PREVIEW_UNCONFIRMED: '1', [PRODUCER_FAST_ENV]: '0' }), false);
});
