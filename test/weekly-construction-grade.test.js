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
