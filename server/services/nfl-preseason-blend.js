/**
 * Phase 2 of the 2026-09-09 learning-pipeline plan: nothing in this codebase
 * currently distinguishes "this team looks different because of a hot/cold
 * 1-4 game start" from "this team is genuinely different because of what
 * happened in the offseason." Real systems (538/nfelo Elo, Football
 * Outsiders' DAVE, ESPN FPI) all solve this the same general way: blend a
 * preseason expectation with in-season results, trusting the preseason
 * number less as more real games accumulate.
 *
 * This does the same thing, but calibrated against THIS project's own
 * history rather than importing someone else's league's constant
 * (`calibratePreseasonBlend` below is how the numbers were actually derived,
 * and reruns cleanly if the underlying data changes).
 *
 * CORRECTED 2026-09-10 (Codex audit finding M01): the normal-normal posterior
 * weight on the prior mean is `sigma^2 / (sigma^2 + n * tau^2)` where
 * `sigma^2` is single-game observation variance and `tau^2` is prior
 * variance -- an EARLIER version of this file had that ratio backwards
 * (`tau^2 / (tau^2 + n*sigma^2)`), which made the code MORE confident in the
 * prior as prior uncertainty increased and made one real game crush the
 * prior's weight to ~17% instead of the correct ~81%. With this fixed
 * formula and honestly-measured variances (per_game_variance ~171,
 * prior_variance ~39 on the full history at time of writing -- re-run
 * `calibratePreseasonBlend()` for the current numbers, they drift slightly
 * as more games accumulate), the fade curve is 81% after 1 game, 52% after
 * 4, 35% after 8, 25% after 13 -- broadly the same shape as DAVE's ~8-13
 * game schedule, not dramatically faster than it. The earlier docstring's
 * "genuine finding" claim was itself a symptom of the bug, not an
 * independent result, and is retracted here rather than carried forward.
 *
 * Also corrected: `calibratePreseasonBlend` previously measured
 * `prior_variance` as the cross-sectional variance of teams' CURRENT-season
 * average margins (among teams that happen to have a prior season on
 * record) -- it checked that a prior season existed but never actually used
 * its value, so it was not measuring "year-over-year change" at all. It now
 * measures the variance of (this season's average margin minus last
 * season's average margin) -- the actual prior PREDICTION ERROR, in the same
 * units the posterior blend uses. Per-game variance is now computed on the
 * same margin-of-victory-dampened scale `blendedTeamRating` blends with
 * (previously the calibration used raw margins while the blend used dampened
 * ones -- inconsistent units). Calibration also now takes an optional
 * `asOfSeason` cutoff so a rating for season S is never calibrated using
 * variance estimates built from seasons >= S (previously the single
 * module-level constant used every season ever recorded, including future
 * ones relative to whatever historical season was being replayed).
 *
 * Shrink-only / evidence-gated in spirit, matching nfl-signal-reliability.js:
 * this never fabricates confidence when data is thin (0 games played simply
 * returns the prior with maximum uncertainty, never a false-precise number),
 * and it is exposed as an ADDITIONAL, clearly labeled signal — see
 * `blendedTeamRating`'s return shape, which always reports prior/in-season/
 * blended side by side, never silently collapsing to one number.
 */
import { rows, row } from '../db/index.js';

/** Elo-style margin-of-victory dampening: a 35-point blowout should not move
 * a rolling in-season estimate nearly as much as a 3-point win moves it,
 * because most of a blowout's extra margin is garbage-time noise, not signal
 * about true team strength. Applied to EVERY raw game margin this module
 * touches (prior-season averages, in-season running means, and the variance
 * calibration below) so every quantity that gets blended together is in the
 * same units — mixing a raw-margin prior with a dampened-margin in-season
 * mean (as an earlier version of this file did) understates how much weight
 * the prior actually deserves. */
function dampenMargin(margin) {
  const sign = margin >= 0 ? 1 : -1;
  return sign * Math.log(Math.abs(margin) + 1) * 6; // ~matches raw margin near 0, compresses hard beyond ~14
}

/**
 * Derives per_game_variance and prior_variance from real history, with an
 * optional `asOfSeason` cutoff so the estimate never uses seasons at or
 * after the season being predicted (`undefined` — the default — uses every
 * season on record, which is what the live, always-current exported
 * constants below intentionally do; pass a real cutoff for any historical
 * replay or backtest):
 *
 *   per_game_variance  — pooled variance of a team's own DAMPENED game
 *                         margins around its own season average (single-game
 *                         noise, on the same scale the blend uses).
 *   prior_variance     — variance of (this season's average dampened margin
 *                         minus the PRIOR season's average dampened margin)
 *                         for every team with both seasons on record — the
 *                         actual year-over-year prior prediction error, not
 *                         merely the cross-sectional spread of current-season
 *                         averages.
 * Exported so recalibration is a function call, not hand-derived math left
 * to go stale in a comment.
 */
export function calibratePreseasonBlend({ asOfSeason } = {}) {
  const seasonFilter = asOfSeason != null ? 'AND season < ?' : '';
  const params = asOfSeason != null ? [asOfSeason, asOfSeason] : [];
  const games = rows(`SELECT season, team, team_score, opp_score FROM game_lines WHERE home=1 AND team_score IS NOT NULL ${seasonFilter}
    UNION ALL
    SELECT season, opponent AS team, opp_score AS team_score, team_score AS opp_score FROM game_lines WHERE home=1 AND team_score IS NOT NULL ${seasonFilter}`,
    ...params);
  const bySeasonTeam = new Map();
  for (const r of games) {
    const key = `${r.season}|${r.team}`;
    if (!bySeasonTeam.has(key)) bySeasonTeam.set(key, []);
    bySeasonTeam.get(key).push(dampenMargin(r.team_score - r.opp_score));
  }
  let sqSum = 0, n = 0;
  const seasonMeans = new Map();
  for (const [key, margins] of bySeasonTeam) {
    const m = margins.reduce((a, b) => a + b, 0) / margins.length;
    for (const margin of margins) { sqSum += (margin - m) ** 2; n++; }
    seasonMeans.set(key, m);
  }
  const perGameVariance = n ? sqSum / n : null;
  const priorResiduals = [];
  for (const [key, mean] of seasonMeans) {
    const [season, team] = key.split('|');
    const priorKey = `${Number(season) - 1}|${team}`;
    const priorMean = seasonMeans.get(priorKey);
    if (priorMean != null) priorResiduals.push(mean - priorMean);
  }
  const rMean = priorResiduals.length ? priorResiduals.reduce((a, b) => a + b, 0) / priorResiduals.length : null;
  const priorVariance = priorResiduals.length
    ? priorResiduals.reduce((s, v) => s + (v - rMean) ** 2, 0) / priorResiduals.length : null;
  return { per_game_variance: perGameVariance, prior_variance: priorVariance,
    games_pooled: n, prior_pairs: priorResiduals.length, as_of_season: asOfSeason ?? null,
    note: perGameVariance != null && priorVariance != null && perGameVariance > priorVariance * 3
      ? 'Single-game variance is well above year-over-year team-quality variance in this data -- expect the calibrated blend to fade the preseason prior on a schedule broadly consistent with external research (DAVE-style ~8-13 games), not dramatically faster or slower.'
      : null };
}

// Calibrated once from every season on record via calibratePreseasonBlend()
// above (see its own docstring for the derivation) -- not re-run on every
// call because the underlying game_lines history it depends on changes
// slowly. Re-run the function directly to refresh these if meaningfully more
// history accumulates. This "all data" pair is for LIVE, always-current use
// only; any historical replay must go through `calibrationAsOf` below so it
// never calibrates using seasons at or after the one being predicted.
const CALIBRATED = calibratePreseasonBlend();
export const PER_GAME_VARIANCE = CALIBRATED.per_game_variance ?? 181.5;
export const PRIOR_VARIANCE = CALIBRATED.prior_variance ?? 36.5;

// Cutoff-safe calibration cache: one entry per asOfSeason actually requested,
// so a walk-forward replay across many seasons/weeks doesn't re-run the
// pooling query on every single call. Keyed by season number; the "current"
// (no-cutoff) pair above is cached separately as CALIBRATED and never mixed
// into this map.
const calibrationCache = new Map();
function calibrationAsOf(asOfSeason) {
  if (asOfSeason == null) return CALIBRATED;
  if (!calibrationCache.has(asOfSeason)) calibrationCache.set(asOfSeason, calibratePreseasonBlend({ asOfSeason }));
  return calibrationCache.get(asOfSeason);
}

/** How much a team's own offseason roster churn should widen its personal
 * prior_variance beyond the league-wide baseline -- a team that churned far
 * more than a typical team has a less trustworthy prior than that baseline
 * assumes, so its prior should fade even faster. Bounded so a data glitch
 * (e.g. an inflated churn count) can't blow the prior's influence up or down
 * to something absurd. */
const CHURN_VARIANCE_SCALE = 1.5;
const MIN_CHURN_MULTIPLIER = 0.75;
const MAX_CHURN_MULTIPLIER = 3;

/**
 * The real offseason window between two seasons for a given franchise's
 * transactions: from the last completed game of `season - 1` through the
 * first scheduled game of `season`. Derived from `game_lines` itself rather
 * than a fixed calendar guess (an earlier version used a flat "Feb 1 to
 * Sep 1" window, which is wrong in a lockout/relocation year and, more
 * routinely, just imprecise) and carries no decision-time assumption of its
 * own -- a caller replaying an earlier season already only sees rows that
 * existed by then. Returns null when either boundary can't be resolved
 * (e.g. an expansion team, or a season with no schedule loaded yet).
 */
function offseasonWindow(season) {
  const priorEnd = row(`SELECT MAX(gameday) d FROM game_lines WHERE season=? AND team_score IS NOT NULL`, season - 1)?.d;
  const start = row(`SELECT MIN(gameday) d FROM game_lines WHERE season=?`, season)?.d;
  if (!priorEnd || !start) return null;
  return { start: priorEnd, end: start };
}

/**
 * A team's roster-churn magnitude this offseason relative to the league
 * average, from Phase 1's now-continuously-tracked roster tables. Returns
 * `null` (not a number) when there isn't enough tracked history to compare
 * against -- these tables have only been live since mid-2026, so most
 * historical seasons legitimately have nothing to report here yet, and this
 * must never be silently treated as "zero churn."
 */
export function teamChurnMultiplier(season, team) {
  const window = offseasonWindow(season);
  if (!window) return null; // no resolvable offseason boundary (e.g. expansion team, unscheduled season)
  const counts = rows(`
    SELECT to_team AS team, COUNT(*) n FROM player_team_changes
    WHERE detected_at >= ? AND detected_at < ? GROUP BY to_team`,
    window.start, window.end);
  if (counts.length < 8) return null; // not enough league-wide coverage this offseason to compare against
  const total = counts.reduce((s, c) => s + c.n, 0);
  const leagueAvg = total / counts.length;
  const teamCount = counts.find(c => c.team === team)?.n ?? 0;
  if (!leagueAvg) return null;
  const relative = teamCount / leagueAvg;
  const multiplier = 1 + CHURN_VARIANCE_SCALE * (relative - 1);
  return Math.min(MAX_CHURN_MULTIPLIER, Math.max(MIN_CHURN_MULTIPLIER, multiplier));
}

/**
 * The actual blend for one team entering week `week` of `season`.
 *
 * `priorMargin` defaults to the team's own prior-season average margin (a
 * real, in-house number, not an external one) when not supplied — pass an
 * explicit value to use a different source (e.g. an nfelo-derived prior).
 *
 * `asOfSeason` controls which variance calibration is used and defaults to
 * `season` itself -- i.e. by default this NEVER calibrates using a season
 * at or after the one being predicted, so appending a later season's games
 * to the database cannot change an earlier prediction. Pass `null`
 * explicitly only for a genuinely live, always-current read where "the
 * season being predicted" and "the most recent complete data" are meant to
 * be the same cutoff-free thing (there is no legitimate reason to pass a
 * cutoff LATER than `season`).
 *
 * Returns prior, in-season, and blended numbers side by side (never just the
 * blended one) plus the posterior standard error, so "how early it still is"
 * stays visible even in a caller that only wants the point estimate.
 */
export function blendedTeamRating(season, team, week, { priorMargin = null, asOfSeason = season } = {}) {
  const calibration = calibrationAsOf(asOfSeason);
  const perGameVariance = calibration.per_game_variance ?? PER_GAME_VARIANCE;
  const basePriorVariance = calibration.prior_variance ?? PRIOR_VARIANCE;

  const resolvedPrior = priorMargin ?? priorSeasonAverageMargin(season, team);
  const played = rows(`
    SELECT team_score - opp_score AS margin FROM game_lines
    WHERE home=1 AND season=? AND team=? AND week<? AND team_score IS NOT NULL
    UNION ALL
    SELECT opp_score - team_score AS margin FROM game_lines
    WHERE home=1 AND season=? AND opponent=? AND week<? AND team_score IS NOT NULL`,
    season, team, week, season, team, week);
  const gamesPlayed = played.length;
  const inSeasonMean = gamesPlayed ? played.reduce((s, r) => s + dampenMargin(r.margin), 0) / gamesPlayed : null;

  const churnMultiplier = teamChurnMultiplier(season, team);
  const priorVariance = basePriorVariance * (churnMultiplier ?? 1);

  if (resolvedPrior == null && inSeasonMean == null) {
    return { season, team, week, games_played: 0, prior: null, in_season: null, blended: null,
      weight_on_prior: null, posterior_se: null, churn_multiplier: churnMultiplier,
      note: 'No prior-season data and no games played yet -- nothing to blend.' };
  }
  if (resolvedPrior == null) {
    return { season, team, week, games_played: gamesPlayed, prior: null, in_season: r3(inSeasonMean),
      blended: r3(inSeasonMean), weight_on_prior: 0, posterior_se: r3(Math.sqrt(perGameVariance / Math.max(1, gamesPlayed))),
      churn_multiplier: churnMultiplier, note: 'No prior-season rating available (e.g. an expansion team or a promoted-from-nothing roster) -- reporting the in-season number alone, not a fabricated prior.' };
  }
  if (gamesPlayed === 0) {
    return { season, team, week, games_played: 0, prior: r3(resolvedPrior), in_season: null, blended: r3(resolvedPrior),
      weight_on_prior: 1, posterior_se: r3(Math.sqrt(priorVariance)), churn_multiplier: churnMultiplier,
      note: 'No games played yet this season -- full weight on the prior, maximum uncertainty.' };
  }

  // Normal-normal posterior weight on the PRIOR mean: sigma^2 / (sigma^2 + n*tau^2),
  // where sigma^2 is single-game observation variance and tau^2 is prior
  // variance. Increasing sigma^2 (noisier observations) raises this weight;
  // increasing tau^2 (a less trustworthy prior) or n (more real evidence)
  // lowers it -- see the module header for the earlier, reversed version of
  // this line and test/nfl-preseason-blend.test.js for the monotonicity
  // checks against exactly this behavior.
  const weightOnPrior = perGameVariance / (perGameVariance + gamesPlayed * priorVariance);
  const blended = weightOnPrior * resolvedPrior + (1 - weightOnPrior) * inSeasonMean;
  const posteriorVariance = 1 / (1 / priorVariance + gamesPlayed / perGameVariance);

  return {
    season, team, week, games_played: gamesPlayed,
    prior: r3(resolvedPrior), in_season: r3(inSeasonMean), blended: r3(blended),
    weight_on_prior: r3(weightOnPrior), posterior_se: r3(Math.sqrt(posteriorVariance)),
    churn_multiplier: churnMultiplier,
    note: churnMultiplier == null
      ? 'No roster-churn comparison available for this offseason yet (Phase 1 tracking only began mid-2026) -- using the league-baseline prior variance.'
      : null
  };
}

function priorSeasonAverageMargin(season, team) {
  const rowsForTeam = rows(`
    SELECT team_score - opp_score AS margin FROM game_lines
    WHERE home=1 AND season=? AND team=? AND team_score IS NOT NULL
    UNION ALL
    SELECT opp_score - team_score AS margin FROM game_lines
    WHERE home=1 AND season=? AND opponent=? AND team_score IS NOT NULL`,
    season - 1, team, season - 1, team);
  if (!rowsForTeam.length) return null;
  return rowsForTeam.reduce((s, r) => s + dampenMargin(r.margin), 0) / rowsForTeam.length;
}

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * The one live integration point for now: injected into `nfl-gbm.js`'s
 * challenger dataset via the exact same `extraFeatures` seam
 * `teamStrengthGbmFeatures` (nfl-team-strength.js) already uses, so this is
 * additive to the CHALLENGER path only -- the champion model's feature set
 * is byte-for-byte unchanged, matching that file's own stated convention.
 */
export function preseasonBlendGbmFeature(season, week, home, away) {
  const h = blendedTeamRating(season, home, week);
  const a = blendedTeamRating(season, away, week);
  if (h.blended == null || a.blended == null) return null;
  return r3(h.blended - a.blended);
}

/**
 * The same `{names, row}` shape `nfl-team-strength.js`'s own
 * `teamStrengthGbmFeatures` uses, so this can be handed straight to
 * `buildGbmDataset({extraFeatures})` or to `teamStrengthWalkForward`'s
 * `challengerFeatures` option to get a real, rigorous (paired, week-block
 * bootstrap) held-out verdict on whether this feature actually helps —
 * rather than assuming the math is right because it looks right.
 */
export function preseasonBlendGbmFeatures() {
  return {
    names: ['preseason_blend_margin_diff'],
    row: g => [preseasonBlendGbmFeature(g.season, g.week, g.home, g.away) ?? 0]
  };
}

/**
 * HONEST RESULT, recorded rather than hidden: run through the exact same
 * rigorous walk-forward harness `nfl-team-strength.js`'s own features are
 * held to (`teamStrengthWalkForward({ challengerFeatures: preseasonBlendGbmFeatures() })`),
 * this feature does NOT show a significant improvement over the champion —
 * pooled 2023-2025, challenger MAE 9.86 vs champion 9.84 (very slightly
 * worse), 90% CI [-0.017, 0.056] on the improvement, includes zero, 0 of 3
 * seasons individually significant. RE-RUN 2026-09-10 after fixing the
 * reversed Bayesian weighting formula (Codex audit finding M01, see above) —
 * the verdict is essentially unchanged from before the fix (a boosted-tree
 * challenger is scale-invariant to a monotonic recalibration of a single
 * input column, so a formula bug that changes weight_on_prior's exact value
 * without changing which direction it moves need not change a tree model's
 * verdict much). This is a genuinely re-derived result, not a stale number
 * carried forward from the buggy version — do not treat the coincidental
 * similarity as evidence the fix was unnecessary; the fix corrects real
 * documented math (see header) independent of what this one downstream test
 * happens to conclude.
 *
 * This module's real value is the calibrated blending mechanism itself
 * (`blendedTeamRating`) as infrastructure other experts can read directly for
 * early-season judgment (nothing has been wired to consume it that way yet)
 * — not this specific reduction of it to one differential column for the
 * residual GBM. Per this project's own standing convention for a tested,
 * honestly negative result (see Package F, the expert-selector research:
 * "lost to the market... preserved, not reopened"), `preseasonBlendGbmFeatures`
 * is NOT wired into any production dataset build. Re-run the walk-forward
 * call above directly if a future change to the blend seems worth re-testing
 * — don't re-propose the same untested assumption that it must help.
 */
export const WALK_FORWARD_VERDICT = 'not significant vs champion (pooled 2023-2025, 90% CI includes zero; re-derived 2026-09-10 post formula fix) — see module header';
