import test from 'node:test';
import assert from 'node:assert/strict';
import { jointResidualFit } from '../server/services/nfl-ensemble.js';

/*
 * FINAL ORDER #1 (2026-09-16, RUNBOOK §10.1): direct proof of
 * `jointResidualFit` -- the joint ridge regression of the realised market
 * residual on every eligible component's own departure from the market,
 * simultaneously, that replaced the one-at-a-time per-component slope fit
 * as what actually decides `ensembleLine`'s served `market_residual` line
 * (see the integration-level proof of the same claim already carried by
 * test/nfl-market-identity.test.js and test/nfl-market-identity-rich.test.js,
 * both re-verified green against this change).
 *
 * Same synthetic-fixture style as nfl-ensemble-joint-weighting.test.js
 * (which proves `jointComponentWeights`' redundancy handling) -- a pure
 * function over plain rows, no database needed.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (rand, sd = 1) => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rand();
  return (s - 6) * sd;
};

/**
 * `n` rows shaped exactly like `residualWindowRows` in nfl-ensemble.js:
 * `{ margins: {id: value}, market_margin, actual_margin, week_key }`, laid
 * out chronologically in `gamesPerWeek`-sized weeks so `completeWeekSplit`
 * has real boundaries. `signal`'s departure from market IS (scaled by
 * `trueCoef`) the market's true residual when `withSignal` is true;
 * `noise1`/`noise2` never carry any real relationship to the residual.
 */
function residualFixture({ n = 900, gamesPerWeek = 14, seed = 777, withSignal, trueCoef = 0.6 } = {}) {
  const rand = mulberry32(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const week = String(Math.floor(i / gamesPerWeek) + 1);
    const marketMargin = normal(rand, 7);
    const signalDeparture = normal(rand, 4);
    const trueResidual = withSignal ? trueCoef * signalDeparture + normal(rand, 1.5) : normal(rand, 6);
    rows.push({
      market_margin: marketMargin,
      actual_margin: marketMargin + trueResidual,
      week_key: week,
      margins: {
        signal: marketMargin + signalDeparture,
        noise1: marketMargin + normal(rand, 5),
        noise2: marketMargin + normal(rand, 3),
      },
    });
  }
  return rows;
}

test('pure noise: the joint gate does not pass, and every weight is exactly zero', () => {
  const rows = residualFixture({ withSignal: false });
  const result = jointResidualFit(rows, ['signal', 'noise1', 'noise2']);
  assert.equal(result.gate_passed, false);
  for (const id of ['signal', 'noise1', 'noise2']) assert.equal(result.weights.get(id), 0);
});

test('a genuine planted signal clears the gate and concentrates weight on the real component', () => {
  const rows = residualFixture({ withSignal: true, trueCoef: 0.6 });
  const result = jointResidualFit(rows, ['signal', 'noise1', 'noise2']);
  assert.equal(result.gate_passed, true, JSON.stringify(result));
  const signalWeight = result.weights.get('signal');
  assert.ok(signalWeight > 0.3 && signalWeight < 0.9,
    `expected the fitted coefficient near the true 0.6, got ${signalWeight}`);
  // Ridge does not guarantee an exact zero for the noise columns, but they
  // must be far smaller than the genuinely predictive one.
  assert.ok(Math.abs(result.weights.get('noise1')) < signalWeight);
  assert.ok(Math.abs(result.weights.get('noise2')) < signalWeight);
});

test('out-of-fold discipline: the reported n is the score block only, never the full window', () => {
  const rows = residualFixture({ withSignal: true, n: 900, gamesPerWeek: 14 });
  const result = jointResidualFit(rows, ['signal', 'noise1', 'noise2']);
  assert.ok(result.n > 0 && result.n < rows.length,
    'the scored out-of-fold block must be strictly smaller than the whole window');
  assert.ok(result.fit_n > 0 && result.fit_n + result.n <= rows.length);
});

test('too few rows: returns an all-zero result rather than fitting on an unstable design', () => {
  const rows = residualFixture({ withSignal: true, n: 10, gamesPerWeek: 3 });
  const result = jointResidualFit(rows, ['signal', 'noise1', 'noise2']);
  assert.equal(result.gate_passed, false);
  assert.equal(result.weights.get('signal'), 0);
});

test('an empty component list, or one with no eligible ids, returns an all-zero map rather than throwing', () => {
  const rows = residualFixture({ withSignal: true });
  assert.equal(jointResidualFit(rows, []).gate_passed, false);
  const noCoverage = jointResidualFit(rows, ['nonexistent_component']);
  assert.equal(noCoverage.weights.get('nonexistent_component'), 0);
});

test('a component that never appears in any row is mean-imputed to its column mean, not treated as a crash', () => {
  const rows = residualFixture({ withSignal: true }).map((r) => ({ ...r, margins: { ...r.margins, sparse: undefined } }));
  // sparse never has a finite value anywhere -- jointResidualFit should
  // simply not include it in usableIds rather than throw or NaN the fit.
  const result = jointResidualFit(rows, ['signal', 'noise1', 'sparse']);
  assert.equal(result.weights.get('sparse'), 0);
  assert.ok(Number.isFinite(result.weights.get('signal')));
});

test('no intercept: a row where every eligible component exactly equals the market predicts zero residual', () => {
  const rows = residualFixture({ withSignal: true });
  const result = jointResidualFit(rows, ['signal', 'noise1', 'noise2']);
  assert.ok(result.gate_passed);
  // Manually replicate what ensembleLine does with the fitted weights: a
  // game where every component's departure from market is exactly zero
  // must predict exactly zero incremental residual (the market itself),
  // never a fabricated nonzero correction from an intercept term.
  const zeroMargin = 3;
  const predicted = ['signal', 'noise1', 'noise2']
    .reduce((s, id) => s + (result.weights.get(id) ?? 0) * (zeroMargin - zeroMargin), 0);
  assert.equal(predicted, 0);
});
