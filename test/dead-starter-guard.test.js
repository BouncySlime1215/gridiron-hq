/**
 * SS-01 dead-starter guard: GET /api/trades/:leagueId/lineup serves `dead_starters`.
 *
 * The rule: before his kickoff, any player SET IN A STARTING SLOT ON ESPN who is Out,
 * Doubtful, on IR, on bye or on the gameday inactive list is flagged, with the best
 * healthy bench player who can legally fill that slot (highest Start/Sit week_points).
 * Suggestion only: nothing is applied.
 *
 * Fixtures follow test/lineup-floor-objective.test.js: the asset universe is mocked;
 * roster loading, slot rules and the kickoff lookup (game_lines) are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-dead-starters-'));
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
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, BENCH: 20, IR: 21 };
let nextId = 1;
/** One rostered player: `slot` is where he is set on ESPN. */
function player(name, position, slot, week, { espn = 'ACTIVE', report = null, bye = 9, team = 'MID', available = true } = {}) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: team, espn_id: 9000 + id, available,
      current_week_ppg: bye === 2 ? 0 : week, adj_ppg: week, ppg: week, ros_ppg: week,
      ceiling: week * 1.5, floor: week * 0.4, active_probability: 0.9, bye, injury_status: report
    },
    entry: {
      lineupSlotId: SLOT_ID[slot],
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: espn } }
    }
  };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 900;
function league(mine, platform = 'espn') {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = platform === 'espn'
    ? { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] }
    : { users: [{ user_id: 'u1', display_name: 'Mine' }],
      rosters: [{ roster_id: 1, owner_id: 'u1', players: mine.map(p => p.asset.sleeper_id).filter(Boolean), starters: [] }] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, ?, ?, 2026, 'Dead starters', '1', 10, 1, ?, ?)`,
  id, platform, `ds-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return id;
}

/** A clean ESPN lineup plus a bench; the caller breaks it. */
function roster(over = {}) {
  return [
    player('Quarterback', 'QB', 'QB', 20),
    over.rb1 ?? player('Back One', 'RB', 'RB', 15),
    player('Back Two', 'RB', 'RB', 12),
    player('Wideout One', 'WR', 'WR', 14),
    over.wr2 ?? player('Wideout Two', 'WR', 'WR', 11),
    player('Tight End', 'TE', 'TE', 8),
    player('Flex Back', 'RB', 'FLEX', 9),
    // bench
    player('Bench Back', 'RB', 'BENCH', 10),
    player('Doubtful Bench Back', 'RB', 'BENCH', 13, { espn: 'DOUBTFUL' }),
    player('Bench Wideout', 'WR', 'BENCH', 7),
    player('Deep Bench Wideout', 'WR', 'BENCH', 4),
    ...(over.extra ?? [])
  ];
}

const byName = ds => Object.fromEntries((ds?.items ?? []).map(i => [i.player.name, i]));
const NOW = Date.parse('2026-09-20T12:00:00Z'); // Sunday of week 2, before the 1:00 pm ET games

test('RED acceptance: an Out starter and a bye starter are both flagged, each with the best healthy bench replacement', () => {
  const id = league(roster({
    rb1: player('Out Back', 'RB', 'RB', 15, { espn: 'OUT' }),
    wr2: player('Bye Wideout', 'WR', 'WR', 11, { bye: 2 })
  }));
  const call = lineupCall(id, { providers: {}, now: NOW });
  assert.ifError(call.error);
  const ds = call.dead_starters;
  assert.ok(ds, 'the lineup payload carries dead_starters');
  assert.equal(ds.covered, true);
  const items = byName(ds);
  assert.deepEqual(Object.keys(items).sort(), ['Bye Wideout', 'Out Back']);
  assert.equal(items['Out Back'].reason, 'out');
  assert.equal(items['Out Back'].slot, 'RB');
  assert.equal(items['Out Back'].replacement?.name, 'Bench Back', 'the Doubtful 13-pointer is not healthy, so the 10 starts');
  assert.equal(items['Bye Wideout'].reason, 'bye');
  assert.equal(items['Bye Wideout'].replacement?.name, 'Bench Wideout');
  assert.equal(ds.applied, false, 'a suggestion, never applied');
});

test('a clean lineup raises nothing, and says it checked', () => {
  const id = league(roster());
  const ds = lineupCall(id, { providers: {}, now: NOW }).dead_starters;
  assert.equal(ds.covered, true);
  assert.equal(ds.items.length, 0);
  assert.equal(ds.starters_checked, 7);
});

test('Doubtful on the injury report, IR status and the season-ending list are dead; Questionable is not', () => {
  const id = league(roster({
    rb1: player('Report Doubtful Back', 'RB', 'RB', 15, { report: 'Doubtful' }),
    wr2: player('Questionable Wideout', 'WR', 'WR', 11, { espn: 'QUESTIONABLE', report: 'Questionable' }),
    extra: []
  }));
  const items = byName(lineupCall(id, { providers: {}, now: NOW }).dead_starters);
  assert.equal(items['Report Doubtful Back']?.reason, 'doubtful');
  assert.equal(items['Report Doubtful Back']?.source, 'injury_report');
  assert.equal(items['Questionable Wideout'], undefined);

  const id2 = league([
    player('IR Quarterback', 'QB', 'QB', 20, { espn: 'INJURY_RESERVE' }),
    player('Released Back', 'RB', 'RB', 15, { available: false }),
    player('Back Two', 'RB', 'RB', 12), player('Wideout One', 'WR', 'WR', 14), player('Wideout Two', 'WR', 'WR', 11),
    player('Tight End', 'TE', 'TE', 8), player('Flex Back', 'RB', 'FLEX', 9),
    player('Bench Quarterback', 'QB', 'BENCH', 16), player('Bench Back', 'RB', 'BENCH', 10)
  ]);
  const items2 = byName(lineupCall(id2, { providers: {}, now: NOW }).dead_starters);
  assert.equal(items2['IR Quarterback']?.reason, 'ir');
  assert.equal(items2['IR Quarterback']?.replacement?.name, 'Bench Quarterback');
  assert.equal(items2['Released Back']?.reason, 'out_for_season');
  assert.equal(items2['Released Back']?.replacement?.name, 'Bench Back');
});

test('two dead starters never get the same replacement, and FLEX takes what the RB slot left', () => {
  // ESPN lists the FLEX entry first here, so a solver that fills slots in entry order
  // would hand the FLEX the only healthy back.
  const base = roster({ rb1: player('Out Back', 'RB', 'RB', 15, { espn: 'OUT' }), extra: [] })
    .filter(p => p.asset.name !== 'Flex Back');
  const id = league([player('Out Flex Back', 'RB', 'FLEX', 9, { espn: 'OUT' }), ...base]);
  const items = byName(lineupCall(id, { providers: {}, now: NOW }).dead_starters);
  assert.equal(items['Out Back']?.replacement?.name, 'Bench Back');
  assert.equal(items['Out Flex Back']?.replacement?.name, 'Bench Wideout', 'the next healthy flex-eligible player');
});

test('kickoff window: a starter whose game has kicked off is not flagged, and a kicked-off bench player is not offered', () => {
  run(`INSERT INTO game_lines (season, week, team, gameday, gametime) VALUES (2026, 2, 'EAR', '2026-09-20', '09:30')`);
  run(`INSERT INTO game_lines (season, week, team, gameday, gametime) VALUES (2026, 2, 'MID', '2026-09-20', '13:00')`);
  const id = league(roster({
    rb1: player('Early Out Back', 'RB', 'RB', 15, { espn: 'OUT', team: 'EAR' }),
    wr2: player('Out Wideout', 'WR', 'WR', 11, { espn: 'OUT' }),
    extra: [player('Early Bench Wideout', 'WR', 'BENCH', 12, { team: 'EAR' })]
  }));
  // 12:00Z is 8:00 am ET: neither game has started.
  const ds = lineupCall(id, { providers: {}, now: NOW }).dead_starters;
  const items = byName(ds);
  assert.equal(items['Early Out Back']?.replacement?.name, 'Bench Back');
  assert.equal(items['Early Out Back']?.kickoff, '2026-09-20T13:30:00.000Z');
  assert.equal(items['Out Wideout']?.replacement?.name, 'Early Bench Wideout');

  // 15:00Z is 11:00 am ET: the 9:30 game is under way.
  const later = byName(lineupCall(id, { providers: {}, now: Date.parse('2026-09-20T15:00:00Z') }).dead_starters);
  assert.equal(later['Early Out Back'], undefined, 'his game kicked off at 13:30Z: locked, nothing to do');
  assert.equal(later['Out Wideout']?.replacement?.name, 'Bench Wideout', 'the kicked-off bench wideout is not offered');
  assert.equal(later['Out Wideout']?.kickoff, '2026-09-20T17:00:00.000Z');
  assert.equal(ds.kickoff_basis, 'game_cutoff');
});

test('gameday inactives: the hook reports not covered until RL-3-2 lands', () => {
  const id = league(roster());
  const ds = lineupCall(id, { providers: {}, now: NOW }).dead_starters;
  assert.equal(ds.inactive_source.covered, false);
  assert.match(ds.inactive_source.reason, /RL-3-2/);

  // The hook's contract: a covered source listing a starter flags him as inactive.
  const target = [...assets.values()].find(a => a.name === 'Wideout One');
  const hooked = lineupCall(id, { providers: {}, now: NOW,
    inactive: { covered: true, source: 'fixture', reason: null, ids: new Set([target.id]) } }).dead_starters;
  assert.equal(byName(hooked)['Wideout One']?.reason, 'inactive');
  assert.equal(byName(hooked)['Wideout One']?.replacement?.name, 'Bench Wideout');
});

test('a Sleeper league says the guard does not cover it rather than implying a clean lineup', () => {
  const qb = player('Sleeper Quarterback', 'QB', 'QB', 20);
  qb.asset.sleeper_id = 'S1';
  const id = league([qb], 'sleeper');
  const call = lineupCall(id, { providers: {}, now: NOW });
  assert.ifError(call.error);
  assert.equal(call.dead_starters.covered, false);
  assert.equal(call.dead_starters.items.length, 0);
  assert.match(call.dead_starters.reason, /ESPN only/);
});
