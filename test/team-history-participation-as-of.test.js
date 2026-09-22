/**
 * A team vector may only see participation that had been published by its
 * cutoff.
 *
 * nflverse publishes a season's participation file only after that season's
 * post-season is complete (nflreadr load_participation reference; the 2025
 * file's last-modified is 2026-02-10). So at any kickoff in season S, the
 * newest participation anyone could have is season S-1. The live cycle can
 * therefore only ever serve prior-season formation features: the growth cycle
 * records the current season's 404 as a skip and never stores it.
 *
 * teamHistory (nfl-weekly-feature-store.js) read nfl_play_formations by game
 * week, `season < S OR (season = S AND week < w)`, the same shape as the feeds
 * that really are published weekly. Once scripts/backfill-formations.mjs loads
 * a completed season, a vector built for a week of that season (a re-freeze,
 * a team card, a research backfill) picks up that season's earlier weeks,
 * which nobody could have had at that kickoff. Skeptic reproduction on a local
 * copy: a 2025 week-5 KC vector's formation_shotgun_share__latest was KC's
 * 2025 week-4 share, while the served 2026 week-3 vector's was KC's 2025
 * week-18 share: one key, two meanings, training against serving.
 *
 * The charting_ family joins nfl_play_charting to nfl_play_formations for the
 * possession team, so its visibility is the participation file's too.
 *
 * What must NOT change: every weekly feed (team-week features, snaps,
 * injuries) still sees the target season's earlier weeks, and prior-season
 * participation still reaches the vector.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-participation-as-of-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { buildTeamFeatureVector, __test } = await import('../server/services/nfl-weekly-feature-store.js');
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
// The store rounds every transform to 6 decimals (r6 in nfl-weekly-feature-store.js).
const r6 = value => +value.toFixed(6);

// KC's weekly team features: 2024 week 18, then 2025 weeks 1-4. `points` is a
// weekly-published feed and must keep reading the target season's weeks.
const WEEKS = [[2024, 18, 17], [2025, 1, 21], [2025, 2, 24], [2025, 3, 27], [2025, 4, 30]];
for (const [season, week, points] of WEEKS) {
  run('INSERT INTO nfl_team_week_features (season, week, team, opponent, home, features) VALUES (?,?,?,?,?,?)',
    season, week, 'KC', 'DEN', 1, JSON.stringify({ points }));
}

// Participation: 2024 week 18 is all SINGLEBACK without motion; every 2025
// play is SHOTGUN with motion. Any 2025 value in a 2025 vector is look-ahead.
let playId = 0;
for (const [season, week] of WEEKS) {
  const gameId = `${season}_${String(week).padStart(2, '0')}_KC_DEN`;
  const is2025 = season === 2025;
  for (let i = 0; i < 3; i++) {
    playId++;
    run(`INSERT INTO nfl_play_formations (game_id, play_id, season, possession, offense_formation,
      defenders_in_box, pass_rushers) VALUES (?,?,?,?,?,?,?)`,
    gameId, playId, season, 'KC', is2025 ? 'SHOTGUN' : 'SINGLEBACK', 7, 4);
    run(`INSERT INTO nfl_play_charting (game_id, play_id, season, week, defense_box, motion, play_action)
      VALUES (?,?,?,?,?,?,?)`, gameId, playId, season, week, 7, is2025 ? 1 : 0, 0);
  }
}

test('a 2025 week-5 vector sees no 2025 participation: its latest shotgun share is 2024\'s', () => {
  const vector = buildTeamFeatureVector(2025, 5, 'KC').vector;
  assert.equal(vector.formation_shotgun_share__latest, 0,
    'the 2025 file was published in February 2026; 1 here is 2025 week 4, which no week-5 kickoff could see');
  assert.equal(vector.formation_shotgun_share__max_6, 0, 'no 2025 week reaches any transform');
  assert.equal(vector.formation_plays__coverage_12, r6(1 / 12), 'one participation week visible: 2024 week 18');
});

test('the charting family, joined through participation, has the same cutoff', () => {
  const vector = buildTeamFeatureVector(2025, 5, 'KC').vector;
  assert.equal(vector.charting_motion_share__latest, 0, '1 here is 2025 week 4 charting joined to 2025 participation');
  assert.equal(vector.charting_charted_plays__coverage_12, r6(1 / 12));
});

test('the history rows themselves carry no same-season participation', () => {
  const history = __test.teamHistory(2025, 5, 'KC');
  const leaked = history.filter(item => item.season === 2025
    && Object.keys(item.values).some(key => key.startsWith('formation_') || key.startsWith('charting_')));
  assert.deepEqual(leaked.map(item => item.week), [], 'no 2025 week carries formation_ or charting_ values');
});

test('weekly feeds still read the target season\'s earlier weeks', () => {
  const vector = buildTeamFeatureVector(2025, 5, 'KC').vector;
  assert.equal(vector.points__latest, 30, 'team-week features are published weekly: 2025 week 4 is visible');
  assert.equal(vector.points__coverage_12, r6(5 / 12));
});

test('known-nonzero: prior-season participation still reaches the vector', () => {
  // The next season's vector sees all of 2025, which is what serving sees in
  // season. Without this, deleting the formation read would pass the tests above.
  const vector = buildTeamFeatureVector(2026, 1, 'KC').vector;
  assert.equal(vector.formation_shotgun_share__latest, 1, '2025 week 4 is published by 2026 week 1');
  assert.equal(vector.formation_plays__coverage_12, r6(5 / 12), '2024 week 18 and 2025 weeks 1-4');
  assert.equal(vector.charting_motion_share__latest, 1);
});
