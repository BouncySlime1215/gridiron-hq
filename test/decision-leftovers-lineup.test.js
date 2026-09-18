/**
 * Start/Sit and the matchup card, on one synthetic ESPN league.
 *
 * Decision-leftovers item, journeys J1 and J5 (docs/tdd/decision-leftovers.tdd.md):
 *   J1  Start/Sit (lineup-brain.js#lineupCall) never starts, benches-against or lists a
 *       player on IR — ESPN's IR slot (lineupSlotId 21) or ESPN status INJURY_RESERVE,
 *       the rule waiver-wire.js, lineup-posture.js and the League Hub card already use.
 *   J5  The matchup card (lineup-posture.js#lineupPosture) prices players with the same
 *       week number Start/Sit uses, betting-line lift included, so "You" on the card and
 *       the Start/Sit projection agree.
 *
 * The asset universe and the betting-line lift are mocked so every number is known in
 * closed form; the lineup solver, roster loading and slot rules are the real ones.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-leftovers-lineup-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const realWaiverBrain = await import('../server/services/waiver-brain.js');

let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 2 }),
    // The real lineupDiff would build the real universe; the submitted-lineup
    // comparison has its own tests and is not what these journeys are about.
    lineupDiff: () => ({ error: 'not under test' })
  }
});
// The betting-line game-script lift, by NFL team: HI teams get +20%, LO teams -20%.
const LIFT = { HI: 1.2, LO: 0.8 };
mock.module('../server/services/waiver-brain.js', {
  namedExports: {
    ...realWaiverBrain,
    vegasLift: p => (LIFT[p?.team_abbr]
      ? { multiplier: LIFT[p.team_abbr], applied: true, line: { spread: -3, total: 47 }, reading: null }
      : { multiplier: 1, line: null, applied: false })
  }
});

const { lineupCall } = await import('../server/services/lineup-brain.js');
const { lineupPosture } = await import('../server/services/lineup-posture.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
/** One priced player plus his ESPN roster entry. */
function player(name, position, week, { team = 'MID', slot = 20, status = 'ACTIVE', ros = week } = {}) {
  const id = nextId++;
  const asset = {
    id, name, position, team_abbr: team, espn_id: 5000 + id, available: true,
    current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: ros,
    ceiling: +(week * 1.5).toFixed(2), floor: +(week * 0.5).toFixed(2),
    active_probability: 0.95, bye: 9
  };
  const entry = {
    lineupSlotId: slot,
    playerPoolEntry: { player: { id: 5000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: status } }
  };
  return { asset, entry };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 700;
/** Inserts a synced ESPN league with two teams meeting in week 2. */
function league(mine, theirs) {
  const id = leagueSeq++;
  assets = new Map([...mine, ...theirs].map(p => [p.asset.id, p.asset]));
  const payload = {
    teams: [
      { id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } },
      { id: 2, name: 'Theirs', roster: { entries: theirs.map(p => p.entry) } }
    ],
    schedule: [{ matchupPeriodId: 2, home: { teamId: 1 }, away: { teamId: 2 } }]
  };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Decision leftovers', '1', 10, 1, ?, ?)`,
  id, `dl-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

/** A full, legal roster on my side; the IR players are the two best by projection. */
function myRoster() {
  return [
    player('Quarterback One', 'QB', 20, { team: 'HI' }),
    player('Quarterback Two', 'QB', 15),
    player('Back One', 'RB', 14),
    player('Back Two', 'RB', 12),
    player('Back Three', 'RB', 5),
    player('Wideout One', 'WR', 16),
    player('Wideout Two', 'WR', 13, { team: 'LO' }),
    player('Wideout Three', 'WR', 6),
    player('Tight End One', 'TE', 9),
    // In ESPN's IR slot. ESPN even lists him ACTIVE: he still cannot score for this
    // team until he is moved out of the IR slot, which uses up a bench spot.
    player('Irslot Receiver', 'WR', 30, { slot: 21, status: 'ACTIVE' }),
    // On the bench, but ESPN has him on injured reserve.
    player('Reserve Back', 'RB', 25, { slot: 20, status: 'INJURY_RESERVE' })
  ];
}
function theirRoster() {
  return [
    player('Rival Quarterback', 'QB', 18, { team: 'HI' }),
    player('Rival Back A', 'RB', 13), player('Rival Back B', 'RB', 11),
    player('Rival Wideout A', 'WR', 14, { team: 'LO' }), player('Rival Wideout B', 'WR', 12),
    player('Rival Tight End', 'TE', 7), player('Rival Flex', 'RB', 9)
  ];
}

const IR_NAMES = new Set(['Irslot Receiver', 'Reserve Back']);
const namesIn = call => [
  ...call.lineup.map(c => c.player.name),
  ...call.lineup.map(c => c.over?.name).filter(Boolean),
  ...call.bench.map(b => b.name)
];

for (const objective of ['mean', 'ceiling', 'floor']) {
  test(`J1 Start/Sit (${objective}) never starts, benches-against or lists a player on IR`, () => {
    const lg = league(myRoster(), theirRoster());
    const call = lineupCall(lg.id, { objective, providers: {} });
    assert.ifError(call.error);
    const leaked = namesIn(call).filter(n => IR_NAMES.has(n));
    assert.deepEqual(leaked, [], `IR players leaked into the ${objective} lineup: ${leaked.join(', ')}`);
    // The seven healthy starters, on the Start/Sit basis.
    assert.equal(call.lineup.length, 7);
    assert.ok(call.lineup.every(c => c.player), 'every slot is filled from the healthy roster');
  });
}

test('J1 IR players are reported by name with the reason, not silently dropped', () => {
  const lg = league(myRoster(), theirRoster());
  const call = lineupCall(lg.id, { providers: {} });
  assert.ok(Array.isArray(call.on_ir), 'lineupCall returns an on_ir list');
  assert.deepEqual(call.on_ir.map(p => p.name).sort(), ['Irslot Receiver', 'Reserve Back']);
  for (const p of call.on_ir) assert.match(p.why, /IR/);
});

test('J1 the mean lineup is the best HEALTHY lineup, at the Start/Sit week points', () => {
  const lg = league(myRoster(), theirRoster());
  const call = lineupCall(lg.id, { providers: {} });
  // QB1 20 x 1.2 = 24; RB 14 + 12; WR 16 + 13 x 0.8 = 10.4; TE 9; FLEX = WR3 6 vs RB3 5
  // vs WR2... WR2 is a starter, so FLEX is Wideout Three at 6.
  assert.equal(call.projected_points, +(24 + 14 + 12 + 16 + 10.4 + 9 + 6).toFixed(2));
});

test('J5 the matchup card\'s "You" total equals the Start/Sit projection, lift included', () => {
  const lg = league(myRoster(), theirRoster());
  const call = lineupCall(lg.id, { providers: {} });
  const card = lineupPosture(lg, {});
  assert.ifError(card.error);
  assert.equal(card.my_projection, +call.projected_points.toFixed(1));
  // Same starters on both pages.
  assert.deepEqual(card.lineup.map(x => x.player).sort(), call.lineup.map(c => c.player.name).sort());
  // The lifted quarterback is priced at his lifted number on the card too.
  const qb = card.lineup.find(x => x.player === 'Quarterback One');
  assert.equal(qb.ppg, 24);
});

test('J5 the opponent is priced on the same basis, so the edge is like-for-like', () => {
  const lg = league(myRoster(), theirRoster());
  const card = lineupPosture(lg, {});
  // Rival QB 18 x 1.2 = 21.6; RB 13 + 11; WR 14 x 0.8 = 11.2 and 12; TE 7; FLEX 9.
  assert.equal(card.opponent_projection, +(21.6 + 13 + 11 + 11.2 + 12 + 7 + 9).toFixed(1));
});

test('J5 a lift that changes who starts changes it on both pages', () => {
  // The FLEX is between Low Back (11 before the line, 11 x 0.8 = 8.8 after) and Plain
  // Back (10, no line). Start/Sit starts Plain Back; the card must too.
  const mine = myRoster();
  mine.push(player('Low Back', 'RB', 11, { team: 'LO' }), player('Plain Back', 'RB', 10));
  const lg = league(mine, theirRoster());
  const call = lineupCall(lg.id, { providers: {} });
  const card = lineupPosture(lg, {});
  const s = call.lineup.map(c => c.player.name);
  assert.ok(s.includes('Plain Back') && !s.includes('Low Back'), `Start/Sit FLEX: ${s.join(', ')}`);
  assert.deepEqual(card.lineup.map(x => x.player).sort(), [...s].sort());
  assert.equal(card.my_projection, +call.projected_points.toFixed(1));
});
