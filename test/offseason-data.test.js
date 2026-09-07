import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';

// The offseason feature builder, exercised end to end against a synthetic
// league: 32 teams, 8 skill players each, two seasons of everything. Real
// nflverse column names throughout, so an upstream rename breaks this test
// rather than silently emptying a column in production.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offseason-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, rows, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// Tables the feature builder reads that live in other services' files. Created
// with the production shape so the queries under test are the real queries.
db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_injuries (
    season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, full_name TEXT,
    position TEXT, report_status TEXT, practice_status TEXT, injury TEXT, modified_at TEXT,
    PRIMARY KEY (season, week, gsis_id));
  CREATE TABLE IF NOT EXISTS nfl_depth (
    season INTEGER, week INTEGER, team TEXT, gsis_id TEXT, player_name TEXT,
    pos_abb TEXT, pos_rank INTEGER, pos_slot TEXT, captured TEXT,
    PRIMARY KEY (season, week, team, gsis_id, pos_abb));
  CREATE TABLE IF NOT EXISTS nfl_ffopportunity_weekly (
    season INTEGER NOT NULL, week INTEGER NOT NULL, player_gsis_id TEXT NOT NULL,
    player_name TEXT, team TEXT, position TEXT,
    expected_fantasy_points REAL, actual_fantasy_points REAL,
    expected_pass_points REAL, expected_receive_points REAL, expected_rush_points REAL,
    expected_total_yards REAL, expected_touchdowns REAL,
    source_release TEXT NOT NULL, ingested_at TEXT NOT NULL,
    PRIMARY KEY (season, week, player_gsis_id));
  CREATE TABLE IF NOT EXISTS game_lines (
    season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
    opponent TEXT, home INTEGER, spread REAL, total REAL, implied_points REAL,
    source TEXT, fetched_at TEXT, team_score INTEGER, opp_score INTEGER,
    PRIMARY KEY (season, week, team));
`);

// Imported before the seeds run: player_week_usage, player_week_snaps and the
// nflverse position table are created at import time by nflverse.js, which
// offseason-data.js pulls in for the shared CSV parser.
const offseason = await import('../server/services/offseason-data.js');
const { parseCsv } = await import('../server/services/nflverse.js');

/* ------------------------------------------------------------- fixture data */

const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN',
  'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LA', 'LAC', 'LV', 'MIA', 'MIN', 'NE',
  'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SF', 'SEA', 'TB', 'TEN', 'WAS'];
const SLOTS = [['QB', 1], ['RB', 1], ['RB', 2], ['WR', 1], ['WR', 2], ['WR', 3], ['TE', 1], ['TE', 2]];

/** Deterministic synthetic universe: 256 players, stable ids across seasons. */
const PLAYERS = TEAMS.flatMap((team, ti) => SLOTS.map(([pos, rank], si) => {
  const n = ti * 8 + si;
  return {
    gsis_id: `00-99${String(n).padStart(5, '0')}`,
    espn_id: 900000 + n,
    pfr_id: `Pfr${String(n).padStart(4, '0')}`,
    sleeper_id: String(70000 + n),
    name: `${pos} ${team} ${rank}`,
    position: pos, rank, team,
    // One player per team switches to the next team in 2026 — enough movement
    // for team_change and the vacated-share maths to have something to measure.
    team2026: si === 3 ? TEAMS[(ti + 1) % TEAMS.length] : team,
    birth_date: `${1996 + (n % 6)}-05-1${n % 9}`,
    draft_round: 1 + (n % 7), draft_pick: 1 + n, entry_year: 2018 + (n % 5)
  };
}));

const csv = (header, records) => [header.join(','), ...records.map(r => r.join(','))].join('\n') + '\n';

function rosterCsv(season) {
  const header = ['season', 'team', 'position', 'depth_chart_position', 'jersey_number', 'status',
    'full_name', 'birth_date', 'height', 'weight', 'college', 'gsis_id', 'espn_id', 'pfr_id',
    'sleeper_id', 'years_exp', 'entry_year', 'rookie_year', 'draft_club', 'draft_number'];
  return csv(header, PLAYERS.map(p => [season, season >= 2026 ? p.team2026 : p.team, p.position,
    p.position, 10, 'ACT', p.name, p.birth_date, 72, 210, 'Test U', p.gsis_id, p.espn_id,
    p.pfr_id, p.sleeper_id, season - p.entry_year, p.entry_year, p.entry_year, p.team, p.draft_pick]));
}

function draftPicksCsv() {
  // Two rounds per team per season so capital_added_at_position has something
  // real to count: a first-round WR and a third-round RB for every club.
  const header = ['season', 'round', 'pick', 'team', 'gsis_id', 'pfr_player_id',
    'pfr_player_name', 'position', 'side', 'college', 'age'];
  const recs = [];
  for (const season of [2025, 2026]) {
    TEAMS.forEach((team, i) => {
      recs.push([season, 1, i + 1, team, '', '', `Rookie WR ${team}`, 'WR', 'O', 'Test U', 22]);
      recs.push([season, 3, 65 + i, team, '', '', `Rookie RB ${team}`, 'RB', 'O', 'Test U', 22]);
    });
  }
  return csv(header, recs);
}

function contractsCsv() {
  const header = ['player', 'position', 'team', 'is_active', 'year_signed', 'years', 'value',
    'apy', 'guaranteed', 'apy_cap_pct', 'player_page', 'otc_id', 'date_of_birth', 'height',
    'weight', 'college', 'draft_year', 'draft_round', 'draft_overall', 'draft_team', 'season_history'];
  return csv(header, PLAYERS.map((p, i) => [p.name, p.position, 'Bengals', 'TRUE', 2024, 4,
    40000000, 10000000 - i * 10000, 20000000, 0.05, '', `otc${i}`, p.birth_date, 72, 210,
    'Test U', p.entry_year, p.draft_round, p.draft_pick, 'Bengals', '']));
}

function depthChartCsv(season) {
  // The post-2024 ESPN format, including a pre-August snapshot that the ingest
  // must ignore in favour of the opening-week one.
  const header = ['dt', 'team', 'player_name', 'espn_id', 'gsis_id', 'pos_grp_id', 'pos_grp',
    'pos_id', 'pos_name', 'pos_abb', 'pos_slot', 'pos_rank'];
  const recs = [];
  for (const [dt, bump] of [[`${season}-03-15T00:00:00Z`, 3], [`${season}-08-05T00:00:00Z`, 0]]) {
    for (const p of PLAYERS) {
      recs.push([dt, season >= 2026 ? p.team2026 : p.team, p.name, p.espn_id, p.gsis_id,
        1, 'Offense', 1, p.position, p.position, 1, p.rank + bump]);
    }
  }
  return csv(header, recs);
}

function ngsCsv(kind) {
  const header = ['season', 'season_type', 'week', 'player_display_name', 'player_position',
    'team_abbr', 'avg_cushion', 'avg_separation', 'avg_intended_air_yards',
    'percent_share_of_intended_air_yards', 'avg_yac_above_expectation', 'catch_percentage',
    'efficiency', 'rush_yards_over_expected_per_att', 'percent_attempts_gte_eight_defenders',
    'avg_time_to_los', 'avg_time_to_throw', 'aggressiveness',
    'completion_percentage_above_expectation', 'player_gsis_id'];
  const recs = [];
  for (const season of [2024, 2025]) {
    for (const p of PLAYERS) {
      // week 1 rows must be ignored; only the week 0 season total is kept.
      for (const week of [0, 1]) {
        recs.push([season, 'REG', week, p.name, p.position, p.team, 5.5, 2.9, 9.1, 12.5,
          0.4, 65, 4.2, 0.35, 22.5, 2.8, 2.7, 15.1, 1.2, p.gsis_id]);
      }
    }
  }
  return csv(header, recs.filter(r => kind !== 'passing' || r[4] === 'QB'));
}

function pfrCsv(kind) {
  const base = ['season', 'player', 'pfr_id', 'tm', 'age', 'pos', 'g', 'gs'];
  const extra = kind === 'rec' ? ['adot', 'yac_r', 'ybc_r', 'brk_tkl', 'drop_percent']
    : kind === 'rush' ? ['ybc_att', 'yac_att', 'brk_tkl']
      : ['pressure_pct', 'on_tgt_pct', 'pocket_time', 'pa_pass_att'];
  const recs = [];
  for (const season of [2024, 2025]) {
    for (const p of PLAYERS) {
      recs.push([season, p.name, p.pfr_id, p.team, 26, p.position, 17, 15,
        ...extra.map((_, i) => 1.5 + i)]);
    }
  }
  return csv([...base, ...extra], recs);
}

function qbrCsv() {
  const header = ['season', 'season_type', 'game_week', 'team_abb', 'player_id', 'name_short',
    'rank', 'qbr_total', 'pts_added', 'qb_plays', 'epa_total', 'qbr_raw', 'sack',
    'name_display', 'qualified'];
  const recs = [];
  for (const season of [2024, 2025]) {
    PLAYERS.filter(p => p.position === 'QB').forEach((p, i) => {
      recs.push([season, 'Regular', 'Season Total', p.team, p.espn_id, p.name, i + 1,
        40 + i, 20, 600, 50, 45, -5, p.name, 'TRUE']);
    });
  }
  return csv(header, recs);
}

function gamesCsv() {
  const header = ['game_id', 'season', 'game_type', 'week', 'gameday', 'weekday', 'away_team',
    'away_score', 'home_team', 'home_score', 'location', 'away_rest', 'home_rest',
    'spread_line', 'total_line', 'div_game', 'roof', 'surface', 'stadium_id',
    'away_coach', 'home_coach', 'away_qb_id', 'home_qb_id'];
  const recs = [];
  for (const season of [2024, 2025, 2026]) {
    for (let week = 1; week <= 18; week++) {
      // Four teams sit each week from week 5 through week 12: 32 teams, one bye each.
      const onBye = week >= 5 && week <= 12 ? TEAMS.slice((week - 5) * 4, (week - 5) * 4 + 4) : [];
      const playing = TEAMS.filter(t => !onBye.includes(t));
      for (let i = 0; i < playing.length; i += 2) {
        const away = playing[i], home = playing[i + 1];
        recs.push([`${season}_${week}_${away}_${home}`, season, 'REG', week,
          `${season}-09-0${(week % 9) + 1}`, 'Sunday', away, '', home, '', 'Home', 7, 7,
          2.5, 44 + (i % 5), i % 4 === 0 ? 1 : 0, i % 3 === 0 ? 'dome' : 'outdoors',
          'grass', `${home}00`, `Coach ${away}`, `Coach ${home}`, '', '']);
      }
    }
  }
  return csv(header, recs);
}

function teamStatsCsv(season) {
  const header = ['season', 'team', 'season_type', 'games', 'completions', 'attempts',
    'passing_yards', 'passing_tds', 'sacks_suffered', 'passing_epa', 'passing_air_yards',
    'carries', 'rushing_yards', 'rushing_tds', 'rushing_epa', 'targets',
    'passing_first_downs', 'rushing_first_downs'];
  return csv(header, TEAMS.map((t, i) => [season, t, 'REG', 17, 380, 580 + i, 4100, 28,
    40, 25.5, 4300, 430 - i, 1900, 14, -5.5, 580 + i, 210, 100]));
}

function sleeperJson() {
  const out = {};
  for (const p of PLAYERS) {
    out[p.sleeper_id] = {
      sport: 'nfl', full_name: p.name, position: p.position, team: p.team2026,
      status: 'Active', injury_status: p.rank === 3 ? 'Questionable' : null,
      depth_chart_position: p.position, depth_chart_order: p.rank,
      years_exp: 4, espn_id: p.espn_id, gsis_id: null
    };
  }
  return out;
}

/* ------------------------------------------------------ existing-table seeds */

function seedExistingTables() {
  db.exec('BEGIN');
  const insPlayer = db.prepare(`INSERT INTO players (name, position, phase, fantasy_relevant, espn_id, gsis_id)
                                VALUES (?,?,'offense',1,?,?)`);
  const insUsage = db.prepare(`INSERT INTO player_week_usage
    (player_id, season, week, team, position, targets, carries, attempts, receptions,
     target_share, air_yards_share, wopr, receiving_air_yards, receiving_yards, receiving_tds,
     rushing_yards, rushing_tds, passing_yards, passing_tds, interceptions, fumbles_lost,
     receiving_epa, rushing_epa, passing_epa) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insSnaps = db.prepare(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
                               VALUES (?,?,?,?,?)`);
  const insInj = db.prepare(`INSERT INTO nfl_injuries (season, week, gsis_id, team, report_status)
                             VALUES (?,?,?,?,?)`);
  const insDepth = db.prepare(`INSERT INTO nfl_depth (season, week, team, gsis_id, pos_abb, pos_rank)
                               VALUES (?,?,?,?,?,?)`);
  const insXfp = db.prepare(`INSERT INTO nfl_ffopportunity_weekly
    (season, week, player_gsis_id, team, position, expected_fantasy_points, actual_fantasy_points,
     source_release, ingested_at) VALUES (?,?,?,?,?,?,?,'test','now')`);
  const insLine = db.prepare(`INSERT INTO game_lines (season, week, team, team_score) VALUES (?,?,?,?)`);

  for (const p of PLAYERS) {
    const id = Number(insPlayer.run(p.name, p.position, p.espn_id, p.gsis_id).lastInsertRowid);
    p.player_id = id;
    for (let week = 1; week <= 17; week++) {
      const rec = p.position === 'WR' || p.position === 'TE';
      insUsage.run(id, 2025, week, p.team, p.position,
        rec ? 8 : 0, p.position === 'RB' ? 12 : 0, p.position === 'QB' ? 32 : 0, rec ? 5 : 0,
        rec ? 0.22 : 0, rec ? 0.25 : 0, rec ? 0.6 : 0, rec ? 90 : 0, rec ? 65 : 0, rec ? 0.4 : 0,
        p.position === 'RB' ? 55 : 0, p.position === 'RB' ? 0.3 : 0,
        p.position === 'QB' ? 250 : 0, p.position === 'QB' ? 1.5 : 0, p.position === 'QB' ? 0.6 : 0,
        0, 1.2, 0.4, 2.1);
      insSnaps.run(id, 2025, week, 50, 0.75);
      insDepth.run(2025, week, p.team, p.gsis_id, p.position, p.rank);
    }
    for (let week = 1; week <= 4; week++) {
      insInj.run(2025, week, p.gsis_id, p.team, p.rank === 2 ? 'Out' : 'Questionable');
      insXfp.run(2025, week, p.gsis_id, p.team, p.position, 12.5, 13.9);
    }
  }
  for (const t of TEAMS) for (let week = 1; week <= 17; week++) insLine.run(2025, week, t, 24);
  db.exec('COMMIT');
}
seedExistingTables();

/* ----------------------------------------------------------------- fetch mock */

const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async url => {
  const u = String(url);
  const ok = body => ({
    ok: true, status: 200,
    text: async () => body,
    json: async () => body,
    arrayBuffer: async () => gzipSync(Buffer.from(body, 'utf8'))
  });
  const m = u.match(/roster_(\d{4})\.csv/);
  if (m) return ok(rosterCsv(Number(m[1])));
  const d = u.match(/depth_charts_(\d{4})\.csv/);
  if (d) return ok(depthChartCsv(Number(d[1])));
  const ts = u.match(/stats_team_reg_(\d{4})\.csv/);
  if (ts) return ok(teamStatsCsv(Number(ts[1])));
  const ngs = u.match(/ngs_(receiving|rushing|passing)\.csv\.gz/);
  if (ngs) return ok(ngsCsv(ngs[1]));
  const pfr = u.match(/advstats_season_(rec|rush|pass)\.csv/);
  if (pfr) return ok(pfrCsv(pfr[1]));
  if (u.includes('draft_picks.csv')) return ok(draftPicksCsv());
  if (u.includes('historical_contracts.csv.gz')) return ok(contractsCsv());
  if (u.includes('qbr_season_level.csv')) return ok(qbrCsv());
  if (u.includes('schedules/games.csv')) return ok(gamesCsv());
  if (u.includes('api.sleeper.app')) return ok(sleeperJson());
  return { ok: false, status: 404, text: async () => '' };
};

test.after(() => {
  globalThis.fetch = REAL_FETCH;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/* ------------------------------------------------------------- parser tests */

test('shared CSV parser handles the quoting nflverse actually emits', () => {
  // A quoted field containing a comma: the headshot URLs that motivated the
  // parser in the first place, and OTC's height values ("6'2""").
  const { header, records } = parseCsv(
    'a,b,c\n1,"two, and a half",3\n4,"say ""hi""",6\n');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.equal(records.length, 2);
  assert.equal(records[0][1], 'two, and a half');
  assert.equal(records[1][1], 'say "hi"');
});

test('shared CSV parser survives CRLF, a missing trailing newline and ragged rows', () => {
  const { header, records } = parseCsv('a,b\r\n1,2\r\n3\r\n4,5');
  assert.deepEqual(header, ['a', 'b']);
  // The short row is dropped rather than shifting every later column.
  assert.deepEqual(records, [['1', '2'], ['4', '5']]);
});

test('shared CSV parser keeps embedded newlines inside quotes', () => {
  const { records } = parseCsv('a,b\n1,"line one\nline two"\n');
  assert.equal(records.length, 1);
  assert.equal(records[0][1], 'line one\nline two');
});

test('empty input does not throw', () => {
  assert.deepEqual(parseCsv(''), { header: [], records: [] });
});

/* ------------------------------------------------------------ formula tests */

test('pprPoints scores a receiving line the way PPR does', () => {
  assert.equal(offseason.pprPoints({ receiving_yards: 100, receiving_tds: 1, receptions: 8 }), 24);
  // A fumble is -2 and an interception is -2, both subtracted.
  assert.equal(offseason.pprPoints({ rushing_yards: 50, fumbles_lost: 1 }), 3);
  assert.equal(offseason.pprPoints({ passing_yards: 300, passing_tds: 2, interceptions: 1 }), 18);
  assert.equal(offseason.pprPoints({}), 0);
});

test('impliedPoints splits the total by the spread, favourite high', () => {
  // spread_line is the HOME spread, positive when the home team is favoured.
  assert.deepEqual(offseason.impliedPoints({ total_line: 44, spread_line: 4 }), { home: 24, away: 20 });
  assert.deepEqual(offseason.impliedPoints({ total_line: 44, spread_line: -4 }), { home: 20, away: 24 });
  assert.deepEqual(offseason.impliedPoints({ total_line: null, spread_line: 4 }), { home: null, away: null });
});

test('OverTheCap nicknames map onto nflverse abbreviations', () => {
  assert.equal(offseason.nicknameToAbbr('Packers'), 'GB');
  assert.equal(offseason.nicknameToAbbr('49ers'), 'SF');
  assert.equal(offseason.nicknameToAbbr('Washington Football Team'), 'WAS');
  assert.equal(offseason.nicknameToAbbr('Not A Team'), null);
  assert.equal(offseason.nicknameToAbbr(null), null);
});

test('relocated franchises fold onto their current code', () => {
  assert.equal(offseason.normTeam('OAK'), 'LV');
  assert.equal(offseason.normTeam('SD'), 'LAC');
  assert.equal(offseason.normTeam('STL'), 'LA');
  assert.equal(offseason.normTeam('KC'), 'KC');
});

test('vacatedShares divides departed opportunity by the team total', () => {
  // Two receivers, 60/40 of the targets; the 60 leaves.
  const priorAgg = {
    byPlayer: new Map([
      ['g1', { gsis_id: 'g1', team: 'BUF', targets: 60, carries: 0 }],
      ['g2', { gsis_id: 'g2', team: 'BUF', targets: 40, carries: 0 }]
    ])
  };
  db.exec("DELETE FROM off_rosters WHERE season = 2099");
  db.exec(`INSERT INTO off_rosters (season, gsis_id, team) VALUES (2099,'g2','BUF')`);
  const out = offseason.vacatedShares(2099, priorAgg);
  assert.equal(out.get('BUF').vacated_target_share, 0.6);
  // A player with no roster row at all counts as departed, not as unknown.
  db.exec("DELETE FROM off_rosters WHERE season = 2099");
  assert.equal(offseason.vacatedShares(2099, priorAgg).get('BUF').vacated_target_share, 1);
});

/* ------------------------------------------------------------- end-to-end */

test('full sync builds a feature row for every synthetic skill player', async () => {
  const result = await offseason.syncOffseasonData({ seasons: [2025, 2026] });
  assert.deepEqual(result.failures, [], 'no dataset should fail against the mock');
  offseason.clearOffseasonCache();

  const features = offseason.offseasonFeatures(2026);
  assert.ok(features.size > 150, `expected >150 players, got ${features.size}`);

  // Every documented column exists on a real row.
  const sample = features.values().next().value;
  for (const col of offseason.featureColumns()) {
    assert.ok(col in sample, `feature row is missing column ${col}`);
  }

  // Lookup works by players.id and by gsis_id, and returns the same row.
  const wr = PLAYERS.find(p => p.name === 'WR ARI 1');
  const byId = offseason.offseasonFeatureRow(wr.player_id, 2026);
  const byGsis = offseason.offseasonFeatureRow(wr.gsis_id, 2026);
  assert.equal(byId?.gsis_id, wr.gsis_id);
  assert.equal(byGsis?.player_id, wr.player_id);
  assert.equal(offseason.offseasonFeatureRow(-1, 2026), null);
});

test('feature values are the ones the formulas imply', () => {
  const wr = PLAYERS.find(p => p.name === 'WR ARI 3');    // stays on ARI in 2026
  const mover = PLAYERS.find(p => p.name === 'WR ARI 1'); // the seeded team change
  const f = offseason.offseasonFeatureRow(wr.gsis_id, 2026);
  const m = offseason.offseasonFeatureRow(mover.gsis_id, 2026);

  assert.equal(f.season, 2026);
  assert.equal(f.team, 'ARI');
  assert.equal(f.prior_team, 'ARI');
  assert.equal(f.team_change, 0);
  assert.equal(m.team_change, 1, 'the seeded mover must register as a team change');
  assert.equal(m.team, 'ATL');

  // 17 weeks of 65 receiving yards, 0.4 TDs and 5 catches.
  assert.ok(Math.abs(f.prior_ppg - (6.5 + 2.4 + 5)) < 1e-9);
  assert.equal(f.prior_games, 17);
  assert.ok(Math.abs(f.prior_target_share - 0.22) < 1e-9);
  assert.ok(Math.abs(f.prior_snap_share - 0.75) < 1e-9);

  // xFP: 13.9 actual against 12.5 expected over 4 charted weeks.
  assert.ok(Math.abs(f.prior_xfp_per_game - 12.5) < 1e-9);
  assert.ok(Math.abs(f.prior_xfp_diff - 1.4) < 1e-9);

  // Every team drafted one first-round WR, so a WR's added capital is 1 and the
  // third-round RB is not counted against him.
  assert.equal(f.capital_added_at_position, 1);
  assert.equal(offseason.offseasonFeatureRow(
    PLAYERS.find(p => p.name === 'RB ARI 1').gsis_id, 2026).capital_added_at_position, 1);

  // Opening depth chart: the August snapshot (rank as seeded), not March's +3.
  assert.equal(f.depth_slot_t, wr.rank);
  assert.equal(f.depth_slot_prior_end, wr.rank);
  assert.equal(f.depth_slot_delta, 0);

  // Sleeper's live snapshot lands on the current season only.
  assert.equal(f.sleeper_depth_chart_order, wr.rank);
  assert.equal(f.sleeper_injury_status, 'Questionable');
  assert.equal(offseason.offseasonFeatureRow(wr.gsis_id, 2025).sleeper_depth_chart_order, null);

  // Contract signed 2024 for 4 years: covers 2026, is not a new deal, and 2027
  // is the final year, so 2026 is not the contract year either.
  assert.equal(f.new_contract, 0);
  assert.equal(f.contract_year, 0);
  assert.equal(f.contract_years_remaining, 2);
  assert.ok(f.apy > 0);
  assert.ok(f.apy_rank_on_team_at_position >= 1);

  // Team context. Every game is priced at spread_line 2.5, so the home side is
  // implied 1.25 above half the total and the away side 1.25 below.
  assert.ok(f.implied_team_points > 15 && f.implied_team_points < 30);
  assert.ok(f.bye_week >= 5 && f.bye_week <= 12);
  assert.equal(f.hc_change, 0, 'the same coach name is seeded in both seasons');
  assert.ok(f.division_sos_proxy > 0);

  // Prior-season availability: rank-2 players are seeded Out for four weeks.
  const out = offseason.offseasonFeatureRow(
    PLAYERS.find(p => p.name === 'WR ARI 2').gsis_id, 2026);
  assert.equal(out.injury_games_missed_prior, 4);
  assert.equal(out.ir_stints_prior, 1, 'four consecutive Out weeks is one stint');
  assert.equal(f.injury_games_missed_prior, 0);

  // Biography.
  assert.ok(f.age_at_season > 25 && f.age_at_season < 35);
  assert.equal(f.rookie, 0);
  assert.equal(f.draft_pick, wr.draft_pick);
});

test('a rerun changes no row count and no value (idempotent)', () => {
  const before = rows('SELECT * FROM off_player_season_features WHERE season = 2026 ORDER BY gsis_id');
  offseason.computeFeatures(2026);
  const after = rows('SELECT * FROM off_player_season_features WHERE season = 2026 ORDER BY gsis_id');
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    for (const k of Object.keys(before[i])) {
      if (k === 'computed_at') continue;       // a timestamp is expected to move
      assert.deepEqual(after[i][k], before[i][k], `${before[i].gsis_id}.${k} changed on rerun`);
    }
  }
});

test('the sync writes nothing outside off_* tables', () => {
  // The seeds are the only rows these tables should ever hold.
  assert.equal(row('SELECT COUNT(*) n FROM players').n, PLAYERS.length);
  assert.equal(row('SELECT COUNT(*) n FROM player_week_usage').n, PLAYERS.length * 17);
  assert.equal(row('SELECT COUNT(*) n FROM nfl_depth').n, PLAYERS.length * 17);
  assert.equal(row('SELECT COUNT(*) n FROM nfl_injuries').n, PLAYERS.length * 4);
});

test('offseasonDataStatus reports every off_ table', () => {
  const status = offseason.offseasonDataStatus();
  assert.ok(status.off_player_season_features > 150);
  assert.ok(status.off_rosters > 0);
  assert.ok(status.off_schedule_games > 0);
  assert.ok(status.features_by_season.some(r => r.season === 2026));
});
