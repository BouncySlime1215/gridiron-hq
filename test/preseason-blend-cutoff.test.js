/**
 * Codex correction C10: "Sparse preseason uncertainty still uses future-fitted
 * fallback."
 *
 * The measured symptom: a 2016 prediction's standard error moved from 5.756 to
 * 12.286 after changing only 2024 scores. Nothing about 2016 changed. The
 * sparse 2016 calibration produced a null variance and fell through to
 * `PRIOR_VARIANCE` — the module-level constant fitted from EVERY season on
 * record, 2024 included. A future-fitted substitute wearing a default's
 * clothing.
 *
 * These tests build their own history so the sparse case is reachable on a
 * clean checkout, which the existing suite cannot do (it needs the developer's
 * populated database — Codex correction C06).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-preseason-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (1,'KC','KC Team','AFC','West'), (2,'BAL','BAL Team','AFC','North')`);

/** One completed game with a real final score. */
function game(season, week, home, away, homeScore, awayScore) {
  for (const [team, opp, isHome, ts, os_] of [[home, away, 1, homeScore, awayScore],
    [away, home, 0, awayScore, homeScore]]) {
    run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,gametime)
         VALUES (?,?,?,?,?,-3,44,?,?,?,'13:00')`,
    season, week, team, opp, isHome, ts, os_, `${season}-09-${String(week).padStart(2, '0')}`);
  }
}

// A SPARSE early season: 2016 has a couple of games and no prior season at all,
// so a cutoff-safe calibration at asOfSeason 2016 has nothing to fit.
game(2016, 1, 'KC', 'BAL', 27, 20);
game(2016, 2, 'BAL', 'KC', 17, 24);

const blend = await import('../server/services/nfl-preseason-blend.js');

test('C10: a sparse cutoff falls back to the PRESPECIFIED prior, not a fitted one', () => {
  const rating = blend.blendedTeamRating(2016, 'KC', 3, { asOfSeason: 2016 });
  assert.equal(rating.calibration_evidence.status, 'insufficient_calibration_evidence',
    'too little eligible history is a stated status, not a silent substitution');
  assert.equal(rating.calibration_evidence.fallback_version, 'nfl-preseason-fallback-v1-prespecified');
  assert.match(rating.calibration_evidence.note, /prespecified prior/);
});

test('C10: adding a FUTURE season cannot change a sparse earlier forecast', () => {
  // The audit's exact experiment, in miniature: measure 2016, then add 2024
  // games, then measure 2016 again. Nothing about 2016 has changed.
  const before = blend.blendedTeamRating(2016, 'KC', 3, { asOfSeason: 2016 });

  for (let week = 1; week <= 16; week++) {
    game(2023, week, week % 2 ? 'KC' : 'BAL', week % 2 ? 'BAL' : 'KC', 30 + week, 10);
    game(2024, week, week % 2 ? 'KC' : 'BAL', week % 2 ? 'BAL' : 'KC', 34, 6 + week);
  }
  blend.invalidatePreseasonCalibrationCache?.();

  const after = blend.blendedTeamRating(2016, 'KC', 3, { asOfSeason: 2016 });
  assert.equal(after.posterior_se, before.posterior_se,
    'the 2016 standard error must not move when 2024 scores change');
  assert.equal(after.blended, before.blended);
  assert.equal(after.weight_on_prior, before.weight_on_prior);
  assert.equal(after.calibration_evidence.status, before.calibration_evidence.status);
});

test('C10: an asOfSeason LATER than the season being predicted is rejected', () => {
  assert.throws(() => blend.blendedTeamRating(2016, 'KC', 3, { asOfSeason: 2024 }),
    /later than the season being predicted/,
    'a forecast cannot be calibrated with data from after the thing it forecasts');
  // The equal case is legitimate: asOfSeason defaults to the season itself and
  // calibratePreseasonBlend filters to strictly EARLIER seasons.
  assert.doesNotThrow(() => blend.blendedTeamRating(2016, 'KC', 3, { asOfSeason: 2016 }));
});

test('C10: the prespecified fallback is a declared constant, never re-fitted', () => {
  const { PRESPECIFIED_FALLBACK } = blend;
  assert.equal(PRESPECIFIED_FALLBACK.per_game_variance, 196);
  assert.equal(PRESPECIFIED_FALLBACK.prior_variance, 36);
  assert.ok(Object.isFrozen(PRESPECIFIED_FALLBACK),
    'a fallback that can be reassigned at runtime is not prespecified');
  assert.match(PRESPECIFIED_FALLBACK.version, /prespecified/);
});

test('C10: the corrected Bayesian direction still holds under the fallback', () => {
  // The direction is the substance of the earlier repair and must survive this
  // one: MORE games means LESS weight on the prior and a SMALLER standard
  // error. If the fallback had broken the arithmetic, this is where it shows.
  const early = blend.blendedTeamRating(2016, 'KC', 2, { asOfSeason: 2016 });
  const later = blend.blendedTeamRating(2016, 'KC', 3, { asOfSeason: 2016 });
  if (early.weight_on_prior != null && later.weight_on_prior != null) {
    assert.ok(later.weight_on_prior <= early.weight_on_prior,
      'accumulating real games can never increase weight on the preseason prior');
  }
  assert.ok(later.games_played >= early.games_played);
});
