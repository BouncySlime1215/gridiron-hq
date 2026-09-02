import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Priority 4 matchup candidates: cutoff-safe profiles, prior-games-only fits,
// explicit abstention when thin, humble forecasts when trained.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-matchup-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/nfl-advanced.js');
await import('../server/services/nfl-pbp.js');
const m = await import('../server/services/nfl-matchup-specialists.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
// A deterministic "quality" per team drives both its features and its results,
// so a fit on prior games has something real (but modest) to find.
const quality = team => (TEAMS.indexOf(team) - 3.5) * 0.02;
let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };

function features(team) {
  const q = quality(team);
  const f = {};
  for (const [off, def] of Object.values(m.ROLE_FEATURES).flat()) {
    f[off] = 0.4 + q + rand() * 0.05;
    f[def] = 0.4 - q + rand() * 0.05;
  }
  return f;
}

function seedSeason(season, weeks) {
  for (let week = 1; week <= weeks; week++) {
    for (const team of TEAMS) {
      run(`INSERT INTO nfl_team_week_features (season,week,team,opponent,home,features) VALUES (?,?,?,?,?,?)`,
        season, week, team, 'OPP', 1, JSON.stringify(features(team)));
    }
    for (let i = 0; i < TEAMS.length; i += 2) {
      const home = TEAMS[(i + week) % TEAMS.length], away = TEAMS[(i + week + 1) % TEAMS.length];
      const edge = (quality(home) - quality(away)) * 60; // points of true edge the market only half prices
      const spread = -(edge / 2);
      const margin = Math.round(edge + rand() * 14);
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,team_score,opp_score,gameday)
           VALUES (?,?,?,?,1,?,44,22,'test',datetime('now'),?,?,?)`, season, week, home, away, spread, 24 + margin, 24, `${season}-10-0${(week % 7) + 1}`);
    }
  }
}

test('a role abstains with a reason when there are not enough prior settled games', () => {
  seedSeason(2020, 6);
  m.clearMatchupCache();
  const opinion = m.matchupOpinion('situational_efficiency', 2020, 6, 'AAA', 'BBB');
  assert.equal(opinion.forecast, null);
  assert.match(opinion.missing_reason, /prior settled games/);
  assert.ok(Array.isArray(opinion.differential), 'the evidence itself was available');
});

test('a role abstains when a team has no cutoff-safe profile', () => {
  const opinion = m.matchupOpinion('tendency_matchup', 2020, 1, 'AAA', 'BBB');
  assert.equal(opinion.forecast, null);
  assert.match(opinion.missing_reason, /no cutoff-safe tendency matchup profile/);
});

test('with enough prior games the fit is prior-only, capped and carries its uncertainty', () => {
  seedSeason(2019, 17); seedSeason(2021, 17); seedSeason(2022, 17); seedSeason(2023, 17);
  m.clearMatchupCache();
  const opinion = m.matchupOpinion('situational_efficiency', 2023, 10, 'HHH', 'AAA');
  assert.ok(Number.isFinite(opinion.forecast), opinion.missing_reason ?? 'forecast expected');
  assert.ok(Math.abs(opinion.forecast) <= 4, 'capped');
  assert.ok(opinion.uncertainty > 0);
  assert.ok(opinion.training_rows >= 200);
  assert.equal(opinion.coefficients.length, 5);
  // The best team at home against the worst should lean home, and the reverse should lean away.
  const reverse = m.matchupOpinion('situational_efficiency', 2023, 10, 'AAA', 'HHH');
  assert.ok(opinion.forecast > reverse.forecast, `expected ${opinion.forecast} > ${reverse.forecast}`);
  assert.equal(m.matchupOpinion('nope', 2023, 10, 'AAA', 'HHH').missing_reason, 'unknown role nope');
});

test('the continuity role needs snap history and reports a retention differential', () => {
  for (const [team, weeks] of [['AAA', [7, 8, 9]], ['BBB', [7, 8, 9]]]) {
    for (const week of weeks) for (let i = 0; i < 6; i++) {
      const player = team === 'BBB' && week === 9 && i < 2 ? `${team}-new${i}` : `${team}-ol${i}`;
      run(`INSERT INTO nfl_snaps (season,week,player,team,position,offense_snaps,offense_pct,st_pct,defense_snaps,defense_pct)
           VALUES (2023,?,?,?,?,60,?,0,0,0)`, week, player, team, i < 5 ? 'T' : 'QB', i < 5 ? 1 : 1);
    }
  }
  m.clearMatchupCache();
  const opinion = m.matchupOpinion('trench_continuity', 2023, 10, 'AAA', 'BBB');
  assert.ok(opinion.differential, opinion.missing_reason ?? 'differential expected');
  assert.ok(opinion.differential[0] > 0, 'AAA kept its line; BBB rotated two starters, so the home side retains more');
});
