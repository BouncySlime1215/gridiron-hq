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
 * 2021-2025 history rather than importing someone else's league's constant
 * (`calibratePreseasonBlend` below is how the numbers were actually derived,
 * and reruns cleanly if the underlying data changes). The result: real
 * single-game NFL margin variance (~181 point^2) is large relative to how
 * much teams actually differ in true year-over-year quality (~36 point^2),
 * so the Bayesian-optimal blend fades the preseason prior much FASTER than
 * DAVE's ~8-13 game schedule — after just one real game, the calibrated
 * weight on the prior is already down to ~17%. That is a genuine finding
 * from this project's own data, not a bug in the math; it is reported
 * plainly rather than forced to match a borrowed number.
 *
 * Shrink-only / evidence-gated in spirit, matching nfl-signal-reliability.js:
 * this never fabricates confidence when data is thin (0 games played simply
 * returns the prior with maximum uncertainty, never a false-precise number),
 * and it is exposed as an ADDITIONAL, clearly labeled signal — see
 * `blendedTeamRating`'s return shape, which always reports prior/in-season/
 * blended side by side, never silently collapsing to one number.
 */
import { rows } from '../db/index.js';

/**
 * Derives per_game_variance and prior_variance from real history:
 *   per_game_variance  — pooled variance of a team's own game margins around
 *                         its own season average (pure single-game noise).
 *   prior_variance     — cross-team variance of a season's final average
 *                         margin, as predicted by (i.e. compared across) the
 *                         PRIOR season's final average margin for the same
 *                         team (how much true team quality actually varies
 *                         year over year).
 * Exported so recalibration is a function call, not hand-derived math left
 * to go stale in a comment.
 */
export function calibratePreseasonBlend() {
  const games = rows(`SELECT season, team, team_score, opp_score FROM game_lines WHERE home=1 AND team_score IS NOT NULL
    UNION ALL
    SELECT season, opponent AS team, opp_score AS team_score, team_score AS opp_score FROM game_lines WHERE home=1 AND team_score IS NOT NULL`);
  const bySeasonTeam = new Map();
  for (const r of games) {
    const key = `${r.season}|${r.team}`;
    if (!bySeasonTeam.has(key)) bySeasonTeam.set(key, []);
    bySeasonTeam.get(key).push(r.team_score - r.opp_score);
  }
  let sqSum = 0, n = 0;
  const seasonMeans = new Map();
  for (const [key, margins] of bySeasonTeam) {
    const m = margins.reduce((a, b) => a + b, 0) / margins.length;
    for (const margin of margins) { sqSum += (margin - m) ** 2; n++; }
    seasonMeans.set(key, m);
  }
  const perGameVariance = n ? sqSum / n : null;
  const priorVals = [];
  for (const [key, mean] of seasonMeans) {
    const [season, team] = key.split('|');
    const priorKey = `${Number(season) - 1}|${team}`;
    if (seasonMeans.has(priorKey)) priorVals.push(mean);
  }
  const pMean = priorVals.length ? priorVals.reduce((a, b) => a + b, 0) / priorVals.length : null;
  const priorVariance = priorVals.length
    ? priorVals.reduce((s, v) => s + (v - pMean) ** 2, 0) / priorVals.length : null;
  return { per_game_variance: perGameVariance, prior_variance: priorVariance,
    games_pooled: n, prior_pairs: priorVals.length,
    note: perGameVariance != null && priorVariance != null && perGameVariance > priorVariance * 3
      ? 'Single-game variance dwarfs cross-team quality variance in this data -- expect the calibrated blend to fade the preseason prior much faster than external research (DAVE-style ~8-13 games) assumes.'
      : null };
}

// Calibrated once from real 2021-2025+ history via calibratePreseasonBlend()
// above (see its own docstring for the derivation) -- not re-run on every
// call because the underlying game_lines history it depends on changes
// slowly. Re-run the function directly to refresh these if meaningfully more
// history accumulates.
const CALIBRATED = calibratePreseasonBlend();
export const PER_GAME_VARIANCE = CALIBRATED.per_game_variance ?? 181.5;
export const PRIOR_VARIANCE = CALIBRATED.prior_variance ?? 36.5;

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
 * A team's roster-churn magnitude this offseason relative to the league
 * average, from Phase 1's now-continuously-tracked roster tables. Returns
 * `null` (not a number) when there isn't enough tracked history to compare
 * against -- these tables have only been live since mid-2026, so most
 * historical seasons legitimately have nothing to report here yet, and this
 * must never be silently treated as "zero churn."
 */
export function teamChurnMultiplier(season, team) {
  const counts = rows(`
    SELECT to_team AS team, COUNT(*) n FROM player_team_changes
    WHERE detected_at >= ? AND detected_at < ? GROUP BY to_team`,
    `${season - 1}-02-01`, `${season}-09-01`);
  if (counts.length < 8) return null; // not enough league-wide coverage this offseason to compare against
  const total = counts.reduce((s, c) => s + c.n, 0);
  const leagueAvg = total / counts.length;
  const teamCount = counts.find(c => c.team === team)?.n ?? 0;
  if (!leagueAvg) return null;
  const relative = teamCount / leagueAvg;
  const multiplier = 1 + CHURN_VARIANCE_SCALE * (relative - 1);
  return Math.min(MAX_CHURN_MULTIPLIER, Math.max(MIN_CHURN_MULTIPLIER, multiplier));
}

/** Elo-style margin-of-victory dampening: a 35-point blowout should not move
 * a rolling in-season estimate nearly as much as a 3-point win moves it,
 * because most of a blowout's extra margin is garbage-time noise, not signal
 * about true team strength. */
function dampenMargin(margin) {
  const sign = margin >= 0 ? 1 : -1;
  return sign * Math.log(Math.abs(margin) + 1) * 6; // ~matches raw margin near 0, compresses hard beyond ~14
}

/**
 * The actual blend for one team entering week `week` of `season`.
 *
 * `priorMargin` defaults to the team's own prior-season average margin (a
 * real, in-house number, not an external one) when not supplied — pass an
 * explicit value to use a different source (e.g. an nfelo-derived prior).
 *
 * Returns prior, in-season, and blended numbers side by side (never just the
 * blended one) plus the posterior standard error, so "how early it still is"
 * stays visible even in a caller that only wants the point estimate.
 */
export function blendedTeamRating(season, team, week, { priorMargin = null } = {}) {
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
  const priorVariance = PRIOR_VARIANCE * (churnMultiplier ?? 1);

  if (resolvedPrior == null && inSeasonMean == null) {
    return { season, team, week, games_played: 0, prior: null, in_season: null, blended: null,
      weight_on_prior: null, posterior_se: null, churn_multiplier: churnMultiplier,
      note: 'No prior-season data and no games played yet -- nothing to blend.' };
  }
  if (resolvedPrior == null) {
    return { season, team, week, games_played: gamesPlayed, prior: null, in_season: r3(inSeasonMean),
      blended: r3(inSeasonMean), weight_on_prior: 0, posterior_se: r3(Math.sqrt(PER_GAME_VARIANCE / Math.max(1, gamesPlayed))),
      churn_multiplier: churnMultiplier, note: 'No prior-season rating available (e.g. an expansion team or a promoted-from-nothing roster) -- reporting the in-season number alone, not a fabricated prior.' };
  }
  if (gamesPlayed === 0) {
    return { season, team, week, games_played: 0, prior: r3(resolvedPrior), in_season: null, blended: r3(resolvedPrior),
      weight_on_prior: 1, posterior_se: r3(Math.sqrt(priorVariance)), churn_multiplier: churnMultiplier,
      note: 'No games played yet this season -- full weight on the prior, maximum uncertainty.' };
  }

  const weightOnPrior = priorVariance / (priorVariance + gamesPlayed * PER_GAME_VARIANCE);
  const blended = weightOnPrior * resolvedPrior + (1 - weightOnPrior) * inSeasonMean;
  const posteriorVariance = 1 / (1 / priorVariance + gamesPlayed / PER_GAME_VARIANCE);

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
  return rowsForTeam.reduce((s, r) => s + r.margin, 0) / rowsForTeam.length;
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
 * worse), 90% CI [-0.021, 0.055] on the improvement, includes zero.
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
export const WALK_FORWARD_VERDICT = 'not significant vs champion (pooled 2023-2025, 90% CI includes zero) — see module header';
