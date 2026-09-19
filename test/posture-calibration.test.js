/**
 * The matchup card's win probability and stance (lineup-posture.js), in closed form.
 *
 * Commit 11ab55c replaced the spread (each player's own distribution x a 1.9
 * "inflation") with POSITION_CV x a fitted SPREAD_SCALE of 1.63, and MATERIAL_EDGE
 * 12 with a derived 23. Nothing tested any of it: putting 1.9 back, putting 12 back,
 * or going back to each player's own (ceiling - floor) / 2.56 all passed the suite.
 * Fixtures follow test/decision-leftovers-lineup.test.js: the asset universe and the
 * betting-line lift are mocked, the solver and roster loading are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-posture-calibration-'));
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
const { lineupPosture, lineupMoments, SPREAD_SCALE, MATERIAL_EDGE, POSITION_CV } =
  await import('../server/services/lineup-posture.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Phi, independent of the module under test (Abramowitz-Stegun 26.2.17).
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
const CV = { QB: 0.40, RB: 0.57, WR: 0.63, TE: 0.67 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'];
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(name, position, week, { available = true } = {}) {
  const id = nextId++;
  return {
    // ceiling/floor wide on purpose: a spread taken from a player's own distribution
    // ((ceiling - floor) / 2.56) would differ from the positional CV.
    asset: { id, name, position, team_abbr: 'MID', espn_id: 6000 + id, available, current_week_ppg: week,
      adj_ppg: week, ppg: week, floor: 0, ceiling: +(week * 2).toFixed(2), active_probability: 0.95, bye: 9 },
    entry: { lineupSlotId: 20, playerPoolEntry: { player: { id: 6000 + id, fullName: name, defaultPositionId: POS_ID[position] } } }
  };
}
let leagueSeq = 950;
function league(mine, theirs, slots = SLOTS) {
  const id = leagueSeq++;
  assets = new Map([...mine, ...theirs].map(p => [p.asset.id, p.asset]));
  const payload = {
    teams: [{ id: 1, roster: { entries: mine.map(p => p.entry) } }, { id: 2, roster: { entries: theirs.map(p => p.entry) } }],
    schedule: [{ matchupPeriodId: 2, home: { teamId: 1 }, away: { teamId: 2 } }]
  };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Posture', '1', 10, 1, ?, ?)`, id, `pc-${id}`, JSON.stringify(slots), JSON.stringify(payload));
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}
/** Six starters summing to `total`, split QB/RB/RB/WR/WR/TE in fixed shares. */
function lineup(prefix, total, extra = []) {
  const shares = { QB: 0.22, RB1: 0.18, RB2: 0.15, WR1: 0.19, WR2: 0.16, TE: 0.10 };
  const pts = Object.fromEntries(Object.entries(shares).map(([k, s]) => [k, +(total * s).toFixed(4)]));
  pts.TE = +(total - pts.QB - pts.RB1 - pts.RB2 - pts.WR1 - pts.WR2).toFixed(4);
  return [
    player(`${prefix} QB`, 'QB', pts.QB), player(`${prefix} RB1`, 'RB', pts.RB1), player(`${prefix} RB2`, 'RB', pts.RB2),
    player(`${prefix} WR1`, 'WR', pts.WR1), player(`${prefix} WR2`, 'WR', pts.WR2), player(`${prefix} TE`, 'TE', pts.TE),
    ...extra
  ];
}
const SPREAD_SCALE_EXPECTED = 1.63;
const sdOf = roster => SPREAD_SCALE_EXPECTED * Math.sqrt(roster.slice(0, 6)
  .reduce((s, p) => s + (p.asset.current_week_ppg * CV[p.asset.position]) ** 2, 0));

test('the constants are the fitted and derived ones', () => {
  assert.equal(SPREAD_SCALE, 1.63);
  assert.equal(MATERIAL_EDGE, 23);
  assert.deepEqual(POSITION_CV, CV);
});

test('my_sd is 1.63 x the root sum of (projection x positional CV)^2', () => {
  const mine = lineup('Me', 100), theirs = lineup('Them', 110);
  const card = lineupPosture(league(mine, theirs), { myTeamId: '1' });
  assert.ifError(card.error);
  assert.equal(card.my_sd, +sdOf(mine).toFixed(1));
  assert.equal(card.opponent_sd, +sdOf(theirs).toFixed(1));
});

test('win probability is Phi(edge / sqrt(my_sd^2 + opp_sd^2))', () => {
  const mine = lineup('Me', 100), theirs = lineup('Them', 110);
  const card = lineupPosture(league(mine, theirs), { myTeamId: '1' });
  const want = 100 * phi(-10 / Math.hypot(sdOf(mine), sdOf(theirs)));
  assert.equal(card.win_probability, +want.toFixed(1));
});

test('the stance turns at an edge of exactly 23 points', () => {
  const neutral = lineupPosture(league(lineup('Me', 100), lineup('Them', 122.9)), { myTeamId: '1' });
  assert.equal(neutral.stance, 'neutral', `edge ${neutral.edge}`);
  const chase = lineupPosture(league(lineup('Me', 100), lineup('Them', 123)), { myTeamId: '1' });
  assert.equal(chase.stance, 'chase variance', `edge ${chase.edge}`);
  const protect = lineupPosture(league(lineup('Me', 123), lineup('Them', 100)), { myTeamId: '1' });
  assert.equal(protect.stance, 'protect the lead');
});

test('a player projected for 0 adds no variance', () => {
  assert.equal(lineupMoments([{ position: 'WR', week_points: 0 }]).sd, 0);
  assert.ok(Math.abs(lineupMoments([{ position: 'WR', week_points: 10 }]).sd - 1.63 * 10 * 0.63) < 1e-9);
});

test('the variance search never starts a player the solver could not start', () => {
  // A heavy underdog in a superflex league. The OP slot holds a 30-point quarterback
  // (CV 0.40). A 29.5-point receiver (CV 0.63) or a 29.6-point tight end (CV 0.67)
  // gives up half a point for much more spread, which is what an underdog wants — but
  // the tight end is flagged out for the season. Neither beats the starters at his
  // own position, so only the OP swap is on the table.
  const mine = [
    player('Me QB', 'QB', 31), player('Me RB1', 'RB', 12), player('Me RB2', 'RB', 11),
    player('Me WR1', 'WR', 40), player('Me WR2', 'WR', 39), player('Me TE', 'TE', 35),
    player('Second QB', 'QB', 30), player('Healthy Boom', 'WR', 29.5),
    player('Flagged Boom', 'TE', 29.6, { available: false })
  ];
  const card = lineupPosture(league(mine, lineup('Them', 275), [...SLOTS, 'OP']), { myTeamId: '1' });
  assert.equal(card.stance, 'chase variance');
  assert.ok(card.swaps.some(s => s.start === 'Healthy Boom'), `the search runs: ${JSON.stringify({ ...card, note: null })}`);
  assert.ok(card.swaps.every(s => s.start !== 'Flagged Boom'), JSON.stringify(card.swaps));
});
