import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFor, scoreLine, PPR } from '../server/services/scoring.js';

// A real ESPN scoringSettings.scoringItems payload, shape-for-shape as stored
// on leagues.payload — confirmed against a real synced league this session.
// statId 44 (receiving two-point conversion) was previously mis-mapped to the
// same 'rec' bucket as statId 53 (the real reception count), and since it
// appears after 53 in ESPN's own array, it silently overwrote 1 with 2 for
// every real 1-point-PPR league synced through this app.
function espnLeague(scoringItems) {
  return { platform: 'espn', ppr: 1, payload: JSON.stringify({ settings: { scoringSettings: { scoringItems } } }) };
}

const REAL_1PPR_ITEMS = [
  { statId: 20, points: -2 }, { statId: 72, points: -2 },
  { statId: 3, points: 0.04 }, { statId: 24, points: 0.1 }, { statId: 42, points: 0.1 },
  { statId: 53, points: 1 }, { statId: 86, points: 1 }, { statId: 209, points: 1 },
  { statId: 19, points: 2 }, { statId: 26, points: 2 }, { statId: 44, points: 2 }, { statId: 206, points: 2 },
  { statId: 4, points: 4 },
  { statId: 25, points: 6 }, { statId: 43, points: 6 }, { statId: 104, points: 6 }
];

test('a real 1-point-PPR league scores a reception as 1 point, not 2', () => {
  const s = scoringFor(espnLeague(REAL_1PPR_ITEMS));
  assert.equal(s.rec, 1, 'statId 44 (receiving 2pt) must never overwrite statId 53 (the real reception value)');
  assert.equal(s.rec_yd, 0.1);
  assert.equal(s.rec_td, 6);
});

test('a real receiver stat line scores correctly against real league settings', () => {
  // Ja'Marr Chase, a real 2025 week: 16 rec / 161 yd / 1 TD.
  const s = scoringFor(espnLeague(REAL_1PPR_ITEMS));
  const line = { receptions: 16, receiving_yards: 161, receiving_tds: 1 };
  assert.equal(scoreLine(line, s), 38.1, '16 rec (16) + 161 yd (16.1) + 1 TD (6) = 38.1, not 54.1');
});

test('a half-PPR league (statId 53 = 0.5) is read correctly, not doubled either', () => {
  const items = REAL_1PPR_ITEMS.map(it => it.statId === 53 ? { ...it, points: 0.5 } : it);
  const s = scoringFor(espnLeague(items));
  assert.equal(s.rec, 0.5);
});

test('a league with no scoring payload falls back to the ppr field, unaffected by the fix', () => {
  const s = scoringFor({ platform: 'espn', ppr: 1, payload: null });
  assert.equal(s.rec, PPR.rec);
});

// ---- A-03: the ESPN stat-id map (fixtures built from ESPN's scoringItems
// shape — statId / points / pointsOverrides keyed by lineup slot — not from
// any real league). Stat ids and slot ids follow the public espn-api
// constant table: 24 rushingYards, 42 receivingYards, 16 = D/ST slot.

const item = (statId, points, overrides) => ({
  statId, points, isReverseItem: false, leagueRanking: 0, leagueTotal: 0,
  ...(overrides ? { pointsOverrides: overrides } : {})
});

// A 27-item D/ST block, the shape ESPN serves: 20 items carry points: 0 with
// the real value in pointsOverrides['16'], 7 carry a plain points value.
const DST_ITEMS = [
  item(99, 0, { 16: 1 }), item(95, 0, { 16: 2 }),
  item(89, 0, { 16: 5 }), item(90, 0, { 16: 4 }), item(91, 0, { 16: 3 }), item(92, 0, { 16: 1 }),
  item(121, 0, { 16: 0 }), item(122, 0, { 16: -1 }), item(123, 0, { 16: -3 }), item(124, 0, { 16: -5 }), item(125, 0, { 16: -6 }),
  item(128, 0, { 16: 5 }), item(129, 0, { 16: 3 }), item(130, 0, { 16: 2 }), item(131, 0, { 16: 0 }), item(132, 0, { 16: -1 }),
  item(133, 0, { 16: -3 }), item(134, 0, { 16: -5 }), item(135, 0, { 16: -6 }), item(136, 0, { 16: -7 }),
  item(93, 6), item(96, 2), item(97, 2), item(98, 2), item(101, 6), item(102, 6), item(103, 6)
];
const OFFENSE_ITEMS = [
  item(3, 0.04), item(4, 4), item(20, -2), item(24, 0.1), item(25, 6),
  item(42, 0.1), item(43, 6), item(53, 1), item(72, -2)
];

test('A-03: D/ST points come from pointsOverrides[16] when scored in the D/ST slot', () => {
  assert.equal(DST_ITEMS.length, 27);
  assert.equal(DST_ITEMS.filter(it => it.points === 0 && it.pointsOverrides?.[16] != null).length, 20);
  const lg = espnLeague([...OFFENSE_ITEMS, ...DST_ITEMS]);
  // One D/ST week keyed by ESPN stat id: 3 sacks, 1 INT, 1 fumble recovery,
  // 20 points allowed (tier 121), 320 yards allowed (tier 131).
  const week = { 99: 3, 95: 1, 96: 1, 121: 1, 131: 1 };
  const score = pts => Object.entries(week).reduce((t, [id, v]) => t + v * (pts[id] ?? 0), 0);
  const dst = scoringFor(lg, { slot: 16 });
  assert.equal(score(dst.espn.points), 7, 'sacks 3 + INT 2 + FR 2 + tiers 0 = 7');
  // Read without the slot, the same league pays only the base values: FR 2.
  assert.equal(score(scoringFor(lg).espn.points), 2);
});

test('A-03: a pointsOverrides entry for an offensive slot changes that slot\'s weights only', () => {
  // A tight-end premium: receptions pay 1.5 in slot 6 (TE), 1 elsewhere.
  const items = OFFENSE_ITEMS.map(it => it.statId === 53 ? item(53, 1, { 6: 1.5 }) : it);
  assert.equal(scoringFor(espnLeague(items), { slot: 6 }).rec, 1.5);
  assert.equal(scoringFor(espnLeague(items), { slot: 4 }).rec, 1);
  assert.equal(scoringFor(espnLeague(items)).rec, 1);
});

test('A-03: stat id 24 is rushing yards and 42 is receiving yards, not the other way round', () => {
  const items = OFFENSE_ITEMS.map(it =>
    it.statId === 24 ? item(24, 0.1) : it.statId === 42 ? item(42, 0.2)
      : it.statId === 25 ? item(25, 6) : it.statId === 43 ? item(43, 4) : it);
  const s = scoringFor(espnLeague(items));
  assert.equal(s.rush_yd, 0.1);
  assert.equal(s.rec_yd, 0.2);
  assert.equal(s.rush_td, 6);
  assert.equal(s.rec_td, 4);
  assert.equal(scoreLine({ rushing_yards: 100, receiving_yards: 50 }, s), 20, '100*0.1 + 50*0.2');
});

test('A-03: a bonus id the scorer cannot apply is reported by id, not silently dropped', () => {
  // 37 = rushing100To199YardGame: a 3-point bonus scoreLine has no column for.
  const s = scoringFor(espnLeague([...OFFENSE_ITEMS, item(37, 3)]));
  assert.deepEqual(s.espn.unscored, [{ statId: 37, name: 'rushing100To199YardGame', points: 3 }]);
  assert.deepEqual(s.espn.unmapped, []);
});

test('A-03: a stat id outside ESPN\'s public list is listed as unmapped', () => {
  const s = scoringFor(espnLeague(REAL_1PPR_ITEMS));
  assert.deepEqual(s.espn.unmapped, [{ statId: 209, points: 1 }]);
  assert.equal(s.espn.source, 'league');
});

test('A-03: falling back to the ppr bucket says so, and still serialises as the bucket', () => {
  const bad = { platform: 'espn', ppr: 1, payload: '{not json' };
  const s = scoringFor(bad);
  assert.equal(s.espn.source, 'fallback');
  assert.match(s.espn.reason, /unparseable/);
  assert.equal(JSON.stringify(s), JSON.stringify(PPR), 'metadata must not leak into memo keys');
  assert.equal(scoringFor({ platform: 'espn', ppr: 1, payload: null }).espn.reason, 'no-payload');
});

// INT-163-1: a caller resolving weights for one slot (or none) has no way to
// tell whether the league's payload carries slot-specific pointsOverrides at
// all elsewhere, short of re-parsing the payload itself. hasOverrides /
// overrideSlots report that directly off the same parse, regardless of which
// `slot` (if any) was requested.
test('INT-163-1: a league with D/ST pointsOverrides reports hasOverrides and the override slot', () => {
  const lg = espnLeague([...OFFENSE_ITEMS, ...DST_ITEMS]);
  assert.equal(scoringFor(lg).espn.hasOverrides, true, 'the payload carries pointsOverrides even when slot is not requested');
  assert.deepEqual(scoringFor(lg).espn.overrideSlots, [16]);
  // Still true when a slot IS requested and resolved.
  assert.equal(scoringFor(lg, { slot: 16 }).espn.hasOverrides, true);
  assert.deepEqual(scoringFor(lg, { slot: 16 }).espn.overrideSlots, [16]);
});

test('INT-163-1: a league with no pointsOverrides anywhere reports hasOverrides false', () => {
  const lg = espnLeague(OFFENSE_ITEMS);
  assert.equal(scoringFor(lg).espn.hasOverrides, false);
  assert.deepEqual(scoringFor(lg).espn.overrideSlots, []);
});

test('INT-163-1: overrideSlots collects every distinct slot id across items, sorted numerically', () => {
  const items = OFFENSE_ITEMS.map(it => it.statId === 53 ? item(53, 1, { 6: 1.5, 16: 0.5 }) : it);
  const s = scoringFor(espnLeague(items));
  assert.deepEqual(s.espn.overrideSlots, [6, 16]);
  // overrideSlots is independent of the requested slot: a caller that resolved
  // one slot must still see every other slot it is not pricing. A skeptic's
  // mutant filtered the set to `slot` and every earlier assertion survived,
  // because their fixture only ever had one override slot.
  assert.deepEqual(scoringFor(espnLeague(items), { slot: 16 }).espn.overrideSlots, [6, 16]);
  assert.deepEqual(scoringFor(espnLeague(items), { slot: 6 }).espn.overrideSlots, [6, 16]);
  assert.equal(scoringFor(espnLeague(items), { slot: 2 }).espn.hasOverrides, true, 'a slot no item overrides still sees the payload has overrides');
});

test('INT-163-1: a fallback (no payload / not-espn) reports hasOverrides false, not undefined', () => {
  assert.equal(scoringFor({ platform: 'espn', ppr: 1, payload: null }).espn.hasOverrides, false);
  assert.equal(scoringFor({ platform: 'sleeper', ppr: 1 }).espn.hasOverrides, false);
});

test('A-03: a known id that pays NEGATIVE points is reported as unscored too', () => {
  // A skeptic's surviving mutant turned `pts !== 0` into `pts > 0` and every
  // test still passed. Real leagues pay negative known ids (85 missedFieldGoals = -1 at base;
  // the points-allowed tiers 122-125 and 132-136 under slot 16), so a
  // positive-only filter would drop them from the report without a sound.
  const base = scoringFor(espnLeague([...OFFENSE_ITEMS, item(85, -1)]));
  assert.deepEqual(base.espn.unscored.map(u => [u.statId, u.points]), [[85, -1]]);
  const dst = scoringFor(espnLeague([...OFFENSE_ITEMS, ...DST_ITEMS]), { slot: 16 });
  const neg = dst.espn.unscored.filter(u => u.points < 0).map(u => u.statId);
  assert.deepEqual(neg, [122, 123, 124, 125, 132, 133, 134, 135, 136]);
});
