/**
 * The lineup surfaces must agree while their rules live in more than one place.
 *
 * Two rules are written more than once (review-fixes, coding-standards findings):
 *   - this week's number: lineup-brain.js#startSitWeekPoints (Start/Sit, the matchup
 *     card) and trade-engine.js#lineupDiffWeekPoints (the League Hub card), kept
 *     separate because trade-engine cannot import lineup-brain without a cycle. "If
 *     the two drift, the League Hub card and the Start/Sit tab name different lineups";
 *   - "is he on IR": lineup-brain.js#irOnRoster, lineup-posture.js#rosterAssets,
 *     trade-engine.js#lineupDiff and waiver-wire.js each test ESPN's IR slot (21) or
 *     status INJURY_RESERVE themselves.
 * Consolidating them into one leaf module is deferred (it also means moving the
 * betting-line mocks in three other test files); until then these tests fail the
 * moment any copy drifts. ESPN only: Sleeper's `reserve` list is read by irOnRoster
 * alone, and the other surfaces do not support Sleeper rosters.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-surfaces-agree-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');

// The betting-line lift, by NFL team, through the REAL vegasLift: the game-script model
// is mocked underneath it, so every surface gets the same lift the way it would in
// production. (Mocking waiver-brain.js#vegasLift instead does not reach trade-engine:
// waiver-brain imports trade-engine, which binds the real waiver-brain first — the
// import cycle the same finding reports.)
const LIFT = { HI: 1.2, LO: 0.8 };
const realGameScript = await import('../server/services/gamescript.js');
mock.module('../server/services/gamescript.js', {
  namedExports: {
    ...realGameScript,
    gameScriptFor: team => (LIFT[team]
      ? { pass_mult: LIFT[team], rush_mult: LIFT[team], line: { spread: -3, total: 47, opponent: 'OPP', home: true } }
      : { pass_mult: 1, rush_mult: 1, line: null })
  }
});
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { lineupDiff } = await import('../server/services/trade-engine.js');
const { startSitWeekPoints, irOnRoster } = await import('../server/services/lineup-brain.js');
const { rosterAssets } = await import('../server/services/lineup-posture.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, BENCH: 20, IR: 21 };
let nextId = 1;
function player(name, position, week, { slot = position, status = 'ACTIVE', team = 'MID' } = {}) {
  const id = nextId++;
  return {
    asset: { id, name, position, team_abbr: team, espn_id: 4000 + id, available: true, current_week_ppg: week,
      adj_ppg: week, ppg: week, active_probability: 0.95, bye: 9, matchup: { opponent: 'OPP' } },
    entry: { lineupSlotId: SLOT_ID[slot],
      playerPoolEntry: { player: { id: 4000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: status } } }
  };
}
function league(roster) {
  const payload = { teams: [{ id: 1, roster: { entries: roster.map(p => p.entry) } }] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (81, 'espn', 'sa-81', 2026, 'Agree', '1', 10, 1, ?, ?)`, JSON.stringify(['QB', 'RB', 'RB', 'WR', 'TE']), JSON.stringify(payload));
  return { lg: db.prepare('SELECT * FROM leagues WHERE id = 81').get(), payload,
    assets: new Map(roster.map(p => [p.asset.id, p.asset])) };
}
const roster = [
  player('Lifted Quarterback', 'QB', 17.37, { team: 'HI' }),
  player('Sunk Back', 'RB', 13.11, { team: 'LO' }),
  player('Plain Back', 'RB', 11.05),
  player('Bench Back', 'RB', 12.99, { slot: 'BENCH', team: 'HI' }),
  player('Wideout', 'WR', 14.2, { team: 'LO' }),
  player('Tight End', 'TE', 7.7),
  player('Parked Receiver', 'WR', 25, { slot: 'IR', status: 'ACTIVE' }),
  player('Reserve Back', 'RB', 22, { slot: 'BENCH', status: 'INJURY_RESERVE' })
];
const { lg, payload, assets } = league(roster);

test('the League Hub card prices every player exactly as Start/Sit does', () => {
  const d = lineupDiff(lg, '1', { assets });
  assert.ifError(d.error);
  const priced = d.optimal.filter(s => s.player).map(s => s.player);
  assert.ok(priced.length >= 5);
  for (const p of priced) {
    const asset = assets.get(p.id);
    assert.equal(p.week_points, startSitWeekPoints(asset, 2026, 2).week_points, p.name);
  }
  // The lift is really in play: the benched HI back outscores the LO starter.
  assert.equal(d.swaps[0]?.in.name, 'Bench Back');
});

test('every surface agrees on who is on IR', () => {
  const players = [...assets.values()];
  const onIr = [...irOnRoster(lg, '1', players).keys()].map(id => assets.get(id).name).sort();
  assert.deepEqual(onIr, ['Parked Receiver', 'Reserve Back'], 'Start/Sit (irOnRoster)');
  const posture = rosterAssets(payload, assets, '1').map(p => p.name);
  assert.deepEqual(players.filter(p => !posture.includes(p.name)).map(p => p.name).sort(), onIr, 'matchup card');
  const d = lineupDiff(lg, '1', { assets });
  const named = new Set([...d.optimal.map(s => s.player?.name), ...d.swaps.map(s => s.in.name)]);
  assert.ok(onIr.every(n => !named.has(n)), 'League Hub card');
  assert.deepEqual(d.activate_from_ir.map(p => p.name), ['Parked Receiver'], 'ESPN lists him ACTIVE in the IR slot');
});
