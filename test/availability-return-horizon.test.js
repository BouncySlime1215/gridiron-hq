/**
 * AVAIL-HORIZON (study): the return-to-play curve's pure parts (availability-return.js).
 *
 * TITLE-ZERO (BROKEN-NUMBERS row S): weeklyAvailability's role state only sees games
 * already played, so a starter who missed last week is priced 0.40 for every remaining
 * week. This unit fitted and graded the curve that would replace that frozen rate; it
 * is NOT wired into weeklyAvailability here (declined: the league-4 sim target was not
 * reached), so these tests pin only the fit, the lookup, the served table and the flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
const R = await import('../server/services/availability-return.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

/** Run fn with env vars set (null = unset), restoring them after. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const OFF = { [R.AVAIL_HORIZON_ENV]: null, [PREVIEW_ENV]: null };
const ON = { [R.AVAIL_HORIZON_ENV]: '1', [PREVIEW_ENV]: null };
const PREVIEW = { [R.AVAIL_HORIZON_ENV]: null, [PREVIEW_ENV]: '1' };

/* ------------------------------------------------------------------ pure parts */

test('horizon buckets', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 16].map(R.horizonBucket),
    [null, 'h1', 'h2', 'h3', 'h4', 'h5-6', 'h5-6', 'h7-9', 'h7-9', 'h10+', 'h10+']);
  assert.equal(R.horizonBucket(1.5), null);
});

test('fitReturnCurve shrinks h -> h|gap -> h|gap|tier and the lookup falls back to the deepest cell', () => {
  const obs = [
    ...Array.from({ length: 10 }, (_, i) => ({ h: 2, gap: 'g1', tier: 'starter', active: i < 6 ? 1 : 0 })),
    ...Array.from({ length: 10 }, (_, i) => ({ h: 2, gap: 'g0', tier: 'depth', active: i < 8 ? 1 : 0 })),
    { h: 0, gap: 'g0', tier: 'starter', active: 1 } // h 0 is the one-week model's job: ignored
  ];
  const fit = R.fitReturnCurve(obs, { k: 10 });
  const cell = (h, gap, tier) => fit.find(r => r.h === h && r.gap === gap && r.tier === tier);
  assert.equal(cell('h2', '*', '*').p_active, 0.7);
  assert.equal(cell('h2', 'g1', '*').p_active, +((6 + 10 * 0.7) / 20).toFixed(4));
  const g1 = (6 + 10 * 0.7) / 20;
  assert.equal(cell('h2', 'g1', 'starter').p_active, +((6 + 10 * g1) / 20).toFixed(4));
  assert.equal(fit.reduce((s, r) => s + (r.gap === '*' ? r.n : 0), 0), 20, 'h 0 row not counted');
  const lk = R.buildReturnLookup(fit);
  assert.equal(lk.lookup({ h: 2, gap: 'g1', tier: 'starter' }).basis, 'h2/g1/starter');
  assert.equal(lk.lookup({ h: 2, gap: 'g1', tier: 'fringe' }).basis, 'h2/g1', 'unfitted tier -> gap cell');
  assert.equal(lk.lookup({ h: 2, gap: 'g2', tier: 'starter' }).basis, 'h2', 'unfitted gap -> horizon root');
  assert.equal(lk.lookup({ h: 3, gap: 'g1', tier: 'starter' }), null, 'unfitted horizon -> null');
  assert.equal(lk.lookup({ h: 0, gap: 'g1', tier: 'starter' }), null);
});

test('the served curve covers every horizon for g0/g1/g2 and a missed-one starter heals with distance', () => {
  const lk = R.servedReturnCurve();
  for (const h of [1, 2, 3, 4, 5, 7, 10]) for (const gap of ['g0', 'g1', 'g2']) {
    assert.ok(lk.lookup({ h, gap, tier: 'starter' })?.basis.endsWith('starter'), `h${h} ${gap} starter fitted`);
  }
  const g1 = h => lk.lookup({ h, gap: 'g1', tier: 'starter' }).p;
  assert.ok(g1(5) > g1(1), 'further out, a starter who missed one game is more likely back');
  assert.deepEqual(R.RETURN_CURVE_FIT.fitSeasons, [2021, 2022, 2023, 2024], 'never fit on the 2025 holdout');
});

test('flag: unset off, 1 on, preview on (labelled), 0 vetoes preview', () => {
  withEnv(OFF, () => assert.deepEqual(R.availHorizonFlag(), { on: false, preview: false }));
  withEnv(ON, () => assert.deepEqual(R.availHorizonFlag(), { on: true, preview: false }));
  withEnv(PREVIEW, () => assert.deepEqual(R.availHorizonFlag(), { on: true, preview: true }));
  withEnv({ [R.AVAIL_HORIZON_ENV]: '0', [PREVIEW_ENV]: '1' }, () =>
    assert.deepEqual(R.availHorizonFlag(), { on: false, preview: false }));
});
