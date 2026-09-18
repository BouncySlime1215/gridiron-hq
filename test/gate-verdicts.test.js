/**
 * The pass/fail rules of two gates that shipped in commit 11ab55c, as tables.
 *
 * scripts/fit-weekly-coverage.mjs (WEEKLY_LEVEL) and scripts/fit-posture-calibration.mjs
 * (SPREAD_SCALE) each decided shipping with a few inline boolean lines that no test ran.
 * The ROS and early-week gates already have table tests (evaluateRosGate,
 * earlyGateVerdict); these two now live in server/services/gate-verdicts.js, called by
 * the scripts, and are pinned here the same way. Rows below that match the shipped
 * runs use the recorded numbers (docs/tdd/week2-numbers.tdd.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const V = await import('../server/services/gate-verdicts.js').catch(error => ({ __importError: error }));

const crps = (mean_diff, significant) => ({ mean_diff, significant, ci90: [mean_diff - 0.01, mean_diff + 0.01] });

test('weekly coverage gate: G1 band, G2 calibration strictly lower, G3 CRPS not significantly worse', () => {
  assert.ifError(V.__importError);
  const base = { baseCalibrationError: 0.134 };
  const rows = [
    // recorded 2025 run: B passed, A failed on coverage
    [{ coverage80: 0.782, calibrationError: 0.111, crpsBoot: crps(-0.0296, true) }, { g1: true, g2: true, g3: true, pass: true }],
    [{ coverage80: 0.772, calibrationError: 0.111, crpsBoot: crps(-0.031, true) }, { g1: false, g2: true, g3: true, pass: false }],
    // band edges are inclusive
    [{ coverage80: 0.78, calibrationError: 0.12, crpsBoot: crps(0.001, false) }, { g1: true, g2: true, g3: true, pass: true }],
    [{ coverage80: 0.82, calibrationError: 0.12, crpsBoot: crps(0.001, false) }, { g1: true, g2: true, g3: true, pass: true }],
    [{ coverage80: 0.8201, calibrationError: 0.12, crpsBoot: crps(0, false) }, { g1: false, g2: true, g3: true, pass: false }],
    // calibration must be strictly lower
    [{ coverage80: 0.8, calibrationError: 0.134, crpsBoot: crps(-0.01, true) }, { g1: true, g2: false, g3: true, pass: false }],
    // CRPS worse only fails when significant
    [{ coverage80: 0.8, calibrationError: 0.1, crpsBoot: crps(0.02, false) }, { g1: true, g2: true, g3: true, pass: true }],
    [{ coverage80: 0.8, calibrationError: 0.1, crpsBoot: crps(0.02, true) }, { g1: true, g2: true, g3: false, pass: false }]
  ];
  for (const [input, want] of rows) {
    assert.deepEqual(V.coverageGateVerdict({ ...base, ...input }), want, JSON.stringify(input));
  }
});

test('posture gate: log loss and calibration both beat B0, and the log-loss gain is significant', () => {
  assert.ifError(V.__importError);
  const B0 = { baseLogLoss: 0.6726, baseEce: 0.0388 };
  const boot = hi => ({ ci90: [-0.0096, hi], mean_diff: -0.0057 });
  const rows = [
    // recorded 2025 run: shipped
    [{ logLoss: 0.6669, ece: 0.010, boot: boot(-0.0016) }, { log_loss_beats_B0: true, ece_beats_B0: true, bootstrap_significant: true, SHIP: true }],
    [{ logLoss: 0.6669, ece: 0.010, boot: boot(0.0004) }, { log_loss_beats_B0: true, ece_beats_B0: true, bootstrap_significant: false, SHIP: false }],
    [{ logLoss: 0.6726, ece: 0.010, boot: boot(-0.001) }, { log_loss_beats_B0: false, ece_beats_B0: true, bootstrap_significant: true, SHIP: false }],
    [{ logLoss: 0.6669, ece: 0.0388, boot: boot(-0.001) }, { log_loss_beats_B0: true, ece_beats_B0: false, bootstrap_significant: true, SHIP: false }],
    [{ logLoss: 0.6669, ece: 0.010, boot: { error: 'too few groups' } }, { log_loss_beats_B0: true, ece_beats_B0: true, bootstrap_significant: false, SHIP: false }]
  ];
  for (const [input, want] of rows) {
    assert.deepEqual(V.postureGateVerdict({ ...B0, ...input }), want, JSON.stringify(input));
  }
});
