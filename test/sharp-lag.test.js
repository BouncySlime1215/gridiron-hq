import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Sharp lag: when Pinnacle moves, how long each soft book takes to follow,
// how often the stale number is still on the board, and what it was worth
// against Pinnacle's close. Synthetic hourly captures of one game.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sharplag-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');    // owns game_lines
await import('../server/services/line-shopping.js'); // owns nfl_line_snapshots
const { sharpLag } = await import('../server/services/sharp-lag.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES ('KC','Kansas City Chiefs','AFC','West'),('DEN','Denver Broncos','AFC','West')`);
// Kickoff Sunday 2026-09-13 13:00 ET = 17:00Z; no score yet.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2026,1,'KC','DEN',1,-3,47,25,'test',datetime('now'),'2026-09-13','13:00')`);

const EVENT = 'nfl:2026-09-13:DEN@KC', KICKOFF = '2026-09-13T17:00:01Z';
const KC = 'Kansas City Chiefs', DEN = 'Denver Broncos';
const hour = h => new Date(Date.UTC(2026, 8, 8, 10 + h)).toISOString(); // hour 0 = 2026-09-08T10:00Z
const snap = (at, book, side, line, { provider = 'free:oddstrader', market = 'spreads', updated = at } = {}) => run(
  `INSERT INTO nfl_line_snapshots (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, at, EVENT, KICKOFF, KC, DEN, book, market, side, line, -110, provider, updated);
const pin = (at, side, line, opts) => snap(at, 'pinnacle', side, line, { provider: 'free:pinnacle', updated: null, ...opts });

// Pinnacle: KC -3 through hour 1, -3.5 from hour 2 (mirrored on the DEN side).
for (let h = 0; h <= 5; h++) { pin(hour(h), KC, h < 2 ? -3 : -3.5); pin(hour(h), DEN, h < 2 ? 3 : 3.5); }
// Bovada follows at hour 3 (60 minutes), Lowvig at hour 5 (180 minutes), BetOnline never.
for (let h = 0; h <= 5; h++) {
  snap(hour(h), 'bovada', KC, h < 3 ? -3 : -3.5, { provider: 'free:bovada', updated: null });
  snap(hour(h), 'bovada', DEN, h < 3 ? 3 : 3.5, { provider: 'free:bovada', updated: null });
  snap(hour(h), 'lowvig', KC, h < 5 ? -3 : -3.5);
  snap(hour(h), 'lowvig', DEN, h < 5 ? 3 : 3.5);
  snap(hour(h), 'betonlineag', KC, -3);
}
// Unibet is in the same batches at the old number, but its own stamp is ten days old:
// the aggregator served a cached price, not a live one. It must not read as a lag.
for (let h = 2; h <= 5; h++) snap(hour(h), 'unibet', KC, -3, { updated: '2026-08-29T10:00:00Z' });

const NOW = '2026-09-09T00:00:00Z';

test('one Pinnacle move, attributed to the side it moved toward; follow latency per soft book in minutes', () => {
  const out = sharpLag({ now: NOW });
  assert.equal(out.pinnacle_moves, 1, 'the mirrored DEN side is the same move, not a second one');
  assert.deepEqual(out.moves.map(m => [m.captured_at, m.side, m.from, m.to]), [[hour(2), KC, -3, -3.5]]);
  assert.equal(out.window.captures, 6);
  assert.equal(out.window.stale_dropped, 4, 'the four stale Unibet rows are counted out, not silently missing');

  const { bovada, lowvig, betonlineag } = out.by_book;
  assert.equal(bovada.moves_seen, 1);
  assert.equal(bovada.followed, 1);
  assert.equal(bovada.median_follow_minutes, 60);
  assert.equal(bovada.p90_follow_minutes, 60);
  assert.equal(bovada.followed_within_60m_share, 1);
  assert.equal(bovada.followed_within_180m_share, 1);

  assert.equal(lowvig.median_follow_minutes, 180);
  assert.equal(lowvig.followed_within_60m_share, 0);
  assert.equal(lowvig.followed_within_180m_share, 1);

  assert.equal(betonlineag.followed, 0);
  assert.equal(betonlineag.not_followed, 1);
  assert.equal(betonlineag.median_follow_minutes, null, 'null, never 0, when nothing was followed');
  assert.equal(betonlineag.followed_within_60m_share, 0, 'a share over one seen move that was not followed is a real 0');
  assert.equal(betonlineag.median_hours_observed_when_not_followed, 3);
  assert.deepEqual(out.moves[0].follows, {
    bovada: { followed: true, minutes: 60 },
    lowvig: { followed: true, minutes: 180 },
    betonlineag: { followed: false, hours_observed: 3 }
  });

  assert.equal(out.by_book.unibet, undefined, 'a book with only stale quotes is not in the study');
  assert.equal(out.by_book.pinnacle, undefined, 'the reference is not graded against itself');
});

test('lag opportunities are every capture the stale number is still up, with the gap to Pinnacle at that capture', () => {
  const out = sharpLag({ now: NOW });
  const { bovada, lowvig, betonlineag } = out.by_book;
  assert.equal(bovada.opportunities, 1, 'hour 2 only — Bovada is at -3.5 by hour 3');
  assert.equal(lowvig.opportunities, 3, 'hours 2, 3 and 4');
  assert.equal(betonlineag.opportunities, 4, 'hours 2 through 5, never followed');
  assert.equal(out.opportunities.length, 8);
  assert.ok(out.opportunities.every(o => o.side === KC && o.soft_line === -3 && o.pinnacle_line === -3.5 && o.gap === 0.5));
  assert.ok(out.opportunities.every(o => o.book !== 'unibet'));
  assert.equal(bovada.mean_gap, 0.5);
  assert.deepEqual(out.opportunities.filter(o => o.book === 'lowvig').map(o => o.minutes_since_move), [0, 60, 120]);

  // Nothing is settled yet: the grades are null, not zero.
  assert.equal(lowvig.settled, 0);
  assert.equal(lowvig.mean_clv_points, null);
  assert.equal(lowvig.positive_clv_share, null);
  assert.equal(lowvig.ats_record, null);
  assert.equal(lowvig.readable, false);
  assert.match(out.readable_rule, /30 settled opportunities/);
});

test('a bigger minMove or an older window finds nothing, and reports nulls rather than zeros', () => {
  assert.equal(sharpLag({ now: NOW, minMove: 1 }).pinnacle_moves, 0);
  const empty = sharpLag({ now: '2026-12-01T00:00:00Z', sinceDays: 14 });
  assert.equal(empty.pinnacle_moves, 0);
  assert.deepEqual(empty.by_book, {});
  assert.deepEqual(empty.opportunities, []);
  assert.equal(empty.window.captures, 0);
});

test('a totals move is attributed to the Under when the number drops, and the Over is not a lag', () => {
  const t = { market: 'totals' };
  for (let h = 0; h <= 2; h++) {
    pin(hour(h), 'Over', h < 1 ? 47 : 46.5, t); pin(hour(h), 'Under', h < 1 ? 47 : 46.5, t);
    snap(hour(h), 'lowvig', 'Over', 47, t); snap(hour(h), 'lowvig', 'Under', 47, t);
  }
  const out = sharpLag({ now: NOW, market: 'totals' });
  assert.equal(out.pinnacle_moves, 1);
  assert.equal(out.moves[0].side, 'Under', '47 to 46.5 is money on the Under; Under bettors got a worse number');
  assert.equal(out.by_book.lowvig.opportunities, 2, 'Lowvig still has Under 47 at hours 1 and 2');
  assert.ok(out.opportunities.every(o => o.side === 'Under' && o.gap === 0.5));
});

test('after the final score and a Pinnacle pre-kickoff close, each opportunity is graded by CLV and ATS', () => {
  run(`UPDATE game_lines SET team_score=27, opp_score=20 WHERE season=2026 AND week=1 AND team='KC'`);
  // Pinnacle's last pre-kickoff line: KC -4.5. A post-kickoff print is neither the close nor a move.
  pin('2026-09-13T16:30:00Z', KC, -4.5); pin('2026-09-13T16:30:00Z', DEN, 4.5);
  pin('2026-09-13T17:20:00Z', KC, -6); pin('2026-09-13T17:20:00Z', DEN, 6);

  const before = sharpLag({ now: '2026-09-12T12:00:00Z' });
  assert.equal(before.by_book.lowvig.settled, 0, 'not before kickoff');

  const out = sharpLag({ now: '2026-09-14T12:00:00Z' });
  assert.equal(out.pinnacle_moves, 2, 'the -3.5 to -4.5 close is a second move (with no soft book quoted at that capture); the in-play -6 is not');
  assert.equal(out.window.in_play_dropped, 2);
  const { bovada, lowvig, betonlineag } = out.by_book;
  assert.equal(lowvig.moves_seen, 1, 'no soft book was quoted at the close capture, so nobody "saw" that move');
  assert.equal(lowvig.settled, 3);
  assert.equal(lowvig.mean_clv_points, 1.5, 'KC -3 against a -4.5 close');
  assert.equal(lowvig.positive_clv_share, 1);
  assert.equal(lowvig.ats_record, '3-0-0', 'KC won by 7 at -3');
  assert.equal(bovada.settled, 1);
  assert.equal(bovada.ats_record, '1-0-0');
  assert.equal(betonlineag.settled, 4);
  assert.equal(betonlineag.mean_clv_points, 1.5);
  const settled = out.opportunities.filter(o => o.close_line != null);
  assert.equal(settled.length, 8);
  assert.ok(settled.every(o => o.close_line === -4.5 && o.clv_points === 1.5 && o.ats === 'W' && o.close_at === '2026-09-13T16:30:00Z'));
});
