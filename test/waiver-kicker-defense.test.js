/**
 * No kicker or defense could be recommended on the waiver or bye-risk surfaces,
 * in five leagues that all start both (2026-09-19).
 *
 * Two independent causes, either of which alone is enough:
 *
 *  1. `SCORED` in waiver-brain.js listed 'DST'. Every writer of
 *     `players.position` writes 'DEF' — drafts.js, draft-assist.js,
 *     draft-lookahead.js, nfl-roster-strength.js — and 'DST' was the only
 *     occurrence of that spelling in the server tree, so the literal matched no
 *     row and no defense had ever reached the free-agent pool.
 *
 *  2. Kickers did reach it, and then changed the solved lineup by exactly zero,
 *     because `bestLineup` filters its pool and its slot list to QB/RB/WR/TE by
 *     design. So they fell out at `gain <= 0.05` in waiverUpgrades and at
 *     `recovered > 0.25` in roster-risk's byePatches — removed by a threshold
 *     meant for weak candidates, having never been scored at all.
 *
 * What Nick would see is an absence with no explanation, under a closing note
 * calling it "a good sign about your roster". A position nobody modelled and a
 * position nobody rates look identical to a reader, and only one of them is a
 * fact about the roster.
 *
 * These tests do not change what the solver scores. They pin what the surface
 * says about what it does not score.
 *
 * Built on the real pipeline rather than a mocked universe, deliberately: the
 * first cause is a mismatch between a literal here and the literal the seed and
 * every writer actually use, and a fixture that supplies its own players could
 * agree with the bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-waiver-kdef-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
// Every seeded team needs a week-1 game or current_week_ppg is 0 for everyone;
// matchupModel() caches the slate per process, so this lands before the first
// assetUniverse() call. Same note as test/decision-inbox.test.js.
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 1, abbr, 1 FROM nfl_teams`);
// Side-effect imports: assetUniverse() reads tables these route files create at
// import time.
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');

const { freeAgents, waiverUpgrades } = await import('../server/services/waiver-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const pick = position => row(
  `SELECT id, name FROM players WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT 1`, position);
const project = (player, points) => run(
  `INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',?,17)`,
  player.id, points);

// A kicker and a defense nobody rosters, both plainly worth having, and a
// receiver who would genuinely crack the lineup.
const freeKicker = pick('K');
const freeDefense = pick('DEF');
const freeWideout = row(
  `SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1 ORDER BY id LIMIT 1`);
project(freeKicker, 200);
project(freeDefense, 200);
project(freeWideout, 320);

// My roster: a full skill lineup of weaker players, so the receiver above is a
// real upgrade and nothing else is.
const POSITION_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const mine = ['QB', 'RB', 'RB', 'WR', 'TE'].map((position, i) => {
  const p = rows(`SELECT id, name FROM players WHERE position = ? AND fantasy_relevant = 1
                  AND id NOT IN (?,?,?) ORDER BY id LIMIT 5`,
    position, freeKicker.id, freeDefense.id, freeWideout.id)[i % 5];
  project(p, 60);
  return { ...p, position };
});
const entry = p => ({ playerPoolEntry: { player: {
  id: p.id, fullName: p.name, defaultPositionId: POSITION_ID[p.position] } } });

run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (401, 'espn', 'kdef-401', 2026, 'K and DEF', ?, 2, '1', ?, 'connected')`,
  JSON.stringify({ teams: [{ id: 1, name: 'My Team', roster: { entries: mine.map(entry) } }] }),
  JSON.stringify(SLOTS));
const lg = () => row('SELECT * FROM leagues WHERE id = 401');

test('a free-agent defense reaches the pool at all', () => {
  // Cause 1, on its own, against the seed's own spelling of the position.
  const pool = freeAgents(lg(), { limit: 600 });
  assert.ok(pool.some(fa => fa.position === 'DEF'),
    'a defense nobody rosters is a free agent');
  assert.ok(pool.some(fa => fa.id === freeDefense.id), `${freeDefense.name} specifically`);
});

test('the spelling this file uses is the spelling the data uses', () => {
  // The defect in its most direct form: 'DST' matched nothing, anywhere.
  assert.equal(rows(`SELECT id FROM players WHERE position = 'DST'`).length, 0,
    'nothing in this database has ever been a DST');
  assert.ok(rows(`SELECT id FROM players WHERE position = 'DEF'`).length > 0);
});

test('the pool records which rows the lineup solver can score', () => {
  const pool = freeAgents(lg(), { limit: 600 });
  assert.equal(pool.find(fa => fa.id === freeWideout.id)?.lineup_modelled, true);
  assert.equal(pool.find(fa => fa.id === freeDefense.id)?.lineup_modelled, false);
  assert.equal(pool.find(fa => fa.id === freeKicker.id)?.lineup_modelled, false);
});

test('the waiver list says what it does not cover, instead of just not covering it', () => {
  // Cause 2. Neither can rank here, and that is a limit of the model. The
  // surface now states it rather than leaving a hole shaped like a verdict.
  const result = waiverUpgrades(401, { myTeamId: '1' });
  assert.ok(result.not_modelled, 'the omission is stated');
  assert.deepEqual(result.not_modelled.positions, ['DEF', 'K']);
  assert.ok(result.not_modelled.in_pool > 0);
  assert.match(result.not_modelled.why, /not scored by the lineup solver/);
});

test('a kicker or defense still never appears as a ranked upgrade', () => {
  // Saying so is not a licence to start listing them at a fabricated gain.
  const result = waiverUpgrades(401, { myTeamId: '1' });
  for (const u of result.upgrades) {
    assert.ok(!['K', 'DEF'].includes(u.player.position),
      `${u.player.position} must not be ranked by a solver that does not score it`);
  }
});

test('a genuinely better skill player still ranks, unchanged', () => {
  const result = waiverUpgrades(401, { myTeamId: '1' });
  assert.ok(result.upgrades.length, 'the real upgrade is still found');
});

test('the closing note cannot claim a clean search it did not run', () => {
  // A second league whose roster nothing can improve, so the reassuring branch
  // is the one that runs. It used to read "a good sign about your roster" while
  // two positions had been dropped from the search unscored — the app reporting
  // as good news something it had not looked at.
  // Only projected players are priced, so rostering every projected skill
  // player leaves a pool of exactly the kicker and the defense — the state this
  // note is about, reached without inventing one.
  const roster = [...mine, { ...freeWideout, position: 'WR' }];
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, connection_status)
       VALUES (402, 'espn', 'kdef-402', 2026, 'Nothing To Add', ?, 2, '1', ?, 'connected')`,
    JSON.stringify({ teams: [{ id: 1, name: 'My Team', roster: { entries: roster.map(entry) } }] }),
    JSON.stringify(SLOTS));

  const result = waiverUpgrades(402, { myTeamId: '1' });
  assert.equal(result.upgrades.length, 0, 'the fixture must leave nothing to add');
  assert.ok(result.not_modelled, 'and the positions it never scored are still named');
  assert.match(result.note, /does not score at all/,
    'the reassuring line must not stand alone over an unscored position');
});
