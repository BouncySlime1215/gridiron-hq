/**
 * The weekly boom/bust shock (projections.js#sampleWeeks, WEEKLY_LEVEL), as properties.
 *
 * Commit 11ab55c made the shock mean-preserving (divided by weeklyLevelMean), gave it a
 * two-piece shape (downMult) and per-position sigmas, and made `{ sigma }` without
 * `byPosition` mean that sigma for everyone. The only thing holding any of it was one
 * golden snapshot captured after the change, so a legitimate refit would break the
 * golden with no statement of what still has to hold. These are those statements.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weekly-level-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { sampleWeeks, weeklyLevelMean, WEEKLY_LEVEL } = await import('../server/services/projections.js');
const { withRandomSeed } = await import('../server/services/stats-util.js');
const { PPR } = await import('../server/services/scoring.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const params = (position, overrides) => ({
  position, attempts: 0, carries: 0, targets: 0, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05, ...overrides
});
const PLAYERS = {
  QB: params('QB', { attempts: 34, carries: 4 }),
  RB: params('RB', { carries: 16, targets: 4 }),
  WR: params('WR', { targets: 9 }),
  TE: params('TE', { targets: 6 })
};
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const draw = (position, n, levelOpts, seed = 7) =>
  withRandomSeed(seed, () => sampleWeeks(PLAYERS[position], n, PPR, 1, 1, levelOpts));

// An independent standard normal (Box-Muller on a seeded LCG), not the module's own.
function normals(n, seed = 12345) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 2 ** 32; };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(u())), t = 2 * Math.PI * u();
    out[i] = r * Math.cos(t); if (i + 1 < n) out[i + 1] = r * Math.sin(t);
  }
  return out;
}

test('(a) with no downside multiplier the shock mean is exp(sigma^2 / 2)', () => {
  assert.equal(weeklyLevelMean(0.45, 1), Math.exp(0.45 ** 2 / 2));
  assert.equal(weeklyLevelMean(0, 1.6), 1);
});

test('(b) the two-piece shock mean matches a 200,000-draw simulation within 0.5%', () => {
  const sigma = 0.3, down = 1.6;
  const z = normals(200000);
  let s = 0;
  for (const x of z) s += Math.exp(x < 0 ? x * sigma * down : x * sigma);
  const simulated = s / z.length;
  assert.ok(Math.abs(weeklyLevelMean(sigma, down) / simulated - 1) < 0.005,
    `closed form ${weeklyLevelMean(sigma, down)} vs simulated ${simulated}`);
});

test('(c) the shock is mean-preserving: the simulated mean equals the no-shock mean within 1%', () => {
  // 100,000 draws: at 20,000 the two independent means differ by up to ~1.3% by chance
  // (measured); at 200,000 they agree within 0.5% for QB and WR over three seeds.
  for (const position of ['QB', 'WR']) {
    const shocked = mean(draw(position, 100000));
    const flat = mean(draw(position, 100000, { sigma: 0 }));
    assert.ok(Math.abs(shocked / flat - 1) < 0.01, `${position}: ${shocked} vs ${flat}`);
  }
});

test('(d) each position gets its own sigma: QB 0.30, WR 0.20 by default', () => {
  assert.deepEqual({ ...WEEKLY_LEVEL.byPosition }, { QB: 0.30, RB: 0.30, WR: 0.20, TE: 0.25 });
  assert.deepEqual(draw('QB', 500), draw('QB', 500, { sigma: 0.30, byPosition: null }));
  assert.deepEqual(draw('WR', 500), draw('WR', 500, { sigma: 0.20, byPosition: null }));
  assert.notDeepEqual(draw('WR', 500), draw('WR', 500, { sigma: 0.30, byPosition: null }));
});

test('(e) { sigma: 0 } turns the shock off for every position', () => {
  const zero = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const position of Object.keys(PLAYERS)) {
    assert.deepEqual(draw(position, 300, { sigma: 0 }), draw(position, 300, { sigma: 0, byPosition: zero }), position);
  }
});

test('(f) meanPreserving: false moves the mean by exactly the shock mean', () => {
  const flat = mean(draw('WR', 100000, { sigma: 0 }));
  const unnormalised = mean(draw('WR', 100000, { meanPreserving: false }));
  // With the stretched downside (downMult 1.6) the raw two-piece shock averages 0.985
  // for a WR, below 1; with the old symmetric shock (downMult 1) it averaged above 1.
  const want = weeklyLevelMean(0.20, WEEKLY_LEVEL.downMult);
  assert.ok(Math.abs(want - 0.985) < 0.001, `shock mean ${want}`);
  assert.ok(Math.abs(unnormalised / flat / want - 1) < 0.01, `ratio ${unnormalised / flat} vs ${want}`);
});
