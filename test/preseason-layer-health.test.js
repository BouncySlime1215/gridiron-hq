/**
 * When a data layer under the preseason board goes inert, a caller can find out
 * (2026-09-20).
 *
 * `preseason-model.js` reads three optional layers and, until this change, swallowed
 * every fault from all three:
 *
 *   - `seasonTotals` parses a JSON `features` blob per player-week and did
 *     `catch { continue; }` on a malformed one, with no count. A row that fails to parse
 *     does not reach `cur.games += 1`, so the player's GAMES COUNT silently drops -- and
 *     `games_1`, `games_2` and `availability_3` are built from those counts. A player
 *     whose weeks would not parse looks like a player who did not play, which is the one
 *     thing this module's header calls the loudest finding in the whole audit.
 *   - `chartRows` did `catch { return new Map(); }`. Its doc comment justifies that for
 *     ONE case, a database that has never run an offseason sync, and the justification is
 *     sound. But the catch is indiscriminate: a renamed column, a corrupt file, a locked
 *     database and a typo in `CHART_COLUMNS` all produce the same empty Map, every
 *     charting feature is imputed to the median, and the drivers then describe median
 *     values as if they were this player's own.
 *   - `inHouseProjections` did `catch { /* a feature, not a dependency *​/ }`. Same shape:
 *     `buildProjections` throwing for any reason is indistinguishable from a player
 *     simply having no projection.
 *
 * CLAUDE.md: "Errors are handled or they throw. No bare `catch {}` that swallows a
 * fault... If a layer goes inert, the surface must say so." These tests are the "say so".
 *
 * WHAT IS NOT ASSERTED HERE. This does not change whether the board is produced. All
 * three faults still degrade rather than fail, because turning a working draft board
 * into a 500 on a structural database error is a product decision and not one to take
 * inside a test. What changes is that the degradation is reportable instead of silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-preseason-health-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { seasonTotals, preseasonLayerHealth, resetPreseasonCache }
  = await import('../server/services/preseason-model.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2024;

/** One player-week row, with `features` given verbatim so a test can supply broken JSON. */
function week(playerId, wk, featuresText, team = 'AAA') {
  run(`INSERT INTO nfl_player_week_features (season, week, team, player_id, player_name, position, features)
       VALUES (?,?,?,?,?,?,?)`, SEASON, wk, team, playerId, 'Health Tester', 'WR', featuresText);
}

test('an unparseable features row is counted, not skipped in silence', () => {
  resetPreseasonCache();
  const good = JSON.stringify({ receptions: 5, receiving_yards: 60, targets: 8 });
  week('h1', 1, good);
  week('h1', 2, '{not json at all');
  week('h1', 3, good);

  // seasonTotals returns { players, teamTargets, teamCarries, teamAttempts }; the
  // per-player aggregate is `players`.
  const totals = seasonTotals(SEASON).players;
  const health = preseasonLayerHealth(SEASON);

  // The behaviour that ships is unchanged: the bad week is still not counted as a game,
  // because a row whose stats cannot be read is not evidence that he played.
  assert.equal(totals.get('h1').games, 2, 'the unreadable week is still not counted as played');

  // What is new: somebody can find out.
  assert.equal(health.season_totals.unparsed_rows, 1,
    'the count is the point -- a run that dropped a third of the league looked identical to one '
    + 'that read all of it');
  assert.ok(Array.isArray(health.season_totals.samples) && health.season_totals.samples.length,
    'a count with no example cannot be investigated');
  assert.equal(health.season_totals.samples[0].player_id, 'h1');
  assert.equal(health.season_totals.samples[0].week, 2);
  assert.equal(health.season_totals.ok, false, 'a layer that dropped rows is not ok');
});

test('a clean season reports every layer ok, with a zero rather than a silence', () => {
  // The unreadable row from the test above is still in the table, and resetPreseasonCache
  // only drops the cache -- so it must go, or this is not a clean season. That the count
  // comes back as 1 until the row is deleted is the correct behaviour: the verdict is
  // re-derived from the read rather than remembered from the last one.
  run(`DELETE FROM nfl_player_week_features WHERE season = ? AND week = ?`, SEASON, 2);
  resetPreseasonCache();
  const health = preseasonLayerHealth(SEASON);
  assert.equal(health.season_totals.unparsed_rows, 0);
  assert.equal(health.season_totals.ok, true);
  // A confident zero, not an absence: the field exists and says none were dropped.
  assert.deepEqual(health.season_totals.samples, []);
});

test('an absent charting table is reported as absent, not as an error', () => {
  resetPreseasonCache();
  // The one case chartRows' comment legitimately tolerates: a database that has never
  // run an offseason sync. It must stay tolerated AND become visible.
  db.exec('DROP TABLE IF EXISTS off_player_season_features');
  const health = preseasonLayerHealth(SEASON);
  assert.equal(health.charting.ok, false);
  assert.equal(health.charting.state, 'absent',
    'a table that was never synced is a known state, not a fault');
  assert.match(health.charting.reason, /never|absent|no such table/i);
});

test('a charting table that exists but is the wrong shape is an error, not an absence', () => {
  resetPreseasonCache();
  // A renamed or missing COLUMN is the case the old catch could not tell from the case
  // above, and the two call for opposite responses: one is expected, one is a fault.
  db.exec('DROP TABLE IF EXISTS off_player_season_features');
  db.exec('CREATE TABLE off_player_season_features (season INTEGER, gsis_id TEXT)');
  const health = preseasonLayerHealth(SEASON);
  assert.equal(health.charting.ok, false);
  assert.equal(health.charting.state, 'error',
    'a present table missing its columns is not the never-synced case');
  assert.notEqual(health.charting.state, 'absent');
  assert.ok(health.charting.reason && health.charting.reason.length > 0,
    'the reason must carry what actually failed, not a shrug');
});

test('an in-house projection fault is reported, not imputed in silence', () => {
  // The third swallowing site. `buildProjections` reads `player_week_usage`, so removing
  // that table makes it throw for a reason that is a genuine fault rather than a player
  // simply having no projection -- which is exactly the distinction the bare catch here
  // could not draw. The board is still produced, by design; what changes is that a
  // caller can tell the feature was imputed for everybody rather than for nobody.
  db.exec('ALTER TABLE player_week_usage RENAME TO player_week_usage_hidden');
  try {
    resetPreseasonCache();
    const health = preseasonLayerHealth(SEASON);
    assert.equal(health.in_house_projections.ok, false);
    assert.equal(health.in_house_projections.state, 'error');
    assert.match(health.in_house_projections.reason, /buildProjections/,
      'the reason must name what failed, so the fault is actionable rather than a shrug');
    assert.match(health.in_house_projections.reason, /imputed/,
      'and must say what was done instead, which is what makes it a report and not a log line');
  } finally {
    db.exec('ALTER TABLE player_week_usage_hidden RENAME TO player_week_usage');
  }
});

test('the health report names every layer, so a new one cannot be added silently', () => {
  resetPreseasonCache();
  const health = preseasonLayerHealth(SEASON);
  assert.deepEqual(Object.keys(health).sort(),
    ['charting', 'in_house_projections', 'season_totals'],
    'a layer that reads from the database and is not in this list is a layer that can go '
    + 'inert without anybody being able to ask');
  for (const [name, layer] of Object.entries(health)) {
    assert.equal(typeof layer.ok, 'boolean', `${name}.ok must be a boolean, not absent`);
  }
});
