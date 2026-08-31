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
import { db, rows, run } from '../db/index.js';
import { availabilityDeficit } from './nfl-availability.js';
import { teamWeeks } from './nfl-pbp.js';
import { mean } from './stats-util.js';
import { gamePlayerAvailability } from './nfl-player-value.js';
import { nflEngineVersionFor } from './nfl-engine-registry.js';
import { rosterStrengthWeek } from './nfl-roster-strength.js';
import { signalReliabilityFor } from './nfl-signal-reliability.js';

const MIN_SEASON = 2015;   // far enough back for stable fits, recent enough to be the modern game
const EVAL_FROM = 2022;    // frozen calibration boundary retained for the established ensemble
const WEIGHT_FIT_FROM = 2018; // discovery history available before the opened 2021-2025 audit
const FIT_ARTIFACT_VERSION = 'nfl-ensemble-fit-v7-consistent-historical-market';
export const CHALLENGER_SIGNAL_VERSION = 'nfl-challenger-signals-v2';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_ensemble_fit_artifacts (
  artifact_key TEXT PRIMARY KEY, model_version TEXT NOT NULL,
  data_fingerprint TEXT NOT NULL, cutoff TEXT NOT NULL,
  weighting TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL
)`);

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
           NULL AS open_spread, NULL AS open_total,
           temp, wind, roof, rest_days AS home_rest, div_game
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

/** Massey: least-squares ratings that best explain observed margins. */
function massey(hist) {
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
  // Ratings are only identified up to a constant, so pin the mean at zero.
  for (let k = 0; k < n; k++) A[n - 1][k] = 1;
  b[n - 1] = 0;
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
 * Empirical predictive distribution around the point forecast. Residual shape
 * comes only from games completed before the target week. Similar spread/total
 * environments are preferred when at least 120 prior games exist.
 */
function predictiveDistribution(hist, { margin, total, homeSpread, marketTotal, disagreement }) {
  if (margin == null) return null;
  const all = hist.filter(x => x.home_spread != null).map(x => ({
    spread: x.home_spread, total: x.total,
    margin_residual: (x.home_score - x.away_score) - (-x.home_spread),
    total_residual: x.total == null ? null : (x.home_score + x.away_score) - x.total
  }));
  let conditional = all.filter(x => homeSpread != null && Math.abs(Math.abs(x.spread) - Math.abs(homeSpread)) <= 2.5 &&
    (marketTotal == null || x.total == null || Math.abs(x.total - marketTotal) <= 6));
  const cohort = conditional.length >= 120 ? conditional : all;
  if (cohort.length < 100) return null;
  const marginResiduals = cohort.map(x => x.margin_residual);
  const residualMedian = quantile(marginResiduals, 0.5) ?? 0;
  const inflation = 1 + Math.min(0.25, Math.max(0, disagreement ?? 0) / 30);
  const marginSamples = marginResiduals.map(x => Math.round(margin + (x - residualMedian) * inflation));
  const grade = marginSamples.map(x => homeSpread == null ? null : Math.sign(x + homeSpread));
  const totalResiduals = cohort.map(x => x.total_residual).filter(Number.isFinite);
  const totalMedian = quantile(totalResiduals, 0.5) ?? 0;
  const totalSamples = total == null ? [] : totalResiduals.map(x => Math.round(total + (x - totalMedian)));
  const q = values => ({
    p10: r2(quantile(values, 0.10)), p25: r2(quantile(values, 0.25)),
    p50: r2(quantile(values, 0.50)), p75: r2(quantile(values, 0.75)), p90: r2(quantile(values, 0.90))
  });
  return {
    method: 'cutoff-safe empirical market-residual distribution with disagreement inflation',
    sample_size: cohort.length, conditional_cohort: conditional.length >= 120,
    margin_quantiles: q(marginSamples), total_quantiles: totalSamples.length ? q(totalSamples) : null,
    home_cover_probability: homeSpread == null ? null : r2(grade.filter(x => x > 0).length / grade.length),
    away_cover_probability: homeSpread == null ? null : r2(grade.filter(x => x < 0).length / grade.length),
    push_probability: homeSpread == null ? null : r2(grade.filter(x => x === 0).length / grade.length),
    margin_interval_80: [r2(quantile(marginSamples, 0.1)), r2(quantile(marginSamples, 0.9))],
    margin_interval_50: [r2(quantile(marginSamples, 0.25)), r2(quantile(marginSamples, 0.75))],
    uncertainty_width_80: r2(quantile(marginSamples, 0.9) - quantile(marginSamples, 0.1)),
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
    note: 'Efficiency corrected for the quality of defences and offences faced.',
    predict: (c) => {
      if (!c.feat.has(c.home) || !c.feat.has(c.away)) return { margin: null, total: null };
      const league = avg([...c.feat.values()].map(f => f.off_epa).filter(v => v != null)) ?? 0;
      const adj = t => {
        const f = c.feat.get(t); if (!f) return 0;
        return ((f.off_epa ?? league) - league) - ((f.def_epa ?? league) - league);
      };
      return { margin: (adj(c.home) - adj(c.away)) * 65 + c.hfa, total: null };
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
    id: 'rest_travel', name: 'Rest and situation', family: 'Context',
    note: 'Home field, rest differential and divisional familiarity. The rest coefficient is fitted, not assumed — replay analysis found short-week games were the single largest systematic error.',
    predict: (c) => {
      // Replaying 2022-2025 showed short-week games losing at 40% (z = -3.4),
      // which said the hand-picked 0.18 points per rest day was wrong. The
      // coefficient is now fitted on the pre-evaluation era like every other
      // scale in this file.
      const restDiff = (c.homeRest ?? 7) - (c.awayRest ?? 7);
      const f = c.cal?.rest;
      const restEdge = f ? f.b1 * restDiff : restDiff * 0.18;
      const divPenalty = c.div === 1 ? -0.4 : 0; // familiarity compresses margins
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
    note: 'Scoring environment adjusted for wind, cold and roof.',
    predict: (c) => {
      const base = ((c.agg.get(c.home)?.totals ?? []).length
        ? avg(c.agg.get(c.home).totals) : 44)
        * 0.5 + ((c.agg.get(c.away)?.totals ?? []).length
        ? avg(c.agg.get(c.away).totals) : 44) * 0.5;
      let adj = 0;
      if (c.roof === 'dome' || c.roof === 'closed') adj += 1.2;
      if (c.wind != null && c.wind >= 15) adj -= 2.4;
      if (c.temp != null && c.temp < 32) adj -= 1.6;
      return { margin: null, total: base + adj };
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
    agg, recent,
    massey: massey(hist), colley: colley(hist), melo: meloRatings(hist), dynamic: dynamicStrength(hist),
    feat: featureAggregates(g.season, g.week),
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

function buildContext(g, hist, restMap) {
  return {
    ...sharedContext(g, hist),
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
export function clearEnsembleLineCache() { _lineCache.clear(); }
/** Invalidate in-process fits after new games land while retaining the immutable fit ledger. */
export function invalidateEnsembleCaches() {
  _cache.clear(); _calibrationCache.clear(); _lineCache.clear();
  _featureAggregateCache.clear(); _sharedContextCache.clear();
}
export function clearEnsembleCache() {
  invalidateEnsembleCaches();
  run('DELETE FROM nfl_ensemble_fit_artifacts');
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
  const artifact = rows('SELECT result_json FROM nfl_ensemble_fit_artifacts WHERE artifact_key=?', artifactKey)[0];
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
  const residuals = Object.fromEntries(MODELS.map(m => [m.id, { signal: [], actual: [] }]));
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
  const weeks = [...new Set(scoreGames.map(g => `${g.season}|${g.week}`))];

  for (const key of weeks) {
    const [season, week] = key.split('|').map(Number);
    const hist = all.filter(g => g.season < season || (g.season === season && g.week < week));
    if (hist.length < 100) continue;
    const slate = scoreGames.filter(g => g.season === season && g.week === week);
    if (!slate.length) continue;

    // One context per week; only the two team names differ between its games.
    const base = { ...buildContext(slate[0], hist, restMap), cal };

    for (const g of slate) {
      const ctx = { ...base, home: g.home, away: g.away,
        spread: g.home_spread, total: g.total,
        openSpread: g.open_spread, openTotal: g.open_total,
        temp: g.temp, wind: g.wind, roof: g.roof, div: g.div_game,
        homeRest: g.home_rest, awayRest: restMap.get(`${g.season}|${g.week}|${g.away}`) };
      const actualMargin = g.home_score - g.away_score;
      const actualTotal = g.home_score + g.away_score;
      for (const m of MODELS) {
        let p; try { p = m.predict(ctx); } catch { continue; }
        if (rawWeightKeys.has(`${g.season}|${g.week}|${g.home}`) && p?.margin != null && Number.isFinite(p.margin)) {
          errs[m.id].margin.push((p.margin - actualMargin) ** 2);
        }
        const marketMargin = g.home_spread == null ? null : -g.home_spread;
        if (p?.margin != null && marketMargin != null && Number.isFinite(p.margin)) {
          residuals[m.id].signal.push(p.margin - marketMargin);
          residuals[m.id].actual.push(actualMargin - marketMargin);
        }
        if (rawWeightKeys.has(`${g.season}|${g.week}|${g.home}`) && p?.total != null && Number.isFinite(p.total)) {
          errs[m.id].total.push((p.total - actualTotal) ** 2);
        }
      }
    }
  }

  // Score every component on cutoff-safe held-out predictions before assigning
  // performance weights.
  const scored = MODELS.map(m => {
    const mm = errs[m.id].margin, tt = errs[m.id].total;
    const rs = residuals[m.id];
    const denominator = rs.signal.reduce((s, x) => s + x * x, 0);
    // No intercept: zero incremental signal must remain exactly the market.
    const slope = denominator > 0 ? rs.signal.reduce((s, x, i) => s + x * rs.actual[i], 0) / denominator : 0;
    const baselineMse = rs.actual.length ? mean(rs.actual.map(x => x ** 2)) : null;
    const residualMse = rs.actual.length ? mean(rs.actual.map((x, i) => (x - slope * rs.signal[i]) ** 2)) : null;
    const paired = rs.actual.map((x, i) => (x - slope * rs.signal[i]) ** 2 - x ** 2);
    const pairedMean = paired.length ? mean(paired) : null;
    const pairedSd = paired.length > 1
      ? Math.sqrt(paired.reduce((sum, x) => sum + (x - pairedMean) ** 2, 0) / (paired.length - 1)) : null;
    const residualT = pairedSd > 0 ? pairedMean / (pairedSd / Math.sqrt(paired.length)) : null;
    const marketRmse = baselineMse == null ? null : Math.sqrt(baselineMse);
    const modelRmse = residualMse == null ? null : Math.sqrt(residualMse);
    const residualGain = marketRmse == null || modelRmse == null ? null : marketRmse - modelRmse;
    return {
      id: m.id, name: m.name, family: m.family, note: m.note,
      challenger_only: m.challengerOnly === true,
      margin_rmse: mm.length ? +Math.sqrt(mean(mm)).toFixed(3) : null,
      total_rmse: tt.length ? +Math.sqrt(mean(tt)).toFixed(3) : null,
      margin_n: mm.length, total_n: tt.length,
      residual_slope: rs.actual.length >= 100 ? r2(slope) : null,
      residual_rmse: residualMse == null ? null : r2(Math.sqrt(residualMse)),
      market_residual_rmse: baselineMse == null ? null : r2(Math.sqrt(baselineMse)),
      residual_rmse_gain: r2(residualGain),
      residual_paired_t: r2(residualT),
      residual_n: rs.actual.length
    };
  });

  // Exponential performance weighting gives meaningfully more influence to the
  // best prior forecasts. Inverse-MSE made a weak model with 17 RMSE nearly as
  // influential as the market near 14 RMSE, so a crowd of correlated mediocre
  // models could overwhelm the strongest prior merely by being numerous.
  const rawWeight = (m, key) => {
    // Challenger status controls production authority, not whether the unified
    // engine may hear the forecast. Candidate audits set includeChallengers so
    // every raw output enters the blend with the same cutoff-safe weighting as
    // established components. The default champion remains unchanged.
    if (m.challenger_only && !includeChallengers) return 0;
    if (!m[key]) return 0;
    if (weighting === 'equal') return 1;
    if (weighting === 'inverse_mse') return 1 / m[key] ** 2;
    return Math.exp(-0.7 * m[key]);
  };
  const wsum = key => scored.reduce((s, m) => s + rawWeight(m, key), 0);
  const mW = wsum('margin_rmse'), tW = wsum('total_rmse');
  for (const m of scored) {
    m.margin_weight = mW ? +(rawWeight(m, 'margin_rmse') / mW).toFixed(4) : 0;
    m.total_weight = tW ? +(rawWeight(m, 'total_rmse') / tW).toFixed(4) : 0;
    // A microscopic in-sample inequality is not an edge. A component earns
    // residual authority only after a material gain and one-sided paired test
    // on the cutoff-safe replay. The market remains the prediction otherwise.
    m.residual_gate_passed = m.residual_n >= 250
      && m.residual_rmse_gain >= 0.03 && m.residual_paired_t <= -1.645;
    m.residual_weight = m.residual_gate_passed ? Math.exp(-0.7 * m.residual_rmse) : 0;
  }
  const residualWeightSum = scored.reduce((s, m) => s + m.residual_weight, 0);
  for (const m of scored) m.residual_weight = residualWeightSum
    ? +(m.residual_weight / residualWeightSum).toFixed(4) : 0;

  const result = {
    models: scored,
    // Preserve the raw-model weighting audit separately from the longer
    // residual-only history used to establish market incremental value.
    evaluated_weeks: new Set(eligible.map(g => `${g.season}|${g.week}`)).size,
    residual_evaluated_weeks: weeks.length,
    games: all.length,
    calibration: cal, weighting, input_mode: inputMode,
    weight_cutoff: beforeSeason == null ? null : { season: beforeSeason, week: beforeWeek ?? 1 }
  };
  _cache.set(cacheKey, result);
  run(`INSERT INTO nfl_ensemble_fit_artifacts
    (artifact_key,model_version,data_fingerprint,cutoff,weighting,created_at,result_json)
    VALUES (?,?,?,?,?,datetime('now'),?)
    ON CONFLICT(artifact_key) DO UPDATE SET created_at=excluded.created_at,result_json=excluded.result_json`,
  artifactKey, FIT_ARTIFACT_VERSION, fingerprint, cutoffKey, weighting, JSON.stringify(result));
  return result;
}

/**
 * The ensemble's line for one upcoming game: every model's own number, the
 * weighted consensus, and how much the models disagree.
 */
export function ensembleLine(season, week, home, away, {
  weighting = 'exponential', families = null, blendMode = 'raw', includeEvidence = true,
  includeChallengers = false, excludeModels = []
} = {}) {
  const inputMode = includeChallengers ? 'all-inputs' : 'champion-inputs';
  const reliability = includeChallengers ? signalReliabilityFor(season, week)
    : { version: 'production-unchanged', multipliers: {}, adjusted: [], result: null };
  const excludedKey = [...excludeModels].sort().join(',');
  const excluded = new Set(excludeModels);
  const lineKey = `${season}|${week}|${home}|${away}|${weighting}|${blendMode}|${inputMode}|reliability:${reliability.version}|exclude:${excludedKey}|${includeEvidence ? 'evidence' : 'forecast'}`;
  // Family ablations are projections of the same frozen per-model line. Build
  // that expensive context once, then re-blend only the requested families.
  // This changes no prediction and makes a nine-cut audit minutes faster.
  if (families?.length) {
    const base = _lineCache.get(lineKey) ?? ensembleLine(season, week, home, away, {
      weighting, families: null, blendMode, includeEvidence, includeChallengers, excludeModels
    });
    if (base.error) return base;
    const allowed = new Set(families);
    const perModel = base.models.filter(m => allowed.has(m.family));
    const audible = perModel.filter(m => includeChallengers || !m.challenger_only);
    const blend = (key, wKey) => {
      const predicted = audible.filter(m => m[key] != null);
      const usable = predicted.filter(m => m[wKey] > 0);
      const weightSum = usable.reduce((s, m) => s + m[wKey], 0);
      return weightSum > 0 ? usable.reduce((s, m) => s + m[key] * m[wKey], 0) / weightSum
        : predicted.length ? mean(predicted.map(m => m[key])) : null;
    };
    const sd = values => values.length > 1 ? Math.sqrt(mean(values.map(v => (v - mean(values)) ** 2))) : null;
    const marginValues = audible.filter(m => m.margin != null).map(m => m.margin);
    const totalValues = audible.filter(m => m.total != null).map(m => m.total);
    const margin = blend('margin', 'margin_weight'), total = blend('total', 'total_weight');
    const marketMargin = base.ensemble.market_spread == null ? null : -base.ensemble.market_spread;
    return { ...base, ensemble: { ...base.ensemble,
      projected_spread: margin == null ? null : r2(-margin), projected_margin: r2(margin), projected_total: r2(total),
      spread_edge: margin != null && marketMargin != null ? r2(margin - marketMargin) : null,
      total_edge: total != null && base.ensemble.market_total != null ? r2(total - base.ensemble.market_total) : null,
      model_disagreement_margin: r2(sd(marginValues)), model_disagreement_total: r2(sd(totalValues)),
      models_contributing_margin: marginValues.length, models_contributing_total: totalValues.length,
      confidence: confidenceFrom(sd(marginValues), margin, marketMargin)
    }, models: perModel };
  }
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

  const g = rows(`SELECT team AS home, opponent AS away, spread AS home_spread, total,
                         CASE WHEN team_score IS NULL THEN open_spread END AS open_spread,
                         CASE WHEN team_score IS NULL THEN open_total END AS open_total,
                         temp, wind, roof, rest_days AS home_rest, div_game
                  FROM game_lines WHERE season=? AND week=? AND team=? AND home=1`, season, week, home)[0]
    ?? { home, away, home_spread: null, total: null };
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
  const residualModels = perModel.filter(m => m.margin != null && m.residual_weight > 0 && m.residual_slope != null);
  const residualWeight = residualModels.reduce((s, m) => s + m.residual_weight, 0);
  const residualMargin = marketMargin != null && residualWeight > 0
    ? marketMargin + residualModels.reduce((s, m) => s + m.residual_weight * m.residual_slope * (m.margin - marketMargin), 0) / residualWeight
    : marketMargin;
  // The residual mode can only move away from the market with independently
  // earned residual skill.  Its no-signal fallback is precisely the spread.
  const margin = blendMode === 'market_residual' ? residualMargin : rawMargin;
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
      spread_edge: margin != null && marketMargin != null ? r2(margin - marketMargin) : null,
      total_edge: total != null && g.total != null ? r2(total - g.total) : null,
      model_disagreement_margin: r2(disagreementMargin),
      model_disagreement_total: r2(sd(totalVals)),
      models_contributing_margin: marginVals.length,
      models_contributing_total: totalVals.length,
      confidence: confidenceFrom(sd(marginVals), margin, marketMargin),
      blend_mode: blendMode,
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
      temp,wind,roof,rest_days home_rest,div_game
    FROM game_lines WHERE season=? AND week=? AND home=1`, season, week);
  if (!slate.length) return { version: CHALLENGER_SIGNAL_VERSION, season, week, games: [] };
  const calibrationCutoff = Math.min(EVAL_FROM, season);
  const calibrationKey = `${calibrationCutoff}|${all.length}`;
  const cal = _calibrationCache.get(calibrationKey) ?? calibrate(all, restMap, calibrationCutoff);
  _calibrationCache.set(calibrationKey, cal);
  const base = { ...buildContext({ ...slate[0], season, week }, hist, restMap), cal };
  const challengers = MODELS.filter(model => model.challengerOnly);
  return { version: CHALLENGER_SIGNAL_VERSION, season, week, games: slate.map(game => {
    const ctx = { ...base, home: game.home, away: game.away,
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

export function featureContracts() {
  return MODELS.map(m => ({ id: m.id, name: m.name, family: m.family, ...FAMILY_CONTRACTS[m.family] }));
}
