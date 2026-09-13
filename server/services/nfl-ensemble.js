/**
 * Independent NFL models, aggregated into one projected line.
 *
 * The single ratings model in nfl-market.js is good but it is one opinion with
 * one blind spot. This runs deliberately different ones — some see only
 * wins, some only margins, some only play-level efficiency, some only the
 * market — and combines them by how well each has actually predicted, measured
 * walk-forward.
 *
 * Diversity is the point. Colley ignores margin entirely, so it disagrees with
 * Massey exactly when a team's record and point differential tell different
 * stories. Turnover-regressed margin fades the luckiest results. The market
 * anchor starts from the number the books set. When many models built on
 * different premises agree, that is real signal; when they scatter, the honest
 * output is low confidence, and the spread between them is reported as exactly
 * that.
 *
 * Weighting is exponential in held-out RMSE, so a model that predicts badly is
 * down-weighted automatically instead of being argued about.
 * Model families follow published work — Massey and Colley least-squares
 * ratings, Pythagenport expectation, margin-dependent Elo — implemented here
 * rather than imported.
 */
import { rows, run } from '../db/index.js';
import { availabilityDeficit } from './nfl-availability.js';
import { teamWeeks } from './nfl-pbp.js';
import { weatherSplits, isIndoors, WINDY_MPH, COLD_F } from './nfl-weather-response.js';
import { mean } from './stats-util.js';
import { dieboldMariano, naivePairedT } from './forecast-comparison.js';
import { ENSEMBLE_FIT_VERSION } from './nfl-forecast-identity.js';
import { gamePlayerAvailability } from './nfl-player-value.js';
import { nflEngineVersionFor } from './nfl-engine-registry.js';
import { rosterStrengthWeek } from './nfl-roster-strength.js';
import { signalReliabilityFor } from './nfl-signal-reliability.js';
import { buildConformal } from './conformal.js';

const MIN_SEASON = 2015;   // far enough back for stable fits, recent enough to be the modern game
const EVAL_FROM = 2022;    // frozen calibration boundary retained for the established ensemble
const WEIGHT_FIT_FROM = 2018; // discovery history available before the opened 2021-2025 audit
const FIT_ARTIFACT_VERSION = ENSEMBLE_FIT_VERSION;
export const CHALLENGER_SIGNAL_VERSION = 'nfl-challenger-signals-v2';

// nfl_ensemble_fit_artifacts comes from
// server/migrations/000_legacy_schema.js.

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const quantile = (values, p) => {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
};

/* --------------------------------------------------------------- game data */

/** One row per real game, chronological, with the context models need. */
function games(minSeason = MIN_SEASON) {
  return rows(`
    SELECT season, week, team AS home, opponent AS away,
           team_score AS home_score, opp_score AS away_score,
           spread AS home_spread, total,
           open_spread, open_total,
           temp, wind, roof, rest_days AS home_rest, div_game, neutral_site
    FROM game_lines
    WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL
      AND season >= ? AND spread IS NOT NULL
    ORDER BY season, week
  `, minSeason);
}

/** Away-side rest, needed for the rest-differential model. */
function awayRest() {
  const m = new Map();
  for (const r of rows(`SELECT season, week, team, rest_days FROM game_lines WHERE home = 0`)) {
    m.set(`${r.season}|${r.week}|${r.team}`, r.rest_days);
  }
  return m;
}

/* ----------------------------------------------------- rating primitives */

/**
 * Ridge strength for the Massey paired-comparison system.
 *
 * `massey()` below solves the normal equations of the paired-comparison design
 * in which every game contributes a row with +1 in the home team's column, -1
 * in the away team's, and the observed margin as its response. Zero here
 * recovers the ordinary least-squares estimator exactly, including its
 * sum-to-zero pin, so a zero is a genuine no-op rather than an approximation
 * of one — `test/ensemble-massey-ridge.test.js` asserts that identity.
 *
 * WHY THIS IS ZERO, and what was measured to put it there.
 *
 * Shrinkage makes the ESTIMATOR better and the FORECAST no better. Swept over
 * lambda in {0,1,2,5,10,20,50,100,200,500} on the deterministic league fixture
 * (`test/helpers/seed-league-history.js`, ten seasons), the component's own
 * walk-forward margin RMSE bottoms out at lambda = 50, and that win replicates
 * on five independent fixture seeds — 13.823 -> 13.583 mean RMSE, better in
 * 5 of 5. But the held-out ensemble forecast (2024-2025, n = 206 per seed) does
 * not move with it: 12.2675 -> 12.2720 mean, WORSE in 4 of 5 seeds by about
 * four hundredths of a point. This component carries roughly a tenth of the
 * margin weight, the market anchor and market regression carry twice that
 * between them, and melo and dynamic_state already supply opponent-adjusted
 * strength — so a sharper Massey is largely redundant information by the time
 * it reaches the blend.
 *
 * A measured non-improvement is not a reason to ship the change silently at a
 * nonzero default, so the default is the old behaviour exactly. The estimator
 * stays because it is the correct closed form, it is now testable, and one
 * constant is all that stands between it and production if the same sweep ever
 * runs against real NFL history — which this branch could not do.
 *
 * Caveat worth carrying forward: the fixture schedules a near-balanced rotating
 * round-robin, which is the regime where opponent-aware shrinkage has least to
 * add. Real NFL schedules are genuinely unbalanced, so this measurement may
 * understate the ridge rather than overstate it.
 */
const MASSEY_RIDGE_LAMBDA = 0;

/**
 * Massey: least-squares ratings that best explain observed margins, with
 * optional ridge shrinkage toward a prior.
 *
 * Closed form: theta_hat = (X'X + lambda*I)^-1 (X'y + lambda*gamma), where X is
 * the paired-comparison design (+1 home, -1 away), y the observed margins and
 * gamma a prior rating vector. `X'X` is assembled directly as the Massey
 * matrix — games played on the diagonal, negated meeting counts off it — so no
 * n-by-g design matrix is ever materialised.
 *
 * Identification. `X'X` has the all-ones vector in its null space, so ordinary
 * least squares needs an explicit constraint; the lambda = 0 branch keeps the
 * historical pin (overwrite the last row with a sum-to-zero condition). With
 * lambda > 0 the system is already full rank and the pin is not merely
 * unnecessary but harmful: it discards one team's own equation. Centring is
 * preserved for free instead — `X'y` is orthogonal to the all-ones vector by
 * construction (every game adds +m to one column and -m to another), the prior
 * is centred below, and the all-ones vector is an eigenvector of
 * (X'X + lambda*I), so the solution stays orthogonal to it.
 */
function massey(hist, { lambda = MASSEY_RIDGE_LAMBDA, prior = null } = {}) {
  const teams = [...new Set(hist.flatMap(g => [g.home, g.away]))];
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;
  if (!n) return new Map();
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (const g of hist) {
    const i = idx.get(g.home), j = idx.get(g.away);
    const m = g.home_score - g.away_score;
    A[i][i]++; A[j][j]++; A[i][j]--; A[j][i]--;
    b[i] += m; b[j] -= m;
  }
  if (!(lambda > 0)) {
    // Ratings are only identified up to a constant, so pin the mean at zero.
    for (let k = 0; k < n; k++) A[n - 1][k] = 1;
    b[n - 1] = 0;
    const x = solve(A, b);
    return new Map(teams.map((t, i) => [t, x?.[i] ?? 0]));
  }
  // A prior that is not centred would shift every rating by its mean, which the
  // identification above deliberately fixes at zero. Centre it rather than
  // silently moving the whole league.
  const gamma = new Array(n).fill(0);
  if (prior) {
    let sum = 0, seen = 0;
    for (let k = 0; k < n; k++) {
      const v = prior.get(teams[k]);
      if (Number.isFinite(v)) { gamma[k] = v; sum += v; seen++; }
    }
    if (seen) { const mid = sum / seen; for (let k = 0; k < n; k++) gamma[k] -= mid; }
  }
  for (let k = 0; k < n; k++) { A[k][k] += lambda; b[k] += lambda * gamma[k]; }
  const x = solve(A, b);
  return new Map(teams.map((t, i) => [t, x?.[i] ?? 0]));
}

/** Colley: ratings from wins and losses only — deliberately margin-blind. */
function colley(hist) {
  const teams = [...new Set(hist.flatMap(g => [g.home, g.away]))];
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;
  if (!n) return new Map();
  const A = Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0); row[i] = 2; return row;
  });
  const b = new Array(n).fill(1);
  for (const g of hist) {
    const i = idx.get(g.home), j = idx.get(g.away);
    const homeWon = g.home_score > g.away_score;
    A[i][i]++; A[j][j]++; A[i][j]--; A[j][i]--;
    b[i] += (homeWon ? 1 : -1) / 2;
    b[j] += (homeWon ? -1 : 1) / 2;
  }
  const x = solve(A, b);
  return new Map(teams.map((t, i) => [t, x?.[i] ?? 0.5]));
}

/** Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) continue;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-9 ? 0 : row[n] / row[i]));
}

/** Per-team scoring, differential and Pythagorean aggregates. */
function teamAggregates(hist) {
  const t = new Map();
  const get = k => {
    if (!t.has(k)) t.set(k, { pf: 0, pa: 0, g: 0, w: 0, margins: [], totals: [] });
    return t.get(k);
  };
  for (const g of hist) {
    const h = get(g.home), a = get(g.away);
    h.pf += g.home_score; h.pa += g.away_score; h.g++;
    a.pf += g.away_score; a.pa += g.home_score; a.g++;
    if (g.home_score > g.away_score) h.w++; else a.w++;
    h.margins.push(g.home_score - g.away_score);
    a.margins.push(g.away_score - g.home_score);
    const tot = g.home_score + g.away_score;
    h.totals.push(tot); a.totals.push(tot);
  }
  return t;
}

/**
 * Lightweight dynamic offense/defense state. Every update occurs after the
 * corresponding game and the state is regressed between seasons, so a target
 * week can never borrow its own score or a future result.
 */
function dynamicStrength(hist) {
  const state = new Map();
  const get = team => {
    if (!state.has(team)) state.set(team, { offense: 0, defense_allowed: 0, games: 0, error2: 196 });
    return state.get(team);
  };
  let season = null;
  let leaguePoints = 22.5;
  let observedPoints = 0, observedTeams = 0;
  for (const g of hist) {
    if (season != null && g.season !== season) {
      for (const s of state.values()) {
        s.offense *= 0.72;
        s.defense_allowed *= 0.72;
        s.error2 = 0.72 * s.error2 + 0.28 * 196;
      }
    }
    season = g.season;
    const h = get(g.home), a = get(g.away);
    const hfaHalf = 0.65;
    const predHome = leaguePoints + h.offense + a.defense_allowed + hfaHalf;
    const predAway = leaguePoints + a.offense + h.defense_allowed - hfaHalf;
    const homeError = g.home_score - predHome, awayError = g.away_score - predAway;
    const gain = 0.075;
    h.offense += gain * homeError;
    a.defense_allowed += gain * homeError;
    a.offense += gain * awayError;
    h.defense_allowed += gain * awayError;
    h.error2 = 0.9 * h.error2 + 0.1 * awayError ** 2;
    a.error2 = 0.9 * a.error2 + 0.1 * homeError ** 2;
    h.games++; a.games++;
    observedPoints += g.home_score + g.away_score; observedTeams += 2;
    leaguePoints = 0.995 * leaguePoints + 0.005 * (observedPoints / observedTeams);
  }
  return { state, league_points: leaguePoints };
}

/**
 * Mondrian bins for the ensemble's conformal interval (Giant Plan 7.3, fix #18).
 * Bucketed on the market's |spread| — the one pre-kickoff feature that actually
 * sorts games by how variable their margin turns out to be.
 */
const ENSEMBLE_SPREAD_BINS = [3, 6.5, 10];
const ENSEMBLE_TOTAL_BINS = [44, 48];
const ENSEMBLE_MIN_BIN = 150;
const ENSEMBLE_MIN_CALIBRATION = 200;

/**
 * Split-conformal predictive distribution around the point forecast.
 *
 * What this replaces, and why. The previous version pooled every residual in
 * history, re-centred them on their own median, and then multiplied the spread
 * of that pool by `1 + min(0.25, disagreement / 30)`. Two separate problems:
 *
 *   1. The pool was effectively unconditional. A "similar environment" cohort
 *      was attempted (|spread| within 2.5 and total within 6) but it fell back
 *      to all history whenever fewer than 120 comparable games existed, and the
 *      fallback is the common case early in a season — so most games got one
 *      global residual shape, the same defect fix #15 names in nfl-market.js.
 *   2. `disagreement / 30` has no derivation. Thirty is not a measured quantity;
 *      the multiplier was a plausible-looking knob, and a knob that widens an
 *      interval without a coverage argument cannot make it better calibrated —
 *      it can only make it wider, which is not the same thing. That is exactly
 *      why this function has always carried `production_eligible: false`.
 *
 * What replaces it is a split-conformal interval, Mondrian-binned by the
 * market's spread bucket. The residual pool is the same one this function
 * already used (actual margin minus the market's margin, from games completed
 * strictly before this one), but the interval is now the bin's own
 * ceil((n+1)·level) order statistic of |residual| — a finite-sample coverage
 * statement rather than a shape assumption plus a fudge factor.
 *
 * `production_eligible` deliberately stays false. A better mechanism is not a
 * promotion; that decision belongs to the promotion gate in staking.js, on
 * forward-settled evidence, not to the function describing itself.
 */
export function predictiveDistribution(hist, { margin, total, homeSpread, marketTotal, disagreement }) {
  if (margin == null) return null;
  const all = hist.filter(x => x.home_spread != null).map(x => ({
    spread: x.home_spread, total: x.total,
    margin_residual: (x.home_score - x.away_score) - (-x.home_spread),
    total_residual: x.total == null ? null : (x.home_score + x.away_score) - x.total
  }));
  if (all.length < ENSEMBLE_MIN_CALIBRATION) return null;

  // Centre the calibration set the same way the point forecast is centred, so
  // the residuals being quantiled are residuals of THIS forecast and not of a
  // systematically different one.
  const marginCentre = quantile(all.map(x => x.margin_residual), 0.5) ?? 0;
  const marginCal = buildConformal(
    all.map(x => ({ key: Math.abs(x.spread), residual: x.margin_residual - marginCentre })),
    { edges: ENSEMBLE_SPREAD_BINS, minBin: ENSEMBLE_MIN_BIN });

  const totalRows = all.filter(x => Number.isFinite(x.total_residual) && x.total != null);
  const totalCentre = totalRows.length ? (quantile(totalRows.map(x => x.total_residual), 0.5) ?? 0) : 0;
  const totalCal = totalRows.length >= ENSEMBLE_MIN_CALIBRATION
    ? buildConformal(totalRows.map(x => ({ key: x.total, residual: x.total_residual - totalCentre })),
      { edges: ENSEMBLE_TOTAL_BINS, minBin: ENSEMBLE_MIN_BIN })
    : null;

  // The bin's own residual sample, applied to this game's point forecast. Every
  // probability below is a threshold read on this one sample, which is what
  // keeps cover, win and push arithmetically unable to contradict each other.
  const marginKey = homeSpread == null ? Math.abs(margin) : Math.abs(homeSpread);
  const binResiduals = marginCal.residualsFor(marginKey);
  const marginSamples = binResiduals.map(x => Math.round(margin + x));
  const grade = marginSamples.map(x => (homeSpread == null ? null : Math.sign(x + homeSpread)));
  const winGrade = marginSamples.map(x => Math.sign(x));

  const totalKey = marketTotal ?? total;
  const totalSamples = total == null || !totalCal ? []
    : totalCal.residualsFor(totalKey).map(x => Math.round(total + x));

  const q = values => ({
    p10: r2(quantile(values, 0.10)), p25: r2(quantile(values, 0.25)),
    p50: r2(quantile(values, 0.50)), p75: r2(quantile(values, 0.75)), p90: r2(quantile(values, 0.90))
  });
  const iv80 = marginCal.interval(margin, marginKey, 0.80);
  const iv50 = marginCal.interval(margin, marginKey, 0.50);
  const detail = marginCal.describe(marginKey, 0.80);

  return {
    method: 'mondrian split-conformal on pre-kickoff market residuals',
    sample_size: binResiduals.length,
    calibration_total: marginCal.calibration_n,
    conditional_cohort: !detail.borrowed_pool,
    conformal: { ...detail, level: 0.80, bins: marginCal.bins, centre: r2(marginCentre) },
    margin_quantiles: q(marginSamples), total_quantiles: totalSamples.length ? q(totalSamples) : null,
    home_cover_probability: homeSpread == null ? null : r2(grade.filter(x => x > 0).length / grade.length),
    away_cover_probability: homeSpread == null ? null : r2(grade.filter(x => x < 0).length / grade.length),
    push_probability: homeSpread == null ? null : r2(grade.filter(x => x === 0).length / grade.length),
    home_win_probability: r2(winGrade.filter(x => x > 0).length / winGrade.length),
    away_win_probability: r2(winGrade.filter(x => x < 0).length / winGrade.length),
    margin_interval_80: iv80 ? [r2(iv80[0]), r2(iv80[1])] : null,
    margin_interval_50: iv50 ? [r2(iv50[0]), r2(iv50[1])] : null,
    uncertainty_width_80: iv80 ? r2(iv80[1] - iv80[0]) : null,
    // Reported, no longer applied. The old code multiplied the interval by
    // 1 + disagreement/30; it is kept visible as a diagnostic so the number can
    // be studied against realised coverage instead of silently widening a bet.
    model_disagreement_margin: disagreement == null ? null : r2(disagreement),
    positive_ev_threshold_at_minus_110: 0.5238,
    calibration_state: 'research_distribution_only',
    production_eligible: false
  };
}

/** Per-team play-by-play feature averages before a given point. */
const _featureAggregateCache = new Map();
function featureAggregates(season, week) {
  const cacheKey = `${season}|${week}`;
  if (_featureAggregateCache.has(cacheKey)) return _featureAggregateCache.get(cacheKey);
  // Early-season forecasts borrow the immediately previous season with a
  // measured recency decay. Week 1 can no longer turn every efficiency model
  // off, while older seasons never leak through the cutoff.
  const all = teamWeeks().filter(t => t.season === season ? t.week < week : t.season === season - 1);
  const byTeam = new Map();
  for (const t of all) {
    const e = byTeam.get(t.team) ?? [];
    e.push(t.features);
    byTeam.set(t.team, e);
  }
  const out = new Map();
  for (const [team, list] of byTeam) {
    const pick = k => {
      const vals = list.map((f, i) => ({ value: f[k], weight: 0.5 ** ((list.length - 1 - i) / 12) }))
        .filter(x => x.value != null);
      const weight = vals.reduce((s, x) => s + x.weight, 0);
      return weight ? vals.reduce((s, x) => s + x.value * x.weight, 0) / weight : null;
    };
    out.set(team, {
      net_epa: pick('net_epa_per_play'),
      off_epa: pick('off_epa_per_play'), def_epa: pick('def_epa_per_play'),
      off_epa_nwp: pick('off_epa_neutral_wp'), def_epa_nwp: pick('def_epa_neutral_wp'),
      off_early_epa: pick('off_early_down_epa'), def_early_epa: pick('def_early_down_epa'),
      off_pass_epa: pick('off_pass_epa_per_play'), def_pass_epa: pick('def_pass_epa_per_play'),
      off_rush_epa: pick('off_rush_epa_per_play'), def_rush_epa: pick('def_rush_epa_per_play'),
      off_expl_pass: pick('off_explosive_pass_rate'), def_expl_pass: pick('def_explosive_pass_rate'),
      off_pressure_epa: pick('off_pressure_epa'), def_pressure_epa: pick('def_pressure_epa'),
      off_series_sr: pick('off_series_success_rate'), def_series_sr: pick('def_series_success_rate'),
      off_drive_start: pick('off_avg_drive_start'), def_drive_start: pick('def_avg_drive_start'),
      off_second_half_epa: pick('off_second_half_epa'), def_second_half_epa: pick('def_second_half_epa'),
      off_sr: pick('off_success_rate'), def_sr: pick('def_success_rate'),
      off_expl: pick('off_explosive_play_rate'), def_expl: pick('def_explosive_play_rate'),
      off_dsr: pick('off_drive_scoring_rate'), def_dsr: pick('def_drive_scoring_rate'),
      off_3rd: pick('off_third_down_rate'), def_3rd: pick('def_third_down_rate'),
      off_rz: pick('off_red_zone_td_rate'), def_rz: pick('def_red_zone_td_rate'),
      off_sack: pick('off_sack_rate'), def_sack: pick('def_sack_rate'),
      def_havoc: pick('def_havoc_rate'), off_to: pick('off_turnover_rate'), def_to: pick('def_turnover_rate'),
      off_plays: pick('off_plays'), off_secs: pick('off_seconds_per_drive'),
      off_drives: pick('off_drives'), off_ypd: pick('off_yards_per_drive'),
      off_proe: pick('off_proe')
    });
  }
  _featureAggregateCache.set(cacheKey, out);
  return out;
}

/* ------------------------------------------------ per-team weather response */

/**
 * League-average weather effects on a GAME TOTAL, in points. These are the
 * constants `weather_total` applied to every team identically, and they stay
 * exactly as they were: they are the prior this component falls back to, and
 * the centre that per-team responses are measured as deviations from.
 */
const FLAT_WEATHER_POINTS = { dome: 1.2, wind: -2.4, cold: -1.6 };

/** Snaps an offense runs in a game when its own play count is unknown. */
const DEFAULT_OFF_PLAYS = 63;

/**
 * A team's own response may shift its share of the weather effect by at most
 * the size of that effect. In a windy game the league constant is -2.4 points
 * of game total, or -1.2 per offense, so one offense's deviation is bounded to
 * +/-1.2: it can cancel its share of the penalty, or double it, and no more.
 *
 * A fixed wide cap was tried first and was wrong. On a synthetic league with
 * NO real per-team weather effect, a 3-point cap still let single games move
 * six points -- an estimate built entirely from sampling noise, sized like a
 * real edge. Bounding the deviation by the effect it is deviating from keeps
 * the adjustment inside the physics of the thing being adjusted.
 */
const weatherDeviationCap = kinds =>
  kinds.reduce((s, kind) => s + Math.abs(FLAT_WEATHER_POINTS[kind]) / 2, 0);

const _weatherSensitivityCache = new Map();

/**
 * How much each offense's own efficiency actually moved indoors, in the cold
 * and in the wind -- measured from that team's prior games, cut off before the
 * week being predicted.
 *
 * `nfl-weather-response.js` has defined these three deltas all along, and
 * `nfl-features.js` has surfaced them per team as `dome_epa_delta` /
 * `cold_epa_delta` / `wind_epa_delta`.
 * The forecasting ensemble never read them: `weather_total` applied one flat
 * league constant to a dome game whether the offense in it threw on 70% of
 * snaps or ran on 55%. This is the aggregate that makes them readable in the
 * walk-forward loop, on the same cutoff convention `featureAggregates` uses
 * (this season's earlier weeks, plus the whole prior season for sample).
 *
 * The hard part is not reading the delta, it is believing it. A team plays
 * perhaps two indoor games and three windy ones in a season. Per-game
 * offensive EPA has a standard deviation around 0.12, so a delta built on a
 * 3-versus-14 split carries a standard error near 0.075 EPA per play -- about
 * five points of game total, several times larger than the entire effect being
 * estimated. Wired in raw, these deltas would be almost pure noise and would
 * make the component worse, not better.
 *
 * So the deltas are shrunk, and the shrinkage is estimated rather than
 * guessed. Across the 32 teams at this cutoff we have the observed spread of
 * the deltas and, from the pooled per-game variance of offensive EPA, the
 * sampling noise each one carries. The between-team variance that survives
 * subtracting the noise is the only part that can be real; each team's delta
 * is pulled toward the league mean by the usual empirical-Bayes ratio
 * tau^2 / (tau^2 + v_team). When no between-team variance survives -- the
 * honest common case -- every weight is zero, every team gets the league mean,
 * and the component's output is identical to the flat constant it replaced.
 *
 * Only the DEVIATION from the league mean is handed back. The league-average
 * weather effect is already in FLAT_WEATHER_POINTS, so keeping the mean here
 * too would double-count it, and would let this change quietly shift the
 * model's global total calibration instead of doing the one thing it is for:
 * telling two offenses in the same weather apart.
 */
function weatherSensitivity(season, week) {
  const cacheKey = `${season}|${week}`;
  if (_weatherSensitivityCache.has(cacheKey)) return _weatherSensitivityCache.get(cacheKey);

  const weeks = teamWeeks().filter(t => (t.season === season ? t.week < week : t.season === season - 1));
  const conditions = new Map();
  for (const r of rows(`SELECT season, week, team, roof, temp, wind FROM game_lines
                        WHERE season IN (?, ?)`, season, season - 1)) {
    conditions.set(`${r.season}|${r.week}|${r.team}`, r);
  }

  const byTeam = new Map();
  for (const t of weeks) {
    const epa = t.features?.off_epa_per_play;
    if (epa == null || !Number.isFinite(epa)) continue;
    const c = conditions.get(`${t.season}|${t.week}|${t.team}`);
    if (!c) continue;
    const list = byTeam.get(t.team) ?? [];
    list.push({ epa, roof: c.roof, temp: c.temp, wind: c.wind });
    byTeam.set(t.team, list);
  }

  const splits = new Map();
  for (const [team, samples] of byTeam) splits.set(team, weatherSplits(samples));

  // Pooled within-team, per-game variance of offensive EPA: the noise floor
  // every one of these deltas is drawn through.
  const centered = [];
  for (const s of splits.values()) {
    const m = avg(s.epa_samples);
    if (m == null || s.epa_samples.length < 2) continue;
    for (const v of s.epa_samples) centered.push((v - m) ** 2);
  }
  const perGameVar = centered.length ? mean(centered) : null;

  const KINDS = [['dome', 'dome_epa_delta', 'dome_n', 'outdoor_n'],
    ['cold', 'cold_epa_delta', 'cold_n', 'warm_n'],
    ['wind', 'wind_epa_delta', 'windy_n', 'calm_n']];

  const out = new Map();
  const diagnostics = {};
  for (const [kind, deltaKey, aKey, bKey] of KINDS) {
    const observed = [];
    for (const [team, s] of splits) {
      const d = s[deltaKey];
      if (d == null || !Number.isFinite(d)) continue;
      const nA = s[aKey], nB = s[bKey];
      if (!nA || !nB) continue;
      // Variance of a difference of two independent group means.
      const v = perGameVar == null ? null : perGameVar * (1 / nA + 1 / nB);
      if (v == null || !(v > 0)) continue;
      observed.push({ team, d, v });
    }
    // Below a handful of teams there is no league spread to estimate, so there
    // is nothing to separate signal from noise with: hold everything at the
    // league prior.
    if (observed.length < 8) { diagnostics[kind] = { teams: observed.length, tau2: 0, shrunk: false }; continue; }
    const dBar = mean(observed.map(o => o.d));
    const spread = mean(observed.map(o => (o.d - dBar) ** 2));
    const noise = mean(observed.map(o => o.v));
    const tau2 = Math.max(0, spread - noise);
    // `spread` is itself an estimate from ~32 teams, so under a true null it
    // lands above `noise` about half the time and max(0, .) keeps only those
    // halves -- an upward bias that would hand out team-specific adjustments
    // built from nothing. Measured on a synthetic league with NO real per-team
    // weather effect, the plain tau2 > 0 rule still moved 288 of 527 games.
    // So the spread must clear the noise by more than the spread's own
    // sampling error (about sqrt(2/(k-1)) of it, for a sum of squares over k
    // teams) at roughly a one-sided 95% level, before any deviation is
    // applied at all. Below that bar every team gets the league mean and this
    // component is byte-identical to the flat constant it replaced.
    const spreadStdErr = noise * Math.sqrt(2 / Math.max(1, observed.length - 1));
    const significant = spread - noise > 1.645 * spreadStdErr;
    diagnostics[kind] = { teams: observed.length, tau2: +tau2.toFixed(6),
      spread: +spread.toFixed(6), noise: +noise.toFixed(6), significant, shrunk: significant && tau2 > 0 };
    if (!significant || !(tau2 > 0)) continue;   // no real between-team variation survived
    for (const o of observed) {
      const w = tau2 / (tau2 + o.v);
      const deviation = w * (o.d - dBar);   // EPA per play, team-specific part only
      const e = out.get(o.team) ?? {};
      e[kind] = deviation;
      out.set(o.team, e);
    }
  }

  const result = { byTeam: out, diagnostics };
  _weatherSensitivityCache.set(cacheKey, result);
  return result;
}

/**
 * The points `weather_total` adds for the conditions this game is played in.
 *
 * The flat league constant is always applied in full. On top of it, each
 * offense contributes its own shrunk deviation converted to points -- EPA per
 * play is already denominated in points, so the conversion is just that team's
 * expected snap count. An offense with no measured deviation (no prior games
 * in those conditions, or no surviving between-team variance) contributes
 * nothing, which reproduces the previous behaviour exactly.
 */
function weatherAdjustment(c) {
  const kinds = [];
  if (isIndoors(c.roof)) kinds.push('dome');
  if (c.wind != null && c.wind >= WINDY_MPH) kinds.push('wind');
  if (c.temp != null && c.temp < COLD_F) kinds.push('cold');
  let adj = 0;
  for (const kind of kinds) adj += FLAT_WEATHER_POINTS[kind];
  if (!kinds.length || !c.weather?.byTeam) return adj;

  for (const team of [c.home, c.away]) {
    const sens = c.weather.byTeam.get(team);
    if (!sens) continue;
    const plays = c.feat?.get(team)?.off_plays;
    const snaps = plays != null && Number.isFinite(plays) && plays > 0 ? plays : DEFAULT_OFF_PLAYS;
    let deviation = 0;
    for (const kind of kinds) deviation += (sens[kind] ?? 0) * snaps;
    const cap = weatherDeviationCap(kinds);
    adj += Math.max(-cap, Math.min(cap, deviation));
  }
  return adj;
}

/** A matchup feature abstains unless both its offense and defense halves exist. */
function netFeature(feature, offenseKey, defenseKey) {
  const offense = feature?.[offenseKey], defense = feature?.[defenseKey];
  return offense == null || defense == null ? null : offense - defense;
}

/* ------------------------------------------------------- component models */

/**
 * Every model is a function of (context) -> { margin, total } from the home
 * team's perspective, where positive margin favours the home side. A model may
 * return null for either when it has no opinion on that quantity.
 */
const MODELS = [
  /* ---- availability ---- */
  {
    id: 'availability', name: 'Injury availability', family: 'Roster availability',
    note: 'Weighted share of each team\'s playing time that is unavailable, from the official ' +
      'injury report. The first model here to read the injury table at all.',
    predict: (c) => {
      const h = c.avail?.get(String(c.home).toUpperCase()) ?? null;
      const a = c.avail?.get(String(c.away).toUpperCase()) ?? null;
      // No injury report is missing evidence, not a healthy team. Returning zero
      // would hand this model real ensemble weight for saying nothing, which is
      // the mistake the feature-differential models were already fixed for.
      if (h == null && a == null) return { margin: null, total: null };
      const raw = (a ?? 0) - (h ?? 0);
      const cal = c.cal?.availability;
      if (cal) return { margin: cal.b0 + cal.b1 * raw, total: null };
      return { margin: raw * 1.2 + c.hfa, total: null };
    }
  },
  {
    id: 'roster_strength', name: 'Roster strength and depth', family: 'Roster availability',
    challengerOnly: true,
    note: 'A preseason-first full depth-chart rating from prior snaps, player efficiency, rookies and optional licensed PFF grades that adapts weekly.',
    predict: (c) => {
      const home = c.roster?.get(String(c.home).toUpperCase());
      const away = c.roster?.get(String(c.away).toUpperCase());
      if (!home?.available || !away?.available) return { margin: null, total: null };
      return { margin: c.hfa + (home.roster_score - away.roster_score) * 0.32, total: null };
    }
  },
  /* ---- rating systems ---- */
  {
    id: 'massey', name: 'Massey least squares', family: 'Rating systems',
    note: 'Solves for the ratings that best explain every observed margin at once.',
    predict: (c) => ({ margin: (c.massey.get(c.home) ?? 0) - (c.massey.get(c.away) ?? 0) + c.hfa, total: null })
  },
  {
    id: 'colley', name: 'Colley (wins only)', family: 'Rating systems',
    note: 'Ignores margin entirely, so it disagrees with Massey exactly when record and point differential tell different stories.',
    predict: (c) => ({ margin: ((c.colley.get(c.home) ?? 0.5) - (c.colley.get(c.away) ?? 0.5)) * 55 + c.hfa, total: null })
  },
  {
    id: 'pythagorean', name: 'Pythagenport expectation', family: 'Rating systems',
    note: 'Expected win rate from points scored and allowed, which regresses lucky records.',
    predict: (c) => {
      const p = t => {
        const a = c.agg.get(t); if (!a || !a.g) return 0.5;
        const ex = 2.37;
        const pf = a.pf ** ex, pa = a.pa ** ex;
        return pf + pa > 0 ? pf / (pf + pa) : 0.5;
      };
      return { margin: (p(c.home) - p(c.away)) * 50 + c.hfa, total: null };
    }
  },
  {
    id: 'point_diff', name: 'Raw point differential', family: 'Rating systems',
    note: 'The simplest honest baseline — average margin per game, differenced.',
    predict: (c) => {
      const d = t => { const a = c.agg.get(t); return a && a.g ? (a.pf - a.pa) / a.g : 0; };
      return { margin: d(c.home) - d(c.away) + c.hfa, total: null };
    }
  },
  {
    id: 'melo', name: 'Margin-dependent Elo', family: 'Rating systems',
    note: 'Elo where a blowout moves the rating more than a one-score win.',
    predict: (c) => ({ margin: ((c.melo.get(c.home) ?? 0) - (c.melo.get(c.away) ?? 0)) / 25 + c.hfa, total: null })
  },
  {
    id: 'dynamic_state', name: 'Dynamic offense / defense state', family: 'Rating systems',
    note: 'A chronological latent scoring state that adapts weekly, regresses between seasons and reports matchup-specific offense/defense strength.',
    predict: (c) => {
      const h = c.dynamic.state.get(c.home), a = c.dynamic.state.get(c.away);
      if (!h || !a) return { margin: null, total: null };
      const homePoints = c.dynamic.league_points + h.offense + a.defense_allowed + c.hfa / 2;
      const awayPoints = c.dynamic.league_points + a.offense + h.defense_allowed - c.hfa / 2;
      return { margin: homePoints - awayPoints, total: homePoints + awayPoints };
    }
  },

  /* ---- play-level efficiency ---- */
  {
    id: 'epa_net', name: 'Net EPA per play', family: 'Efficiency',
    note: 'Offensive efficiency minus defensive efficiency allowed, scaled to points.',
    predict: (c) => diffModel(c, f => f.net_epa, 65, 'epa_net')
  },
  {
    id: 'epa_neutral', name: 'EPA, garbage time removed', family: 'Efficiency',
    note: 'Same idea, but only plays from competitive game states.',
    predict: (c) => diffModel(c, f => (f.off_epa_nwp ?? 0) - (f.def_epa_nwp ?? 0), 65, 'epa_neutral')
  },
  /* New signals begin as measured challengers. They are scored in every
   * chronological fit and shown in diagnostics, but cannot dilute the active
   * raw blend merely because we added them. Promotion is an evidence decision. */
  {
    id: 'early_down_eff', name: 'Early-down efficiency', family: 'Efficiency', challengerOnly: true,
    note: 'First- and second-down EPA, before third-down conversion variance can dominate a small sample.',
    predict: c => diffModel(c, f => netFeature(f, 'off_early_epa', 'def_early_epa'), 60, 'early_down_eff')
  },
  {
    id: 'pass_eff_matchup', name: 'Passing efficiency mismatch', family: 'Efficiency', challengerOnly: true,
    note: 'Passing EPA created versus passing EPA allowed; isolates the league’s highest-leverage play type.',
    predict: c => diffModel(c, f => netFeature(f, 'off_pass_epa', 'def_pass_epa'), 60, 'pass_eff_matchup')
  },
  {
    id: 'rush_eff_matchup', name: 'Rushing efficiency mismatch', family: 'Efficiency', challengerOnly: true,
    note: 'Rushing EPA created versus allowed, kept separate so it cannot hide inside a net efficiency average.',
    predict: c => diffModel(c, f => netFeature(f, 'off_rush_epa', 'def_rush_epa'), 55, 'rush_eff_matchup')
  },
  {
    id: 'explosive_pass', name: 'Explosive-pass asymmetry', family: 'Efficiency', challengerOnly: true,
    note: 'Rate of explosive passes created minus allowed; measures one-play scoring and comeback capacity.',
    predict: c => diffModel(c, f => netFeature(f, 'off_expl_pass', 'def_expl_pass'), 160, 'explosive_pass')
  },
  {
    id: 'pressure_response', name: 'Pressure response mismatch', family: 'Efficiency', challengerOnly: true,
    note: 'Offensive EPA under pressure against the opponent’s defensive pressure outcomes.',
    predict: c => diffModel(c, f => netFeature(f, 'off_pressure_epa', 'def_pressure_epa'), 45, 'pressure_response')
  },
  {
    id: 'series_sustain', name: 'Series sustain rate', family: 'Efficiency', challengerOnly: true,
    note: 'How consistently an offense earns another first down versus how consistently a defense ends a series.',
    predict: c => diffModel(c, f => netFeature(f, 'off_series_sr', 'def_series_sr'), 100, 'series_sustain')
  },
  {
    id: 'field_position', name: 'Starting field-position edge', family: 'Efficiency', challengerOnly: true,
    note: 'Average offensive drive start versus field position conceded, capturing hidden special-teams and turnover value.',
    predict: c => diffModel(c, f => netFeature(f, 'off_drive_start', 'def_drive_start'), 0.7, 'field_position')
  },
  {
    id: 'second_half_eff', name: 'Second-half efficiency', family: 'Efficiency', challengerOnly: true,
    note: 'Prior-game second-half EPA created versus allowed; a candidate for adjustment and depth effects.',
    predict: c => diffModel(c, f => netFeature(f, 'off_second_half_epa', 'def_second_half_epa'), 55, 'second_half_eff')
  },
  {
    id: 'success_rate', name: 'Success rate differential', family: 'Efficiency',
    note: 'Consistency rather than explosiveness — how often a team stays on schedule.',
    predict: (c) => diffModel(c, f => (f.off_sr ?? 0) - (f.def_sr ?? 0), 120, 'success_rate')
  },
  {
    id: 'explosive', name: 'Explosive play differential', family: 'Efficiency',
    note: 'Big plays created minus big plays allowed.',
    predict: (c) => diffModel(c, f => (f.off_expl ?? 0) - (f.def_expl ?? 0), 200, 'explosive')
  },
  {
    id: 'drive_eff', name: 'Drive scoring differential', family: 'Efficiency',
    note: 'Possessions turned into points, both directions.',
    predict: (c) => diffModel(c, f => (f.off_dsr ?? 0) - (f.def_dsr ?? 0), 60, 'drive_eff')
  },
  {
    id: 'situational', name: 'Third down and red zone', family: 'Efficiency',
    note: 'The two situations that convert efficiency into actual points.',
    predict: (c) => diffModel(c, f =>
      ((f.off_3rd ?? 0) - (f.def_3rd ?? 0)) + ((f.off_rz ?? 0) - (f.def_rz ?? 0)), 40, 'situational')
  },
  {
    id: 'trenches', name: 'Line of scrimmage', family: 'Efficiency',
    note: 'Pressure generated and allowed, plus defensive havoc.',
    predict: (c) => diffModel(c, f =>
      ((f.def_sack ?? 0) - (f.off_sack ?? 0)) + ((f.def_havoc ?? 0) * 0.5), 70, 'trenches')
  },
  {
    id: 'turnover_regressed', name: 'Turnover-regressed margin', family: 'Efficiency',
    note: 'Average margin with turnover luck faded, since takeaways barely persist week to week.',
    predict: (c) => {
      const d = t => {
        const a = c.agg.get(t), f = c.feat.get(t);
        if (!a || !a.g) return 0;
        const raw = (a.pf - a.pa) / a.g;
        const toEdge = f ? ((f.def_to ?? 0) - (f.off_to ?? 0)) * 70 : 0;
        return raw - 0.6 * toEdge; // fade most of the turnover contribution
      };
      return { margin: d(c.home) - d(c.away) + c.hfa, total: null };
    }
  },
  {
    id: 'opp_adjusted', name: 'Opponent-adjusted EPA', family: 'Efficiency',
    note: 'Efficiency corrected for the quality of defences and offences actually faced this season, using each team\'s real schedule (`c.schedule`, from games strictly earlier than the decision). ' +
      'CORRECTED 2026-09-10 (Codex audit finding M13): the previous version computed ((off_epa - league) - (def_epa - league)), which algebraically cancels to plain off_epa - def_epa -- ' +
      'mathematically identical to the unadjusted `epa_net` component elsewhere in this file, despite its name and note claiming a real opponent adjustment. It now actually looks up each ' +
      'team\'s opponents from that season\'s schedule and adjusts offense for the average quality of defenses faced (and defense for the average quality of offenses faced), a standard ' +
      'first-pass strength-of-schedule adjustment (not a fully iterative SRS solve). This is a genuine behavior change, not just a rename -- it has not yet been walk-forward validated as an ' +
      'improvement over the plain net-EPA component it replaces functionally; treat its ensemble weight like any other freshly-changed component until a dedicated comparison runs.',
    predict: (c) => {
      if (!c.feat.has(c.home) || !c.feat.has(c.away)) return { margin: null, total: null };
      const league = avg([...c.feat.values()].map(f => f.off_epa).filter(v => v != null)) ?? 0;
      const leagueDef = avg([...c.feat.values()].map(f => f.def_epa).filter(v => v != null)) ?? 0;
      const opponentsOf = t => (c.schedule?.get(t) ?? []).filter(o => o !== t && c.feat.has(o));
      // A team that faced tougher-than-average defenses (lower def_epa allowed
      // = better defense) has its raw offensive EPA adjusted UP relative to a
      // team with an easier schedule, and symmetrically for defense.
      // Codex correction C04: below MIN_OPPONENTS_FOR_ADJUSTMENT the schedule is
      // too thin to say anything about strength faced, and the component falls
      // back to the league average -- which is the same as making no adjustment
      // at all, stated explicitly rather than arrived at by averaging one game.
      const adjOff = t => {
        const f = c.feat.get(t); if (!f || f.off_epa == null) return null;
        const opponents = opponentsOf(t).filter(o => c.feat.get(o).def_epa != null);
        const avgOppDef = opponents.length >= MIN_OPPONENTS_FOR_ADJUSTMENT
          ? avg(opponents.map(o => c.feat.get(o).def_epa)) : leagueDef;
        return (f.off_epa - league) - (avgOppDef - leagueDef);
      };
      const adjDef = t => {
        const f = c.feat.get(t); if (!f || f.def_epa == null) return null;
        const opponents = opponentsOf(t).filter(o => c.feat.get(o).off_epa != null);
        const avgOppOff = opponents.length >= MIN_OPPONENTS_FOR_ADJUSTMENT
          ? avg(opponents.map(o => c.feat.get(o).off_epa)) : league;
        return (f.def_epa - leagueDef) - (avgOppOff - league);
      };
      const homeOff = adjOff(c.home), homeDef = adjDef(c.home);
      const awayOff = adjOff(c.away), awayDef = adjDef(c.away);
      if (homeOff == null || homeDef == null || awayOff == null || awayDef == null) return { margin: null, total: null };
      const homeNet = homeOff - homeDef, awayNet = awayOff - awayDef;
      return { margin: (homeNet - awayNet) * 65 + c.hfa, total: null };
    }
  },

  /* ---- context ---- */
  {
    id: 'recent_form', name: 'Recent form (last 3)', family: 'Context',
    note: 'Weights the last three games heavily — catches teams that have changed.',
    predict: (c) => {
      const d = t => {
        const m = c.recent.get(t);
        return m && m.length ? avg(m.slice(-3)) : 0;
      };
      return { margin: d(c.home) - d(c.away) + c.hfa, total: null };
    }
  },
  {
    id: 'rest_travel', name: 'Rest and division familiarity', family: 'Context',
    note: 'Home field, rest differential (fitted, not assumed — replay analysis found short-week games were the single largest systematic error) and a fixed home-field reduction in division games. ' +
      'RENAMED 2026-09-10 (Codex audit finding M13): despite its previous "rest and travel" name, this component has never measured travel (distance, time zones, direction) at all — only rest ' +
      'days and a division-game indicator. The id is kept stable (persisted weight/provenance history is keyed by it) but the name and this note now describe only what it actually computes.',
    predict: (c) => {
      // Replaying 2022-2025 showed short-week games losing at 40% (z = -3.4),
      // which said the hand-picked 0.18 points per rest day was wrong. The
      // coefficient is now fitted on the pre-evaluation era like every other
      // scale in this file.
      const restDiff = (c.homeRest ?? 7) - (c.awayRest ?? 7);
      const f = c.cal?.rest;
      const restEdge = f ? f.b1 * restDiff : restDiff * 0.18;
      // A fixed shift toward the AWAY side in division games -- division
      // rivals travel less and know the building, which erodes some of the
      // home crowd/environment edge. This always favors away by the same
      // amount regardless of who is favored; it does NOT shrink the overall
      // predicted margin toward a pick'em the way "compresses margins" (the
      // previous comment here) implies.
      const divPenalty = c.div === 1 ? -0.4 : 0;
      return { margin: c.hfa + restEdge + divPenalty, total: null };
    }
  },
  {
    id: 'pace_total', name: 'Pace and possessions', family: 'Context',
    note: 'How many plays and drives these two generate, which sets the ceiling on a total.',
    predict: (c) => {
      if (!c.feat.has(c.home) || !c.feat.has(c.away)) return { margin: null, total: null };
      const t = k => c.feat.get(k) ?? {};
      const h = t(c.home), a = t(c.away);
      const drives = ((h.off_drives ?? 11) + (a.off_drives ?? 11));
      const ypd = ((h.off_ypd ?? 30) + (a.off_ypd ?? 30)) / 2;
      return { margin: null, total: drives * (ypd / 30) * 2.05 };
    }
  },
  {
    id: 'weather_total', name: 'Weather-adjusted total', family: 'Context',
    note: 'Scoring environment adjusted for wind, cold and roof, plus how much each of these two offenses has actually moved in those conditions.',
    predict: (c) => {
      const base = ((c.agg.get(c.home)?.totals ?? []).length
        ? avg(c.agg.get(c.home).totals) : 44)
        * 0.5 + ((c.agg.get(c.away)?.totals ?? []).length
        ? avg(c.agg.get(c.away).totals) : 44) * 0.5;
      return { margin: null, total: base + weatherAdjustment(c) };
    }
  },

  /* ---- market ---- */
  {
    id: 'market_anchor', name: 'Market anchor', family: 'Market',
    note: 'Starts from the number the books opened and keeps it — the market is a strong prior.',
    predict: (c) => ({
      margin: c.openSpread != null ? -c.openSpread : c.spread != null ? -c.spread : null,
      total: c.openTotal ?? c.total ?? null
    })
  },
  {
    id: 'market_regression', name: 'Market regression', family: 'Market',
    note: 'Fitted relationship between the closing line and the margin that actually happened.',
    predict: (c) => ({
      margin: c.spread == null ? null : c.reg ? c.reg.b0 + c.reg.b1 * (-c.spread) : -c.spread,
      total: c.total ?? null
    })
  }
];

const FAMILY_CONTRACTS = {
  'Roster availability': {
    source: 'depth charts, prior snaps/player features, injury reports and optional licensed grades',
    availability: 'before kickoff',
    cutoff_rule: 'depth captured by target game; performance and external grades strictly before target week',
    missing_policy: 'component abstains when either roster lacks a cutoff-safe depth chart'
  },
  'Rating systems': {
    source: 'game_lines final scores', availability: 'game final',
    cutoff_rule: 'season < target OR same season and week < target week',
    missing_policy: 'cold-start neutral rating; never fabricate a completed game'
  },
  Efficiency: {
    source: 'nflverse play-by-play aggregated by team-week', availability: 'after game final',
    cutoff_rule: 'teamWeeks are filtered to week < target week',
    missing_policy: 'component abstains when either team lacks the required feature'
  },
  Context: {
    source: 'pregame schedule, weather, rest and prior play-by-play', availability: 'before kickoff',
    cutoff_rule: 'target-game context plus outcomes only from strictly earlier games',
    missing_policy: 'nullable context stays null or the component abstains'
  },
  Market: {
    source: 'pregame sportsbook spread and total', availability: 'before kickoff',
    cutoff_rule: 'target-game quote is allowed; no target-game result enters fitting',
    missing_policy: 'market component abstains when no real quote exists'
  }
};

/**
 * Shared shape for "difference two teams on one feature, scale to points".
 *
 * The scale passed in is only a starting guess. Hand-picking how many points a
 * unit of EPA is worth is exactly the kind of assumption that should be
 * measured, so `calibrate()` refits every model's slope and intercept on an
 * era that ends before the evaluation window begins — the raw differential is
 * what carries the signal, and the conversion to points is fitted.
 */
function diffModel(c, f, scale, id) {
  const home = c.feat.get(c.home), away = c.feat.get(c.away);
  // Missing play-by-play is missing evidence, not a zero-valued signal. The old
  // fallback emitted several duplicate "home field only" forecasts and gave
  // them real ensemble weight, which manufactured confidence on thin data.
  if (!home || !away) return { margin: null, total: null };
  const hx = f(home), ax = f(away);
  if (hx == null || ax == null) return { margin: null, total: null };
  const raw = hx - ax;
  const cal = c.cal?.[id];
  if (cal) return { margin: cal.b0 + cal.b1 * raw, total: null };
  return { margin: raw * scale + c.hfa, total: null };
}

/* ------------------------------------------------------------- fit + eval */

/** Margin-dependent Elo run forward over history. */
function meloRatings(hist, k = 20) {
  const r = new Map();
  const get = t => r.get(t) ?? 1500;
  for (const g of hist) {
    const m = g.home_score - g.away_score;
    const exp = 1 / (1 + 10 ** ((get(g.away) - get(g.home) - 55) / 400));
    const actual = m > 0 ? 1 : m < 0 ? 0 : 0.5;
    // Blowouts should move ratings more than a field goal does.
    const mov = Math.log(Math.abs(m) + 1) * 0.85;
    const delta = k * mov * (actual - exp);
    r.set(g.home, get(g.home) + delta);
    r.set(g.away, get(g.away) - delta);
  }
  return r;
}

/** Simple OLS of actual margin on the (negated) closing spread. */
function marketRegression(hist) {
  const xs = hist.map(g => -g.home_spread), ys = hist.map(g => g.home_score - g.away_score);
  if (xs.length < 50) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b1 = den ? num / den : 1;
  return { b0: my - b1 * mx, b1 };
}

/**
 * Every opponent each team has actually played in `hist` (games strictly
 * earlier than the target decision) -- the schedule data `opp_adjusted`
 * below needs to genuinely adjust for strength of schedule, rather than
 * silently reducing to unadjusted net EPA the way it did before the Codex
 * audit's M13 finding.
 */
function scheduleFaced(hist, { season, week } = {}) {
  const m = new Map();
  const add = (t, opp) => { if (!m.has(t)) m.set(t, []); m.get(t).push(opp); };

  // Codex correction C04: this used to consume EVERY game in `hist`, while the
  // EPA features it is adjusting come from `featureAggregates`, which spans
  // only the current season's earlier weeks plus the immediately previous one.
  // Opponent EXPOSURE therefore ran over a decade while opponent QUALITY ran
  // over two seasons, and the adjustment mixed them.
  //
  // The audit measured what that costs: adding 2016 schedule rows moved the
  // isolated 2024 component from -23.400 to +16.714 with the 2024 features
  // completely unchanged. A team's 2016 opponents were being counted as
  // exposure, then priced with 2024 defensive efficiency.
  //
  // The window below is the SAME one featureAggregates uses. Both must move
  // together; narrowing only one of them reintroduces the mismatch pointing
  // the other way.
  const eligible = Number.isFinite(season) && Number.isFinite(week)
    ? hist.filter(g => (g.season === season ? g.week < week : g.season === season - 1))
    : hist;
  for (const g of eligible) { add(g.home, g.away); add(g.away, g.home); }
  return m;
}

/**
 * How much schedule a team actually has inside the eligible window.
 *
 * C04 asks for the sparse-coverage fallback to be DEFINED and REPORTED rather
 * than left implicit. Week 1 of a season with no prior-season rows genuinely
 * has zero opponents, and the honest answer there is the league average, not a
 * confident adjustment computed from one game.
 */
const MIN_OPPONENTS_FOR_ADJUSTMENT = 3;


const RESIDUAL_FIT_FRACTION = 0.7;

/**
 * Where to cut the residual sequence, on a COMPLETE-WEEK boundary.
 *
 * Codex correction C07: `Math.floor(length * 0.7)` cuts at a row index, which
 * lands in the middle of a Sunday slate roughly six times out of seven. The
 * games either side of that cut share a week of common information -- the same
 * market state, the same injury cycle, the same weather -- so a score block
 * containing half of a week whose other half trained the slope is not out of
 * fold in any meaningful sense.
 *
 * This walks forward to the first index at which the week CHANGES, so every
 * week lands entirely on one side. It returns 0 -- no split at all -- when
 * there is no honest boundary to find, rather than inventing one: a single
 * week's worth of rows cannot be divided into a fit block and an out-of-fold
 * score block, and pretending otherwise is the defect.
 */
export function completeWeekSplit(weekKeys) {
  if (weekKeys.length < 2) return 0;
  const target = Math.floor(weekKeys.length * RESIDUAL_FIT_FRACTION);
  let index = target;
  while (index < weekKeys.length && weekKeys[index] === weekKeys[target]) index++;
  if (index >= weekKeys.length) {
    // The target week runs to the end of the sequence: fall back to the start
    // of that week instead, so the score block is never empty.
    index = target;
    while (index > 0 && weekKeys[index - 1] === weekKeys[target]) index--;
  }
  return index > 0 && index < weekKeys.length ? index : 0;
}

/**
 * Internals exposed for the chronology tests that Codex corrections C04 and
 * C07 close with. They are pure functions over their arguments; exporting them
 * lets a fixture assert the window and the split boundary directly, rather
 * than inferring them from a fitted artifact.
 */
export const __testables = { scheduleFaced, completeWeekSplit, massey, MASSEY_RIDGE_LAMBDA,
  weatherSensitivity, weatherAdjustment, FLAT_WEATHER_POINTS, DEFAULT_OFF_PLAYS, weatherDeviationCap };

/** Builds the context object every model reads, from games strictly earlier. */
const _sharedContextCache = new Map();
function sharedContext(g, hist) {
  const key = `${g.season}|${g.week}|${hist.length}`;
  if (_sharedContextCache.has(key)) return _sharedContextCache.get(key);
  const agg = teamAggregates(hist);
  const recent = new Map();
  for (const [t, a] of agg) recent.set(t, a.margins);
  const shared = {
    hfa: 2 * (avg(hist.map(x => (x.home_score - x.away_score) / 2)) ?? 1.1),
    agg, recent, schedule: scheduleFaced(hist, { season: g.season, week: g.week }),
    massey: massey(hist), colley: colley(hist), melo: meloRatings(hist), dynamic: dynamicStrength(hist),
    feat: featureAggregates(g.season, g.week),
    // Per-offense dome/cold/wind response, shrunk toward the league mean.
    weather: weatherSensitivity(g.season, g.week),
    // Injury availability. The forecasting model has never had this — seventeen
    // thousand injury rows sat in a table nfl-ensemble.js never referenced.
    avail: availabilityDeficit(g.season, g.week),
    // Preseason roster quality is the opening prior; settled weekly snaps and
    // player efficiency gradually update it. Missing depth charts abstain.
    roster: rosterStrengthWeek(g.season, g.week),
    reg: marketRegression(hist)
  };
  _sharedContextCache.set(key, shared);
  return shared;
}

/** A neutral-site game has a nominal home team and no home field: every model reads `hfa` from here. */
const hfaFor = (g, shared) => (g.neutral_site ? 0 : shared.hfa);

function buildContext(g, hist, restMap) {
  const shared = sharedContext(g, hist);
  return {
    ...shared,
    hfa: hfaFor(g, shared), neutral: Boolean(g.neutral_site),
    home: g.home, away: g.away,
    spread: g.home_spread, total: g.total,
    openSpread: g.open_spread, openTotal: g.open_total,
    temp: g.temp, wind: g.wind, roof: g.roof, div: g.div_game,
    homeRest: g.home_rest, awayRest: restMap.get(`${g.season}|${g.week}|${g.away}`)
  };
}

/**
 * Fits each feature-differential model's conversion from its raw differential
 * to points, on games that finish before the evaluation window opens.
 *
 * Guessing that "one unit of EPA differential is worth 65 points" is exactly
 * the kind of constant that should be measured. Calibration runs strictly on
 * the pre-evaluation era, so no game used to fit a slope is ever also used to
 * grade it.
 */
function calibrate(all, restMap, evalFrom) {
  const train = all.filter(g => g.season < evalFrom);
  const ids = ['epa_net', 'epa_neutral', 'early_down_eff', 'pass_eff_matchup', 'rush_eff_matchup',
    'explosive_pass', 'pressure_response', 'series_sustain', 'field_position', 'second_half_eff',
    'success_rate', 'explosive', 'drive_eff', 'situational', 'trenches'];
  // Availability is calibrated separately because its raw differential comes
  // from the injury report rather than the play-by-play feature table, and it
  // is only available from 2023 on.
  const availPairs = [];
  const pairs = Object.fromEntries(ids.map(i => [i, []]));

  const weeks = [...new Set(train.map(g => `${g.season}|${g.week}`))];
  for (const key of weeks) {
    const [season, week] = key.split('|').map(Number);
    const hist = train.filter(g => g.season < season || (g.season === season && g.week < week));
    if (hist.length < 100) continue;
    const slate = train.filter(g => g.season === season && g.week === week);
    if (!slate.length) continue;
    const feat = featureAggregates(season, week);
    if (!feat.size) continue;   // play-by-play features do not reach back forever

    for (const g of slate) {
      const actual = g.home_score - g.away_score;
      const raw = rawDifferentials(feat, g.home, g.away);
      for (const id of ids) if (raw[id] != null) pairs[id].push([raw[id], actual]);
      const def = availabilityDeficit(season, week);
      if (def.size) {
        const hd = def.get(String(g.home).toUpperCase()) ?? 0;
        const ad = def.get(String(g.away).toUpperCase()) ?? 0;
        if (hd || ad) availPairs.push([ad - hd, actual]);
      }
    }
  }

  const fitLine = p => {
    if (p.length < 100) return null;
    const xs = p.map(x => x[0]), ys = p.map(x => x[1]);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    if (den <= 0) return null;
    const b1 = num / den;
    return { b0: my - b1 * mx, b1, n: p.length };
  };

  const out = {};
  for (const id of ids) {
    const f = fitLine(pairs[id]);
    if (f) out[id] = f;
  }
  const availFit = fitLine(availPairs);
  if (availFit) out.availability = availFit;

  // Rest differential, fitted on the same era. The replay found short-week
  // games were the largest systematic miss, so how much a day of rest is
  // actually worth should be measured rather than picked.
  const restRows = rows(`SELECT h.season, h.week, h.team, h.rest_days AS home_rest,
                                a.rest_days AS away_rest,
                                h.team_score - h.opp_score AS margin
                         FROM game_lines h
                         JOIN game_lines a ON a.season = h.season AND a.week = h.week
                                          AND a.team = h.opponent AND a.home = 0
                         WHERE h.home = 1 AND h.season < ? AND h.season >= ?
                           AND h.team_score IS NOT NULL
                           AND h.rest_days IS NOT NULL AND a.rest_days IS NOT NULL`,
                        evalFrom, MIN_SEASON);
  const restPairs = restRows.map(r => [r.home_rest - r.away_rest, r.margin]);
  const restFit = fitLine(restPairs);
  if (restFit) out.rest = restFit;

  return out;
}

/** The raw (uncalibrated) differential each feature model is built on. */
function rawDifferentials(feat, home, away) {
  const h = feat.get(home), a = feat.get(away);
  if (!h || !a) return {};
  const d = f => {
    const x = f(h), y = f(a);
    return x == null || y == null ? null : x - y;
  };
  return {
    epa_net: d(f => f.net_epa),
    epa_neutral: d(f => (f.off_epa_nwp ?? 0) - (f.def_epa_nwp ?? 0)),
    early_down_eff: d(f => netFeature(f, 'off_early_epa', 'def_early_epa')),
    pass_eff_matchup: d(f => netFeature(f, 'off_pass_epa', 'def_pass_epa')),
    rush_eff_matchup: d(f => netFeature(f, 'off_rush_epa', 'def_rush_epa')),
    explosive_pass: d(f => netFeature(f, 'off_expl_pass', 'def_expl_pass')),
    pressure_response: d(f => netFeature(f, 'off_pressure_epa', 'def_pressure_epa')),
    series_sustain: d(f => netFeature(f, 'off_series_sr', 'def_series_sr')),
    field_position: d(f => netFeature(f, 'off_drive_start', 'def_drive_start')),
    second_half_eff: d(f => netFeature(f, 'off_second_half_epa', 'def_second_half_epa')),
    success_rate: d(f => (f.off_sr ?? 0) - (f.def_sr ?? 0)),
    explosive: d(f => (f.off_expl ?? 0) - (f.def_expl ?? 0)),
    drive_eff: d(f => (f.off_dsr ?? 0) - (f.def_dsr ?? 0)),
    situational: d(f => ((f.off_3rd ?? 0) - (f.def_3rd ?? 0)) + ((f.off_rz ?? 0) - (f.def_rz ?? 0))),
    trenches: d(f => ((f.def_sack ?? 0) - (f.off_sack ?? 0)) + ((f.def_havoc ?? 0) * 0.5))
  };
}

const _cache = new Map();
const _calibrationCache = new Map();
const _lineCache = new Map();
let _artifactPersistenceEnabled = true;
export function clearEnsembleLineCache() { _lineCache.clear(); }
/** Invalidate in-process fits after new games land while retaining the immutable fit ledger. */
export function invalidateEnsembleCaches() {
  _cache.clear(); _calibrationCache.clear(); _lineCache.clear();
  _featureAggregateCache.clear(); _sharedContextCache.clear();
  _weatherSensitivityCache.clear();
}
export function clearEnsembleCache() {
  invalidateEnsembleCaches();
  run('DELETE FROM nfl_ensemble_fit_artifacts');
}

/**
 * Compute a sealed replay from frozen inputs without reading or writing the
 * persistent fit cache. The in-process caches remain available for repeated
 * calls inside one opened week, then are discarded at the boundary.
 */
export function withEphemeralEnsembleArtifacts(operation) {
  if (typeof operation !== 'function') throw new TypeError('ephemeral ensemble scope requires an operation');
  const prior = _artifactPersistenceEnabled;
  invalidateEnsembleCaches();
  _artifactPersistenceEnabled = false;
  try {
    return operation();
  } finally {
    _artifactPersistenceEnabled = prior;
    invalidateEnsembleCaches();
  }
}

function fitDataFingerprint() {
  const g = rows(`SELECT COUNT(*) games,COALESCE(SUM(team_score+opp_score),0) score_sum,
      COALESCE(MAX(season*100+week),0) latest_week FROM game_lines
      WHERE home=1 AND season>=? AND team_score IS NOT NULL AND opp_score IS NOT NULL AND spread IS NOT NULL`, MIN_SEASON)[0];
  const f = rows(`SELECT COUNT(*) feature_rows,COALESCE(MAX(season*100+week),0) latest_feature_week,
      COALESCE(SUM(LENGTH(features)),0) feature_bytes FROM nfl_team_week_features`)[0];
  return `${g.games}:${g.score_sum}:${g.latest_week}:${f.feature_rows}:${f.latest_feature_week}:${f.feature_bytes}`;
}

function fitArtifactKey(evalFrom, cutoffKey, weighting, fingerprint, includeChallengers) {
  const inputMode = includeChallengers ? 'all-inputs' : 'champion-inputs';
  return `${FIT_ARTIFACT_VERSION}|${evalFrom}|${cutoffKey}|${weighting}|${inputMode}|${fingerprint}`;
}

/**
 * Which games are in the weight-fitting window, which are scoreable at all,
 * and in what chronological order the replay must visit their weeks.
 *
 * Shared by the prediction stream and by `fitEnsemble`'s reported window
 * sizes, so the definition of "eligible" exists once.
 */
function replayWindows({ all, beforeSeason = null, beforeWeek = null }) {
  // Weight fitting is part of the model, not part of grading. A historical
  // prediction must therefore derive its weights only from games that were final
  // before that prediction. The old global fit used 2022-2025 outcomes even while
  // replaying 2022, which made the component forecasts walk-forward but the
  // ensemble itself look ahead.
  const eligible = all.filter(g => g.season >= WEIGHT_FIT_FROM && (
    beforeSeason == null || g.season < beforeSeason ||
    (g.season === beforeSeason && g.week < (beforeWeek ?? 1))
  ));
  // Residual skill can be evaluated before the newer raw-margin weighting
  // window.  Restrict it to prior games at the same cutoff, but do not throw
  // away the 2015–2021 observations when replaying an early evaluation season.
  const residualEligible = all.filter(g => g.season >= MIN_SEASON + 2 && (
    beforeSeason == null || g.season < beforeSeason ||
    (g.season === beforeSeason && g.week < (beforeWeek ?? 1))
  ));
  const rawWeightKeys = new Set(eligible.map(g => `${g.season}|${g.week}|${g.home}`));
  const scoreGames = [...new Map([...eligible, ...residualEligible]
    .map(g => [`${g.season}|${g.week}|${g.home}`, g])).values()];
  // CORRECTED 2026-09-10 (Codex audit finding M05): the residual-skill gate
  // downstream needs its slope FIT on strictly earlier games than the ones it
  // is GRADED on -- that requires the replay to actually visit weeks in
  // chronological order. The old `[...new Set(...)]` derived its order from
  // Map insertion order of two concatenated, overlapping-but-not-identical
  // eligibility windows, which is not reliably chronological. An explicit
  // sort makes every component's residual arrays land in true (season, week)
  // order, which the split downstream depends on.
  const weeks = [...new Set(scoreGames.map(g => `${g.season}|${g.week}`))]
    .sort((a, b) => { const [sa, wa] = a.split('|').map(Number), [sb, wb] = b.split('|').map(Number); return sa - sb || wa - wb; });
  return { eligible, scoreGames, rawWeightKeys, weeks };
}

/**
 * Every component's walk-forward forecast for every scoreable game, in
 * chronological order.
 *
 * This is now the one place the cutoff-safe replay loop lives. `fitEnsemble`
 * consumes it to grade components and derive weights; the component-rank
 * diagnostic in nfl-ensemble-rank.js consumes the same stream to measure how
 * much of that forecast set is independent information. Two separate loops
 * would drift, and a diagnostic answering "how many independent signals does
 * this ensemble actually have" is only meaningful if it saw exactly the
 * forecasts the ensemble saw, under the same cutoff, calibration and
 * abstention rules.
 *
 * A component that abstained yields `null`, never zero — abstention is missing
 * evidence, and treating it as a number is the specific mistake the
 * feature-differential models in this file were already corrected for.
 *
 * Extracted from fitEnsemble 2026-09-12 with no behavioural change; the fitted
 * artifact it produces on a fixed fixture is byte-identical before and after,
 * which is what test/nfl-ensemble-rank.test.js pins.
 */
export function* componentPredictionStream({ all, restMap, cal, beforeSeason = null, beforeWeek = null } = {}) {
  const { rawWeightKeys, scoreGames, weeks } = replayWindows({ all, beforeSeason, beforeWeek });

  for (const key of weeks) {
    const [season, week] = key.split('|').map(Number);
    const hist = all.filter(g => g.season < season || (g.season === season && g.week < week));
    if (hist.length < 100) continue;
    const slate = scoreGames.filter(g => g.season === season && g.week === week);
    if (!slate.length) continue;

    // One context per week; only the two team names differ between its games.
    const base = { ...buildContext(slate[0], hist, restMap), cal };
    // CORRECTED 2026-09-12 sweep item 12: `base.hfa` is `slate[0]`'s OWN
    // per-game value (buildContext already zeroed it via hfaFor when
    // slate[0] itself is a neutral-site game), not the week's raw home-field
    // constant. Re-deriving every other game's hfa from `base.hfa` therefore
    // silently zeroed home-field advantage for every OTHER game in a week
    // whenever the week's first-sorted game happened to be the neutral one --
    // confirmed against real 2015+ history: this fires for all 13 real
    // non-neutral games sharing 2022 week 11 with the neutral ARI game (sorted
    // first that week), and for the live 2026 week 1 SEA game sharing its
    // week with the neutral LAR game. `sharedContext` is cached by
    // `season|week|hist.length`, so this is a cache hit for every game after
    // the first and costs nothing extra.
    const rawHfa = sharedContext(slate[0], hist).hfa;

    for (const g of slate) {
      const ctx = { ...base, home: g.home, away: g.away,
        hfa: g.neutral_site ? 0 : rawHfa, neutral: Boolean(g.neutral_site),
        spread: g.home_spread, total: g.total,
        openSpread: g.open_spread, openTotal: g.open_total,
        temp: g.temp, wind: g.wind, roof: g.roof, div: g.div_game,
        homeRest: g.home_rest, awayRest: restMap.get(`${g.season}|${g.week}|${g.away}`) };
      const margins = {}, totals = {};
      for (const m of MODELS) {
        let p; try { p = m.predict(ctx); } catch { continue; }
        margins[m.id] = p?.margin != null && Number.isFinite(p.margin) ? p.margin : null;
        totals[m.id] = p?.total != null && Number.isFinite(p.total) ? p.total : null;
      }
      yield {
        season, week, week_key: key, home: g.home, away: g.away,
        market_margin: g.home_spread == null ? null : -g.home_spread,
        market_total: g.total ?? null,
        actual_margin: g.home_score - g.away_score,
        actual_total: g.home_score + g.away_score,
        in_raw_weight_window: rawWeightKeys.has(`${g.season}|${g.week}|${g.home}`),
        margins, totals
      };
    }
  }
}

/**
 * The inputs `componentPredictionStream` needs, assembled exactly the way
 * `fitEnsemble` assembles them, so a diagnostic replays identical forecasts
 * without restating the cutoff and calibration rules.
 */
export function ensembleReplayInputs({ evalFrom = EVAL_FROM, beforeSeason = null, minSeason = MIN_SEASON } = {}) {
  const all = games(minSeason);
  const restMap = awayRest();
  // Calibration is part of the fitted model; its training era must end before
  // the prediction, exactly as in fitEnsemble.
  const calibrationCutoff = beforeSeason == null ? evalFrom : Math.min(evalFrom, beforeSeason);
  const calibrationKey = `${calibrationCutoff}|${all.length}`;
  const cal = _calibrationCache.get(calibrationKey) ?? calibrate(all, restMap, calibrationCutoff);
  _calibrationCache.set(calibrationKey, cal);
  return { all, restMap, cal };
}

/** The component catalog, so a diagnostic can label every column it measures. */
export function componentIds() {
  return MODELS.map(m => ({
    id: m.id, name: m.name, family: m.family, challenger_only: m.challengerOnly === true
  }));
}

/* ------------------------------------------------------- joint raw-blend fit */

/**
 * How many multiples of the design's own scale to try when choosing the ridge
 * strength in `chooseRawBlendLambda`. Expressed as multipliers rather than raw
 * point-scale numbers so the same grid works whether a walk-forward window
 * holds two hundred rows or twenty thousand: the chosen multiplier is scaled
 * by trace(X'X)/k, the average per-component sum of squares, which is the
 * same unit the ridge penalty competes against on the diagonal of the normal
 * equations.
 */
const RAW_BLEND_RIDGE_GRID = [0.02, 0.05, 0.15, 0.5, 1.5, 5, 15, 50];

/** Below this many rows a k-parameter joint fit is not attempted at all. */
const RAW_BLEND_MIN_ROWS = 30;

/** `X'X` and `X'y` for a plain (no-intercept) linear design. */
function jointNormalEquations(X, y) {
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const row = X[i];
    for (let a = 0; a < k; a++) {
      Xty[a] += row[a] * y[i];
      for (let b = a; b < k; b++) XtX[a][b] += row[a] * row[b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  return { XtX, Xty };
}

/**
 * theta = (X'X + lambda*I)^-1 X'y -- the same closed form `massey()` uses
 * above, ridge added to the diagonal and solved by the same Gaussian
 * elimination (`solve`, defined near the top of this file). Unlike massey's
 * design there is no null space to pin here: the components are not a
 * paired-comparison system, and lambda > 0 alone makes the matrix positive
 * definite whether or not the columns are collinear.
 */
function jointRidgeCoefficients(XtX, Xty, lambda) {
  const A = XtX.map((row, i) => row.map((v, j) => (i === j ? v + lambda : v)));
  return solve(A, Xty);
}

/**
 * Choose the ridge strength with a single chronological holdout inside the
 * fitting window itself, using the same complete-week boundary
 * `completeWeekSplit` already gives the residual slope a few dozen lines
 * below: an earlier block picks among the grid, a later, disjoint block
 * scores the choice.
 *
 * This is not a claim of rigorously cross-validated regularisation -- it is
 * one split, not a rolling k-fold, for the same reason the residual slope
 * above only gets one split (see the M05 comment above `scored`): a rolling
 * scheme means re-solving a k-parameter ridge system before every scored
 * game, which is a lot of linear algebra to spend on a knob this coarse.
 * When the window is too small to hold anything out, or every candidate
 * produces a non-finite fit, the grid's own middle value is used rather than
 * either extreme -- a moderate default, not a tuned one.
 */
function chooseRawBlendLambda(X, y, weekKeys, grid) {
  const scaleOf = XtX => {
    const k = XtX.length;
    let trace = 0;
    for (let i = 0; i < k; i++) trace += XtX[i][i];
    return k && trace > 0 ? trace / k : 1;
  };
  const fallback = () => scaleOf(jointNormalEquations(X, y).XtX) * grid[Math.floor(grid.length / 2)];

  const splitIdx = completeWeekSplit(weekKeys);
  if (!splitIdx) return fallback();
  const fitX = X.slice(0, splitIdx), fitY = y.slice(0, splitIdx);
  const scoreX = X.slice(splitIdx), scoreY = y.slice(splitIdx);
  if (fitX.length < RAW_BLEND_MIN_ROWS || !scoreX.length) return fallback();

  const { XtX, Xty } = jointNormalEquations(fitX, fitY);
  const scale = scaleOf(XtX);
  let bestLambda = null, bestRmse = Infinity;
  for (const mult of grid) {
    const lambda = mult * scale;
    const beta = jointRidgeCoefficients(XtX, Xty, lambda);
    if (!beta.every(Number.isFinite)) continue;
    let sq = 0;
    for (let i = 0; i < scoreX.length; i++) {
      let pred = 0;
      for (let j = 0; j < beta.length; j++) pred += scoreX[i][j] * beta[j];
      sq += (pred - scoreY[i]) ** 2;
    }
    const rmse = Math.sqrt(sq / scoreX.length);
    if (rmse < bestRmse) { bestRmse = rmse; bestLambda = lambda; }
  }
  return bestLambda ?? scale * grid[Math.floor(grid.length / 2)];
}

/**
 * The raw blend's actual weighting mechanism: a genuine joint regression of
 * the realised outcome on every eligible component's own prediction,
 * simultaneously, instead of the old `rawWeight`'s exp(-0.7 * standalone
 * RMSE) per component in isolation.
 *
 * WHY THE OLD FORMULA WAS WRONG. Each component's weight depended only on its
 * own walk-forward RMSE against the outcome, never on how it related to any
 * OTHER component. Two consequences followed mechanically, not as edge
 * cases: a component two RMSE points worse than the market still kept
 * exp(-0.7*2) ~= 25% of a perfect component's relative weight, because
 * nothing in the formula could push a consistently-worse signal toward zero
 * once its own RMSE stopped changing; and two components that both mostly
 * restate the market (market_anchor, market_regression) were each scored and
 * weighted as though they were independent evidence, double-counting the one
 * opinion they actually share. Measured against real history this raw blend
 * ran ~1.2-1.4 RMSE points WORSE than the market it was built from across two
 * full audits (n=138 and n=153) -- structurally so, since no per-component
 * formula can ever discount a component for being redundant with another
 * one. A joint fit prices both problems correctly: OLS on correlated columns
 * already splits credit between them, and ridge is what keeps that split
 * from becoming unstable when ~20 columns are fit on a walk-forward window
 * that is not always large relative to that count.
 *
 * MISSING VALUES: mean-imputed, per component, using only the rows in THIS
 * window -- not listwise deletion. `forecast-combination.js`'s own reduction
 * step already made the case for this: "listwise deletion over a set of
 * columns costs whatever the WORST column costs." Several components here
 * (e.g. `pace_total`) never produce a margin at all, so requiring every
 * column present on every row would gut the training set for components that
 * simply have nothing to do with the target. A component's own column mean
 * is an aggregate of games already strictly before the cutoff, so imputing
 * with it introduces no lookahead -- it is a statistic of the past, not of
 * the row being imputed. A component that NEVER produces a value for this
 * target at all (its column is entirely missing across the window) is
 * dropped from the design rather than imputed with an undefined mean, and
 * gets weight zero -- exactly what the old `!m[key]` check produced for it.
 *
 * NON-NEGATIVITY. `ensembleLine`'s blend computes
 * `sum(component_prediction * weight) / sum(weight)` -- a weighted AVERAGE of
 * the components' own point forecasts, which is only a coherent combination
 * when every weight is >= 0. (A negative weight would not "subtract" the
 * component from the blend; it would flip the sign of its prediction inside
 * the average, which nothing downstream expects and which the old formula
 * could never produce either -- `blend()` in `ensembleLine` and the replay in
 * `nfl-ensemble-rank.js` both already filter on `weight > 0`.) An
 * unconstrained ridge solution can absolutely go negative -- that is exactly
 * what a correct joint fit does to a component that is redundant with a
 * better one once both are seen together. The coefficients are therefore
 * clipped to zero and the survivors renormalised to sum to one. This is a
 * simplification of a true ridge-constrained NNLS (which would re-solve
 * under the constraint rather than clip after the fact), chosen because it
 * is one closed-form solve plus an O(k) pass rather than an iterative QP, it
 * runs once per weekly walk-forward cutoff across a full historical replay,
 * and the practical goal -- a redundant or under-performing component's
 * contribution collapses toward zero instead of merely shrinking -- is met
 * either way: clipping cannot leave a genuinely harmful component with
 * positive weight, it can only be more conservative than true NNLS about how
 * much weight the survivors receive.
 *
 * Returns a `Map` from every id in `ids` to a weight in [0, 1], the positive
 * ones summing to 1, or `null` when the window has too few rows for a
 * k-parameter fit to mean anything -- callers should treat `null` exactly
 * like an all-zero result, which is what the old formula also produced
 * whenever a window had no eligible games at all.
 */
export function jointComponentWeights(rows, ids, { key, actualKey, lambdaGrid = RAW_BLEND_RIDGE_GRID } = {}) {
  const zeroMap = () => new Map(ids.map(id => [id, 0]));
  if (!ids.length) return zeroMap();
  const usableIds = ids.filter(id => rows.some(r => Number.isFinite(r[key]?.[id])));
  if (!usableIds.length) return zeroMap();

  const validRows = rows.filter(r => Number.isFinite(r[actualKey]));
  if (validRows.length < RAW_BLEND_MIN_ROWS) return null;

  const means = new Map(usableIds.map(id => {
    const vals = validRows.map(r => r[key]?.[id]).filter(Number.isFinite);
    return [id, vals.length ? mean(vals) : 0];
  }));
  const X = validRows.map(r => usableIds.map(id => {
    const v = r[key]?.[id];
    return Number.isFinite(v) ? v : means.get(id);
  }));
  const y = validRows.map(r => r[actualKey]);
  const weekKeys = validRows.map(r => r.week_key);

  const lambda = chooseRawBlendLambda(X, y, weekKeys, lambdaGrid);
  const { XtX, Xty } = jointNormalEquations(X, y);
  const beta = jointRidgeCoefficients(XtX, Xty, lambda);
  const out = zeroMap();
  if (!beta.every(Number.isFinite)) return out;

  const positive = beta.map(b => Math.max(0, b));
  const sum = positive.reduce((s, v) => s + v, 0);
  if (!(sum > 0)) return out;
  usableIds.forEach((id, j) => out.set(id, +(positive[j] / sum).toFixed(4)));
  return out;
}

/**
 * Grades every model walk-forward and derives its weight.
 *
 * Context is rebuilt once per (season, week) rather than per game, since every
 * game in a week sees the same prior history — this is what keeps a full
 * evaluation to seconds instead of minutes.
 */
export function fitEnsemble({ evalFrom = EVAL_FROM, beforeSeason = null, beforeWeek = null,
  weighting = 'exponential', includeChallengers = false } = {}) {
  const cutoffKey = beforeSeason == null ? 'live' : `${beforeSeason}|${beforeWeek ?? 1}`;
  const inputMode = includeChallengers ? 'all-inputs' : 'champion-inputs';
  const cacheKey = `${evalFrom}|${cutoffKey}|${weighting}|${inputMode}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  const fingerprint = fitDataFingerprint();
  const artifactKey = fitArtifactKey(evalFrom, cutoffKey, weighting, fingerprint, includeChallengers);
  const artifact = _artifactPersistenceEnabled
    ? rows('SELECT result_json FROM nfl_ensemble_fit_artifacts WHERE artifact_key=?', artifactKey)[0]
    : null;
  if (artifact?.result_json) {
    try {
      const saved = JSON.parse(artifact.result_json);
      _cache.set(cacheKey, saved);
      return saved;
    } catch { /* corrupt artifacts are ignored and rebuilt below */ }
  }
  const all = games();
  if (all.length < 200) return { error: `only ${all.length} games available — sync game lines first` };
  const restMap = awayRest();

  // Calibration is part of the fitted model. For a historical prediction its
  // training era must end before the prediction, just like ensemble weights.
  // `evalFrom` normally provides that earlier boundary; min() also makes custom
  // early replays incapable of borrowing later calibration outcomes.
  const calibrationCutoff = beforeSeason == null ? evalFrom : Math.min(evalFrom, beforeSeason);
  const calibrationKey = `${calibrationCutoff}|${all.length}`;
  const cal = _calibrationCache.get(calibrationKey) ?? calibrate(all, restMap, calibrationCutoff);
  _calibrationCache.set(calibrationKey, cal);
  const errs = Object.fromEntries(MODELS.map(m => [m.id, { margin: [], total: [] }]));
  // Spread betting is not a raw-margin contest.  For every component we also
  // keep the only error that matters after a market quote exists: did its
  // departure from the market explain the eventual market residual?  These are
  // still walk-forward predictions, and are cut off at the requested game.
  const residuals = Object.fromEntries(MODELS.map(m => [m.id, { signal: [], actual: [], week: [] }]));
  // The cutoff-safe replay loop itself lives in `componentPredictionStream`
  // above, so this grading pass and the component-rank diagnostic cannot drift
  // apart. Everything about which games are eligible, in which order, and what
  // context each component sees is unchanged — only its home moved.
  const windows = replayWindows({ all, beforeSeason, beforeWeek });
  // Every raw-window game's full row of component predictions, gathered once
  // so `jointComponentWeights` below can fit its regression on exactly the
  // same walk-forward rows the per-component RMSEs (still computed just below
  // for diagnostics and for the 'equal'/'inverse_mse' alternate weighting
  // modes) are drawn from.
  const rawWindowRows = [];
  for (const row of componentPredictionStream({ all, restMap, cal, beforeSeason, beforeWeek })) {
    const { actual_margin: actualMargin, actual_total: actualTotal,
      market_margin: marketMargin, week_key: key, in_raw_weight_window: inRawWindow } = row;
    if (inRawWindow) {
      rawWindowRows.push({ margins: row.margins, totals: row.totals,
        actual_margin: actualMargin, actual_total: actualTotal, week_key: key });
    }
    for (const m of MODELS) {
      const margin = row.margins[m.id] ?? null;
      const total = row.totals[m.id] ?? null;
      if (inRawWindow && margin != null) errs[m.id].margin.push((margin - actualMargin) ** 2);
      if (margin != null && marketMargin != null) {
        residuals[m.id].signal.push(margin - marketMargin);
        residuals[m.id].actual.push(actualMargin - marketMargin);
        // Codex correction C07: the week each residual belongs to, so the
        // fit/score boundary can be placed BETWEEN weeks. A row-index split
        // cuts a Sunday slate in half roughly six times out of seven, and
        // the games either side of that cut share a week of common
        // information -- the same market state, the same injury cycle, the
        // same weather -- so the "out-of-fold" block was not out of fold.
        residuals[m.id].week.push(key);
      }
      if (inRawWindow && total != null) errs[m.id].total.push((total - actualTotal) ** 2);
    }
  }

  // Score every component on cutoff-safe held-out predictions before assigning
  // performance weights.
  //
  // CORRECTED 2026-09-10 (Codex audit finding M05): `slope` used to be fit on
  // every residual pair, and `residualMse`/`residualT`/`residual_n` were then
  // computed on those SAME pairs -- so "does this component's deviation from
  // the market explain the eventual market residual" was graded on the exact
  // rows used to choose the coefficient that explains them, which is
  // optimistic by construction, not evidence of real skill. `residuals[m.id]`
  // now arrives in true chronological order (the `weeks` sort above), so it
  // is split into an EARLIER fit block and a LATER, strictly out-of-fold
  // score block: the slope is fit only on the fit block, and every reported
  // statistic (RMSE, gain, paired t) is computed only on the score block,
  // which never contributed to the slope it is grading. This is a single
  // chronological train/test split, not a fully rolling nested walk-forward
  // (that would mean refitting the slope before every scored game) -- a
  // bounded, real fix for "fits and grades on the same rows," not a claim of
  // maximal statistical rigor.
  const scored = MODELS.map(m => {
    const mm = errs[m.id].margin, tt = errs[m.id].total;
    const rs = residuals[m.id];
    const splitIdx = completeWeekSplit(rs.week);
    const fitSignal = rs.signal.slice(0, splitIdx), fitActual = rs.actual.slice(0, splitIdx);
    const scoreSignal = rs.signal.slice(splitIdx), scoreActual = rs.actual.slice(splitIdx);
    const fitWeeks = new Set(rs.week.slice(0, splitIdx));
    const scoreWeeks = new Set(rs.week.slice(splitIdx));
    const denominator = fitSignal.reduce((s, x) => s + x * x, 0);
    // No intercept: zero incremental signal must remain exactly the market.
    const slope = denominator > 0 ? fitSignal.reduce((s, x, i) => s + x * fitActual[i], 0) / denominator : 0;
    const baselineMse = scoreActual.length ? mean(scoreActual.map(x => x ** 2)) : null;
    const residualMse = scoreActual.length ? mean(scoreActual.map((x, i) => (x - slope * scoreSignal[i]) ** 2)) : null;
    // CORRECTED 2026-09-12 (Giant Plan 7.2, FIX #2): this comparison used to be
    // an ad hoc paired t-test over per-game squared errors. That statistic
    // assumes the per-game loss differentials are independent, and here they
    // are emphatically not: every game on one Sunday slate is scored by the
    // SAME `slope`, fitted once on the earlier block and then held fixed, and
    // shares one week of market state, injury news and weather. Fourteen games
    // off one slate are far closer to one observation than to fourteen, and
    // the paired t divides by sqrt(n) using the inflated n -- so it reports a
    // statistic larger than the evidence supports, and this is the gate that
    // decides which components earn residual weight.
    //
    // Diebold-Mariano with the Harvey-Leybourne-Newbold small-sample
    // correction is the standard instrument for the question actually being
    // asked ("is forecast A more accurate than forecast B on dependent data").
    // The week is the forecast period, so each week's slate collapses to one
    // loss differential and the test runs over the series of weeks; the
    // reference is t with (weeks - 1) degrees of freedom rather than a normal.
    //
    // Worth knowing before reading the two numbers side by side: DM* reduces
    // EXACTLY to the paired t when the horizon is 1 and there is no clustering
    // (asserted in test/diebold-mariano.test.js). So the gap between
    // `residual_dm_t` and `residual_paired_t` below is not two tools
    // disagreeing -- it is a direct measurement of how much within-week
    // dependence the old statistic was spending as though it were evidence.
    const scoreWeekLabels = rs.week.slice(splitIdx);
    const modelLoss = scoreActual.map((x, i) => (x - slope * scoreSignal[i]) ** 2);
    const marketLoss = scoreActual.map(x => x ** 2);
    // horizon 1: the slate is the period, and one week's forecast does not
    // overlap the next week's information set. Clustering, not the horizon, is
    // what carries the dependence in this particular design.
    const dm = dieboldMariano(modelLoss, marketLoss, { horizon: 1, clusters: scoreWeekLabels });
    // The superseded statistic, still computed and still reported -- an audit
    // that cannot see what the old gate would have said cannot check this one.
    const legacyPaired = naivePairedT(modelLoss, marketLoss);
    const residualT = legacyPaired.ok ? legacyPaired.statistic : null;
    const marketRmse = baselineMse == null ? null : Math.sqrt(baselineMse);
    const modelRmse = residualMse == null ? null : Math.sqrt(residualMse);
    const residualGain = marketRmse == null || modelRmse == null ? null : marketRmse - modelRmse;
    return {
      id: m.id, name: m.name, family: m.family, note: m.note,
      challenger_only: m.challengerOnly === true,
      margin_rmse: mm.length ? +Math.sqrt(mean(mm)).toFixed(3) : null,
      total_rmse: tt.length ? +Math.sqrt(mean(tt)).toFixed(3) : null,
      margin_n: mm.length, total_n: tt.length,
      residual_slope: fitActual.length >= 100 ? r2(slope) : null,
      residual_rmse: residualMse == null ? null : r2(Math.sqrt(residualMse)),
      market_residual_rmse: baselineMse == null ? null : r2(Math.sqrt(baselineMse)),
      residual_rmse_gain: r2(residualGain),
      // The statistic the gate reads. Same sign convention as the paired t it
      // replaces: negative means the component beat the market.
      residual_dm_t: dm.ok ? r2(dm.statistic) : null,
      // One-sided "this component is more accurate than the market", on
      // t with (weeks - 1) df. Small p = real incremental skill.
      residual_dm_p: dm.ok ? +dm.pLess.toFixed(4) : null,
      residual_dm_df: dm.ok ? dm.df : null,
      // The sample size the test actually has (weeks), next to the one the old
      // paired t claimed (games). The ratio is the inflation that was being
      // counted as evidence.
      residual_dm_weeks: dm.ok ? dm.periods : null,
      residual_dm_ok: dm.ok,
      residual_dm_reason: dm.ok ? null : dm.reason,
      // Superseded; retained for audit continuity, never read by a gate.
      residual_paired_t: r2(residualT),
      // The size of the OUT-OF-FOLD score block, not the total pool -- this is
      // the sample size the gate below actually requires 250 of.
      residual_n: scoreActual.length,
      residual_fit_n: fitActual.length,
      // The membership manifest C07 asks to be stored: which complete weeks
      // trained the slope, and which graded it. No week may appear in both.
      residual_fit_weeks: fitWeeks.size,
      residual_score_weeks: scoreWeeks.size,
      residual_week_overlap: [...scoreWeeks].filter(w => fitWeeks.has(w)).length
    };
  });

  // Challenger status controls production authority, not whether the unified
  // engine may hear the forecast. Candidate audits set includeChallengers so
  // every raw output enters the blend with the same cutoff-safe weighting as
  // established components. The default champion remains unchanged. Every
  // weighting mode below applies this gate identically -- it is exactly the
  // old `rawWeight`'s first check, kept in one place instead of three.
  const blendEligible = m => includeChallengers || !m.challenger_only;

  if (weighting === 'equal' || weighting === 'inverse_mse') {
    // Harmless legacy paths, left exactly as they were: per-component
    // standalone weighting, still keyed only to that component's own RMSE.
    // Both remain valid `modelOptions.weighting` values elsewhere
    // (nfl-forecast-identity.js, nfl-experiments.js), but nothing in the
    // repository fits either one against real history for edge -- the
    // confirmed defect (see `jointComponentWeights`) was specifically that
    // the DEFAULT ('exponential', the fall-through below) path could never
    // concentrate weight on the market no matter what the data showed. Only
    // that path changes here.
    const rawWeight = (m, key) => {
      if (!blendEligible(m)) return 0;
      if (!m[key]) return 0;
      return weighting === 'equal' ? 1 : 1 / m[key] ** 2;
    };
    const wsum = key => scored.reduce((s, m) => s + rawWeight(m, key), 0);
    const mW = wsum('margin_rmse'), tW = wsum('total_rmse');
    for (const m of scored) {
      m.margin_weight = mW ? +(rawWeight(m, 'margin_rmse') / mW).toFixed(4) : 0;
      m.total_weight = tW ? +(rawWeight(m, 'total_rmse') / tW).toFixed(4) : 0;
    }
  } else {
    // DEFAULT ('exponential'): a genuine joint regression across every
    // eligible component's own prediction, replacing exp(-0.7 * standalone
    // RMSE) per component in isolation. See `jointComponentWeights` above for
    // the full rationale and the measured defect this fixes.
    const eligibleIds = scored.filter(blendEligible).map(m => m.id);
    const marginWeights = jointComponentWeights(rawWindowRows, eligibleIds,
      { key: 'margins', actualKey: 'actual_margin' });
    const totalWeights = jointComponentWeights(rawWindowRows, eligibleIds,
      { key: 'totals', actualKey: 'actual_total' });
    for (const m of scored) {
      m.margin_weight = blendEligible(m) ? (marginWeights?.get(m.id) ?? 0) : 0;
      m.total_weight = blendEligible(m) ? (totalWeights?.get(m.id) ?? 0) : 0;
    }
  }

  for (const m of scored) {
    // Since the M05 fix above, the slope is fit on an earlier chronological
    // block and this gain/t-statistic is graded on a later, disjoint block --
    // a real (if single-split, not fully rolling) out-of-fold test, not a
    // same-rows diagnostic. It still does not by itself grant production
    // promotion: this is one internal split within one walk-forward cutoff's
    // available history, not the repository's stronger week-clustered,
    // multi-season OOF-1 standard used elsewhere (e.g. nfl-cover-calibration.js's
    // forward gate). Excluded challengers have no weight in either
    // normalization, even when their score is strong.
    //
    // The significance leg of this gate now reads the Diebold-Mariano
    // statistic (FIX #2, above) instead of the paired t. Two changes follow
    // from that, both deliberate:
    //   - the threshold is a one-sided 5% P-VALUE rather than a fixed -1.645.
    //     -1.645 is the normal critical value; DM* is referred to t with
    //     (weeks - 1) degrees of freedom, where the 5% critical value depends
    //     on how many weeks were actually scored. Hard-coding -1.645 would
    //     quietly re-import the large-sample assumption HLN exists to remove.
    //   - a component whose DM test could not be computed at all (too few
    //     complete weeks in the score block, zero variance) fails the gate.
    //     No statistic means no evidence, which is not the same as evidence of
    //     no skill, but it is equally not grounds for production weight.
    m.residual_diagnostic_passed = m.residual_n >= 250
      && m.residual_rmse_gain >= 0.03
      && m.residual_dm_ok === true && m.residual_dm_p <= 0.05;
    m.residual_gate_passed = (includeChallengers || !m.challenger_only)
      && m.residual_diagnostic_passed;
    m.residual_weight = m.residual_gate_passed ? Math.exp(-0.7 * m.residual_rmse) : 0;
  }
  const residualWeightSum = scored.reduce((s, m) => s + m.residual_weight, 0);
  for (const m of scored) m.residual_weight = residualWeightSum
    ? +(m.residual_weight / residualWeightSum).toFixed(4) : 0;
  // SWEEP STEP 0 ITEM 3 (2026-09-12): across every fit artifact ever persisted
  // (848 artifacts / 26,288 component-cutoff rows, checked read-only against
  // real production history), residual_gate_passed has NEVER once been true.
  // That is not a property of one unlucky cutoff -- it means market_residual
  // has, in practice, always fallen through to `marketMargin` verbatim below,
  // and spread_edge has been identically 0 at every cutoff that ever shipped.
  // `residual_gate_pass_count` makes that a queryable fact of THIS cutoff's fit
  // rather than something only visible by re-deriving it from 26k stored rows,
  // and `ensembleLine`'s `is_market_identity` (below) is the per-game flag
  // downstream code and audits actually branch on.
  const residualGatePassCount = scored.filter(m => m.residual_gate_passed).length;

  const result = {
    models: scored,
    // Preserve the raw-model weighting audit separately from the longer
    // residual-only history used to establish market incremental value.
    evaluated_weeks: new Set(windows.eligible.map(g => `${g.season}|${g.week}`)).size,
    residual_evaluated_weeks: windows.weeks.length,
    games: all.length,
    calibration: cal, weighting, input_mode: inputMode,
    weight_cutoff: beforeSeason == null ? null : { season: beforeSeason, week: beforeWeek ?? 1 },
    residual_gate_pass_count: residualGatePassCount,
    // True exactly when NO component earned residual weight at this cutoff --
    // the honest, queryable version of "market_residual has no independent
    // opinion here." Independent of blendMode: this describes what the fit
    // itself has to offer, not which blend a particular caller requested.
    zero_residual_components_at_cutoff: residualGatePassCount === 0
  };
  _cache.set(cacheKey, result);
  if (_artifactPersistenceEnabled) {
    run(`INSERT INTO nfl_ensemble_fit_artifacts
      (artifact_key,model_version,data_fingerprint,cutoff,weighting,created_at,result_json)
      VALUES (?,?,?,?,?,datetime('now'),?)
      ON CONFLICT(artifact_key) DO UPDATE SET created_at=excluded.created_at,result_json=excluded.result_json`,
    artifactKey, FIT_ARTIFACT_VERSION, fingerprint, cutoffKey, weighting, JSON.stringify(result));
  }
  return result;
}

/**
 * The ensemble's line for one upcoming game: every model's own number, the
 * weighted consensus, and how much the models disagree.
 */
export function ensembleLine(season, week, home, away, {
  weighting = 'exponential', families = null, blendMode = 'raw', includeEvidence = true,
  includeChallengers = false, excludeModels = [],
  // Integration stage 1 (2026-09-12): when a caller has a frozen T-60 evidence
  // packet for this exact game, it passes the market number(s) the packet
  // actually froze here instead of letting this function read game_lines for
  // them -- see nfl-auto-picks.js's autoPickDecisionBoardForPacket and
  // nfl-t60-packet.js's resolvePacketMarketQuote. `undefined` on a field means
  // "no override, read game_lines as before"; an explicit `null` means "the
  // packet was checked and had nothing eligible" and must NOT fall back to a
  // live read for that field -- silently doing so would let the one input the
  // packet actually carries real values for quietly come from the present
  // instead of from what was frozen, defeating the whole point of a
  // packet-sourced board. `source` is a label (e.g. 'frozen_packet') recorded
  // on the result so the caller can see, per field, where each number came
  // from -- see the `market_data_source` on the returned `ensemble` object.
  marketOverride = null
} = {}) {
  const inputMode = includeChallengers ? 'all-inputs' : 'champion-inputs';
  const reliability = includeChallengers ? signalReliabilityFor(season, week)
    : { version: 'production-unchanged', multipliers: {}, adjusted: [], result: null };
  const excludedKey = [...excludeModels].sort().join(',');
  const excluded = new Set(excludeModels);
  const familyKey = families?.length ? [...new Set(families)].sort().join(',') : '*';
  // A market override changes the actual inputs to this line, so it must be
  // part of the cache key -- otherwise a live call and a packet-sourced call
  // for the identical game would collide on the same cached result, and
  // whichever ran first would silently answer for both.
  const overrideKey = marketOverride
    ? `override:${marketOverride.home_spread ?? 'null'},${marketOverride.total ?? 'null'}` : 'override:none';
  const lineKey = `${season}|${week}|${home}|${away}|${weighting}|${blendMode}|${inputMode}|reliability:${reliability.version}|exclude:${excludedKey}|families:${familyKey}|${includeEvidence ? 'evidence' : 'forecast'}|${overrideKey}`;
  // Every family ablation follows the same blend and distribution path as the
  // full model. Shared contexts and fitted artifacts remain cached below.
  if (_lineCache.has(lineKey)) return _lineCache.get(lineKey);
  // This cutoff is what makes season replay genuinely walk-forward. Live games
  // naturally use every completed game before their kickoff; historical games
  // can no longer borrow weights learned from themselves or the future.
  if (!['raw', 'market_residual'].includes(blendMode)) return { error: 'unsupported ensemble blend mode' };
  const fit = fitEnsemble({ beforeSeason: season, beforeWeek: week, weighting, includeChallengers });
  if (fit.error) return fit;

  const all = games();
  const restMap = awayRest();
  const hist = all.filter(g => g.season < season || (g.season === season && g.week < week));
  if (hist.length < 100) return { error: 'not enough history before this week' };

  // CORRECTED 2026-09-12 sweep item 11: this used to null the opener out for
  // any already-decided game (`CASE WHEN team_score IS NULL THEN open_spread
  // END`), so a call against a PAST game read a different open_spread than
  // `games()` -- fixed for exactly this discrepancy by a3e1841 -- supplies
  // for the identical row via componentPredictionStream/fitEnsemble. The
  // opener is fixed well before kickoff regardless of whether the game has
  // since finished, so hiding it here was never a look-ahead guard, only an
  // unnoticed second copy of the bug a3e1841 already fixed at `games()`.
  // market_anchor's replay-graded RMSE and its live prediction for the same
  // game now read the same number.
  const g = rows(`SELECT team AS home, opponent AS away, spread AS home_spread, total,
                         open_spread, open_total,
                         temp, wind, roof, rest_days AS home_rest, div_game, neutral_site
                  FROM game_lines WHERE season=? AND week=? AND team=? AND home=1`, season, week, home)[0]
    ?? { home, away, home_spread: null, total: null };
  // `game_context` below covers every field this query read OTHER than
  // home_spread/total: weather, rest, division and neutral-site status.
  // Nothing overrides those today (see the marketOverride doc above) -- they
  // are always this live game_lines row -- so `market_data_source` always
  // reports 'game_lines' for them, honestly, rather than only tracking the
  // two fields an override CAN reach and leaving the rest unstated.
  const marketDataSource = { home_spread: 'game_lines', total: 'game_lines', game_context: 'game_lines' };
  if (marketOverride && 'home_spread' in marketOverride) {
    g.home_spread = marketOverride.home_spread;
    marketDataSource.home_spread = marketOverride.source ?? 'frozen_packet';
  }
  if (marketOverride && 'total' in marketOverride) {
    g.total = marketOverride.total;
    marketDataSource.total = marketOverride.source ?? 'frozen_packet';
  }
  const ctx = { ...buildContext({ ...g, season, week, home, away }, hist, restMap),
    home, away, cal: fit.calibration };

  const allowedFamilies = families?.length ? new Set(families) : null;
  const perModel = [];
  for (const m of MODELS.filter(x => (!allowedFamilies || allowedFamilies.has(x.family)) && !excluded.has(x.id))) {
    let p; try { p = m.predict(ctx); } catch { p = null; }
    const w = fit.models.find(x => x.id === m.id) ?? {};
    perModel.push({
      id: m.id, name: m.name, family: m.family, note: m.note,
      challenger_only: m.challengerOnly === true,
      margin: r2(p?.margin), total: r2(p?.total),
      base_margin_weight: w.margin_weight ?? 0,
      reliability_multiplier: reliability.multipliers[m.id] ?? 1,
      margin_weight: (w.margin_weight ?? 0) * (reliability.multipliers[m.id] ?? 1),
      total_weight: w.total_weight ?? 0,
      residual_slope: w.residual_slope ?? null, residual_weight: w.residual_weight ?? 0,
      margin_rmse: w.margin_rmse ?? null, total_rmse: w.total_rmse ?? null
    });
  }

  const blend = (key, wKey) => {
    const predicted = perModel.filter(m => (includeChallengers || !m.challenger_only) && m[key] != null);
    const usable = predicted.filter(m => m[wKey] > 0);
    const wsum = usable.reduce((s, m) => s + m[wKey], 0);
    // At the beginning of the first evaluation season there are not yet enough
    // past errors to estimate weights. Equal weighting is an honest cold-start;
    // returning null would silently skip the hardest early-season games.
    return wsum > 0
      ? usable.reduce((s, m) => s + m[key] * m[wKey], 0) / wsum
      : (predicted.length ? mean(predicted.map(m => m[key])) : null);
  };
  const marginVals = perModel.filter(m => (includeChallengers || !m.challenger_only) && m.margin != null).map(m => m.margin);
  const totalVals = perModel.filter(m => (includeChallengers || !m.challenger_only) && m.total != null).map(m => m.total);
  const sd = a => (a.length > 1 ? Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2))) : null);

  const rawMargin = blend('margin', 'margin_weight');
  const total = blend('total', 'total_weight');
  const marketMargin = g.home_spread != null ? -g.home_spread : null;
  const residualModels = perModel.filter(m => (includeChallengers || !m.challenger_only) && m.margin != null && m.residual_weight > 0 && m.residual_slope != null);
  const residualWeight = residualModels.reduce((s, m) => s + m.residual_weight, 0);
  const residualMargin = marketMargin != null && residualWeight > 0
    ? marketMargin + residualModels.reduce((s, m) => s + m.residual_weight * m.residual_slope * (m.margin - marketMargin), 0) / residualWeight
    : marketMargin;
  // Only permitted components may move this research forecast away from the
  // market. The in-sample residual diagnostic is not proof of independent skill.
  // The no-signal fallback is precisely the spread.
  const margin = blendMode === 'market_residual' ? residualMargin : rawMargin;
  // SWEEP STEP 0 ITEM 3: `market_residual` returns `marketMargin` verbatim,
  // by construction, whenever no component has residual weight (see the
  // fallback in `residualMargin` above) -- this is production's blend mode
  // (nfl-auto-picks.js) and, checked read-only against real history, has been
  // true at EVERY cutoff ever fit (0 of 848 stored fit artifacts / 26,288
  // component-cutoff rows ever passed the gate). `is_market_identity` names
  // that plainly rather than leaving a caller to notice spread_edge is 0: it
  // is true only when the served forecast IS the market line by arithmetic,
  // not merely close to it because the models happened to agree with the
  // market. `raw` mode never falls back to the market this way, so it is
  // always false there even if a model's own output happens to match the line.
  const isMarketIdentity = blendMode === 'market_residual'
    && marketMargin != null && residualWeight === 0;
  const disagreementMargin = sd(marginVals);
  const distribution = predictiveDistribution(hist, { margin, total, homeSpread: g.home_spread,
    marketTotal: g.total, disagreement: disagreementMargin });
  // Historical scoring does not need the shadow replacement-value packet.
  // Keeping it lazy avoids thousands of irrelevant DB lookups during replay;
  // the live Model Room still requests and displays it by default.
  const playerAvailability = includeEvidence ? gamePlayerAvailability(season, week, home, away) : null;

  const result = {
    season, week, home, away, engine_version: nflEngineVersionFor(season, week), input_mode: inputMode,
    reliability_controller: { version: reliability.version,
      mode: includeChallengers ? 'candidate_shrink_only' : 'off', adjusted_signals: reliability.adjusted },
    ensemble: {
      // A projected spread is quoted the way a book would: negative favours home.
      projected_spread: margin == null ? null : r2(-margin),
      projected_margin: r2(margin),
      projected_total: r2(total),
      market_spread: g.home_spread ?? null,
      market_total: g.total ?? null,
      // Where market_spread/market_total (and the weather/rest/div/neutral
      // context folded into every model's ctx above) actually came from --
      // 'game_lines' unless a caller supplied marketOverride. Visible on every
      // line, live or packet-sourced, so a reader never has to guess.
      market_data_source: marketDataSource,
      spread_edge: margin != null && marketMargin != null ? r2(margin - marketMargin) : null,
      total_edge: total != null && g.total != null ? r2(total - g.total) : null,
      model_disagreement_margin: r2(disagreementMargin),
      model_disagreement_total: r2(sd(totalVals)),
      models_contributing_margin: marginVals.length,
      models_contributing_total: totalVals.length,
      confidence: confidenceFrom(sd(marginVals), margin, marketMargin),
      blend_mode: blendMode,
      // Every audit/replay run declares its blend explicitly (blend_mode,
      // above) and now also declares, honestly, whether that blend actually
      // produced a real model opinion for this game or just the market line
      // with no independent view -- see the sweep note on `isMarketIdentity`.
      is_market_identity: isMarketIdentity,
      residual_models_contributing: residualModels.length,
      distribution,
      player_availability: playerAvailability
    },
    models: perModel.sort((a, b) => b.margin_weight - a.margin_weight)
  };
  _lineCache.set(lineKey, result);
  return result;
}

/**
 * Confidence is about agreement, not edge size. A four-point disagreement with
 * the market means little if the component models are themselves scattered by six.
 */
function confidenceFrom(disagreement, margin, marketMargin) {
  if (disagreement == null || margin == null || marketMargin == null) return 'unknown';
  const edge = Math.abs(margin - marketMargin);
  if (edge < 1) return 'no edge — the models land on the market';
  const ratio = edge / disagreement;
  if (ratio >= 1.0) return 'strong — the market edge is large relative to how much the models scatter';
  if (ratio >= 0.5) return 'moderate';
  return 'weak — the models disagree among themselves more than they disagree with the market';
}

/** Ensemble lines for a whole week. */
export function ensembleWeek(season, week, options = {}) {
  const slate = rows(`SELECT team AS home, opponent AS away FROM game_lines
                      WHERE season=? AND week=? AND home=1`, season, week);
  return slate.map(g => ensembleLine(season, week, g.home, g.away, options)).filter(x => !x.error);
}

/**
 * Cutoff-safe weekly outputs for research-only signal backfills. This avoids
 * refitting the active ensemble for every historical week: challengers use the
 * same pre-evaluation calibration, prior-game context and missing-data rules,
 * while retaining zero blend weight.
 */
export function challengerSignalWeek(season, week) {
  const all = games(), restMap = awayRest();
  const hist = all.filter(game => game.season < season || (game.season === season && game.week < week));
  if (hist.length < 100) return { error: 'not enough history before this week', season, week };
  const slate = rows(`SELECT team home,opponent away,spread,total,open_spread,open_total,
      temp,wind,roof,rest_days home_rest,div_game,neutral_site
    FROM game_lines WHERE season=? AND week=? AND home=1`, season, week);
  if (!slate.length) return { version: CHALLENGER_SIGNAL_VERSION, season, week, games: [] };
  const calibrationCutoff = Math.min(EVAL_FROM, season);
  const calibrationKey = `${calibrationCutoff}|${all.length}`;
  const cal = _calibrationCache.get(calibrationKey) ?? calibrate(all, restMap, calibrationCutoff);
  _calibrationCache.set(calibrationKey, cal);
  const base = { ...buildContext({ ...slate[0], season, week }, hist, restMap), cal };
  // See the matching comment in componentPredictionStream: `base.hfa` is
  // `slate[0]`'s own zeroed-if-neutral value, not the week's raw constant.
  const rawHfa = sharedContext({ ...slate[0], season, week }, hist).hfa;
  const challengers = MODELS.filter(model => model.challengerOnly);
  return { version: CHALLENGER_SIGNAL_VERSION, season, week, games: slate.map(game => {
    const ctx = { ...base, home: game.home, away: game.away,
      hfa: game.neutral_site ? 0 : rawHfa, neutral: Boolean(game.neutral_site),
      spread: game.spread, total: game.total, openSpread: game.open_spread, openTotal: game.open_total,
      temp: game.temp, wind: game.wind, roof: game.roof, div: game.div_game,
      homeRest: game.home_rest, awayRest: restMap.get(`${season}|${week}|${game.away}`) };
    return { home: game.home, away: game.away, market_margin: game.spread == null ? null : -Number(game.spread),
      signals: challengers.map(model => {
        let prediction; try { prediction = model.predict(ctx); } catch { prediction = null; }
        return { id: model.id, projected_margin: r2(prediction?.margin), projected_total: r2(prediction?.total) };
      }) };
  }) };
}

/**
 * The exit test Giant Plan 7.5 asks this change to be judged on, as a function
 * rather than a one-off script: replay every weather-affected game with only
 * prior information, and report total-line error for the flat league constant
 * and for the per-offense wiring SIDE BY SIDE on exactly the same games.
 *
 * The split that matters is pass-heavy versus run-heavy offenses. A flat wind
 * penalty is a statement that wind costs a team that throws on seventy per
 * cent of snaps the same points it costs a team that runs the ball -- which is
 * where a single constant should be most wrong, and so where a per-team
 * response should show up first if it is worth anything. Games are bucketed by
 * the two offenses' combined pass rate over expected, measured from prior
 * weeks like everything else here.
 *
 * This reports error, it does not decide anything. A component that does not
 * lower error on held-out games has not earned its way into the blend, and the
 * numbers this returns are the evidence either way.
 */
export function weatherComponentDiagnostic({ evalFrom = EVAL_FROM, minSeason = MIN_SEASON } = {}) {
  const all = games(minSeason);
  if (all.length < 200) return { error: `only ${all.length} games available — sync game lines first` };
  const restMap = awayRest();
  const weeks = [...new Set(all.filter(g => g.season >= evalFrom).map(g => `${g.season}|${g.week}`))]
    .sort((a, b) => { const [sa, wa] = a.split('|').map(Number), [sb, wb] = b.split('|').map(Number); return sa - sb || wa - wb; });

  const rowsOut = [];
  for (const key of weeks) {
    const [season, week] = key.split('|').map(Number);
    const hist = all.filter(g => g.season < season || (g.season === season && g.week < week));
    if (hist.length < 100) continue;
    const slate = all.filter(g => g.season === season && g.week === week);
    if (!slate.length) continue;
    const base = buildContext(slate[0], hist, restMap);
    for (const g of slate) {
      if (g.total == null) continue;
      const c = { ...base, home: g.home, away: g.away,
        temp: g.temp, wind: g.wind, roof: g.roof };
      const weatherActive = isIndoors(c.roof)
        || (c.wind != null && c.wind >= WINDY_MPH) || (c.temp != null && c.temp < COLD_F);
      if (!weatherActive) continue;   // both variants are identical here by construction
      const teamTotal = t => ((c.agg.get(t)?.totals ?? []).length ? avg(c.agg.get(t).totals) : 44);
      const baseTotal = teamTotal(g.home) * 0.5 + teamTotal(g.away) * 0.5;
      const wired = weatherAdjustment(c);
      const flat = weatherAdjustment({ ...c, weather: null });
      const proe = t => c.feat.get(t)?.off_proe;
      const hp = proe(g.home), ap = proe(g.away);
      rowsOut.push({
        season, week, home: g.home, away: g.away,
        roof: g.roof, temp: g.temp, wind: g.wind,
        actual_total: g.home_score + g.away_score,
        market_total: g.total,
        wired_total: baseTotal + wired,
        flat_total: baseTotal + flat,
        combined_proe: hp == null || ap == null ? null : hp + ap
      });
    }
  }
  if (!rowsOut.length) return { error: 'no weather-affected games in the evaluation window' };

  const withProe = rowsOut.filter(r => r.combined_proe != null).sort((a, b) => a.combined_proe - b.combined_proe);
  const cut = Math.floor(withProe.length / 3);
  const buckets = {
    all: rowsOut,
    run_heavy: withProe.slice(0, cut),
    pass_heavy: withProe.slice(withProe.length - cut)
  };
  const score = list => {
    if (!list.length) return null;
    const err = (key) => list.map(r => r[key] - r.actual_total);
    const stat = e => ({
      rmse: +Math.sqrt(mean(e.map(x => x ** 2))).toFixed(4),
      mae: +mean(e.map(Math.abs)).toFixed(4),
      bias: +mean(e).toFixed(4)
    });
    const flat = stat(err('flat_total')), wired = stat(err('wired_total'));
    // Paired, because both variants forecast the very same games: the question
    // is whether the wiring helped game by game, not whether two independent
    // samples happened to differ.
    const paired = list.map(r => (r.wired_total - r.actual_total) ** 2 - (r.flat_total - r.actual_total) ** 2);
    const pm = mean(paired);
    const sd = paired.length > 1
      ? Math.sqrt(paired.reduce((s, x) => s + (x - pm) ** 2, 0) / (paired.length - 1)) : null;
    // How far the wiring actually moves a number. A change that cannot move a
    // total by much cannot help much either, and cannot do much damage -- both
    // halves of that are worth knowing before reading the error deltas.
    const shifts = list.map(r => Math.abs(r.wired_total - r.flat_total));
    return { n: list.length, flat, wired,
      rmse_delta: +(wired.rmse - flat.rmse).toFixed(4),
      mae_delta: +(wired.mae - flat.mae).toFixed(4),
      paired_t: sd > 0 ? +(pm / (sd / Math.sqrt(paired.length))).toFixed(3) : null,
      differing_games: shifts.filter(v => v > 1e-9).length,
      mean_abs_shift: +mean(shifts).toFixed(4),
      max_abs_shift: +Math.max(...shifts).toFixed(4) };
  };
  return {
    eval_from: evalFrom,
    weather_games: rowsOut.length,
    splits: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, score(v)])),
    note: 'rmse_delta/mae_delta are wired minus flat: negative means the per-offense wiring lowered error. ' +
      'paired_t is on squared error, so a negative t is the wiring helping.'
  };
}

export function modelCatalog() {
  const fit = fitEnsemble();
  return fit.error ? fit : {
    count: MODELS.length,
    evaluated_weeks: fit.evaluated_weeks,
    games: fit.games,
    weighting: fit.weighting,
    models: fit.models.map(m => ({ ...m, contract: FAMILY_CONTRACTS[m.family] }))
  };
}

/**
 * Every registered component with its family's data contract.
 *
 * Codex correction C16: this used to spread only `{ id, name, family }` plus
 * the family contract, dropping `challenger_only`. The family report reads
 * this, so it concluded that every family had ZERO challengers -- while nine
 * challenger-only components are registered. A report that cannot see nine of
 * its own inputs is not measuring what it says it is.
 *
 * `base_margin_weight` comes along for the same reason: "report actual active
 * consumers and weights", not merely which components exist.
 */
export function featureContracts() {
  return MODELS.map(m => ({ id: m.id, name: m.name, family: m.family,
    // `challengerOnly` is the registry's own spelling; `challenger_only` is
    // what every consumer downstream reads. Reading the wrong one here is how
    // the family report came to believe there were no challengers at all.
    challenger_only: m.challengerOnly === true,
    base_margin_weight: m.baseWeight ?? m.base_margin_weight ?? null,
    ...FAMILY_CONTRACTS[m.family] }));
}
