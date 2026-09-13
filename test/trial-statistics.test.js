import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autocovariance, geyerIntegratedAutocorrelationTime, effectiveTrialCount,
  expectedMaxSharpeUnderNull, probabilisticSharpeRatio, deflatedSharpeRatio,
  reconstructBetReturns, sharpeStatsFromReturns, probabilityOfBacktestOverfitting,
} from '../server/services/trial-statistics.js';
import { withRandomSeed, randn } from '../server/services/stats-util.js';

function iidSequence(seed, n) {
  const xs = [];
  withRandomSeed(seed, () => { for (let i = 0; i < n; i++) xs.push(randn()); });
  return xs;
}

// AR(1): x[i] = phi*x[i-1] + noise. Theoretical integrated autocorrelation
// time for an AR(1) process is (1+phi)/(1-phi).
function ar1Sequence(seed, n, phi) {
  const xs = [0];
  withRandomSeed(seed, () => {
    for (let i = 1; i < n; i++) xs.push(phi * xs[i - 1] + randn());
  });
  return xs;
}

test('autocovariance at lag 0 equals the population variance', () => {
  const x = [1, 2, 3, 4, 5];
  const mu = 3;
  const g0 = autocovariance(x, 0, mu);
  const expected = x.reduce((s, v) => s + (v - mu) ** 2, 0) / x.length;
  assert.ok(Math.abs(g0 - expected) < 1e-9);
});

test('a short sequence (n<8) falls back to tau=1, no correction', () => {
  const g = geyerIntegratedAutocorrelationTime([1, 2, 3, 4, 5]);
  assert.equal(g.tau, 1);
  assert.match(g.note, /too short/);
});

test('a zero-variance (constant) sequence falls back to tau=1', () => {
  const g = geyerIntegratedAutocorrelationTime(new Array(20).fill(5));
  assert.equal(g.tau, 1);
  assert.match(g.note, /zero-variance/);
});

test('an i.i.d. sequence has an integrated autocorrelation time near 1 (little to no correction)', () => {
  const x = iidSequence(1, 400);
  const g = geyerIntegratedAutocorrelationTime(x);
  assert.ok(g.tau < 2, `expected tau close to 1 for i.i.d. data, got ${g.tau}`);
  const eff = effectiveTrialCount(x);
  assert.ok(eff.n_effective > eff.n_raw * 0.5, `expected little reduction for i.i.d. data, got n_eff=${eff.n_effective} of n_raw=${eff.n_raw}`);
});

test('a strongly autocorrelated AR(1) sequence has a materially larger tau and smaller n_effective', () => {
  const x = ar1Sequence(2, 400, 0.8); // theoretical tau = 1.8/0.2 = 9
  const g = geyerIntegratedAutocorrelationTime(x);
  assert.ok(g.tau > 3, `expected tau meaningfully above 1 for phi=0.8 AR(1), got ${g.tau}`);
  const eff = effectiveTrialCount(x);
  assert.ok(eff.n_effective < eff.n_raw / 2, `expected n_effective well below n_raw, got ${eff.n_effective} of ${eff.n_raw}`);
});

test('effectiveTrialCount never exceeds the raw count', () => {
  const x = iidSequence(3, 60);
  const eff = effectiveTrialCount(x);
  assert.ok(eff.n_effective <= eff.n_raw + 1e-9);
});

test('expectedMaxSharpeUnderNull is 0 for a single trial and grows with more trials', () => {
  assert.equal(expectedMaxSharpeUnderNull({ nTrials: 1, sharpeStd: 0.5 }), 0);
  const sr10 = expectedMaxSharpeUnderNull({ nTrials: 10, sharpeStd: 0.5 });
  const sr100 = expectedMaxSharpeUnderNull({ nTrials: 100, sharpeStd: 0.5 });
  assert.ok(sr10 > 0);
  assert.ok(sr100 > sr10, `expected the null benchmark to rise with more trials: ${sr10} vs ${sr100}`);
});

test('probabilisticSharpeRatio is 0.5 exactly at the benchmark, and rises above it as sharpe grows', () => {
  const atBenchmark = probabilisticSharpeRatio({ sharpe: 0.3, benchmark: 0.3, n: 100 });
  assert.ok(Math.abs(atBenchmark - 0.5) < 1e-9);
  const above = probabilisticSharpeRatio({ sharpe: 0.8, benchmark: 0.3, n: 100 });
  assert.ok(above > 0.5);
});

test('deflatedSharpeRatio falls as the effective trial count rises, holding the observed result fixed', () => {
  const base = { sharpe: 0.3, n: 200, skewness: -0.2, kurtosis: 2.5, sharpeStdAcrossTrials: 0.15 };
  const fewTrials = deflatedSharpeRatio({ ...base, nTrialsEffective: 3 });
  const manyTrials = deflatedSharpeRatio({ ...base, nTrialsEffective: 50 });
  assert.ok(manyTrials.sr0_expected_max_sharpe_under_null > fewTrials.sr0_expected_max_sharpe_under_null);
  assert.ok(manyTrials.dsr < fewTrials.dsr,
    `expected DSR to fall as the number of (effective) trials tried grows: ${fewTrials.dsr} vs ${manyTrials.dsr}`);
});

test('reconstructBetReturns exactly reproduces the recorded aggregate mean (ROI) and sample size', () => {
  const agg = { bets: 184, wins: 96, losses: 85, units: 3.048 };
  const rec = reconstructBetReturns(agg);
  assert.equal(rec.returns.length, agg.bets);
  const mean = rec.returns.reduce((s, v) => s + v, 0) / rec.returns.length;
  assert.ok(Math.abs(mean - agg.units / agg.bets) < 1e-9);
});

test('reconstructBetReturns handles a variant with zero wins without dividing by zero', () => {
  const rec = reconstructBetReturns({ bets: 10, wins: 0, losses: 10, units: -10 });
  assert.equal(rec.returns.length, 10);
  assert.ok(rec.returns.every(v => v === -1));
});

test('sharpeStatsFromReturns: a real bet aggregate produces finite, sane moments', () => {
  const rec = reconstructBetReturns({ bets: 184, wins: 96, losses: 85, units: 3.048 });
  const stats = sharpeStatsFromReturns(rec.returns);
  assert.equal(stats.n, 184);
  assert.ok(Math.abs(stats.mean - 3.048 / 184) < 1e-9);
  assert.ok(Number.isFinite(stats.sharpe));
  assert.ok(Number.isFinite(stats.skewness));
  assert.ok(Number.isFinite(stats.kurtosis));
});

test('probabilityOfBacktestOverfitting requires at least 2 strategies and even subsets', () => {
  assert.match(probabilityOfBacktestOverfitting([{ id: 'a', periods: [1, 2, 3, 4] }]).error, /at least 2 strategies/);
  const twoStrats = [{ id: 'a', periods: [1, 2, 3, 4] }, { id: 'b', periods: [1, 2, 3, 4] }];
  assert.match(probabilityOfBacktestOverfitting(twoStrats, { subsets: 3 }).error, /even integer/);
});

test('probabilityOfBacktestOverfitting: a strategy that dominates every period scores PBO near 0', () => {
  const periods = 40;
  const good = Array.from({ length: periods }, () => 1); // always wins
  const noise1 = ar1Sequence(11, periods, 0.1);
  const noise2 = ar1Sequence(12, periods, 0.1);
  const noise3 = ar1Sequence(13, periods, 0.1);
  const strategies = [
    { id: 'good', periods: good },
    { id: 'noise1', periods: noise1 },
    { id: 'noise2', periods: noise2 },
    { id: 'noise3', periods: noise3 },
  ];
  const result = probabilityOfBacktestOverfitting(strategies, { subsets: 4 });
  assert.equal(result.strategies, 4);
  assert.ok(result.pbo < 0.2, `expected a dominant strategy to show low PBO, got ${result.pbo}`);
});

test('probabilityOfBacktestOverfitting: pure noise strategies score PBO near 0.5 on average', () => {
  const periods = 60;
  const strategies = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, periods: ar1Sequence(100 + i, periods, 0.05) }));
  const result = probabilityOfBacktestOverfitting(strategies, { subsets: 6 });
  assert.ok(result.pbo > 0.15 && result.pbo < 0.85,
    `expected noise-only strategies to land near chance PBO, got ${result.pbo}`);
});
