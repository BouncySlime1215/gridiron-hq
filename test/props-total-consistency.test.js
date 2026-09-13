import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-module tests: props-total-consistency.js takes no database dependency
// (see its header — clv-core.js's inverse-normal is deliberately re-derived
// here rather than imported, because importing clv-core.js opens the live
// db as a side effect). These tests use synthetic quote rows shaped exactly
// like real `nfl_prop_quote_snapshots` rows, never the real database.
const {
  pairPropQuotes, devigPropPairs, impliedMean, teamTdPointsFromProps,
  teamYardsFromProps, yardsToPoints, compareImpliedTotalToPostedTotal, TD_POINT_VALUE
} = await import('../server/services/props-total-consistency.js');

const q = (market, player, side, line, price) => ({ market, player, side, line, american_price: price });

test('pairPropQuotes groups Over/Under rows by market+player+line', () => {
  const pairs = pairPropQuotes([
    q('player_pass_yds', 'Caleb Williams', 'Over', 235.5, -112),
    q('player_pass_yds', 'Caleb Williams', 'Under', 235.5, -112),
    q('player_rush_yds', 'David Montgomery', 'Over', 55.5, -120),
    q('player_rush_yds', 'David Montgomery', 'Under', 55.5, +100)
  ]);
  assert.equal(pairs.length, 2);
  const cw = pairs.find(p => p.player === 'Caleb Williams');
  assert.equal(cw.overPrice, -112);
  assert.equal(cw.underPrice, -112);
});

test('pairPropQuotes treats a one-sided "Yes" (anytime-TD style) as the over side, under left null', () => {
  const pairs = pairPropQuotes([q('player_anytime_td', 'Bijan Robinson', 'Yes', null, -150)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].overPrice, -150);
  assert.equal(pairs[0].underPrice, null);
});

test('devigPropPairs de-vigs a two-sided pair and flags a one-sided pair as unavailable, not zero', () => {
  const [twoSided, oneSided] = devigPropPairs([
    { market: 'player_pass_yds', player: 'A', line: 235.5, overPrice: -112, underPrice: -112 },
    { market: 'player_anytime_td', player: 'B', line: null, overPrice: -150, underPrice: null }
  ]);
  assert.ok(Math.abs(twoSided.fair_prob_over - 0.5) < 1e-9);
  assert.equal(twoSided.devig_method, 'shin');
  assert.equal(oneSided.fair_prob_over, null);
  assert.equal(oneSided.devig_method, 'unavailable');
  assert.match(oneSided.reason, /one-sided/);
});

test('impliedMean falls back to the raw line with no sigma or no fair probability', () => {
  assert.equal(impliedMean({ line: 235.5, fairProbOver: null, sigma: 60 }), 235.5);
  assert.equal(impliedMean({ line: 235.5, fairProbOver: 0.55, sigma: null }), 235.5);
});

test('impliedMean shifts the mean above the line when the market favors the Over, below when it favors the Under', () => {
  const over = impliedMean({ line: 235.5, fairProbOver: 0.6, sigma: 60 });
  const under = impliedMean({ line: 235.5, fairProbOver: 0.4, sigma: 60 });
  assert.ok(over > 235.5, `expected the mean to shift above the line, got ${over}`);
  assert.ok(under < 235.5, `expected the mean to shift below the line, got ${under}`);
  // Symmetric probabilities around 0.5 should shift the mean symmetrically.
  assert.ok(Math.abs((over - 235.5) - (235.5 - under)) < 1e-9);
});

test('impliedMean at exactly fair 0.5 returns the line unchanged', () => {
  assert.ok(Math.abs(impliedMean({ line: 235.5, fairProbOver: 0.5, sigma: 60 }) - 235.5) < 1e-9);
});

test('teamTdPointsFromProps reports unavailable (not zero) when no anytime-TD prop was captured — the real 2026-09 case', () => {
  const devigged = devigPropPairs(pairPropQuotes([
    q('player_pass_yds', 'Caleb Williams', 'Over', 235.5, -112),
    q('player_pass_yds', 'Caleb Williams', 'Under', 235.5, -112)
  ]));
  const result = teamTdPointsFromProps(devigged);
  assert.equal(result.available, false);
  assert.equal(result.points, null);
});

test('teamTdPointsFromProps sums fair TD probability times the fixed points-per-TD constant', () => {
  const devigged = devigPropPairs(pairPropQuotes([
    q('player_anytime_td', 'Bijan Robinson', 'Yes', null, -150), // fair prob = americanToProb(-150) since one-sided -> falls back...
  ]));
  // A one-sided anytime-TD quote can't be de-vigged (no second price), so
  // fair_prob_over is null and it must not silently count as zero TD points.
  const result = teamTdPointsFromProps(devigged);
  assert.equal(result.available, false);

  // With both sides captured (e.g. a book that prices anytime-TD two-sided),
  // the points math should be the fair probability times TD_POINT_VALUE.
  const twoSided = devigPropPairs(pairPropQuotes([
    q('player_anytime_td', 'Bijan Robinson', 'Over', null, -150),
    q('player_anytime_td', 'Bijan Robinson', 'Under', null, +130)
  ]));
  const withPrice = teamTdPointsFromProps(twoSided);
  assert.equal(withPrice.available, true);
  assert.ok(Math.abs(withPrice.points - withPrice.players * 0) >= 0); // sanity: no NaN
  const p = twoSided[0].fair_prob_over;
  assert.ok(Math.abs(withPrice.points - p * TD_POINT_VALUE) < 1e-3, `expected ~${p * TD_POINT_VALUE}, got ${withPrice.points}`);
});

test('teamYardsFromProps picks the highest-line pass_yds candidate as the starter and sums all rushers, excluding receiving yards from the total', () => {
  const devigged = devigPropPairs(pairPropQuotes([
    q('player_pass_yds', 'Starter QB', 'Over', 245.5, -112), q('player_pass_yds', 'Starter QB', 'Under', 245.5, -112),
    q('player_pass_yds', 'Backup QB', 'Over', 55.5, -112), q('player_pass_yds', 'Backup QB', 'Under', 55.5, -112),
    q('player_rush_yds', 'RB1', 'Over', 65.5, -112), q('player_rush_yds', 'RB1', 'Under', 65.5, -112),
    q('player_rush_yds', 'RB2', 'Over', 20.5, -112), q('player_rush_yds', 'RB2', 'Under', 20.5, -112),
    q('player_reception_yds', 'WR1', 'Over', 70.5, -112), q('player_reception_yds', 'WR1', 'Under', 70.5, -112)
  ]));
  const result = teamYardsFromProps(devigged, { sigmas: {} }); // no sigma -> falls back to raw lines
  assert.equal(result.pass_yds.player, 'Starter QB');
  assert.equal(result.pass_yds.mean, 245.5);
  assert.equal(result.rush_yds.total, 86); // 65.5 + 20.5
  assert.equal(result.total_yards, 245.5 + 86); // pass + rush only, receiving excluded
  assert.ok(result.receiving_check, 'expected a receiving-vs-passing cross-check when both markets exist');
  assert.equal(result.receiving_check.receivers_total, 70.5);
});

test('teamYardsFromProps returns null total_yards when the team has no pass or rush props at all', () => {
  const result = teamYardsFromProps([]);
  assert.equal(result.total_yards, null);
  assert.equal(result.pass_yds.player, null);
});

test('yardsToPoints applies the caller-supplied calibration and returns null without one', () => {
  assert.equal(yardsToPoints(350, null).points, null);
  const { points, r2 } = yardsToPoints(350, { intercept: 2, slope: 0.06, r2: 0.31 });
  assert.ok(Math.abs(points - (2 + 0.06 * 350)) < 1e-9);
  assert.equal(r2, 0.31);
});

test('compareImpliedTotalToPostedTotal flags which side the props implied and whether that side actually won', () => {
  const result = compareImpliedTotalToPostedTotal({ homePoints: 24, awayPoints: 20, postedTotal: 41, actualTotal: 47 });
  assert.equal(result.implied_total, 44);
  assert.equal(result.disagreement, 3);
  assert.equal(result.props_implied_side, 'Over');
  assert.equal(result.actual_side, 'Over');
  assert.equal(result.props_called_side_correctly, true);
});

test('compareImpliedTotalToPostedTotal returns nulls rather than guessing when a team has no implied points', () => {
  const result = compareImpliedTotalToPostedTotal({ homePoints: null, awayPoints: 20, postedTotal: 41 });
  assert.equal(result.implied_total, null);
  assert.equal(result.disagreement, null);
  assert.equal(result.props_called_side_correctly, null);
});
