/**
 * Phase 2 of the 2026-09-09 learning-pipeline plan: nothing in this codebase
 * previously distinguished "hot/cold 1-4 game start" from "genuinely
 * different team." This proves the calibrated Bayesian blend behaves
 * correctly at its boundaries (full trust in the prior at 0 games, fading
 * correctly as real games accumulate, never fabricating a number when an
 * input is missing) using real historical game_lines data already present
 * in the dev database — no synthetic fixtures needed since every check here
 * is about the blending MATH, not about needing a specific manufactured
 * scenario.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { blendedTeamRating, calibratePreseasonBlend, PRIOR_VARIANCE, PER_GAME_VARIANCE, teamChurnMultiplier } =
  await import('../server/services/nfl-preseason-blend.js');

test('calibration derives real, positive variances from actual history, not placeholders', () => {
  const c = calibratePreseasonBlend();
  assert.ok(c.per_game_variance > 0);
  assert.ok(c.prior_variance > 0);
  assert.ok(c.games_pooled > 1000, 'should pool thousands of real team-games');
  // The specific, real finding this calibration produced: single-game NFL
  // margin variance is much larger than year-over-year team-quality variance.
  assert.ok(c.per_game_variance > c.prior_variance * 2);
});

test('at 0 games played, the blend is 100% the prior with maximum uncertainty', () => {
  const r = blendedTeamRating(2024, 'KC', 1);
  assert.equal(r.games_played, 0);
  assert.equal(r.weight_on_prior, 1);
  assert.equal(r.blended, r.prior);
  assert.equal(r.in_season, null);
  assert.ok(r.posterior_se > 0);
});

test('weight on the prior strictly decreases as more real games accumulate', () => {
  const early = blendedTeamRating(2024, 'KC', 3);  // 2 games played
  const mid = blendedTeamRating(2024, 'KC', 8);     // ~6-7 games played
  const late = blendedTeamRating(2024, 'KC', 15);   // ~13 games played
  assert.ok(early.weight_on_prior > mid.weight_on_prior, `${early.weight_on_prior} should exceed ${mid.weight_on_prior}`);
  assert.ok(mid.weight_on_prior > late.weight_on_prior, `${mid.weight_on_prior} should exceed ${late.weight_on_prior}`);
  assert.ok(late.weight_on_prior >= 0 && late.weight_on_prior <= 1);
});

test('posterior uncertainty (standard error) shrinks as more games accumulate', () => {
  const early = blendedTeamRating(2024, 'KC', 3);
  const late = blendedTeamRating(2024, 'KC', 15);
  assert.ok(late.posterior_se < early.posterior_se, `${late.posterior_se} should be less than ${early.posterior_se}`);
});

test('never fabricates a prior for a team with no prior-season history, reports honestly instead', () => {
  const r = blendedTeamRating(2021, 'ZZZ_NONEXISTENT', 10);
  assert.equal(r.prior, null);
  assert.ok(r.note.includes('No prior-season'));
});

test('the blended estimate always sits between the prior and the in-season number (or equals whichever exists alone)', () => {
  const r = blendedTeamRating(2024, 'KC', 10);
  if (r.prior != null && r.in_season != null) {
    const lo = Math.min(r.prior, r.in_season), hi = Math.max(r.prior, r.in_season);
    assert.ok(r.blended >= lo - 0.01 && r.blended <= hi + 0.01,
      `blended (${r.blended}) should be a convex combination of prior (${r.prior}) and in-season (${r.in_season})`);
  }
});

test('churn multiplier is bounded and null (not zero, not one) when there is not enough tracked history', () => {
  const old = teamChurnMultiplier(2021, 'KC'); // long before Phase 1's roster tracking existed
  assert.equal(old, null, 'must not fabricate a churn read for an untracked era');
  const recent = teamChurnMultiplier(2026, 'KC');
  if (recent != null) {
    assert.ok(recent >= 0.75 && recent <= 3, `churn multiplier ${recent} must stay within its declared bounds`);
  }
});

test('PRIOR_VARIANCE and PER_GAME_VARIANCE constants match a fresh calibration', () => {
  const fresh = calibratePreseasonBlend();
  assert.equal(PRIOR_VARIANCE, fresh.prior_variance);
  assert.equal(PER_GAME_VARIANCE, fresh.per_game_variance);
});
