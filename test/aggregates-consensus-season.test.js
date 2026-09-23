/**
 * Last season's ADP could carry DOUBLE weight on this season's draft board
 * (2026-09-19).
 *
 * `espn_player_market` is keyed `espn_id INTEGER PRIMARY KEY`, so it holds one
 * global row per player and the upsert overwrites the `season` column too: the
 * table carries exactly one season at a time and no row says which.
 * `computeConsensus()` joined it on `espn_id` alone, with no season predicate,
 * and weights ESPN at 2 against 1 for FFC and 1 for Sleeper. So a table left
 * holding 2025 rows made last year's ADP the single heaviest input to the 2026
 * board — and `draft-assist.js`'s market check reports
 * `sourced: N, unsourced: false` for exactly that state, because it tests
 * presence and not freshness.
 *
 * These tests pin the season predicate, and pin that it is a predicate rather
 * than a removal: a CURRENT-season row must still rank, at full weight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-consensus-season-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const { computeConsensus } = await import('../server/routes/aggregates.js');
const { espnMarketFreshness } = await import('../server/services/espn-market.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

process.env.NFL_SEASON = '2026';

const STALE = 2025;
const CURRENT = 2026;

function seed(marketSeason) {
  db.exec('DELETE FROM player_metrics');
  db.exec('DELETE FROM espn_player_market');
  db.exec('DELETE FROM players');

  // Their ONLY market signal is the ESPN row: no FFC, no Sleeper, no team.
  db.prepare('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)')
    .run(1, 'Espn Only', 'WR', 1001);
  // Has an FFC ADP of its own, so it stays on the board either way and lets us
  // read whether the ESPN source voted.
  db.prepare('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)')
    .run(2, 'Ffc Backed', 'RB', 1002);
  db.prepare(`INSERT INTO player_metrics (player_id, source, value) VALUES (2, 'ffc_adp', 5.0)`).run();

  const insert = db.prepare(`INSERT INTO espn_player_market (espn_id, season, adp, ppr_rank, injury_status, fetched_at)
                             VALUES (?,?,?,?,?,?)`);
  insert.run(1001, marketSeason, 1.0, 1, 'ACTIVE', new Date().toISOString());
  insert.run(1002, marketSeason, 2.0, 2, 'QUESTIONABLE', new Date().toISOString());
}

test('a past-season ESPN row does not put a player on this season\'s board at all', () => {
  seed(STALE);
  const board = computeConsensus();
  assert.equal(board.find(p => p.id === 1), undefined,
    'a player whose only market signal is last season\'s ADP is not a ranked asset this season');
});

test('a past-season ESPN row casts no vote for a player who is on the board anyway', () => {
  // This is the one that matters: ESPN carries weight 2, so a stale vote here
  // outranks FFC and Sleeper combined while looking like an ordinary source.
  seed(STALE);
  const ffcBacked = computeConsensus().find(p => p.id === 2);
  assert.ok(ffcBacked, 'the FFC-backed player stays on the board');
  assert.equal(ffcBacked.espn_adp, null, 'last season\'s ADP is not served as this season\'s');
  assert.equal(ffcBacked.espn_ppr_rank, null);
  assert.equal(ffcBacked.espn_injury_status, null, 'nor last season\'s injury tag');
  assert.equal(ffcBacked.espn_rank, null, 'and it casts no weighted vote');
});

test('a current-season ESPN row still ranks, at full weight', () => {
  // The fix must be a season predicate, not a quiet removal of the source that
  // the board\'s own docstring calls the most relevant market signal it has.
  seed(CURRENT);
  const board = computeConsensus();
  const espnOnly = board.find(p => p.id === 1);
  const ffcBacked = board.find(p => p.id === 2);
  assert.ok(espnOnly, 'a current ESPN ADP is enough to be a ranked asset');
  assert.equal(espnOnly.espn_rank, 1);
  assert.equal(ffcBacked.espn_rank, 2);
  assert.equal(ffcBacked.espn_adp, 2.0);
});

test('the freshness read says which season the table is for', () => {
  // Count and timestamp cannot distinguish a current board from last year\'s,
  // which is how the staleness stayed invisible. The season can.
  seed(STALE);
  const stale = espnMarketFreshness();
  assert.equal(stale.n, 2);
  assert.equal(stale.newest_season, STALE);
  assert.equal(stale.oldest_season, STALE);

  seed(CURRENT);
  assert.equal(espnMarketFreshness().newest_season, CURRENT);
});

test('a table caught between seasons reports both, rather than one plausible number', () => {
  seed(CURRENT);
  db.prepare('UPDATE espn_player_market SET season = ? WHERE espn_id = 1001').run(STALE);
  const mixed = espnMarketFreshness();
  assert.equal(mixed.oldest_season, STALE);
  assert.equal(mixed.newest_season, CURRENT);
});
