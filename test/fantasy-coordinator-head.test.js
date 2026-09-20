/**
 * Which number the coordinator's correction is added to (2026-09-20).
 *
 * `coordinateFantasy(fit, expertValues, structuralPpg)` returns
 * `structuralPpg + correction`, and that correction was fitted against
 * `actual_weekly_points - projection.structural_ppg` (see the TARGET line in
 * fantasy-coordinator.js's header, and `target:` in
 * buildFantasyCoordinatorExamples). So the head it is added to must be the
 * structural projection and nothing else.
 *
 * `weeklyProjectionFor` passed `projection.ppg` — the ENSEMBLE number — into
 * that slot. The two differ by `projection.ensemble_shift`, which is itself
 * one of the three experts the correction was learned from, so the published
 * `corrected_ppg` added the ensemble shift once outright and a learned
 * multiple of it a second time. Nothing errored: the field is a plausible
 * fantasy-point number either way, which is why it survived.
 *
 * THE FIXTURE MATTERS. `structural_ppg` is 11 and `ppg` is 14, deliberately
 * unequal, because a fixture where the ensemble equals the structural head
 * cannot tell the two implementations apart and would pass against the defect.
 * The first assertion of the fitted test is that they are still unequal.
 *
 * Second rule here: when no fit is persisted — which is the live app's state
 * today — `corrected_ppg` was set to `projection.ppg`, publishing the plain
 * ensemble number under the name of a corrected one. There is nothing to
 * correct with, so the honest value is null, and `ensemble_ppg` already
 * carries that number for any caller that wants it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coordinator-head-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');

const STRUCTURAL = 11;
const ENSEMBLE = 14;          // ensemble_shift = +3, the gap that makes the two heads distinguishable
const PLAYER = 4242;

const PROJECTION = Object.freeze({
  params: { pid: PLAYER },
  structural_ppg: STRUCTURAL,
  ppg: ENSEMBLE,
  ensemble_shift: ENSEMBLE - STRUCTURAL,
  team: null,                 // no team -> gameScriptFor is never reached, game_script_delta stays null
  player_week_engine: { cutoff: '2026-09-14' }
});

// Spread the real module and override only the three functions this path calls:
// boom-bust.js and trade-engine.js import the same module, and a bare mock would
// hand them an empty one.
const realEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realEngine,
    buildPlayerWeekEngine: () => ({ cutoff: '2026-09-14' }),
    playerWeekProjection: (_engine, playerId) => (playerId === PLAYER ? { ...PROJECTION } : null),
    playerWeekEventExpectation: () => ({ structural_fantasy_points: STRUCTURAL })
  }
});

const {
  fitFantasyCoordinator, saveFantasyCoordinatorFit, weeklyProjectionFor
} = await import('../server/services/fantasy-coordinator.js?head-mocks');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Deterministic examples in the real shape; enough rows to clear MIN_ROWS (200). */
function examples() {
  let s = 20260920;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; };
  const out = [];
  for (let week = 1; week <= 20; week++) {
    for (let i = 0; i < 15; i++) {
      const signal = rand() * 3;
      out.push({
        season: 2024, week,
        target: 0.8 * signal + rand() * 0.5,
        experts: {
          ensemble_shift: signal + rand() * 0.3,
          game_script_delta: rand() * 3,
          boom_bust_signal: signal + rand() * 0.4
        }
      });
    }
  }
  return out;
}

test('with no fit persisted, corrected_ppg is null rather than the ensemble number', () => {
  // Runs FIRST, before any fit is saved: this is the live app's state today.
  const out = weeklyProjectionFor(PLAYER, { season: 2026, week: 2 });
  assert.ok(out, 'the projection itself is real; only the correction is missing');
  assert.equal(out.corrected_ppg, null,
    'there is nothing to correct with, so a number here would be the ensemble wearing the corrected name');
  assert.equal(out.coordinator, null);
  // The consumer's side of the same rule: nothing is lost by the null, because the
  // ensemble number is still published under its own name. routes/drafts.js reads
  // this chain, so if this ever stops holding, that page prints a worse number.
  assert.equal(out.ensemble_ppg, ENSEMBLE);
  assert.equal(out.structural_ppg, STRUCTURAL);
});

test('the correction is added to the structural head, not to the ensemble', () => {
  assert.notEqual(STRUCTURAL, ENSEMBLE,
    'a fixture whose ensemble equals its structural head cannot tell the two apart');
  const fit = fitFantasyCoordinator(examples());
  assert.equal(fit.ready, true, 'the fixture must actually produce a usable fit');
  assert.equal(saveFantasyCoordinatorFit(fit, 2025).inserted, true);

  const out = weeklyProjectionFor(PLAYER, { season: 2026, week: 2 });
  assert.ok(out.coordinator, 'a saved fit must actually be applied');
  const correction = out.coordinator.correction;
  assert.ok(Number.isFinite(correction) && correction !== 0, `correction is ${correction}`);

  const round3 = x => Number(x.toFixed(3));
  assert.equal(out.corrected_ppg, round3(STRUCTURAL + correction));
  assert.notEqual(out.corrected_ppg, round3(ENSEMBLE + correction),
    'adding the correction to the ensemble double-counts ensemble_shift, which is one of its own experts');
  assert.equal(out.structural_ppg, STRUCTURAL, 'the head is reported, not just used');
  assert.equal(out.ensemble_ppg, ENSEMBLE, 'and the ensemble number is still available under its own name');
});
