/**
 * Twenty independent NFL models, aggregated into one projected line.
 *
 * The single ratings model in nfl-market.js is good but it is one opinion with
 * one blind spot. This runs twenty deliberately different ones — some see only
 * wins, some only margins, some only play-level efficiency, some only the
 * market — and combines them by how well each has actually predicted, measured
 * walk-forward.
 *
 * Diversity is the point. Colley ignores margin entirely, so it disagrees with
 * Massey exactly when a team's record and point differential tell different
 * stories. Turnover-regressed margin fades the luckiest results. The market
 * anchor starts from the number the books set. When twenty models built on
 * different premises agree, that is real signal; when they scatter, the honest
 * output is low confidence, and the spread between them is reported as exactly
 * that.
 *
 * Weighting is by inverse mean squared error on held-out games, so a model that
 * predicts badly is down-weighted automatically instead of being argued about.
 * Model families follow published work — Massey and Colley least-squares
 * ratings, Pythagenport expectation, margin-dependent Elo — implemented here
 * rather than imported.
 */
import { rows } from '../db/index.js';
import { teamWeeks } from './nfl-pbp.js';
import { mean } from './stats-util.js';

const MIN_SEASON = 2015;   // far enough back for stable fits, recent enough to be the modern game
const EVAL_FROM = 2022;    // seasons graded out-of-sample (also where play-by-play features exist)

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/* --------------------------------------------------------------- game data */

/** One row per real game, chronological, with the context models need. */
function games(minSeason = MIN_SEASON) {
  return rows(`
    SELECT season, week, team AS home, opponent AS away,
           team_score AS home_score, opp_score AS away_score,
           spread AS home_spread, total, open_spread, open_total,
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

/** Per-team play-by-play feature averages before a given point. */
function featureAggregates(season, week) {
  const all = teamWeeks(season).filter(t => t.week < week);
  const byTeam = new Map();
  for (const t of all) {
    const e = byTeam.get(t.team) ?? [];
    e.push(t.features);
    byTeam.set(t.team, e);
  }
  const out = new Map();
  for (const [team, list] of byTeam) {
    const pick = k => avg(list.map(f => f[k]).filter(v => v != null));
    out.set(team, {
      net_epa: pick('net_epa_per_play'),
      off_epa: pick('off_epa_per_play'), def_epa: pick('def_epa_per_play'),
      off_epa_nwp: pick('off_epa_neutral_wp'), def_epa_nwp: pick('def_epa_neutral_wp'),
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
  return out;
}

/* ----------------------------------------------------------- the 20 models */

/**
 * Every model is a function of (context) -> { margin, total } from the home
 * team's perspective, where positive margin favours the home side. A model may
 * return null for either when it has no opinion on that quantity.
 */
const MODELS = [
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
    predict: (c) => ({ margin: c.openSpread != null ? -c.openSpread : -c.spread, total: c.openTotal ?? c.total })
  },
  {
    id: 'market_regression', name: 'Market regression', family: 'Market',
    note: 'Fitted relationship between the closing line and the margin that actually happened.',
    predict: (c) => ({
      margin: c.reg ? c.reg.b0 + c.reg.b1 * (-c.spread) : -c.spread,
      total: c.total
    })
  }
];

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
function buildContext(g, hist, restMap) {
  const agg = teamAggregates(hist);
  const recent = new Map();
  for (const [t, a] of agg) recent.set(t, a.margins);
  return {
    home: g.home, away: g.away,
    hfa: 2 * (avg(hist.map(x => (x.home_score - x.away_score) / 2)) ?? 1.1),
    spread: g.home_spread, total: g.total,
    openSpread: g.open_spread, openTotal: g.open_total,
    temp: g.temp, wind: g.wind, roof: g.roof, div: g.div_game,
    homeRest: g.home_rest, awayRest: restMap.get(`${g.season}|${g.week}|${g.away}`),
    agg, recent,
    massey: massey(hist), colley: colley(hist), melo: meloRatings(hist),
    feat: featureAggregates(g.season, g.week),
    reg: marketRegression(hist)
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
  const ids = ['epa_net', 'epa_neutral', 'success_rate', 'explosive', 'drive_eff', 'situational', 'trenches'];
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
    success_rate: d(f => (f.off_sr ?? 0) - (f.def_sr ?? 0)),
    explosive: d(f => (f.off_expl ?? 0) - (f.def_expl ?? 0)),
    drive_eff: d(f => (f.off_dsr ?? 0) - (f.def_dsr ?? 0)),
    situational: d(f => ((f.off_3rd ?? 0) - (f.def_3rd ?? 0)) + ((f.off_rz ?? 0) - (f.def_rz ?? 0))),
    trenches: d(f => ((f.def_sack ?? 0) - (f.off_sack ?? 0)) + ((f.def_havoc ?? 0) * 0.5))
  };
}

const _cache = new Map();
export function clearEnsembleCache() { _cache.clear(); }

/**
 * Grades all twenty models walk-forward and derives their weights.
 *
 * Context is rebuilt once per (season, week) rather than per game, since every
 * game in a week sees the same prior history — this is what keeps a full
 * evaluation to seconds instead of minutes.
 */
export function fitEnsemble({ evalFrom = EVAL_FROM, beforeSeason = null, beforeWeek = null } = {}) {
  const cutoffKey = beforeSeason == null ? 'live' : `${beforeSeason}|${beforeWeek ?? 1}`;
  const cacheKey = `${evalFrom}|${cutoffKey}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  const all = games();
  if (all.length < 200) return { error: `only ${all.length} games available — sync game lines first` };
  const restMap = awayRest();

  // Calibration is part of the fitted model. For a historical prediction its
  // training era must end before the prediction, just like ensemble weights.
  // `evalFrom` normally provides that earlier boundary; min() also makes custom
  // early replays incapable of borrowing later calibration outcomes.
  const calibrationCutoff = beforeSeason == null ? evalFrom : Math.min(evalFrom, beforeSeason);
  const cal = calibrate(all, restMap, calibrationCutoff);
  const errs = Object.fromEntries(MODELS.map(m => [m.id, { margin: [], total: [] }]));
  // Weight fitting is part of the model, not part of grading. A historical
  // prediction must therefore derive its weights only from games that were final
  // before that prediction. The old global fit used 2022-2025 outcomes even while
  // replaying 2022, which made the component forecasts walk-forward but the
  // ensemble itself look ahead.
  const eligible = all.filter(g => g.season >= evalFrom && (
    beforeSeason == null || g.season < beforeSeason ||
    (g.season === beforeSeason && g.week < (beforeWeek ?? 1))
  ));
  const weeks = [...new Set(eligible.map(g => `${g.season}|${g.week}`))];

  for (const key of weeks) {
    const [season, week] = key.split('|').map(Number);
    const hist = all.filter(g => g.season < season || (g.season === season && g.week < week));
    if (hist.length < 100) continue;
    const slate = all.filter(g => g.season === season && g.week === week);
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
        if (p?.margin != null && Number.isFinite(p.margin)) errs[m.id].margin.push((p.margin - actualMargin) ** 2);
        if (p?.total != null && Number.isFinite(p.total)) errs[m.id].total.push((p.total - actualTotal) ** 2);
      }
    }
  }

  // Inverse-MSE weights within each quantity, so a model that predicts badly
  // fades on its own rather than by argument.
  const scored = MODELS.map(m => {
    const mm = errs[m.id].margin, tt = errs[m.id].total;
    return {
      id: m.id, name: m.name, family: m.family, note: m.note,
      margin_rmse: mm.length ? +Math.sqrt(mean(mm)).toFixed(3) : null,
      total_rmse: tt.length ? +Math.sqrt(mean(tt)).toFixed(3) : null,
      margin_n: mm.length, total_n: tt.length
    };
  });

  // Exponential performance weighting gives meaningfully more influence to the
  // best prior forecasts. Inverse-MSE made a weak model with 17 RMSE nearly as
  // influential as the market near 14 RMSE, so a crowd of correlated mediocre
  // models could overwhelm the strongest prior merely by being numerous.
  const rawWeight = (m, key) => m[key] ? Math.exp(-0.7 * m[key]) : 0;
  const wsum = key => scored.reduce((s, m) => s + rawWeight(m, key), 0);
  const mW = wsum('margin_rmse'), tW = wsum('total_rmse');
  for (const m of scored) {
    m.margin_weight = mW ? +(rawWeight(m, 'margin_rmse') / mW).toFixed(4) : 0;
    m.total_weight = tW ? +(rawWeight(m, 'total_rmse') / tW).toFixed(4) : 0;
  }

  const result = {
    models: scored, evaluated_weeks: weeks.length, games: all.length,
    calibration: cal,
    weight_cutoff: beforeSeason == null ? null : { season: beforeSeason, week: beforeWeek ?? 1 }
  };
  _cache.set(cacheKey, result);
  return result;
}

/**
 * The ensemble's line for one upcoming game: every model's own number, the
 * weighted consensus, and how much the models disagree.
 */
export function ensembleLine(season, week, home, away) {
  // This cutoff is what makes season replay genuinely walk-forward. Live games
  // naturally use every completed game before their kickoff; historical games
  // can no longer borrow weights learned from themselves or the future.
  const fit = fitEnsemble({ beforeSeason: season, beforeWeek: week });
  if (fit.error) return fit;

  const all = games();
  const restMap = awayRest();
  const hist = all.filter(g => g.season < season || (g.season === season && g.week < week));
  if (hist.length < 100) return { error: 'not enough history before this week' };

  const g = rows(`SELECT team AS home, opponent AS away, spread AS home_spread, total,
                         open_spread, open_total, temp, wind, roof, rest_days AS home_rest, div_game
                  FROM game_lines WHERE season=? AND week=? AND team=? AND home=1`, season, week, home)[0]
    ?? { home, away, home_spread: null, total: null };
  const ctx = { ...buildContext({ ...g, season, week, home, away }, hist, restMap),
    home, away, cal: fit.calibration };

  const perModel = [];
  for (const m of MODELS) {
    let p; try { p = m.predict(ctx); } catch { p = null; }
    const w = fit.models.find(x => x.id === m.id) ?? {};
    perModel.push({
      id: m.id, name: m.name, family: m.family, note: m.note,
      margin: r2(p?.margin), total: r2(p?.total),
      margin_weight: w.margin_weight ?? 0, total_weight: w.total_weight ?? 0,
      margin_rmse: w.margin_rmse ?? null, total_rmse: w.total_rmse ?? null
    });
  }

  const blend = (key, wKey) => {
    const predicted = perModel.filter(m => m[key] != null);
    const usable = predicted.filter(m => m[wKey] > 0);
    const wsum = usable.reduce((s, m) => s + m[wKey], 0);
    // At the beginning of the first evaluation season there are not yet enough
    // past errors to estimate weights. Equal weighting is an honest cold-start;
    // returning null would silently skip the hardest early-season games.
    return wsum > 0
      ? usable.reduce((s, m) => s + m[key] * m[wKey], 0) / wsum
      : (predicted.length ? mean(predicted.map(m => m[key])) : null);
  };
  const marginVals = perModel.filter(m => m.margin != null).map(m => m.margin);
  const totalVals = perModel.filter(m => m.total != null).map(m => m.total);
  const sd = a => (a.length > 1 ? Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2))) : null);

  const margin = blend('margin', 'margin_weight');
  const total = blend('total', 'total_weight');
  const marketMargin = g.home_spread != null ? -g.home_spread : null;

  return {
    season, week, home, away,
    ensemble: {
      // A projected spread is quoted the way a book would: negative favours home.
      projected_spread: margin == null ? null : r2(-margin),
      projected_margin: r2(margin),
      projected_total: r2(total),
      market_spread: g.home_spread ?? null,
      market_total: g.total ?? null,
      spread_edge: margin != null && marketMargin != null ? r2(margin - marketMargin) : null,
      total_edge: total != null && g.total != null ? r2(total - g.total) : null,
      model_disagreement_margin: r2(sd(marginVals)),
      model_disagreement_total: r2(sd(totalVals)),
      models_contributing_margin: marginVals.length,
      models_contributing_total: totalVals.length,
      confidence: confidenceFrom(sd(marginVals), margin, marketMargin)
    },
    models: perModel.sort((a, b) => b.margin_weight - a.margin_weight)
  };
}

/**
 * Confidence is about agreement, not edge size. A four-point disagreement with
 * the market means little if the twenty models are themselves scattered by six.
 */
function confidenceFrom(disagreement, margin, marketMargin) {
  if (disagreement == null || margin == null || marketMargin == null) return 'unknown';
  const edge = Math.abs(margin - marketMargin);
  if (edge < 1) return 'no edge — the models land on the market';
  const ratio = edge / disagreement;
  if (ratio >= 1.0) return 'strong — the disagreement is large relative to how much the models scatter';
  if (ratio >= 0.5) return 'moderate';
  return 'weak — the models disagree among themselves more than they disagree with the market';
}

/** Ensemble lines for a whole week. */
export function ensembleWeek(season, week) {
  const slate = rows(`SELECT team AS home, opponent AS away FROM game_lines
                      WHERE season=? AND week=? AND home=1`, season, week);
  return slate.map(g => ensembleLine(season, week, g.home, g.away)).filter(x => !x.error);
}

export function modelCatalog() {
  const fit = fitEnsemble();
  return fit.error ? fit : {
    count: MODELS.length,
    evaluated_weeks: fit.evaluated_weeks,
    games: fit.games,
    models: fit.models
  };
}
