/**
 * Where a team actually stands, and how much of that is worth believing yet.
 *
 * O4 in `docs/FANTASY-ENGINE-MASTER-PLAN.md`. The rule this is fitted against is
 * `docs/tdd/team-outlook.tdd.md`, which was committed BEFORE any of it was fitted --
 * a threshold chosen after seeing which threshold looked good is not a threshold.
 * Read that document before changing anything here; it fixes the features, the
 * baselines, the four gate conditions and what happens when the gate fails.
 *
 * WHAT THIS IS NOT. It is not an opinion about a team, and it does not say "Act".
 * The plan defines Act as two conditions -- odds below a fitted threshold AND a best
 * available move that raises title odds by at least a fitted amount -- and only the
 * first is computable from league history. So the verdict tops out at `act_candidate`
 * and a caller holding the Trade Brain's best move promotes it. Telling someone to act
 * without having shown that acting helps them is the thing the plan's own rule forbids.
 *
 * PROJECTED LINEUP STRENGTH IS DELIBERATELY ABSENT. The plan assumed Sleeper rosters
 * could be priced with our own projections via `players.sleeper_id`; measured, that
 * column is populated for 751 of 8,556 players, and a roster priced off an 8.8%
 * crosswalk would score a team badly for having unmapped stars -- an error correlated
 * with player profile rather than noise. Everything gated here is computed without it.
 */
import { shrinkToLeague } from './history-corpus.js';

/**
 * The features, in order. Every one of them is known at the end of week w.
 *
 * `win_pct` is not a duplicate of `all_play_pct` (they correlate 0.66 at week 3): seeding
 * is decided by the actual record, so a lucky team really is closer to the playoffs than
 * its scoring deserves, and a model that sees only all-play would miss that.
 *
 * `games_back` is what `win_pct` cannot say: 2-1 is comfortable where six of twelve
 * qualify and outside the line where four of eight do.
 */
export const OUTLOOK_FEATURES = Object.freeze([
  'all_play_pct', 'points_shrunk', 'win_pct', 'games_back', 'weeks_left', 'playoff_share'
]);

/** The direction each feature must come out with, checked after fitting (gate G4). */
export const EXPECTED_SIGNS = Object.freeze({
  all_play_pct: 1, points_shrunk: 1, win_pct: 1, games_back: -1
});

/** The gate, exactly as pre-registered. Changing a number here changes the rule. */
export const OUTLOOK_GATE = Object.freeze({
  weeks: Object.freeze([2, 3, 4, 5, 6, 7, 8]),
  calibrationMax: 0.03,
  bins: 10,
  bootstrapIterations: 2000,
  bootstrapSeed: 20260919,
  l2: 1.0,
  baselines: Object.freeze(['base_rate', 'all_play_pct', 'points_shrunk', 'win_pct'])
});

/** Verdict bands. Thresholds are FITTED, not set here; these are only the names. */
export const VERDICTS = Object.freeze(['fine', 'watch', 'act_candidate']);

const clamp01 = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const sigmoid = z => 1 / (1 + Math.exp(-z));

/**
 * One row's feature vector. `k` comes from the variance decomposition, so the shrinkage
 * this applies is the measured posterior weight and not a chosen one.
 */
export function featureRow(row, k) {
  const share = row.num_teams ? row.playoff_teams / row.num_teams : 0.5;
  return {
    all_play_pct: row.all_play_pct ?? 0.5,
    points_shrunk: shrinkToLeague(row.mean_points_z ?? 0, row.games ?? 0, k),
    win_pct: row.win_pct ?? 0.5,
    games_back: row.games_back ?? 0,
    weeks_left: row.weeks_left ?? 0,
    playoff_share: share
  };
}

/** The state a team is in before a ball is kicked: every performance signal neutral. */
export function neutralFeatures(row, k) {
  return { ...featureRow(row, k), all_play_pct: 0.5, points_shrunk: 0, win_pct: 0.5 };
}

const vectorise = f => OUTLOOK_FEATURES.map(name => f[name]);

/**
 * L2-regularised logistic regression by iteratively reweighted least squares.
 *
 * IRLS rather than gradient descent because with six features the normal equations are a
 * 7x7 solve, it converges in a handful of iterations, and it is deterministic -- no step
 * size to tune and no run-to-run variation, which matters when the result is gated.
 *
 * The intercept is NOT penalised. Penalising it shrinks the fitted base rate toward 0.5,
 * which would quietly bias every prediction in a league whose playoff share is not a half.
 */
export function fitLogistic(X, y, { l2 = 1.0, iterations = 50, tolerance = 1e-9 } = {}) {
  const n = X.length;
  if (!n) return null;
  const d = X[0].length;
  const p = d + 1;                       // + intercept, held at index 0
  let beta = new Array(p).fill(0);
  beta[0] = Math.log(clamp01(y.reduce((s, v) => s + v, 0) / n) / (1 - clamp01(y.reduce((s, v) => s + v, 0) / n)));

  for (let iter = 0; iter < iterations; iter++) {
    // Hessian (penalised) and gradient.
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    const g = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      let z = beta[0];
      for (let j = 0; j < d; j++) z += beta[j + 1] * X[i][j];
      const mu = sigmoid(z);
      const w = Math.max(1e-10, mu * (1 - mu));
      const r = y[i] - mu;
      const xi = [1, ...X[i]];
      for (let a = 0; a < p; a++) {
        g[a] += r * xi[a];
        for (let b = a; b < p; b++) H[a][b] += w * xi[a] * xi[b];
      }
    }
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < a; b++) H[a][b] = H[b][a];
      if (a > 0) { H[a][a] += l2; g[a] -= l2 * beta[a]; }
    }
    const step = solve(H, g);
    if (!step) return null;
    let moved = 0;
    for (let a = 0; a < p; a++) { beta[a] += step[a]; moved = Math.max(moved, Math.abs(step[a])); }
    // A fit that has gone non-finite is not a fit. Returning it lets a NaN travel into every
    // prediction downstream, where it reads as a missing number rather than as a broken one.
    if (!beta.every(Number.isFinite)) return null;
    if (moved < tolerance) break;
  }
  return { intercept: beta[0], coef: beta.slice(1) };
}

/** Gaussian elimination with partial pivoting. Returns null on a singular system. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  // `row[i]` is the diagonal entry of this row after full elimination. Writing `row[i][i]`
  // here indexes into a NUMBER and yields undefined, so every solved value comes back NaN --
  // which is how this was first written, and it produced a fit of NaN coefficients that the
  // sign check below then PASSED, because every comparison against NaN is false. Two defects
  // compounding: a silent arithmetic error and a gate that could not see it.
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Fit one model per week. Per week rather than one model with week interactions, because a
 * per-week fit cannot borrow strength across weeks -- the conservative choice -- and each
 * week's coefficients are then readable on their own.
 *
 * Standardisation uses FIT-SET means and deviations only, carried on the fit so a test row
 * is transformed by the numbers the model was built with and never by its own.
 */
export function fitOutlook({ panel, k, weeks = OUTLOOK_GATE.weeks, l2 = OUTLOOK_GATE.l2 }) {
  if (!panel?.length || !(k > 0)) return null;
  // A live league's rows carry `outcome_known: false`, because whether those teams make
  // the playoffs has not happened yet. `y` below reads `made_playoffs`, and a null there
  // becomes a 0 in the logistic fit, so a panel of live rows would fit a model of "nobody
  // qualifies" and return coefficients with the wrong signs and no error anywhere. Live
  // rows are for SCORING against a fit, never for building one, and that distinction is
  // invisible in the row shape, so it is enforced here rather than trusted.
  const unfinished = panel.find(r => r.outcome_known === false);
  if (unfinished) {
    throw new Error('outlook fit refused: panel contains rows whose season has not finished '
      + `(league ${unfinished.league_id}, week ${unfinished.week}). Live rows are scored, not fitted.`);
  }
  const byWeek = {};
  for (const week of weeks) {
    const rows = panel.filter(r => r.week === week);
    if (rows.length < OUTLOOK_FEATURES.length * 10) continue;
    const raw = rows.map(r => vectorise(featureRow(r, k)));
    const y = rows.map(r => r.made_playoffs);
    const mu = OUTLOOK_FEATURES.map((_, j) => raw.reduce((s, v) => s + v[j], 0) / raw.length);
    const sd = OUTLOOK_FEATURES.map((_, j) => {
      const m = mu[j];
      const v = raw.reduce((s, r) => s + (r[j] - m) ** 2, 0) / raw.length;
      // A feature with no spread in the fit set carries no information; dividing by its
      // zero deviation would produce NaN coefficients rather than a zero contribution.
      return Math.sqrt(v) || 1;
    });
    const X = raw.map(v => v.map((x, j) => (x - mu[j]) / sd[j]));
    const fit = fitLogistic(X, y, { l2 });
    if (!fit) continue;
    byWeek[week] = { ...fit, mu, sd, n: rows.length, week };
  }
  return { k, weeks: Object.keys(byWeek).map(Number), byWeek };
}

/** Probability from a fitted week model and a feature object. */
export function predictFrom(weekFit, features) {
  if (!weekFit) return null;
  const v = vectorise(features);
  let z = weekFit.intercept;
  for (let j = 0; j < v.length; j++) z += weekFit.coef[j] * ((v[j] - weekFit.mu[j]) / weekFit.sd[j]);
  return clamp01(sigmoid(z));
}

/** Probability for a panel row. */
export function predictOutlook(fit, row) {
  const weekFit = fit?.byWeek?.[row.week];
  return weekFit ? predictFrom(weekFit, featureRow(row, fit.k)) : null;
}

/** Coefficients in the original feature units, which is what a sign check must read. */
export function coefficientsInFeatureUnits(weekFit) {
  const out = {};
  OUTLOOK_FEATURES.forEach((name, j) => { out[name] = weekFit.coef[j] / weekFit.sd[j]; });
  return out;
}

/**
 * Gate G4: a coefficient whose sign disagrees with the direction of the world is a defect
 * in the fit, not a discovery.
 */
export function signCheck(weekFit) {
  const coef = coefficientsInFeatureUnits(weekFit);
  const wrong = [];
  // Non-finite FIRST, and for every feature rather than only the four with an expected sign.
  // A NaN coefficient passes both comparisons below, because every comparison against NaN is
  // false -- so a check written only in terms of `< 0` and `> 0` reports a fit of pure NaN as
  // sound. That happened here, and it is why this branch exists.
  for (const name of OUTLOOK_FEATURES) {
    if (!Number.isFinite(coef[name])) wrong.push({ feature: name, expected: 'finite', got: String(coef[name]) });
  }
  for (const [name, want] of Object.entries(EXPECTED_SIGNS)) {
    const got = coef[name];
    if (!Number.isFinite(got)) continue;
    if (want > 0 && got < 0) wrong.push({ feature: name, expected: 'positive', got: +got.toFixed(4) });
    if (want < 0 && got > 0) wrong.push({ feature: name, expected: 'negative', got: +got.toFixed(4) });
  }
  return { pass: wrong.length === 0, wrong, coefficients: coef };
}

/**
 * The change since we knew nothing about this team, split three ways.
 *
 * `no_results_yet` IS NOT A PRESEASON FORECAST. It is this same fitted model with every
 * result-derived feature at its neutral value: what the model says about a team in this
 * league, at this week, whose results we have not seen. It carries no projection of the
 * roster and no preseason ranking. A per-player preseason model does exist
 * (`preseason-model.js`), which makes the name collision worse rather than better, but it
 * cannot be summed into a team's strength: skill positions only, and `players.sleeper_id`
 * covers 751 of 8,556 players. See the module header and tdd 7.6. It was called
 * `preseason` until the UI thread read that name and wrote "the rest is the preseason
 * picture", which a reader takes as our projection. A field name is read by consumers who
 * will not read this header, so the name carries the claim on its own.
 *
 * `luck` and `noise` are each defined exactly as the plan defines them -- luck is the
 * record against the all-play record, noise is the scoring the posterior does not yet
 * believe -- and `real` is the remainder, so the three sum to the total identically. A
 * decomposition whose parts do not sum to the whole is three unrelated numbers.
 *
 * `real` IS THE REMAINDER, NOT ROSTER CHANGE. The plan calls this term "injuries, roster,
 * projections". On this population that cannot be what it is: no roster here is priced (see
 * the header). It is the believed performance signal net of luck and noise, and it is
 * reported under that name. Calling it roster change would be inventing a meaning for a
 * residual.
 *
 * This is an ORDERING choice and not a unique attribution: a different order moves the
 * individual parts. `order` is returned so the number is never read without it.
 */
export function decompose(fit, row) {
  const weekFit = fit?.byWeek?.[row.week];
  if (!weekFit) return null;
  const k = fit.k;
  const actual = featureRow(row, k);
  const neutral = neutralFeatures(row, k);

  const pNeutral = predictFrom(weekFit, neutral);
  const pActual = predictFrom(weekFit, actual);

  // Luck: what the schedule gave or took. The record replaced by the all-play record.
  const luckFree = { ...actual, win_pct: actual.all_play_pct };
  const luck = pActual - predictFrom(weekFit, luckFree);

  // Noise: the part of the scoring the posterior discards. The shrunk value against the
  // raw one -- the same features, with the measured weight removed.
  const unshrunk = { ...actual, points_shrunk: row.mean_points_z ?? 0 };
  const noise = predictFrom(weekFit, unshrunk) - pActual;

  const total = pActual - pNeutral;
  const real = total - luck - noise;
  const games = row.games ?? 0;
  return {
    no_results_yet: +pNeutral.toFixed(4),
    now: +pActual.toFixed(4),
    total: +total.toFixed(4),
    luck: +luck.toFixed(4),
    noise: +noise.toFixed(4),
    real: +real.toFixed(4),
    real_is: 'the remainder: believed performance net of luck and noise, not roster change',
    order: 'luck from the record against all-play, then noise from the shrunk scoring against the raw, then the remainder',
    weight_on_results: games ? +(games / (games + k)).toFixed(4) : 0,
    noise_share: games ? +(1 - games / (games + k)).toFixed(4) : 1,
    k
  };
}

/**
 * Verdict thresholds, fitted on the fit seasons.
 *
 * `watch` is the probability below which a team is materially worse off than the field, and
 * `act_candidate` the point below which it is in trouble. They are set as quantiles of the
 * FITTED probabilities rather than as round numbers, so a league format that makes every
 * probability low does not put its whole field on the same verdict.
 */
export function fitThresholds({ fit, panel, watchQuantile = 0.35, actQuantile = 0.15 }) {
  const probs = [];
  for (const row of panel) {
    const p = predictOutlook(fit, row);
    if (p != null) probs.push(p);
  }
  if (!probs.length) return null;
  probs.sort((a, b) => a - b);
  const at = q => probs[Math.min(probs.length - 1, Math.max(0, Math.floor(q * probs.length)))];
  return {
    watch: +at(watchQuantile).toFixed(4),
    act_candidate: +at(actQuantile).toFixed(4),
    basis: `quantiles of ${probs.length} fitted probabilities on the fit seasons`,
    watch_quantile: watchQuantile, act_quantile: actQuantile
  };
}

/** `act` is never returned. See the header. */
export function verdictFor(prob, thresholds) {
  if (prob == null || !thresholds) return null;
  if (prob <= thresholds.act_candidate) return 'act_candidate';
  if (prob <= thresholds.watch) return 'watch';
  return 'fine';
}

/* ------------------------------------------------- a live league's panel rows */

/*
 * `espnWeeklyRows` USED TO LIVE HERE and now lives in `./espn-weekly-scores.js`.
 *
 * It is re-exported below so existing importers keep working, but new readers should import
 * it from that module directly. It moved because it is not part of this model: it parses the
 * weekly scores ESPN has been storing in `leagues.payload` since the first sync, and four
 * consumers want them -- the outlook panel, the luck read, the season simulator and the
 * feature-audit thresholds. This file exists only on the O4 branch and is absent from main,
 * so anything importing the parser from here would have had to wait for O4 to merge, and
 * would have pulled in a fitted model to read a score it does not use. That is the shape that
 * ends in a second parser and two numbers for one quantity on two pages.
 */
export { espnWeeklyRows } from './espn-weekly-scores.js';
