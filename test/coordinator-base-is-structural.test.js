/**
 * The fantasy coordinator's correction was being added to the wrong number
 * (2026-09-20).
 *
 * `coordinateFantasy(fit, experts, base)` returns `base + correction`. The
 * correction is not a free-floating adjustment: it is a residual **from the
 * structural head**, by construction and by grading.
 *
 *   - Training target: `actualPoints - projection.structural_ppg`
 *     (fantasy-coordinator.js:324).
 *   - Walk-forward baseline: "predict zero correction = plain structural
 *     projection" (:519), scored with `structuralPpg = 0` so the correction alone
 *     is what is graded.
 *
 * `assetUniverse` passed `weeklyPpg` — `weekProjection.ppg`, the ENSEMBLE — so
 * production served `ensemble + correction`, a combination that was never graded
 * against anything.
 *
 * And it double-counts a specific thing rather than being merely off-base. One of
 * the correction's three experts is `ensemble_shift`, defined as
 * `projection.ppg - projection.structural_ppg` (:33-34): the ensemble calibration
 * itself. Feeding the ensemble as the base applies that calibration once in the
 * base and again inside the correction.
 *
 * These tests pin the choice of base as a named, checkable unit rather than as an
 * argument at one call site, because an argument at one call site is exactly how
 * it went wrong — and `weeklyProjectionFor` (fantasy-coordinator.js:571) makes the
 * same mistake in the other direction of the same seam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coordinator-base-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { coordinatorBase } = await import('../server/services/trade-engine.js');
const { fitFantasyCoordinator, coordinateFantasy } = await import('../server/services/fantasy-coordinator.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Deterministic pseudo-noise, the same shape test/fantasy-coordinator.test.js
// uses, so the fit below is reproducible and owes nothing to Math.random.
function noise(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; };
}

/** Examples in the real shape: target is the residual FROM THE STRUCTURAL HEAD. */
function examples() {
  const rand = noise(11);
  const rows = [];
  for (let week = 1; week <= 20; week++) {
    for (let i = 0; i < 15; i++) {
      const trueSignal = rand() * 3;
      rows.push({
        season: 2024, week,
        target: 0.8 * trueSignal + rand() * 0.5,
        experts: {
          ensemble_shift: trueSignal + rand() * 0.3,
          boom_bust_signal: trueSignal + rand() * 0.4,
          game_script_delta: rand() * 3
        }
      });
    }
  }
  return rows;
}

const fit = fitFantasyCoordinator(examples());

test('the fit is real, so the tests below are about a correction that exists', () => {
  // The premise. A not-ready fit returns no correction at all and every
  // assertion below would hold for the wrong reason.
  assert.equal(fit.ready, true, fit.reason ?? 'the fixture must produce a fitted coordinator');
});

test('the correction is declared to be a residual from the structural projection', () => {
  // Not decoration. If someone re-bases the fit onto the ensemble, this string is
  // the first thing that changes and this file goes red — which is the only early
  // warning the consumer gets, since both bases are plausible-looking numbers.
  assert.equal(fit.safeguards.target, 'structural-projection residual');
});

test('the base is the structural head, not the ensemble', () => {
  assert.equal(coordinatorBase({ ppg: 12.4, structural_ppg: 10.1 }), 10.1);
});

test('with no structural head the coordinator is skipped, not handed the ensemble', () => {
  // The dangerous fallback is the plausible one. Substituting `ppg` here would
  // reintroduce the whole defect for exactly the players the structural model
  // could not price, and it would look like a sensible default.
  assert.equal(coordinatorBase({ ppg: 12.4 }), null);
  assert.equal(coordinatorBase({ ppg: 12.4, structural_ppg: null }), null);
  assert.equal(coordinatorBase(null), null);
});

test('what is served is the base plus the correction, whatever base it is given', () => {
  // The rule that makes the choice of base matter at all.
  const experts = { ensemble_shift: 1.5, game_script_delta: 0.2, boom_bust_signal: 1.4 };
  const out = coordinateFantasy(fit, experts, 10.1);
  assert.equal(out.ready, true);
  assert.equal(out.structural_ppg, 10.1);
  assert.equal(out.corrected_ppg, +(10.1 + out.correction).toFixed(3));
});

test('feeding the ensemble instead moves the served number by exactly the ensemble shift', () => {
  // The size of the defect, stated rather than asserted vaguely: the two calls
  // differ by `ppg - structural_ppg`, which is the ensemble_shift expert's own
  // value — the quantity already inside the correction.
  const structural = 10.1, ensembleShift = 2.3, ensemble = structural + ensembleShift;
  const experts = { ensemble_shift: ensembleShift, game_script_delta: 0.2, boom_bust_signal: 1.4 };

  const right = coordinateFantasy(fit, experts, structural);
  const wrong = coordinateFantasy(fit, experts, ensemble);

  assert.equal(right.correction, wrong.correction, 'the correction itself is unchanged; only the base moves');
  assert.equal(+(wrong.corrected_ppg - right.corrected_ppg).toFixed(3), ensembleShift);
  assert.notEqual(right.corrected_ppg, wrong.corrected_ppg,
    'and the fixture must have a non-zero shift, or this test proves nothing');
});
