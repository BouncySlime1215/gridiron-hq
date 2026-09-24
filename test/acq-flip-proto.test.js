/**
 * ACQ-FLIP prototype: the path-scoring math on a fixture (no DB, no simulation).
 * The study script only loads services inside main(), so importing it is pure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  screenPct, screenFair, pathExpectation, isChained, flipSpread, linearNick, combos, SCREEN_WINDOW
} = await import('../scripts/study/acq-flip-proto.mjs');

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('screen fairness uses the finder window on his side', () => {
  close(screenPct(110, 100), 10);
  assert.equal(screenPct(10, 0), null);
  assert.equal(screenFair(100 * (1 + SCREEN_WINDOW.high / 100), 100), true);
  assert.equal(screenFair(119, 100), false);
  assert.equal(screenFair(88, 100), true);
  assert.equal(screenFair(87, 100), false);
});

test('a one-step path is P x delta', () => {
  const e = pathExpectation([{ p: 0.3, delta: 0.1, se: 0.01 }]);
  close(e.p_complete, 0.3);
  close(e.score, 0.03);
  close(e.expected, 0.03);
  close(e.stranded, 0);
  close(e.expected_se, 0.003);
});

test('a declined later leg strands the earlier state', () => {
  // Step 1 (p .5) costs Nick 2 points of title odds; step 2 (p .4) ends at +10.
  const e = pathExpectation([{ p: 0.5, delta: -0.02, se: 0.004 }, { p: 0.4, delta: 0.10, se: 0.01 }]);
  close(e.p_complete, 0.2);
  close(e.score, 0.02);
  // 0.5 declined at step 1 -> 0; 0.5*0.6 stranded at -0.02; 0.2 complete at +0.10
  close(e.stranded, 0.3 * -0.02);
  close(e.expected, 0.3 * -0.02 + 0.2 * 0.10);
  close(e.expected_se, Math.sqrt((0.3 * 0.004) ** 2 + (0.2 * 0.01) ** 2));
  // A path is never scored above its complete-case value when earlier states lose.
  assert.ok(e.expected < e.score);
});

test('three steps weight every stopping point', () => {
  const steps = [{ p: 0.5, delta: 0.01 }, { p: 0.5, delta: 0.02 }, { p: 0.5, delta: 0.04 }];
  const e = pathExpectation(steps);
  close(e.expected, 0.25 * 0.01 + 0.125 * 0.02 + 0.125 * 0.04);
  assert.equal(e.expected_se, null);
  assert.deepEqual(pathExpectation([]).expected, 0);
});

test('chained only when a later step spends a player an earlier one bought', () => {
  assert.equal(isChained([{ give: [1], get: [9] }, { give: [9, 2], get: [7] }]), true);
  assert.equal(isChained([{ give: [1], get: [9] }, { give: [2], get: [7] }]), false);
  assert.equal(isChained([{ give: [1], get: [9] }]), false);
});

test('flip spread clears noise only past 2 combined SE', () => {
  const s = flipSpread(0.10, 0.01, -0.05, 0.01);
  close(s.spread, 0.05);
  close(s.se, Math.sqrt(2) * 0.01);
  assert.equal(s.clears, true);
  assert.equal(flipSpread(0.03, 0.01, -0.01, 0.01).clears, false);
  assert.equal(flipSpread(0, null, 0, null).clears, false);
});

test('linear Nick value nets out players that pass through', () => {
  const add = new Map([[9, 0.05], [7, 0.08]]);
  const loss = new Map([[1, -0.01], [2, -0.02]]);
  // Nick had 1,2,3; bought 9 with 1, then 7 with 9+2: ends 3,7.
  close(linearNick([3, 7], [1, 2, 3], add, loss), 0.08 - 0.01 - 0.02);
  assert.equal(combos([1, 2, 3], 2).length, 6);
  assert.equal(combos([1, 2, 3], 1).length, 3);
});
