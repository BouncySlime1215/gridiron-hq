/**
 * The start/sit confidence label has to be worth the word it uses.
 *
 * `CLEAR_THRESHOLD` was 4.0, set as an explicit judgement — lineup-brain.js's own
 * comment said so: "not fitted — it is a judgement, stated here in one place so it
 * can be argued with". The measurement argued with it, in
 * docs/evidence/2026-09-22/start-sit-decision-curve.md (Model evidence audit's
 * branch). On the STARTABLE universe — 656,705 fully enumerated same-week pairs
 * with both projections >= 8.0 PPR, margin = higher minus lower projection, win =
 * strictly higher actual PPR — the tail rates are:
 *
 *     above 1.5 -> 66.5%    above 4.0 -> 72.6%    above 7.15 -> 80.0%
 *     above 9.0 -> 83.9%    above 9.57 -> 85%     above 12.71 -> 90%
 *
 * and the band BELOW 1.5 measures 52.9%.
 *
 * Two consequences, and the second matters more than the first.
 *
 * First, 4.0 bought 72.6%, not 80%. A call labelled "clear" was wrong better than
 * one time in four.
 *
 * Second — and this is why the fix is not just a bigger constant — there is no
 * band where a weekly start/sit call is near-certain. 90% needs a 12.71-point
 * margin, which is 2,617 of 656,705 pairs: four hundredths of a percent of the
 * decisions anyone faces. Any word strong enough to mean "certain" overclaims at
 * every threshold a real lineup reaches. So the measured number travels with the
 * call, and it is MEASURED: the rate reported for a margin is the rate of the
 * largest measured anchor at or below it, never interpolated between anchors and
 * never extrapolated past the last one.
 *
 * TIE_THRESHOLD is left at 1.5 deliberately. The evidence examined it and said it
 * is well chosen: the band below it measures 52.9%, which is the coin flip it
 * already claims to be.
 *
 * Note both quantities are on the curve and they are not the same shape:
 * DECISION_CURVE holds TAIL rates ("of calls with a margin at least M, this share
 * won"), which is the quantity a threshold is answerable for, while
 * TIE_BAND_WIN_RATE is the rate WITHIN the band below 1.5. Reading a tail rate as
 * a band rate is the mistake that produced the first draft of this file.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-start-sit-curve-'));
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
// No betting-line lift, so every margin below is the projection difference itself.
mock.module('../server/services/waiver-brain.js', {
  namedExports: {
    ...realWaiverBrain,
    vegasLift: () => ({ multiplier: 1, line: null, applied: false })
  }
});

const { lineupCall, decisionWinRate, DECISION_CURVE, CLEAR_THRESHOLD, TIE_THRESHOLD,
  TIE_BAND_WIN_RATE } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the curve

test('the reported rate is a measured anchor, never an interpolation', () => {
  assert.equal(decisionWinRate(4.0), 0.726);
  assert.equal(decisionWinRate(5.0), 0.726,
    'a margin between two anchors was interpolated instead of reported at the lower measured rate');
  assert.equal(decisionWinRate(7.15), 0.80);
  assert.equal(decisionWinRate(12.71), 0.90);
});

test('nothing is extrapolated past the largest measured margin', () => {
  assert.equal(decisionWinRate(100), 0.90,
    'a margin beyond the measured range was given a rate the data does not support');
});

test('a margin below the smallest measured anchor has no rate rather than a made-up one', () => {
  assert.equal(decisionWinRate(1.0), null);
  assert.equal(decisionWinRate(null), null);
  assert.equal(decisionWinRate(Number.NaN), null);
});

test('the reported rate never decreases as the margin grows', () => {
  let previous = 0;
  for (let margin = 1.5; margin <= 15; margin += 0.05) {
    const rate = decisionWinRate(margin) ?? 0;
    assert.ok(rate >= previous, `rate fell at margin ${margin.toFixed(2)}`);
    previous = rate;
  }
});

test('the curve itself is ordered and rising, so a lookup down it is meaningful', () => {
  const points = DECISION_CURVE.points;
  assert.ok(points.length >= 6, 'too few anchors to describe a curve');
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].margin > points[i - 1].margin, `margin out of order at index ${i}`);
    assert.ok(points[i].win_rate >= points[i - 1].win_rate, `win rate fell at index ${i}`);
  }
});

test('the clear threshold sits on a measured anchor, not a judgement', () => {
  assert.ok(DECISION_CURVE.points.some(p => p.margin === CLEAR_THRESHOLD),
    'CLEAR_THRESHOLD is not one of the measured margins');
  assert.ok(decisionWinRate(CLEAR_THRESHOLD) >= 0.80,
    'the threshold that earns the strongest label is below the measured 80% point');
});

test('a four-point margin no longer earns the strongest label', () => {
  assert.ok(CLEAR_THRESHOLD > 4.0,
    '4.0 still earns the strongest label despite measuring 72.6%');
  assert.equal(decisionWinRate(4.0), 0.726);
});

test('the coin-flip threshold is left where the measurement supports it', () => {
  assert.equal(TIE_THRESHOLD, 1.5);
  // The TAIL rate at 1.5, which is what the curve holds.
  assert.equal(decisionWinRate(TIE_THRESHOLD), 0.665);
  // The rate WITHIN the band below it, which is what makes it a coin flip.
  assert.equal(TIE_BAND_WIN_RATE, 0.529,
    'the tie band no longer carries its measured coin-flip rate');
});

test('every curve point carries the universe it was measured on', () => {
  for (const point of DECISION_CURVE.points) {
    assert.equal(typeof point.margin, 'number');
    assert.equal(typeof point.win_rate, 'number');
    assert.ok(point.win_rate > 0.5 && point.win_rate <= 1);
  }
  assert.ok(DECISION_CURVE.source, 'the curve does not say where it was measured');
  assert.match(DECISION_CURVE.universe, /8\.0|startable/,
    'the curve does not state the universe it is valid for');
  assert.match(DECISION_CURVE.measured_on, /week_points|baseline/,
    'the curve does not say which projection it was measured on');
});

// ------------------------------------------------------- what a call reports

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(name, position, week, { slot = 20 } = {}) {
  const id = nextId++;
  const asset = {
    id, name, position, team_abbr: 'MID', espn_id: 5000 + id, available: true,
    current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
    ceiling: +(week * 1.5).toFixed(2), floor: +(week * 0.5).toFixed(2),
    active_probability: 0.95, bye: 9
  };
  const entry = {
    lineupSlotId: slot,
    playerPoolEntry: { player: { id: 5000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } }
  };
  return { asset, entry };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 900;
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
       VALUES (?, 'espn', ?, 2026, 'Decision curve', '1', 10, 1, ?, ?)`,
  id, `dc-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

// The quarterback slot is the one under test: 20.0 against a 15.0 bench
// quarterback is a 5.0 margin, which used to read "clear, comfortably" and
// measures 72.6%.
function roster() {
  return [
    player('Quarterback One', 'QB', 20),
    player('Quarterback Two', 'QB', 15),
    player('Back One', 'RB', 14), player('Back Two', 'RB', 12), player('Back Three', 'RB', 5),
    player('Wideout One', 'WR', 16), player('Wideout Two', 'WR', 13), player('Wideout Three', 'WR', 6),
    player('Tight End One', 'TE', 9)
  ];
}
function theirRoster() {
  return [
    player('Rival Quarterback', 'QB', 18), player('Rival Back A', 'RB', 13),
    player('Rival Back B', 'RB', 11), player('Rival Wideout A', 'WR', 14),
    player('Rival Wideout B', 'WR', 12), player('Rival Tight End', 'TE', 7),
    player('Rival Flex', 'RB', 9)
  ];
}

test('a five-point margin is a lean carrying its measured rate, not a comfortable clear', () => {
  const lg = league(roster(), theirRoster());
  const call = lineupCall(lg.id, { providers: {} });
  const qb = call.lineup.find(c => c.slot === 'QB');
  assert.equal(qb.margin, 5, 'the fixture no longer produces the 5.0 margin under test');
  assert.equal(qb.confidence, 'lean',
    'a 5.0 margin still earns the strongest label, which measures 72.6%');
  assert.equal(qb.confidence_win_rate, 0.726,
    'the call does not carry the rate its margin actually measured');
});

test('no call describes itself as comfortable, at any margin', () => {
  const lg = league(roster(), theirRoster());
  const call = lineupCall(lg.id, { providers: {} });
  for (const c of call.lineup) {
    assert.doesNotMatch(c.why, /comfortab/i,
      `${c.slot} still claims comfort the projection cannot support`);
  }
});

test('the payload says which curve the rates came from', () => {
  const lg = league(roster(), theirRoster());
  const call = lineupCall(lg.id, { providers: {} });
  assert.ok(call.confidence_curve, 'nothing on the payload names the curve');
  assert.match(call.confidence_curve.universe, /8\.0|startable/);
  assert.ok(call.confidence_curve.source);
  // It has to survive the wire, or the page cannot print it.
  const wire = JSON.parse(JSON.stringify(call.confidence_curve));
  assert.ok(wire.points.length > 0, 'the curve points did not survive serialisation');
});
