/**
 * FIX-308-2: PRODUCER-FAST under SIM-KDST (#314). With GRIDIRON_SIM_KDST=1 the
 * lineup also starts a K and a D/ST at their ESPN projection (the week's `kdst`
 * map); teamPointsFast must pick and sum them exactly as lineupPoints does, the
 * adapter's slow path must pass the same map, and the rescore cache key must
 * change with the flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-producer-fast-kdst-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_SIM_KDST = '1';

const { setupLeague } = await import('./fixtures/producer-speed-league.mjs');
const { db, svc, buildAdapter, leagueId } = await setupLeague({ teams: 6, perTeam: 12, regularWeeks: 9, currentWeek: 5,
  playoffTeams: 4, kdst: true });
const { worldPrint } = await import('../scripts/campaign/rescore-cache.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); delete process.env.GRIDIRON_SIM_KDST; });

const lg = () => db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);
const world = svc.sim.tradeImpactWorld(lg(), { fastLineups: true });

test('control: the world starts a K and a D/ST and scores them', () => {
  assert.ifError(world.fail?.error);
  assert.equal(world.key.kdst, 'kdst');
  assert.ok(world.prep.slots.includes('K') && world.prep.slots.includes('DEF'), JSON.stringify(world.prep.slots));
  const [, first] = [...world.draws][0];
  assert.ok(first.kdst?.size > 0, 'the week has K / D/ST points');
});

test('with GRIDIRON_SIM_KDST=1, teamPointsFast is lineupPoints (with kdst) to the last bit', () => {
  const { lineupPoints } = svc.sim.__test;
  const rosters = world.prep.teams.flatMap(t => [t.players, t.players.slice(1),
    t.players.filter(p => p.position !== 'K')]);
  rosters.push([...world.prep.teams[0].players.slice(0, 6), ...world.prep.teams[1].players.slice(4)]);
  let withKdst = 0;
  for (const players of rosters) {
    const fast = svc.sim.teamPointsFast(world, players);
    for (const [week, { byRun, expected, kdst }] of world.draws) {
      const arr = fast.get(week);
      const skill = lineupPoints(players, world.prep.slots, byRun[0], expected);
      if (lineupPoints(players, world.prep.slots, byRun[0], expected, kdst) !== skill) withKdst++;
      for (let run = 0; run < world.runs; run++) {
        const want = lineupPoints(players, world.prep.slots, byRun[run], expected, kdst);
        if (!Object.is(arr[run], want)) assert.fail(`week ${week} run ${run}: ${arr[run]} != ${want}`);
      }
    }
  }
  assert.ok(withKdst > 0, 'the K / D/ST points changed the totals being compared');
});

test('fast and slow adapters give Object.is-equal weekly totals on a roster with K and DEF', () => {
  const slow = buildAdapter({ fast: false }), fast = buildAdapter({ fast: true });
  const team = world.prep.teams[0].players;
  assert.ok(team.some(p => p.position === 'K') && team.some(p => p.position === 'DEF'));
  const ids = team.map(p => p.id);
  const a = slow.world(slow.seed).weekly(ids), b = fast.world(fast.seed).weekly(ids);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    for (let r = 0; r < a[i].samples.length; r++) {
      if (!Object.is(a[i].samples[r], b[i].samples[r])) assert.fail(`week ${a[i].week} run ${r}: ${a[i].samples[r]} != ${b[i].samples[r]}`);
    }
  }
});

test('the rescore cache key covers the SIM-KDST flag', () => {
  const on = worldPrint(world, lg());
  process.env.GRIDIRON_SIM_KDST = '0';
  try {
    const off = svc.sim.tradeImpactWorld(lg(), { fastLineups: true, projections: world.projections });
    assert.equal(off.key.kdst, 'skill');
    assert.notEqual(worldPrint(off, lg()), on, 'flag off is another world');
  } finally { process.env.GRIDIRON_SIM_KDST = '1'; }
  assert.equal(worldPrint(svc.sim.tradeImpactWorld(lg(), { fastLineups: true, projections: world.projections }), lg()), on);
});
