import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Weekly QBR profiles are strictly prior and follow the actual starter.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-qbr-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const qbr = await import('../server/services/nfl-qbr.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const row = (season, week, team, id, name, total, plays) => run(`INSERT INTO nfl_qbr_weekly
  (season,week,team,player_id,name,opponent,qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack,qualified,fetched_at)
  VALUES (?,?,?,?,?,'OPP',?,0,?,0,?,0,1,datetime('now'))`, season, week, team, id, name, total, plays, total);

// 2022: starter A all season at ~70. 2023: A weeks 1-3, then B (a backup at ~35) from week 4.
for (let w = 1; w <= 17; w++) row(2022, w, 'KC', 'A', 'Starter A', 70 + (w % 3), 35);
for (let w = 1; w <= 3; w++) row(2023, w, 'KC', 'A', 'Starter A', 68, 34);
for (let w = 4; w <= 6; w++) { row(2023, w, 'KC', 'B', 'Backup B', 35, 33); row(2023, w, 'KC', 'A', 'Starter A', 50, 3); }

test('the profile before week 4 is starter A from this season and last, with no change flagged', () => {
  const p = qbr.teamQbrProfile(2023, 4, 'KC');
  assert.equal(p.starter.player_id, 'A');
  assert.equal(p.starter_changed, 0);
  assert.equal(p.starter_starts, 6, 'six most recent starts: three this season, three from last');
  assert.ok(p.starter_qbr > 65 && p.starter_qbr < 72);
  assert.equal(p.this_season_weeks, 3);
});

test('once the backup takes the snaps the profile follows him and flags the change', () => {
  const p = qbr.teamQbrProfile(2023, 5, 'KC');
  assert.equal(p.starter.player_id, 'B', 'most plays in the most recent prior week');
  assert.equal(p.starter_changed, 1);
  assert.equal(p.starter_qbr, 35);
  assert.equal(p.starter_starts, 1);
  const later = qbr.teamQbrProfile(2023, 7, 'KC');
  assert.equal(later.starter_changed, 0, 'B has now started two weeks running');
  assert.equal(later.starter_starts, 3);
  assert.equal(qbr.teamQbrProfile(2023, 1, 'NOPE'), null);
});

// --- syncQbr: upsert-key and placeholder-copy regression coverage ---------
// 2026-09 findings (docs/CLAUDE-NEXT-STEPS.md): (1) a stale team tag left a
// duplicate row instead of being corrected, because the primary key includes
// team; (2) the entire 2026 season was found bulk-seeded with byte-identical
// copies of the matching 2025 row. syncQbr fetches a CSV over the network, so
// these tests mock globalThis.fetch rather than reaching nflverse for real.

const QBR_CSV_HEADER = ['season', 'season_type', 'game_week', 'team_abb', 'player_id', 'name_display', 'opp_abb',
  'qbr_total', 'pts_added', 'qb_plays', 'epa_total', 'qbr_raw', 'sack', 'qualified'];

function qbrCsv(records) {
  const lines = [QBR_CSV_HEADER.join(',')];
  for (const r of records) {
    lines.push(QBR_CSV_HEADER.map(col => (r[col] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

function mockFetchOnce(t, csvText) {
  t.mock.method(globalThis, 'fetch', async () => new Response(csvText, { status: 200 }));
}

test('a changed team tag corrects the existing row instead of duplicating it', async (t) => {
  // The stale row a prior (buggy) sync would have left behind: Geno Smith
  // tagged LV, exactly reproducing the real corruption found in the live DB.
  row(2026, 2, 'LV', '15864', 'Geno Smith', 40.0, 30);
  mockFetchOnce(t, qbrCsv([
    { season: 2026, season_type: 'Regular', game_week: 2, team_abb: 'NYJ', player_id: '15864',
      name_display: 'Geno Smith', opp_abb: 'MIA', qbr_total: 62.3, pts_added: 3.1, qb_plays: 38,
      epa_total: 12.4, qbr_raw: 60.1, sack: 2, qualified: 'TRUE' },
  ]));
  const result = await qbr.syncQbr({ seasons: [2026] });
  assert.equal(result.written, 1);
  assert.equal(result.quarantined, 0);
  const remaining = db.prepare(`SELECT team, qbr_total FROM nfl_qbr_weekly WHERE season=2026 AND week=2 AND player_id='15864'`).all();
  assert.equal(remaining.length, 1, 'the stale LV row must be gone, not left beside the new NYJ row');
  assert.equal(remaining[0].team, 'NYJ');
  assert.equal(remaining[0].qbr_total, 62.3);
});

test('an incoming row byte-identical to last season\'s is quarantined, not written as fact', async (t) => {
  // A real, played 2025 week for this player/team.
  row(2025, 3, 'KC', 'PLACEHOLDER1', 'Copy Test', 71.4, 34);
  db.prepare(`UPDATE nfl_qbr_weekly SET pts_added=1.2, epa_total=40.1, qbr_raw=68.0, sack=0.5
    WHERE season=2025 AND week=3 AND player_id='PLACEHOLDER1'`).run();
  // The exact same six stat fields, relabeled as 2026 -- the observed bulk-seed pattern.
  mockFetchOnce(t, qbrCsv([
    { season: 2026, season_type: 'Regular', game_week: 3, team_abb: 'KC', player_id: 'PLACEHOLDER1',
      name_display: 'Copy Test', opp_abb: 'DEN', qbr_total: 71.4, pts_added: 1.2, qb_plays: 34,
      epa_total: 40.1, qbr_raw: 68.0, sack: 0.5, qualified: 'TRUE' },
  ]));
  const result = await qbr.syncQbr({ seasons: [2026] });
  assert.equal(result.quarantined, 1);
  assert.equal(result.written, 0);
  const found = db.prepare(`SELECT * FROM nfl_qbr_weekly WHERE season=2026 AND week=3 AND player_id='PLACEHOLDER1'`).get();
  assert.equal(found, undefined, 'the copied row must not be persisted as a 2026 fact');
});

test('a genuinely different current-season stat line is written normally, even when close to last season\'s', async (t) => {
  row(2025, 5, 'SF', 'REAL1', 'Real Player', 71.4, 34);
  db.prepare(`UPDATE nfl_qbr_weekly SET pts_added=1.2, epa_total=40.1, qbr_raw=68.0, sack=0.5
    WHERE season=2025 AND week=5 AND player_id='REAL1'`).run();
  // Several fields differ from the 2025 row -- a real, distinct performance,
  // not a coincidental one-field match.
  mockFetchOnce(t, qbrCsv([
    { season: 2026, season_type: 'Regular', game_week: 5, team_abb: 'SF', player_id: 'REAL1',
      name_display: 'Real Player', opp_abb: 'SEA', qbr_total: 55.2, pts_added: 0.4, qb_plays: 30,
      epa_total: 22.0, qbr_raw: 52.0, sack: 3, qualified: 'TRUE' },
  ]));
  const result = await qbr.syncQbr({ seasons: [2026] });
  assert.equal(result.quarantined, 0);
  assert.equal(result.written, 1);
  const found = db.prepare(`SELECT qbr_total, pts_added FROM nfl_qbr_weekly WHERE season=2026 AND week=5 AND player_id='REAL1'`).get();
  assert.ok(found, 'a genuinely different current-season row must be written');
  assert.equal(found.qbr_total, 55.2);
  assert.equal(found.pts_added, 0.4);
});

test('a near-miss on a single field is not mistaken for an exact copy', async (t) => {
  row(2025, 6, 'DAL', 'REAL2', 'Close Player', 70.0, 30);
  db.prepare(`UPDATE nfl_qbr_weekly SET pts_added=1.0, epa_total=30.0, qbr_raw=65.0, sack=1
    WHERE season=2025 AND week=6 AND player_id='REAL2'`).run();
  // Five of six fields match exactly; qbr_total differs slightly -- a real
  // coincidence on some fields must not trip the all-six-fields guard.
  mockFetchOnce(t, qbrCsv([
    { season: 2026, season_type: 'Regular', game_week: 6, team_abb: 'DAL', player_id: 'REAL2',
      name_display: 'Close Player', opp_abb: 'NYG', qbr_total: 70.5, pts_added: 1.0, qb_plays: 30,
      epa_total: 30.0, qbr_raw: 65.0, sack: 1, qualified: 'TRUE' },
  ]));
  const result = await qbr.syncQbr({ seasons: [2026] });
  assert.equal(result.quarantined, 0);
  assert.equal(result.written, 1);
});
