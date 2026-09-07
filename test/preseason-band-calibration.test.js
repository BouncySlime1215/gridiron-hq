/**
 * The p20/p80 band's calibration properties.
 *
 * The shipped band reads ratio quantiles from a Gaussian window over `pos_rank`
 * (`fitSpreadCurve`), replacing three hard tiers that made the band far too wide out of
 * sample. See docs/PRESEASON_BAND_CALIBRATION.md for the walk-forward numbers this
 * decision rests on; these tests pin the properties that decision assumed, on synthetic
 * data so they run without the user's real database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-band-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

await import('../server/db/index.js');
const { fitPreseasonModel, spreadFor, componentsFor, blendPoints, FEATURE_NAMES, SPREAD_TIERS } =
  await import('../server/services/preseason-model.js');

/** Deterministic LCG — a seeded generator so the assertions below never flake. */
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * Synthetic training rows whose relative spread WIDENS with positional rank: the elite
 * slot is a +/-15% player, the deep slot a +/-70% player. That is the real structure the
 * tier table smeared away, so it is the structure these tests check the curve recovers.
 */
function makeRows({ seasons = 3, perPos = 90, seed = 7 } = {}) {
  const rand = rng(seed);
  const rows = [];
  for (let s = 0; s < seasons; s++) {
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      for (let rank = 1; rank <= perPos; rank++) {
        const base = 300 - 2.0 * rank;
        const relSpread = 0.15 + 0.0065 * rank;          // widens with rank
        const shock = 1 + relSpread * (rand() * 2 - 1) * 1.8;
        rows.push({
          position, pos_rank: rank, market_rank: rank * 4, name: `${position}${rank}-${s}`,
          gsis: `${position}${rank}-${s}`, has_projection: 0,
          features: Object.fromEntries(FEATURE_NAMES.map(f => [f, 0])),
          vector: FEATURE_NAMES.map(() => 0),
          actual_points: Math.max(0, base * shock),
          actual_games: 16, actual_ppg: Math.max(0, base * shock) / 16
        });
      }
    }
  }
  return rows;
}

test('the band is fitted as a rank-local curve, not three hard tiers', () => {
  const model = fitPreseasonModel(makeRows());
  assert.ok(model.spreadCurve, 'a fit exposes spreadCurve');
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    assert.ok(model.spreadCurve[pos], `${pos} has a curve`);
  }
  // The tier table is still fitted and kept as the fallback for a thin position.
  assert.ok(model.spread?.WR?.early, 'the tier table survives as the fallback');
});

test('the band resolves rank inside a tier — WR40 and WR110 no longer share one number', () => {
  const model = fitPreseasonModel(makeRows());
  const lateTier = SPREAD_TIERS.find(t => t.name === 'late');
  assert.ok(40 >= lateTier.lo && 110 >= lateTier.lo, 'both ranks sit in the same old tier');

  const near = spreadFor(model, 'WR', 40), far = spreadFor(model, 'WR', 110);
  const widthNear = near.p80 - near.p20, widthFar = far.p80 - far.p20;
  assert.ok(widthFar > widthNear * 1.15,
    `the deeper slot must get a materially wider band (got ${widthNear.toFixed(3)} vs ${widthFar.toFixed(3)})`);
});

test('the band still widens with rank and still brackets 1.0', () => {
  const model = fitPreseasonModel(makeRows());
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const early = spreadFor(model, pos, 2), late = spreadFor(model, pos, 85);
    assert.ok(early.p20 < 1 && early.p80 > 1, `${pos} elite band brackets 1.0`);
    assert.ok(late.p20 < early.p20 && late.p80 > early.p80,
      `${pos}: the deep slot's band contains the elite slot's`);
  }
});

test('in-sample coverage of the fitted band is close to the 60% nominal', () => {
  const rows = makeRows();
  const model = fitPreseasonModel(rows);
  let inside = 0, total = 0;
  for (const r of rows) {
    const p = blendPoints(model, componentsFor(model, r));
    if (!(p > 20)) continue;
    const sp = spreadFor(model, r.position, r.pos_rank);
    if (r.actual_points >= p * sp.p20 && r.actual_points <= p * sp.p80) inside++;
    total++;
  }
  const coverage = inside / total;
  assert.ok(coverage > 0.5 && coverage < 0.7,
    `coverage ${coverage.toFixed(3)} should sit near the 0.60 nominal`);
});

test('the tier band is materially wider than the rank-local band on the deep slots', () => {
  // This is the whole reason for the change: pooling ranks 37+ into one cell inflates
  // the band for everyone near the front of that range.
  const model = fitPreseasonModel(makeRows());
  const tier = model.spread.WR.late;
  const curve = spreadFor(model, 'WR', 40);
  assert.ok((tier.p80 - tier.p20) > (curve.p80 - curve.p20),
    'the old late-tier cell is wider at WR40 than the rank-local band');
});

test('a rank past the tabulated grid reuses the last cell rather than falling apart', () => {
  const model = fitPreseasonModel(makeRows());
  const deep = spreadFor(model, 'WR', 5000);
  assert.ok(Number.isFinite(deep.p20) && Number.isFinite(deep.p80) && deep.p80 > deep.p20,
    'an off-the-board rank still returns a usable band');
});

test('a position with too few graded rows falls back to the tier table', () => {
  const rows = makeRows().filter(r => r.position !== 'TE' || r.pos_rank <= 3);
  const model = fitPreseasonModel(rows);
  assert.ok(!model.spreadCurve.TE, 'TE has too few rows for a curve');
  const sp = spreadFor(model, 'TE', 2);
  assert.ok(Number.isFinite(sp.p20) && sp.p80 > sp.p20, 'TE still gets a band from the fallback');
});

test('the band is deterministic — the same rows fit the same numbers twice', () => {
  const a = spreadFor(fitPreseasonModel(makeRows()), 'RB', 25);
  const b = spreadFor(fitPreseasonModel(makeRows()), 'RB', 25);
  assert.deepEqual(a, b);
});
