import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// rankBooks() (nfl-execution.js) prices a line move against the real NFL
// margin distribution (nfl-execution-edge.js#marginDistribution), which reads
// `game_lines` — so priceImprovement() needs an isolated database with a
// little real-shaped score history, never the live data.sqlite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-attribution-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

// game_lines' real schema (server/db/schema/core-and-fantasy.js; team_score/
// opp_score are added there via a guarded ALTER, same file) always exists now
// that schema creation is centralized (server/migrations/000_legacy_schema.js)
// and requires season/week/team NOT NULL (its primary key) — supply real
// values for those rather than only the columns this test actually reads.
const { db, run } = await import('../server/db/index.js');
const scores = [[24, 21], [27, 24], [20, 17], [31, 28], [17, 14], [24, 20], [27, 20]];
scores.forEach(([teamScore, oppScore], i) => {
  run('INSERT INTO game_lines (season, week, team, team_score, opp_score, home) VALUES (2025,?,?,?,?,1)',
    i + 1, `TEST${i + 1}`, teamScore, oppScore);
});

const {
  fairPriceProbability, fairPriceEv, challengeExtremePrice, priceImprovement,
  threeWayAttribution, attributePnl, EXTREME_EV_THRESHOLD
} = await import('../server/services/nfl-execution-attribution.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('fairPriceProbability uses Shin no-vig when the opposite price is known', () => {
  const { probability, method } = fairPriceProbability(-110, -110);
  assert.equal(method, 'shin_no_vig');
  assert.ok(Math.abs(probability - 0.5) < 1e-6);
});

test('fairPriceProbability falls back to raw implied probability, clearly labeled, with no opposite price', () => {
  const { probability, method } = fairPriceProbability(-110, null);
  assert.equal(method, 'implied_only_no_opposite_quote_available');
  assert.ok(probability > 0.5); // vig included, so it overstates the true probability
});

test('fairPriceEv is negative at a fair coin-flip price with vig baked in, using the fair (no-vig) probability', () => {
  // -110 both sides: fair probability is exactly 0.5, but -110 pays less than even money.
  const ev = fairPriceEv(-110, 0.5, 1);
  assert.ok(ev < 0);
});

test('challengeExtremePrice flags anything far beyond this project\'s one measured edge, and only that', () => {
  const ordinary = challengeExtremePrice({ price: -108, fairProbability: 0.51 });
  assert.equal(ordinary.suspect, false);

  const extreme = challengeExtremePrice({ price: 500, fairProbability: 0.5 });
  assert.equal(extreme.suspect, true);
  assert.ok(extreme.fair_price_ev_per_unit > EXTREME_EV_THRESHOLD);
  assert.match(extreme.reason, /probable bad join or stale feed/);
});

test('priceImprovement reports the ACCEPTED book\'s edge, not just whichever book ranked best', () => {
  const quotes = [
    { book: 'draftkings', side: 'home', line: -3.5, american_price: -110 },
    { book: 'fanduel', side: 'home', line: -3.5, american_price: -105 },
    { book: 'caesars', side: 'home', line: -3, american_price: -120 }
  ];
  const mine = priceImprovement(quotes, { market: 'spreads', takingPoints: true, book: 'draftkings' });
  assert.equal(mine.book, 'draftkings');
  assert.equal(mine.books_compared, 3);
  assert.ok(Number.isFinite(mine.edge_vs_median_winrate_pts));
});

test('threeWayAttribution reports price improvement, fair-price EV and realized result as three separate figures', () => {
  const opportunity = {
    id: 'test-opp',
    events: [
      { state: 'accepted', book: 'draftkings', line: -3.5, price: -110, stake_units: 1 },
      { state: 'settled', result: 'won', realized_pnl_units: 0.9091 }
    ]
  };
  const quotesAtAccepted = [
    { book: 'draftkings', side: 'home', line: -3.5, american_price: -110 },
    { book: 'fanduel', side: 'home', line: -3.5, american_price: -105 }
  ];
  const report = threeWayAttribution({ opportunity, quotesAtAccepted, fairProbability: 0.5 });
  assert.ok(report.price_improvement);
  assert.ok(report.fair_price_ev);
  assert.equal(report.realized_result.result, 'won');
  // The three figures must not collapse into each other.
  assert.notEqual(report.price_improvement.edge_vs_median_winrate_pts, report.fair_price_ev.expected_value_units);
  assert.notEqual(report.fair_price_ev.expected_value_units, report.realized_result.realized_pnl_units);
});

test('threeWayAttribution refuses to attribute an opportunity that was never accepted', () => {
  const report = threeWayAttribution({ opportunity: { id: 'x', events: [{ state: 'decision' }] } });
  assert.ok(report.error);
});

test('attributePnl: the four-way decomposition reconciles EXACTLY to the realized result, on a win', () => {
  const result = attributePnl({
    modelProbability: null, fairProbability: 0.5, decisionPrice: -110, medianPrice: -115,
    acceptedPrice: -105, stakeUnits: 2, result: 'won'
  });
  assert.equal(result.identity_holds, true);
  const sum = result.per_unit.baseline_fair_ev_at_median + result.per_unit.price_selection
    + result.per_unit.timing + result.per_unit.prediction_quality + result.per_unit.luck;
  assert.ok(Math.abs(sum - result.per_unit.realized) < 1e-3);
});

test('attributePnl: reconciles exactly on a loss too, and prediction_quality is zero with no model probability', () => {
  const result = attributePnl({
    fairProbability: 0.45, decisionPrice: -120, medianPrice: -120, acceptedPrice: -130,
    stakeUnits: 1, result: 'lost'
  });
  assert.equal(result.identity_holds, true);
  assert.equal(result.per_unit.prediction_quality, 0);
  assert.equal(result.per_unit.realized, -1);
});

test('attributePnl: reconciles exactly on a push (realized zero)', () => {
  const result = attributePnl({
    fairProbability: 0.5, decisionPrice: -110, medianPrice: -110, acceptedPrice: -110,
    stakeUnits: 3, result: 'push'
  });
  assert.equal(result.identity_holds, true);
  assert.equal(result.per_unit.realized, 0);
});

test('attributePnl: a model probability different from the fair price shows up ONLY in prediction_quality', () => {
  const noModel = attributePnl({ fairProbability: 0.5, decisionPrice: -110, medianPrice: -110,
    acceptedPrice: -110, stakeUnits: 1, result: 'won' });
  const withModel = attributePnl({ modelProbability: 0.58, fairProbability: 0.5, decisionPrice: -110,
    medianPrice: -110, acceptedPrice: -110, stakeUnits: 1, result: 'won' });
  assert.equal(noModel.per_unit.baseline_fair_ev_at_median, withModel.per_unit.baseline_fair_ev_at_median);
  assert.equal(noModel.per_unit.price_selection, withModel.per_unit.price_selection);
  assert.equal(noModel.per_unit.timing, withModel.per_unit.timing);
  assert.notEqual(noModel.per_unit.prediction_quality, withModel.per_unit.prediction_quality);
  assert.ok(withModel.per_unit.prediction_quality > 0, 'believing the true rate is higher than fair should show positive prediction_quality');
});

test('attributePnl throws on an invalid result label rather than silently defaulting', () => {
  assert.throws(() => attributePnl({ fairProbability: 0.5, decisionPrice: -110, acceptedPrice: -110,
    stakeUnits: 1, result: 'unknown' }), /result must be/);
});
