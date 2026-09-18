/**
 * Rest-of-season projection (server/services/ros-projection.js).
 *
 * User journeys this file guards (derived during the ros-projection TDD run):
 *   J1 One big week-1 game does not become a player's rest-of-season rate
 *      (the live bug: free agent Jalen Coker showed ros_ppg 29.9 = his week-1 score).
 *   J2 One dud week does not erase a strong prior (Jaylen Waddle: ros_ppg 2.72, and
 *      the waiver board suggested dropping him).
 *   J3 The update is a transparent, fitted, cutoff-safe formula whose selection and
 *      gate can be re-run: fit on seasons before the graded one, gate pre-registered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ros-projection-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, row } = await import('../server/db/index.js');
// Side-effect import: player_week_usage is created at import time by nflverse.js.
await import('../server/services/nflverse.js');
const { PPR, HALF_PPR, STANDARD } = await import('../server/services/scoring.js');
const {
  evidenceWeight, kFor, rosUpdate, priorFor, fitRosParams, selectRosStructure,
  foldOf, evaluateRosGate, isStandardPpr, inSeasonHistory, buildRosProjections,
  rosPriorMap, clearRosPriorCache, ROS_PARAMS, ROS_ALPHA_GRID, ROS_K_GRID
} = await import('../server/services/ros-projection.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/* ------------------------------------------------------------ the update */

test('evidenceWeight is n/(n+k): 0 with no games, one half when n equals k', () => {
  assert.equal(evidenceWeight(0, 5), 0);
  close(evidenceWeight(3, 3), 0.5);
  close(evidenceWeight(1, 6), 1 / 7);
});

test('kFor reads a per-position k and a global k; an unfitted position has none', () => {
  assert.equal(kFor({ k: 4 }, 'WR'), 4);
  assert.equal(kFor({ k: { QB: 2, RB: 5, WR: 6, TE: 8 } }, 'RB'), 5);
  assert.equal(kFor({ k: { QB: 2, RB: 5, WR: 6, TE: 8 } }, 'K'), null);
  assert.equal(kFor({}, 'WR'), null);
  assert.equal(rosUpdate({ structural: 5, seasonToDate: 5, games: 1, prior: 5, position: 'WR' }, { alpha: 0.5 }), null);
});

test('with no in-season games the update is alpha*structural + (1-alpha)*prior', () => {
  const v = rosUpdate({ structural: 12, seasonToDate: null, games: 0, prior: 8, position: 'WR' }, { alpha: 0.25, k: 5 });
  close(v, 0.25 * 12 + 0.75 * 8);
});

test('J1: one 29.9-point week moves rest-of-season by n/(n+k) of the gap, not all of it', () => {
  const params = { alpha: 0.3, k: { QB: 3, RB: 4, WR: 6, TE: 8 } };
  const v = rosUpdate({ structural: 12, seasonToDate: 29.9, games: 1, prior: 9, position: 'WR' }, params);
  const w = 1 / 7;
  close(v, 0.3 * 12 + 0.7 * (w * 29.9 + (1 - w) * 9));
  assert.ok(v < 15, `one big week should not make him a WR1 (got ${v})`);
});

test('J2: one 2.72-point dud leaves a strong prior mostly intact', () => {
  const params = { alpha: 0.3, k: { QB: 3, RB: 4, WR: 6, TE: 8 } };
  const v = rosUpdate({ structural: 13, seasonToDate: 2.72, games: 1, prior: 14, position: 'WR' }, params);
  assert.ok(v > 11, `one dud should not crater a strong prior (got ${v})`);
});

test('as games accumulate with alpha 0, the update converges on season-to-date', () => {
  const v = rosUpdate({ structural: 10, seasonToDate: 20, games: 1000, prior: 5, position: 'RB' }, { alpha: 0, k: 3 });
  assert.ok(Math.abs(v - 20) < 0.05);
});

test('missing inputs fall back instead of producing NaN', () => {
  const params = { alpha: 0.5, k: 4 };
  // no prior: the structural head stands in for it
  close(rosUpdate({ structural: 10, seasonToDate: 14, games: 2, prior: null, position: 'WR' }, params),
    0.5 * 10 + 0.5 * ((2 / 6) * 14 + (4 / 6) * 10));
  // no structural head: the prior stands in for it
  close(rosUpdate({ structural: undefined, seasonToDate: 14, games: 2, prior: 8, position: 'WR' }, params),
    0.5 * 8 + 0.5 * ((2 / 6) * 14 + (4 / 6) * 8));
  // neither, but he has played: his own rate
  close(rosUpdate({ structural: NaN, seasonToDate: 14, games: 2, prior: null, position: 'WR' }, params), 14);
  // nothing at all
  assert.equal(rosUpdate({ structural: null, seasonToDate: null, games: 0, prior: null, position: 'WR' }, params), null);
  // a position the fit does not cover
  assert.equal(rosUpdate({ structural: 5, seasonToDate: 5, games: 1, prior: 5, position: 'K' },
    { alpha: 0.5, k: { QB: 1, RB: 1, WR: 1, TE: 1 } }), null);
});

test('priorFor: the market prior falls back to the structural preseason prior; c_struct never reads the market', () => {
  assert.equal(priorFor({ c_mkt: 11, c_struct: 9 }, 'c_mkt'), 11);
  assert.equal(priorFor({ c_mkt: null, c_struct: 9 }, 'c_mkt'), 9);
  assert.equal(priorFor({ c_mkt: 11, c_struct: 9 }, 'c_struct'), 9);
  assert.equal(priorFor({ c_mkt: 11, c_struct: null }, 'c_struct'), null);
});

/* ---------------------------------------------------------------- fitting */

// Synthetic rows whose truth is known: `actual` equals exactly one of the inputs.
function synthRows(truth, { n = 120, positions = ['QB', 'RB', 'WR', 'TE'] } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const position = positions[i % positions.length];
    const r = {
      player_id: 1000 + i, position, n: 1 + (i % 5),
      structural: 6 + ((i * 7) % 11), std: 3 + ((i * 13) % 17), c_mkt: 5 + ((i * 5) % 13), c_struct: 4 + ((i * 3) % 9)
    };
    const t = typeof truth === 'function' ? truth(r) : truth;
    r.actual = t === 'prior' ? r.c_mkt : t === 'c_struct' ? r.c_struct : t === 'std' ? r.std : r.structural;
    out.push(r);
  }
  return out;
}

test('fitRosParams: prior-perfect data picks alpha 0 and the largest k', () => {
  const fit = fitRosParams(synthRows('prior'), { prior: 'c_mkt', perPosition: false });
  assert.equal(fit.alpha, 0);
  assert.equal(fit.k, ROS_K_GRID.at(-1));
  assert.equal(fit.prior, 'c_mkt');
});

test('fitRosParams: season-to-date-perfect data picks alpha 0 and the smallest k', () => {
  const fit = fitRosParams(synthRows('std'), { prior: 'c_mkt', perPosition: false });
  assert.equal(fit.alpha, 0);
  assert.equal(fit.k, ROS_K_GRID[0]);
});

test('fitRosParams: structural-perfect data picks alpha 1', () => {
  const fit = fitRosParams(synthRows('structural'), { prior: 'c_mkt', perPosition: false });
  assert.equal(fit.alpha, ROS_ALPHA_GRID.at(-1));
  assert.equal(fit.mae, 0);
});

test('fitRosParams per position fits each position its own k under one shared alpha', () => {
  const rows = synthRows(r => (r.position === 'RB' ? 'prior' : r.position === 'WR' ? 'std' : 'prior'));
  const fit = fitRosParams(rows, { prior: 'c_mkt', perPosition: true });
  assert.equal(fit.alpha, 0);
  assert.equal(fit.k.RB, ROS_K_GRID.at(-1));
  assert.equal(fit.k.WR, ROS_K_GRID[0]);
  assert.deepEqual(Object.keys(fit.k).sort(), ['QB', 'RB', 'TE', 'WR']);
});

test('foldOf is a deterministic two-way split by player that fills both folds', () => {
  const folds = Array.from({ length: 200 }, (_, i) => foldOf(i + 1));
  assert.deepEqual(folds, Array.from({ length: 200 }, (_, i) => foldOf(i + 1)));
  assert.ok(folds.every(f => f === 0 || f === 1));
  assert.ok(folds.filter(f => f === 0).length > 50 && folds.filter(f => f === 1).length > 50);
});

test('selectRosStructure picks the prior that is actually right, by held-out players', () => {
  const sel = selectRosStructure(synthRows('c_struct', { n: 240 }));
  assert.equal(sel.params.prior, 'c_struct');
  assert.equal(sel.cv.length, 4);
  assert.ok(sel.cv.every(c => Number.isFinite(c.cv_mae)));
});

/* ------------------------------------------------------------------- gate */

// Per-(season, w) error rows for (a) and (d) on the same players.
function gateRows(seasons, errFor) {
  const out = [];
  for (const season of seasons) {
    for (const w of [1, 2, 3, 4, 6, 8, 10]) {
      for (let p = 0; p < 150; p++) {
        const base = 3 + ((p * 7 + w) % 9);
        out.push({ season, w, player_id: p, err_a: base, err_d: errFor(base, w, p, season) });
      }
    }
  }
  return out;
}

test('evaluateRosGate passes when d is clearly better early and equal late in both seasons', () => {
  const g = evaluateRosGate(gateRows([2024, 2025], (b, w) => (w <= 4 ? b - 1 : b)));
  assert.equal(g.pass, true);
});

test('evaluateRosGate fails when d is significantly worse at w >= 6', () => {
  const g = evaluateRosGate(gateRows([2024, 2025], (b, w) => (w <= 4 ? b - 1 : b + 1)));
  assert.equal(g.pass, false);
  assert.ok(g.checks.some(c => c.rule === 'late_not_worse' && !c.ok));
});

test('evaluateRosGate fails when d loses a single early week even if it wins pooled', () => {
  const g = evaluateRosGate(gateRows([2024, 2025], (b, w) => (w === 4 ? b + 0.2 : w <= 3 ? b - 1 : b)));
  assert.equal(g.pass, false);
  assert.ok(g.checks.some(c => c.rule === 'early_direction' && c.w === 4 && !c.ok));
});

test('evaluateRosGate fails when a validation season is missing', () => {
  const g = evaluateRosGate(gateRows([2024], (b, w) => (w <= 4 ? b - 1 : b)));
  assert.equal(g.pass, false);
});

/* ------------------------------------------------------------ live inputs */

test('isStandardPpr: only full PPR can use the PPR market prior', () => {
  assert.equal(isStandardPpr(PPR), true);
  assert.equal(isStandardPpr({ ...PPR }), true);
  assert.equal(isStandardPpr(HALF_PPR), false);
  assert.equal(isStandardPpr(STANDARD), false);
});

function addPlayer(name, position) {
  run('INSERT INTO players (name, position, fantasy_relevant) VALUES (?,?,1)', name, position);
  return row('SELECT id FROM players WHERE name = ?', name).id;
}
function usage(playerId, season, week, { receptions = 0, receiving_yards = 0, receiving_tds = 0 } = {}) {
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, receptions, receiving_yards, receiving_tds, targets)
       VALUES (?,?,?,'CAR','WR',?,?,?,?)`, playerId, season, week, receptions, receiving_yards, receiving_tds, receptions + 2);
}

test('inSeasonHistory counts only this season before the target week, scored by the league', () => {
  const id = addPlayer('History Receiver', 'WR');
  usage(id, 2025, 17, { receptions: 10, receiving_yards: 100 });      // prior season: ignored
  usage(id, 2026, 1, { receptions: 8, receiving_yards: 99, receiving_tds: 1 }); // 8 + 9.9 + 6 = 23.9 PPR
  usage(id, 2026, 2, { receptions: 2, receiving_yards: 20 });          // the target week: ignored
  const h = inSeasonHistory(2026, 2, { scoring: PPR }).get(id);
  assert.equal(h.games, 1);
  close(h.season_to_date, 23.9, 1e-6);
  const half = inSeasonHistory(2026, 2, { scoring: HALF_PPR }).get(id);
  close(half.season_to_date, 19.9, 1e-6);
});

test('buildRosProjections: players who have played get the fitted update; the rest are left to the caller', () => {
  const params = { prior: 'c_mkt', alpha: 0.3, k: { QB: 3, RB: 4, WR: 6, TE: 8 } };
  const weekly = new Map([
    [1, { position: 'WR', structural_ppg: 12, ppg: 29.9 }],   // played week 1, big game
    [2, { position: 'WR', structural_ppg: 13, ppg: 2.72 }],   // played week 1, dud
    [3, { position: 'RB', structural_ppg: 10, ppg: 10 }],     // has not played this season
    [4, { position: 'K', structural_ppg: 8, ppg: 8 }]         // position the fit does not cover
  ]);
  const history = new Map([[1, { games: 1, season_to_date: 29.9 }], [2, { games: 1, season_to_date: 2.72 }],
    [4, { games: 1, season_to_date: 9 }]]);
  const priors = new Map([[1, { c_mkt: 9, c_struct: 8 }], [2, { c_mkt: 14, c_struct: 13 }], [3, { c_mkt: 11, c_struct: 10 }]]);
  const out = buildRosProjections({ season: 2026, week: 2, weekly, params, priors, history });

  const coker = out.get(1);
  close(coker.ros_ppg, rosUpdate({ structural: 12, seasonToDate: 29.9, games: 1, prior: 9, position: 'WR' }, params), 1e-9);
  assert.equal(coker.games, 1);
  assert.equal(coker.prior, 9);
  assert.equal(coker.prior_source, 'c_mkt');
  assert.ok(coker.ros_ppg < 15);
  assert.ok(out.get(2).ros_ppg > 11);
  // outside the graded population (no in-season game yet, or an unfitted position):
  // no entry, so trade-engine keeps its existing number for them
  assert.equal(out.has(3), false);
  assert.equal(out.has(4), false);
});

test('the shipped fit is the gated one: market prior, one k, alpha in [0,1]', () => {
  assert.equal(ROS_PARAMS.prior, 'c_mkt');
  assert.ok(ROS_K_GRID.includes(ROS_PARAMS.k));
  assert.ok(ROS_ALPHA_GRID.includes(ROS_PARAMS.alpha));
  assert.ok(Object.isFrozen(ROS_PARAMS));
});

test('rosPriorMap: the structural prior uses last season only; no board on file means no market prior', () => {
  clearRosPriorCache();
  const id = addPlayer('Prior Receiver', 'WR');
  for (let week = 1; week <= 6; week++) usage(id, 2025, week, { receptions: 6, receiving_yards: 70 });
  usage(id, 2026, 1, { receptions: 12, receiving_yards: 200, receiving_tds: 3 }); // in-season: must not leak in
  const priors = rosPriorMap(2026, { scoring: PPR });
  const p = priors.get(id);
  assert.ok(p, 'a player with last-season history has a prior');
  assert.equal(p.c_mkt, null, 'no draft board in this database');
  assert.ok(Number.isFinite(p.c_struct) && p.c_struct > 0 && p.c_struct < 20,
    `prior ${p.c_struct} should reflect 2025 (13 PPR/game), not the 50-point 2026 week`);
  assert.equal(rosPriorMap(2026, { scoring: PPR }), priors, 'memoised per season and scoring');
  assert.notEqual(rosPriorMap(2026, { scoring: HALF_PPR }), priors, 'a different scoring is a different prior');
});

test('buildRosProjections without params returns an empty map (nothing ships unfitted)', () => {
  const out = buildRosProjections({ season: 2026, week: 2, weekly: new Map([[1, { position: 'WR', structural_ppg: 12 }]]),
    params: null, priors: new Map(), history: new Map([[1, { games: 1, season_to_date: 20 }]]) });
  assert.equal(out.size, 0);
});
