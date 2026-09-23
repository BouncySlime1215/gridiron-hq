/**
 * RL-4-2: the Start/Sit tab (lineup-brain.js#lineupCall) must not re-solve a slot
 * whose player's game has kicked off, nor offer a locked bench player as the man a
 * starter "beat". Same lock rule as the League Hub card (lineup-lock.js), same
 * pinned solve (trade-engine.js#pinnedBestLineup). Clock injected (`now`); kickoffs
 * are real game_lines rows read through game-cutoff.js#gameCutoff.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-startsit-locks-'));
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

for (const [team, opp, time] of [['EAR', 'EOP', '13:00'], ['LAT', 'LOP', '16:25']]) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime) VALUES (2026, 2, ?, ?, 1, '2026-09-20', ?)`,
    team, opp, time);
}
const PRE = Date.parse('2026-09-20T16:00:00Z');   // noon ET
const MID = Date.parse('2026-09-20T17:30:00Z');   // 1:30 pm ET: EAR (13:00) locked, LAT (16:25) open

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, BENCH: 20 };
let nextId = 1;
function player(name, position, week, { slot = position, team = 'LAT' } = {}) {
  const id = nextId++;
  return {
    asset: { id, name, position, team_abbr: team, espn_id: 5000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week, active_probability: 0.95, bye: 9 },
    entry: { lineupSlotId: SLOT_ID[slot],
      playerPoolEntry: { player: { id: 5000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } } }
  };
}
let leagueSeq = 600;
function league(mine) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Start/Sit locks', '1', 10, 1, ?, ?)`,
  id, `ssl-${id}`, JSON.stringify(['QB', 'RB', 'WR', 'TE']), JSON.stringify(payload));
  return id;
}
const call = (c, slot) => c.lineup.find(x => x.slot === slot);

const earlyStarterLateBench = () => [
  player('Quarterback', 'QB', 18),
  player('Early Starter', 'RB', 6, { team: 'EAR' }),
  player('Late Bench', 'RB', 16, { slot: 'BENCH' }),
  player('Wideout', 'WR', 14),
  player('Tight End', 'TE', 8)
];

test('control, before kickoff: Start/Sit starts the better late back', () => {
  const id = league(earlyStarterLateBench());
  const c = lineupCall(id, { providers: {}, now: PRE });
  assert.equal(call(c, 'RB').player.name, 'Late Bench');
  assert.equal(call(c, 'RB').over?.name, 'Early Starter');
});

test('after his kickoff the started back holds his slot and the call says locked', () => {
  const id = league(earlyStarterLateBench());
  const c = lineupCall(id, { providers: {}, now: MID });
  const rb = call(c, 'RB');
  assert.equal(rb.player.name, 'Early Starter', 'a locked starter is pinned, not re-solved');
  assert.equal(rb.confidence, 'locked');
  assert.equal(rb.over, null, 'nobody can replace him');
  assert.match(rb.why, /kicked off/);
});

test('a bench player whose game kicked off is never the man a starter "beat", nor a bench option', () => {
  const id = league([
    player('Quarterback', 'QB', 18),
    player('Late Starter', 'RB', 6),
    player('Early Bench', 'RB', 16, { slot: 'BENCH', team: 'EAR' }),
    player('Wideout', 'WR', 14),
    player('Tight End', 'TE', 8)
  ]);
  const c = lineupCall(id, { providers: {}, now: MID });
  const rb = call(c, 'RB');
  assert.equal(rb.player.name, 'Late Starter');
  assert.notEqual(rb.over?.name, 'Early Bench');
  assert.ok(!c.bench.some(b => b.name === 'Early Bench'), 'a locked bench player is not a bench option');
});
