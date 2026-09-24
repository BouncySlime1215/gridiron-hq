/**
 * BLEND-01 serving holds (FIX-164-1, FIX-164-3). Each code-only hold is lifted only by a test
 * that fails without its fix; the forward hold stays until blind forward weeks confirm ESPN.
 *
 *   - espn_zero_reads_as_missing: lineupCall (Start/Sit) compares a bench player whose weekly
 *     number is ESPN's 0 at 0. It used to list him as "no projection ... missing data".
 *     A 0 with no ESPN value behind it is still missing data (the control).
 *   - forward_unconfirmed: lifts only when the pooled BLIND forward weeks (first game after the
 *     pre-registration commit) give an ESPN-minus-ours pair-accuracy CI lower bound above 0.
 *     The committed tournament output decides it; 2026 week 2 is not blind.
 *
 * Fixtures follow test/lineup-floor-objective.test.js: the asset universe is mocked, the
 * solver, roster loading and slot rules are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-blend-holds-'));
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
const blend = await import('../server/services/weekly-blend.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(name, position, week, weekBlend = null) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: 'MID', espn_id: 9000 + id, available: true,
      current_week_ppg: week, adj_ppg: week || 9, ppg: week || 9, ros_ppg: week || 9,
      active_probability: 0.9, bye: 9, week_blend: weekBlend
    },
    entry: {
      lineupSlotId: 20,
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } }
    }
  };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'];
let leagueSeq = 820;
function league(mine) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Blend holds', '1', 10, 1, ?, ?)`,
  id, `bh-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return id;
}

function roster(benchBlend) {
  return [
    player('Quarterback', 'QB', 20), player('Back One', 'RB', 14), player('Back Two', 'RB', 11),
    player('Wideout One', 'WR', 15), player('Wideout Two', 'WR', 12), player('Tight End', 'TE', 8),
    player('Ruled Out Wideout', 'WR', 0, benchBlend)
  ];
}
const NO_HOOK = { covered: false, ids: new Set() };
const wrCall = call => call.lineup.find(c => c.slot === 'WR' && c.player.name === 'Wideout Two');

test('espn_zero_reads_as_missing: ESPN\'s 0 is a projection of 0, compared at 0', () => {
  const call = lineupCall(league(roster({ basis: 'blend', weight_ours: 0, espn_ppg: 0 })), { providers: {}, inactive: NO_HOOK });
  assert.ifError(call.error);
  const c = wrCall(call);
  assert.ok(c, 'Wideout Two starts at WR');
  assert.equal(c.over?.name, 'Ruled Out Wideout', 'the 0-projected wideout is the alternative, not unpriced');
  assert.equal(c.margin, 12);
  assert.notEqual(c.confidence, 'no projection');
  assert.doesNotMatch(c.why, /missing data/);
  assert.doesNotMatch(call.note, /no weekly projection/);
});

test('control: a 0 with no ESPN value behind it is still missing data', () => {
  for (const b of [null, { basis: 'no_espn_value', weight_ours: 1, espn_ppg: null }, { basis: 'no_game', weight_ours: null, espn_ppg: 0 }]) {
    const call = lineupCall(league(roster(b)), { providers: {}, inactive: NO_HOOK });
    const c = wrCall(call);
    assert.equal(c.over, null, JSON.stringify(b));
    assert.equal(c.confidence, 'no projection', JSON.stringify(b));
    assert.match(c.why, /missing data/);
  }
});

test('the code-only holds are lifted and recorded; the waiver and forward holds stand', () => {
  const ids = blend.SERVING_HOLDS.map(h => h.id);
  assert.deepEqual(ids, ['waiver_ungraded', 'forward_unconfirmed']);
  assert.deepEqual(blend.LIFTED_HOLDS.map(h => h.id), ['espn_zero_reads_as_missing', 'labels_describe_ours', 's03_identity']);
  for (const h of blend.LIFTED_HOLDS) assert.ok(fs.existsSync(h.lifted_by), `${h.id}: ${h.lifted_by} exists`);
  assert.equal(blend.SERVED_BLEND.on, false);
  assert.deepEqual(blend.SERVED_BLEND.holds, ids);
});

test('forward_unconfirmed: only blind weeks count, and the pooled CI lower bound must be above 0', () => {
  const { isBlindForwardWeek, forwardConfirmed, FORWARD_CONFIRMATION } = blend;
  assert.equal(isBlindForwardWeek('2026-09-17'), false, 'week 2 was played before the pre-registration');
  assert.equal(isBlindForwardWeek('2026-09-22'), false, 'the commit day itself is not blind');
  assert.equal(isBlindForwardWeek('2026-09-24'), true, 'week 3');
  assert.equal(isBlindForwardWeek(null), false);
  assert.match(FORWARD_CONFIRMATION.prereg_commit, /^7c443485/);
  const wk = (week, blind = true) => ({ week, blind });
  const pooled = lo => ({ pa_diff: 0.05, pa: { ci90: [lo, 0.1] } });
  assert.equal(forwardConfirmed(null), false);
  assert.equal(forwardConfirmed({ weeks: [], pooled: pooled(0.01) }), false, 'no graded week');
  assert.equal(forwardConfirmed({ weeks: [wk(3)], pooled: pooled(-0.002) }), false, 'CI crosses 0');
  assert.equal(forwardConfirmed({ weeks: [wk(3)], pooled: pooled(0) }), false, 'a bound at 0 is not above 0');
  assert.equal(forwardConfirmed({ weeks: [wk(2, false), wk(3)], pooled: pooled(0.01) }), false, 'a non-blind week in the pool');
  assert.equal(forwardConfirmed({ weeks: [wk(3), wk(4)], pooled: pooled(0.01) }), true);
});

test('the committed tournament output decides the forward hold', () => {
  const out = JSON.parse(fs.readFileSync(blend.TOURNAMENT_DECISION.evidence, 'utf8'));
  assert.ok(out.forward_blind, 'the output records the blind forward check (FIX-164-1)');
  assert.equal(out.forward_blind.prereg_commit, blend.FORWARD_CONFIRMATION.prereg_commit);
  assert.ok(Array.isArray(out.forward_blind.weeks));
  assert.ok(out.forward_blind.weeks.every(w => w.blind === true), 'only blind weeks are graded');
  assert.ok(out.forward_blind.excluded.some(w => w.week === 2 && w.blind === false), 'week 2 is recorded as not blind');
  const lifted = blend.forwardConfirmed(out.forward_blind);
  assert.equal(out.forward_blind.lifts_hold, lifted);
  assert.equal(blend.SERVING_HOLDS.some(h => h.id === 'forward_unconfirmed'), !lifted,
    'the hold stands exactly while the committed blind weeks do not confirm ESPN');
});
