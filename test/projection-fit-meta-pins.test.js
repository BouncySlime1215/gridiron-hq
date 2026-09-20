/**
 * The four served fields of the projection basis, pinned against deletion (2026-09-20).
 *
 * WHY A SECOND FILE. `test/projection-fit-meta.test.js` runs with NO active fit, which is
 * the live state -- `shrinkage_fits` holds zero rows -- and is the case it was written for.
 * But `projectionFitMeta` returns null in that state, so its three fields are never
 * evaluated by any test, and each of `fit_id`, `recency` and `volume_k` can be deleted from
 * the returned object with the whole suite staying green. A field a consumer renders and
 * nothing asserts is a field that silently stops arriving.
 *
 * So this file does the opposite: it stores a real fit, activates it, and reads the object
 * that a caller with a live fit actually receives.
 *
 * `recency` AND `volume_k` ARE NOT DECORATION. `activeKVectorFor` withholds the VOLUME
 * entries of the fitted vector from every caller that is not on weekly-role recency -- its
 * own header says those callers "keep the hand-picked constants they were validated with.
 * They are not claimed to be right, only untested with the fitted k." The season simulator
 * is one of them. So with an active fit the odds run on fitted efficiency constants and
 * unvouched-for volume constants at the same time, and a payload carrying only `fit_id`
 * states the opposite of what happened. Deleting `volume_k` is therefore not a smaller
 * version of the truth; it is a different claim.
 *
 * THE FOURTH FIELD WAS NOT WHERE IT WAS REPORTED. The unpinned served field at
 * `season-sim.js:594` is an ARGUMENT -- `through: tradeBasis.through` -- not something
 * served. Reading the function around it found the real defect: `tradeImpact` computes
 * `simProjectionBasis`, uses it to build the shared projection set, and then returns
 * `{ runs, from_week, seed, paired_simulation, me, them }` -- no basis and no fit meta at
 * all. Both inner `simulateSeason` calls are handed `projections`, so each one's own
 * `projection_fit` is null by design. The trade verdict was the one number in this file
 * served with no statement of what it rests on, which is the thing the basis work exists to
 * prevent. That field is added here rather than pinned, and the test is a RED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fit-pins-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { projectionFitMeta } = await import('../server/services/projections.js');
const { saveFit, activateFit, activeFitMeta, isWeeklyRoleRecency, VOLUME_METRICS }
  = await import('../server/services/shrinkage-fit.js');
const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
const { simProjectionBasis, tradeImpactPayload, TRADE_IMPACT_FIELDS }
  = await import('../server/services/season-sim.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const THROUGH = 2025;

/**
 * A fit carrying BOTH an efficiency metric and a volume metric, which is what makes
 * `volume_k` answerable: with volume entries present, a season-long caller still gets them
 * withheld, and that is the divergence the field reports.
 */
const K_VECTOR = [
  { metric: 'yards_per_target', position: 'WR', k: 6.5, n_obs: 400, n_groups: 80 },
  { metric: 'target_share', position: 'ALL', k: 4.25, n_obs: 400, n_groups: 80 },
  { metric: 'team_pass_att', position: 'ALL', k: 3.5, n_obs: 200, n_groups: 32 }
];

const FIT_ID = (() => {
  const id = saveFit({ through: THROUGH, testSeason: THROUGH, kVector: K_VECTOR,
    note: 'fixture for the served-field pins' });
  activateFit(id);
  return id;
})();

test('the fixture really is an active fit, or the pins below test nothing', () => {
  const meta = activeFitMeta();
  assert.equal(meta?.id, FIT_ID);
  assert.equal(meta.through_season, THROUGH);
});

/* ------------------------------------------------------------------ 1. fit_id */

test('fit_id names the stored fit the number came from', () => {
  const meta = projectionFitMeta({ through: THROUGH, throughWeek: null });
  assert.ok(meta, 'an active fit must produce a basis object, not null');
  assert.equal(meta.fit_id, FIT_ID,
    'without this a reader cannot tell which stored fit produced the number, and two fits '
    + 'in the table are indistinguishable after the fact');
  assert.equal(meta.through_season, THROUGH);
  assert.ok(typeof meta.fitted_at === 'string' && meta.fitted_at.length > 0);
});

/* ------------------------------------------------------------------ 2. recency */

test('recency says which of the two constant sets the caller was handed', () => {
  const seasonLong = projectionFitMeta({ through: THROUGH, throughWeek: null });
  assert.equal(seasonLong.recency, 'season_long');

  const weeklyRole = projectionFitMeta({ through: THROUGH, throughWeek: null,
    roleRecency: WEEKLY_ROLE_RECENCY });
  assert.ok(isWeeklyRoleRecency({ ...WEEKLY_ROLE_RECENCY }), 'the fixture must be the real recency');
  assert.equal(weeklyRole.recency, 'weekly_role');

  assert.notEqual(seasonLong.recency, weeklyRole.recency,
    'if both call shapes report the same recency the field cannot be read off the resolved '
    + 'vector, and it is describing the code rather than the call');
});

/* ------------------------------------------------------------------ 3. volume_k */

test('volume_k reports that a season-long caller keeps the hand-set volume constants', () => {
  // This is the assertion the whole basis field exists for. The fit above CONTAINS volume
  // metrics; a season-long caller does not receive them, so the honest report is hand_set
  // even though a fit is active and its id is right there in the same object.
  const seasonLong = projectionFitMeta({ through: THROUGH, throughWeek: null });
  assert.equal(seasonLong.volume_k, 'hand_set',
    'an active fit whose volume entries are withheld from this caller must not report fitted');
  assert.ok(seasonLong.fit_id, 'and it reports hand_set WHILE naming a live fit, which is the point');

  const weeklyRole = projectionFitMeta({ through: THROUGH, throughWeek: null,
    roleRecency: WEEKLY_ROLE_RECENCY });
  assert.equal(weeklyRole.volume_k, 'fitted',
    'the caller that does receive the fitted volume entries must report fitted');

  const volumeNames = new Set(VOLUME_METRICS.map(([m]) => m));
  assert.ok(weeklyRole.fitted_metrics.some(m => volumeNames.has(m)),
    'the named metrics have to include the volume ones for fitted to be true');
  assert.ok(!seasonLong.fitted_metrics.some(m => volumeNames.has(m)),
    'and must not include them for the caller they are withheld from');
});

/* ------------------------------------------------------------------ 4. the trade basis */

test('a trade comparison serves the projection basis it ran on', () => {
  // tradeImpact builds ONE projection set for both runs -- correct, because rebuilding would
  // put Monte Carlo noise where the trade's effect should be -- and that is exactly why each
  // inner simulateSeason reports a null fit meta: it was handed projections it did not build.
  // So nothing in the returned object said what the comparison rested on, although
  // simProjectionBasis had already computed the sentence and tradeImpact then discarded it.
  const basis = simProjectionBasis(3, 2026, 2);
  assert.ok(basis.basis.length, 'the producer of the sentence is unchanged');

  const me = { roster_id: '1', owner: 'Mine', title_delta: 0.01 };
  const them = { roster_id: '2', owner: 'Theirs', title_delta: -0.01 };
  // The opts, not a ready-made fit object: the payload derives the fit from the SAME
  // arguments the projections were built from, so it cannot describe a different build.
  const payload = tradeImpactPayload({ runs: 600, fromWeek: 3, seed: 7,
    basis: basis.basis, projOpts: { through: THROUGH, throughWeek: null }, me, them });

  assert.equal(payload.projection_basis, basis.basis,
    'a trade verdict served with no statement of what it rests on is the thing the basis '
    + 'work exists to prevent');
  assert.equal(payload.projection_fit.fit_id, FIT_ID,
    'and the fit it names must be the one the shared build used');
  assert.equal(payload.projection_fit.volume_k, 'hand_set',
    'the same withheld-volume truth as every other caller on season-long recency');

  // The rest of the payload is unchanged: this added two fields, it did not rename any.
  assert.deepEqual(TRADE_IMPACT_FIELDS, ['runs', 'from_week', 'seed', 'paired_simulation',
    'projection_basis', 'projection_fit', 'me', 'them']);
  assert.equal(payload.runs, 600);
  assert.equal(payload.from_week, 3);
  assert.equal(payload.seed, 7);
  assert.equal(payload.paired_simulation, true);
  assert.equal(payload.me, me);
  assert.equal(payload.them, them);

  // A caller that supplied its own projections gets null, which is a statement about the
  // call and not a missing value -- the same contract simulateSeason already keeps.
  const supplied = tradeImpactPayload({ runs: 1, fromWeek: 1, seed: 1, basis: basis.basis, me, them });
  assert.equal('projOpts' in supplied, false, 'the opts are an input, never served');
  assert.equal(supplied.projection_fit, null);
  assert.equal('projection_fit' in supplied, true, 'null, not absent: an absent field is invisible');
});
