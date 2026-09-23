/**
 * The waiver board's cut, and who it offers.
 *
 * Decision-leftovers item, journeys J2 and J3 (docs/tdd/decision-leftovers.tdd.md):
 *   J2  An immediate claim never cuts a player whose rest-of-season value is higher
 *       than the claim's, and never lowers the rest-of-season lineup. The cut is the
 *       one that keeps this week's gain and costs the season least. It used to be the
 *       bench player with the lowest THIS-WEEK number, so one bad game (Jaylen Waddle,
 *       1.2 in week 1) made a good player the suggested cut.
 *   J3  Free agents with no NFL team are not offered as stashes (or anything else):
 *       they cannot score until someone signs them.
 *
 * The asset universe is mocked so every number is known; the lineup solver and slot
 * rules are the real ones from trade-engine.js.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-leftovers-waivers-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const { bestLineup } = realTradeEngine;
let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 2 })
  }
});
const { waiverBoard } = await import('../server/services/waiver-wire.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let nextId = 1;
const p = (name, position, week, ros, extra = {}) => ({
  id: nextId++, name, position, team_abbr: 'NYJ', current_week_ppg: week, adj_ppg: week,
  ppg: week, ros_ppg: ros, available: true, active_probability: 0.95, espn_id: 4000 + nextId, ...extra
});
// ESPN payload entries always carry the player's ESPN id and position id; the board
// resolves by id first (RL-6-4, trade-engine.js#espnPlayerResolver).
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };

/**
 * My roster. This week: QB 20, RB 15 + 12, WR 15 + 11, TE 8, FLEX Back Three 9 = 90.
 * Rest of season: the same, but the FLEX is Waddle at 10 (Back Three is 9) = 91.
 * Bench this week: Waddle (2 this week after one bad game, 10 rest of season), Corum
 * (3 / 4) and a backup quarterback (14 / 13).
 */
function myRoster(extra = []) {
  return [
    p('Starting QB', 'QB', 20, 20), p('Back One', 'RB', 15, 15), p('Back Two', 'RB', 12, 12),
    p('Wideout One', 'WR', 15, 15), p('Wideout Two', 'WR', 11, 11), p('Tight End', 'TE', 8, 8),
    p('Back Three', 'RB', 9, 9),
    p('Jaylen Waddle', 'WR', 2, 10), p('Blake Corum', 'RB', 3, 4), p('Backup QB', 'QB', 14, 13),
    ...extra
  ];
}

function board(mine, free) {
  assets = new Map([...mine, ...free].map(a => [a.id, a]));
  const payload = {
    teams: [{ id: 1, roster: { entries: mine.map(a => ({
      lineupSlotId: a.slot ?? 20,
      playerPoolEntry: { player: { id: a.espn_id, fullName: a.name, defaultPositionId: POS_ID[a.position],
        injuryStatus: a.espn_status ?? 'ACTIVE' } }
    })) } }]
  };
  const lg = { id: 1, platform: 'espn', team_count: 10, ppr: 1, my_team_id: '1',
    roster_positions: JSON.stringify(SLOTS), payload: JSON.stringify(payload) };
  return waiverBoard(lg, {});
}

/** Independent recomputation of one claim, from the real solver. */
function recompute(mine, faName, dropName, free) {
  const all = [...mine, ...free];
  const fa = all.find(a => a.name === faName), drop = all.find(a => a.name === dropName);
  const active = mine.filter(a => (a.slot ?? 20) !== 21);
  const after = [...active.filter(a => a.id !== drop.id), fa];
  return {
    week: bestLineup(after, SLOTS, 'current_week_ppg').points - bestLineup(active, SLOTS, 'current_week_ppg').points,
    ros: bestLineup(after, SLOTS, 'ros_ppg').points - bestLineup(active, SLOTS, 'ros_ppg').points,
    dropRos: drop.available === false ? 0 : drop.ros_ppg, claimRos: fa.ros_ppg
  };
}

test('J2 the one-bad-week player is not the cut: Coker is claimed by cutting Corum, not Waddle', () => {
  const mine = myRoster();
  const free = [p('Jalen Coker', 'WR', 13, 9.5)];
  const b = board(mine, free);
  const coker = b.immediate.find(r => r.player === 'Jalen Coker');
  assert.ok(coker, 'Coker still helps this week and is offered');
  assert.equal(coker.drop_candidate.player, 'Blake Corum');
  assert.equal(coker.upgrade, 4, 'the week gain is unchanged: Coker 13 takes the WR spot, Wideout Two moves to FLEX');
});

test('J2 every immediate claim keeps the rest-of-season lineup and never cuts more season value than it adds', () => {
  const mine = myRoster();
  const free = [p('Jalen Coker', 'WR', 13, 9.5), p('Streamer QB', 'QB', 23, 16), p('Hot Back', 'RB', 13.5, 12)];
  const b = board(mine, free);
  assert.ok(b.immediate.length >= 3, `expected three claims, got ${b.immediate.map(r => r.player)}`);
  for (const r of b.immediate) {
    const x = recompute(mine, r.player, r.drop_candidate.player, free);
    assert.ok(x.dropRos <= x.claimRos, `${r.player}: cuts ${r.drop_candidate.player} (${x.dropRos}) worth more than ${x.claimRos}`);
    assert.ok(x.ros >= -1e-9, `${r.player}: rest-of-season lineup falls by ${-x.ros} cutting ${r.drop_candidate.player}`);
    assert.ok(x.week > 0.05, `${r.player}: no week gain cutting ${r.drop_candidate.player}`);
    assert.ok(Math.abs(x.week - r.upgrade) < 0.011, `${r.player}: reported +${r.upgrade}, recomputed +${x.week}`);
  }
});

test('J2 the rule is chosen, not just satisfied: largest week gain, then the least season cost', () => {
  // Streamer QB (23 this week, 16 rest of season) replaces the starting QB this week.
  // Cutting Corum, the backup QB or Waddle all give the same +3 this week. Waddle
  // (10, under 16) passes the value rule but his loss drops the rest-of-season FLEX
  // from 10 to 9, so he is out. The backup QB (13) and Corum (4) cost the
  // rest-of-season lineup nothing; Corum is worth less. So: Corum.
  const mine = myRoster();
  const b = board(mine, [p('Streamer QB', 'QB', 23, 16)]);
  const r = b.immediate.find(x => x.player === 'Streamer QB');
  assert.equal(r.drop_candidate.player, 'Blake Corum');
  assert.equal(r.upgrade, 3);
  assert.equal(r.drop_candidate.ros_ppg, 4, 'the cut carries its rest-of-season number for the card');
  assert.ok(r.ros_change >= 0, 'the claim reports its rest-of-season effect');
});

test('J2 a claim with no safe cut is held back, and says why', () => {
  // A one-week streamer (12 this week, 3 rest of season). Every player he could
  // replace is worth more than 3 over the rest of the season, so there is no cut
  // that keeps the season whole — he is not an immediate claim.
  const mine = myRoster();
  const b = board(mine, [p('One Week Wonder', 'WR', 12, 3)]);
  assert.equal(b.immediate.find(r => r.player === 'One Week Wonder'), undefined);
  const held = (b.held_back ?? []).find(h => h.player === 'One Week Wonder');
  assert.ok(held, 'listed in held_back');
  assert.ok(held.week_upgrade > 0, 'with the gain it would have added');
  assert.match(String(b.drop_rule ?? ''), /rest of season/i, 'the rule is stated in the response');
});

test('J2 a player flagged out for the season is a free cut even with a stale rest-of-season number', () => {
  const mine = myRoster([p('Kenneth Walker III', 'RB', 0, 12, { available: false })]);
  const b = board(mine, [p('One Week Wonder', 'WR', 12, 3)]);
  const r = b.immediate.find(x => x.player === 'One Week Wonder');
  assert.ok(r, 'the season-ending player makes room');
  assert.equal(r.drop_candidate.player, 'Kenneth Walker III');
});

test('J2 IR players are never the cut (unchanged)', () => {
  const mine = myRoster([p('Injured Star', 'WR', 0, 0.5, { slot: 21 })]);
  const b = board(mine, [p('Jalen Coker', 'WR', 13, 9.5)]);
  const coker = b.immediate.find(r => r.player === 'Jalen Coker');
  assert.notEqual(coker.drop_candidate.player, 'Injured Star');
  assert.deepEqual(b.on_ir, ['Injured Star']);
});

test('J3 a free agent with no NFL team is not a stash; the same player on a team is', () => {
  const mine = myRoster();
  const free = [
    p('Tyreek Hill', 'WR', 0, 14, { team_abbr: null }),
    p('Signed Veteran', 'WR', 0, 14),
    // Teamless too, but he would not have made the board anyway (a 5-a-week WR does
    // not improve this rest-of-season lineup), so he is not part of the count.
    p('Teamless Depth', 'WR', 0, 5, { team_abbr: null })
  ];
  const b = board(mine, free);
  const stashNames = b.stashes.map(s => s.player);
  assert.ok(stashNames.includes('Signed Veteran'), `control stash missing: ${stashNames}`);
  assert.ok(!stashNames.includes('Tyreek Hill'), 'teamless free agent offered as a stash');
  assert.ok(![...b.immediate, ...b.stashes].some(r => !r.team), 'no teamless row anywhere on the board');
  // The count is of rows actually taken off the board, not of every unsigned player
  // in the database (on the live copy that was ~300 per league, mostly retired).
  assert.equal(b.teamless_excluded, 1, 'the exclusion is counted, not silent');
});
