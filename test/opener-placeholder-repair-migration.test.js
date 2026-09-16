/**
 * Migration 055: Pinnacle placeholder openers (usually home -1.0) that
 * migration 047 copied into game_lines for 2022-2025. Each case below is a
 * shape measured in the real archive on 2026-09-16.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as m055 from '../server/migrations/055_repair_pinnacle_placeholder_openers.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-055-'));
const open = [];
test.after(() => {
  for (const d of open) { try { d.close(); } catch { /* closed */ } }
  fs.rmSync(temp, { recursive: true, force: true });
});

const T0 = Date.parse('2025-09-08T12:00:00Z');
const at = hours => new Date(T0 + hours * 3600e3).toISOString();
let eid = 1;

function fresh() {
  const d = new DatabaseSync(path.join(temp, `${eid}-${open.length}.sqlite`));
  open.push(d);
  d.exec(`CREATE TABLE game_lines (season INTEGER, week INTEGER, team TEXT, opponent TEXT, home INTEGER,
            open_spread REAL, open_total REAL, open_spread_source TEXT);
          CREATE TABLE nfl_odds_archive (eid INTEGER, season INTEGER, week INTEGER, home TEXT, away TEXT,
            book TEXT, market TEXT, side TEXT, phase TEXT, line REAL, book_updated_at TEXT);`);
  return d;
}

/** One game: both game_lines rows as 047 left them, plus archive openers. */
function game(d, { season = 2025, week = 2, home, away, pin, peers, peerHours = 1, pinTotal = null, peerTotals = [],
  source = 'pinnacle_archive_reopen_2022_2025' }) {
  const id = eid++;
  const ins = d.prepare(`INSERT INTO game_lines VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(season, week, home, away, 1, pin, pinTotal, source);
  ins.run(season, week, away, home, 0, pin === 0 ? 0 : -pin, pinTotal, source);
  const q = d.prepare(`INSERT INTO nfl_odds_archive VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  q.run(id, season, week, home, away, 'pinnacle', 'spreads', home, 'open', pin, at(0));
  peers.forEach((line, i) => q.run(id, season, week, home, away, `book${i}`, 'spreads', home, 'open', line, at(peerHours)));
  if (pinTotal != null) q.run(id, season, week, home, away, 'pinnacle', 'totals', 'Over', 'open', pinTotal, at(0));
  peerTotals.forEach((line, i) => q.run(id, season, week, home, away, `book${i}`, 'totals', 'Over', 'open', line, at(peerHours)));
}

const rowOf = (d, team, opponent) =>
  d.prepare(`SELECT open_spread, open_total, open_spread_source, open_total_source FROM game_lines WHERE team=? AND opponent=?`).get(team, opponent);

test('a -1.0 placeholder with contemporaneous peers is replaced by their median, correctly signed on both rows', () => {
  const d = fresh();
  game(d, { home: 'BAL', away: 'CLE', pin: -2.5, peers: [-13, -13, -12.5, -12.5, -12.5] });
  m055.up(d);
  assert.equal(rowOf(d, 'BAL', 'CLE').open_spread, -12.5);
  assert.equal(rowOf(d, 'CLE', 'BAL').open_spread, 12.5);
  assert.equal(rowOf(d, 'BAL', 'CLE').open_spread_source, m055.REPAIRED);
  assert.equal(rowOf(d, 'CLE', 'BAL').open_spread_source, m055.REPAIRED);
});

test('an even-count median is rounded to a bettable half point', () => {
  const d = fresh();
  game(d, { home: 'IND', away: 'TEN', pin: -1, peers: [-14.5, -14, -14, -12] });
  m055.up(d);
  assert.equal(rowOf(d, 'IND', 'TEN').open_spread, -14);
});

test('stale peers posted days before Pinnacle do NOT override it (the 2022-23 case)', () => {
  const d = fresh();
  game(d, { season: 2022, home: 'KC', away: 'LV', pin: -3, peers: [-6, -6, -6, -6], peerHours: -108 });
  m055.up(d);
  assert.equal(rowOf(d, 'KC', 'LV').open_spread, -3);
  assert.equal(rowOf(d, 'KC', 'LV').open_spread_source, 'pinnacle_archive_reopen_2022_2025');
});

test('a Pinnacle opener that agrees with its peers is left alone', () => {
  const d = fresh();
  game(d, { home: 'MIA', away: 'NE', pin: -3, peers: [-3.5, -3, -2.5] });
  m055.up(d);
  assert.equal(rowOf(d, 'MIA', 'NE').open_spread, -3);
  assert.equal(rowOf(d, 'MIA', 'NE').open_spread_source, 'pinnacle_archive_reopen_2022_2025');
});

test('fewer than three contemporaneous peers is not enough evidence to override', () => {
  const d = fresh();
  game(d, { home: 'GB', away: 'WAS', pin: -1, peers: [-7, -7] });
  m055.up(d);
  assert.equal(rowOf(d, 'GB', 'WAS').open_spread, -1);
});

test('an unresolvable -1.0 keeps its value but is labeled suspect so analyses can exclude it', () => {
  const d = fresh();
  game(d, { home: 'DET', away: 'CHI', pin: -1, peers: [-4.5, -4.5, -5], peerHours: -100 });
  m055.up(d);
  assert.equal(rowOf(d, 'DET', 'CHI').open_spread, -1);
  assert.equal(rowOf(d, 'DET', 'CHI').open_spread_source, m055.SUSPECT);
  assert.equal(rowOf(d, 'CHI', 'DET').open_spread_source, m055.SUSPECT);
});

test('totals get the same rule, with provenance in open_total_source', () => {
  const d = fresh();
  game(d, { home: 'SF', away: 'TEN', pin: -13, peers: [-13, -12.5, -13.5], pinTotal: 38, peerTotals: [45.5, 45.5, 46] });
  m055.up(d);
  const r = rowOf(d, 'SF', 'TEN');
  assert.equal(r.open_total, 45.5);
  assert.equal(r.open_total_source, m055.REPAIRED);
  assert.equal(rowOf(d, 'TEN', 'SF').open_total, 45.5);
  assert.equal(r.open_spread, -13);
});

test('rows 047 did not write are never touched', () => {
  const d = fresh();
  game(d, { season: 2022, home: 'NYJ', away: 'BUF', pin: -1, peers: [7, 7, 7.5], source: 'unresolved_legacy_median_2022_2025' });
  m055.up(d);
  assert.equal(rowOf(d, 'NYJ', 'BUF').open_spread, -1);
  assert.equal(rowOf(d, 'NYJ', 'BUF').open_spread_source, 'unresolved_legacy_median_2022_2025');
});

test('running it twice changes nothing the second time', () => {
  const d = fresh();
  game(d, { home: 'CAR', away: 'BUF', pin: -1, peers: [7, 7, 7.5], pinTotal: 40, peerTotals: [47, 47, 47.5] });
  m055.up(d);
  const first = [rowOf(d, 'CAR', 'BUF'), rowOf(d, 'BUF', 'CAR')];
  m055.up(d);
  assert.deepEqual([rowOf(d, 'CAR', 'BUF'), rowOf(d, 'BUF', 'CAR')], first);
  assert.equal(first[0].open_spread, 7);
  assert.equal(first[1].open_spread, -7);
});

test('down() drops only the additive column', () => {
  const d = fresh();
  game(d, { home: 'PHI', away: 'LV', pin: -1, peers: [-13.5, -12.5, -12.5] });
  m055.up(d);
  m055.down(d);
  const cols = d.prepare('PRAGMA table_info(game_lines)').all().map(c => c.name);
  assert.ok(!cols.includes('open_total_source'));
  assert.equal(d.prepare(`SELECT open_spread FROM game_lines WHERE team='PHI'`).get().open_spread, -12.5);
});

test('runs inside the caller\'s transaction, as server/db/migrate.js wraps every migration', () => {
  const d = fresh();
  game(d, { home: 'ATL', away: 'MIA', pin: -1, peers: [-7.5, -7.5, -7] });
  d.exec('BEGIN');
  m055.up(d);
  d.exec('COMMIT');
  assert.equal(rowOf(d, 'ATL', 'MIA').open_spread, -7.5);
});
