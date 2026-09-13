import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * `weather_total` used to apply one flat league constant -- +1.2 indoors,
 * -2.4 in wind, -1.6 in cold -- to every game, identically, no matter which
 * two offenses were in it. `nfl-features.js` had measured each team's own
 * dome/cold/wind EPA response the whole time and nothing read it.
 *
 * These checks are about the WIRING and its safety rails, not about whether
 * the wiring forecasts better. They prove three things:
 *   1. with nothing measured, the component reproduces the old constants bit
 *      for bit, so the change cannot silently move a forecast it has no
 *      evidence about;
 *   2. when the measured deltas across the league are indistinguishable from
 *      sampling noise, the shrinkage collapses to that same baseline;
 *   3. when a real between-team spread does survive the noise, two offenses in
 *      the SAME weather finally get different numbers, and the deviations are
 *      centred on zero so the league-average effect is not counted twice.
 *
 * Whether this reduces total-line error on real games is a separate question
 * that only a walk-forward run on populated history can answer; see
 * scripts/measure-weather-split.mjs.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weather-response-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/nfl-pbp.js');
const { __testables, invalidateEnsembleCaches } = await import('../server/services/nfl-ensemble.js');
const { weatherSensitivity, weatherAdjustment, FLAT_WEATHER_POINTS, DEFAULT_OFF_PLAYS,
  weatherDeviationCap } = __testables;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2024;
/** 16 teams, so the eight-team floor for estimating a league spread is cleared. */
const TEAMS = Array.from({ length: 16 }, (_, i) => `T${String(i).padStart(2, '0')}`);

/** One prior game: its conditions in game_lines, its offensive EPA in the feature table. */
function priorGame(team, week, { roof = 'outdoors', temp: t = 60, wind = 5, epa, plays = 63 }) {
  run(`INSERT OR REPLACE INTO game_lines (season,week,team,opponent,home,spread,total,source,fetched_at,
       team_score,opp_score,roof,temp,wind)
       VALUES (?,?,?,'OPP',1,-3,44,'test',datetime('now'),24,20,?,?,?)`,
  SEASON, week, team, roof, t, wind);
  run(`INSERT OR REPLACE INTO nfl_team_week_features (season,week,team,opponent,home,features)
       VALUES (?,?,?,'OPP',1,?)`,
  SEASON, week, team, JSON.stringify({ off_epa_per_play: epa, off_plays: plays }));
}

function reset() {
  run(`DELETE FROM game_lines`);
  run(`DELETE FROM nfl_team_week_features`);
  invalidateEnsembleCaches();
}

/**
 * The context `weather_total` reads, with only the fields the adjustment
 * touches. `feat` is left empty so snap counts fall back to DEFAULT_OFF_PLAYS
 * and the arithmetic in these checks stays exact.
 */
function context(week, { roof = 'outdoors', temp: t = 60, wind = 5, home, away } = {}) {
  return { roof, temp: t, wind, home, away,
    weather: weatherSensitivity(SEASON, week), feat: new Map() };
}

test('with nothing measured, every condition reproduces the old flat constant exactly', () => {
  reset();
  const c = week => ({ ...context(week), home: 'T00', away: 'T01' });
  assert.equal(weatherAdjustment({ ...c(5), roof: 'dome' }), FLAT_WEATHER_POINTS.dome);
  assert.equal(weatherAdjustment({ ...c(5), roof: 'closed' }), FLAT_WEATHER_POINTS.dome);
  assert.equal(weatherAdjustment({ ...c(5), wind: 20 }), FLAT_WEATHER_POINTS.wind);
  assert.equal(weatherAdjustment({ ...c(5), temp: 20 }), FLAT_WEATHER_POINTS.cold);
  assert.equal(weatherAdjustment({ ...c(5), wind: 20, temp: 20 }),
    FLAT_WEATHER_POINTS.wind + FLAT_WEATHER_POINTS.cold);
  assert.equal(weatherAdjustment(c(5)), 0, 'fair weather outdoors is still no adjustment at all');
});

test('deltas that are pure sampling noise are shrunk away to the flat constant', () => {
  reset();
  // Every team has the same underlying offense; the only thing separating their
  // windy games from their calm ones is which sample landed where. There is no
  // between-team weather signal here to find, and none should be reported.
  let seed = 1;
  const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - 0.5) * 0.24; };
  for (const team of TEAMS) {
    for (let w = 1; w <= 12; w++) priorGame(team, w, { wind: w <= 3 ? 20 : 5, epa: noise() });
  }
  invalidateEnsembleCaches();
  const sens = weatherSensitivity(SEASON, 13);
  assert.equal(sens.diagnostics.wind.shrunk, false,
    'no between-team variance survives subtracting the sampling noise');
  const c = { ...context(13), home: TEAMS[0], away: TEAMS[1], wind: 20 };
  assert.equal(weatherAdjustment(c), FLAT_WEATHER_POINTS.wind);
});

test('a real between-team spread separates two offenses standing in the same wind', () => {
  reset();
  // Half the league is badly hurt by wind, half is barely touched, and each
  // team's split is consistent across many games -- a spread far too large and
  // too repeated to be sampling noise.
  TEAMS.forEach((team, i) => {
    const windEffect = i % 2 === 0 ? -0.25 : 0.05;
    for (let w = 1; w <= 16; w++) {
      const windy = w % 2 === 0;
      priorGame(team, w, { wind: windy ? 20 : 5, epa: (windy ? windEffect : 0) + (w % 4) * 0.002 });
    }
  });
  invalidateEnsembleCaches();
  const sens = weatherSensitivity(SEASON, 17);
  assert.equal(sens.diagnostics.wind.shrunk, true, 'a genuine league spread is detected');
  assert.equal(sens.diagnostics.wind.teams, 16);

  const hurt = sens.byTeam.get(TEAMS[0]).wind;
  const fine = sens.byTeam.get(TEAMS[1]).wind;
  assert.ok(hurt < 0 && fine > 0, `expected opposite-signed deviations, got ${hurt} and ${fine}`);

  // The league-average wind effect already lives in the flat constant, so the
  // deviations this returns must average to zero rather than re-adding it.
  const all = TEAMS.map(t => sens.byTeam.get(t).wind);
  assert.ok(Math.abs(all.reduce((s, v) => s + v, 0) / all.length) < 1e-9,
    'deviations are centred on zero, so the flat constant is not double counted');

  // Two wind-hurt offenses should now forecast a lower total than two that
  // shrug it off, in the very same conditions.
  const windy = { roof: 'outdoors', temp: 60, wind: 20, weather: sens, feat: new Map() };
  const bothHurt = weatherAdjustment({ ...windy, home: TEAMS[0], away: TEAMS[2] });
  const bothFine = weatherAdjustment({ ...windy, home: TEAMS[1], away: TEAMS[3] });
  assert.ok(bothHurt < FLAT_WEATHER_POINTS.wind, 'wind-sensitive offenses go below the constant');
  assert.ok(bothFine > FLAT_WEATHER_POINTS.wind, 'wind-resistant offenses go above it');
  assert.ok(bothFine - bothHurt > 1,
    `the split should be worth more than a point of total, got ${(bothFine - bothHurt).toFixed(2)}`);

  // A dome game reads no wind response at all -- the conditions in front of the
  // model decide which measured response applies.
  assert.equal(weatherAdjustment({ ...windy, wind: 5, roof: 'dome', home: TEAMS[0], away: TEAMS[2] }),
    FLAT_WEATHER_POINTS.dome, 'no dome games were played, so there is no dome deviation to apply');
});

test('an offense with no prior games in those conditions contributes nothing', () => {
  reset();
  // A mild but consistent league split, chosen so the per-offense cap does not
  // bind and the arithmetic below is exact.
  TEAMS.forEach((team, i) => {
    for (let w = 1; w <= 16; w++) {
      const windy = w % 2 === 0;
      priorGame(team, w, { wind: windy ? 20 : 5, epa: (windy ? (i % 2 === 0 ? -0.02 : 0.005) : 0) + (w % 4) * 0.0005 });
    }
  });
  // A seventeenth team that has only ever played calm games.
  for (let w = 1; w <= 16; w++) priorGame('CALM', w, { wind: 5, epa: 0.01 });
  invalidateEnsembleCaches();
  const sens = weatherSensitivity(SEASON, 17);
  assert.equal(sens.byTeam.has('CALM'), false, 'no windy games means no wind delta to shrink');

  const windy = { roof: 'outdoors', temp: 60, wind: 20, weather: sens, feat: new Map() };
  const withUnknown = weatherAdjustment({ ...windy, home: 'CALM', away: TEAMS[1] });
  const onlyKnown = weatherAdjustment({ ...windy, home: TEAMS[1], away: 'CALM' });
  assert.equal(withUnknown, onlyKnown, 'the unmeasured side is symmetric and silent');
  const moved = sens.byTeam.get(TEAMS[1]).wind * DEFAULT_OFF_PLAYS;
  assert.ok(Math.abs(moved) < weatherDeviationCap(['wind']), 'this fixture stays inside the cap');
  assert.equal(+(withUnknown - FLAT_WEATHER_POINTS.wind).toFixed(9), +moved.toFixed(9),
    'exactly one offense moves the number');
});

test('one offense may not shift its share of the weather effect by more than that effect', () => {
  reset();
  // An absurd, physically implausible split -- the kind a corrupt feature row
  // would produce. The estimate survives shrinkage because it is consistent,
  // so the cap is the only thing standing between it and the forecast.
  TEAMS.forEach((team, i) => {
    for (let w = 1; w <= 16; w++) {
      const windy = w % 2 === 0;
      priorGame(team, w, { wind: windy ? 20 : 5, epa: (windy ? (i % 2 === 0 ? -0.25 : 0.05) : 0) + (w % 4) * 0.002 });
    }
  });
  invalidateEnsembleCaches();
  const sens = weatherSensitivity(SEASON, 17);
  const cap = weatherDeviationCap(['wind']);
  assert.equal(cap, Math.abs(FLAT_WEATHER_POINTS.wind) / 2,
    'the bound on one offense is its own share of the league effect');
  const raw = sens.byTeam.get(TEAMS[0]).wind * DEFAULT_OFF_PLAYS;
  assert.ok(raw < -cap, `fixture should exceed the cap, got ${raw.toFixed(2)}`);
  const windy = { roof: 'outdoors', temp: 60, wind: 20, weather: sens, feat: new Map() };
  const both = weatherAdjustment({ ...windy, home: TEAMS[0], away: TEAMS[2] });
  assert.equal(both, FLAT_WEATHER_POINTS.wind - 2 * cap,
    'each offense is capped independently, and neither escapes it');
  // Two conditions at once raise the bound by the second effect's share, and
  // no further: the cap tracks what is being adjusted.
  assert.equal(weatherDeviationCap(['wind', 'cold']),
    (Math.abs(FLAT_WEATHER_POINTS.wind) + Math.abs(FLAT_WEATHER_POINTS.cold)) / 2);
});
