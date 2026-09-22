/**
 * S-02: the study that grades the served weekly construction must build each arm from
 * the SERVED functions, in the served order, and grade it by the pre-registered rule
 * (docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md).
 *
 * What these tests pin:
 *   - the study's dependencies ARE the served functions (identity, not copies);
 *   - arm B adds the coordinator correction to the ENSEMBLE base, as trade-engine.js:354
 *     does, and S1 to the structural base, as the fit was gated (fantasy-coordinator.js:324);
 *   - the lifted arms equal lineup-brain.js#startSitWeekPoints on the same input, through
 *     the real vegasLift (RB split included), with only the game-script model mocked;
 *   - the ship rule is matchups.js:33-35 exactly, and a decline carries its MDE;
 *   - the harness guards (k control, fit cutoff) stop the run.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weekly-construction-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db } = await import('../server/db/index.js');

// The game-script model under the real vegasLift and the real weeklyExpertValues: pass
// and rush differ so the RB 0.65/0.35 split is visible in the multiplier.
const MULTS = { HI: { pass: 1.2, rush: 0.8 }, LO: { pass: 0.9, rush: 1.1 } };
const realGameScript = await import('../server/services/gamescript.js');
mock.module('../server/services/gamescript.js', {
  namedExports: {
    ...realGameScript,
    gameScriptFor: team => (MULTS[team]
      ? { pass_mult: MULTS[team].pass, rush_mult: MULTS[team].rush, line: { spread: -3, total: 47, opponent: 'OPP', home: true } }
      : { pass_mult: 1, rush_mult: 1, line: null })
  }
});
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const lib = await import('../scripts/weekly-construction-grade-lib.mjs');
const coordinator = await import('../server/services/fantasy-coordinator.js');
const waiverBrain = await import('../server/services/waiver-brain.js');
const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const { predictionWeightedMedianRatio } = await import('../server/services/level-information-decomposition.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Deterministic pseudo-random numbers, so the synthetic fit is the same on every run.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; };
}
function syntheticExamples(n = 320) {
  const r = lcg(7);
  const out = [];
  for (let i = 0; i < n; i++) {
    const shift = (r() - 0.5) * 6;
    const script = (r() - 0.5) * 2;
    out.push({
      season: 2022 + (i % 3), week: 1 + (i % 17), player_id: i, team: 'AAA', opponent: 'BBB',
      market_spread: null, market_total: null,
      target: 1.5 + 0.8 * shift + 0.5 * script + (r() - 0.5) * 3,
      experts: { ensemble_shift: shift, game_script_delta: script, boom_bust_signal: null }
    });
  }
  return out;
}
const FIT = coordinator.fitFantasyCoordinator(syntheticExamples());
const EXPERTS = { ensemble_shift: 2.4, game_script_delta: 0.3, boom_bust_signal: null };
const stubExperts = { ...lib.SERVED, weeklyExpertValues: () => EXPERTS };
const proj = (position, team, { ppg = 14.4, structural = 12.0 } = {}) =>
  ({ position, team, ppg, structural_ppg: structural, params: {}, ensemble_shift: +(ppg - structural).toFixed(4) });
const CTX = { season: 2025, week: 6, scoring: undefined, fitS: FIT, fitE: FIT, lambda: 0.5 };

test('the synthetic fit is ready and moves the number (known-nonzero control)', () => {
  assert.equal(FIT.ready, true);
  const correction = coordinator.coordinateFantasy(FIT, EXPERTS, 0).correction;
  assert.ok(Math.abs(correction) > 0.1, `correction ${correction} should be visibly nonzero`);
});

test('the study calls the served functions, not copies', () => {
  assert.equal(lib.SERVED.weeklyExpertValues, coordinator.weeklyExpertValues);
  assert.equal(lib.SERVED.coordinateFantasy, coordinator.coordinateFantasy);
  assert.equal(lib.SERVED.vegasLift, waiverBrain.vegasLift);
  assert.equal(lib.SERVED.fitFantasyCoordinator, coordinator.fitFantasyCoordinator);
  assert.equal(lib.SERVED.buildFantasyCoordinatorExamples, coordinator.buildFantasyCoordinatorExamples);
});

test('arm B adds the correction to the ENSEMBLE base (trade-engine.js:354); S1 to the structural base', () => {
  const p = proj('WR', null);
  const correction = coordinator.coordinateFantasy(FIT, EXPERTS, 0).correction;
  const arms = lib.constructArms(p, CTX, stubExperts);
  assert.equal(arms.A, 14.4);
  assert.ok(Math.abs(arms.B - (14.4 + correction)) < 0.0006, `B ${arms.B} vs ensemble + correction ${14.4 + correction}`);
  assert.ok(Math.abs(arms.S1 - (12.0 + correction)) < 0.0006, `S1 ${arms.S1} vs structural + correction ${12.0 + correction}`);
  assert.notEqual(arms.B, arms.S1);
});

test('arm S2 uses its own fit on the ensemble base', () => {
  const other = coordinator.fitFantasyCoordinator(syntheticExamples().map(e => ({ ...e, target: e.target - 5 })));
  const arms = lib.constructArms(proj('WR', null), { ...CTX, fitE: other }, stubExperts);
  const expected = coordinator.coordinateFantasy(other, EXPERTS, 14.4).corrected_ppg;
  assert.equal(arms.S2, expected);
  assert.notEqual(arms.S2, arms.B);
});

test('an unready fit falls back to the base, as trade-engine.js:355 does', () => {
  const arms = lib.constructArms(proj('WR', null), { ...CTX, fitS: { ready: false }, fitE: { ready: false } }, stubExperts);
  assert.equal(arms.B, 14.4);
  assert.equal(arms.S1, 12.0);
  assert.equal(arms.S2, 14.4);
});

test('no expert values (no params) means no correction, as trade-engine.js:353-354', () => {
  const arms = lib.constructArms(proj('WR', null), CTX, { ...lib.SERVED, weeklyExpertValues: () => null });
  assert.equal(arms.B, 14.4);
  assert.equal(arms.S1, 12.0);
});

for (const [position, team] of [['QB', 'HI'], ['RB', 'HI'], ['RB', 'LO'], ['WR', 'LO'], ['TE', 'HI']]) {
  test(`lifted arms equal startSitWeekPoints for a ${position} on ${team} (real vegasLift, RB split)`, () => {
    const p = proj(position, team);
    const arms = lib.constructArms(p, CTX, stubExperts);
    const m = MULTS[team];
    const expectedMult = position === 'RB' ? 0.65 * m.rush + 0.35 * m.pass : m.pass;
    assert.ok(Math.abs(arms.lift - +expectedMult.toFixed(3)) < 1e-12, `lift ${arms.lift} vs ${expectedMult}`);
    assert.equal(arms.C, arms.A * arms.lift);
    assert.equal(arms.D, arms.B * arms.lift);
    const served = startSitWeekPoints({ team_abbr: team, position, current_week_ppg: arms.B }, 2025, 6).week_points;
    assert.equal(lib.round2(arms.D), served);
    const servedUncoordinated = startSitWeekPoints({ team_abbr: team, position, current_week_ppg: arms.A }, 2025, 6).week_points;
    assert.equal(lib.round2(arms.C), servedUncoordinated);
  });
}

test('no betting line: lifted arms equal their unlifted base', () => {
  const arms = lib.constructArms(proj('WR', 'NONE'), CTX, stubExperts);
  assert.equal(arms.lift_applied, false);
  assert.equal(arms.C, arms.A);
  assert.equal(arms.D, arms.B);
  assert.equal(arms.S3, arms.A);
});

test('S3 shrinks the lift by the exponent chosen on 2024', () => {
  const p = proj('QB', 'HI');
  const at = lambda => lib.constructArms(p, { ...CTX, lambda }, stubExperts);
  assert.equal(at(0).S3, 14.4);
  assert.equal(at(1).S3, at(1).C);
  assert.ok(Math.abs(at(0.5).S3 - 14.4 * Math.sqrt(1.2)) < 1e-9);
});

test('retargetToEnsembleResidual subtracts the shift and counts the rows it drops', () => {
  const out = lib.retargetToEnsembleResidual([
    { target: 5, experts: { ensemble_shift: 2 } },
    { target: 1, experts: { ensemble_shift: null } },
    { target: -1, experts: { ensemble_shift: -0.5 } }
  ]);
  assert.deepEqual(out.examples.map(e => e.target), [3, -0.5]);
  assert.equal(out.dropped, 1);
});

test('eligibleRows follows the weekly-backtest population and DNP rules', () => {
  const truth = new Map([
    [1, { weeks: new Map([[1, 10], [2, 12], [3, 8]]) }],   // played w2 and w3: played + decision row
    [2, { weeks: new Map([[1, 6], [2, 9]]) }],             // played w2, not w3: decision row with actual 0
    [3, { weeks: new Map([[3, 20]]) }],                    // no prior week: not graded
    [4, { weeks: new Map([[1, 4], [3, 7]]) }],             // played w3, not w2: played row only
    [5, { weeks: new Map([[1, 5], [2, 5], [3, 5]]) }]      // kicker: not graded
  ]);
  const engine = new Map([
    [1, { position: 'WR', ppg: 11 }], [2, { position: 'RB', ppg: 7 }], [3, { position: 'QB', ppg: 15 }],
    [4, { position: 'TE', ppg: 5 }], [5, { position: 'K', ppg: 8 }], [6, { position: 'WR', ppg: 9 }]
  ]);
  const rows = lib.eligibleRows(3, engine, truth);
  const byId = new Map(rows.map(r => [r.player_id, r]));
  assert.deepEqual([...byId.keys()].sort(), [1, 2, 4]);
  assert.deepEqual(byId.get(1), { player_id: 1, week: 3, position: 'WR', played: true, decision: true, actual: 8, proj: engine.get(1) });
  assert.deepEqual({ played: byId.get(2).played, decision: byId.get(2).decision, actual: byId.get(2).actual }, { played: false, decision: true, actual: 0 });
  assert.deepEqual({ played: byId.get(4).played, decision: byId.get(4).decision, actual: byId.get(4).actual }, { played: true, decision: false, actual: 7 });
});

test('weekWindow splits 2-4 from 5-17 and leaves 1 and 18 out', () => {
  assert.deepEqual([1, 2, 4, 5, 17, 18].map(lib.weekWindow), [null, '2-4', '2-4', '5-17', '5-17', null]);
});

test('shipVerdict is matchups.js:33-35: CI below 0, Spearman >= -0.002, DNP-included no worse', () => {
  const ok = { d_mae: { mean_diff: -0.02, ci90: [-0.03, -0.001] }, d_spearman: -0.002, d_dnp: { mean_diff: 0 } };
  assert.equal(lib.shipVerdict(ok).pass, true);
  assert.equal(lib.shipVerdict({ ...ok, d_mae: { mean_diff: -0.02, ci90: [-0.03, 0] } }).pass, false);
  assert.equal(lib.shipVerdict({ ...ok, d_spearman: -0.0021 }).pass, false);
  assert.equal(lib.shipVerdict({ ...ok, d_dnp: { mean_diff: 0.0001 } }).pass, false);
  assert.equal(lib.shipVerdict({ ...ok, d_mae: { error: 'too few' } }).pass, false);
  assert.equal(lib.shipVerdict({ ...ok, d_mae: { mean_diff: -0.02, ci90: [-0.03, 0.01] } }).reasons.length, 1);
});

test('mde80 is 2.487 standard errors, with SE from the 90% CI width', () => {
  assert.ok(Math.abs(lib.mde80([-0.1, 0.1]) - 2.487 * (0.2 / 3.29)) < 1e-12);
});

test('decision win rate counts only the pairs where the arm and m0 disagree', () => {
  // Week 5 WRs: m0 orders x>y>z, the arm orders z>x>y. Actuals: z 20, x 10, y 5.
  const rows = [
    { player_id: 1, week: 5, position: 'WR', actual: 10, preds: { A: 12, X: 11 } },
    { player_id: 2, week: 5, position: 'WR', actual: 5, preds: { A: 10, X: 9 } },
    { player_id: 3, week: 5, position: 'WR', actual: 20, preds: { A: 8, X: 13 } }
  ];
  const out = lib.decisionWinRate(rows, 'X', 'A', { threshold: 4 });
  // disagreements: (1,3) arm picks 3 (scored 20 > 10) -> 1; (2,3) arm picks 3 (20 > 5) -> 1. (1,2) agree.
  assert.equal(out.pairs, 3);
  assert.equal(out.disagreements, 2);
  assert.equal(out.win_rate, 1);
});

test('selectWinner: none passing -> A; else lowest MAE, ties to fewer components', () => {
  assert.equal(lib.selectWinner({ B: { pass: false }, C: { pass: false } }, { A: 4.3, B: 4.2, C: 4.1 }), 'A');
  assert.equal(lib.selectWinner({ B: { pass: true }, C: { pass: true }, D: { pass: true } }, { A: 4.3, B: 4.2, C: 4.1, D: 4.15 }), 'C');
  assert.equal(lib.selectWinner({ C: { pass: true }, D: { pass: true } }, { A: 4.3, C: 4.1, D: 4.1 }), 'C');
});

test('forwardVerdict: ON only when both forward point estimates are <= 0', () => {
  assert.equal(lib.forwardVerdict('A', {}).status, 'off');
  assert.equal(lib.forwardVerdict('C', { C: { d_mae: { mean_diff: -0.01 }, d_dnp: { mean_diff: 0 } } }).status, 'on');
  assert.equal(lib.forwardVerdict('C', { C: { d_mae: { mean_diff: 0.01 }, d_dnp: { mean_diff: -0.1 } } }).status, 'default-off, unconfirmed forward');
  assert.equal(lib.forwardVerdict('C', {}).status, 'default-off, unconfirmed forward');
});

test('fitLambda picks the lowest-MAE exponent on the fit-split rows', () => {
  // Truth equals A x m^0.5 exactly, so 0.5 must win.
  const rows = [1.2, 0.8, 1.1, 0.9].map((m, i) => ({ played: true, A: 10 + i, lift: m, lift_applied: true, actual: (10 + i) * Math.sqrt(m) }));
  assert.equal(lib.fitLambda(rows), 0.5);
});

test('assertKControl stops on a missing vector or the hand-picked share 6', () => {
  assert.throws(() => lib.assertKControl(null, 2025), /k control/);
  assert.throws(() => lib.assertKControl({ target_share: { ALL: 6 } }, 2025), /k control/);
  assert.doesNotThrow(() => lib.assertKControl({ target_share: { ALL: 0.1733 } }, 2025));
});

test('assertFitCutoff stops when a fit saw a season past its cutoff', () => {
  assert.throws(() => lib.assertFitCutoff([{ season: 2023 }, { season: 2025 }], 2024, 'fitS'), /cutoff/);
  assert.doesNotThrow(() => lib.assertFitCutoff([{ season: 2023 }, { season: 2024 }], 2024, 'fitS'));
});

test('assertContextCutoff: every fit that grades season S must end before S', () => {
  assert.equal(lib.assertContextCutoff({ fitSThrough: 2024, fitEThrough: 2024 }, 2025), true);
  assert.equal(lib.assertContextCutoff({ fitSThrough: 2025, fitEThrough: 2025 }, 2026), true);
  assert.throws(() => lib.assertContextCutoff({ fitSThrough: 2025, fitEThrough: 2024 }, 2025), /cutoff/);
  assert.throws(() => lib.assertContextCutoff({ fitSThrough: 2024, fitEThrough: 2025 }, 2025), /cutoff/);
  assert.throws(() => lib.assertContextCutoff({ fitSThrough: 2024 }, 2025), /cutoff/);
});

test('gradingContext maps each graded season to its registered fits, and the cutoff travels with the fit', () => {
  const pair = (through, tag) => ({ fitS: { tag: `${tag}S` }, fitE: { tag: `${tag}E` }, through });
  const fits = { split: pair(2023, 'split'), heldOut: pair(2024, 'held'), forward: pair(2025, 'fwd'),
    served: { fitS: { tag: 'served' }, through: 2025 } };
  const c24 = lib.gradingContext(2024, fits, 1);
  assert.deepEqual([c24.fitS.tag, c24.fitE.tag, c24.fitSThrough, c24.fitEThrough], ['splitS', 'splitE', 2023, 2023]);
  const c25 = lib.gradingContext(2025, fits, 0.5);
  assert.deepEqual([c25.fitS.tag, c25.fitE.tag, c25.fitSThrough, c25.lambda], ['heldS', 'heldE', 2024, 0.5]);
  const c26 = lib.gradingContext(2026, fits, 1);
  assert.deepEqual([c26.fitS.tag, c26.fitE.tag, c26.fitSThrough, c26.fitEThrough], ['served', 'fwdE', 2025, 2025]);
  // A caller that hands the <=2025 fits to the 2025 grade is stopped by the fits' own cutoff.
  assert.throws(() => lib.gradingContext(2025, { ...fits, heldOut: fits.forward }, 1), /cutoff/);
  assert.throws(() => lib.gradingContext(2023, fits, 1), /cutoff/);
  assert.throws(() => lib.gradingContext(2025, { split: fits.split }, 1), /cutoff/);
});

// ---------------------------------------------------------------------------------------
// Amendment 1 (docs/evidence/2026-09-22/weekly-construction-grade-preregistration-amendment-1.md):
// the metric producers behind every verdict, the arguments handed to the served functions,
// the runner's window bookkeeping, and the report-only diagnostics.

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
/**
 * 16 players x 4 weeks. Each player carries a persistent miss, so errors are correlated
 * within a player (the reason the CI is clustered). X misses by half as much as A. A few
 * rows are DNPs (decision, actual 0) and a few are played-only, so the played and decision
 * sets differ.
 */
function clusteredRows({ weeks = [5, 6, 7, 8] } = {}) {
  const r = lcg(11);
  const rows = [];
  for (let pid = 1; pid <= 16; pid++) {
    const miss = (r() - 0.5) * 8;
    const position = POSITIONS[pid % 4];
    for (const week of weeks) {
      const truth = 6 + r() * 12;
      const dnp = (pid + week) % 9 === 0;
      const playedOnly = (pid + week) % 7 === 0;
      const A = truth + miss + (r() - 0.5);
      const X = truth + 0.5 * miss + (r() - 0.5) * 0.5;
      rows.push({ player_id: pid, week, position, played: !dnp, decision: !playedOnly,
        actual: dnp ? 0 : truth, preds: { A, X } });
    }
  }
  return rows;
}
const absErr = (rows, arm) => rows.map(row => Math.abs(row.preds[arm] - row.actual));

test('compareArms: dMAE is arm minus reference, negative when the arm is better', () => {
  const rows = clusteredRows();
  const played = rows.filter(r => r.played);
  const out = lib.compareArms(rows, 'X', 'A');
  assert.equal(out.arm, 'X');
  assert.equal(out.reference, 'A');
  const mae = arm => absErr(played, arm).reduce((s, x) => s + x, 0) / played.length;
  assert.ok(mae('X') < mae('A'), 'fixture: X has the lower error');
  assert.ok(out.d_mae.mean_diff < 0, `dMAE ${out.d_mae.mean_diff} must be negative for the better arm`);
  assert.ok(Math.abs(out.d_mae.mean_diff - (mae('X') - mae('A'))) < 0.05, 'bootstrap mean near the observed difference');
  assert.ok(out.d_mae.ci90[1] < 0);
  assert.ok(lib.compareArms(rows, 'A', 'X').d_mae.mean_diff > 0, 'the reverse comparison is positive');
});

test('compareArms: both intervals are player-clustered (prereg section 6), on their own row sets', () => {
  const rows = clusteredRows();
  const played = rows.filter(r => r.played), decision = rows.filter(r => r.decision);
  const opts = { iterations: 2000, seed: 1 };
  const clustered = pairedBootstrapDiff(absErr(played, 'A'), absErr(played, 'X'), { ...opts, groups: played.map(r => r.player_id) });
  const flat = pairedBootstrapDiff(absErr(played, 'A'), absErr(played, 'X'), opts);
  assert.notDeepEqual(flat.ci90, clustered.ci90, 'fixture: clustering must change the interval');
  const out = lib.compareArms(rows, 'X', 'A');
  assert.deepEqual([out.d_mae.mean_diff, out.d_mae.ci90], [clustered.mean_diff, clustered.ci90]);
  const dnp = pairedBootstrapDiff(absErr(decision, 'A'), absErr(decision, 'X'), { ...opts, groups: decision.map(r => r.player_id) });
  assert.deepEqual([out.d_dnp.mean_diff, out.d_dnp.ci90], [dnp.mean_diff, dnp.ci90]);
});

test('constructArms hands the served expert and lift functions the graded season, week and scoring', () => {
  const calls = { experts: [], lift: [] };
  const SCORING = Object.freeze({ tag: 'league scoring' });
  const deps = {
    ...lib.SERVED,
    weeklyExpertValues: (p, season, week, scoring) => { calls.experts.push([p, season, week, scoring]); return EXPERTS; },
    vegasLift: (asset, season, week) => {
      calls.lift.push([asset.team_abbr, asset.position, season, week]);
      return lib.SERVED.vegasLift(asset, season, week);
    }
  };
  const p = proj('RB', 'HI');
  lib.constructArms(p, { ...CTX, season: 2025, week: 6, scoring: SCORING }, deps);
  assert.equal(calls.experts.length, 1);
  assert.equal(calls.experts[0][0], p);
  assert.deepEqual(calls.experts[0].slice(1), [2025, 6, SCORING]);
  assert.deepEqual(calls.lift, [['HI', 'RB', 2025, 6]]);
});

test('armSummary: MAE and signed error on played rows, DNP-included MAE on decision rows', () => {
  const rows = [
    { played: true, decision: true, actual: 10, preds: { A: 12 } },   // +2
    { played: true, decision: false, actual: 5, preds: { A: 4 } },    // -1, played only
    { played: false, decision: true, actual: 0, preds: { A: 6 } },    // DNP, +6
    { played: true, decision: true, actual: 8, preds: { A: 9 } }      // +1
  ];
  const s = lib.armSummary(rows, 'A');
  assert.equal(s.n_played, 3);
  assert.equal(s.n_decision, 3);
  assert.ok(Math.abs(s.mae - 4 / 3) < 1e-12);
  assert.ok(Math.abs(s.signed_error - 2 / 3) < 1e-12);
  assert.ok(Math.abs(s.dnp_mae - 3) < 1e-12, `dnp_mae ${s.dnp_mae} is (2 + 6 + 1) / 3`);
});

test('m0For is the prediction-weighted median ratio over PLAYED rows only (prereg section 8)', () => {
  const rows = [
    { played: true, decision: true, actual: 8, preds: { A: 10 } },
    { played: true, decision: true, actual: 8, preds: { A: 10 } },
    { played: false, decision: true, actual: 0, preds: { A: 30 } }   // a DNP: would drag m0 to 0
  ];
  assert.equal(lib.m0For(rows, 'A'), 0.8);
  assert.equal(predictionWeightedMedianRatio([10, 10, 30], [8, 8, 0]), 0, 'control: the DNP row changes the answer');
});

test('headroom is MAE(X) - MAE(X x m0) on played rows', () => {
  const rows = [
    { played: true, actual: 9, preds: { A: 10 } },
    { played: true, actual: 18, preds: { A: 20 } },
    { played: false, actual: 0, preds: { A: 50 } }
  ];
  const h = lib.headroom(rows, 'A', 0.9);
  assert.ok(Math.abs(h.raw_mae - 1.5) < 1e-12);
  assert.ok(Math.abs(h.scaled_mae) < 1e-12);
  assert.ok(Math.abs(h.headroom - 1.5) < 1e-12);
});

test('pairAccuracy keeps only pairs where every model projects both players at 4 or more', () => {
  const rows = [
    { player_id: 1, week: 5, position: 'WR', actual: 10, preds: { A: 12, X: 11 } },
    { player_id: 2, week: 5, position: 'WR', actual: 5, preds: { A: 10, X: 13 } },
    { player_id: 3, week: 5, position: 'WR', actual: 8, preds: { A: 3.5, X: 9 } }
  ];
  assert.deepEqual(lib.pairAccuracy(rows, ['A', 'X']), { pairs: 1, accuracy: { A: 1, X: 0 } });
});

/**
 * Rows carrying every arm. A overshoots every outcome by 2 (plus a small player-level
 * wobble), B, D, S1 and S2 remove the overshoot, C adds 1 to it, S3 = A. Rankings are
 * identical across arms, so only the level differs.
 */
function allArmRows() {
  const r = lcg(23);
  const rows = [];
  for (let pid = 1; pid <= 16; pid++) {
    const wobble = (r() - 0.5) * 0.5;
    const position = POSITIONS[pid % 4];
    for (const week of [5, 6, 7, 8]) {
      const truth = 6 + r() * 12;
      const dnp = (pid + week) % 9 === 0;
      const playedOnly = (pid + week) % 7 === 0;
      const A = truth + 2 + wobble;
      rows.push({ player_id: pid, week, position, played: !dnp, decision: !playedOnly, actual: dnp ? 0 : truth,
        preds: { A, B: A - 2, C: A + 1, D: A - 2, S1: A - 2, S2: A - 2, S3: A } });
    }
  }
  return rows;
}

test('gradeWindow grades every candidate as arm-vs-A, and the verdicts follow', () => {
  const rows = allArmRows();
  const g = lib.gradeWindow(rows, { m0: null, light: true });
  for (const x of lib.CANDIDATES) {
    assert.equal(g.vs_A[x].arm, x);
    assert.equal(g.vs_A[x].reference, 'A');
  }
  assert.ok(g.vs_A.B.d_mae.mean_diff < 0);
  assert.equal(g.verdicts.B.pass, true);
  assert.ok(g.vs_A.C.d_mae.mean_diff > 0);
  assert.equal(g.verdicts.C.pass, false);
  assert.equal(g.verdicts.S3.pass, false, 'S3 = A cannot beat A');
  assert.deepEqual(Object.keys(g).sort(), ['arms', 'verdicts', 'vs_A']);
  assert.ok(Math.abs(g.arms.B.mae - lib.armSummary(rows, 'B').mae) < 1e-12);
});

test('gradeWindow (full): marginals, pair metrics, positions and m0 headroom', () => {
  const rows = allArmRows();
  const m0 = Object.fromEntries(lib.ARMS.map(a => [a, 0.9]));
  const g = lib.gradeWindow(rows, { m0 });
  assert.deepEqual([g.marginal.lift_given_coordinator.arm, g.marginal.lift_given_coordinator.reference], ['D', 'B']);
  assert.deepEqual([g.marginal.coordinator_given_lift.arm, g.marginal.coordinator_given_lift.reference], ['D', 'C']);
  assert.deepEqual(Object.keys(g.by_position), POSITIONS);
  assert.deepEqual(g.pair_accuracy, lib.pairAccuracy(rows.filter(r => r.decision), lib.ARMS));
  assert.equal(g.decision_win_rate_vs_A.C.disagreements, 0, 'C = A + 1 never reorders a pair');
  assert.equal(g.m0_headroom.A.m0_from_2024, 0.9);
  assert.equal(lib.gradeWindow(rows, { m0: null }).m0_headroom, undefined);
});

test('lambdaForWeek reads each window its own lambda and refuses a week outside both', () => {
  const lambda = { '2-4': 1, '5-17': 0 };
  assert.equal(lib.lambdaForWeek(lambda, 3), 1);
  assert.equal(lib.lambdaForWeek(lambda, 6), 0);
  assert.throws(() => lib.lambdaForWeek(lambda, 1), /lambda/);
  assert.throws(() => lib.lambdaForWeek({ '2-4': 1 }, 6), /lambda/);
});

test('gradeWeekRows: the season\'s registered fits and the week\'s window lambda reach every arm', () => {
  const pair = through => ({ fitS: FIT, fitE: FIT, through });
  const fits = { split: pair(2023), heldOut: pair(2024), forward: pair(2025), served: { fitS: FIT, through: 2025 } };
  const truth = new Map([[1, { weeks: new Map([[1, 10], [2, 11], [3, 12], [5, 9], [6, 14]]) }]]);
  const engine = new Map([[1, proj('QB', 'HI')]]);
  const lambdaByWindow = { '2-4': 1, '5-17': 0.5 };
  const at = week => lib.gradeWeekRows({ season: 2025, week, engine, truth, fits, lambdaByWindow, scoring: undefined }, stubExperts);
  const w3 = at(3), w6 = at(6);
  assert.deepEqual([w3.ctx.lambda, w3.ctx.fitSThrough, w3.ctx.fitEThrough], [1, 2024, 2024]);
  assert.equal(w6.ctx.lambda, 0.5);
  assert.equal(w3.rows.length, 1);
  assert.equal(w3.rows[0].player_id, 1);
  assert.equal(w3.rows[0].arms.S3, w3.rows[0].arms.C);
  assert.ok(Math.abs(w6.rows[0].arms.S3 - 14.4 * Math.sqrt(1.2)) < 1e-9);
  assert.throws(() => lib.gradeWeekRows({ season: 2025, week: 6, engine, truth, fits: { ...fits, heldOut: fits.forward }, lambdaByWindow }, stubExperts), /cutoff/);
});

test('assertS3UsedLambda stops when a graded row\'s S3 was not built with its window\'s lambda', () => {
  const row = (week, S3) => ({ week, lift: 1.25, lift_applied: true, preds: { A: 10, S3 } });
  const lambda = { '2-4': 1, '5-17': 0 };
  assert.equal(lib.assertS3UsedLambda([row(3, 12.5), row(6, 10), { week: 6, lift: 1, lift_applied: false, preds: { A: 7, S3: 7 } }], lambda), 3);
  assert.throws(() => lib.assertS3UsedLambda([row(6, 12.5)], lambda), /lambda/);
  assert.throws(() => lib.assertS3UsedLambda([row(3, 10)], lambda), /lambda/);
});

test('consumerDecomposition: the page number is B x game factor x chance to play x lift (trade-engine.js:359)', () => {
  const arms = { B: 12.345, D: 12.345 * 1.2 };
  const asset = { team_abbr: 'HI', position: 'QB', active_probability: 0.749, matchup: { mult: 1 },
    fantasy_coordinator: { corrected_ppg: 12.345 }, current_week_ppg: +(12.345 * 1 * 0.749).toFixed(2) };
  const page = startSitWeekPoints(asset, 2025, 6).week_points;
  const d = lib.consumerDecomposition(asset, arms, page, 'HI');
  assert.deepEqual([d.b_parity, d.current_week_identity, d.bye, d.team_differs], [true, true, false, false]);
  assert.deepEqual([d.p, d.mult, d.arm_D, d.page], [0.749, 1, lib.round2(arms.D), page]);
  assert.ok(Math.abs(d.page_over_D - page / arms.D) < 1e-12);
  assert.ok(d.page_over_D < 0.76 && d.page_over_D > 0.74, 'the page carries p, the arm does not');
  const bye = lib.consumerDecomposition({ ...asset, matchup: null, current_week_ppg: 0 }, arms, 0, 'HI');
  assert.deepEqual([bye.current_week_identity, bye.bye, bye.page_over_D], [true, true, 0]);
  assert.equal(lib.consumerDecomposition({ ...asset, current_week_ppg: 12.35 }, arms, page, 'HI').current_week_identity, false);
  assert.equal(lib.consumerDecomposition(asset, { ...arms, B: 12.3 }, page, 'HI').b_parity, false);
  assert.equal(lib.consumerDecomposition(asset, arms, page, 'LO').team_differs, true);
});

test('meanSignedError is prediction minus actual, with a player-clustered interval', () => {
  const rows = allArmRows().filter(r => r.played);
  const out = lib.meanSignedError(rows, 'C');
  const errs = rows.map(r => r.preds.C - r.actual);
  const boot = pairedBootstrapDiff(errs.map(() => 0), errs, { iterations: 2000, seed: 1, groups: rows.map(r => r.player_id) });
  assert.equal(out.n, rows.length);
  assert.ok(Math.abs(out.mean - errs.reduce((s, x) => s + x, 0) / errs.length) < 1e-12);
  assert.ok(out.mean > 2, 'C overshoots by more than 2: positive = reads high');
  assert.deepEqual(out.ci90, boot.ci90);
});

test('starterProxy keeps each week\'s top N per position by the reference arm', () => {
  const row = (id, week, position, A) => ({ player_id: id, week, position, played: true, decision: true, actual: 1, preds: { A } });
  const rows = [row(1, 5, 'QB', 20), row(2, 5, 'QB', 15), row(3, 5, 'QB', 10), row(4, 6, 'QB', 9), row(5, 6, 'QB', 30), row(6, 5, 'K', 40)];
  const picked = lib.starterProxy(rows, 'A', { QB: 2 });
  assert.deepEqual(picked.map(r => r.player_id).sort(), [1, 2, 4, 5]);
});

test('levelBands splits played rows by A and reads the starter proxy on played and decision rows', () => {
  const rows = allArmRows();
  const bands = lib.levelBands(rows, ['A', 'B'], { quota: { QB: 2, RB: 2, WR: 2, TE: 2 } });
  assert.deepEqual(Object.keys(bands), ['played_all', 'played_A_ge_10', 'played_A_lt_10', 'starters_played', 'starters_decision']);
  const played = rows.filter(r => r.played);
  assert.equal(bands.played_all.n, played.length);
  assert.equal(bands.played_A_ge_10.n + bands.played_A_lt_10.n, played.length);
  const starters = lib.starterProxy(rows, 'A', { QB: 2, RB: 2, WR: 2, TE: 2 });
  assert.equal(bands.starters_played.n, starters.filter(r => r.played).length);
  assert.equal(bands.starters_decision.n, starters.filter(r => r.decision).length);
  assert.ok(Math.abs(bands.played_all.arms.B.mean - lib.armSummary(rows, 'B').signed_error) < 1e-12);
  // The band edge: a projection of exactly 10 is in the A >= 10 band.
  const edge = lib.levelBands([{ player_id: 1, week: 5, position: 'WR', played: true, decision: true, actual: 9, preds: { A: 10 } }], ['A']);
  assert.deepEqual([edge.played_A_ge_10.n, edge.played_A_lt_10.n], [1, 0]);
});

test('reproductionMismatches compares dumped rows against a committed arm table to 4 dp', () => {
  const rows = allArmRows();
  const table = Object.fromEntries(['A', 'B'].map(a => [a, lib.armSummary(rows, a)]));
  assert.deepEqual(lib.reproductionMismatches(rows, table, ['A', 'B']), []);
  for (const field of ['n_played', 'n_decision', 'mae', 'signed_error']) {
    const off = { ...table, B: { ...table.B, [field]: table.B[field] + 0.0002 } };
    assert.deepEqual(lib.reproductionMismatches(rows, off, ['A', 'B']).map(m => [m.arm, m.field]), [['B', field]], field);
  }
  const close = { ...table, B: { ...table.B, mae: table.B.mae + 0.00002 } };
  assert.deepEqual(lib.reproductionMismatches(rows, close, ['A', 'B']), [], 'a difference below the 4th decimal passes');
  assert.equal(lib.reproductionMismatches(rows, { A: table.A }, ['A', 'B']).length, 1, 'a missing arm is a mismatch');
});

test('summarizeConsumerParity: counts, page / arm D, p for players with no injury status, and the starter proxy', () => {
  const c = (position, armD, p, extra = {}) => ({ position, arm_D: armD, page: lib.round2(armD * p), p,
    page_over_D: lib.round2(armD * p) / armD, mult: 1, bye: false, b_parity: true, current_week_identity: true,
    team_differs: false, no_report: true, p_is_durability_prior: true, ...extra });
  const checked = [
    c('QB', 20, 0.75), c('QB', 10, 0.5, { no_report: false, p_is_durability_prior: false }), c('QB', 5, 1, { team_differs: true }),
    { ...c('WR', 12, 0.8), bye: true, page: 0, page_over_D: 0, mult: 0 }
  ];
  const s = lib.summarizeConsumerParity(checked, { QB: 2 });
  assert.deepEqual([s.n_checked, s.byes, s.team_differs, s.b_parity_holds, s.current_week_identity_holds], [4, 1, 1, 4, 4]);
  assert.equal(s.page_differs_from_arm_D, 2, 'the p = 1 player reads the same; the other two do not');
  assert.equal(s.active_probability.no_injury_status_n, 2);
  assert.equal(s.active_probability.no_injury_status_share_at_durability_prior, 1);
  assert.deepEqual([s.starter_proxy.n, s.starter_proxy.mean_arm_D, s.starter_proxy.mean_page, s.starter_proxy.median_p], [2, 15, 10, 0.5]);
  assert.deepEqual(s.game_mult_values, [1]);
});
