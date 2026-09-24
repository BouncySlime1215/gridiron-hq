/**
 * SIM-CALIB — the season sim's projection level is the as-of rate (preseason at
 * week 1, in-season rest-of-season after), built only from data before the week.
 *
 * Contract, with GRIDIRON_SIM_ASOF_PROJ on (or preview mode):
 *   - projection-asof.js#projectionAsOf(week w) reads nothing from week >= w of the
 *     season: each reader is asked for that cutoff, and adding week >= w rows to the
 *     database does not change the result;
 *   - a player with no game yet gets the preseason blend (ros-projection.js#rosUpdate
 *     with n = 0), so week 1 is no longer empty;
 *   - the sim's pools are scaled onto that rate (asofScale), reported as the RL-17-3
 *     ROS basis with `ros_asof_week`; flag off = old numbers; GRIDIRON_RL17_3_ENABLED=0
 *     vetoes it.
 *
 * Calibration (needs a copy of the live DB, so it skips in CI): point
 * GRIDIRON_ASOF_CALIBRATION_DB at a local copy. Each of weeks 1-2 of league
 * GRIDIRON_ASOF_CALIBRATION_LEAGUE (default 4) is replayed from a world that starts at
 * that week (so its projection is as of that week) and graded on that week only; the
 * pooled ratio to the actual mean must be within +-10%. The week-3 forward league mean
 * must be within +-10% of ESPN's projected 10-starter lineup mean for week 3
 * (GRIDIRON_ASOF_ESPN_W3, default 137.0 from evidence scale-140.md). Rosters are the
 * current ones (a known in-sample leak shared by every configuration).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CAL_DB = process.env.GRIDIRON_ASOF_CALIBRATION_DB || null;
const CAL_LEAGUE = Number(process.env.GRIDIRON_ASOF_CALIBRATION_LEAGUE) || 4;
const ESPN_W3 = Number(process.env.GRIDIRON_ASOF_ESPN_W3) || 137.0;
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
if (CAL_DB) {
  process.env.GRIDIRON_DB_PATH = CAL_DB;
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sim-asof-'));
  process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
}

const { row, run } = await import('../server/db/index.js');
if (!CAL_DB) {
  const { runMigrations } = await import('../server/db/migrate.js');
  await runMigrations();
}
const sim = await import('../server/services/season-sim.js');
const { projectionAsOf, ASOF_READERS } = await import('../server/services/projection-asof.js');
const { buildPlayerWeekEngine } = await import('../server/services/player-week-engine.js');
const { ROS_PARAMS, rosUpdate, clearRosPriorCache } = await import('../server/services/ros-projection.js');
const { asofScale } = sim.__test;

const withEnv = (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
};

test('simAsofFlag: 1 on, 0 off (vetoes preview), unset follows preview mode', () => {
  withEnv({ GRIDIRON_SIM_ASOF_PROJ: null, GRIDIRON_PREVIEW_UNCONFIRMED: null },
    () => assert.deepEqual(sim.simAsofFlag(), { on: false, preview: false }));
  withEnv({ GRIDIRON_SIM_ASOF_PROJ: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' },
    () => assert.deepEqual(sim.simAsofFlag(), { on: true, preview: true }));
  withEnv({ GRIDIRON_SIM_ASOF_PROJ: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' },
    () => assert.deepEqual(sim.simAsofFlag(), { on: false, preview: false }));
  withEnv({ GRIDIRON_SIM_ASOF_PROJ: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null },
    () => assert.deepEqual(sim.simAsofFlag(), { on: true, preview: false }));
  // The ROS basis kill switch vetoes the as-of mode of that basis too.
  withEnv({ GRIDIRON_SIM_ASOF_PROJ: '1', GRIDIRON_RL17_3_ENABLED: '0' },
    () => assert.deepEqual(sim.simAsofFlag(), { on: false, preview: false }));
});

test('projectionAsOf asks every reader for data before week w only, and blends preseason with in-season', () => {
  const calls = [];
  const readers = {
    structural: a => { calls.push(['structural', a.season, a.week]); return new Map([
      [1, { position: 'WR', structural_ppg: 12 }], [2, { position: 'RB', structural_ppg: 10 }],
      [3, { position: 'K', structural_ppg: 8 }]]); },
    history: a => { calls.push(['history', a.season, a.week]); return new Map([[1, { games: 2, season_to_date: 20 }]]); },
    priors: a => { calls.push(['priors', a.season, a.week ?? null]); return new Map([[1, { c_mkt: 14 }], [2, { c_mkt: 8 }]]); }
  };
  const out = projectionAsOf({ season: 2026, week: 3, readers });
  // The weekly engine for week 3 reads usage through week 2; history reads week < 3;
  // the priors are preseason (no week at all).
  assert.deepEqual(calls, [['structural', 2026, 3], ['history', 2026, 3], ['priors', 2026, null]]);
  const inSeason = rosUpdate({ structural: 12, seasonToDate: 20, games: 2, prior: 14, position: 'WR' }, ROS_PARAMS);
  assert.equal(out.get(1).ppg, inSeason);
  assert.equal(out.get(1).source, 'in_season');
  // No game yet: the preseason blend (alpha * structural + (1 - alpha) * prior), not empty.
  assert.equal(out.get(2).ppg, ROS_PARAMS.alpha * 10 + (1 - ROS_PARAMS.alpha) * 8);
  assert.equal(out.get(2).source, 'preseason');
  assert.equal(out.has(3), false, 'K / D/ST are not on this basis');
});

const usage = (id, season, week, targets, yards) => run(
  `INSERT INTO player_week_usage (player_id, season, week, team, opponent, position, attempts, carries, targets,
     receptions, target_share, passing_yards, rushing_yards, receiving_yards, passing_tds, rushing_tds, receiving_tds,
     interceptions, fumbles_lost)
   VALUES (?, ?, ?, 'AAA', 'BBB', 'WR', 0, 0, ?, ?, 0.2, 0, 0, ?, 0, 0, 0, 0, 0)`,
  id, season, week, targets, Math.round(targets * 0.7), yards);

test('no leakage: replaying week w reads no stats from week >= w (adding them changes nothing)',
  { skip: CAL_DB ? 'fixture test runs on a fresh DB only' : false }, () => {
    const ids = [];
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      const r = run(`INSERT INTO players (name, position, gsis_id) VALUES (?, 'WR', ?)`, name, `00-${name}`);
      ids.push(Number(r.lastInsertRowid));
    }
    for (const [i, id] of ids.entries()) {
      for (let wk = 1; wk <= 17; wk++) usage(id, 2025, wk, 5 + i, 50 + 10 * i);
      usage(id, 2026, 1, 6 + i, 60 + 5 * i);
    }
    const snap = m => JSON.stringify([...m].sort((a, b) => a[0] - b[0]));
    // The real readers, with the weekly engine's memo bypassed so a re-read sees the new rows.
    const at = week => { clearRosPriorCache(); return projectionAsOf({ season: 2026, week, readers: {
      ...ASOF_READERS, structural: a => buildPlayerWeekEngine({ ...a, useCache: false })
    } }); };
    const before2 = at(2), before1 = at(1);
    assert.equal(before2.size, ids.length, 'every player gets an as-of rate');
    assert.ok([...before1.values()].every(r => r.source === 'preseason' && r.games === 0), 'week 1 = preseason');
    assert.ok([...before2.values()].every(r => r.source === 'in_season' && r.games === 1), 'week 2 reads week 1');
    // Week 2 and later happen: huge games that would move every number if read.
    for (const id of ids) { usage(id, 2026, 2, 20, 300); usage(id, 2026, 3, 20, 300); }
    assert.equal(snap(at(2)), snap(before2), 'week-2 replay unchanged by week >= 2 stats');
    assert.equal(snap(at(1)), snap(before1), 'week-1 replay unchanged by week >= 1 stats of 2026');
    assert.notEqual(snap(at(3)), snap(before2), 'week 3 does read week 2 (the fixture is live)');
  });

test('asofScale: flag off -> null (old numbers); on -> each pool scaled onto its as-of rate', () => {
  const roster = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const proj = new Map([[1, { ppg: 10 }], [2, { ppg: 8 }], [3, { ppg: 5 }]]);
  const asOf = ({ week }) => new Map([[1, { ppg: 12, source: week > 1 ? 'in_season' : 'preseason' }], [2, { ppg: 4, source: 'preseason' }]]);
  assert.equal(asofScale(roster, proj, { season: 2026, fromWeek: 2, flag: { on: false }, asOf }), null);
  const got = asofScale(roster, proj, { season: 2026, fromWeek: 2, flag: { on: true, preview: false }, asOf });
  assert.deepEqual([...got.scale], [[1, 1.2], [2, 0.5]]);
  assert.deepEqual(got.fields, { projection_basis: 'ros', ros_asof_week: 2, ros_scaled: 2,
    ros_unscaled: 1, ros_preseason: 1, ros_in_season: 1 });
  const preview = asofScale(roster, proj, { season: 2026, fromWeek: 1, flag: { on: true, preview: true },
    basisFlag: { on: true, preview: true }, asOf });
  assert.equal(preview.fields.preview, true);
  assert.match(preview.fields.preview_reason, /RL-17-3.*SIM-CALIB/);
});

test('calibration: out-of-sample weeks 1-2 replay within +-10% of actual; week-3 forward within +-10% of ESPN (local DB copy only)',
  { skip: CAL_DB ? false : 'set GRIDIRON_ASOF_CALIBRATION_DB to a local copy of the live DB' }, () => {
    const lg = row('SELECT * FROM leagues WHERE id = ?', CAL_LEAGUE);
    assert.ok(lg, 'calibration league present');
    const actual = wk => row(`SELECT AVG(points) AS a FROM league_week_scores
                              WHERE league_id = ? AND season = ? AND week = ? AND points > 0`, CAL_LEAGUE, lg.season, wk).a;
    const meanAt = (fromWeek, wk) => {
      const w = sim.tradeImpactWorld(lg, { runs: 300, seed: 12345, fromWeek });
      assert.ok(!w.fail, JSON.stringify(w.fail));
      let s = 0, n = 0;
      for (const weeks of w.points.values()) for (const v of weeks.get(wk)) { s += v; n++; }
      return { mean: s / n, basis: w.base.projection_basis, asofWeek: w.base.ros_asof_week };
    };
    const replay = env => withEnv(env, () => {
      const w1 = meanAt(1, 1), w2 = meanAt(2, 2), f3 = meanAt(3, 3);
      return { w1, w2, f3, ratio: +((w1.mean + w2.mean) / (actual(1) + actual(2))).toFixed(3), fwd: +(f3.mean / ESPN_W3).toFixed(3) };
    });
    const base = replay({ GRIDIRON_SIM_KDST: '1', GRIDIRON_SIM_ASOF_PROJ: '0', GRIDIRON_PREVIEW_UNCONFIRMED: null });
    const asof = replay({ GRIDIRON_SIM_KDST: '1', GRIDIRON_SIM_ASOF_PROJ: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null });
    console.log(`# sim-asof calibration: actual w1 ${actual(1).toFixed(1)} w2 ${actual(2).toFixed(1)}; `
      + `kdst only ${base.w1.mean.toFixed(1)}/${base.w2.mean.toFixed(1)} (${base.ratio}), fwd w3 ${base.f3.mean.toFixed(1)} (${base.fwd}); `
      + `asof ${asof.w1.mean.toFixed(1)}/${asof.w2.mean.toFixed(1)} (${asof.ratio}), fwd w3 ${asof.f3.mean.toFixed(1)} (${asof.fwd})`);
    assert.equal(asof.w1.basis, 'ros');
    assert.deepEqual([asof.w1.asofWeek, asof.w2.asofWeek, asof.f3.asofWeek], [1, 2, 3], 'each replay is as of its own week');
    assert.ok(Math.abs(asof.ratio - 1) <= 0.10, `out-of-sample ratio ${asof.ratio} within +-10%`);
    assert.ok(Math.abs(asof.fwd - 1) <= 0.10, `forward week-3 mean vs ESPN ${asof.fwd} within +-10%`);
    assert.ok(asof.ratio > base.ratio, 'moves toward actual');
  });
