/**
 * SY-02. nflverse's play-by-play spells the Rams 'LA'. nfl-pbp.js stored it
 * as-is, so every weekly re-ingest wrote 'LA' rows beside the 'LAR' rows the
 * reconcile step had already renamed, and nfl_team_week_features ended a
 * season with 33 teams. reconcileHistoricalTeamCodes renamed with
 * UPDATE OR IGNORE, which silently skips exactly the rows that have a twin.
 *
 * Two halves: the writer stores one code per team, and reconcile folds any
 * existing LA twin into its LAR row, keeping every key the LAR row lacks.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sy02-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const COLS = ['season_type', 'week', 'posteam', 'defteam', 'home_team', 'play_type', 'down', 'ydstogo', 'yardline_100', 'epa', 'success', 'fixed_drive', 'drive_start_yard_line'];
const play = o => COLS.map(c => (o[c] ?? '')).join(',');
const csv = [COLS.join(','),
  play({ season_type: 'REG', week: 1, posteam: 'LA', defteam: 'SEA', home_team: 'LA', play_type: 'run', down: 1, ydstogo: 10, yardline_100: 75, epa: '0.2', success: '1', fixed_drive: 1, drive_start_yard_line: 'LA 25' }),
  play({ season_type: 'REG', week: 1, posteam: 'SEA', defteam: 'LA', home_team: 'LA', play_type: 'pass', down: 1, ydstogo: 10, yardline_100: 75, epa: '-0.1', success: '0', fixed_drive: 2, drive_start_yard_line: 'SEA 25' })];
globalThis.fetch = async () => ({
  ok: true, status: 200,
  body: Readable.toWeb(Readable.from([zlib.gzipSync(Buffer.from(csv.join('\n') + '\n'))]))
});

const { syncPbpSeason } = await import('../server/services/nfl-pbp.js');
const { reconcileHistoricalTeamCodes } = await import('../server/services/nfl-advanced.js');

test('an LA play-by-play row is stored as LAR, on both sides of the game', async () => {
  await syncPbpSeason(2030);
  const got = rows('SELECT team, opponent, home FROM nfl_team_week_features WHERE season=2030 ORDER BY team');
  assert.deepEqual(got.map(r => ({ ...r })), [
    { team: 'LAR', opponent: 'SEA', home: 1 },
    { team: 'SEA', opponent: 'LAR', home: 0 }
  ]);
});

// nflverse labels the Rams' half of the field 'LA 25', not 'LAR 25'. Once the
// writer canonicalises posteam, the yard-line prefix must be canonicalised too,
// or a Rams drive from their own 25 is stored as starting at the opponent's 25.
test('a Rams drive starting at "LA 25" is stored as their own 25, not 75', () => {
  const start = rows("SELECT team, features FROM nfl_team_week_features WHERE season=2030 ORDER BY team")
    .map(r => { const f = JSON.parse(r.features); return { team: r.team, off: f.off_avg_drive_start, def: f.def_avg_drive_start }; });
  assert.deepEqual(start, [
    { team: 'LAR', off: 25, def: 75 },
    { team: 'SEA', off: 25, def: 75 }
  ]);
});

const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];
const insert = (week, team, features) => run(
  'INSERT INTO nfl_team_week_features (season, week, team, opponent, home, features) VALUES (?,?,?,?,?,?)',
  2031, week, team, 'SEA', 1, JSON.stringify(features));

test('reconcile collapses LA/LAR twins to 32 teams and keeps every row\'s data', () => {
  for (const t of TEAMS) insert(1, t, { off_epa_per_play: 0 });
  insert(1, 'LAR', { off_epa_per_play: 0.1 });
  insert(1, 'LA', { off_epa_per_play: 0.9, only_on_la: 7 });   // twin: LAR wins, the extra key is kept
  insert(2, 'LA', { off_epa_per_play: 0.2 });                   // no twin: renamed
  const teams = () => rows('SELECT COUNT(DISTINCT team) n FROM nfl_team_week_features WHERE season=2031')[0].n;
  assert.equal(teams(), 33);

  reconcileHistoricalTeamCodes();

  assert.equal(teams(), 32);
  assert.equal(rows("SELECT COUNT(*) n FROM nfl_team_week_features WHERE season=2031 AND team='LA'")[0].n, 0);
  const lar = week => JSON.parse(rows("SELECT features FROM nfl_team_week_features WHERE season=2031 AND week=? AND team='LAR'", week)[0].features);
  assert.deepEqual(lar(1), { off_epa_per_play: 0.1, only_on_la: 7 });
  assert.deepEqual(lar(2), { off_epa_per_play: 0.2 });
});
