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
const { lineupPosture } = await import('../server/services/lineup-posture.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

for (const [team, opp, time] of [['EAR', 'EOP', '13:00'], ['LAT', 'LOP', '16:25']]) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime) VALUES (2026, 2, ?, ?, 1, '2026-09-20', ?)`,
    team, opp, time);
}
const PRE = Date.parse('2026-09-20T16:00:00Z');   // noon ET
const MID = Date.parse('2026-09-20T17:30:00Z');   // 1:30 pm ET: EAR (13:00) locked, LAT (16:25) open

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, OP: 7, BENCH: 20, FLEX: 23 };
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
  assert.match(rb.why, /already kicked off/, 'the only-option sentence says why the better back cannot come in');
});

/*
 * The matchup card on the same Start/Sit page (lineup-posture.js#lineupPosture) is a
 * third lineup producer: its "You" total, its opponent total and its variance swaps
 * all come from its own solve. It must hold locked players exactly as Start/Sit does.
 */
function matchupLeague(mine, theirs, slots) {
  const id = leagueSeq++;
  assets = new Map([...mine, ...theirs].map(p => [p.asset.id, p.asset]));
  const payload = {
    teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } },
      { id: 2, name: 'Theirs', roster: { entries: theirs.map(p => p.entry) } }],
    schedule: [{ matchupPeriodId: 2, home: { teamId: 1 }, away: { teamId: 2 } }]
  };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Matchup locks', '1', 10, 1, ?, ?)`,
  id, `mul-${id}`, JSON.stringify(slots), JSON.stringify(payload));
  return { id, lg: db.prepare('SELECT * FROM leagues WHERE id = ?').get(id) };
}
/** Six late-window starters, QB/RB/RB/WR/WR/TE, scoring `total` between them. */
const theirSix = (total, extra = []) => [
  player('Their QB', 'QB', +(total * 0.22).toFixed(2)), player('Their RB1', 'RB', +(total * 0.18).toFixed(2)),
  player('Their RB2', 'RB', +(total * 0.15).toFixed(2)), player('Their WR1', 'WR', +(total * 0.19).toFixed(2)),
  player('Their WR2', 'WR', +(total * 0.16).toFixed(2)), player('Their TE', 'TE', +(total * 0.10).toFixed(2)),
  ...extra
];
const FLEX_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];

test('surfaces agree after kickoff: the matchup card\'s "You" total is the Start/Sit total, locked bench back left out', () => {
  // Early Bench (9, 1:00 pm, benched) would fill FLEX in an unpinned solve (83). At
  // 1:30 pm he cannot come in, so FLEX has no one left who can: 74.
  const mine = () => [
    player('Quarterback', 'QB', 18), player('Early Back', 'RB', 10, { team: 'EAR' }), player('Late Back', 'RB', 15),
    player('Early Bench', 'RB', 9, { slot: 'BENCH', team: 'EAR' }),
    player('Wideout One', 'WR', 12), player('Wideout Two', 'WR', 11), player('Tight End', 'TE', 8)
  ];
  const pre = matchupLeague(mine(), theirSix(80), FLEX_SLOTS);
  const cPre = lineupPosture(pre.lg, { myTeamId: '1', now: PRE });
  assert.equal(cPre.my_projection, 83, 'control: before kickoff he starts in FLEX');
  assert.equal(cPre.my_projection, +lineupCall(pre.id, { providers: {}, now: PRE }).projected_points.toFixed(1));
  const mid = matchupLeague(mine(), theirSix(80), FLEX_SLOTS);
  const card = lineupPosture(mid.lg, { myTeamId: '1', now: MID });
  const call = lineupCall(mid.id, { providers: {}, now: MID });
  assert.equal(card.my_projection, 74, JSON.stringify(card.lineup));
  assert.equal(card.my_projection, +call.projected_points.toFixed(1), 'the card and Start/Sit show one number');
  assert.ok(!card.lineup.some(l => l.player === 'Early Bench'));
});

test('the matchup card\'s opponent total holds his locked bench player out too', () => {
  const theirs = () => theirSix(100, [player('Their Early Star', 'RB', 30, { slot: 'BENCH', team: 'EAR' })]);
  const mine = () => [player('Quarterback', 'QB', 18), player('Back One', 'RB', 12), player('Back Two', 'RB', 11),
    player('Wideout One', 'WR', 12), player('Wideout Two', 'WR', 11), player('Tight End', 'TE', 8)];
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'];
  const cPre = lineupPosture(matchupLeague(mine(), theirs(), slots).lg, { myTeamId: '1', now: PRE });
  const cMid = lineupPosture(matchupLeague(mine(), theirs(), slots).lg, { myTeamId: '1', now: MID });
  assert.equal(cPre.opponent_projection, 115, 'control: before kickoff he replaces their 15-point RB2');
  assert.equal(cMid.opponent_projection, 100, 'after his kickoff he stays on their bench');
});

// A heavy underdog in a superflex league (the variance search's own fixture in
// test/posture-calibration.test.js): a 29.5-point receiver in OP over a 30-point
// quarterback gives up half a point for more spread, which an underdog wants.
const underdog = ({ boomTeam = 'LAT', secondQbTeam = 'LAT' } = {}) => [
  player('Me QB', 'QB', 31), player('Me RB1', 'RB', 12), player('Me RB2', 'RB', 11),
  player('Me WR1', 'WR', 40), player('Me WR2', 'WR', 39), player('Me TE', 'TE', 35),
  player('Second QB', 'QB', 30, { slot: 'OP', team: secondQbTeam }),
  player('Boom Receiver', 'WR', 29.5, { slot: 'BENCH', team: boomTeam })
];
const OP_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'OP'];

test('the matchup card never tells you to start a bench player whose game kicked off', () => {
  const pre = lineupPosture(matchupLeague(underdog({ boomTeam: 'EAR' }), theirSix(275), OP_SLOTS).lg, { myTeamId: '1', now: PRE });
  assert.equal(pre.stance, 'chase variance');
  assert.ok(pre.swaps.some(s => s.start === 'Boom Receiver'), `control, before kickoff: ${JSON.stringify(pre.swaps)}`);
  const mid = lineupPosture(matchupLeague(underdog({ boomTeam: 'EAR' }), theirSix(275), OP_SLOTS).lg, { myTeamId: '1', now: MID });
  assert.equal(mid.stance, 'chase variance');
  assert.ok(mid.swaps.every(s => s.start !== 'Boom Receiver'), JSON.stringify(mid.swaps));
});

test('the matchup card never tells you to bench a starter whose game kicked off', () => {
  const pre = lineupPosture(matchupLeague(underdog({ secondQbTeam: 'EAR' }), theirSix(275), OP_SLOTS).lg, { myTeamId: '1', now: PRE });
  assert.ok(pre.swaps.some(s => s.instead_of === 'Second QB'), `control, before kickoff: ${JSON.stringify(pre.swaps)}`);
  const mid = lineupPosture(matchupLeague(underdog({ secondQbTeam: 'EAR' }), theirSix(275), OP_SLOTS).lg, { myTeamId: '1', now: MID });
  assert.ok(mid.swaps.every(s => s.instead_of !== 'Second QB'), JSON.stringify(mid.swaps));
});

test('a locked starter flagged out holds his slot on the matchup card and counts 0, as on Start/Sit', () => {
  const mine = () => [
    player('Quarterback', 'QB', 18), player('Early Back', 'RB', 10, { team: 'EAR' }), player('Late Back', 'RB', 15),
    player('Wideout One', 'WR', 12), player('Wideout Two', 'WR', 11), player('Tight End', 'TE', 8)
  ];
  const roster = mine();
  roster[1].asset.available = false;
  const { id, lg } = matchupLeague(roster, theirSix(80), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE']);
  const card = lineupPosture(lg, { myTeamId: '1', now: MID });
  assert.equal(card.my_projection, 18 + 15 + 12 + 11 + 8, JSON.stringify(card.lineup));
  assert.equal(card.my_projection, +lineupCall(id, { providers: {}, now: MID }).projected_points.toFixed(1));
});
