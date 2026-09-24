/**
 * SIM-KDST — the season sim plays every starter the league starts, K and D/ST included.
 *
 * BROKEN-NUMBERS row R: season-sim.js scored only QB/RB/WR/TE (+ flex), and
 * trade-engine.js#lineupSlots dropped K and DEF, so a 10-starter lineup
 * (QB, 2 RB, 2 WR, TE, 2 FLEX, K, D/ST) was simulated as 8 slots (about 14 points a
 * week short per team) and a K or D/ST swap was worth exactly 0.
 *
 * Contract, with GRIDIRON_SIM_KDST on (or preview mode):
 *   - the sim's slots equal the league's real slots (K and D/ST kept, 'D/ST' -> 'DEF');
 *   - a K / D/ST scores his ESPN projection that week (weekly one when published,
 *     else season projection per game); a bye scores 0;
 *   - flag off: slots and lineup totals are exactly the old ones.
 *
 * Calibration (needs a copy of the live DB, so it skips in CI): point
 * GRIDIRON_KDST_CALIBRATION_DB at a local copy and the replayed weeks 1-2 league
 * mean of league GRIDIRON_KDST_CALIBRATION_LEAGUE (default 4) must be within
 * +-15% of the actual weeks 1-2 mean (league_week_scores). It runs in the flag's
 * served configuration (preview mode). Only aggregates are printed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CAL_DB = process.env.GRIDIRON_KDST_CALIBRATION_DB || null;
const CAL_LEAGUE = Number(process.env.GRIDIRON_KDST_CALIBRATION_LEAGUE) || 4;
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
if (CAL_DB) {
  process.env.GRIDIRON_DB_PATH = CAL_DB;
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sim-kdst-'));
  process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
}

const { row } = await import('../server/db/index.js');
if (!CAL_DB) {
  const { runMigrations } = await import('../server/db/migrate.js');
  await runMigrations();
}
const sim = await import('../server/services/season-sim.js');
const { lineupSlots } = await import('../server/services/trade-engine.js');
const { lineupPoints } = sim.__test;

const withEnv = (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
};

const TEN = { roster_positions: JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'DEF', 'K', 'FLEX', 'FLEX']) };

test('lineupSlots keeps K and D/ST only when asked (the sim); default unchanged', () => {
  assert.deepEqual(lineupSlots(TEN), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX']);
  assert.deepEqual(lineupSlots(TEN, { kdst: true }), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'DEF', 'K', 'FLEX', 'FLEX']);
  const dst = { roster_positions: JSON.stringify(['QB', 'D/ST', 'K', 'BE', 'IR']) };
  assert.deepEqual(lineupSlots(dst, { kdst: true }), ['QB', 'DEF', 'K']);
});

test('simKdstFlag: 1 on, 0 off (vetoes preview), unset follows preview mode', () => {
  withEnv({ GRIDIRON_SIM_KDST: null, GRIDIRON_PREVIEW_UNCONFIRMED: null },
    () => assert.deepEqual(sim.simKdstFlag(), { on: false, preview: false }));
  withEnv({ GRIDIRON_SIM_KDST: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' },
    () => assert.deepEqual(sim.simKdstFlag(), { on: true, preview: true }));
  withEnv({ GRIDIRON_SIM_KDST: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' },
    () => assert.deepEqual(sim.simKdstFlag(), { on: false, preview: false }));
  withEnv({ GRIDIRON_SIM_KDST: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null },
    () => assert.deepEqual(sim.simKdstFlag(), { on: true, preview: false }));
});

const ROSTER = [
  { id: 1, position: 'QB' }, { id: 2, position: 'RB' }, { id: 3, position: 'WR' },
  { id: 10, position: 'K' }, { id: 11, position: 'DEF' }, { id: 12, position: 'DEF' }
];
const DRAWN = new Map([[1, 20], [2, 12], [3, 9]]);
const EXPECTED = new Map([[1, 18], [2, 10], [3, 11]]);
const SLOTS10 = ['QB', 'RB', 'WR', 'DEF', 'K', 'FLEX'];

test('lineupPoints: K and D/ST score their projection; the better-projected D/ST starts; bye = 0', () => {
  // Without a kdst map (flag off) the K / D/ST slots play empty: the old total.
  assert.equal(lineupPoints(ROSTER, SLOTS10, DRAWN, EXPECTED), 20 + 12 + 9);
  const kdst = new Map([[10, 8.5], [11, 5], [12, 7]]);
  assert.equal(lineupPoints(ROSTER, SLOTS10, DRAWN, EXPECTED, kdst), 20 + 12 + 9 + 8.5 + 7);
  // D/ST 12 on bye (no entry): D/ST 11 starts; kicker on bye scores 0.
  assert.equal(lineupPoints(ROSTER, SLOTS10, DRAWN, EXPECTED, new Map([[11, 5]])), 20 + 12 + 9 + 5);
  // A K / D/ST never fills a FLEX.
  assert.equal(lineupPoints(ROSTER, ['FLEX', 'FLEX', 'FLEX', 'FLEX'], DRAWN, EXPECTED, kdst), 12 + 9);
});

test('espnProjections reads ESPN projected points (weekly, else season per game), not actuals', () => {
  const player = (id, stats) => ({ playerPoolEntry: { player: { id, stats } } });
  const lg = {
    season: 2026,
    payload: JSON.stringify({
      seasonId: 2026,
      teams: [{ roster: { entries: [
        player(-16001, [
          { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, seasonId: 2026, appliedTotal: 7.2 },
          { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, seasonId: 2026, appliedTotal: 22 },
          { statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, seasonId: 2026, appliedTotal: 110, appliedAverage: 6.5 },
          { statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, seasonId: 2025, appliedTotal: 170, appliedAverage: 10 }
        ]),
        player(55, [{ statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, seasonId: 2026, appliedTotal: 136 }])
      ] } }]
    })
  };
  const p = sim.espnProjections(lg);
  assert.equal(p.get('-16001').weeks.get(3), 7.2);
  assert.equal(p.get('-16001').weeks.has(2), false, 'an actual is never read as a projection');
  assert.equal(p.get('-16001').perGame, 6.5, 'this season, not last');
  assert.equal(p.get('55').perGame, 8, 'no average: season total / 17');
});

test('calibration: replayed weeks 1-2 league mean within +-15% of actual (local DB copy only)',
  { skip: CAL_DB ? false : 'set GRIDIRON_KDST_CALIBRATION_DB to a local copy of the live DB' }, () => {
    const lg = row('SELECT * FROM leagues WHERE id = ?', CAL_LEAGUE);
    assert.ok(lg, 'calibration league present');
    const actual = row(`SELECT AVG(points) AS a, COUNT(*) AS n FROM league_week_scores
                        WHERE league_id = ? AND season = ? AND week IN (1, 2) AND points > 0`, CAL_LEAGUE, lg.season);
    assert.ok(actual.n > 0, 'weeks 1-2 actual scores on file');
    const replay = env => withEnv(env, () => {
      const w = sim.tradeImpactWorld(lg, { runs: 300, seed: 12345, fromWeek: 1 });
      assert.ok(!w.fail, JSON.stringify(w.fail));
      let s = 0, n = 0;
      for (const weeks of w.points.values()) for (const wk of [1, 2]) for (const v of weeks.get(wk)) { s += v; n++; }
      return { slots: w.prep.slots.length, mean: s / n };
    });
    const off = replay({ GRIDIRON_SIM_KDST: '0', GRIDIRON_PREVIEW_UNCONFIRMED: null });
    const kdstOnly = replay({ GRIDIRON_SIM_KDST: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null });
    const served = replay({ GRIDIRON_SIM_KDST: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' });
    const ratio = x => +(x.mean / actual.a).toFixed(3);
    console.log(`# sim-kdst calibration: actual ${actual.a.toFixed(1)}; off ${off.mean.toFixed(1)} (${ratio(off)}, `
      + `${off.slots} slots); kdst only ${kdstOnly.mean.toFixed(1)} (${ratio(kdstOnly)}); `
      + `preview ${served.mean.toFixed(1)} (${ratio(served)}, ${served.slots} slots)`);
    assert.ok(kdstOnly.slots > off.slots, 'K and D/ST slots are simulated');
    assert.ok(kdstOnly.mean > off.mean, 'K and D/ST add points');
    assert.ok(Math.abs(ratio(served) - 1) <= 0.15, `preview replay within 15% of actual (ratio ${ratio(served)})`);
  });
