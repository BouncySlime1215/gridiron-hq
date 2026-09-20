/**
 * Which shrinkage constants a projection call actually used, reported beside the odds.
 *
 * The UI thread asked for a field naming whether the odds ran on the fitted shrinkage
 * constants or the hand-set ones, because after the fit lands those diverge and the
 * divergence is the whole reason a basis label exists. `activeFitMeta()` was the obvious
 * source and could not answer it: it returns `{id, through_season, fitted_at}` and nothing
 * about recency, and the recency is what decides which constants a caller receives.
 *
 * THE THING THAT MAKES THIS WORTH A FIELD. `activeKVectorFor` withholds the VOLUME entries
 * of the fitted vector from any caller that is not on weekly-role recency, and its own
 * header says those callers "keep the hand-picked constants they were validated with. They
 * are not claimed to be right, only untested with the fitted k." The simulator is one of
 * those callers. So even with an active fit, the odds run on fitted efficiency constants
 * and unvouched-for volume constants, and a field reporting only the fit id would say the
 * opposite of what is happening.
 *
 * These tests deliberately run with NO active fit in the database, which is the state the
 * live volume is in (shrinkage_fits holds zero rows). That case has to read as
 * "hand-set constants", not as a missing field, because a missing field is invisible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { projectionFitMeta, RECENCY } = await import('../server/services/projections.js');
const { isWeeklyRoleRecency, VOLUME_METRICS } = await import('../server/services/shrinkage-fit.js');

test('no active fit reports null, which reads as the hand-set constants', () => {
  // Not an error and not an omission: the live database holds zero rows in shrinkage_fits,
  // so this is the production case, and a consumer must be able to render it.
  assert.equal(projectionFitMeta({ through: 2026, throughWeek: 2 }), null);
});

test('the metadata is derived from the same call arguments the projections used', () => {
  // Both call shapes the simulator produces: an in-season cutoff and a season-boundary one.
  // Neither may throw, whatever the fit tables hold, because this runs inside the odds path.
  for (const args of [{ through: 2026, throughWeek: 2 }, { through: 2025, throughWeek: null }]) {
    const meta = projectionFitMeta(args);
    assert.ok(meta === null || typeof meta === 'object', `${JSON.stringify(args)}`);
    if (meta) {
      assert.ok(['weekly_role', 'season_long'].includes(meta.recency));
      assert.ok(['fitted', 'hand_set'].includes(meta.volume_k));
    }
  }
});

test('the simulator call site resolves to season-long recency, not weekly-role', () => {
  // This is the fact the field exists to carry, and it is a property of the CALL SITE
  // rather than of the fit, so it can be asserted without any fit stored. `simulateSeason`
  // and `tradeImpact` pass no roleRecency, so their recency is RECENCY itself.
  assert.equal(isWeeklyRoleRecency({ ...RECENCY }), false);
});

test('the volume metrics the fit withholds from this caller are named, not assumed', () => {
  // If this list ever empties, `volume_k` stops meaning anything and the field would report
  // 'fitted' for a caller that is still on hand-set volume constants.
  assert.ok(VOLUME_METRICS.length > 0, 'the volume metric list is what volume_k is about');
});
