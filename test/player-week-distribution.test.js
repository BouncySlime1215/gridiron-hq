/**
 * playerWeekDistribution: a week the player does not play scores 0.
 *
 * The bug (live, 2026 week 2): the sampler returned 0 for a did-not-play draw and
 * the ensemble shift (blend minus structural) was then added to EVERY draw, so a
 * DNP week scored the shift. For P(play) < 0.9 and a positive shift, more than 10%
 * of draws sat at exactly `shift` and every played draw was above it, so the
 * printed floor (p10) was the shift itself: in league 1's assets, 99 of the 99
 * players projected over 5 with a positive shift (Caleb Williams, floor 13.9 at
 * P(play) 0.76). The mean was inflated by (1 - P(play)) x shift.
 *
 * Gate and eval definition: scratchpad step1b/fake-floors/GATE.md and
 * docs/tdd/fake-floors.tdd.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

if (!process.env.GRIDIRON_DB_PATH) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pwd-test-'));
  process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
}
process.env.SCHEDULER_DISABLED = '1';

const { playerWeekDistribution } = await import('../server/services/player-week-engine.js');

const params = overrides => ({
  attempts: 0, carries: 0, targets: 0, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025,
  ypc: 4.2, rush_td_rate: 0.03, catch_rate: 0.68,
  ypt: 8, rec_td_rate: 0.05, ...overrides
});
const engine = { season: 2026, week: 2 };
const player = (id, position, shift, overrides) => ({
  player_id: id, position, player_week_engine: engine, ensemble_shift: shift,
  params: params({ position, ...overrides })
});
const dist = (projection, opts) => playerWeekDistribution(projection, { useCache: false, ...opts });
const PERCENTILES = ['p5', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95'];

/* ------------------------------------------------ capability: DNP scores 0 */

test('C1 a did-not-play week scores 0, not the ensemble shift', () => {
  const wr = player(9201, 'WR', 8, { targets: 8 });
  const d = dist(wr, { runs: 2000, activeProbability: 0.5 });
  assert.equal(d.p5, 0, `p05 ${d.p5}: half the draws are DNP and must be 0`);
  assert.equal(d.p10, 0, `p10 ${d.p10}: a DNP draw scored the +8 shift`);
  assert.equal(d.p25, 0, `p25 ${d.p25}: a DNP draw scored the +8 shift`);
});

test('C2 the Caleb Williams case: floor is 0 at P(play) 0.76, not the +13.9 shift', () => {
  const qb = player(9202, 'QB', 13.9, { attempts: 33, carries: 4 });
  const d = dist(qb, { runs: 2000, activeProbability: 0.76 });
  assert.notEqual(d.p10, 13.9, 'the floor equals the shift: DNP draws are scoring the shift');
  assert.equal(d.p10, 0, `24% of weeks are DNP, so the 10th percentile is 0 (got ${d.p10})`);
});

test('C3 exactly a (1 - P(play)) share of draws is 0', () => {
  // +30 puts every played draw above the WR bust line (8) and boom line (18),
  // so bust_rate is exactly the DNP share and boom_rate exactly the played share.
  const wr = player(9203, 'WR', 30, { targets: 8 });
  for (const p of [0.76, 0.57, 0.9]) {
    const d = dist(wr, { runs: 2000, activeProbability: p });
    const dnpShare = Math.round((1 - p) * 2000) / 2000;
    assert.equal(d.bust_rate, +dnpShare.toFixed(3), `P(play) ${p}: DNP share ${d.bust_rate}, want ${dnpShare}`);
    assert.equal(d.boom_rate, +(1 - dnpShare).toFixed(3),
      `P(play) ${p}: boom share ${d.boom_rate}; a DNP week cannot boom`);
  }
});

test('C4 the mean is P(play) x the played-week mean, not inflated by (1 - P(play)) x shift', () => {
  const wr = player(9204, 'WR', 8, { targets: 8 });
  const full = dist(wr, { runs: 20000, activeProbability: 1 });
  const part = dist(wr, { runs: 20000, activeProbability: 0.6 });
  const want = 0.6 * full.mean;
  assert.ok(Math.abs(part.mean - want) / want < 0.02,
    `mean at P(play) 0.6 is ${part.mean}; 0.6 x ${full.mean} = ${want.toFixed(2)}`);
});

test('C5 P(play) 0 gives an all-zero week', () => {
  const qb = player(9205, 'QB', 6, { attempts: 33, carries: 4 });
  const d = dist(qb, { runs: 1000, activeProbability: 0 });
  assert.equal(d.mean, 0);
  for (const k of PERCENTILES) assert.equal(d[k], 0, `${k} = ${d[k]}`);
  assert.equal(d.boom_rate, 0);
  assert.equal(d.bust_rate, 1);
});

test('C6 P(play) outside [0, 1] is clamped', () => {
  const wr = player(9206, 'WR', 30, { targets: 8 });
  const below = dist(wr, { runs: 1000, activeProbability: -0.3 });
  assert.equal(below.mean, 0, `P(play) -0.3 must behave as 0 (mean ${below.mean})`);
  assert.equal(below.p95, 0);
  const above = dist(wr, { runs: 1000, activeProbability: 1.7 });
  assert.equal(above.bust_rate, 0, 'P(play) 1.7 must behave as 1: no DNP draws');
  assert.ok(above.p5 >= 30, `every played draw carries the +30 shift (p5 ${above.p5})`);
});

/* ---------------------------------------------------------- regression */

test('R1 at P(play) 1 the output is bit-identical to the pre-fix engine', () => {
  // Golden values captured from the pre-fix code (HEAD e2ba4c4) with these exact
  // inputs. The seed is derived from the cache key, which includes
  // PLAYER_WEEK_ENGINE_VERSION, and the draws come from projections.js#sampleWeeks:
  // a deliberate change to either re-rolls these numbers and this test must be
  // re-captured, which is the point.
  const golden = {
    qb: { p5: 6.1, p10: 7.8, p25: 11.5, p50: 17, p75: 24.5, p90: 32.4, p95: 38.5, mean: 18.98, boom_rate: 0.266, bust_rate: 0.363 },
    rb: { p5: 0, p10: 1.7, p25: 5.6, p50: 11.2, p75: 18.8, p90: 26.2, p95: 32.2, mean: 13.07, boom_rate: 0.272, bust_rate: 0.36 },
    wr: { p5: 10, p10: 11.5, p25: 15.1, p50: 20.3, p75: 27.6, p90: 36, p95: 41.1, mean: 22.36, boom_rate: 0.61, bust_rate: 0.015 },
    te: { p5: 0, p10: 1.8, p25: 4.6, p50: 9.3, p75: 15.2, p90: 21.5, p95: 26.1, mean: 10.77, boom_rate: 0.293, bust_rate: 0.335 }
  };
  assert.deepEqual(dist(player(9101, 'QB', 2.5, { attempts: 33, carries: 4 }),
    { runs: 2000, activeProbability: 1, mult: { pass: 1.05, rush: 0.95 } }), golden.qb);
  assert.deepEqual(dist(player(9102, 'RB', -3, { carries: 15, targets: 4 }),
    { runs: 2000, activeProbability: 1 }), golden.rb);
  assert.deepEqual(dist(player(9103, 'WR', 8, { targets: 8 }),
    { runs: 2000, activeProbability: 1 }), golden.wr);
  assert.deepEqual(dist(player(9104, 'TE', 0, { targets: 6 }), { runs: 2000 }), golden.te);
});

test('R2 the draw is deterministic for the same inputs', () => {
  const qb = player(9207, 'QB', 4, { attempts: 30, carries: 3 });
  const a = dist(qb, { runs: 2000, activeProbability: 0.83 });
  const b = dist(qb, { runs: 2000, activeProbability: 0.83 });
  assert.deepEqual(a, b);
});

test('R3 a negative shift still clamps every week at 0', () => {
  const rb = player(9208, 'RB', -100, { carries: 15, targets: 4 });
  const d = dist(rb, { runs: 1000, activeProbability: 1 });
  assert.equal(d.mean, 0);
  for (const k of PERCENTILES) assert.equal(d[k], 0, `${k} = ${d[k]}`);
});

test('R5 the cached call returns the same summary as the uncached one', () => {
  const te = player(9209, 'TE', 3, { targets: 6 });
  const cachedOnce = playerWeekDistribution(te, { runs: 1000, activeProbability: 0.8 });
  const cachedTwice = playerWeekDistribution(te, { runs: 1000, activeProbability: 0.8 });
  assert.equal(cachedOnce, cachedTwice, 'second call is a cache hit');
  assert.deepEqual(cachedOnce, dist(te, { runs: 1000, activeProbability: 0.8 }));
});

test('R6 a non-numeric P(play) plays every week, as the old sampler did', () => {
  // The old sampler's `random() > NaN` was always false, i.e. always active.
  const wr = player(9210, 'WR', 30, { targets: 8 });
  const d = dist(wr, { runs: 1000, activeProbability: Number.NaN });
  assert.equal(d.bust_rate, 0, 'NaN must not zero the week');
  assert.ok(d.p5 >= 30, `every draw is a played week carrying the +30 shift (p5 ${d.p5})`);
});

test('R7 a structural-only player (no ensemble shift) is shift 0, and a sitting week is 0', () => {
  const base = player(9211, 'RB', 0, { carries: 15, targets: 4 });
  const { ensemble_shift, ...structuralOnly } = base;
  assert.equal(ensemble_shift, 0);
  const a = dist(structuralOnly, { runs: 2000, activeProbability: 0.76 });
  assert.deepEqual(a, dist(base, { runs: 2000, activeProbability: 0.76 }));
  assert.equal(a.p10, 0, '24% of weeks are DNP');
});
