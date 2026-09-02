import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The nfelo loader, run against real rows trimmed from the GitHub CSVs on
// 2026-09-02 (2024 Week 1, ARI @ BUF and the OAK-spelled Raiders game) so an
// upstream schema change fails here before it silently empties a table.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-nfelo-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const nfelo = await import('../server/services/nfelo.js');

const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

function mockFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    const body = u.includes('qb_elos') ? fixture('nfelo-qb-elos.csv')
      : u.includes('nfelo_games') ? fixture('nfelo-games.csv')
        : u.includes('historic_projected_spreads') ? fixture('nfelo-hps.csv')
          : u.includes('lines.csv') ? fixture('nfelo-lines.csv')
            : u.includes('stadiums.csv') ? fixture('nfelo-stadiums.csv')
              : null;
    if (body == null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  return () => { globalThis.fetch = real; };
}

test('the CSV parser keeps quoted commas inside one field', () => {
  const recs = nfelo.parseCsv('a,b,c\r\n1,"x, y",3\n4,"say ""hi""",6\n');
  assert.equal(recs.length, 2);
  assert.equal(recs[0].b, 'x, y');
  assert.equal(recs[1].b, 'say "hi"');
  assert.equal(recs[1].c, '6');
});

test('game ids parse as season_week_away_home with canonical codes', () => {
  assert.deepEqual(nfelo.parseGameId('2021_01_SF_DET'), { season: 2021, week: 1, away: 'SF', home: 'DET' });
  assert.deepEqual(nfelo.parseGameId('2024_01_OAK_LAC'), { season: 2024, week: 1, away: 'LV', home: 'LAC' });
  assert.equal(nfelo.parseGameId('not-a-game'), null);
});

test('a sync writes every table from the fixtures and reports counts per source', async () => {
  const restore = mockFetch();
  try {
    const out = await nfelo.syncNfelo();
    assert.equal(out.errors, undefined, JSON.stringify(out.errors));
    assert.equal(out.qb.rows, 6, 'six 2024 rows; the 2019 row is below sinceSeason');
    assert.equal(out.qb.skipped, 1);
    assert.equal(out.games.rows, 6);
    assert.equal(out.hps.merged, 6);
    assert.equal(out.hps.unmatched, 0);
    assert.equal(out.lines.rows, 6);
    assert.ok(out.stadiums.rows >= 6, JSON.stringify(out.stadiums));
    assert.equal(out.team_stadiums.rows, 7);
    assert.equal(row('SELECT COUNT(*) n FROM nfl_nfelo_qb').n, 6);
    assert.equal(row('SELECT COUNT(*) n FROM nfl_nfelo_games').n, 6);
    assert.equal(row('SELECT COUNT(*) n FROM nfl_nfelo_lines').n, 6);
    assert.equal(row('SELECT COUNT(*) n FROM nfl_team_stadiums').n, 7);
    assert.ok(row('SELECT COUNT(*) n FROM nfl_stadiums').n >= 6);
    assert.equal(row('SELECT COUNT(*) n FROM nfl_nfelo_games WHERE home_line_pre_regression IS NULL').n, 0, 'HPS merged into every game');
  } finally { restore(); }
});

test('team codes land canonical: OAK becomes LV in every table, the upstream game_id is kept verbatim', () => {
  const game = row(`SELECT * FROM nfl_nfelo_games WHERE game_id='2024_01_OAK_LAC'`);
  assert.ok(game, 'upstream game_id kept as the key');
  assert.equal(game.home, 'LAC');
  assert.equal(game.away, 'LV');
  assert.equal(row(`SELECT away FROM nfl_nfelo_lines WHERE game_id='2024_01_OAK_LAC'`).away, 'LV');
  const qb = row(`SELECT team1, team2 FROM nfl_nfelo_qb WHERE game_id='2024_01_OAK_LAC'`);
  assert.deepEqual([qb.team1, qb.team2], ['LAC', 'LV']);
  const codes = new Set(rows('SELECT home c FROM nfl_nfelo_games UNION SELECT away FROM nfl_nfelo_games UNION SELECT team1 FROM nfl_nfelo_qb UNION SELECT team2 FROM nfl_nfelo_qb UNION SELECT team FROM nfl_team_stadiums').map(r => r.c));
  assert.ok(!codes.has('OAK') && !codes.has('LA') && !codes.has('WSH') && !codes.has('JAC'), [...codes].join(','));
  const raiders = rows(`SELECT stadium_id, is_current FROM nfl_team_stadiums WHERE team='LV' ORDER BY is_current DESC`)
    .map(r => ({ stadium_id: r.stadium_id, is_current: r.is_current }));
  assert.deepEqual(raiders, [{ stadium_id: 'VEG00', is_current: 1 }, { stadium_id: 'OAK00', is_current: 0 }]);
});

test('stadium rows carry coordinates, roof and time zone, and a quoted address does not shift columns', () => {
  const atl = row(`SELECT * FROM nfl_stadiums WHERE stadium_id='ATL97'`);
  assert.equal(atl.name, 'Mercedes-Benz Stadium');
  assert.ok(Math.abs(atl.lat - 33.7555) < 0.001 && Math.abs(atl.lon + 84.4008) < 0.001);
  assert.equal(atl.tz, 'America/New_York');
  assert.equal(atl.city, 'Atlanta');
  assert.equal(atl.roof_type, 'Outdoors');
  const buf = row(`SELECT * FROM nfl_stadiums WHERE stadium_id='BUF00'`);
  assert.ok(buf.altitude > 200 && buf.altitude < 230);
});

test('nfeloFeatures joins the three tables for the fixture game with home-minus-away signs', () => {
  const f = nfelo.nfeloFeatures(2024, 1, 'BUF', 'ARI');
  const close = (actual, expected, tol = 1e-6) => assert.ok(actual != null && Math.abs(actual - expected) < tol, `${actual} vs ${expected}`);
  // nfelo_games: home_538_qb_adj 6.1449, away 17.5597 -> the away QB is better, so the diff is negative.
  close(f.qb_adj_diff, 6.1449 - 17.5597);
  // qb_elos: team1 BUF elo1_pre 1631.033, team2 ARI elo2_pre 1409.326.
  close(f.elo_diff, 1631.0332497332722 - 1409.3260089396226);
  close(f.qbelo_diff, 1637.178197264687 - 1426.885720299442);
  close(f.nfelo_diff, 1605.4638 - 1431.9538);
  close(f.nfelo_pre_line, -12.0);
  close(f.nfelo_line_open, -8.0);
  close(f.hfa_mod, 79.95);
  close(f.tickets_pct_home, 0.35);
  close(f.money_pct_home, 0.41);
  // lines.csv publishes no total split; that must read as absent, not as 0.
  assert.equal(f.tickets_pct_total_over, null);
  assert.equal(f.money_pct_total_over, null);
});

test('nfeloFeatures accepts legacy spellings and the reversed orientation of the qb table', () => {
  const canonical = nfelo.nfeloFeatures(2024, 1, 'LAC', 'LV');
  const legacy = nfelo.nfeloFeatures(2024, 1, 'LAC', 'OAK');
  assert.deepEqual(legacy, canonical);
  assert.ok(canonical.elo_diff != null && canonical.elo_diff < 0, 'LAC (1460) minus the Raiders (1534) is negative');
  // Asking from the away side of the same game flips every diff and finds no games/lines row.
  const flipped = nfelo.nfeloFeatures(2024, 1, 'LV', 'LAC');
  assert.ok(Math.abs(flipped.elo_diff + canonical.elo_diff) < 1e-9);
  assert.equal(flipped.hfa_mod, null);
});

test('a game nobody has rows for returns nulls, never zeros', () => {
  const f = nfelo.nfeloFeatures(2024, 9, 'GB', 'DET');
  assert.deepEqual(f, {
    qb_adj_diff: null, elo_diff: null, qbelo_diff: null, nfelo_diff: null, nfelo_pre_line: null, nfelo_line_open: null,
    hfa_mod: null, tickets_pct_home: null, money_pct_home: null, tickets_pct_total_over: null, money_pct_total_over: null
  });
  assert.ok(Object.values(f).every(v => v === null));
});

test('a failing source is reported without blocking the others, and a re-sync is idempotent', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('lines.csv')) return { ok: false, status: 503, text: async () => '' };
    const body = u.includes('qb_elos') ? fixture('nfelo-qb-elos.csv')
      : u.includes('nfelo_games') ? fixture('nfelo-games.csv')
        : u.includes('historic_projected_spreads') ? fixture('nfelo-hps.csv')
          : fixture('nfelo-stadiums.csv');
    return { ok: true, status: 200, text: async () => body };
  };
  try {
    const out = await nfelo.syncNfelo();
    assert.match(out.errors.lines, /503/);
    assert.equal(out.games.rows, 6);
    assert.equal(row('SELECT COUNT(*) n FROM nfl_nfelo_games').n, 6, 'no duplicate rows after a second sync');
    assert.equal(row('SELECT COUNT(*) n FROM nfl_nfelo_qb').n, 6);
    assert.equal(row('SELECT COUNT(*) n FROM nfl_nfelo_lines').n, 6, 'the failed source keeps its previous rows');
  } finally { globalThis.fetch = real; }
  const status = nfelo.nfeloStatus();
  assert.equal(status.rows.nfl_nfelo_games, 6);
  assert.deepEqual(status.seasons, [2024, 2024]);
  assert.equal(status.latest_game.season, 2024);
  assert.equal(status.ticket_split_rows, 5, 'BAL @ KC (the Thursday opener) has no public split upstream');
});
