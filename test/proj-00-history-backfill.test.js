/**
 * PROJ-00-a: history backfill. nflverse play-by-play goes into nfl_play_by_play,
 * participation players go into nfl_play_participation_players (migration 074),
 * and the load refuses to run until the licence file says the source is usable.
 *
 * What these tests pin:
 *   1. The licence gate. The loaders refuse (exit 2, no database opened) while
 *      the licence file is absent, and they refuse a source the file marks
 *      blocked. Each loader gates on its own source, and any verdict word other
 *      than `usable` refuses. ESPN leaguedefaults is usable, local-archive-only,
 *      in the committed file (Nick accepted the Disney ToU risk 2026-09-23).
 *   2. The pbp mapping. nflverse columns become the play shape `storePlays`
 *      (nfl-espn-pbp.js) already writes, in the engine's own play_type
 *      vocabulary (classifyPlay). Nothing the engine does not simulate is
 *      counted as a rush.
 *   3. One producer per game, both ways: the ESPN `backfillSeasons` skips a
 *      season that nflverse already loaded, and the nflverse loader refuses a
 *      season that already holds ESPN plays. Two-point tries are untyped in both.
 *   4. Participation: one row per offense player per offensive snap, team codes
 *      canonical, was_route_runner NULL (not published), plus the
 *      player_week_snaps match share served at GET /formations/participation.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-proj00-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const LICENCE = path.join(ROOT, 'docs', 'evidence', '2026-09-23', 'proj-00-licences.md');

// ---- 1. licence gate --------------------------------------------------------

test('the licence gate reads the committed decisions', async () => {
  const { licenceDecision } = await import('../server/services/licence-gate.js');
  assert.equal(licenceDecision('nflverse_pbp', { file: LICENCE }).usable, true);
  assert.equal(licenceDecision('nflverse_participation', { file: LICENCE }).usable, true);
  assert.equal(licenceDecision('open_meteo_archive', { file: LICENCE }).usable, true);
  const espn = licenceDecision('espn_leaguedefaults', { file: LICENCE });
  assert.equal(espn.usable, true, 'Nick accepted the Disney ToU risk 2026-09-23 for a local-only archive');
  assert.match(espn.reason, /LOCAL archive only/);
  const missing = licenceDecision('nflverse_pbp', { file: path.join(temp, 'no-such-licence.md') });
  assert.equal(missing.usable, false);
  assert.match(missing.reason, /licence file missing/);
  const unnamed = licenceDecision('some_new_source', { file: LICENCE });
  assert.equal(unnamed.usable, false, 'a source the file does not name is not usable');
  // Any verdict word other than `usable` refuses; there is no default-allow.
  assert.equal(licenceDecision('ftn_charting', { file: LICENCE }).usable, false,
    'the committed "ftn_charting not pulled" line is not a usable verdict');
  const pendingFile = path.join(temp, 'pending-licence.md');
  fs.writeFileSync(pendingFile, '- decision: nflverse_pbp pending review\n');
  const pending = licenceDecision('nflverse_pbp', { file: pendingFile });
  assert.equal(pending.usable, false, 'a pending verdict is a refusal');
  assert.match(pending.reason, /is pending/);
});

function runScript(script, args, env) {
  const clean = { ...process.env };
  delete clean.GRIDIRON_DB_PATH;
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { ...clean, SCHEDULER_DISABLED: '1', ...env } });
}

test('RED (1): the loaders refuse to run while the licence file is absent', () => {
  const dbPath = path.join(temp, 'never-created.sqlite');
  const env = { GRIDIRON_DB_PATH: dbPath, GRIDIRON_LICENCE_FILE: path.join(temp, 'absent.md') };
  for (const [script, args] of [
    ['backfill-history.mjs', ['pbp', '2023', path.join(temp, 'x.csv.gz')]],
    ['backfill-history.mjs', ['weather', '2023']],
    ['backfill-participation.mjs', ['2023', path.join(temp, 'x.csv')]],
  ]) {
    const result = runScript(script, args, env);
    assert.equal(result.status, 2, `${script} ${args[0]}: exit ${result.status}; stderr: ${result.stderr}`);
    assert.match(result.stderr, /licence file missing/);
  }
  assert.equal(fs.existsSync(dbPath), false, 'a refused run opens no database');
});

test('each loader gates on its own source, not on any usable source', () => {
  const gz = path.join(temp, 'gate-x.csv.gz');
  fs.writeFileSync(gz, zlib.gzipSync('play_id\n'));
  const csvFile = path.join(temp, 'gate-x.csv');
  fs.writeFileSync(csvFile, 'nflverse_game_id\n');
  const cases = [
    { lines: ['nflverse_pbp blocked', 'open_meteo_archive usable', 'nflverse_participation usable'],
      script: 'backfill-history.mjs', args: ['pbp', '2023', gz], blocked: 'nflverse_pbp' },
    { lines: ['nflverse_pbp usable', 'open_meteo_archive blocked', 'nflverse_participation usable'],
      script: 'backfill-history.mjs', args: ['weather', '2023'], blocked: 'open_meteo_archive' },
    { lines: ['nflverse_pbp usable', 'open_meteo_archive usable', 'nflverse_participation blocked'],
      script: 'backfill-participation.mjs', args: ['2023', csvFile], blocked: 'nflverse_participation' },
  ];
  for (const [i, c] of cases.entries()) {
    const licence = path.join(temp, `gate-licence-${i}.md`);
    fs.writeFileSync(licence, c.lines.map(l => `- decision: ${l} (fixture)`).join('\n') + '\n');
    const dbPath = path.join(temp, `gate-never-${i}.sqlite`);
    const result = runScript(c.script, c.args, { GRIDIRON_DB_PATH: dbPath, GRIDIRON_LICENCE_FILE: licence });
    assert.equal(result.status, 2, `${c.script} ${c.args[0]}: exit ${result.status}; stderr: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`licence decision for ${c.blocked} is blocked`));
    assert.equal(fs.existsSync(dbPath), false, `${c.script} ${c.args[0]}: a refused run opens no database`);
  }
});

test('the loaders refuse without an explicit database path', () => {
  const result = runScript('backfill-history.mjs', ['pbp', '2023', 'x.csv.gz'], {});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GRIDIRON_DB_PATH/);
});

// ---- 2. pbp mapping ---------------------------------------------------------

const PBP_HEADER = ['play_id', 'game_id', 'season', 'season_type', 'week', 'posteam', 'defteam', 'qtr',
  'game_seconds_remaining', 'down', 'ydstogo', 'yardline_100', 'desc', 'play_type', 'yards_gained',
  'shotgun', 'no_huddle', 'pass_length', 'pass_location', 'field_goal_result', 'touchdown', 'safety',
  'interception', 'fumble_lost', 'sack', 'incomplete_pass', 'penalty', 'total_home_score',
  'total_away_score', 'order_sequence', 'qb_spike', 'two_point_attempt'];
const pbpRec = over => Object.fromEntries(PBP_HEADER.map(h => [h, over[h] ?? (
  ['touchdown', 'safety', 'interception', 'fumble_lost', 'sack', 'incomplete_pass', 'penalty',
    'shotgun', 'no_huddle', 'qb_spike', 'two_point_attempt'].includes(h) ? '0' : 'NA')]));
const base = { game_id: '2023_05_LA_PHI', season: '2023', season_type: 'REG', week: '5', posteam: 'LA',
  defteam: 'PHI', qtr: '2', game_seconds_remaining: '2100', down: '3', ydstogo: '7', yardline_100: '42',
  total_home_score: '7', total_away_score: '3' };

test('nflverse plays map to the engine vocabulary storePlays writes', async () => {
  const { mapNflversePlay } = await import('../server/services/nflverse-pbp.js');
  const m = over => mapNflversePlay(pbpRec({ ...base, ...over }));
  const pass = m({ play_id: '101', play_type: 'pass', yards_gained: '12', shotgun: '1', pass_length: 'short',
    pass_location: 'right', desc: '(Shotgun) M.Stafford pass short right to P.Nacua to PHI 30 for 12 yards',
    order_sequence: '101' });
  assert.equal(pass.event_id, '2023_05_LA_PHI');
  assert.equal(pass.season, 2023);
  assert.equal(pass.week, 5);
  assert.equal(pass.play.play_id, '101');
  assert.equal(pass.play.play_type, 'pass');
  assert.equal(pass.play.offense, 'LAR', 'the feed writes LA for the Rams; stored code is canonical');
  assert.equal(pass.play.defense, 'PHI');
  assert.equal(pass.play.period, 2);
  assert.equal(pass.play.clock_seconds, 2100);
  assert.equal(pass.play.down, 3);
  assert.equal(pass.play.distance, 7);
  assert.equal(pass.play.yards_to_endzone, 42);
  assert.equal(pass.play.yards_gained, 12);
  assert.equal(pass.play.shotgun, 1);
  assert.equal(pass.play.no_huddle, 0);
  assert.equal(pass.play.pass_depth, 'short');
  assert.equal(pass.play.pass_direction, 'right');
  assert.equal(pass.play.home_score, 7);
  assert.equal(pass.play.away_score, 3);
  assert.equal(pass.play.is_turnover, 0);

  assert.equal(m({ play_id: '2', play_type: 'pass', incomplete_pass: '1' }).play.play_type, 'incompletion');
  assert.equal(m({ play_id: '3', play_type: 'pass', sack: '1', yards_gained: '-8' }).play.play_type, 'sack');
  const pick = m({ play_id: '4', play_type: 'pass', interception: '1' }).play;
  assert.equal(pick.play_type, 'interception');
  assert.equal(pick.is_turnover, 1);
  const fum = m({ play_id: '5', play_type: 'run', fumble_lost: '1' }).play;
  assert.equal(fum.play_type, 'fumble');
  assert.equal(fum.is_turnover, 1);
  assert.equal(m({ play_id: '6', play_type: 'run', yards_gained: '4' }).play.play_type, 'rush');
  assert.equal(m({ play_id: '7', play_type: 'field_goal', field_goal_result: 'made' }).play.play_type, 'fg_make');
  assert.equal(m({ play_id: '8', play_type: 'field_goal', field_goal_result: 'missed' }).play.play_type, 'fg_miss');
  assert.equal(m({ play_id: '9', play_type: 'field_goal', field_goal_result: 'blocked' }).play.play_type, 'fg_miss');
  assert.equal(m({ play_id: '10', play_type: 'punt' }).play.play_type, 'punt');
  assert.equal(m({ play_id: '11', play_type: 'qb_kneel' }).play.play_type, 'kneel');
  for (const skip of ['kickoff', 'extra_point', 'no_play', 'NA']) {
    assert.equal(m({ play_id: '12', play_type: skip }).play.play_type, null, `${skip} is not simulated`);
  }
  // A two-point try is not simulated: ESPN's classifyPlay gives 'two-point' null, so nflverse does too.
  // A failed two-point pass has incomplete_pass 0 in nflverse; it must not become a completed pass.
  assert.equal(m({ play_id: '16', play_type: 'pass', two_point_attempt: '1' }).play.play_type, null);
  assert.equal(m({ play_id: '17', play_type: 'run', two_point_attempt: '1' }).play.play_type, null);
  assert.equal(m({ play_id: '18', play_type: 'pass', two_point_attempt: '0' }).play.play_type, 'pass', 'control');
  const td = m({ play_id: '13', play_type: 'run', touchdown: '1' }).play;
  assert.equal(td.is_scoring, 1);
  assert.equal(m({ play_id: '14', play_type: 'no_play', penalty: '1' }).play.is_penalty, 1);
  assert.equal(m({ play_id: '15', play_type: 'run', down: 'NA' }).play.down, null, 'NA is unknown, not zero');
});

function writePbpGz(file, recs) {
  const esc = v => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const text = [PBP_HEADER.join(','), ...recs.map(r => PBP_HEADER.map(h => esc(r[h])).join(','))].join('\n') + '\n';
  fs.writeFileSync(file, zlib.gzipSync(text));
}

test('a season file loads through storePlays, every published row, idempotently', async () => {
  const { ingestNflversePbpFile } = await import('../server/services/nflverse-pbp.js');
  const file = path.join(temp, 'play_by_play_2022.csv.gz');
  const recs = [
    pbpRec({ ...base, season: '2022', game_id: '2022_01_BUF_LA', week: '1', play_id: '1', play_type: 'NA',
      desc: 'GAME' }),
    pbpRec({ ...base, season: '2022', game_id: '2022_01_BUF_LA', week: '1', play_id: '40', play_type: 'pass',
      desc: 'J.Allen pass short left to S.Diggs, "quoted", for 5 yards', yards_gained: '5' }),
    pbpRec({ ...base, season: '2022', game_id: '2022_02_TEN_BUF', week: '2', play_id: '55', play_type: 'run',
      yards_gained: '3' }),
    pbpRec({ ...base, season: '2022', game_id: '2022_19_MIA_BUF', season_type: 'POST', week: '19',
      play_id: '60', play_type: 'run', yards_gained: '1' }),
  ];
  writePbpGz(file, recs);
  const first = await ingestNflversePbpFile(2022, file);
  assert.equal(first.rows_read, 4);
  assert.equal(first.plays_stored, 4, 'every published row is stored, postseason included');
  assert.equal(first.games, 3);
  const again = await ingestNflversePbpFile(2022, file);
  assert.equal(again.plays_stored, 4);
  assert.equal(row('SELECT COUNT(*) n FROM nfl_play_by_play WHERE season=2022').n, 4, 're-run does not duplicate');
  const quoted = row(`SELECT text FROM nfl_play_by_play WHERE event_id='2022_01_BUF_LA' AND play_id='40'`);
  assert.equal(quoted.text, 'J.Allen pass short left to S.Diggs, "quoted", for 5 yards');
  const wrong = await ingestNflversePbpFile(2021, file).catch(e => e);
  assert.ok(wrong instanceof Error && /season/.test(wrong.message), 'a file for another season is refused');
});

// ---- 3. one producer per game ----------------------------------------------

test('ESPN backfillSeasons skips a season nflverse already loaded', async () => {
  const { backfillSeasons } = await import('../server/services/nfl-espn-pbp.js');
  const asked = [];
  globalThis.fetch = async url => { asked.push(String(url)); return { ok: false, status: 503, json: async () => ({}) }; };
  try {
    const out = await backfillSeasons({ seasons: [2022, 2020], throttleMs: 0 });
    assert.equal(asked.filter(u => /dates=2022/.test(u)).length, 0, 'no ESPN call for a season nflverse holds');
    assert.ok(asked.some(u => /dates=2020/.test(u)), 'control: a season nflverse does not hold is still asked for');
    const s2022 = out.seasons.find(s => s.season === 2022);
    assert.equal(s2022.skipped_reason, 'nflverse pbp already loaded');
  } finally { globalThis.fetch = realFetch; }
});

test('pbpStatus names both sources', async () => {
  const { pbpStatus } = await import('../server/services/nfl-espn-pbp.js');
  const s = pbpStatus();
  const nv = s.by_source.find(x => x.source === 'nflverse');
  assert.equal(nv.plays, 4);
  assert.match(s.source, /nflverse/);
});

test('the nflverse loader refuses a season ESPN already holds (one producer per game)', async () => {
  const { storePlays } = await import('../server/services/nfl-espn-pbp.js');
  const { ingestNflversePbpFile } = await import('../server/services/nflverse-pbp.js');
  storePlays({ event_id: '401000001', season: 2019, week: 1, plays: [{ play_id: '1', sequence: 1, period: 1,
    clock_seconds: 3600, offense: 'BUF', defense: 'NYJ', down: 1, distance: 10, yards_to_endzone: 75,
    play_type: 'rush', yards_gained: 3, is_turnover: 0, is_scoring: 0, is_penalty: 0, shotgun: null,
    no_huddle: null, pass_depth: null, pass_direction: null, home_score: 0, away_score: 0, text: 'ESPN fixture' }] });
  const file = path.join(temp, 'play_by_play_2019.csv.gz');
  writePbpGz(file, [pbpRec({ ...base, season: '2019', game_id: '2019_01_NYJ_BUF', week: '1', play_id: '40',
    play_type: 'run', yards_gained: '3' })]);
  const refused = await ingestNflversePbpFile(2019, file).catch(e => e);
  assert.ok(refused instanceof Error && /ESPN/.test(refused.message), `refused: ${refused?.message ?? refused}`);
  assert.equal(row(`SELECT COUNT(*) n FROM nfl_play_by_play WHERE event_id='2019_01_NYJ_BUF'`).n, 0,
    'nothing is written for a season ESPN holds');
  const cli = runScript('backfill-history.mjs', ['pbp', '2019', file], { GRIDIRON_DB_PATH: process.env.GRIDIRON_DB_PATH });
  assert.equal(cli.status, 2, `exit ${cli.status}; stderr: ${cli.stderr}`);
  assert.match(cli.stderr, /2019 already has 1 ESPN play/);
  assert.equal(row(`SELECT COUNT(*) n FROM nfl_play_by_play WHERE event_id='2019_01_NYJ_BUF'`).n, 0);
});

// ---- 4. participation -------------------------------------------------------

// Participation plays are kept only when they are offensive snaps, judged against the
// nflverse play row in nfl_play_by_play: kicking plays (punt, field goal) are skipped,
// and an untyped row (kickoff, extra point, pre-snap penalty) is kept only when the
// feed recorded an offensive formation (a snapped play: post-snap penalty, two-point try).
async function seedPbp(gameId, season, week, plays) {
  const { mapNflversePlay } = await import('../server/services/nflverse-pbp.js');
  const { storePlays } = await import('../server/services/nfl-espn-pbp.js');
  const mapped = plays.map(over => mapNflversePlay(pbpRec({ ...base, game_id: gameId, season: String(season),
    week: String(week), ...over })).play);
  storePlays({ event_id: gameId, season, week, plays: mapped });
}

const PART_HEADER = 'nflverse_game_id,old_game_id,play_id,possession_team,offense_formation,offense_personnel,'
  + 'defenders_in_box,defense_personnel,number_of_pass_rushers,players_on_play,offense_players,defense_players,'
  + 'n_offense,n_defense,ngs_air_yards,time_to_throw,was_pressure,route,defense_man_zone_type,defense_coverage_type';

test('migration 074 adds the participation table, additive only', () => {
  const cols = rows('PRAGMA table_info(nfl_play_participation_players)').map(c => c.name);
  assert.deepEqual(cols, ['game_id', 'play_id', 'season', 'week', 'gsis_id', 'team', 'was_route_runner']);
  const applied = row(`SELECT name FROM schema_migrations WHERE name='074_nfl_play_participation_players'`);
  assert.ok(applied, 'migration recorded');
});

test('participation writes one row per offense player, and the snaps match share reaches the route', async () => {
  const { ingestParticipationFile, parseOffensePlayers } = await import('../server/services/nfl-participation.js');
  assert.deepEqual(parseOffensePlayers('00-0031234;00-0035678;;bad'), ['00-0031234', '00-0035678']);
  assert.deepEqual(parseOffensePlayers(''), []);

  const file = path.join(temp, 'pbp_participation_2023.csv');
  const lines = [PART_HEADER,
    '2023_01_LA_SEA,2023091001,40,LA,SHOTGUN,"1 RB, 1 TE, 3 WR",6,"4 DL, 2 LB, 5 DB",4,x,00-0000001;00-0000002,00-0000009,2,1,,2.1,FALSE,SLANT,ZONE,COVER_3',
    '2023_01_LA_SEA,2023091001,61,LA,SHOTGUN,"1 RB, 1 TE, 3 WR",6,"4 DL, 2 LB, 5 DB",4,x,00-0000001,00-0000009,1,1,,,,,,',
    '2023_01_LA_SEA,2023091001,70,SEA,,,,,,,,,0,0,,,,,,',
    '2023_01_LA_SEA,2023091001,80,LA,,,,,,x,00-0000001,00-0000009,1,1,,,,,,',
    '2023_01_LA_SEA,2023091001,90,LA,,,,,,x,00-0000001,00-0000009,1,1,,,,,,',
    '2023_01_LA_SEA,2023091001,85,LA,SHOTGUN,,,,,x,00-0000002,00-0000009,1,1,,,,,,',
    '2023_01_LA_SEA,2023091001,86,LA,,,,,,x,00-0000002,00-0000009,1,1,,,,,,',
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const noPbp = await ingestParticipationFile(2023, file).catch(e => e);
  assert.ok(noPbp instanceof Error && /load nflverse pbp for 2023 first/.test(noPbp.message),
    `participation without pbp is refused: ${noPbp?.message ?? noPbp}`);
  await seedPbp('2023_01_LA_SEA', 2023, 1, [
    { play_id: '40', play_type: 'pass' }, { play_id: '61', play_type: 'run' }, { play_id: '70', play_type: 'run' },
    { play_id: '80', play_type: 'punt' },
    { play_id: '90', play_type: 'kickoff' },
    { play_id: '85', play_type: 'no_play', penalty: '1' },
    { play_id: '86', play_type: 'qb_kneel' },
  ]);
  const out = await ingestParticipationFile(2023, file);
  assert.equal(out.rows_read, 7);
  assert.equal(out.skipped_kicking_plays, 1, 'the punt unit is not an offensive snap');
  assert.equal(out.skipped_untyped_no_formation, 1, 'the kickoff unit is not an offensive snap');
  assert.equal(out.plays_with_players, 4, 'pass, run, post-snap penalty, kneel');
  assert.equal(out.player_rows, 5);
  const stored = rows('SELECT * FROM nfl_play_participation_players ORDER BY play_id, gsis_id');
  assert.equal(stored.length, 5);
  assert.deepEqual([...new Set(stored.map(r => r.play_id))].sort((a, b) => a - b), [40, 61, 85, 86]);
  assert.equal(stored[0].team, 'LAR');
  assert.equal(stored[0].week, 1);
  assert.equal(stored[0].season, 2023);
  assert.equal(stored[0].was_route_runner, null, 'route runners are not published per play');
  await ingestParticipationFile(2023, file);
  assert.equal(row('SELECT COUNT(*) n FROM nfl_play_participation_players').n, 5, 're-run does not duplicate');

  // Two players with snaps in 2023 week 1: one appears in participation (60 snaps), one does not (40 snaps).
  run(`INSERT INTO players (id, name, position, gsis_id) VALUES (9001, 'Fixture One', 'WR', '00-0000001')`);
  run(`INSERT INTO players (id, name, position, gsis_id) VALUES (9002, 'Fixture Two', 'WR', '00-0000003')`);
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (9001, 2023, 1, 60, 0.9)');
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (9002, 2023, 1, 40, 0.6)');
  // Another season in the table, so the route's ?season= filter is observable.
  run(`INSERT INTO nfl_play_participation_players (game_id, play_id, season, week, gsis_id, team)
       VALUES ('2022_01_BUF_LA', 40, 2022, 1, '00-0000005', 'BUF')`);

  const app = express();
  const { default: router } = await import('../server/routes/nfl-betting.js');
  app.use('/api/nfl/betting', router);
  const res = await new Promise((resolve, reject) => {
    const req = new Readable({ read() { this.push(null); } });
    req.url = '/api/nfl/betting/formations/participation?season=2023'; req.method = 'GET'; req.headers = {};
    req.socket = new PassThrough(); req.connection = req.socket;
    const r = new ServerResponse(req); const chunks = [];
    r.write = c => { chunks.push(Buffer.from(c)); return true; };
    r.end = c => { if (c) chunks.push(Buffer.from(c));
      resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); };
    app.handle(req, r, reject);
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.seasons.map(x => x.season), [2023], 'the route passes ?season= through');
  const s = res.body.seasons.find(x => x.season === 2023);
  assert.equal(s.plays, 4);
  assert.equal(s.player_rows, 5);
  assert.equal(s.snap_match_share, 0.6, '60 of 100 offense snaps have a participation player-week');
  assert.equal(s.matched_play_ratio, +(2 / 60).toFixed(4), 'participation plays over PFR snaps on matched weeks');
  assert.match(res.body.attribution, /FTN Data via nflverse/);
});

test('with the committed licence the participation command loads and prints the credit', async () => {
  await seedPbp('2024_03_KC_ATL', 2024, 3, [{ play_id: '77', play_type: 'pass', posteam: 'KC', defteam: 'ATL' }]);
  const file = path.join(temp, 'pbp_participation_2024.csv');
  fs.writeFileSync(file, [PART_HEADER,
    '2024_03_KC_ATL,2024092200,77,KC,SHOTGUN,,,,,x,00-0000011;00-0000012,,2,0,,,,,,',
  ].join('\n') + '\n');
  const result = runScript('backfill-participation.mjs', ['2024', file], { GRIDIRON_DB_PATH: process.env.GRIDIRON_DB_PATH });
  assert.equal(result.status, 0, `exit ${result.status}; stderr: ${result.stderr}`);
  assert.match(result.stdout, /"player_rows": 2/);
  assert.match(result.stdout, /decision: nflverse_participation usable/);
  assert.equal(row(`SELECT COUNT(*) n FROM nfl_play_participation_players WHERE season=2024 AND week=3`).n, 2,
    'the week comes from the game id');
});
