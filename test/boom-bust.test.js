import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-boom-bust-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
// Side-effect import: player_week_usage / nflverse_player_positions are
// created ad-hoc at import time by nflverse.js (same "~40 files create
// tables on import" pattern the rest of the suite relies on).
await import('../server/services/nflverse.js');
const { classify, buildBoomBustDataset, boomBustWalkForward } = await import('../server/services/boom-bust.js');

db.exec(`CREATE TABLE IF NOT EXISTS nfl_historical_adp (
  season INTEGER NOT NULL, source TEXT NOT NULL, player_key TEXT NOT NULL,
  name TEXT NOT NULL, position TEXT, team TEXT, ecr_rank REAL NOT NULL,
  ecr_std_dev REAL, scrape_date TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, source, player_key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS nfl_injuries (
  season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, full_name TEXT,
  position TEXT, report_status TEXT, practice_status TEXT, injury TEXT, modified_at TEXT,
  PRIMARY KEY (season, week, gsis_id)
)`);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

let gsisCounter = 0;
function player(name, position, { gsisId } = {}) {
  const gsis = gsisId ?? `test-gsis-${++gsisCounter}`;
  run('INSERT INTO players (name, position, fantasy_relevant, gsis_id) VALUES (?,?,1,?)', name, position, gsis);
  return gsis;
}
function playerId(name) {
  return row('SELECT id FROM players WHERE name = ?', name).id;
}
function bio(gsisId, { birthDate = null, rookieSeason = null } = {}) {
  run(`INSERT INTO nflverse_player_positions (gsis_id, birth_date, rookie_season) VALUES (?,?,?)
       ON CONFLICT(gsis_id) DO UPDATE SET birth_date=excluded.birth_date, rookie_season=excluded.rookie_season`,
    gsisId, birthDate, rookieSeason);
}
function adp(season, name, position, team, rank) {
  run(`INSERT INTO nfl_historical_adp (season, source, player_key, name, position, team, ecr_rank, scrape_date, fetched_at)
       VALUES (?,'test',?,?,?,?,?,'2000-01-01','2000-01-01')`,
    season, name.toLowerCase(), name, position, team, rank);
}
function usage(season, week, name, opts = {}) {
  const id = playerId(name);
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, receptions, receiving_yards, receiving_tds, targets)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    id, season, week, opts.team ?? 'FA', opts.position ?? 'WR', opts.receptions ?? 0, opts.receiving_yards ?? 0,
    opts.receiving_tds ?? 0, opts.targets ?? 0);
}
function injuryWeek(season, week, name, status = 'Questionable') {
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, full_name, report_status) VALUES (?,?,?,?,?)`,
    season, week, `inj-${name}`, name, status);
}

player('Elite Star', 'WR');
player('Injury Bust', 'WR');
player('Waiver Boom', 'WR');
player('Steady Eddie', 'WR');
// classify()'s boom/bust thresholds (rank_gap beyond +-15) are calibrated for
// a realistic full-league population (500+ players) — with only 4 real
// players the rank spread can never exceed 3, so 40 mediocre filler players
// are seeded purely to give "Waiver Boom"/"Injury Bust" real room to move
// more than 15 spots, the same way a real season's full player pool would.
for (let i = 0; i < 40; i++) player(`Filler Player ${i}`, 'WR');

test('a top-ADP player who actually produces is graded "as expected", not a boom or bust', async () => {
  adp(2022, 'Elite Star', 'WR', 'KC', 1);
  adp(2022, 'Injury Bust', 'WR', 'DAL', 2);
  adp(2022, 'Waiver Boom', 'WR', 'NYJ', 40);
  adp(2022, 'Steady Eddie', 'WR', 'MIA', 20);
  for (let i = 0; i < 40; i++) adp(2022, `Filler Player ${i}`, 'WR', 'FA', 50 + i);

  for (let w = 1; w <= 10; w++) {
    usage(2022, w, 'Elite Star', { receptions: 8, receiving_yards: 100, receiving_tds: 1, targets: 10 });
    usage(2022, w, 'Steady Eddie', { receptions: 5, receiving_yards: 60, targets: 7 });
    usage(2022, w, 'Waiver Boom', { receptions: 9, receiving_yards: 110, receiving_tds: 1, targets: 11 });
    if (w <= 2) usage(2022, w, 'Injury Bust', { receptions: 1, receiving_yards: 5, targets: 2 }); // hurt, barely plays
    for (let i = 0; i < 40; i++) usage(2022, w, `Filler Player ${i}`, { receptions: 4, receiving_yards: 40, targets: 5 });
  }

  const rows = await classify(2022);
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));

  assert.ok(byName['Waiver Boom'].rank_gap > 15, 'a #40 ADP player who outproduces the #1 must show a clear boom');
  assert.equal(byName['Waiver Boom'].label, 'boom');
  assert.ok(byName['Injury Bust'].rank_gap < -15, 'a #2 ADP player who barely plays must show a clear bust');
  assert.equal(byName['Injury Bust'].label, 'bust');
  assert.equal(byName['Elite Star'].label, 'as expected', 'the #1 pick actually playing like the #1 pick must not be flagged either way');
});

test('the feature vector carries real age, real rookie flag, and real injury-report weeks — not proxies', async () => {
  const gsis = player('Bio Test Player', 'WR');
  bio(gsis, { birthDate: '2000-03-15', rookieSeason: 2023 });
  adp(2023, 'Bio Test Player', 'WR', 'SF', 30);
  for (let w = 1; w <= 5; w++) usage(2023, w, 'Bio Test Player', { team: 'SF', receptions: 4, receiving_yards: 40, targets: 5 });
  injuryWeek(2022, 3, 'Bio Test Player', 'Out');
  injuryWeek(2022, 4, 'Bio Test Player', 'Questionable');

  const { X, meta, featureNames } = await buildBoomBustDataset({ fromSeason: 2023, throughSeason: 2023 });
  const idx = meta.findIndex(r => r.name === 'Bio Test Player');
  assert.ok(idx >= 0);
  const features = Object.fromEntries(featureNames.map((n, i) => [n, X[idx][i]]));

  assert.equal(features.age_entering_season, 23, 'born March 2000, entering the 2023 season (post-Sept-1 cutoff) -> age 23');
  assert.equal(features.is_rookie_season, 1, 'nflverse rookie_season=2023 matches the season being graded');
  assert.equal(features.prior_injury_report_weeks, 2, 'two real 2022 injury-report weeks, not a games-played proxy');
});

test('buildBoomBustDataset produces one feature row per matched player, aligned X/y', async () => {
  const { X, y, meta, featureNames } = await buildBoomBustDataset({ fromSeason: 2022, throughSeason: 2022 });
  assert.equal(X.length, y.length);
  assert.equal(X.length, meta.length);
  assert.equal(X.length, 44, 'all 44 seeded players (4 named + 40 filler) have both an ADP row and real usage that season');
  assert.ok(featureNames.length > 0 && X[0].length === featureNames.length);
});

test('walk-forward honestly reports a skip rather than forcing a bootstrap on too few rows', async () => {
  const result = await boomBustWalkForward({ fromSeason: 2021, throughSeason: 2022 });
  const fold2022 = result.find(r => r.test_season === 2022);
  assert.ok(fold2022.skipped, 'four training rows is nowhere near enough for a real gate — must say so, not fabricate a verdict');
});
