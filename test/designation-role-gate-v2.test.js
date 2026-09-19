/**
 * G2-v2 — the restructured designation x role gate.
 *
 * The rule is docs/tdd/play-chance-gate-v2.md, committed before the fit was re-run
 * under it. Section 5 of that document lists the tests it requires before the rule may
 * decide anything; these are them.
 *
 * The cells here are hand-built rather than drawn from the database, because the thing
 * under test is the DECISION RULE, not the fit. A cell built by hand lets each branch
 * be hit exactly: a real degradation, a noisy one, and the fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { designationRoleGate, DESIGNATION_ROLE_GATE, rowLogLoss } =
  await import('../server/services/contingency.js');

const V1 = { ...DESIGNATION_ROLE_GATE, logLossBootstrap: false };

/**
 * One cell's worth of rows. `players` spreads the rows over that many player ids so
 * the clustered bootstrap has more than one cluster to resample — a single cluster
 * would give a degenerate interval and the test would pass for the wrong reason.
 */
function cell({ n, designation = 'none', tier = 'unknown', y, pCurrent, pCandidate, players = 10 }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      player_id: `p${i % players}`,
      y: typeof y === 'function' ? y(i) : y,
      p_current: typeof pCurrent === 'function' ? pCurrent(i) : pCurrent,
      p_candidate: typeof pCandidate === 'function' ? pCandidate(i) : pCandidate,
      rs: designation, tier
    });
  }
  return out;
}

/** Only the cells the gate actually judged, so a helper row cannot be mistaken for one. */
const gatedCells = result => result.cells.filter(c => c.gated);
const find = (result, designation, role) =>
  result.cells.find(c => c.designation === designation && c.role === role);

test('a cell with a large real degradation still fails, and the bootstrap is what said so', () => {
  // 90% of these players play. Current says 0.90 and is right; the candidate says 0.30
  // and is badly wrong, so its log loss is far worse than current + 0.02 and no amount
  // of resampling makes that ambiguous.
  const rows = cell({ n: 400, y: i => (i % 10 === 0 ? 0 : 1), pCurrent: 0.9, pCandidate: 0.3 });
  const result = designationRoleGate(rows);
  const c = find(result, 'none', 'unknown');
  assert.equal(c.gated, true);
  assert.equal(c.log_loss_basis, 'bootstrap_ci90');
  assert.equal(c.log_loss_pass, false, 'a real degradation must still veto');
  assert.ok(c.log_loss_ci90[0] > DESIGNATION_ROLE_GATE.logLossSlack,
    `the whole interval must sit above the slack, got ${JSON.stringify(c.log_loss_ci90)}`);
  assert.equal(result.pass, false);
  // And v1 agrees, which is the point: on a large cell with a real effect the two
  // rules give the same answer. The change is only meant to bite on noise.
  assert.equal(find(designationRoleGate(rows, V1), 'none', 'unknown').log_loss_pass, false);
});

test('a noisy cell whose interval straddles the slack passes v2 and failed v1', () => {
  // This is the case the restructure exists for, and the fixture is computed rather
  // than guessed at: 60 rows, 8 of which did not play, current saying 0.88 for
  // everyone, and the candidate dropping to 0.60 on exactly FOUR rows that did play.
  //
  // That gives a point log loss of 0.39349 current against 0.41902 candidate, a
  // difference of 0.02553 — just past the 0.02 slack, so v1 vetoes. But the whole
  // difference is carried by four rows out of sixty, so a resample that misses them
  // sees no degradation at all and the interval is far wider than the effect.
  //
  // The first fixture written here put the candidate's lower predictions on the rows
  // that did NOT play, which made the candidate better and v1 passed it. Stating that
  // because "a small cell with a worse point estimate" is not automatically this case,
  // and the arithmetic is what decides whether a fixture is in the ambiguous region.
  //
  // Calibration is deliberately clean (bias 0.0053 against a tolerance of 0.0878) so
  // this test isolates the log-loss condition and nothing else.
  const DROPPED = new Set([1, 2, 3, 4]);
  const rows = cell({
    n: 60, players: 12,
    y: i => (i % 8 === 0 ? 0 : 1),
    pCurrent: 0.88,
    pCandidate: i => (DROPPED.has(i) ? 0.60 : 0.88)
  });

  const v1 = find(designationRoleGate(rows, V1), 'none', 'unknown');
  const v2 = find(designationRoleGate(rows), 'none', 'unknown');

  assert.equal(v1.gated, true);
  assert.equal(v2.gated, true);
  // Both see the same point estimate; only the question differs.
  assert.equal(v2.log_loss_point_pass, v1.log_loss_pass);
  assert.equal(v1.log_loss_pass, false, 'v1 must fail this cell on the point estimate');
  assert.equal(v2.log_loss_basis, 'bootstrap_ci90');
  assert.equal(v2.log_loss_pass, true, 'v2 must not veto a degradation it cannot demonstrate');
  assert.ok(v2.log_loss_ci90[0] <= DESIGNATION_ROLE_GATE.logLossSlack,
    `the interval must straddle or sit below the slack, got ${JSON.stringify(v2.log_loss_ci90)}`);
  assert.ok(v2.log_loss_ci90[1] > DESIGNATION_ROLE_GATE.logLossSlack,
    'and it must reach above it, or this cell is not the ambiguous case it claims to be');
});

test('with the bootstrap off, v2 reproduces v1 cell for cell', () => {
  // The diff must be provably confined to the one condition. Any other change would
  // show up here as a differing field on some cell.
  const rows = [
    ...cell({ n: 300, designation: 'noreport', tier: 'starter', y: i => (i % 20 === 0 ? 0 : 1),
      pCurrent: 0.7, pCandidate: 0.94 }),
    ...cell({ n: 80, designation: 'questionable', tier: 'depth', y: i => (i % 3 === 0 ? 1 : 0),
      pCurrent: 0.5, pCandidate: 0.42 }),
    ...cell({ n: 40, designation: 'out', tier: 'fringe', y: 0, pCurrent: 0.2, pCandidate: 0.05 })
  ];
  const a = designationRoleGate(rows, V1);
  const b = designationRoleGate(rows, { ...DESIGNATION_ROLE_GATE, logLossBootstrap: false });
  assert.deepEqual(b, a);

  // And every field v1 ever produced is still produced by the live rule, so no
  // consumer of this shape breaks.
  const live = designationRoleGate(rows);
  for (const key of Object.keys(a.cells[0])) {
    assert.ok(key in live.cells[0], `v2 dropped the field ${key}`);
  }
});

test('an ungated cell is judged by neither rule and cannot veto', () => {
  const rows = cell({ n: 49, y: 1, pCurrent: 0.95, pCandidate: 0.05 });
  const result = designationRoleGate(rows);
  const c = find(result, 'none', 'unknown');
  assert.equal(c.n, 49);
  assert.equal(c.gated, false, 'below minCell it is not gated');
  assert.equal(c.pass, true, 'and an ungated cell passes however bad it looks');
  // The pooled row is the same 49 rows, so it is ungated too. This is what section 2.2
  // means by a thin cell's evidence being weighed at the pooled level rather than
  // discarded: pooling only helps once something else shares the designation.
  assert.equal(find(result, 'none', '*').gated, false);
});

test('a thin cell rolls up into its designation pooled row, and the pooled row is gated', () => {
  // Two thin role cells under one designation. Neither is gated on its own; together
  // they clear minCell at the pooled `*` row, which IS gated.
  const rows = [
    ...cell({ n: 30, designation: 'none', tier: 'depth', y: 1, pCurrent: 0.9, pCandidate: 0.9 }),
    ...cell({ n: 30, designation: 'none', tier: 'fringe', y: 1, pCurrent: 0.9, pCandidate: 0.9 })
  ];
  const result = designationRoleGate(rows);
  assert.equal(find(result, 'none', 'depth').gated, false);
  assert.equal(find(result, 'none', 'fringe').gated, false);
  const pooled = find(result, 'none', '*');
  assert.equal(pooled.n, 60);
  assert.equal(pooled.gated, true);
});

test('a pooled row that fails blocks the gate, with no size escape', () => {
  // Section 2.3. The pooled row is built from thin role cells that individually escape
  // gating, and it is bad enough that the bootstrap confirms it. The gate must fail.
  const rows = [
    ...cell({ n: 150, designation: 'none', tier: 'depth', players: 15,
      y: i => (i % 10 === 0 ? 0 : 1), pCurrent: 0.9, pCandidate: 0.25 }),
    ...cell({ n: 150, designation: 'none', tier: 'fringe', players: 15,
      y: i => (i % 10 === 0 ? 0 : 1), pCurrent: 0.9, pCandidate: 0.25 })
  ];
  const result = designationRoleGate(rows);
  const pooled = find(result, 'none', '*');
  assert.equal(pooled.gated, true);
  assert.equal(pooled.pass, false);
  assert.equal(result.pass, false, 'a failing pooled row must block the whole gate');
});

test('the calibration condition is untouched by the restructure', () => {
  // A cell whose candidate log loss is fine but whose mean is biased well outside the
  // tolerance must still fail, and it must fail on calibration rather than log loss.
  // 50% of these play; the candidate predicts 0.99 for everyone.
  const rows = cell({ n: 500, players: 25, y: i => i % 2, pCurrent: 0.5, pCandidate: 0.99 });
  const result = designationRoleGate(rows);
  const c = find(result, 'none', 'unknown');
  assert.equal(c.calibration_pass, false);
  assert.equal(result.pass, false);
  // Identical verdict under v1: nothing about calibration moved.
  assert.equal(find(designationRoleGate(rows, V1), 'none', 'unknown').calibration_pass, false);
});

test('the fallback path is taken, and labelled, when a cell cannot be bootstrapped', () => {
  // minBootstrapRows raised above the cell's size stands in for the real trigger
  // (pairedBootstrapDiff refusing below 10 rows), which minCell=50 makes unreachable
  // through the live config. The branch still has to be exercised, and labelled, so a
  // cell that could not be evaluated is never silently passed.
  const gate = { ...DESIGNATION_ROLE_GATE, minBootstrapRows: 1000 };
  const rows = cell({ n: 400, players: 20, y: i => (i % 10 === 0 ? 0 : 1),
    pCurrent: 0.9, pCandidate: 0.3 });
  const c = find(designationRoleGate(rows, gate), 'none', 'unknown');
  assert.equal(c.log_loss_basis, 'point_estimate');
  assert.equal(c.log_loss_ci90, null);
  assert.equal(c.log_loss_pass, false, 'the fallback must still catch a real degradation');
});

test('an improving cell passes under both rules, and the interval is below the slack', () => {
  // The case that matters for shipping: current is the miscalibrated constants path,
  // the candidate is right. 94% of these play; current says 0.70, candidate says 0.94.
  const rows = cell({ n: 1800, players: 90, y: i => (i % 17 === 0 ? 0 : 1),
    pCurrent: 0.7, pCandidate: 0.94 });
  const result = designationRoleGate(rows);
  const c = find(result, 'none', 'unknown');
  assert.equal(c.log_loss_pass, true);
  assert.equal(c.calibration_pass, true);
  assert.ok(c.log_loss_ci90[1] < 0, `an improvement should sit entirely below zero, got ${JSON.stringify(c.log_loss_ci90)}`);
  assert.equal(result.pass, true);
  assert.equal(find(designationRoleGate(rows, V1), 'none', 'unknown').pass, true);
});

test('rowLogLoss is what the bootstrap is fed, clipped the same way the gate scores', () => {
  // If these two ever diverge, the interval would be describing a different quantity
  // from the point estimate it is compared against.
  assert.equal(rowLogLoss(1, 1), -Math.log(0.999));
  assert.equal(rowLogLoss(0, 1), -Math.log(0.001));
  assert.ok(rowLogLoss(0.9, 1) < rowLogLoss(0.5, 1));
});

test('every gated cell reports which rule decided it', () => {
  const rows = [
    ...cell({ n: 300, designation: 'noreport', tier: 'starter', players: 30,
      y: i => (i % 20 === 0 ? 0 : 1), pCurrent: 0.7, pCandidate: 0.94 }),
    ...cell({ n: 60, designation: 'none', tier: 'unknown', players: 12,
      y: i => (i % 6 === 0 ? 0 : 1), pCurrent: 0.88, pCandidate: i => (i % 3 === 0 ? 0.55 : 0.88) })
  ];
  const result = designationRoleGate(rows);
  const gated = gatedCells(result);
  assert.ok(gated.length >= 3, `expected the two role cells and their pooled rows, got ${gated.length}`);
  for (const c of gated) {
    assert.equal(c.log_loss_basis, 'bootstrap_ci90', `${c.designation}/${c.role} was not bootstrapped`);
    assert.ok(Array.isArray(c.log_loss_ci90));
    assert.equal(typeof c.log_loss_mean_diff, 'number');
  }
});
