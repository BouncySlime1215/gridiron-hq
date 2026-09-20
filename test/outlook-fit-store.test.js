/**
 * Storing a fitted Team Outlook model, so the app can score a league without the
 * corpus it was fitted on (2026-09-20).
 *
 * WHY THIS EXISTS. `history-corpus.js` opens the crawled corpus from
 * `process.cwd()/data/derived/` and returns null when it is absent, and the
 * Dockerfile's runtime stage copies only `client/dist`, `server` and `scripts`.
 * So `fitOutlook`, `fitThresholds` and the variance k have always resolved to
 * nothing on the deployed app, silently, while working perfectly on a dev
 * checkout. The fit has to be written by a machine that has the corpus and READ
 * at request time; that is what this store is.
 *
 * The rules below are the ones that can fail without anything erroring:
 *
 *   - Coefficients are POSITIONAL. A stored vector read back against a different
 *     `OUTLOOK_FEATURES` order applies `all_play_pct`'s coefficient to
 *     `win_pct`, and the result is still a probability between 0 and 1. So the
 *     feature list travels with the fit and a disagreement refuses the fit.
 *   - `k` is the measured posterior weight `featureRow` shrinks points with.
 *     Lose it and `shrinkToLeague(z, games, undefined)` is NaN, every
 *     probability is NaN, and `verdictFor(NaN, thresholds)` returns **'fine'** —
 *     an entire league told it is fine, with no error anywhere. That is asserted
 *     below, because it is the reason the loader validates k rather than trusting
 *     the column.
 *   - A fit with no thresholds cannot produce a verdict, so storing one would
 *     make a present, healthy-looking fit render nothing.
 *   - "The active fit" has to be a fact, not a convention: two active rows and a
 *     reader has to guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-outlook-fit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { fitOutlook, fitThresholds, predictOutlook, verdictFor, OUTLOOK_FEATURES, OUTLOOK_GATE }
  = await import('../server/services/team-outlook.js');
const { saveOutlookFit, activeOutlookFit, outlookFitStatus }
  = await import('../server/services/outlook-fit-store.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const WEEKS = [3, 4];

/**
 * A panel big enough to fit: `fitOutlook` needs 60 rows a week (six features x 10),
 * and the outcome has to actually depend on the features or the coefficients are
 * noise and the round-trip assertions would pass on nothing.
 */
function panel() {
  let s = 20260920;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [];
  for (const week of WEEKS) {
    for (let i = 0; i < 80; i++) {
      const strength = rand();                       // the latent "this team is good"
      const allPlay = 0.15 + 0.7 * strength + 0.1 * (rand() - 0.5);
      out.push({
        season: 2023, league_id: 100 + (i % 8), roster_id: i, week,
        num_teams: 12, playoff_teams: i % 2 ? 6 : 4,
        all_play_pct: allPlay,
        mean_points_z: (strength - 0.5) * 2,
        games: week,
        win_pct: 0.1 + 0.8 * strength,
        games_back: (1 - strength) * 3,
        weeks_left: 14 - week,
        made_playoffs: strength + 0.15 * (rand() - 0.5) > 0.45 ? 1 : 0,
        champion: 0,
        outcome_known: true
      });
    }
  }
  return out;
}

const K = 4.75;
const PANEL = panel();
const FIT = fitOutlook({ panel: PANEL, k: K, weeks: WEEKS });
const THRESHOLDS = fitThresholds({ fit: FIT, panel: PANEL });
const PROVENANCE = { seasons: [2023], league_seasons: 8, rows: PANEL.length };

test('the fixture is a real fit, not an empty one', () => {
  assert.deepEqual(FIT.weeks, WEEKS);
  assert.equal(FIT.k, K);
  for (const week of WEEKS) assert.equal(FIT.byWeek[week].coef.length, OUTLOOK_FEATURES.length);
  assert.ok(THRESHOLDS.watch > THRESHOLDS.act_candidate, 'the bands must be ordered');
});

test('with nothing stored, the store says so and says why rather than returning a shape', () => {
  assert.equal(activeOutlookFit(), null);
  const status = outlookFitStatus();
  assert.equal(status.present, false);
  assert.match(status.reason, /no .*fit/i, 'a surface has to be able to print the reason');
});

test('a stored fit reproduces the in-memory fit exactly, probability for probability', () => {
  const id = saveOutlookFit({ fit: FIT, thresholds: THRESHOLDS, through_season: 2023,
    l2: OUTLOOK_GATE.l2, provenance: PROVENANCE });
  assert.ok(id > 0);

  const loaded = activeOutlookFit();
  assert.equal(loaded.k, K);
  assert.deepEqual(loaded.weeks, WEEKS);
  assert.deepEqual(loaded.thresholds, THRESHOLDS);
  assert.equal(loaded.through_season, 2023);
  assert.deepEqual(loaded.provenance, PROVENANCE);

  for (const week of WEEKS) {
    const a = FIT.byWeek[week], b = loaded.byWeek[week];
    assert.equal(b.intercept, a.intercept);
    assert.deepEqual(b.coef, a.coef);
    assert.deepEqual(b.mu, a.mu);
    assert.deepEqual(b.sd, a.sd);
    assert.equal(b.n, a.n);
    assert.equal(b.week, week);
  }
  // The assertion that matters: the same input gives the same number, not a close one.
  for (const row of PANEL) {
    assert.equal(predictOutlook(loaded, row), predictOutlook(FIT, row),
      `week ${row.week} roster ${row.roster_id}`);
  }
});

test('the newest stored fit is the active one, and only one row is ever active', () => {
  const second = saveOutlookFit({ fit: FIT, thresholds: THRESHOLDS, through_season: 2024,
    l2: OUTLOOK_GATE.l2, provenance: PROVENANCE });
  assert.equal(rows('SELECT COUNT(*) AS n FROM outlook_fits WHERE active = 1')[0].n, 1);
  assert.equal(activeOutlookFit().id, second);
  assert.equal(activeOutlookFit().through_season, 2024);
  assert.equal(outlookFitStatus().through_season, 2024);
});

test('a fit stored under a different feature list is refused, not reinterpreted', () => {
  // The coefficients are positional. Reorder the list and the same vector prices
  // `win_pct` with `all_play_pct`'s coefficient -- still a probability, still
  // plausible, wrong. This is the one failure mode a caller cannot detect.
  const reordered = [...OUTLOOK_FEATURES].reverse();
  const id = activeOutlookFit().id;
  run('UPDATE outlook_fits SET features = ? WHERE id = ?', JSON.stringify(reordered), id);

  assert.equal(activeOutlookFit(), null, 'refused');
  const status = outlookFitStatus();
  assert.equal(status.present, false);
  assert.match(status.reason, /feature/i);
  run('UPDATE outlook_fits SET features = ? WHERE id = ?', JSON.stringify(OUTLOOK_FEATURES), id);
  assert.ok(activeOutlookFit(), 'and readable again once the list agrees');
});

test('a stored k that cannot shrink anything is refused, because the alternative is a league told it is fine', () => {
  // Why this guard exists, stated as an assertion rather than a comment:
  assert.equal(verdictFor(NaN, THRESHOLDS), 'fine',
    'a NaN probability reads as "fine" -- every comparison against NaN is false');
  const id = activeOutlookFit().id;
  run('UPDATE outlook_fits SET k = 0 WHERE id = ?', id);
  assert.equal(activeOutlookFit(), null);
  assert.match(outlookFitStatus().reason, /\bk\b/);
  run('UPDATE outlook_fits SET k = ? WHERE id = ?', K, id);
  assert.ok(activeOutlookFit());
});

test('saving refuses what cannot be scored with', () => {
  const base = { fit: FIT, thresholds: THRESHOLDS, through_season: 2023, provenance: PROVENANCE };
  assert.throws(() => saveOutlookFit({ ...base, fit: { k: K, weeks: [], byWeek: {} } }), /week/i,
    'a fit with no weeks scores nothing');
  assert.throws(() => saveOutlookFit({ ...base, fit: { ...FIT, k: 0 } }), /\bk\b/);
  assert.throws(() => saveOutlookFit({ ...base, thresholds: null }), /threshold/i,
    'no thresholds means no verdict, so a stored fit would render nothing while looking present');
  assert.throws(() => saveOutlookFit({ ...base,
    thresholds: { watch: 0.4, act_candidate: null } }), /threshold/i);
  // A truncated coefficient vector is a corrupt fit, not a smaller one.
  const short = { ...FIT, byWeek: { ...FIT.byWeek,
    [WEEKS[0]]: { ...FIT.byWeek[WEEKS[0]], coef: FIT.byWeek[WEEKS[0]].coef.slice(0, 3) } } };
  assert.throws(() => saveOutlookFit({ ...base, fit: short }), /coefficient|feature/i);
  // None of that left a row behind.
  assert.equal(rows('SELECT COUNT(*) AS n FROM outlook_fits WHERE active = 1')[0].n, 1);
});
