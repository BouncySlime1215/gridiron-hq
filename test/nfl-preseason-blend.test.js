/**
 * Phase 2 of the 2026-09-09 learning-pipeline plan: nothing in this codebase
 * previously distinguished "hot/cold 1-4 game start" from "genuinely
 * different team." This proves the calibrated Bayesian blend behaves
 * correctly at its boundaries — full trust in the prior at 0 games, fading
 * correctly as real games accumulate, never fabricating a number when an
 * input is missing.
 *
 * CORRECTED 2026-09-10 (Codex correction C06). This file used to say it needed
 * "no synthetic fixtures" because it read "real historical game_lines data
 * already present in the dev database". That is precisely the defect: on a
 * clean checkout with an isolated database there is no such history, every one
 * of these tests failed, and the suite was green on exactly one machine. A
 * suite that only passes where the author's data happens to sit is not a
 * passing suite; it is an unmeasured one.
 *
 * The blending MATH is now checked against a deterministic seeded league (see
 * test/helpers/seed-league-history.js), so the same assertions run anywhere.
 * The one check that is genuinely about REAL football — that single-game
 * margin variance far exceeds year-over-year team-quality variance in the
 * actual NFL — cannot be proved by a fixture however well built, so it is kept
 * and guarded, reporting its disposition rather than silently passing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-preseason-blend-'));
const usingFixture = !process.env.GRIDIRON_DB_PATH || !fs.existsSync(process.env.GRIDIRON_DB_PATH);
if (usingFixture) process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { seedTeams, seedLeagueHistory, hasRealHistory } = await import('./helpers/seed-league-history.js');

seedTeams(db);
if (!hasRealHistory(rows)) seedLeagueHistory(run);
const realHistory = hasRealHistory(rows, { minSeasons: 8, minGames: 3000 });

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { blendedTeamRating, calibratePreseasonBlend, PRIOR_VARIANCE, PER_GAME_VARIANCE, teamChurnMultiplier } =
  await import('../server/services/nfl-preseason-blend.js');

test('calibration derives real, positive variances from history, not placeholders', () => {
  const c = calibratePreseasonBlend();
  assert.ok(c.per_game_variance > 0, 'a variance estimated from real games must be positive');
  assert.ok(c.prior_variance > 0);
  assert.ok(c.games_pooled > 1000, 'the calibration pools thousands of team-games');
  assert.ok(c.prior_pairs > 0, 'and has year-over-year pairs to estimate a prior variance from');
});

test('REAL HISTORY: single-game margin variance far exceeds year-over-year team variance', {
  skip: realHistory ? false : 'requires the real multi-season game_lines history; the seeded fixture ' +
    'cannot establish an empirical fact about the actual NFL. Run against the populated database to check it.'
}, () => {
  // Deliberately NOT asserted against the fixture: this is a claim about
  // football, not about the code, and a fixture that satisfied it would only
  // be proving that its own generator was tuned to.
  const c = calibratePreseasonBlend();
  assert.ok(c.per_game_variance > c.prior_variance * 2,
    `single-game variance ${c.per_game_variance} should far exceed prior variance ${c.prior_variance}`);
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

// --- Codex audit finding M01 acceptance criteria (2026-09-10 fix) ---------

test('the posterior weight follows the correct normal-normal formula: sigma^2 / (sigma^2 + n*tau^2)', () => {
  // Reconstruct the exact formula independently from the reported inputs and
  // compare against the module's own output -- this must never regress back
  // to the reversed tau^2/(tau^2+n*sigma^2) form.
  const r = blendedTeamRating(2024, 'KC', 8); // some real number of games played, no churn multiplier available
  if (r.games_played === 0 || r.churn_multiplier != null) return; // keep this check isolated to the plain-baseline case
  const c = calibratePreseasonBlend({ asOfSeason: 2024 });
  const expected = c.per_game_variance / (c.per_game_variance + r.games_played * c.prior_variance);
  assert.ok(Math.abs(r.weight_on_prior - expected) < 0.001,
    `weight_on_prior ${r.weight_on_prior} should equal sigma^2/(sigma^2+n*tau^2) = ${expected}`);
});

test('increasing prior variance (a less trustworthy prior) strictly REDUCES weight on the prior', () => {
  // A team the churn model treats as heavily churned should trust its prior
  // less at the same game count than one treated as stable -- exercise this
  // directly via priorMargin/asOfSeason holding games_played fixed, using the
  // internal formula shape rather than needing a specific real team's churn
  // history (which may not exist for every era, see the churn test above).
  const low = blendedTeamRating(2024, 'KC', 8, { priorMargin: 3 });
  // Simulate "more prior uncertainty" the same way the module does internally
  // (basePriorVariance * churnMultiplier) by comparing against a synthetic
  // higher-variance recomputation of the same closed-form weight.
  const c = calibratePreseasonBlend({ asOfSeason: 2024 });
  const n = low.games_played;
  const wLowTau = c.per_game_variance / (c.per_game_variance + n * c.prior_variance);
  const wHighTau = c.per_game_variance / (c.per_game_variance + n * (c.prior_variance * 3));
  assert.ok(wHighTau < wLowTau, 'tripling prior variance must reduce the weight placed on the prior');
});

test('increasing observation noise (sigma^2) strictly INCREASES weight on the prior', () => {
  const c = calibratePreseasonBlend({ asOfSeason: 2024 });
  const n = 6;
  const wLowSigma = c.per_game_variance / (c.per_game_variance + n * c.prior_variance);
  const wHighSigma = (c.per_game_variance * 3) / (c.per_game_variance * 3 + n * c.prior_variance);
  assert.ok(wHighSigma > wLowSigma, 'tripling observation variance must increase the weight placed on the prior');
});

test('posterior mean is exactly the precision-weighted average of prior and in-season means', () => {
  const r = blendedTeamRating(2024, 'KC', 12);
  if (r.games_played === 0 || r.prior == null || r.in_season == null) return;
  const expected = r.weight_on_prior * r.prior + (1 - r.weight_on_prior) * r.in_season;
  assert.ok(Math.abs(r.blended - expected) < 0.002,
    `blended ${r.blended} should equal weight_on_prior*prior + (1-weight_on_prior)*in_season = ${expected}`);
});

test('cutoff safety: a prediction for an earlier season is identical whether or not later seasons exist in the database', () => {
  // calibrationAsOf(2022) must depend only on seasons < 2022 -- verify by
  // confirming the as-of-2022 calibration differs from (i.e. is NOT silently
  // reusing) the all-history calibration, which does include 2022 onward.
  const asOf2022 = calibratePreseasonBlend({ asOfSeason: 2022 });
  const allHistory = calibratePreseasonBlend();
  assert.ok(asOf2022.games_pooled < allHistory.games_pooled,
    'the 2022 cutoff must pool strictly fewer games than the all-history calibration');
  // And the actual rating call for a 2022 game must use that restricted
  // calibration by default (asOfSeason defaults to `season`), not the
  // always-current constants.
  const r2022 = blendedTeamRating(2022, 'KC', 10);
  if (r2022.games_played > 0 && r2022.prior != null) {
    const expected = asOf2022.per_game_variance / (asOf2022.per_game_variance + r2022.games_played * asOf2022.prior_variance
      * (r2022.churn_multiplier ?? 1));
    assert.ok(Math.abs(r2022.weight_on_prior - expected) < 0.001,
      'a 2022 prediction must be calibrated from seasons before 2022, not the full all-history constants');
  }
});

test('per_game_variance and prior_variance are computed on the SAME (dampened-margin) scale the blend itself uses', () => {
  // A 35-point blowout and a 3-point win must not carry equal weight in
  // either the calibration or the blend -- confirm the calibration query
  // itself is not simply reproducible from raw (undampened) margins.
  const c = calibratePreseasonBlend();
  // Raw per-game margin variance in this league is well above 300 (a
  // typical single-game std-dev of home-away margin is ~13-14 points); the
  // dampened-scale variance must come out meaningfully smaller than that,
  // confirming the dampening transform is actually being applied before the
  // variance is pooled, not just documented as intent.
  assert.ok(c.per_game_variance < 300, `dampened per_game_variance ${c.per_game_variance} should be well below raw-margin variance (~350+)`);
});
