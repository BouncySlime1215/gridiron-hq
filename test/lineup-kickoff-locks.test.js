/**
 * RL-4-2: the League Hub lineup card and the Decision Inbox row it publishes
 * (trade-engine.js#lineupDiff) must never recommend moving a player whose game
 * has already kicked off.
 *
 * All five live leagues lock each player at his own game's kickoff
 * (lineupLocktimeType INDIVIDUAL_GAME). lineupDiff used to solve every slot as if
 * everyone could still move, and gave every inbox row a flat 72-hour expiry, so in
 * 2026 week 2 two rows stayed open 17.2 h and 32.0 h after a player they named had
 * locked. A player is locked when ESPN says so (playerPoolEntry.lineupLocked) or
 * when his game's kickoff (game-cutoff.js#gameCutoff) is at or before `now`.
 *
 * The clock is injected (`now`), the universe is injected (`assets`), and the
 * kickoffs are real game_lines rows read through the real gameCutoff.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-kickoff-locks-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { lineupDiff, bestLineup, pinnedBestLineup } = await import('../server/services/trade-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Week 2, Sunday 2026-09-20 (EDT, UTC-4): EAR kicks off 13:00 ET = 17:00Z, LAT 16:25 ET = 20:25Z.
for (const [team, opp, time] of [['EAR', 'EOP', '13:00'], ['LAT', 'LOP', '16:25']]) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime) VALUES (2026, 2, ?, ?, 1, '2026-09-20', ?)`,
    team, opp, time);
}
const EARLY_KICKOFF = Date.parse('2026-09-20T17:00:00Z');
const LATE_KICKOFF = Date.parse('2026-09-20T20:25:00Z');
const PRE = Date.parse('2026-09-20T16:00:00Z');   // noon ET, nobody locked
const MID = Date.parse('2026-09-20T17:30:00Z');   // 1:30 pm ET, the early window is locked

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, BENCH: 20, IR: 21 };
let nextId = 1;
function player(name, position, week, { slot = position, team = 'LAT', espnLocked } = {}) {
  const id = nextId++;
  const ppe = { player: { id: 6000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } };
  if (espnLocked !== undefined) ppe.lineupLocked = espnLocked;
  return {
    asset: {
      id, name, position, team_abbr: team, espn_id: 6000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
      active_probability: 0.95, bye: 9, matchup: { opponent: 'OPP' }
    },
    entry: { lineupSlotId: SLOT_ID[slot], playerPoolEntry: ppe }
  };
}

let leagueSeq = 700;
function league(mine) {
  const id = leagueSeq++;
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Kickoff locks', '1', 2, 1, ?, ?)`,
  id, `kl-${id}`, JSON.stringify(['QB', 'RB', 'WR', 'TE']), JSON.stringify(payload));
  return { lg: db.prepare('SELECT * FROM leagues WHERE id = ?').get(id), assets: new Map(mine.map(p => [p.asset.id, p.asset])) };
}
const inbox = lgId => rows(`SELECT * FROM decision_recommendations WHERE league_id = ? AND type = 'lineup'`, lgId);
const named = d => new Set(d.swaps.flatMap(s => [s.in.name, s.out?.name]).filter(Boolean));

/** A 1:00 pm back started over a far better 4:25 pm back on the bench. */
function earlyStarterLateBench(extra = {}) {
  return [
    player('Quarterback', 'QB', 18, { team: 'EAR' }),
    player('Early Starter', 'RB', 6, { team: 'EAR', ...(extra.early ?? {}) }),
    player('Late Bench', 'RB', 16, { slot: 'BENCH', team: 'LAT' }),
    player('Wideout', 'WR', 14, { team: 'LAT' }),
    player('Tight End', 'TE', 8, { team: 'LAT' })
  ];
}

test('control, before any kickoff: the swap is proposed and its row expires by the named starter\'s kickoff', () => {
  const { lg, assets } = league(earlyStarterLateBench());
  const d = lineupDiff(lg, '1', { assets, now: PRE });
  assert.equal(d.swaps.length, 1);
  assert.equal(d.swaps[0].in.name, 'Late Bench');
  assert.equal(d.swaps[0].out.name, 'Early Starter');
  const [row] = inbox(lg.id).filter(r => r.status === 'open');
  assert.ok(row, 'a 10-point swap publishes');
  assert.ok(Date.parse(row.expires_at) <= EARLY_KICKOFF,
    `expires_at ${row.expires_at} must be at or before Early Starter's kickoff ${new Date(EARLY_KICKOFF).toISOString()}`);
});

test('after his kickoff a locked starter is never the "out" leg, and the open row is retired', () => {
  const { lg, assets } = league(earlyStarterLateBench());
  lineupDiff(lg, '1', { assets, now: PRE });
  const d = lineupDiff(lg, '1', { assets, now: MID });
  assert.ok(!named(d).has('Early Starter'), `swaps named a locked player: ${[...named(d)].join(', ')}`);
  assert.equal(d.swaps.length, 0, 'the only RB slot is locked, so nothing can move');
  assert.equal(d.optimal_points, d.submitted_points, 'no gain is claimed from an impossible move');
  assert.equal(inbox(lg.id).filter(r => r.status === 'open').length, 0, 'no open row names a locked player');
  assert.deepEqual(d.locked.map(p => p.name).sort(), ['Early Starter', 'Quarterback']);
  assert.equal(d.locked.find(p => p.name === 'Early Starter').reason, 'kicked_off');
});

test('ESPN\'s own lock flag locks him even when the kickoff is still in the future (delayed or moved game)', () => {
  const { lg, assets } = league(earlyStarterLateBench({ early: { espnLocked: true } }));
  const d = lineupDiff(lg, '1', { assets, now: PRE });
  assert.ok(!named(d).has('Early Starter'));
  assert.equal(d.swaps.length, 0);
  assert.equal(d.locked.find(p => p.name === 'Early Starter')?.reason, 'espn_locked');
});

test('a bench player whose game kicked off is never recommended IN', () => {
  const { lg, assets } = league([
    player('Quarterback', 'QB', 18, { team: 'LAT' }),
    player('Late Starter', 'RB', 6, { team: 'LAT' }),
    player('Early Bench', 'RB', 16, { slot: 'BENCH', team: 'EAR' }),
    player('Wideout', 'WR', 14, { team: 'LAT' }),
    player('Tight End', 'TE', 8, { team: 'LAT' })
  ]);
  const d = lineupDiff(lg, '1', { assets, now: MID });
  assert.ok(!named(d).has('Early Bench'), `swaps named a locked player: ${[...named(d)].join(', ')}`);
  assert.equal(d.swaps.length, 0);
});

test('the open slots are still re-solved, and the row expires at the earliest kickoff it names', () => {
  const { lg, assets } = league([
    player('Quarterback', 'QB', 18, { team: 'EAR' }),
    player('Early Starter', 'RB', 6, { team: 'EAR' }),
    player('Late Bench Back', 'RB', 16, { slot: 'BENCH', team: 'LAT' }),
    player('Late Wideout Started', 'WR', 5, { team: 'LAT' }),
    player('Late Wideout Benched', 'WR', 15, { slot: 'BENCH', team: 'LAT' }),
    player('Tight End', 'TE', 8, { team: 'LAT' })
  ]);
  const d = lineupDiff(lg, '1', { assets, now: MID });
  assert.equal(d.swaps.length, 1);
  assert.equal(d.swaps[0].in.name, 'Late Wideout Benched');
  assert.equal(d.swaps[0].out.name, 'Late Wideout Started');
  assert.equal(d.optimal.find(s => s.slot === 'RB').player.name, 'Early Starter', 'the locked back holds his slot');
  const [row] = inbox(lg.id).filter(r => r.status === 'open');
  assert.equal(Date.parse(row.expires_at), LATE_KICKOFF, 'both named players kick off at 4:25 pm ET');
});

test('pinnedBestLineup with no pins is exactly bestLineup', () => {
  const ps = earlyStarterLateBench().map(p => ({ ...p.asset, week_points: p.asset.current_week_ppg }));
  const slots = ['QB', 'RB', 'WR', 'TE'];
  assert.deepEqual(pinnedBestLineup(ps, slots, 'week_points', new Map()), bestLineup(ps, slots, 'week_points'));
});

test('pinnedBestLineup keeps a locked back in FLEX and solves the other slots around him', () => {
  const mk = (id, position, pts) => ({ id, name: `P${id}`, position, week_points: pts, available: true });
  const ps = [mk(1, 'QB', 20), mk(2, 'RB', 4), mk(3, 'RB', 12), mk(4, 'RB', 11), mk(5, 'WR', 9), mk(6, 'WR', 8),
    mk(7, 'WR', 7), mk(8, 'TE', 6)];
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
  const out = pinnedBestLineup(ps, slots, 'week_points', new Map([[2, 'FLEX']]));
  assert.deepEqual(out.slots.map(s => [s.slot, s.player?.id]),
    [['QB', 1], ['RB', 3], ['RB', 4], ['WR', 5], ['WR', 6], ['TE', 8], ['FLEX', 2]]);
  assert.equal(out.points, 20 + 12 + 11 + 9 + 8 + 6 + 4);
  assert.deepEqual(out.bench.map(p => p.id), [7]);
  // A locked bench player is out of the solve entirely.
  const benched = pinnedBestLineup(ps, slots, 'week_points', new Map([[3, 'BENCH']]));
  assert.ok(!benched.slots.some(s => s.player?.id === 3));
});
