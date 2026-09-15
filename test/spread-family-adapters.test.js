/**
 * Tests for `server/betting/nfl/forecast/spread-family-adapters.js`.
 *
 * Three kinds of claim, three kinds of proof.
 *
 *  1. SHAPE: every adapter returns the exact common contract's top-level keys
 *     (`FAMILY_FORECAST_FIELDS`), never more, never fewer, regardless of
 *     whether the family observed anything for this game.
 *
 *  2. HONEST ABSTENTION: a family with genuinely no data for a game returns
 *     `observed: false` with a real, specific `missing_reason` -- never a
 *     thrown exception, and never a fabricated number standing in for "no
 *     data". This is exercised on the lineup family (no injuries/depth-chart
 *     tables are seeded by the ensemble fixture below) and on the direct-cover
 *     stub (no artifact bridge exists at all).
 *
 *  3. PARITY, the load-bearing claim: the ensemble adapter's output is an
 *     EXACT reshaping of what `nfl-ensemble.js`'s own `ensembleLine` already
 *     reports for the identical game, called the identical way. If this ever
 *     fails, the adapter has drifted from the family it claims to describe,
 *     the same failure mode `test/forecast-combination.test.js`'s own
 *     load-bearing incumbent-parity test exists to catch.
 *
 * The fixture is `test/helpers/seed-ensemble-fixture.js`'s synthetic league --
 * the same one the forecast-combination suite uses -- seeded with only
 * `game_lines` and `nfl_team_week_features`. It carries no injuries, no depth
 * chart and no play-by-play, so the lineup and simulation families' behavior
 * on it is read honestly from what IS and ISN'T seeded, not asserted by
 * assumption.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-spread-family-adapters-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run, rows, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'a spread-family-adapters test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { seedEnsembleFixture } = await import('./helpers/seed-ensemble-fixture.js');
seedEnsembleFixture({ run, rows }, { latentFactors: 3, noise: 0.35 });

const ensembleModule = await import('../server/services/nfl-ensemble.js');
const adapters = await import('../server/betting/nfl/forecast/spread-family-adapters.js');
const {
  FAMILIES, FAMILY_FORECAST_FIELDS,
  ensembleFamilyForecast, simulationFamilyForecast, lineupFamilyForecast,
  directCoverFamilyForecast, allFamilyForecasts, probabilitiesFromTriple
} = adapters;

/* -------------------------------------------------------- probabilitiesFromTriple */

test('probabilitiesFromTriple renormalizes a sub-0.01 rounding drift and says so', () => {
  // 0.638 + 0.022 + 0.339 = 0.999, exactly the drift a triple of independently
  // 2-decimal-rounded fractions produces -- see nfl-ensemble.js's r2() on
  // home_cover_probability/push_probability/away_cover_probability.
  const result = probabilitiesFromTriple({ win: 0.638, push: 0.022, loss: 0.339, handicap: 11, method: 'test' });
  assert.equal(result.available, true);
  assert.equal(result.rounding_adjusted, true);
  const total = result.win + result.push + result.loss;
  assert.ok(Math.abs(total - 1) < 1e-6, `renormalized triple summed to ${total}`);
  assert.ok(Math.abs(result.win - 0.638) < 0.01);
});

test('probabilitiesFromTriple refuses a triple that is genuinely invalid, not just rounded', () => {
  // Sums to 1, but a component is outside [0,1] -- a real defect, not a
  // rounding artifact, and must not be silently renormalized into looking fine.
  const result = probabilitiesFromTriple({ win: 1.4, push: 0, loss: -0.4, handicap: 3, method: 'test' });
  assert.equal(result.available, false);
  assert.match(result.reason, /failed validation/);
});

test('probabilitiesFromTriple refuses a half-point handicap with nonzero push', () => {
  const result = probabilitiesFromTriple({ win: 0.5, push: 0.1, loss: 0.4, handicap: 3.5, method: 'test' });
  assert.equal(result.available, false);
  assert.match(result.reason, /half_point_handicap_cannot_push/);
});

test('probabilitiesFromTriple is unavailable, not thrown, on missing inputs', () => {
  const result = probabilitiesFromTriple({ win: 0.5, push: null, loss: 0.5, handicap: 3 });
  assert.equal(result.available, false);
  assert.equal(typeof result.reason, 'string');
});

// A cutoff at or after the 2022 calibration boundary, same reasoning as
// forecast-combination.test.js's own CUTOFF: enough prior history exists for
// both the ensemble's blend weights and its conformal calibration.
const SEASON = 2023, WEEK = 3;
const game = rows(`SELECT team AS home, opponent AS away FROM game_lines
  WHERE season=? AND week=? AND home=1 ORDER BY team LIMIT 1`, SEASON, WEEK)[0];
assert.ok(game, 'fixture did not produce a season 2023 week 3 game to test against');
const { home, away } = game;

/* ------------------------------------------------------------------ shape */

test('every adapter returns exactly the common contract shape', () => {
  const results = allFamilyForecasts({ season: SEASON, week: WEEK, home, away, cutoff: '2023-09-24T17:00:00Z' });
  assert.equal(results.length, 4);
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), [...FAMILY_FORECAST_FIELDS].sort(),
      `${result.family}: shape drifted from FAMILY_FORECAST_FIELDS`);
    assert.equal(typeof result.observed, 'boolean');
    assert.equal(typeof result.qualified, 'boolean');
    assert.ok('predicted' in result.margin && 'market' in result.margin);
    assert.ok('available' in result.probabilities);
    assert.ok('available' in result.distribution);
    assert.ok('available' in result.uncertainty);
    assert.deepEqual(result.game, { season: SEASON, week: WEEK, home, away, cutoff: '2023-09-24T17:00:00Z' });
    // observed:false must always carry a real reason, not a null shrug.
    if (!result.observed) assert.equal(typeof result.missing_reason, 'string', `${result.family}: missing_reason`);
  }
  assert.deepEqual(results.map(r => r.family), [FAMILIES.ensemble, FAMILIES.simulation, FAMILIES.lineup, FAMILIES.direct_cover]);
});

test('cutoff defaults to null and is carried through untouched, not fabricated', () => {
  const result = ensembleFamilyForecast({ season: SEASON, week: WEEK, home, away });
  assert.equal(result.game.cutoff, null);
});

/* ------------------------------------------------------------- honest abstention */

test('the lineup family abstains honestly: no injuries/depth-chart tables are seeded', () => {
  // The ensemble fixture never writes nfl_injuries, nfl_depth or
  // nfl_pregame_snapshot_history, so teamRosterStrength has no cutoff-safe
  // depth chart for either side and gamePlayerAvailability has no reports.
  // The adapter must abstain, not throw and not invent a margin.
  const result = lineupFamilyForecast({ season: SEASON, week: WEEK, home, away });
  assert.equal(result.family, FAMILIES.lineup);
  assert.equal(result.observed, false);
  assert.equal(typeof result.missing_reason, 'string');
  assert.ok(result.missing_reason.length > 0);
  assert.equal(result.margin.predicted, null);
  assert.equal(result.probabilities.available, false);
  assert.equal(result.distribution.available, false);
  // A qualification state must still be reported (the family's own general
  // production-readiness), independent of abstaining on this one game.
  assert.equal(typeof result.qualified, 'boolean');
  assert.equal(typeof result.qualification_source, 'string');
});

test('the direct-cover family is a clearly-labeled stub, never a fabricated bridge', () => {
  const result = directCoverFamilyForecast({ season: SEASON, week: WEEK, home, away });
  assert.equal(result.family, FAMILIES.direct_cover);
  assert.equal(result.observed, false);
  assert.match(result.missing_reason, /not_yet_connected/);
  assert.equal(result.qualified, false);
  assert.equal(result.margin.predicted, null);
  assert.equal(result.probabilities.available, false);
  assert.equal(result.distribution.available, false);
});

test('a family asked about a nonexistent matchup abstains rather than throws', () => {
  assert.doesNotThrow(() => {
    const result = ensembleFamilyForecast({ season: SEASON, week: WEEK, home: 'ZZ', away: 'YY' });
    assert.equal(typeof result.observed, 'boolean');
  });
});

/* ------------------------------------------------------------------ simulation */

test('the simulation family, when observed, reports a validated probability triple and a research-only qualification', () => {
  const result = simulationFamilyForecast({ season: SEASON, week: WEEK, home, away });
  assert.equal(result.family, FAMILIES.simulation);
  if (!result.observed) {
    // Honest either way: the fixture seeds no play-by-play, so
    // blendedProfiles() may or may not resolve a team profile depending on
    // what learnedProfiles() can build from weekly features alone. Either
    // outcome is legitimate; what matters is it is reported, not thrown.
    assert.equal(typeof result.missing_reason, 'string');
    return;
  }
  assert.equal(result.qualified, false, 'the simulator has no production promotion and must not report qualified');
  assert.match(result.qualification_source, /research_only/);
  assert.equal(typeof result.margin.predicted, 'number');
  if (result.probabilities.available) {
    const { win, push, loss } = result.probabilities;
    // The triple that was VALIDATED is the unrounded one (see
    // probabilitiesFromTriple); win/push/loss here are then independently
    // rounded to 3 decimals for display, which can reintroduce a drift of a
    // few thousandths -- the same display-rounding effect
    // nfl-ensemble.js's own r2()-rounded fields have, not a violation of the
    // invariant that was actually checked.
    assert.ok(Math.abs(win + push + loss - 1) < 2e-3, `win+push+loss summed to ${win + push + loss}`);
    assert.ok(win >= 0 && win <= 1 && push >= 0 && push <= 1 && loss >= 0 && loss <= 1);
  }
});

/* -------------------------------------------------------------------- ensemble */

test('LOAD-BEARING: the ensemble adapter faithfully reshapes ensembleLine\'s own output', () => {
  const direct = ensembleModule.ensembleLine(SEASON, WEEK, home, away,
    { blendMode: 'raw', includeEvidence: false, includeChallengers: false });
  assert.ok(!direct.error, `direct ensembleLine call failed: ${direct.error}`);
  assert.ok(Number.isFinite(direct.ensemble.projected_margin), 'fixture did not produce an ensemble margin to compare against');

  const result = ensembleFamilyForecast({ season: SEASON, week: WEEK, home, away });
  assert.equal(result.family, FAMILIES.ensemble);
  assert.equal(result.observed, true);

  // The point forecast: identical number, not a rounded or re-derived one.
  assert.equal(result.margin.predicted, direct.ensemble.projected_margin);
  const expectedMarket = direct.ensemble.market_spread != null ? +(-direct.ensemble.market_spread).toFixed(2) : null;
  assert.equal(result.margin.market, expectedMarket);

  assert.equal(result.detail.engine_version, direct.engine_version);
  assert.equal(result.detail.blend_mode, direct.ensemble.blend_mode);
  assert.equal(result.detail.is_market_identity, direct.ensemble.is_market_identity);
  assert.equal(result.detail.models_contributing_margin, direct.ensemble.models_contributing_margin);

  const dist = direct.ensemble.distribution;
  if (!dist) {
    assert.equal(result.distribution.available, false);
    assert.equal(result.qualified, false);
    return;
  }
  // The qualification claim must be the DISTRIBUTION's own field, verbatim.
  assert.equal(result.qualified, dist.production_eligible === true);
  assert.equal(result.distribution.available, true);
  assert.equal(result.distribution.method, dist.method);
  assert.equal(result.distribution.sample_size, dist.sample_size);
  assert.deepEqual(result.distribution.margin_quantiles, dist.margin_quantiles);
  assert.deepEqual(result.distribution.margin_interval_80, dist.margin_interval_80);
  assert.equal(result.uncertainty.value, dist.uncertainty_width_80);

  // The probability triple: a faithful reshaping of the distribution's own
  // home/away cover and push probabilities at the SAME market handicap -- not
  // independently recomputed by the adapter. `nfl-ensemble.js` exposes those
  // three fields already rounded to 2 decimals (r2()), which can leave them a
  // hair off summing to one; the adapter's own comment on
  // `probabilitiesFromTriple` documents why a sub-0.01 drift is proportionally
  // renormalized rather than rejected, so values are compared within that same
  // tolerance rather than by strict equality.
  if (direct.ensemble.market_spread != null
      && [dist.home_cover_probability, dist.push_probability, dist.away_cover_probability].every(Number.isFinite)) {
    assert.equal(result.probabilities.available, true);
    assert.ok(Math.abs(result.probabilities.win - dist.home_cover_probability) < 0.01,
      `win ${result.probabilities.win} vs source ${dist.home_cover_probability}`);
    assert.ok(Math.abs(result.probabilities.push - dist.push_probability) < 0.01,
      `push ${result.probabilities.push} vs source ${dist.push_probability}`);
    assert.ok(Math.abs(result.probabilities.loss - dist.away_cover_probability) < 0.01,
      `loss ${result.probabilities.loss} vs source ${dist.away_cover_probability}`);
    assert.equal(result.probabilities.handicap, +direct.ensemble.market_spread.toFixed(2));
    // And the reshaped triple must itself satisfy the shared invariant --
    // proof this adapter actually ran the numbers through
    // validateSpreadProbabilities rather than merely copying fields across.
    const total = result.probabilities.win + result.probabilities.push + result.probabilities.loss;
    assert.ok(Math.abs(total - 1) < 2e-3, `reshaped triple summed to ${total}`);
  } else {
    assert.equal(result.probabilities.available, false);
  }
});

test('the ensemble adapter agrees with a second, independent ensembleLine call at a different game', () => {
  const second = rows(`SELECT team AS home, opponent AS away FROM game_lines
    WHERE season=? AND week=? AND home=1 ORDER BY team DESC LIMIT 1`, SEASON, WEEK)[0];
  if (!second || (second.home === home && second.away === away)) return; // fixture too small; nothing new to check
  const direct = ensembleModule.ensembleLine(SEASON, WEEK, second.home, second.away,
    { blendMode: 'raw', includeEvidence: false, includeChallengers: false });
  if (direct.error || !Number.isFinite(direct.ensemble.projected_margin)) return;
  const result = ensembleFamilyForecast({ season: SEASON, week: WEEK, home: second.home, away: second.away });
  assert.equal(result.margin.predicted, direct.ensemble.projected_margin);
  assert.equal(result.game.home, second.home);
  assert.equal(result.game.away, second.away);
});
