import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Historical per-book opening and closing quotes, stored with the book's own
// timestamps so cutoff-bounded readers see them as they see a live capture.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-odds-archive-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
const codes = await import('../server/services/team-codes.js');
const archive = await import('../server/services/odds-archive.js');

for (const [abbr, name] of [['DEN', 'Denver Broncos'], ['IND', 'Indianapolis Colts'], ['MIN', 'Minnesota Vikings'], ['CHI', 'Chicago Bears']]) {
  run('INSERT OR IGNORE INTO nfl_teams (abbr, name, conference, division) VALUES (?,?,?,?)', abbr, name, 'AFC', 'West');
}
codes.clearTeamResolverCache();
// The two games the fixture holds, as nflverse writes them (closing consensus only).
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2022,5,'DEN','IND',1,-3.5,42,19,'nflverse',datetime('now'),'2022-10-06','20:15')`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2022,5,'IND','DEN',0,3.5,42,23,'nflverse',datetime('now'),'2022-10-06','20:15')`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2022,5,'MIN','CHI',1,-7,44,25,'nflverse',datetime('now'),'2022-10-09','13:00')`);

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/oddstrader-archive-2022.json', import.meta.url), 'utf8'));

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('the archive parser yields per-book open and close quotes with the book timestamp', () => {
  const quotes = archive.parseArchiveEvents(fixture);
  assert.ok(quotes.length > 40, `expected many quotes, got ${quotes.length}`);
  const den = quotes.filter(q => q.home === 'DEN' && q.away === 'IND');
  assert.ok(den.length > 0);
  const openSpreads = den.filter(q => q.phase === 'open' && q.market === 'spreads' && q.side === 'DEN');
  const closeSpreads = den.filter(q => q.phase === 'close' && q.market === 'spreads' && q.side === 'DEN');
  assert.ok(openSpreads.length >= 3, 'several books posted an opener');
  assert.ok(closeSpreads.length >= 3, 'several books posted a pre-kickoff line');
  for (const q of [...openSpreads, ...closeSpreads]) {
    assert.ok(q.book_updated_at, 'every quote carries the book timestamp');
    assert.ok(Number.isFinite(q.price));
  }
  assert.ok(openSpreads.every(q => q.book_updated_at < q.commence_time), 'openers are days before kickoff');
  // A book's last posted line can carry a timestamp a minute or two after the
  // listed kickoff; the cutoff-bounded readers exclude those on their own.
  assert.ok(closeSpreads.filter(q => q.book_updated_at < q.commence_time).length >= 3, 'most closes are pre-kickoff');
  assert.ok(new Set(closeSpreads.map(q => q.book)).size >= 3, 'genuinely different books');
});

test('storing the archive fills snapshots, the raw table and blank openers without touching a recorded opener', () => {
  const quotes = archive.parseArchiveEvents(fixture);
  const stored = archive.storeArchiveQuotes(quotes, { fetchedAt: '2026-09-02T12:00:00Z' });
  assert.ok(stored.archived > 40);
  assert.ok(stored.snapshots > 40);
  assert.equal(stored.unmatched, 0, 'both fixture games matched stored games');
  assert.ok(stored.openers_filled >= 2, 'home and away rows of at least one game got an opener');
  const den = rows(`SELECT open_spread, open_total FROM game_lines WHERE season=2022 AND week=5 AND team='DEN'`)[0];
  assert.ok(Number.isFinite(den.open_spread), 'DEN opener filled from the median opening line');
  assert.ok(Number.isFinite(den.open_total));
  const snaps = rows(`SELECT captured_at, home_team, away_team, book, provider FROM nfl_line_snapshots WHERE provider='archive:oddstrader' AND market='spreads' AND home_team='Denver Broncos'`);
  assert.ok(snaps.length >= 6);
  assert.ok(snaps.filter(s => s.captured_at < '2022-10-07T00:15:01.000Z').length >= 6, 'captured_at is the book timestamp; the pre-kickoff ones are what a cutoff query sees');
  assert.equal(snaps[0].away_team, 'Indianapolis Colts', 'full names, as the live capture writes them');
  // Idempotent: a second store changes nothing.
  const again = archive.storeArchiveQuotes(quotes);
  assert.equal(again.snapshots, 0);
  assert.equal(again.openers_filled, 0);
  const status = archive.oddsArchiveStatus();
  assert.equal(status.by_season[0].season, 2022);
  assert.ok(status.by_season[0].books >= 3);
});
