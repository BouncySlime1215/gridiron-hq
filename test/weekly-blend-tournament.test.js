/**
 * BLEND-01: the tournament's study library (scripts/weekly-blend-tournament-lib.mjs) and the
 * runner's pure pieces (scripts/weekly-blend-tournament.mjs).
 *
 * What these tests pin (docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md):
 *   - the fits: Stock-Watson lambda with T = slates, the simplex weight, C5's cells shrinking to
 *     the pooled weight, C6's encompassing slope and its proven gate;
 *   - the grade: startSitPairAccuracy's pair score, pairs never cross a season, week or
 *     position, the decision grade on disagreements only, the player bootstrap;
 *   - the rules: good, the ladder and the complexity rule, the late-news layer, the ship rule;
 *   - the runner: 2025 refused, ESPN's archive parsed as projections only, one value per player,
 *     and our number rebuilt as S-03 serves it.
 * Pure functions only: no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCHEDULER_DISABLED = '1';
const lib = await import('../scripts/weekly-blend-tournament-lib.mjs');
const runner = await import('../scripts/weekly-blend-tournament.mjs');
const { blendWeekPoints } = await import('../server/services/weekly-blend.js');
const { startSitPairAccuracy } = await import('../scripts/promote-early-week-weights.mjs');

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

/** Rows where actual = a*ours + (1-a)*espn exactly, over `weeks` slates of one season. */
function exactRows(a, { weeks = 10, perWeek = 12, season = 2022, position = 'WR', seed = 7 } = {}) {
  const rand = lib.seededRandom(seed);
  const out = [];
  for (let w = 2; w < 2 + weeks; w++) {
    for (let k = 0; k < perWeek; k++) {
      const ours = 4 + 16 * rand(), espn = 4 + 16 * rand();
      out.push({ season, week: w, position, player_id: 1000 * w + k, ours, espn, actual: a * ours + (1 - a) * espn, played: true });
    }
  }
  return out;
}

test('Stock-Watson lambda counts slates: 0 until T - K - 1 > 0, then 1 - 2/(T - 3)', () => {
  assert.equal(lib.stockWatsonLambda(3), 0);
  assert.equal(lib.stockWatsonLambda(4), 0);
  assert.equal(lib.stockWatsonLambda(5), 0);
  near(lib.stockWatsonLambda(6), 1 / 3);
  near(lib.stockWatsonLambda(16), 1 - 2 / 13);
  near(lib.stockWatsonLambda(48), 1 - 2 / 45);
  assert.equal(lib.slates([{ season: 2022, week: 2 }, { season: 2022, week: 2 }, { season: 2023, week: 2 }]), 2);
});

test('fit rows: an ESPN value, ours >= 4, a graded position', () => {
  const rows = [
    { position: 'WR', ours: 5, espn: 6 }, { position: 'WR', ours: 3.99, espn: 6 },
    { position: 'WR', ours: 5, espn: null }, { position: 'K', ours: 9, espn: 8 }, { position: 'TE', ours: 4, espn: 0 }
  ];
  assert.deepEqual(lib.fitRowsOf(rows).map(r => r.position), ['WR', 'TE']);
});

test('C4: the simplex weight recovers an exact blend, then shrinks toward 50/50 by lambda', () => {
  const rows = exactRows(0.3, { weeks: 10 });
  near(lib.simplexWeight(rows), 0.3, 1e-3);
  const fit = lib.fitShrunkWeight(rows);
  assert.equal(fit.T, 10);
  near(fit.lambda, 1 - 2 / 7);
  near(fit.w, fit.lambda * fit.w_hat + (1 - fit.lambda) * 0.5);
  assert.ok(fit.w > 0.3 && fit.w < 0.5, 'shrunk between the fit and 50/50');
});

test('C5: a cell with too few slates is its pooled weight; a well-sampled cell moves toward its own fit', () => {
  // WR over two seasons of weeks 2-13: the 9-13 cell has 10 slates (lambda 1 - 2/7); QB has weeks 2-4 of one season.
  const rows = [...exactRows(0.8, { weeks: 3, position: 'QB' }), ...exactRows(0.2, { weeks: 12, position: 'WR', seed: 3 }),
    ...exactRows(0.2, { weeks: 12, position: 'WR', season: 2023, seed: 4 })];
  const fit = lib.fitPosPhase(rows, 0.5);
  near(fit.w.QB['2-4'], 0.5);                      // weeks 2-4: T = 3, lambda 0
  assert.equal(fit.cells.QB['2-4'].T, 3);
  near(fit.w.TE['2-4'], 0.5);                      // no rows at all: the pooled weight
  assert.equal(fit.cells.WR['9-13'].T, 10);
  near(fit.cells.WR['9-13'].lambda, 1 - 2 / 7, 1e-4);
  assert.ok(fit.w.WR['9-13'] < 0.5, `WR 9-13 ${fit.w.WR['9-13']} moves toward 0.2`);
  near(fit.w.WR['9-13'], fit.cells.WR['9-13'].lambda * fit.cells.WR['9-13'].w_hat + (1 - fit.cells.WR['9-13'].lambda) * 0.5, 1e-4);
});

test('C6: the encompassing slope, proven only when its lower bound clears 0', () => {
  const strong = exactRows(0.4, { weeks: 12, position: 'RB' });
  near(lib.disagreementSlope(strong), 0.4);
  // Noise: the actual is ESPN plus a miss that ignores our disagreement.
  const rand = lib.seededRandom(11);
  const noise = strong.map(r => ({ ...r, position: 'TE', actual: r.espn + (rand() - 0.5) * 20 }));
  const fit = lib.fitEspnProven([...strong, ...noise], { iterations: 300 });
  const rb = fit.cells.RB['9-13'];
  assert.equal(rb.proven, true);
  near(fit.b.RB['9-13'], 0.4, 1e-4);
  assert.equal(rb.clears_plan_bar_0_3, true);
  const te = fit.cells.TE['9-13'];
  assert.equal(te.proven, false, `TE slope ${te.b_hat} CI ${te.ci90}`);
  assert.equal(fit.b.TE['9-13'], 0);
  assert.equal(fit.b.QB['2-4'], 0);               // an empty cell is ESPN alone
});

test('pairs never cross a season, week or position, and the pair score is startSitPairAccuracy\'s', () => {
  const rows = [
    { season: 2023, week: 5, position: 'WR', player_id: 1, ours: 9, actual: 1 },
    { season: 2023, week: 5, position: 'WR', player_id: 2, ours: 8, actual: 2 },
    { season: 2023, week: 5, position: 'RB', player_id: 3, ours: 9, actual: 3 },
    { season: 2024, week: 5, position: 'WR', player_id: 4, ours: 9, actual: 4 },
    { season: 2023, week: 6, position: 'WR', player_id: 5, ours: 9, actual: 5 },
    { season: 2023, week: 5, position: 'WR', player_id: 6, ours: 3, actual: 6 }
  ];
  const pairs = lib.enumeratePairs(rows, r => r.ours >= 4);
  assert.deepEqual([...pairs.a].map((a, k) => [a, pairs.b[k]]), [[0, 1]]);
  assert.equal(pairs.players, 6);
  assert.equal(lib.pairScore(9, 8, 1, 2), 0);
  assert.equal(lib.pairScore(9, 8, 2, 1), 1);
  assert.equal(lib.pairScore(9, 9, 2, 1), 0.5);
  assert.equal(lib.pairScore(9, 8, 2, 2), 0.5);
});

test('comparePreds: pair accuracy, the paired difference and the decision grade, by hand', () => {
  const rows = [
    { season: 2023, week: 5, position: 'WR', player_id: 1, actual: 10 },
    { season: 2023, week: 5, position: 'WR', player_id: 2, actual: 20 },
    { season: 2023, week: 5, position: 'WR', player_id: 3, actual: 5 }
  ];
  const X = [8, 12, 6];   // orders 2 > 1 > 3: all three pairs right
  const Y = [12, 8, 6];   // orders 1 > 2 > 3: pair (1,2) wrong
  const pairs = lib.enumeratePairs(rows, () => true);
  const draws = lib.playerDraws(pairs.players, { iterations: 200 });
  const c = lib.comparePreds(rows, pairs, X, Y, draws);
  assert.equal(c.pairs, 3);
  near(c.pa_x, 1);
  near(c.pa_y, 0.6667, 1e-4);
  near(c.pa_diff, 0.3333, 1e-4);
  assert.equal(c.decisions.n, 1);                 // they disagree on (1,2) only
  near(c.decisions.points_per_decision, 10);      // X picks player 2 (20) over player 1 (10)
  near(c.decisions.win_rate, 1);
  assert.ok(Array.isArray(c.pa.ci90) && c.pa.mde80 != null);
  // Ties in either projection are not a disagreement.
  const tie = lib.comparePreds(rows, pairs, [8, 8, 6], Y, draws);
  assert.equal(tie.decisions.n, 0);
});

test('the pair enumeration agrees with startSitPairAccuracy on the same universe', () => {
  const rand = lib.seededRandom(5);
  const rows = [];
  for (const season of [2023, 2024]) for (let w = 2; w <= 5; w++) for (const pos of ['WR', 'RB']) {
    for (let k = 0; k < 9; k++) {
      rows.push({ season, week: w, position: pos, player_id: `${pos}${k}`, ours: 2 + 14 * rand(), espn: 2 + 14 * rand(),
        actual: Math.round(20 * rand()) });
    }
  }
  const preds = { ours: rows.map(r => r.ours), espn: rows.map(r => r.espn) };
  const universe = r => r.ours >= 4;
  const pairs = lib.enumeratePairs(rows, universe);
  const draws = lib.playerDraws(pairs.players, { iterations: 50 });
  const c = lib.comparePreds(rows, pairs, preds.espn, preds.ours, draws);
  const house = lib.pairAccuracyParity(rows, preds, universe, ['ours', 'espn']);
  assert.equal(house.pairs, c.pairs);
  near(house.accuracy.espn, c.pa_x, 1e-4);
  near(house.accuracy.ours, c.pa_y, 1e-4);
  // Without the season in the key, weeks of two seasons would pool: the parity keys on season:week.
  const pooled = startSitPairAccuracy(rows.filter(universe).map(r => ({ ...r, preds: { ours: r.ours } })), ['ours'], { threshold: -Infinity });
  assert.ok(pooled.pairs > c.pairs, 'a week-only key pools two seasons');
  near(lib.winRateParity(rows, preds, universe, 'espn', 'ours'), c.decisions.win_rate, 1e-4);
});

test('the player bootstrap is reproducible and each draw resamples every player once in total', () => {
  const a = lib.playerDraws(7, { iterations: 3, seed: 9 });
  const b = lib.playerDraws(7, { iterations: 3, seed: 9 });
  assert.deepEqual(a.map(m => [...m]), b.map(m => [...m]));
  for (const m of a) assert.equal([...m].reduce((s, x) => s + x, 0), 7);
});

const cmp = (paDiff, lo, { mde = 0.01, pts = 1, paX = 0.6 } = {}) =>
  ({ pa_diff: paDiff, pa_x: paX, pa: { ci90: [lo, lo + 0.02], mde80: mde }, decisions: { points_per_decision: pts } });

test('selection: none good is ours; the first good rung wins; climbing needs more than the MDE', () => {
  assert.equal(lib.selectWinner({ espn: cmp(0.01, -0.001), half: cmp(-0.01, -0.02) }, () => null).winner, 'ours');
  const vs = { espn: cmp(0.02, 0.01, { paX: 0.66 }), half: cmp(0.03, 0.02, { paX: 0.67 }), fit_shrunk: cmp(0.035, 0.025, { paX: 0.675 }),
    pos_phase: cmp(0.05, 0.04, { paX: 0.69 }), news: cmp(-0.001, -0.004), espn_proven: cmp(0.001, -0.002) };
  const between = (x, y) => ({ pa_diff: vs[x].pa_x - vs[y].pa_x, pa: { mde80: 0.011 } });
  const sel = lib.selectWinner(vs, between);
  // half beats espn on the same rung; fit_shrunk's 0.005 over half is under the MDE; pos_phase's 0.02 is over it.
  assert.equal(sel.winner, 'pos_phase');
  assert.deepEqual(sel.steps.map(s => s.step), ['first good on the ladder', 'same rung, lower pair accuracy', 'climb', 'climb']);
  assert.equal(sel.steps[0].champion, 'half');
  assert.equal(sel.steps[2].replaces, false);
  assert.equal(sel.steps[3].replaces, true);
  assert.deepEqual(sel.good.sort(), ['espn', 'fit_shrunk', 'half', 'pos_phase']);
});

test('the late-news layer is tested only on a blend winner with a good switch, and adopted past its MDE', () => {
  const good = { news: cmp(0.01, 0.002) };
  assert.equal(lib.layerDecision('espn', good, null).tested, false);
  assert.equal(lib.layerDecision('half', { news: cmp(0.01, -0.001) }, null).tested, false);
  assert.throws(() => lib.layerDecision('half', good, null), /layered comparison is required/);
  assert.equal(lib.layerDecision('half', good, { pa_diff: 0.02, pa: { mde80: 0.01 } }).adopt, true);
  assert.equal(lib.layerDecision('half', good, { pa_diff: 0.005, pa: { mde80: 0.01 } }).adopt, false);
});

test('the ship rule: good on history, points above 0, and holds forward; otherwise declined or unconfirmed', () => {
  assert.deepEqual(lib.shipDecision('ours', null, null).verdict, 'declined');
  assert.equal(lib.shipDecision('half', cmp(0.01, -0.001), cmp(0.02, 0.01)).verdict, 'declined');
  assert.equal(lib.shipDecision('half', cmp(0.01, 0.001, { pts: 0 }), cmp(0.02, 0.01)).verdict, 'declined');
  assert.equal(lib.shipDecision('half', cmp(0.01, 0.001), cmp(-0.02, -0.1)).verdict, 'unconfirmed forward');
  assert.equal(lib.shipDecision('half', cmp(0.01, 0.001), cmp(0.02, -0.1, { pts: -0.5 })).verdict, 'unconfirmed forward');
  assert.equal(lib.shipDecision('half', cmp(0.01, 0.001), null).verdict, 'unconfirmed forward');
  const on = lib.shipDecision('half', cmp(0.01, 0.001), cmp(0.02, -0.1));
  assert.equal(on.on, true);
  assert.equal(on.verdict, 'shipped');
});

test('predict is the served blendWeekPoints, with each candidate\'s own parameters', () => {
  const row = { ours: 10, espn: 16, position: 'WR', week: 6, report_status: null, bye: false };
  const params = { fit_shrunk: { w: 0.25 } };
  assert.equal(lib.predict(row, 'fit_shrunk', params),
    blendWeekPoints({ ours: 10, espn: 16, position: 'WR', week: 6, reportStatus: null, bye: false }, { candidate: 'fit_shrunk', params: { w: 0.25 } }).ppg);
  assert.equal(lib.predict({ ...row, report_status: 'Out' }, 'half', null, { newsLayer: true }), 16);
  assert.equal(lib.predict({ ...row, bye: true }, 'espn', null), 0);
});

test('the runner refuses 2025, parses ESPN projections only, and keeps one value per player', () => {
  assert.throws(() => runner.refuseHoldout(2025), /used-up holdout/);
  assert.equal(runner.refuseHoldout(2024), 2024);
  const json = { players: [
    { player: { id: 11, defaultPositionId: 3, stats: [
      { seasonId: 2023, scoringPeriodId: 5, statSourceId: 1, statSplitTypeId: 1, appliedTotal: 14.2 },
      { seasonId: 2023, scoringPeriodId: 5, statSourceId: 0, statSplitTypeId: 1, appliedTotal: 30 },   // actual
      { seasonId: 2023, scoringPeriodId: 0, statSourceId: 1, statSplitTypeId: 0, appliedTotal: 250 },  // season total
      { seasonId: 2022, scoringPeriodId: 5, statSourceId: 1, statSplitTypeId: 1, appliedTotal: 9 }      // other season
    ] } },
    { player: { id: 12, defaultPositionId: 5, stats: [
      { seasonId: 2023, scoringPeriodId: 5, statSourceId: 1, statSplitTypeId: 1, appliedTotal: 8 } ] } }   // a kicker
  ] };
  const parsed = runner.parseEspnArchive(json, 2023);
  assert.deepEqual([...parsed.byEspnWeek.entries()], [['11|5', 14.2]]);
  assert.equal(parsed.players, 1);
  const one = runner.oneValuePerPlayer([{ id: 1, v: 5 }, { id: 1, v: 5.005 }, { id: 2, v: 3 }, { id: 2, v: 4 }, { id: 3, v: null }], 'id', 'v');
  assert.deepEqual([...one.values.entries()], [['1', 5]]);
  assert.equal(one.conflicting, 1);
});

test('our number is rebuilt as S-03 serves it: structural plus the correction, else the ensemble', () => {
  const deps = {
    weeklyExpertValues: proj => (proj.noExperts ? null : { ensemble_shift: proj.ppg - proj.structural_ppg }),
    coordinateFantasy: (fit, experts, base) => (fit.ready ? { ready: true, corrected_ppg: base + fit.shift } : { ready: false })
  };
  const proj = { ppg: 12, structural_ppg: 10 };
  const ctx = { season: 2024, week: 6, scoring: null };
  assert.deepEqual(runner.servedBaseFor(proj, { ready: true, shift: -0.5 }, ctx, deps), { base: 9.5, arm: 'S1' });
  assert.deepEqual(runner.servedBaseFor(proj, { ready: false }, ctx, deps), { base: 12, arm: 'A' });
  assert.deepEqual(runner.servedBaseFor({ ...proj, noExperts: true }, { ready: true, shift: -0.5 }, ctx, deps), { base: 12, arm: 'A' });
  assert.deepEqual(runner.servedBaseFor({ ppg: 12, structural_ppg: null }, { ready: true, shift: -0.5 }, ctx, deps), { base: 12, arm: 'A' });
  assert.deepEqual(runner.servedBaseFor({ ppg: null }, { ready: true, shift: -0.5 }, ctx, deps), { base: null, arm: null });
});

test('the availability diagnostic grades our base without the chance to play, on the primary pairs', () => {
  // Two healthy WRs whose chance to play differs (0.5 vs 0.9) and one ruled Out: the multiplier
  // flips the healthy pair; the base alone gets it right; keeping p only for the designated
  // player keeps the Out call.
  const rows = [
    { season: 2023, week: 5, position: 'WR', player_id: 1, base: 12, p: 0.5, report_status: null, bye: false, played: true, actual: 15 },
    { season: 2023, week: 5, position: 'WR', player_id: 2, base: 10, p: 0.9, report_status: null, bye: false, played: true, actual: 9 },
    { season: 2023, week: 5, position: 'WR', player_id: 3, base: 11, p: 0.1, report_status: 'Out', bye: false, played: false, actual: 0 }
  ];
  for (const r of rows) { r.ours = r.base * r.p; r.espn = r.actual + 1; }
  const preds = { ours: rows.map(r => r.ours), espn: rows.map(r => r.espn) };
  const pairs = lib.enumeratePairs(rows, () => true);
  const draws = lib.playerDraws(pairs.players, { iterations: 50 });
  const d = lib.availabilityDiagnostic(rows, pairs, draws, preds);
  assert.match(d.note, /not pre-registered/);
  near(d.base_only_vs_ours.pa_x, 2 / 3, 1e-4);        // base alone: (1,2) right, (1,3) right, (2,3) wrong
  near(d.base_only_vs_ours.pa_y, 2 / 3, 1e-4);        // ours: (1,2) wrong, (1,3) right, (2,3) right
  near(d.designated_only_vs_ours.pa_x, 1, 1e-4);      // p only for the Out player: all three right
  assert.deepEqual(d.startable_no_designation, { rows: 2, mean_p: 0.7, played_share: 1 });
});
