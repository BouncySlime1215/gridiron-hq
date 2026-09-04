import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern as the rest of the suite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-auction-values-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, row } = await import('../server/db/index.js');
await import('../server/routes/stats.js'); // creates player_season_stats
await import('../server/routes/aggregates.js'); // creates player_metrics (vorBoard's adp join)
const {
  auctionValues, initAuctionDraft, recordSale, liveAuctionValues
} = await import('../server/services/auction-values.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const SEASON = Number(process.env.NFL_SEASON) || 2026;

function addPlayer(name, position, proj) {
  run(`INSERT INTO players (name, position, fantasy_relevant) VALUES (?, ?, 1)`, name, position);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points) VALUES (?, ?, 'projected', ?)`,
    id, SEASON, proj);
  return id;
}

// vorBoard() reads the WHOLE players table, and all these tests share one database
// (same isolated-DB convention as the rest of the suite) — so every seedPool() call
// must use a distinct name tag per test, and lookups must go by returned id, never
// by name, or a later test's fixture rows bleed into an earlier test's board.
let poolCounter = 0;

/** A small but shaped-enough player pool: a clear tier gap at each position. */
function seedPool() {
  poolCounter += 1;
  const tag = `P${poolCounter}`;
  const ids = {};
  // QBs
  ids.qb1 = addPlayer(`${tag} Star QB`, 'QB', 380);
  ids.qb2 = addPlayer(`${tag} Mid QB`, 'QB', 300);
  for (let i = 0; i < 10; i++) addPlayer(`${tag} Replacement QB ${i}`, 'QB', 220 - i);
  // RBs
  ids.rb1 = addPlayer(`${tag} Star RB`, 'RB', 320);
  ids.rb2 = addPlayer(`${tag} Mid RB`, 'RB', 240);
  ids.rbReplacement = addPlayer(`${tag} Replacement RB 20`, 'RB', 130);
  for (let i = 0; i < 22; i++) if (i !== 20) addPlayer(`${tag} Replacement RB ${i}`, 'RB', 150 - i);
  // WRs
  ids.wr1 = addPlayer(`${tag} Star WR`, 'WR', 300);
  ids.wr2 = addPlayer(`${tag} Mid WR`, 'WR', 220);
  for (let i = 0; i < 34; i++) addPlayer(`${tag} Replacement WR ${i}`, 'WR', 140 - i);
  // TEs
  ids.te1 = addPlayer(`${tag} Star TE`, 'TE', 220);
  for (let i = 0; i < 10; i++) addPlayer(`${tag} Replacement TE ${i}`, 'TE', 90 - i);
  // K/DEF filler so replacementLevels() has something at every position
  for (let i = 0; i < 12; i++) addPlayer(`${tag} K ${i}`, 'K', 100 - i);
  for (let i = 0; i < 12; i++) addPlayer(`${tag} DEF ${i}`, 'DEF', 100 - i);
  return ids;
}

const byId = (players, id) => players.find(p => p.id === id);

test('book auction values sum to exactly the total room budget', () => {
  seedPool();
  const { players, total_budget } = auctionValues(null, { budget: 200, teams: 12, rosterSize: 16 });
  assert.equal(total_budget, 2400);
  const sum = players.reduce((s, p) => s + (p.auction_value ?? 0), 0);
  assert.equal(sum, total_budget, 'largest-remainder rounding must re-true the total exactly');
});

test('the elite player at each position costs meaningfully more than the replacement tier', () => {
  const ids = seedPool();
  const { players } = auctionValues(null, { budget: 200, teams: 12, rosterSize: 16 });
  assert.ok(byId(players, ids.rb1).auction_value > byId(players, ids.rb2).auction_value);
  assert.ok(byId(players, ids.rb2).auction_value > byId(players, ids.rbReplacement).auction_value);
});

test('every player in the room is floored at $1, never $0 or negative', () => {
  seedPool();
  const { players } = auctionValues(null, { budget: 200, teams: 12, rosterSize: 16 });
  for (const p of players) if (p.auction_value != null) assert.ok(p.auction_value >= 1, `${p.name} priced below $1`);
});

test('players outside the realistic room (beyond total roster spots) get no auction value', () => {
  seedPool();
  const { players, roster_size, teams } = auctionValues(null, { budget: 200, teams: 12, rosterSize: 16 });
  assert.equal(roster_size, 16);
  const poolSize = teams * roster_size;
  const withValue = players.filter(p => p.auction_value != null);
  assert.ok(withValue.length <= poolSize);
  const withoutValue = players.filter(p => p.auction_value == null);
  assert.ok(withoutValue.length > 0, 'this fixture seeds more players than roster spots, some should be outside the room');
});

test('a bigger total budget scales every price up proportionally', () => {
  const ids = seedPool();
  const cheap = auctionValues(null, { budget: 100, teams: 12, rosterSize: 16 });
  const rich = auctionValues(null, { budget: 400, teams: 12, rosterSize: 16 });
  const cheapVal = byId(cheap.players, ids.rb1).auction_value;
  const richVal = byId(rich.players, ids.rb1).auction_value;
  assert.ok(richVal > cheapVal * 2, 'quadrupling the budget should more than double the top player\'s price');
});

test('a league lookup resolves teams/roster size when not passed explicitly', () => {
  seedPool();
  run(`INSERT INTO leagues (platform, league_id, season, team_count) VALUES ('espn', '999', ?, 10)`, SEASON);
  const leagueId = row(`SELECT id FROM leagues WHERE league_id = '999'`).id;
  run(`INSERT INTO drafts (name, type, team_count, rounds, league_row_id) VALUES ('t', 'live', 10, 14, ?)`, leagueId);
  const { teams, roster_size } = auctionValues(leagueId, { budget: 200 });
  assert.equal(teams, 10);
  assert.equal(roster_size, 14);
});

/* ------------------------------------------------------ live inflation */

function makeDraft(teamCount = 12, rounds = 16) {
  run(`INSERT INTO drafts (name, type, team_count, rounds) VALUES ('auction test', 'mock', ?, ?)`, teamCount, rounds);
  return row('SELECT last_insert_rowid() AS id').id;
}

test('with no sales yet, inflation is zero and live value equals book value', () => {
  const ids = seedPool();
  const draftId = makeDraft();
  initAuctionDraft(draftId, { budget: 200, rosterSize: 16 });
  const live = liveAuctionValues(draftId);
  assert.equal(live.inflation_pct, 0);
  const star = byId(live.players, ids.rb1);
  assert.equal(star.live_value, star.auction_value);
  assert.equal(live.spent, 0);
  assert.equal(live.remaining_budget, live.total_budget);
});

test('a player selling above book value leaves less money than value in the room, deflating remaining prices', () => {
  // Real mechanic (Footballguys/FantasySixpack inflation calculators): overpaying for
  // one player spends more of the room's cap than that player's book value represented,
  // leaving LESS money behind relative to the value still on the board — so remaining
  // players go for less than book, not more. (The opposite of the naive "stud goes for
  // a lot so everything gets pricier" intuition — that effect exists but is driven by
  // bargains elsewhere leaving spare cash, tested below.)
  const ids = seedPool();
  const draftId = makeDraft();
  initAuctionDraft(draftId, { budget: 200, rosterSize: 16 });
  const before = liveAuctionValues(draftId);
  const starRb = byId(before.players, ids.rb1);

  recordSale(draftId, ids.rb1, 1, starRb.auction_value + 50);

  const after = liveAuctionValues(draftId);
  assert.ok(after.inflation_pct < 0, 'overpaying for a player should deflate the room (less $ left per unit of remaining value)');
  const someoneElse = byId(after.players, ids.rb2);
  assert.ok(someoneElse.live_value < someoneElse.auction_value, 'remaining players should cost less after this deflation');
  assert.equal(byId(after.players, ids.rb1).sold, true);
  assert.equal(byId(after.players, ids.rb1).live_value, null);
});

test('a player selling below book value leaves spare money in the room, inflating remaining prices', () => {
  const ids = seedPool();
  const draftId = makeDraft();
  initAuctionDraft(draftId, { budget: 200, rosterSize: 16 });
  const before = liveAuctionValues(draftId);
  const starRb = byId(before.players, ids.rb1);

  recordSale(draftId, ids.rb1, 1, Math.max(1, starRb.auction_value - Math.floor(starRb.auction_value * 0.7)));

  const after = liveAuctionValues(draftId);
  assert.ok(after.inflation_pct > 0, 'a bargain sale should inflate the room (more $ left per unit of remaining value)');
  const someoneElse = byId(after.players, ids.rb2);
  assert.ok(someoneElse.live_value > someoneElse.auction_value);
});

test('recordSale rejects a price below the real $1 minimum bid', () => {
  const ids = seedPool();
  const draftId = makeDraft();
  initAuctionDraft(draftId, { budget: 200, rosterSize: 16 });
  assert.throws(() => recordSale(draftId, ids.rb1, 1, 0), /price must be/);
});

test('re-selling the same player (a correction) overwrites rather than double-counts spend', () => {
  const ids = seedPool();
  const draftId = makeDraft();
  initAuctionDraft(draftId, { budget: 200, rosterSize: 16 });
  recordSale(draftId, ids.rb1, 1, 40);
  recordSale(draftId, ids.rb1, 1, 55);
  const live = liveAuctionValues(draftId);
  assert.equal(live.sales.length, 1);
  assert.equal(live.spent, 55);
});

test('liveAuctionValues on an unconfigured draft falls back to sane defaults instead of throwing', () => {
  seedPool();
  const draftId = makeDraft(12, 16); // team_count=12
  const live = liveAuctionValues(draftId);
  assert.equal(live.total_budget, 12 * 200); // default budget of $200/team
});

test('liveAuctionValues on a missing draft throws a 404-shaped error', () => {
  assert.throws(() => liveAuctionValues(999999), /draft not found/);
});
