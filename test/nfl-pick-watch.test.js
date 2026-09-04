import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// nfl-pick-watch.js's job: pick generation freezes one quote and never looks
// at it again. This re-shops every open pick against the live multi-book
// snapshot, using nfl-execution.js's real rankBooks — the same "actual
// mechanism, not a stub" bar every other feature this session touched had to
// clear. Three things must all be true: it finds the right live quotes for a
// pick generated with team abbreviations against a snapshot table keyed by
// full team names, it reports the correct direction (more/less favorable)
// off a real probability-space comparison rather than a raw price diff, and
// it stays at the zero-edge floor (recommended_stake_units=0, status
// "watching_no_action") until model-governance.js's registry says a
// champion has actually been promoted to production — then flips
// automatically, with no code change, once one is.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pick-watch-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');       // owns game_lines
await import('../server/services/line-shopping.js');    // owns nfl_line_snapshots
await import('../server/services/nfl-auto-picks.js');    // owns nfl_auto_picks
await import('../server/services/nfl-props.js');         // owns nfl_total_picks
const { updateRegistry } = await import('../server/services/model-governance.js');
const { clearShoppingBoardCache } = await import('../server/services/nfl-shopping-board.js');
const watch = await import('../server/services/nfl-pick-watch.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (901,'SEA','Seattle Seahawks','NFC','West'),(902,'NE','New England Patriots','AFC','East')`);

const SEASON = 2026, WEEK = 2;

function openGame() {
  run(`INSERT OR REPLACE INTO game_lines (season,week,team,opponent,home,team_score,opp_score)
       VALUES (?,?,?,?,1,NULL,NULL)`, SEASON, WEEK, 'SEA', 'NE');
  run(`INSERT OR REPLACE INTO game_lines (season,week,team,opponent,home,team_score,opp_score)
       VALUES (?,?,?,?,0,NULL,NULL)`, SEASON, WEEK, 'NE', 'SEA');
}

function lockedSpreadPick({ rank = 1, selection = 'SEA', side = '-3', line = -3, price = -110 } = {}) {
  run(`INSERT INTO nfl_auto_picks
      (season, week, rank, home_team, away_team, matchup, selection, side, line, american_price,
       model_probability, implied_probability, probability_difference, detail, units_staked, selected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(season, week, rank) DO NOTHING`,
  SEASON, WEEK, rank, 'SEA', 'NE', 'NE at SEA', selection, side, line, price,
  0.58, 0.5238, 0.0562, 'test pick', 0, new Date().toISOString());
}

function snapshotQuote({ book, side, line, price, capturedAt = '2026-09-10T10:00:00Z' }) {
  run(`INSERT INTO nfl_line_snapshots
      (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
  capturedAt, 'nfl:2026-09-14:NE@SEA', '2026-09-14T17:00:00Z', 'Seattle Seahawks', 'New England Patriots',
  book, 'spreads', side, line, price);
  // Production capture (book-feeds.js) always clears this cache right after
  // writing new quotes; a raw test insert has to do the same or
  // simultaneousQuotes() would keep serving the pre-insert snapshot.
  clearShoppingBoardCache();
}

test('a pick with no live snapshot yet is reported, not silently dropped', () => {
  openGame();
  lockedSpreadPick({ rank: 1 });
  const out = watch.reshopOpenPicks();
  assert.equal(out.spread_checked, 1);
  const board = watch.pickWatchBoard();
  const row = board.picks.find(p => p.pick_source === 'spread' && p.rank === 1);
  assert.equal(row.status, 'watching_no_market_data');
  assert.equal(row.gate_open, 0);
  assert.equal(row.recommended_stake_units, 0);
});

test('a real live quote is matched by team-name side, and a better price reads as more favorable', () => {
  // The pick was generated at Seattle -3 / -110. The live market now has
  // Seattle -3 at -105 (a better price for the same number at one book) and
  // -102 at another — genuinely better than -110, so this must read
  // more_favorable once rankBooks compares break-even rates.
  snapshotQuote({ book: 'pinnacle', side: 'Seattle Seahawks', line: -3, price: -105 });
  snapshotQuote({ book: 'circa', side: 'Seattle Seahawks', line: -3, price: -102 });
  // The away side must also be present for a simultaneous quote set (>=2 books
  // sharing captured_at across both sides of a market is how simultaneousQuotes
  // treats this as one comparable event — but bestExecution only needs the SIDE
  // it is pricing, so two books on the home side alone already qualifies).
  const out = watch.reshopOpenPicks();
  assert.equal(out.spread_checked, 1);
  const board = watch.pickWatchBoard();
  const row = board.picks.find(p => p.pick_source === 'spread' && p.rank === 1);
  assert.equal(row.best_book, 'circa', 'the better price should win');
  assert.equal(row.best_price, -102);
  assert.equal(row.direction, 'more_favorable');
  assert.equal(row.status, 'watching_no_action', 'no market champion is in production yet');
  assert.equal(row.recommended_stake_units, 0);
  assert.match(row.note, /No proven CLV/);
});

test('a worse current price reads as less favorable', () => {
  lockedSpreadPick({ rank: 2, side: '-3', line: -3, price: -105 }); // generated at a GOOD price
  // A later capture (simultaneousQuotes always reads the MOST RECENT capture
  // per event, so this supersedes the -105/-102 pair from the previous test).
  const at = '2026-09-10T11:00:00Z';
  snapshotQuote({ book: 'pinnacle', side: 'Seattle Seahawks', line: -3, price: -130, capturedAt: at });
  snapshotQuote({ book: 'circa', side: 'Seattle Seahawks', line: -3, price: -125, capturedAt: at });
  watch.reshopOpenPicks();
  const board = watch.pickWatchBoard();
  const row = board.picks.find(p => p.pick_source === 'spread' && p.rank === 2);
  assert.equal(row.direction, 'less_favorable');
});

test('the recommendation flips to actionable the moment the market gate actually opens, automatically', () => {
  updateRegistry({ sport: 'NFL', market: 'spread', role: 'champion', modelVersion: 'test-promoted-v1',
    state: 'production', reason: 'test promotion' });
  assert.equal(watch.marketGateOpen('spread'), true);
  const prevUnits = process.env.NFL_MODEL_STAKE_UNITS;
  process.env.NFL_MODEL_STAKE_UNITS = '0.5';
  try {
    watch.reshopOpenPicks();
    const board = watch.pickWatchBoard();
    const row = board.picks.find(p => p.pick_source === 'spread' && p.rank === 1);
    assert.equal(row.status, 'actionable');
    assert.equal(row.gate_open, 1);
    assert.equal(row.recommended_stake_units, 0.5);
    assert.match(row.note, /promoted to production/);
  } finally {
    if (prevUnits === undefined) delete process.env.NFL_MODEL_STAKE_UNITS;
    else process.env.NFL_MODEL_STAKE_UNITS = prevUnits;
    // Restore the baseline so later tests (and other suites sharing this
    // module in-process) see the honest default: no champion in production.
    updateRegistry({ sport: 'NFL', market: 'spread', role: 'champion', modelVersion: 'market-consensus-v1',
      state: 'baseline', reason: 'test cleanup: restore baseline' });
  }
});

test('pickWatchBoard reports only the latest check per pick, not the whole history', () => {
  watch.reshopOpenPicks();
  watch.reshopOpenPicks();
  const log = watch.pickWatchLog({ limit: 1000 });
  const board = watch.pickWatchBoard();
  const rank1Logs = log.filter(r => r.pick_source === 'spread' && r.rank === 1);
  assert.ok(rank1Logs.length >= 3, 'the log should accumulate every run');
  const rank1Board = board.picks.filter(p => p.pick_source === 'spread' && p.rank === 1);
  assert.equal(rank1Board.length, 1, 'the board should show exactly one row per open pick: the latest');
});

test('a settled game (team_score present) is no longer treated as an open pick', () => {
  run(`UPDATE game_lines SET team_score=27, opp_score=20 WHERE season=? AND week=? AND team='SEA'`, SEASON, WEEK);
  const out = watch.reshopOpenPicks();
  assert.equal(out.spread_checked, 0, 'a settled game must drop out of the open-pick set');
});
