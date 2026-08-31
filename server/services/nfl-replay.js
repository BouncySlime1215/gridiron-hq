/**
 * Season replay and error analysis — the training loop.
 *
 * Replays a season week by week, betting the model's picks with only the
 * information available at the time, grades every result, then looks for where
 * it went wrong.
 *
 * The important design decision is *how* it looks for mistakes. The tempting
 * version — open each loss, find something that would have called it, add that
 * variable, repeat — does not work. With 328 variables and roughly 270 games a
 * season, something always "explains" any single miss, and what the model
 * learns is that season's noise. It would grade beautifully on the data used to
 * build it and lose money on the next one.
 *
 * So this looks only for *systematic* error: segments of games (favourites,
 * road teams, windy games, short weeks, high totals) where the model is biased
 * across many games rather than unlucky in one. A segment only counts when it
 * holds over enough games to not be chance, and `validateAdjustment` re-tests
 * any correction on seasons it was not discovered on. A fix that only works on
 * the season that suggested it is reported as exactly that — rejected.
 */
import { db, rows, run } from '../db/index.js';
import { fitEnsemble, ensembleLine } from './nfl-ensemble.js';
import { mean, quantile, random, withRandomSeed } from './stats-util.js';
import { NFL_PRODUCTION_POLICY, applyNflPolicy, normalizeNflPolicy } from './nfl-policy.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_replay_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, label TEXT, created_at TEXT NOT NULL,
    bets INTEGER, wins INTEGER, losses INTEGER, pushes INTEGER,
    units REAL, roi REAL, config TEXT
  );
  CREATE TABLE IF NOT EXISTS nfl_replay_bets (
    run_id INTEGER NOT NULL, season INTEGER, week INTEGER,
    home TEXT, away TEXT, market TEXT, side TEXT, line REAL,
    model_margin REAL, market_margin REAL, edge REAL, disagreement REAL,
    actual_margin REAL, actual_total REAL,
    result TEXT, units REAL,
    PRIMARY KEY (run_id, season, week, home, market)
  );
  CREATE TABLE IF NOT EXISTS nfl_policy_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id TEXT NOT NULL, policy_version TEXT NOT NULL,
    seasons_json TEXT NOT NULL, created_at TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_candidate_input_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL, seasons_json TEXT NOT NULL,
    created_at TEXT NOT NULL, result_json TEXT NOT NULL
  );
`);

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export function uncertainty(bets) {
  const settled = bets.filter(b => b.result === 'Won' || b.result === 'Lost');
  const clusters = new Map();
  for (const b of bets) {
    const key = `${b.season}-${b.week}`;
    const group = clusters.get(key) ?? [];
    group.push(b); clusters.set(key, group);
  }
  const weeks = [...clusters.values()];
  const draws = [];
  if (weeks.length) withRandomSeed(20260804, () => {
    for (let trial = 0; trial < 4000; trial++) {
      const sample = [];
      for (let i = 0; i < weeks.length; i++) sample.push(...weeks[Math.floor(random() * weeks.length)]);
      const graded = sample.filter(b => b.result === 'Won' || b.result === 'Lost');
      const wins = graded.filter(b => b.result === 'Won').length;
      draws.push({ roi: sample.length ? mean(sample.map(b => b.units)) : 0, winRate: graded.length ? wins / graded.length : 0 });
    }
  });
  const rois = draws.map(x => x.roi), winRates = draws.map(x => x.winRate);
  return {
    method: 'deterministic weekly-cluster bootstrap',
    clusters: weeks.length,
    trials: draws.length,
    win_rate_95: draws.length ? [r2(quantile(winRates, 0.025)), r2(quantile(winRates, 0.975))] : [null, null],
    roi_95: draws.length ? [r2(quantile(rois, 0.025)), r2(quantile(rois, 0.975))] : [null, null],
    probability_roi_above_zero: draws.length ? r2(rois.filter(x => x > 0).length / draws.length) : null,
    sample_warning: settled.length < 100
      ? 'Very small sample: results are dominated by variance.'
      : settled.length < 500 ? 'Moderate sample: treat profitability as provisional until the interval clears zero.' : null
  };
}

/** Settle at the stored historical price. Missing prices never reach this path. */
const unitsFor = (won, pushed, price) => {
  if (pushed) return 0;
  if (!won) return -1;
  return price > 0 ? price / 100 : 100 / Math.abs(price);
};

/**
 * Replays one season. For each week, the ensemble is asked for a line using
 * only prior games, a bet is placed when the edge clears `minEdge`, and the
 * result is graded against what actually happened.
 */
export function replaySeason(season, {
  minEdge = NFL_PRODUCTION_POLICY.minEdge,
  // Skip games where the component models disagree with each other by more than
  // this. The 4.5-point guard and 3-point edge floor were frozen using only
  // 2018-2020 before the 2021-2025 evaluation window was opened.
  maxDisagreement = NFL_PRODUCTION_POLICY.maxDisagreement,
  markets = NFL_PRODUCTION_POLICY.markets,
  maxPicksPerWeek = NFL_PRODUCTION_POLICY.maxPicksPerWeek,
  startWeek = 1,
  endWeek = 22,
  modelOptions = {},
  label = null
} = {}) {
  const slate = rows(`
    SELECT gl.season, gl.week, gl.team AS home, gl.opponent AS away,
           gl.team_score AS home_score, gl.opp_score AS away_score,
           gl.spread AS home_spread, gl.total,
           gl.spread_odds AS home_spread_odds,
           away.spread_odds AS away_spread_odds,
           gl.total_over_odds, gl.total_under_odds,
           gl.source, gl.fetched_at
    FROM game_lines gl
    LEFT JOIN game_lines away ON away.season=gl.season AND away.week=gl.week AND away.team=gl.opponent
    WHERE gl.season = ? AND gl.week BETWEEN ? AND ?
      AND gl.home = 1 AND gl.team_score IS NOT NULL AND gl.spread IS NOT NULL
    ORDER BY gl.week
  `, season, startWeek, endWeek);
  if (!slate.length) return { error: `no completed games stored for ${season}` };

  const bets = [], decisions = [];
  // Historical replay grades the policy that was actually live at the time.
  // It intentionally does not apply today's calibration gate retroactively:
  // that would turn a losing audit into an artificial zero-bet backtest.
  const policy = normalizeNflPolicy({ minEdge, maxDisagreement, markets, maxPicksPerWeek,
    requireCalibratedAdvantage: false });
  let currentWeek = null, weekly = [];
  const commitWeek = () => {
    if (!weekly.length) return;
    const judged = applyNflPolicy(weekly, policy);
    decisions.push(...judged.decisions);
    bets.push(...judged.selected.map(b => ({ ...b, units: unitsFor(b.won, b.pushed, b.american_price) })));
    weekly = [];
  };
  for (const g of slate) {
    if (currentWeek != null && g.week !== currentWeek) commitWeek();
    currentWeek = g.week;
    const line = ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions });
    if (line.error) continue;
    const e = line.ensemble;

    const actualMargin = g.home_score - g.away_score;
    const actualTotal = g.home_score + g.away_score;

    if (markets.includes('spread') && e.projected_margin != null && g.home_spread != null) {
      const marketMargin = -g.home_spread;
      const edge = e.projected_margin - marketMargin;
      const backHome = edge > 0;
      const covered = backHome
        ? actualMargin + g.home_spread > 0
        : actualMargin + g.home_spread < 0;
      const pushed = actualMargin + g.home_spread === 0;
      weekly.push({
          season, week: g.week, home: g.home, away: g.away, market: 'spread',
          side: backHome ? `${g.home} ${fmtLine(g.home_spread)}` : `${g.away} ${fmtLine(-g.home_spread)}`,
          line: backHome ? g.home_spread : -g.home_spread,
          american_price: backHome ? g.home_spread_odds : g.away_spread_odds,
          opposite_price: backHome ? g.away_spread_odds : g.home_spread_odds,
          model_margin: e.projected_margin, market_margin: marketMargin,
          edge: r2(edge), edge_points: Math.abs(edge), disagreement: e.model_disagreement_margin,
          actual_margin: actualMargin, actual_total: actualTotal,
          result: pushed ? 'Push' : covered ? 'Won' : 'Lost',
          won: covered, pushed, book: g.source ?? null, quote_source: g.source ?? null, quote_at: g.fetched_at ?? null,
          feature_snapshot: {
            margin_models_active: e.models_contributing_margin ?? null,
            predictive_distribution: e.distribution ?? null
          }
        });
    }

    if (markets.includes('total') && e.projected_total != null && g.total != null) {
      const edge = e.projected_total - g.total;
      const over = edge > 0;
      const won = over ? actualTotal > g.total : actualTotal < g.total;
      const pushed = actualTotal === g.total;
      weekly.push({
          season, week: g.week, home: g.home, away: g.away, market: 'total',
          side: `${over ? 'Over' : 'Under'} ${g.total}`, line: g.total,
          american_price: over ? g.total_over_odds : g.total_under_odds,
          model_margin: e.projected_total, market_margin: g.total,
          edge: r2(edge), edge_points: Math.abs(edge), disagreement: e.model_disagreement_total,
          actual_margin: actualMargin, actual_total: actualTotal,
          result: pushed ? 'Push' : won ? 'Won' : 'Lost',
          won, pushed, book: g.source ?? null, quote_source: g.source ?? null, quote_at: g.fetched_at ?? null,
          feature_snapshot: { total_models_active: e.models_contributing_total ?? null }
        });
    }
  }
  commitWeek();

  const wins = bets.filter(b => b.result === 'Won').length;
  const losses = bets.filter(b => b.result === 'Lost').length;
  const pushes = bets.filter(b => b.result === 'Push').length;
  const units = bets.reduce((s, b) => s + b.units, 0);
  const averageBreakEven = avg(bets.filter(b => b.american_price != null).map(b => {
    const p = b.american_price;
    return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
  }));

  const summary = {
    season, label, bets: bets.length, wins, losses, pushes,
    win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
    units: r2(units),
    roi: bets.length ? r2(units / bets.length) : null,
    // Historical payouts use each stored price; there is no synthetic -110.
    break_even_needed: r2(averageBreakEven),
    beat_vig: bets.length ? units > 0 : null,
    config: { policy, modelOptions, startWeek, endWeek },
    decision_audit: {
      candidates: decisions.length,
      selected: bets.length,
      abstentions: Object.fromEntries([...new Set(decisions.filter(d => !d.eligible).map(d => d.abstention_reason))]
        .map(reason => [reason, decisions.filter(d => d.abstention_reason === reason).length]))
    },
    uncertainty: uncertainty(bets)
  };
  return { summary, bets, decisions };
}

const fmtLine = v => (v > 0 ? `+${v}` : `${v}`);

/** Persists a replay so runs can be compared over time. */
export function saveReplay(result) {
  const s = result.summary;
  run(`INSERT INTO nfl_replay_runs (season, label, created_at, bets, wins, losses, pushes, units, roi, config)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    s.season, s.label, new Date().toISOString(), s.bets, s.wins, s.losses, s.pushes,
    s.units, s.roi, JSON.stringify(s.config));
  const id = rows('SELECT last_insert_rowid() AS id')[0].id;
  for (const b of result.bets) {
    run(`INSERT INTO nfl_replay_bets
        (run_id, season, week, home, away, market, side, line, model_margin, market_margin,
         edge, disagreement, actual_margin, actual_total, result, units)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT DO NOTHING`,
      id, b.season, b.week, b.home, b.away, b.market, b.side, b.line,
      b.model_margin, b.market_margin, b.edge, b.disagreement,
      b.actual_margin, b.actual_total, b.result, b.units);
  }
  return id;
}

/* ------------------------------------------------------- error analysis */

/**
 * Buckets a bet into the segments worth checking for systematic bias.
 * Each is a hypothesis about *when* the model might be wrong, not about any
 * individual game.
 */
function segmentsFor(b, ctx) {
  const segs = [];
  segs.push(['market', b.market]);
  if (b.market === 'spread') {
    segs.push(['side', b.side.includes(b.home) ? 'backed home' : 'backed away']);
    segs.push(['role', b.line < 0 ? 'home favoured' : 'home underdog']);
    segs.push(['spread size', Math.abs(b.line) >= 7 ? 'big spread (7+)' : Math.abs(b.line) <= 3 ? 'short spread (<=3)' : 'mid spread']);
  } else {
    segs.push(['side', /Over/.test(b.side) ? 'took over' : 'took under']);
    segs.push(['total size', b.line >= 48 ? 'high total (48+)' : b.line <= 41 ? 'low total (<=41)' : 'mid total']);
  }
  segs.push(['edge size', Math.abs(b.edge) >= 4 ? 'large edge (4+)' : 'small edge (<4)']);
  segs.push(['model agreement',
    (b.disagreement ?? 0) <= 3.5 ? 'models agree' : (b.disagreement ?? 0) >= 5.5 ? 'models scatter' : 'mixed']);
  segs.push(['part of season', b.week <= 6 ? 'early (wk 1-6)' : b.week >= 14 ? 'late (wk 14+)' : 'mid']);
  const c = ctx.get(`${b.season}|${b.week}|${b.home}`);
  if (c) {
    if (c.roof) segs.push(['venue', c.roof === 'dome' || c.roof === 'closed' ? 'indoors' : 'outdoors']);
    if (c.wind != null) segs.push(['wind', c.wind >= 15 ? 'windy (15+ mph)' : 'calm']);
    if (c.temp != null) segs.push(['temperature', c.temp < 32 ? 'freezing' : 'mild']);
    if (c.rest_days != null) segs.push(['rest', c.rest_days <= 6 ? 'short week' : c.rest_days >= 10 ? 'off a bye' : 'normal week']);
    if (c.div_game != null) segs.push(['divisional', c.div_game === 1 ? 'divisional' : 'non-divisional']);
  }
  return segs;
}

/**
 * Finds segments where the model is systematically wrong.
 *
 * `minBets` is the guard that keeps this from being noise-chasing: a 2-8 stretch
 * in freezing games is not evidence of anything. Segments are reported with
 * their sample size so a thin one is visibly thin, and the bias direction is
 * given as average signed error so the fix is legible.
 */
export function analyzeErrors(bets, { minBets = 25 } = {}) {
  const ctx = new Map();
  for (const r of rows(`SELECT season, week, team, roof, wind, temp, rest_days, div_game
                        FROM game_lines WHERE home = 1`)) {
    ctx.set(`${r.season}|${r.week}|${r.team}`, r);
  }

  const buckets = new Map();
  for (const b of bets) {
    if (b.result === 'Push') continue;
    for (const [dim, val] of segmentsFor(b, ctx)) {
      const key = `${dim}|${val}`;
      const e = buckets.get(key) ?? { dim, val, n: 0, wins: 0, units: 0, signed: [], breakEven: [] };
      e.n++;
      if (b.result === 'Won') e.wins++;
      e.units += b.units;
      if (b.american_price != null) e.breakEven.push(b.american_price > 0
        ? 100 / (b.american_price + 100) : Math.abs(b.american_price) / (Math.abs(b.american_price) + 100));
      // Signed model error: positive means the model was too high on its side.
      e.signed.push(b.market === 'spread'
        ? b.model_margin - b.actual_margin
        : b.model_margin - b.actual_total);
      buckets.set(key, e);
    }
  }

  const out = [];
  for (const e of buckets.values()) {
    if (e.n < minBets) continue;
    const winRate = e.wins / e.n;
    const breakEven = avg(e.breakEven) ?? 0.524;
    out.push({
      dimension: e.dim, segment: e.val, bets: e.n,
      win_rate: r2(winRate), units: r2(e.units),
      roi: r2(e.units / e.n),
      mean_signed_error: r2(avg(e.signed)),
      break_even_needed: r2(breakEven),
      beats_vig: e.units > 0,
      // How far from break-even, in standard errors — the honest test of whether
      // a segment is a real bias or just a run of results.
      z: r2((winRate - breakEven) / Math.sqrt(breakEven * (1 - breakEven) / e.n))
    });
  }
  out.sort((a, b) => a.win_rate - b.win_rate);

  const weakest = out.filter(s => s.win_rate < 0.5 && Math.abs(s.z) >= 1.5);
  const strongest = out.filter(s => s.win_rate > 0.55 && s.z >= 1.5);

  return {
    segments: out,
    weakest, strongest,
    note: weakest.length
      ? 'Segments below break-even by more than 1.5 standard errors are candidates for a correction — but any correction must be validated on a season it was not found on.'
      : 'No segment is reliably below break-even at this sample size. Differences here are consistent with chance, and "fixing" them would be fitting noise.'
  };
}

/**
 * Tests a proposed correction honestly.
 *
 * The adjustment is discovered on `discoverySeasons` and applied on
 * `holdoutSeasons`. If it only helps where it was found, it was noise — and
 * this says so rather than reporting the flattering number.
 */
export function validateAdjustment({ discoverySeasons, holdoutSeasons, adjust, config = {} }) {
  // Replays are deterministic, so each season is run once and the adjustment is
  // applied to the same bets — otherwise this replays every season four times.
  const cache = new Map();
  const betsFor = seasons => seasons.flatMap(s => {
    if (!cache.has(s)) {
      const r = replaySeason(s, config);
      cache.set(s, r.error ? [] : r.bets);
    }
    return cache.get(s);
  });

  const score = list => {
    const w = list.filter(b => b.result === 'Won').length;
    const l = list.filter(b => b.result === 'Lost').length;
    const u = list.reduce((s, b) => s + b.units, 0);
    return {
      bets: list.length, wins: w, losses: l,
      win_rate: w + l ? r2(w / (w + l)) : null,
      units: r2(u), roi: list.length ? r2(u / list.length) : null,
      uncertainty: uncertainty(list)
    };
  };

  const discBets = betsFor(discoverySeasons);
  const holdBets = betsFor(holdoutSeasons);
  const discBase = score(discBets);
  const discAdj = score(discBets.map(adjust).filter(Boolean));
  const holdBase = score(holdBets);
  const holdAdj = score(holdBets.map(adjust).filter(Boolean));

  const helpedDiscovery = (discAdj.roi ?? -9) > (discBase.roi ?? -9);
  const helpedHoldout = (holdAdj.roi ?? -9) > (holdBase.roi ?? -9);

  return {
    discovery: { seasons: discoverySeasons, before: discBase, after: discAdj },
    holdout: { seasons: holdoutSeasons, before: holdBase, after: holdAdj },
    helped_discovery: helpedDiscovery,
    helped_holdout: helpedHoldout,
    verdict: helpedDiscovery && helpedHoldout
      ? 'Keep — the correction helped on seasons it was not derived from.'
      : helpedDiscovery && !helpedHoldout
        ? 'Reject — it only helps on the data that suggested it. This is overfitting, and shipping it would make the model worse on new games.'
        : !helpedDiscovery && helpedHoldout
          ? 'Inconclusive — it helps out of sample but not in sample, which usually means the sample is too small to tell.'
          : 'Reject — it does not help anywhere.'
  };
}

/**
 * One full training iteration: replay, grade, look for systematic bias, and
 * report what is worth acting on.
 */
export function trainingIteration(seasons, config = {}) {
  const perSeason = [];
  const allBets = [];
  for (const s of seasons) {
    const r = replaySeason(s, config);
    if (r.error) { perSeason.push({ season: s, error: r.error }); continue; }
    perSeason.push(r.summary);
    allBets.push(...r.bets);
  }
  const analysis = analyzeErrors(allBets, { minBets: config.minBets ?? 25 });

  const wins = allBets.filter(b => b.result === 'Won').length;
  const losses = allBets.filter(b => b.result === 'Lost').length;
  const units = allBets.reduce((s, b) => s + b.units, 0);
  let cumulative = 0;
  const byWeek = new Map();
  for (const b of allBets) {
    const key = `${b.season}-${String(b.week).padStart(2, '0')}`;
    byWeek.set(key, (byWeek.get(key) ?? 0) + b.units);
  }
  const equityCurve = [...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([week, weekUnits]) => ({
    week, week_units: r2(weekUnits), cumulative_units: r2(cumulative += weekUnits)
  }));

  return {
    seasons, config,
    policy: perSeason.find(x => x.config?.policy)?.config.policy ?? normalizeNflPolicy(config),
    overall: {
      bets: allBets.length, wins, losses,
      win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
      units: r2(units), roi: allBets.length ? r2(units / allBets.length) : null,
      break_even_needed: r2(avg(allBets.filter(b => b.american_price != null).map(b => {
        const p = b.american_price;
        return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
      }))),
      beat_vig: allBets.length ? units > 0 : null,
      uncertainty: uncertainty(allBets)
    },
    equity_curve: equityCurve,
    per_season: perSeason,
    analysis
  };
}

export function saveTrainingAudit(result) {
  const policy = result.policy ?? normalizeNflPolicy(result.config ?? {});
  run(`INSERT INTO nfl_policy_audits
    (policy_id,policy_version,seasons_json,created_at,result_json) VALUES (?,?,?,?,?)`,
    policy.id, policy.version, JSON.stringify(result.seasons), new Date().toISOString(), JSON.stringify(result));
  return latestTrainingAudit();
}

export function latestTrainingAudit() {
  const r = rows('SELECT * FROM nfl_policy_audits ORDER BY id DESC LIMIT 1')[0];
  if (!r) return null;
  return {
    id: r.id, policy_id: r.policy_id, policy_version: r.policy_version,
    seasons: JSON.parse(r.seasons_json), created_at: r.created_at,
    result: JSON.parse(r.result_json)
  };
}

/**
 * Development comparison for the unified all-inputs engine. This is not the
 * sealed blind audit and cannot promote itself. Both sides use identical
 * policy, seasons and chronological cutoffs; only challenger input visibility
 * changes.
 */
export function candidateInputComparison(seasons = [2022, 2023, 2024, 2025], config = {}) {
  const shared = { ...config, minBets: config.minBets ?? 30 };
  const baseline = trainingIteration(seasons, { ...shared, label: 'champion-inputs', modelOptions: {} });
  const combined = trainingIteration(seasons, {
    ...shared, label: 'all-inputs', modelOptions: { includeChallengers: true }
  });
  const b = baseline.overall, c = combined.overall;
  const earlierSeasons = [2021].filter(season => !seasons.includes(season));
  const earlierBaseline = earlierSeasons.length ? trainingIteration(earlierSeasons,
    { ...shared, label: 'champion-inputs-pre-feature', modelOptions: {} }) : null;
  const earlierCombined = earlierSeasons.length ? trainingIteration(earlierSeasons,
    { ...shared, label: 'all-inputs-pre-feature', modelOptions: { includeChallengers: true } }) : null;
  const join = (current, earlier) => {
    if (!earlier) return current;
    const bets = current.bets + earlier.bets;
    const wins = current.wins + earlier.wins, losses = current.losses + earlier.losses;
    const units = current.units + earlier.units;
    return { seasons: [...earlierSeasons, ...seasons], bets, wins, losses,
      win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
      units: r2(units), roi: bets ? r2(units / bets) : null,
      note: 'Descriptive full-window total. The advanced inputs begin in 2022; 2021 is retained so the supported-era result cannot hide the cold-start failure.' };
  };
  const result = {
    candidate_id: 'unified-all-inputs-v3-isolated-roster',
    candidate_inputs: 9,
    evidence_class: 'chronological development replay; not sealed forward proof',
    seasons,
    baseline: { overall: b, per_season: baseline.per_season },
    combined: { overall: c, per_season: combined.per_season },
    full_window_context: {
      baseline: join(b, earlierBaseline?.overall), combined: join(c, earlierCombined?.overall)
    },
    delta: {
      bets: c.bets - b.bets,
      win_rate: r2((c.win_rate ?? 0) - (b.win_rate ?? 0)),
      units: r2(c.units - b.units),
      roi: r2((c.roi ?? 0) - (b.roi ?? 0))
    }
  };
  const lowerRoi = c.uncertainty?.roi_95?.[0];
  result.promotion_gate_passed = c.beat_vig === true && lowerRoi != null && lowerRoi > 0;
  result.verdict = result.promotion_gate_passed
    ? 'Eligible for a separately preregistered forward audit; not automatically promoted.'
    : c.beat_vig
      ? 'Promising development lift, but uncertainty still crosses zero. Keep all inputs visible and withhold bankroll authority.'
      : 'Rejected for bankroll authority: the combined engine did not beat the stored prices.';
  return result;
}

export function saveCandidateInputAudit(result) {
  run(`INSERT INTO nfl_candidate_input_audits
    (candidate_id,seasons_json,created_at,result_json) VALUES (?,?,?,?)`,
  result.candidate_id, JSON.stringify(result.seasons), new Date().toISOString(), JSON.stringify(result));
  return latestCandidateInputAudit();
}

export function latestCandidateInputAudit() {
  const audit = rows('SELECT * FROM nfl_candidate_input_audits ORDER BY id DESC LIMIT 1')[0];
  if (!audit) return null;
  return { id: audit.id, candidate_id: audit.candidate_id,
    seasons: JSON.parse(audit.seasons_json), created_at: audit.created_at,
    result: JSON.parse(audit.result_json) };
}
