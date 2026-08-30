/**
 * The waiver half of the brain, and the horizon it prices on.
 *
 * The sell-high test below is the one that matters most: the first version of
 * that function recommended selling the two best players on the roster, and the
 * reason was a modelling error subtle enough to look like a finding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { playoffWeight, horizonValue } from '../server/services/waiver-brain.js';

test('the playoff horizon matters more as the season runs', () => {
  let prev = -1;
  for (const week of [1, 3, 6, 9, 12, 14]) {
    const w = playoffWeight(week);
    assert.ok(w > prev, `week ${week} weight ${w} did not increase from ${prev}`);
    prev = w;
  }
});

test('once the playoffs start, the regular season is worth nothing', () => {
  for (const week of [15, 16, 17, 18]) {
    assert.equal(playoffWeight(week), 1, `week ${week} should weight playoffs fully`);
  }
});

test('the horizon weight never reaches either extreme during the regular season', () => {
  // Never 0, because a September pickup is still on the roster in December.
  // Never 1, because you have to reach the playoffs before that schedule counts.
  for (const week of [1, 7, 14]) {
    const w = playoffWeight(week);
    assert.ok(w > 0 && w < 1, `week ${week} produced a degenerate weight of ${w}`);
  }
});

test('horizon value sits between the season and playoff projections', () => {
  const player = { adj_ppg: 10, playoff_ppg: 20 };
  for (const week of [1, 8, 14]) {
    const v = horizonValue(player, week);
    assert.ok(v >= 10 && v <= 20, `week ${week} blended to ${v}, outside its own inputs`);
  }
  // In the playoffs it is the playoff number and nothing else.
  assert.equal(horizonValue(player, 16), 20);
});

test('a player with no playoff projection falls back to his season number', () => {
  assert.equal(horizonValue({ adj_ppg: 12 }, 10), 12);
  assert.equal(horizonValue({ adj_ppg: 12, playoff_ppg: null }, 10), 12);
});

test('horizon value handles a player with no projection at all', () => {
  const v = horizonValue({}, 5);
  assert.ok(Number.isFinite(v), `produced ${v}`);
  assert.equal(v, 0);
});

test('a weak week number cannot produce a nonsense weight', () => {
  for (const week of [0, -5, NaN, undefined, null]) {
    const w = playoffWeight(week);
    assert.ok(Number.isFinite(w) && w >= 0 && w <= 1, `week ${week} produced ${w}`);
  }
});

/**
 * The convexity trap, stated as a test.
 *
 * Fantasy value is steeply convex in production because it prices scarcity. A
 * flat value-per-point ratio therefore makes every elite player look wildly
 * overpriced — which is exactly what the first sell-high implementation did,
 * recommending a sale of the roster's two best running backs at "535%" and
 * "460%" premiums. This asserts the property that makes the flat ratio wrong,
 * so the reasoning behind the power-law fit stays documented in the suite.
 */
test('value per point rises with production, so a flat ratio mislabels stars', () => {
  // A realistic convex market: value roughly proportional to points^2.
  const market = [4, 8, 12, 16, 20].map(pts => ({ pts, value: pts ** 2 }));
  const ratios = market.map(p => p.value / p.pts);
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(ratios[i] > ratios[i - 1],
      'value per point should rise with production in a convex market');
  }
  // The best player's ratio against the median is enormous — and means nothing.
  const median = ratios[Math.floor(ratios.length / 2)];
  const topPremium = ratios[ratios.length - 1] / median - 1;
  assert.ok(topPremium > 0.5,
    'the flat-ratio method should flag the best player by a wide margin, which is the bug');

  // A log-log fit recovers the exponent and leaves no residual, so nobody is
  // flagged. That is the property the real implementation relies on.
  const xs = market.map(p => Math.log(p.pts));
  const ys = market.map(p => Math.log(p.value));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxy / sxx;
  assert.ok(Math.abs(slope - 2) < 1e-9, `power-law fit recovered ${slope}, expected 2`);
});
