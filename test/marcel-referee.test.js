/**
 * Marcel-NFL referee (R&D r37 IDEA-026). The fixture is the synthetic player the R&D
 * run hand-computed: 40 pts in 4 games now, 170/17 and 150/15 the two seasons before,
 * nothing three back, position mean 10, R 8, w0 6, a 0.02, age 25, peak 27.
 *   (6*40 + 5*170 + 4*150 + 3*0 + 8*10) / (6*4 + 5*17 + 4*15 + 3*0 + 8) * (1 + 0.02*2)
 *   = 1770 / 177 * 1.04 = 10.4
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARCEL_PARAMS, marcelPrediction, ageAtSeason, positionMeans, marcelRefereeChecks
} from '../server/services/marcel-referee.js';

const FIXTURE_PARAMS = { ...MARCEL_PARAMS, R: 8, w0: 6, peak: 27 };

test('fixture: synthetic player, hand-computed == function', () => {
  const hand = (6 * 40 + 5 * 170 + 4 * 150 + 3 * 0 + 8 * 10) / (6 * 4 + 5 * 17 + 4 * 15 + 3 * 0 + 8) * (1 + 0.02 * (27 - 25));
  const fn = marcelPrediction({ points: [40, 170, 150, 0], games: [4, 17, 15, 0], positionMean: 10,
    position: 'WR', age: 25, params: FIXTURE_PARAMS });
  assert.ok(Math.abs(hand - 10.4) < 1e-12);
  assert.ok(Math.abs(fn - hand) < 1e-12, `fn ${fn} != hand ${hand}`);
});

test('pinned params match the confirmed R&D fit', () => {
  assert.deepEqual({ ...MARCEL_PARAMS.R }, { QB: 32, RB: 16, WR: 6, TE: 12 });
  assert.equal(MARCEL_PARAMS.w0, 16);
  assert.deepEqual([...MARCEL_PARAMS.priorWeights], [5, 4, 3]);
  assert.equal(MARCEL_PARAMS.a, 0.02);
  assert.deepEqual({ ...MARCEL_PARAMS.peak }, { QB: 29, RB: 25, WR: 27, TE: 28 });
});

test('no history = position mean; unknown age = no age factor; age factor is clamped', () => {
  assert.equal(marcelPrediction({ points: [0, 0, 0, 0], games: [0, 0, 0, 0], positionMean: 12.5, position: 'RB' }), 12.5);
  const base = { points: [60, 0, 0, 0], games: [4, 0, 0, 0], positionMean: 10, position: 'TE' };
  const noAge = marcelPrediction(base);
  assert.ok(Math.abs(noAge - (16 * 60 + 12 * 10) / (16 * 4 + 12)) < 1e-12);
  assert.ok(Math.abs(marcelPrediction({ ...base, age: 60 }) - noAge * 0.8) < 1e-12);
  assert.ok(Math.abs(marcelPrediction({ ...base, age: 5 }) - noAge * 1.2) < 1e-12);
  assert.equal(marcelPrediction({ ...base, positionMean: null }), null);
});

test('age at 1 Sep of the season', () => {
  assert.ok(Math.abs(ageAtSeason('1999-09-01', 2024) - 9132 / 365.25) < 1e-12);
  assert.equal(ageAtSeason(null, 2024), null);
  assert.equal(ageAtSeason('not-a-date', 2024), null);
});

test('position means are games-weighted', () => {
  const act = new Map([[1, { points: 100, games: 10 }], [2, { points: 30, games: 10 }], [3, { points: 50, games: 5 }]]);
  const pos = new Map([[1, 'WR'], [2, 'WR'], [3, 'QB']]);
  const m = positionMeans(act, pos);
  assert.equal(m.WR, 6.5);
  assert.equal(m.QB, 10);
  assert.equal(m.RB, null);
});

test('referee checks: candidate <= marcel per season x w, skips seasons with no marcel', () => {
  const bySeason = {
    2023: { by_w: { 1: { primary: { d_update: { mae: 2.5 }, marcel: { mae: 2.6, n: 9 } } },
      2: { primary: { d_update: { mae: 2.7 }, marcel: { mae: 2.6, n: 9 } } } } },
    2025: { by_w: { 1: { primary: { d_update: { mae: 2.0 } } } } }
  };
  const r = marcelRefereeChecks(bySeason, { seasons: [2023, 2025], ws: [1, 2] });
  assert.deepEqual(r.checks.map(c => [c.season, c.w, c.ok]), [[2023, 1, true], [2023, 2, false]]);
  assert.equal(r.all_ok, false);
});
