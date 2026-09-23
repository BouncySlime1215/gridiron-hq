/**
 * S-03's walk-forward grade (docs/evidence/2026-09-22/weekly-construction-walk-forward-preregistration.md):
 * the pieces of scripts/weekly-construction-walk-forward-lib.mjs that decide what is served.
 *
 * What these tests pin:
 *   - each graded season gets fits that end before it, and the lift arms read gameScriptLift
 *     (the multiplier), not the switched-off vegasLift;
 *   - the served construction equals arm S1 on every row the coordinator applies to, and the
 *     served vegasLift is off (the parity stop condition);
 *   - the dumb baseline is the player's season average over his played weeks before w;
 *   - the per-window decision is the pre-registered rule, item by item (2 of 3 passes, no
 *     veto, forward point estimates), and the lift can never come out 'on'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-walk-forward-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const wf = await import('../scripts/weekly-construction-walk-forward-lib.mjs');
const s02 = await import('../scripts/weekly-construction-grade-lib.mjs');
const coordinator = await import('../server/services/fantasy-coordinator.js');
const waiverBrain = await import('../server/services/waiver-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; };
}
function examples(seasons, perSeason = 120) {
  const r = lcg(5);
  const out = [];
  for (const season of seasons) {
    for (let i = 0; i < perSeason; i++) {
      const shift = (r() - 0.5) * 6;
      out.push({ season, week: 1 + (i % 17), player_id: i, team: 'AAA', opponent: 'BBB', market_spread: null, market_total: null,
        target: -0.6 + 0.5 * shift + (r() - 0.5) * 3,
        experts: { ensemble_shift: i % 10 === 0 ? null : shift, game_script_delta: (r() - 0.5), boom_bust_signal: null } });
    }
  }
  return out;
}

test('the lift arms read gameScriptLift, the multiplier; the served vegasLift is the switch', () => {
  assert.equal(wf.LIFT_DEPS.vegasLift, waiverBrain.gameScriptLift);
  assert.equal(wf.LIFT_DEPS.weeklyExpertValues, s02.SERVED.weeklyExpertValues);
  assert.equal(wf.LIFT_DEPS.coordinateFantasy, s02.SERVED.coordinateFantasy);
  assert.notEqual(wf.LIFT_DEPS.vegasLift, waiverBrain.vegasLift);
});

test('walkForwardFits: each graded season gets a structural and an ensemble-residual fit that end before it', () => {
  const all = examples([2022, 2023], 250);
  const fits = wf.walkForwardFits(all, [2023, 2024], { fitFrom: 2022 });
  assert.deepEqual(Object.keys(fits).map(Number), [2023, 2024]);
  assert.equal(fits[2023].through, 2022);
  assert.equal(fits[2023].rows, 250);
  assert.equal(fits[2024].through, 2023);
  assert.equal(fits[2024].rows, 500);
  for (const s of [2023, 2024]) {
    assert.equal(fits[s].fitS.ready, true);
    assert.equal(coordinator.fitTargetOf(fits[s].fitS), 'structural');
    assert.equal(coordinator.fitTargetOf(fits[s].fitE), 'ensemble');
    assert.ok(fits[s].dropped > 0, 'rows with no ensemble shift are dropped from the ensemble-residual fit and counted');
  }
  // A season with no earlier examples cannot be graded.
  assert.throws(() => wf.walkForwardFits(examples([2023]), [2023], { fitFrom: 2022 }), /no examples|cutoff/);
});

test('walkForwardContext refuses a fit that does not end before the graded season', () => {
  const fits = wf.walkForwardFits(examples([2022, 2023], 250), [2023, 2024], { fitFrom: 2022 });
  const ctx = wf.walkForwardContext(2024, fits);
  assert.deepEqual([ctx.fitSThrough, ctx.fitEThrough, ctx.lambda], [2023, 2023, 1]);
  assert.equal(ctx.fitS, fits[2024].fitS);
  assert.throws(() => wf.walkForwardContext(2023, { 2023: fits[2024] }), /cutoff/);
  assert.throws(() => wf.walkForwardContext(2025, fits), /no walk-forward fit/);
});

test('seasonAverageToDate: mean PPR points over his played weeks before w, null with none', () => {
  const truth = { weeks: new Map([[1, 10], [2, 20], [4, 6], [5, 30]]) };
  assert.equal(wf.seasonAverageToDate(truth, 5), 12);
  assert.equal(wf.seasonAverageToDate(truth, 3), 15);
  assert.equal(wf.seasonAverageToDate(truth, 1), null);
  assert.equal(wf.seasonAverageToDate(null, 4), null);
});

test('servedParity: the served construction must equal arm S1, and the served lift must be off', () => {
  const fit = coordinator.fitFantasyCoordinator(examples([2022, 2023], 150));
  const proj = { position: 'WR', team: 'NONE', ppg: 14.4, structural_ppg: 12, ensemble_shift: 2.4, params: {} };
  const deps = { ...wf.LIFT_DEPS, weeklyExpertValues: () => ({ ensemble_shift: 2.4, game_script_delta: 0.2, boom_bust_signal: null }) };
  const ctx = { season: 2024, week: 6, scoring: undefined, fitS: fit, fitE: fit, lambda: 1 };
  const arms = s02.constructArms(proj, ctx, deps);
  const served = { ppg: arms.S1, basis: 'structural+coordinator', coordinated: { ready: true } };
  const off = { applied: false, switched_off: true, multiplier: 1 };
  assert.deepEqual(wf.servedParity(arms, served, off), { coordinated: true });
  assert.throws(() => wf.servedParity(arms, { ...served, ppg: arms.B }, off), /parity/);
  assert.throws(() => wf.servedParity(arms, served, { applied: true, multiplier: 1.2 }), /lift/);
  // No coordinator inputs: the served number is the ensemble (arm A), counted separately.
  assert.deepEqual(wf.servedParity(arms, { ppg: arms.A, basis: 'ensemble', coordinated: null }, off), { coordinated: false });
  assert.throws(() => wf.servedParity(arms, { ppg: arms.S1, basis: 'ensemble', coordinated: null }, off), /parity/);
});

test('squaredErrorComparison: MSE of each arm and the player-clustered change, negative = arm better', () => {
  const rows = [];
  for (let p = 0; p < 40; p++) {
    for (let w = 5; w < 9; w++) rows.push({ player_id: p, week: w, played: true, actual: 10, preds: { A: 12, S1: 11 } });
  }
  const out = wf.squaredErrorComparison(rows, 'S1', 'A');
  assert.equal(out.mse_reference, 4);
  assert.equal(out.mse_arm, 1);
  assert.equal(out.d_mse.mean_diff, -3);
  assert.ok(Array.isArray(out.d_mse.ci90));
});

test('seasonSummary reads S1\'s and the lift\'s verdicts, and S1\'s interval, off a gradeWindow result', () => {
  const grade = {
    verdicts: { S1: { pass: true, reasons: [] }, C: { pass: false, reasons: ['x'] } },
    vs_A: { S1: { d_mae: { ci90: [-0.09, -0.02], mean_diff: -0.05, mde80: 0.04 } }, C: { d_mae: { ci90: [0, 0.02], mde80: 0.015 } } }
  };
  assert.deepEqual(wf.seasonSummary(grade), {
    S1: { pass: true, ci90: [-0.09, -0.02], mean_diff: -0.05, mde80: 0.04, reasons: [] },
    C: { pass: false, ci90: [0, 0.02], mde80: 0.015, reasons: ['x'] }
  });
});

test('windowDecision follows the pre-registered rule item by item', () => {
  const season = (pass, lo, hi) => ({ S1: { pass, ci90: [lo, hi] }, C: { pass: false } });
  const forwardOk = { S1: { d_mae: -0.1, d_dnp: -0.2 }, proxy: false };
  const on = wf.windowDecision({ window: '5-17', seasons: { 2023: season(true, -0.1, -0.01), 2024: season(false, -0.05, 0.02) },
    s02Pass: true, forward: forwardOk });
  assert.equal(on.coordinator, 'S1');
  assert.equal(on.status, 'on');
  assert.equal(on.passes, 2);
  assert.equal(on.lift, 'off');

  // 1 of 3 passes.
  const few = wf.windowDecision({ window: '5-17', seasons: { 2023: season(false, -0.05, 0.02), 2024: season(false, -0.05, 0.02) },
    s02Pass: true, forward: forwardOk });
  assert.deepEqual([few.coordinator, few.status], ['A', 'off: not confirmed historically']);

  // A veto: significantly worse than A in one walk-forward season, even with 2 passes.
  const veto = wf.windowDecision({ window: '2-4', seasons: { 2023: season(true, -0.2, -0.1), 2024: season(false, 0.01, 0.08) },
    s02Pass: true, forward: forwardOk });
  assert.deepEqual([veto.coordinator, veto.vetoes], ['A', [2024]]);

  // Forward fails on a point estimate.
  const fwd = wf.windowDecision({ window: '2-4', seasons: { 2023: season(true, -0.2, -0.1), 2024: season(true, -0.2, -0.1) },
    s02Pass: true, forward: { S1: { d_mae: 0.01, d_dnp: -0.2 }, proxy: false } });
  assert.deepEqual([fwd.coordinator, fwd.status], ['A', 'off: unconfirmed forward']);

  // No forward rows at all is unconfirmed, never a pass.
  const none = wf.windowDecision({ window: '2-4', seasons: { 2023: season(true, -0.2, -0.1), 2024: season(true, -0.2, -0.1) },
    s02Pass: true, forward: null });
  assert.equal(none.status, 'off: unconfirmed forward');

  // The lift cannot come out on, even if C passes in both walk-forward seasons.
  const liftPass = { S1: { pass: true, ci90: [-0.2, -0.1] }, C: { pass: true } };
  const lift = wf.windowDecision({ window: '2-4', seasons: { 2023: liftPass, 2024: liftPass }, s02Pass: true, forward: forwardOk });
  assert.equal(lift.lift, 'off');
  assert.match(lift.lift_note, /2025-specific/);
});

test('forwardSummary reads S1 against A on point estimates and marks the weeks 5-17 proxy', () => {
  const rows = [];
  for (let p = 0; p < 30; p++) {
    rows.push({ player_id: p, week: 2, played: true, decision: true, actual: 10, preds: { A: 13, B: 12, C: 13, D: 12, S1: 11 } });
  }
  const out = wf.forwardSummary(rows, { window: '5-17', weeks: [2] });
  assert.equal(out.proxy, true);
  assert.ok(out.S1.d_mae < 0);
  assert.ok(out.S1.d_dnp < 0);
  assert.equal(wf.forwardSummary(rows, { window: '2-4', weeks: [2] }).proxy, false);
  assert.equal(wf.forwardSummary([], { window: '2-4', weeks: [] }), null);
});

test('promotionFromEvidence: windows come from the committed decisions, and the evidence must name the fit it cleared', () => {
  const report = {
    unit: 'S-03', mode: '--walk-forward', prereg: { commit: 'abc' },
    forward: { fit: { id: 7, through_season: 2025 } },
    decisions: { '2-4': { coordinator: 'S1', status: 'on' }, '5-17': { coordinator: 'A', status: 'off: not confirmed historically' } }
  };
  const fitRow = { id: 7, through_season: 2025, target: 'structural' };
  assert.deepEqual(wf.promotionFromEvidence(report, fitRow), { windows: { '2-4': 'on', '5-17': 'off' } });
  assert.throws(() => wf.promotionFromEvidence({ ...report, unit: 'S-02' }, fitRow), /S-03/);
  assert.throws(() => wf.promotionFromEvidence({ ...report, mode: '--smoke' }, fitRow), /walk-forward/);
  assert.throws(() => wf.promotionFromEvidence(report, { ...fitRow, id: 6 }), /fit 7/);
  assert.throws(() => wf.promotionFromEvidence(report, { ...fitRow, through_season: 2024 }), /through/);
  assert.throws(() => wf.promotionFromEvidence(report, { ...fitRow, target: 'ensemble' }), /structural/);
  const nothing = { ...report, decisions: { '2-4': { coordinator: 'A', status: 'off: unconfirmed forward' }, '5-17': { coordinator: 'A', status: 'off: unconfirmed forward' } } };
  assert.throws(() => wf.promotionFromEvidence(nothing, fitRow), /nothing to promote/);
  assert.throws(() => wf.promotionFromEvidence({ ...report, decisions: { '2-4': report.decisions['2-4'] } }, fitRow), /5-17/);
});

test('refitReproduces: the stored fit must be what the served fitter makes from this database now', () => {
  const stored = { coefficients: [-0.5, 0.1, 0.02, 0, 0, 0, 0] };
  assert.deepEqual(wf.refitReproduces(stored, { coefficients: [-0.5, 0.1, 0.02, 0, 0, 0, 0] }), { max_abs_coefficient_diff: 0 });
  assert.throws(() => wf.refitReproduces(stored, { coefficients: [0.578, 0.1, 0.02, 0, 0, 0, 0] }), /does not reproduce/);
  assert.throws(() => wf.refitReproduces(stored, { coefficients: [-0.5, 0.1] }), /does not reproduce/);
});
