/**
 * Codex plan section 8.6 — "Prove the existing information earns its
 * influence" — specifically the two requirements the existing ROI-only
 * ablation does not meet:
 *
 *   "Report three separate answers for each group: did it improve the
 *    game-margin forecast; did it improve cover/push probabilities around
 *    offered spread thresholds; and did it improve the economic policy after
 *    prices and costs?"
 *
 *   "Use identical candidate universes, quote cutoffs, folds, score
 *    definitions, and missing-data rules."
 *
 * These are pure-function tests of the scoring and decision layer. They use
 * hand-built decision rows rather than a real replay, so each rule is pinned
 * by a case whose right answer is known by construction — the five-season run
 * against real data is reported separately as evidence, not as a test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { contributionFamilies, familyConsumers, FAMILY_CONTRIBUTION_VERSION } =
  await import('../server/services/nfl-family-contribution.js');

test('the family list is read from the model catalog, never restated', () => {
  const families = contributionFamilies();
  const consumers = familyConsumers();
  assert.deepEqual(families, consumers.map(c => c.family),
    'a family added to the ensemble cannot be silently omitted from its own ablation');
  assert.ok(families.includes('Roster availability'),
    'the family a hardcoded list previously dropped is present');
  assert.ok(families.length >= 5);
});

test('every family reports how many models actually consume it', () => {
  for (const consumer of familyConsumers()) {
    assert.ok(consumer.model_count > 0, `${consumer.family} is in the catalog with no models`);
    assert.ok(['production_ensemble', 'challenger_only', 'none'].includes(consumer.numerical_consumer));
    assert.ok(Array.isArray(consumer.models) && consumer.models.length === consumer.model_count);
  }
});

test('a family whose models are all challenger-only reports NO NUMERICAL CONSUMER, not a zero effect', async () => {
  // Section 8.6: "Where a family is not actually consumed, report 'no
  // numerical consumer' instead of manufacturing a zero-effect scientific
  // result." A challenger-only family never reaches a production forecast, so
  // its ablation delta would be exactly zero — and reporting that zero as a
  // measured finding would be a fabricated result, not a real one.
  const module = await import('../server/services/nfl-family-contribution.js');
  const consumers = module.familyConsumers();
  const staged = consumers.filter(c => c.numerical_consumer === 'challenger_only');
  for (const family of staged) {
    assert.ok(family.challenger_only === family.model_count,
      'challenger_only is claimed only when EVERY model in the family is challenger-only');
  }
  // The real catalog may legitimately have none of these; the classification
  // itself is what must be correct.
  assert.ok(consumers.every(c => c.challenger_only <= c.model_count));
});

test('the version string is declared so a stored report is attributable to this scoring code', () => {
  assert.match(FAMILY_CONTRIBUTION_VERSION, /^nfl-family-contribution-v\d+$/);
});

const { scoreOver, decideFamily, perGameMetrics, pairedDelta, gameKey } =
  await import('../server/services/nfl-family-contribution.js');

/**
 * One candidate. `marketMargin` is the market's projected home margin, so the
 * home spread is its negation — the same convention `replaySeason` uses.
 */
const decision = ({ week = 1, home = 'ATL', away = 'CAR', modelMargin = 3, marketMargin = 3,
  actualMargin = 7, coverProb = 0.6, pushProb = 0.02, units = null, eligible = false } = {}) => ({
  season: 2026, week, home, away, market: 'spread',
  model_margin: modelMargin, market_margin: marketMargin, actual_margin: actualMargin,
  eligible, units,
  feature_snapshot: { predictive_distribution: { home_cover_probability: coverProb, push_probability: pushProb } }
});

const mapOf = decisions => new Map(decisions.map(d => [gameKey(d), d]));

test('a PUSH is excluded from the Brier score rather than graded as a failure to cover', () => {
  // Home margin +3, home spread -3 => the game lands exactly on the number.
  const push = decision({ marketMargin: 3, actualMargin: 3, coverProb: 0.9, pushProb: 0.08 });
  const score = scoreOver(mapOf([push]), [gameKey(push)]);
  assert.equal(score.cover_scored, 0, 'no decided cover outcome exists to score');
  assert.equal(score.cover_brier, null);
  assert.equal(score.actual_pushes, 1);
  assert.equal(score.predicted_pushes, 0.08,
    'the push is still counted where it belongs — against the push probability, not the cover probability');

  // Scored as a loss it would have cost (0.9 - 0)^2 = 0.81, the single worst
  // possible contribution, for an outcome the model separately called.
  const decided = decision({ week: 2, marketMargin: 3, actualMargin: 2, coverProb: 0.9 });
  const both = scoreOver(mapOf([push, decided]), [gameKey(push), gameKey(decided)]);
  assert.equal(both.cover_scored, 1);
  assert.equal(both.cover_brier, 0.81, 'only the decided game contributes, and it contributes its own error');
});

test('cover probability is reconciled to the home side, not assumed to match the backed side', () => {
  // Home is favoured by 3 and wins by 7: the home side covered. A 0.8 home
  // cover probability was mostly right, and must score as mostly right.
  const covered = decision({ marketMargin: 3, actualMargin: 7, coverProb: 0.8 });
  assert.equal(scoreOver(mapOf([covered]), [gameKey(covered)]).cover_brier, 0.04);

  // Same forecast, home fails to cover: the same 0.8 is now mostly wrong.
  const failed = decision({ marketMargin: 3, actualMargin: 1, coverProb: 0.8 });
  assert.equal(scoreOver(mapOf([failed]), [gameKey(failed)]).cover_brier, 0.64);
});

test('margin error is reported against the market error on the SAME games', () => {
  const rows = [
    decision({ week: 1, modelMargin: 0, marketMargin: 6, actualMargin: 4 }),  // model off 4, market off 2
    decision({ week: 2, modelMargin: 10, marketMargin: 6, actualMargin: 4 })  // model off 6, market off 2
  ];
  const score = scoreOver(mapOf(rows), rows.map(gameKey));
  assert.equal(score.margin_mae, 5);
  assert.equal(score.market_margin_mae, 2);
  assert.equal(score.margin_beats_market, false,
    'beating the previous configuration and beating the number you must beat are different claims');
});

test('a game missing from the common universe contributes to nothing', () => {
  const present = decision({ week: 1 });
  const absent = decision({ week: 2, home: 'BUF', away: 'NYJ' });
  // The key is requested but the configuration never forecast it.
  const score = scoreOver(mapOf([present]), [gameKey(present), gameKey(absent)]);
  assert.equal(score.cover_scored, 1, 'only the game this configuration actually forecast is scored');
  assert.equal(score.games, 2, 'the requested universe size is still reported honestly');
});

test('only SELECTED bets reach the economic answer; unselected candidates stay in the universe', () => {
  const rows = [
    decision({ week: 1, eligible: true, units: 0.91 }),
    decision({ week: 2, eligible: false, units: null }),
    decision({ week: 3, eligible: true, units: -1 })
  ];
  const score = scoreOver(mapOf(rows), rows.map(gameKey));
  assert.equal(score.bets, 2);
  assert.equal(score.units, -0.09);
  assert.equal(score.roi, -0.045);
  assert.equal(score.cover_scored, 3, 'the forecast answers cover every candidate, not just the bets');
});

test('the paired bootstrap resamples the same weeks under both configurations', () => {
  const base = [
    { week: '2026-1', abs_error: 10, brier: 0.3, units: -1 },
    { week: '2026-2', abs_error: 10, brier: 0.3, units: -1 }
  ];
  // The variant is better by exactly 2 points of error on every single game.
  const variant = base.map(g => ({ ...g, abs_error: g.abs_error - 2 }));
  const delta = pairedDelta(base, variant);
  assert.deepEqual(delta.margin_mae.delta_95, [-2, -2],
    'a constant per-game improvement has no sampling variance once the comparison is paired');
  assert.equal(delta.margin_mae.probability_variant_better, 1);
  assert.deepEqual(delta.cover_brier.delta_95, [0, 0], 'an unchanged metric shows exactly no change');
});

test('the bootstrap is deterministic: the same inputs give byte-identical intervals', () => {
  const games = [
    { week: '2026-1', abs_error: 3, brier: 0.2, units: 0.91 },
    { week: '2026-2', abs_error: 14, brier: 0.4, units: -1 },
    { week: '2026-3', abs_error: 8, brier: 0.1, units: 0.91 }
  ];
  const variant = games.map(g => ({ ...g, abs_error: g.abs_error * 0.9 }));
  assert.deepEqual(pairedDelta(games, variant), pairedDelta(games, variant));
});

const inconclusive = { delta_95: [-0.5, 0.5], probability_variant_better: 0.5 };
const conclusiveBetter = { delta_95: [-0.9, -0.1], probability_variant_better: 0.99 };
const conclusiveWorse = { delta_95: [0.1, 0.9], probability_variant_better: 0.01 };
const consumer = { family: 'Efficiency', model_count: 17, challenger_only: 0, numerical_consumer: 'production_ensemble' };

test('inconclusive evidence KEEPS a family — absence of proof is not proof of absence', () => {
  const decided = decideFamily({ family: 'Efficiency', consumer,
    score: { margin_mae: 10.2 }, baselineScore: { margin_mae: 10.3 },
    uncertaintyOfDelta: { margin_mae: inconclusive, cover_brier: inconclusive, roi: inconclusive } });
  assert.equal(decided.verdict, 'keep');
  assert.match(decided.because, /Inconclusive is not evidence of no contribution/);
});

test('SIMPLIFY requires a conclusive FORECAST interval, not just a favourable point estimate', () => {
  const decided = decideFamily({ family: 'Efficiency', consumer,
    // The variant looks better on margin, but no interval excludes zero.
    score: { margin_mae: 9.0 }, baselineScore: { margin_mae: 10.3 },
    uncertaintyOfDelta: { margin_mae: inconclusive, cover_brier: inconclusive, roi: inconclusive } });
  assert.equal(decided.verdict, 'keep', 'a better number with an interval spanning zero is not a finding');
});

test('a conclusive ROI move alone never justifies simplifying', () => {
  const decided = decideFamily({ family: 'Efficiency', consumer,
    score: { margin_mae: 9.0 }, baselineScore: { margin_mae: 10.3 },
    uncertaintyOfDelta: { margin_mae: inconclusive, cover_brier: inconclusive, roi: conclusiveWorse } });
  assert.equal(decided.verdict, 'keep',
    'ROI is the noisiest of the three answers and selection still differs game to game');
});

test('a conclusive forecast improvement in the right direction DOES justify simplifying', () => {
  const decided = decideFamily({ family: 'Efficiency', consumer,
    score: { margin_mae: 9.0 }, baselineScore: { margin_mae: 10.3 },
    uncertaintyOfDelta: { margin_mae: conclusiveBetter, cover_brier: inconclusive, roi: inconclusive } });
  assert.equal(decided.verdict, 'simplify');
  assert.match(decided.because, /confirmed on later observations before anything changes/);
});

test('a conclusive move in the WRONG direction keeps the family', () => {
  const decided = decideFamily({ family: 'Efficiency', consumer,
    score: { margin_mae: 11.5 }, baselineScore: { margin_mae: 10.3 },
    uncertaintyOfDelta: { margin_mae: conclusiveWorse, cover_brier: inconclusive, roi: inconclusive } });
  assert.equal(decided.verdict, 'keep');
});

test('a family with no numerical consumer gets test-connection, never a manufactured zero effect', () => {
  const none = decideFamily({ family: 'Typed news', consumer: { family: 'Typed news', model_count: 0, challenger_only: 0, numerical_consumer: 'none' },
    score: {}, baselineScore: {}, uncertaintyOfDelta: { margin_mae: inconclusive, cover_brier: inconclusive, roi: inconclusive } });
  assert.equal(none.verdict, 'test-connection');
  assert.match(none.because, /no numerical consumer/);

  const staged = decideFamily({ family: 'Staged', consumer: { family: 'Staged', model_count: 3, challenger_only: 3, numerical_consumer: 'challenger_only' },
    score: {}, baselineScore: {}, uncertaintyOfDelta: { margin_mae: conclusiveBetter, cover_brier: conclusiveBetter, roi: inconclusive } });
  assert.equal(staged.verdict, 'test-connection',
    'a challenger-only family never reaches production, so no ablation of it can mean anything');
});
