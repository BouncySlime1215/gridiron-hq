/**
 * "Protect the floor" must never hand back an arbitrary lineup.
 *
 * At 2026 week 2 every player's floor (the 10th percentile of his week, trade-engine.js
 * floor = weekDist.p10) is 0: a did-not-play week scores 0 and every live chance to play
 * is 0.9 or less. The floor objective then ties every player, the solver keeps roster
 * order, and the page printed "Week 2 projection 0" with every margin a +0 coin flip —
 * league 1 benched Mahomes for Caleb Williams and Jacobs for Javonte Williams.
 *
 * Rules pinned here:
 *   - an objective that cannot rank anyone (every startable skill player has the same
 *     value) is not solved on; the lineup is solved on week_points and says so;
 *   - exact ties on the requested key are broken by week_points, never by roster order;
 *   - when the key does rank players, the floor lineup is exactly what it was.
 *
 * Fixtures follow test/decision-leftovers-lineup.test.js: the asset universe is mocked,
 * the solver, roster loading and slot rules are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-floor-objective-'));
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
    lineupDiff: () => ({ error: 'not under test' })
  }
});
mock.module('../server/services/waiver-brain.js', {
  namedExports: { ...realWaiverBrain, vegasLift: () => ({ multiplier: 1, line: null, applied: false }) }
});

const { lineupCall } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(name, position, week, floor, ceiling = week * 1.5) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: 'MID', espn_id: 9000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
      ceiling: +ceiling.toFixed(2), floor, active_probability: 0.85, bye: 9
    },
    entry: {
      lineupSlotId: 20,
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } }
    }
  };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 800;
function league(mine) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Floor objective', '1', 10, 1, ?, ?)`,
  id, `fo-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return id;
}

const starters = call => Object.fromEntries(call.lineup.map(c => [c.player.name, c.slot]));

/** Roster order puts the weaker player first at QB, RB and WR, as ESPN often does. */
function allZeroFloors() {
  return [
    player('Backup Quarterback', 'QB', 13.9, 0), player('Star Quarterback', 'QB', 22.4, 0),
    player('Backup Back', 'RB', 6.1, 0), player('Back One', 'RB', 15.2, 0), player('Back Two', 'RB', 12.8, 0),
    player('Backup Wideout', 'WR', 5.5, 0), player('Wideout One', 'WR', 16.0, 0), player('Wideout Two', 'WR', 11.7, 0),
    player('Tight End', 'TE', 8.3, 0)
  ];
}

test('every floor 0: the floor lineup is solved on week_points and says so', () => {
  const id = league(allZeroFloors());
  const mean = lineupCall(id, { objective: 'mean', providers: {} });
  const floor = lineupCall(id, { objective: 'floor', providers: {} });
  assert.ifError(floor.error);
  assert.equal(floor.objective, 'floor', 'the request is echoed');
  assert.equal(floor.objective_used, 'week_points', 'a key that ranks no one is not optimised');
  assert.match(floor.objective_fallback ?? '', /floor/i);
  assert.equal(floor.confidence_basis, 'calibrated_on_week_points');
  assert.deepEqual(starters(floor), starters(mean), 'the fallback lineup is the mean lineup');
  assert.ok(floor.projected_points > 0, `projected_points ${floor.projected_points} must not be 0`);
  assert.equal(starters(floor)['Star Quarterback'], 'QB');
  assert.equal(starters(floor)['Backup Quarterback'], undefined);
});

test('exact floor ties are broken by week_points, never by roster order', () => {
  const roster = allZeroFloors();
  // RBs and WRs rank on floor; the two QBs still tie at 0.
  for (const p of roster) {
    if (p.asset.position === 'RB' || p.asset.position === 'WR') p.asset.floor = +(p.asset.current_week_ppg * 0.4).toFixed(2);
  }
  const id = league(roster);
  const floor = lineupCall(id, { objective: 'floor', providers: {} });
  assert.equal(floor.objective_used, 'floor', 'the key ranks some players, so it is optimised');
  assert.equal(floor.objective_fallback, null);
  assert.equal(starters(floor)['Star Quarterback'], 'QB', 'the 22.4 quarterback starts, not the first one listed');
  const qb = floor.lineup.find(c => c.slot === 'QB');
  assert.equal(qb.over?.name, 'Backup Quarterback');
});

test('when floors rank the players, the floor lineup is exactly the floor-optimal one', () => {
  const roster = [
    player('Steady Quarterback', 'QB', 18.0, 9.0), player('Boom Quarterback', 'QB', 20.0, 4.0),
    player('Back One', 'RB', 15.0, 6.0), player('Back Two', 'RB', 12.0, 5.5), player('Back Three', 'RB', 10.0, 7.0),
    player('Wideout One', 'WR', 16.0, 5.0), player('Wideout Two', 'WR', 11.0, 4.5), player('Wideout Three', 'WR', 9.0, 4.8),
    player('Tight End', 'TE', 8.0, 3.0)
  ];
  const id = league(roster);
  const floor = lineupCall(id, { objective: 'floor', providers: {} });
  assert.equal(floor.objective_used, 'floor');
  assert.equal(floor.objective_fallback, null);
  assert.equal(starters(floor)['Steady Quarterback'], 'QB', 'the higher floor starts even with a lower mean');
  assert.equal(starters(floor)['Back Three'] !== undefined, true, 'the 7.0-floor back starts');
  assert.equal(floor.projected_points, +(9 + 7 + 6 + 5 + 4.8 + 3 + 5.5).toFixed(2));
});

test('the page repeats what confidence_basis says, instead of leaving it on the wire', () => {
  // Clear / Lean / Coin flip are thresholds on a MEAN weekly margin. On a
  // ceiling or floor view the same chips are drawn from a wider, differently
  // shaped quantity, and the server has said so in `confidence_basis` since the
  // objectives shipped — to a page that never read it. The chips looked equally
  // trustworthy on all three views, which is the same defect as an unlabelled
  // percentage: the reader cannot tell a calibrated call from an uncalibrated
  // one from the label alone.
  const src = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  assert.match(src, /confidence_basis/, 'the page reads the field');
  assert.match(src, /startsWith\('uncalibrated_for_'\)/,
    'and branches on the uncalibrated case rather than printing the raw string');
  assert.match(src, /set on average weekly points/, 'and says what the labels are calibrated on');
  assert.match(src, /objective_held_out/,
    'and names anyone who could not be ranked on the objective actually requested');
});

/**
 * The K/D-ST disclosure has to be ON THE RESPONSE, not merely computed.
 *
 * Found by mutation rather than by design: deleting `slots_not_modelled` from the
 * object `lineupCall` returns left all 34 tests across this PR's four files green.
 * `slotsNotModelled` itself is covered nine ways over in
 * test/lineup-slots-not-modelled.test.js — but that file calls the pure function
 * directly and never the surface, so the field could be computed correctly and
 * dropped on the way out with nothing failing. That is this repository's standing
 * failure shape, and this is the disclosure that stops Start/Sit rendering a
 * seven-slot lineup for a nine-slot league in silence.
 *
 * The expected slots are written out by hand. Deriving them from the league row
 * would pass the exact defect this exists to catch.
 */
test('the slots nobody models reach the caller, with the sentence that explains them', () => {
  const roster = allZeroFloors();
  const id = leagueSeq++;
  assets = new Map(roster.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: roster.map(p => p.entry) } }], schedule: [] };
  // The same seven modelled slots, plus the two every one of the real leagues starts.
  const positions = [...SLOTS, 'DEF', 'K', 'BENCH', 'BENCH', 'IR'];
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Kicker and defence', '1', 10, 1, ?, ?)`,
  id, `kd-${id}`, JSON.stringify(positions), JSON.stringify(payload));

  const call = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ifError(call.error);
  assert.deepEqual(call.slots_not_modelled, [{ slot: 'DEF', count: 1 }, { slot: 'K', count: 1 }],
    'the response carries the two slots the solver never priced');
  assert.match(String(call.slots_not_modelled_reason ?? ''), /\S/,
    'and the sentence saying why, because a bare list reads as a failure rather than a scope');
  assert.equal(call.lineup.length, 7, 'the lineup itself is unchanged: this names the gap, it does not close it');

  // Bench and IR depth must never appear here — it is not a starting slot, and
  // reporting it would turn a real disclosure into noise nobody reads.
  const named = call.slots_not_modelled.map(s => s.slot);
  for (const depth of ['BENCH', 'IR']) {
    assert.equal(named.includes(depth), false, `${depth} is depth, not a starting slot`);
  }
});
