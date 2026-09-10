import test from 'node:test';
import assert from 'node:assert/strict';
import { NFL_HISTORICAL_REPLAY_POLICY, NFL_PRODUCTION_POLICY, applyNflPolicy, normalizeNflPolicy,
  expectedNetReturn } from '../server/services/nfl-policy.js';

test('historical replay and live publication have explicit different calibration contracts', () => {
  assert.equal(NFL_PRODUCTION_POLICY.requireCalibratedAdvantage, true);
  assert.equal(NFL_HISTORICAL_REPLAY_POLICY.requireCalibratedAdvantage, false);
  assert.equal(NFL_HISTORICAL_REPLAY_POLICY.authority, 'diagnostic_only');
  assert.notEqual(NFL_HISTORICAL_REPLAY_POLICY.id, NFL_PRODUCTION_POLICY.id);
});

/* ---- Codex audit finding E2: executable expected return, not just fair-price edge ---- */

const evAt = expectedNetReturn;
const replayPolicy = NFL_HISTORICAL_REPLAY_POLICY;

const evCandidate = (over = {}) => ({
  market: 'spread', line: -3.5, american_price: -110, edge_points: 5,
  disagreement: 1, calibration_eligible: true, model_probability: 0.60, ...over
});

test('E2 acceptance: the audit\'s own example — 51% at -110 — is rejected, not published', () => {
  // 0.51 against a fair 0.50 IS a forecasting improvement, and at -110 it
  // still loses ~2.6 cents per dollar. The old policy passed it.
  const raw = evAt({ winProbability: 0.51, americanPrice: -110 });
  assert.ok(raw < 0, `51% at -110 must be negative EV, got ${raw}`);
  const result = applyNflPolicy([evCandidate({ model_probability: 0.51 })], NFL_PRODUCTION_POLICY);
  assert.equal(result.decisions[0].eligible, false);
  assert.equal(result.decisions[0].abstention_reason, 'negative_expected_return');
  assert.ok(result.decisions[0].expected_return < 0);
});

test('E2 acceptance: a genuinely profitable price clears the gate', () => {
  // 0.60 at -110 pays 0.909 per unit: 0.59*0.909 - 0.41 = +0.126 after the haircut.
  const result = applyNflPolicy([evCandidate({ model_probability: 0.60 })], NFL_PRODUCTION_POLICY);
  assert.equal(result.decisions[0].eligible, true, JSON.stringify(result.decisions[0]));
  assert.ok(result.decisions[0].expected_return > 0.01);
});

test('E2 acceptance: the same forecast at a worse price becomes ineligible — price is part of the decision', () => {
  const good = applyNflPolicy([evCandidate({ model_probability: 0.55, american_price: +120 })], NFL_PRODUCTION_POLICY);
  const bad = applyNflPolicy([evCandidate({ model_probability: 0.55, american_price: -200 })], NFL_PRODUCTION_POLICY);
  assert.equal(good.decisions[0].eligible, true, 'a 55% shot at +120 is clearly worth taking');
  assert.equal(bad.decisions[0].eligible, false, 'the identical forecast at -200 is not');
  assert.equal(bad.decisions[0].abstention_reason, 'negative_expected_return');
});

test('E2 acceptance: an unpriceable candidate abstains rather than being treated as zero-EV', () => {
  const result = applyNflPolicy([evCandidate({ model_probability: null })], NFL_PRODUCTION_POLICY);
  assert.equal(result.decisions[0].eligible, false);
  assert.equal(result.decisions[0].abstention_reason, 'expected_return_unknown');
  assert.equal(result.decisions[0].expected_return, null);
});

test('E2: push mass shrinks expected return without flipping its sign, and a half-point line has none', () => {
  const decided = evAt({ winProbability: 0.60, americanPrice: -110, pushProbability: 0 });
  const withPush = evAt({ winProbability: 0.60, americanPrice: -110, pushProbability: 0.08 });
  assert.ok(withPush < decided && withPush > 0, 'a bet that sometimes pushes risks less and wins less');
  assert.ok(Math.abs(withPush - decided * 0.92) < 1e-9);
  // A losing bet does not become a winner by pushing more often.
  assert.ok(evAt({ winProbability: 0.51, americanPrice: -110, pushProbability: 0.3 }) < 0);
});

test('E2: expectedNetReturn refuses inputs it cannot price rather than returning zero', () => {
  assert.equal(evAt({ winProbability: null, americanPrice: -110 }), null);
  assert.equal(evAt({ winProbability: 0.6, americanPrice: null }), null);
  assert.equal(evAt({ winProbability: 0.6, americanPrice: 0 }), null, 'a zero price is not a price');
  assert.equal(evAt({ winProbability: 1.4, americanPrice: -110 }), null);
});

test('E2 INVARIANT: the historical replay policy has NO executable-return gate, so the blind audit is unchanged', () => {
  // This is the load-bearing safety property of the whole change. The replay
  // policy spreads production, so an inherited minExpectedReturn would have
  // silently changed what every historical replay bets -- and made run 32's
  // numbers incomparable to runs 27 and 31.
  assert.equal(replayPolicy.minExpectedReturn, null);
  const normalized = normalizeNflPolicy(replayPolicy);
  assert.equal(normalized.minExpectedReturn, null, 'normalizeNflPolicy must not resurrect the production floor');

  // A candidate with no probability at all -- exactly what a historical
  // replay produces -- stays eligible under the replay policy.
  const result = applyNflPolicy([evCandidate({ model_probability: null })], replayPolicy);
  assert.equal(result.decisions[0].eligible, true);
  assert.equal(result.decisions[0].abstention_reason, null);
  // The economic figure is still REPORTED where computable, just not gated on.
  const priced = applyNflPolicy([evCandidate({ model_probability: 0.51 })], replayPolicy);
  assert.equal(priced.decisions[0].eligible, true);
  assert.ok(priced.decisions[0].expected_return < 0, 'a diagnostic replay still shows the bet was negative-EV');
});
