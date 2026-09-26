/**
 * integration-e: PLAYOFF-SEEDING (#477) reached plans.json only through a fixture adapter. The real
 * producer's adapter (scripts/campaign/league-adapter.mjs) wrapped the world without `base`, so
 * planner.js#playoffPathFor(W.base) was always null and `_run.inputs.playoff_path` never appeared on a
 * real league. The adapter now exposes the base season's playoff_path block (and nothing else) when
 * GRIDIRON_PLAYOFF_SEEDING is on; off, the wrapped world is unchanged. Made-up league only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-int-e-pp-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { setupLeague } = await import('./fixtures/producer-speed-league.mjs');
const { db, buildAdapter } = await setupLeague({ teams: 6, perTeam: 12, regularWeeks: 9, currentWeek: 5, playoffTeams: 4 });
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 9, 1);
const withEnv = (v, fn) => {
  const prev = process.env.GRIDIRON_PLAYOFF_SEEDING;
  if (v == null) delete process.env.GRIDIRON_PLAYOFF_SEEDING; else process.env.GRIDIRON_PLAYOFF_SEEDING = v;
  try { return fn(); } finally { if (prev == null) delete process.env.GRIDIRON_PLAYOFF_SEEDING; else process.env.GRIDIRON_PLAYOFF_SEEDING = prev; }
};

test('real adapter, flag on: the wrapped world carries base.playoff_path and the planner copies Nick\'s block', () => {
  withEnv('shadow', () => {
    const adapter = buildAdapter({ now: NOW, fast: true });
    const W = adapter.world(adapter.seed);
    assert.ok(W.base?.playoff_path?.teams, 'the base season playoff_path block is exposed');
    assert.deepEqual(Object.keys(W.base), ['playoff_path'], 'only the block, not the whole base season');
    const res = planLeague(adapter, { objective: normaliseObjective({}, { leagueGoal: 'playoffs' }), env: { GRIDIRON_GETS_FLOOR: '0' } });
    assert.ok(res.playoff_path, 'planner result carries playoff_path');
    assert.equal(String(res.playoff_path.me), String(adapter.league.me));
  });
});

test('real adapter, flag off: no base key on the wrapped world, no playoff_path in the plan', () => {
  withEnv(null, () => {
    const adapter = buildAdapter({ now: NOW, fast: true });
    assert.equal('base' in adapter.world(adapter.seed), false);
    const res = planLeague(adapter, { objective: normaliseObjective({}, { leagueGoal: 'playoffs' }), env: { GRIDIRON_GETS_FLOOR: '0' } });
    assert.equal(res.playoff_path ?? null, null);
  });
});
