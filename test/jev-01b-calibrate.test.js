/**
 * JEV-01b: the calibration map and the blend weight, on synthetic points.
 *
 * Pre-registration: docs/evidence/2026-09-24/jev-01b-chat-preregistration.md.
 * These are the spec's RED items that need no database:
 *  (1) a perfectly calibrated arm gets an identity isotonic map to 1e-9;
 *  (2) an arm that always says 0.9 on a 30%-true fixture maps to ~0.3;
 *  (3) an arm worse than the incumbent ends with weight <= 0.05 and the grade
 *      says "incumbent leads";
 *  (5) the blend with Jev's weight at 0 reproduces the incumbent exactly;
 *  and the floor: a thin question is a typed unknown, never a number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { fitCalibration, applyCalibration, ISOTONIC_MIN_N, PLATT_RIDGE, logit } =
  await import('../server/services/jev/calibrate.js');
const { blend, logLoss } = await import('../server/services/jev/stack.js');
const { gradeUnits, MIN_N } = await import('../server/services/jev/chat-grader.js');

// A tiny deterministic generator, so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('a perfectly calibrated arm gets an identity isotonic map to 1e-9', () => {
  const points = [];
  for (let k = 1; k <= 9; k++) {
    const p = k / 10;
    // exactly p of each block is true, so the observed rate IS the claim
    for (let i = 0; i < 100; i++) points.push({ p, y: i < k * 10 ? 1 : 0 });
  }
  assert.ok(points.length >= ISOTONIC_MIN_N);
  const cal = fitCalibration(points);
  assert.equal(cal.kind, 'isotonic');
  for (let k = 1; k <= 9; k++) {
    assert.ok(Math.abs(applyCalibration(cal, k / 10) - k / 10) < 1e-9, `p=${k / 10}`);
  }
  // between blocks too: linear between centres that lie on the diagonal
  assert.ok(Math.abs(applyCalibration(cal, 0.35) - 0.35) < 1e-9);
});

test('an arm that always says 0.9 on a 30%-true fixture maps to ~0.3', () => {
  for (const n of [300, 100]) { // isotonic above the n floor, Platt below it
    const points = Array.from({ length: n }, (_, i) => ({ p: 0.9, y: i % 10 < 3 ? 1 : 0 }));
    const cal = fitCalibration(points);
    assert.equal(cal.kind, n >= ISOTONIC_MIN_N ? 'isotonic' : 'platt');
    assert.ok(Math.abs(applyCalibration(cal, 0.9) - 0.3) < 0.01, `${cal.kind}: ${applyCalibration(cal, 0.9)}`);
  }
});

const softplus = z => (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)));

test('Platt lands on the minimum of its own objective when the claims separate the outcomes', () => {
  // Claims at 0.01 / 0.99 that are always right push the slope up hard. The
  // objective is the smooth penalised logistic loss; measured before the fix,
  // a damped fit on the CLAMPED loss stalled at a = 2.08; the minimum is 2.63.
  const points = Array.from({ length: 100 }, (_, i) => ({ p: i < 50 ? 0.01 : 0.99, y: i < 50 ? 0 : 1 }));
  const cal = fitCalibration(points);
  assert.equal(cal.kind, 'platt');
  const objective = (a, b) => PLATT_RIDGE * a * a / 2 + points.reduce((s, { p, y }) => {
    const z = a * (logit(p) - cal.mu) + b;
    return s + softplus(y ? -z : z);
  }, 0);
  const at = objective(cal.a, cal.b);
  for (const [da, db] of [[0.01, 0], [-0.01, 0], [0, 0.01], [0, -0.01]]) {
    assert.ok(at <= objective(cal.a + da, cal.b + db), `not a minimum along (${da}, ${db})`);
  }
});

test('the blend with weight 0 is the incumbent, exactly', () => {
  for (const inc of [0.01, 0.123456789, 0.5, 0.97]) {
    assert.equal(blend(inc, 0.9, 0), inc);
    assert.equal(blend(inc, 0.02, 0), inc);
  }
  // and weight 1 is the calibrated Jev claim
  assert.ok(Math.abs(blend(0.2, 0.7, 1) - 0.7) < 1e-12);
});

test('an arm worse than the incumbent gets weight <= 0.05 and the grade says the incumbent leads', () => {
  const r = rng(7);
  const units = [];
  // The incumbent is exactly right: outcome rates are fixed by construction
  // (3 in 20 for one group, 3 in 4 for the other), not drawn, so no sample
  // drift can make shrinking toward the middle look like skill. Jev is noise.
  for (let i = 0; i < 400; i++) {
    const high = i % 2 === 1, j = Math.floor(i / 2);
    const y = high ? (j % 4 < 3 ? 1 : 0) : (j % 20 < 3 ? 1 : 0);
    units.push({ t: i, cluster: `m${i % 8}`, inc: high ? 0.75 : 0.15, claim: r(), y });
  }
  const grade = gradeUnits(units);
  assert.equal(grade.status, 'measured');
  assert.ok(grade.weight <= 0.05, `served weight ${grade.weight}`);
  assert.equal(grade.leader, 'incumbent');
  assert.match(grade.text, /incumbent leads/);
});

test('the weight is fitted out-of-fold: a noise arm at n=300 stays under the floor', () => {
  // Same exactly-right incumbent as above, 300 units, so the training folds
  // sit just above and below the isotonic floor. Measured on this fixture:
  // seed 6 buys weight 0.110 when fitted on in-sample isotonic output and
  // 0.007 out-of-fold. Seed 1's out-of-fold Platt fit (168 claims) is the one
  // plain Newton could not converge on.
  for (const seed of [1, 6]) {
    const r = rng(seed);
    const units = [];
    for (let i = 0; i < 300; i++) {
      const high = i % 2 === 1, j = Math.floor(i / 2);
      const y = high ? (j % 4 < 3 ? 1 : 0) : (j % 20 < 3 ? 1 : 0);
      units.push({ t: i, cluster: `m${i % 8}`, inc: high ? 0.75 : 0.15, claim: r(), y });
    }
    const grade = gradeUnits(units);
    assert.equal(grade.status, 'measured');
    if (seed === 6) {
      assert.ok(grade.holdout.weight <= 0.05, `holdout weight ${grade.holdout.weight}`);
      assert.ok(grade.weight <= 0.05, `served weight ${grade.weight}`);
    }
  }
});

test('an informative arm earns weight and a lower holdout log loss than the incumbent', () => {
  const r = rng(11);
  const units = [];
  for (let i = 0; i < 400; i++) {
    const truth = r() < 0.5 ? 0.1 : 0.8;
    units.push({ t: i, cluster: `m${i % 8}`, inc: 0.45, claim: truth === 0.8 ? 0.6 + 0.3 * r() : 0.3 * r(),
      y: r() < truth ? 1 : 0 });
  }
  const grade = gradeUnits(units);
  assert.equal(grade.status, 'measured');
  assert.ok(grade.weight > 0.5, `weight ${grade.weight}`);
  assert.ok(grade.holdout.log_loss_blend < grade.holdout.log_loss_incumbent);
  assert.equal(grade.leader, 'jev');
  assert.ok(grade.holdout.diff_ci90[1] < 0);
});

test('a thin question is a typed unknown with its n and floor, never a number', () => {
  const units = Array.from({ length: MIN_N - 1 }, (_, i) => ({ t: i, cluster: 'm', inc: 0.3, claim: 0.5, y: i % 2 }));
  const grade = gradeUnits(units);
  assert.equal(grade.status, 'unknown');
  assert.equal(grade.reason, 'thin');
  assert.equal(grade.n, MIN_N - 1);
  assert.equal(grade.floor.n, MIN_N);
  assert.equal(grade.weight, undefined);
  assert.equal(grade.calibration, undefined);
  // one outcome class under its floor is thin too, however many units there are
  const oneSided = Array.from({ length: 300 }, (_, i) => ({ t: i, cluster: 'm', inc: 0.3, claim: 0.5, y: i < 5 ? 1 : 0 }));
  assert.equal(gradeUnits(oneSided).reason, 'thin');
  const otherSide = Array.from({ length: 300 }, (_, i) => ({ t: i, cluster: 'm', inc: 0.3, claim: 0.5, y: i < 5 ? 0 : 1 }));
  assert.equal(gradeUnits(otherSide).reason, 'thin');
});

test('log loss is finite at the edges', () => {
  assert.ok(Number.isFinite(logLoss([{ p: 0, y: 1 }, { p: 1, y: 0 }])));
});
