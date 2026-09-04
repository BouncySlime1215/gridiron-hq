import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFor, scoreLine, PPR } from '../server/services/scoring.js';

// A real ESPN scoringSettings.scoringItems payload, shape-for-shape as stored
// on leagues.payload — confirmed against a real synced league this session.
// statId 44 (rushing two-point conversion) was previously mis-mapped to the
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
  assert.equal(s.rec, 1, 'statId 44 (rushing 2pt) must never overwrite statId 53 (the real reception value)');
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
