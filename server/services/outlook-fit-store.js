/**
 * The fitted Team Outlook model, persisted, so a request can score a league
 * without the corpus the model was fitted on.
 *
 * WHY THIS FILE EXISTS. `history-corpus.js` opens
 * `process.cwd()/data/derived/sleeper_history.sqlite` read-only and returns null
 * when it is absent; the Dockerfile's runtime stage copies `client/dist`,
 * `server` and `scripts` and nothing else. So on the deployed app `fitOutlook`,
 * `fitThresholds` and the variance `k` have always resolved to nothing --
 * silently, and only there. A consumer wired straight to those functions renders
 * a verdict on a dev checkout and an empty chip in production, which is worse
 * than the heuristic it replaces, because that at least renders. `scripts/
 * fit-team-outlook.mjs` fits on a machine that has the corpus and writes here;
 * the request path only ever reads.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS A REFUSAL. Every check below guards a
 * failure that produces a plausible number rather than an error:
 *   - The coefficient vectors are POSITIONAL against `OUTLOOK_FEATURES`. Reorder
 *     or extend that list in code and a stored vector prices `win_pct` with
 *     `all_play_pct`'s coefficient. The output is still a probability in (0,1),
 *     still monotone, still chartable, and wrong. So the list is stored with the
 *     fit and a disagreement refuses the whole fit rather than reinterpreting it.
 *   - `k` is the measured posterior weight `featureRow` shrinks points with.
 *     `shrinkToLeague(z, games, undefined)` is NaN, every probability downstream
 *     is NaN, and `verdictFor(NaN, thresholds)` returns 'fine' because every
 *     comparison against NaN is false. A missing k does not show up as an error;
 *     it shows up as a league being told it is fine.
 *   - Thresholds are what turn a probability into a verdict. A fit stored without
 *     them is a fit that reads as present and renders nothing.
 *
 * Reading returns null, not a partial object, and `outlookFitStatus()` says why.
 * That is the shape a surface can be honest with: "no fit stored" is a sentence a
 * page can print, where a fit-shaped object with empty innards is not.
 */
import { rows, run, db } from '../db/index.js';
import { OUTLOOK_FEATURES } from './team-outlook.js';

const FEATURES = JSON.stringify(OUTLOOK_FEATURES);
const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Every reason a stored row cannot be scored with, or null when it can. */
function rejection(meta, weeks) {
  if (meta.features !== FEATURES) {
    return `fit ${meta.id} was fitted on features [${JSON.parse(meta.features).join(', ')}] `
      + `but this build's features are [${OUTLOOK_FEATURES.join(', ')}]; the coefficients are `
      + 'positional, so scoring with them would price the wrong feature';
  }
  if (!finite(meta.k) || meta.k <= 0) {
    return `fit ${meta.id} has k = ${meta.k}, which cannot shrink anything: every probability `
      + "would be NaN and every verdict 'fine'";
  }
  if (!weeks.length) return `fit ${meta.id} has no week models stored`;
  const thresholds = JSON.parse(meta.thresholds);
  if (!finite(thresholds?.watch) || !finite(thresholds?.act_candidate)) {
    return `fit ${meta.id} has no usable verdict thresholds, so no verdict could be produced`;
  }
  const wrongWidth = weeks.find(w => JSON.parse(w.coef).length !== OUTLOOK_FEATURES.length);
  if (wrongWidth) {
    return `fit ${meta.id} week ${wrongWidth.week} stores `
      + `${JSON.parse(wrongWidth.coef).length} coefficients for ${OUTLOOK_FEATURES.length} features`;
  }
  return null;
}

function latest() {
  const meta = rows('SELECT * FROM outlook_fits WHERE active = 1 ORDER BY id DESC LIMIT 1')[0];
  if (!meta) return { meta: null, weeks: [], reason: 'no outlook fit has been stored; '
    + 'scripts/fit-team-outlook.mjs writes one from a machine that has the league-history corpus' };
  const weeks = rows('SELECT week, n, intercept, coef, mu, sd FROM outlook_fit_weeks '
    + 'WHERE fit_id = ? ORDER BY week', meta.id);
  return { meta, weeks, reason: rejection(meta, weeks) };
}

/**
 * The active fit in `fitOutlook`'s own shape -- `{ id, k, weeks, byWeek, thresholds,
 * fitted_at, through_season, provenance }` -- so `predictOutlook`, `decompose` and
 * `signCheck` take it unchanged. Null when there is none or when the stored one
 * cannot be scored with; `outlookFitStatus()` carries the reason.
 */
export function activeOutlookFit() {
  const { meta, weeks, reason } = latest();
  if (!meta || reason) return null;
  const byWeek = {};
  for (const w of weeks) {
    byWeek[w.week] = {
      intercept: w.intercept,
      coef: JSON.parse(w.coef),
      mu: JSON.parse(w.mu),
      sd: JSON.parse(w.sd),
      n: w.n,
      week: w.week
    };
  }
  return {
    id: meta.id, k: meta.k, weeks: weeks.map(w => w.week), byWeek,
    thresholds: JSON.parse(meta.thresholds),
    fitted_at: meta.fitted_at, through_season: meta.through_season, l2: meta.l2,
    provenance: meta.provenance ? JSON.parse(meta.provenance) : null
  };
}

/**
 * What a surface can say about the fit without scoring anything. `present: false`
 * always carries a `reason` in words, because "the outlook model has not been
 * fitted on this deployment" is a sentence worth printing and an empty chip is not.
 */
export function outlookFitStatus() {
  const { meta, weeks, reason } = latest();
  if (!meta) return { present: false, reason };
  if (reason) {
    return { present: false, reason, id: meta.id, fitted_at: meta.fitted_at,
      through_season: meta.through_season };
  }
  return {
    present: true, id: meta.id, fitted_at: meta.fitted_at,
    through_season: meta.through_season, k: meta.k,
    weeks: weeks.map(w => w.week), features: OUTLOOK_FEATURES,
    thresholds: JSON.parse(meta.thresholds),
    provenance: meta.provenance ? JSON.parse(meta.provenance) : null
  };
}

/**
 * Store a fit and make it the active one, in one transaction: a crash mid-write
 * leaves the previous fit active rather than none, and the partial unique index
 * `outlook_fits_one_active` makes two active rows impossible rather than unlikely.
 *
 * Refuses, loudly, a fit that could not be scored with. Throwing here is the point:
 * the caller is a script with a terminal in front of it, and the alternative is a
 * stored fit that fails at request time in production where nobody is looking.
 */
export function saveOutlookFit({ fit, thresholds, through_season = null, l2 = null,
  provenance = null, fitted_at = new Date().toISOString() } = {}) {
  const weeks = Object.entries(fit?.byWeek ?? {});
  if (!weeks.length) throw new Error('outlook fit not stored: it has no week models, so it scores nothing');
  if (!finite(fit?.k) || fit.k <= 0) {
    throw new Error(`outlook fit not stored: k is ${fit?.k}, which cannot shrink anything `
      + "(every probability would be NaN and every verdict 'fine')");
  }
  if (!finite(thresholds?.watch) || !finite(thresholds?.act_candidate)) {
    throw new Error('outlook fit not stored: verdict thresholds are missing, so a stored fit '
      + 'would read as present and produce no verdict');
  }
  for (const [week, wf] of weeks) {
    if (!Array.isArray(wf?.coef) || wf.coef.length !== OUTLOOK_FEATURES.length) {
      throw new Error(`outlook fit not stored: week ${week} has ${wf?.coef?.length ?? 0} `
        + `coefficients for ${OUTLOOK_FEATURES.length} features`);
    }
    if (!finite(wf.intercept) || wf.coef.some(c => !finite(c))
      || wf.mu?.length !== OUTLOOK_FEATURES.length || wf.sd?.length !== OUTLOOK_FEATURES.length) {
      throw new Error(`outlook fit not stored: week ${week} has a non-finite coefficient or a `
        + 'standardisation vector of the wrong width');
    }
  }

  db.exec('BEGIN');
  try {
    run('UPDATE outlook_fits SET active = 0 WHERE active = 1');
    const id = Number(run(`INSERT INTO outlook_fits
      (fitted_at, through_season, k, l2, features, thresholds, provenance, active)
      VALUES (?,?,?,?,?,?,?,1)`, fitted_at, through_season, fit.k, l2, FEATURES,
      JSON.stringify(thresholds), provenance ? JSON.stringify(provenance) : null).lastInsertRowid);
    for (const [week, wf] of weeks) {
      run(`INSERT INTO outlook_fit_weeks (fit_id, week, n, intercept, coef, mu, sd)
           VALUES (?,?,?,?,?,?,?)`, id, Number(week), wf.n ?? null, wf.intercept,
        JSON.stringify(wf.coef), JSON.stringify(wf.mu), JSON.stringify(wf.sd));
    }
    db.exec('COMMIT');
    return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Every stored fit, newest first, for a status page or a human reading history. */
export function outlookFitHistory(limit = 20) {
  return rows('SELECT id, fitted_at, through_season, k, l2, active FROM outlook_fits '
    + 'ORDER BY id DESC LIMIT ?', limit);
}
