/**
 * Backtesting harness.
 *
 * The point of this module is to make "did that change help?" answerable. Any
 * projection source — ESPN's numbers, last year's points, our own model — is just a
 * Map of player_id to prediction, and every one is graded the same way against
 * actuals recomputed from real weekly boxscores.
 *
 * Two families of metric, because there are two kinds of forecast:
 *   point estimates → MAE, RMSE, bias, R², Spearman
 *   distributions   → CRPS and a PIT calibration curve
 *
 * CRPS is the one that matters once projections become distributions: it rewards
 * being both accurate and honestly uncertain, and it collapses to MAE when the
 * forecast is a single point, so the two families stay comparable.
 */
import { rows } from '../db/index.js';
import { PPR, scoreLine } from './scoring.js';

/* ------------------------------------------------------------------ actuals */

/**
 * What each player really scored in a season, from `player_week_usage`.
 * @returns {Map<number, {points:number, games:number, ppg:number, weeks:Map<number,number>}>}
 */
export function actuals(season, scoring = PPR) {
  const out = new Map();
  for (const u of rows('SELECT * FROM player_week_usage WHERE season = ?', season)) {
    const pts = Number(scoreLine(u, scoring));
    const cur = out.get(u.player_id) ?? { points: 0, games: 0, ppg: 0, weeks: new Map() };
    cur.points += pts;
    cur.games += 1;
    cur.weeks.set(u.week, pts);
    out.set(u.player_id, cur);
  }
  for (const v of out.values()) {
    v.points = +v.points.toFixed(1);
    v.ppg = +(v.points / Math.max(1, v.games)).toFixed(2);
  }
  return out;
}

/* ------------------------------------------------------------------ metrics */

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Spearman: rank correlation, which is what actually matters for draft and start/sit order. */
export function spearman(pairs) {
  if (pairs.length < 3) return null;
  const rank = key => {
    const sorted = [...pairs].sort((a, b) => b[key] - a[key]);
    const r = new Map();
    // Average ties so a block of equal predictions doesn't get an arbitrary order.
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][key] === sorted[i][key]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r.set(sorted[k], avg);
      i = j + 1;
    }
    return r;
  };
  const rp = rank('pred'), ra = rank('act');
  const n = pairs.length;
  const d2 = pairs.reduce((s, p) => s + (rp.get(p) - ra.get(p)) ** 2, 0);
  return +(1 - (6 * d2) / (n * (n * n - 1))).toFixed(4);
}

/**
 * Grade point predictions.
 * @param predictions Map<player_id, number>
 * @param truth       Map<player_id, {points, ppg, games}>
 */
export function gradePoint(predictions, truth, { field = 'points', minGames = 4 } = {}) {
  const pairs = [];
  for (const [pid, pred] of predictions) {
    const a = truth.get(Number(pid));
    if (!a || a.games < minGames || pred == null) continue;
    pairs.push({ pid: Number(pid), pred: Number(pred), act: a[field] });
  }
  if (pairs.length < 5) return { n: pairs.length, error: 'not enough overlapping players to grade' };

  const errs = pairs.map(p => p.pred - p.act);
  const abs = errs.map(Math.abs);
  const actMean = mean(pairs.map(p => p.act));
  const ssRes = errs.reduce((s, e) => s + e * e, 0);
  const ssTot = pairs.reduce((s, p) => s + (p.act - actMean) ** 2, 0);

  // Top-36 hit rate: of the players the model ranked as startable, how many really were.
  const topN = Math.min(36, Math.floor(pairs.length / 3));
  const predTop = new Set([...pairs].sort((a, b) => b.pred - a.pred).slice(0, topN).map(p => p.pid));
  const actTop = new Set([...pairs].sort((a, b) => b.act - a.act).slice(0, topN).map(p => p.pid));
  const hits = [...predTop].filter(p => actTop.has(p)).length;

  return {
    n: pairs.length,
    mae: +mean(abs).toFixed(2),
    rmse: +Math.sqrt(mean(errs.map(e => e * e))).toFixed(2),
    bias: +mean(errs).toFixed(2),            // positive = systematically over-projecting
    r2: ssTot ? +(1 - ssRes / ssTot).toFixed(4) : null,
    spearman: spearman(pairs),
    top_n: topN,
    top_n_hit_rate: +(hits / topN).toFixed(3)
  };
}

/**
 * Continuous Ranked Probability Score from samples.
 *
 * CRPS = E|X - y| - 0.5 * E|X - X'|. The first term punishes being wrong, the second
 * rewards being appropriately uncertain — a forecast that hedges by predicting a huge
 * spread is penalised just as a confidently wrong one is. Lower is better, and the
 * units are points, so it reads on the same scale as MAE.
 */
export function crps(samples, y) {
  const n = samples.length;
  if (!n) return null;
  const s = [...samples].sort((a, b) => a - b);
  const term1 = mean(s.map(x => Math.abs(x - y)));
  // E|X - X'| for a sorted sample has a closed form, which avoids the O(n^2) double loop.
  let term2 = 0;
  for (let i = 0; i < n; i++) term2 += s[i] * (2 * i - n + 1);
  term2 = (2 * term2) / (n * n);
  return +(term1 - 0.5 * term2).toFixed(3);
}

/**
 * Grade distributional forecasts.
 * @param samplesBy Map<player_id, number[]>  simulated outcomes per player
 */
export function gradeDistribution(samplesBy, truth, { field = 'points', minGames = 4 } = {}) {
  const scores = [], pits = [];
  for (const [pid, samples] of samplesBy) {
    const a = truth.get(Number(pid));
    if (!a || a.games < minGames || !samples?.length) continue;
    scores.push(crps(samples, a[field]));
    // Probability integral transform: where the actual fell in the predicted
    // distribution. Perfectly calibrated forecasts give a flat histogram of these.
    pits.push(samples.filter(s => s <= a[field]).length / samples.length);
  }
  if (!scores.length) return { n: 0, error: 'no overlapping players' };

  const bins = new Array(10).fill(0);
  for (const p of pits) bins[Math.min(9, Math.floor(p * 10))]++;
  const expected = pits.length / 10;
  // Chi-square-ish deviation from flat; 0 means perfectly calibrated.
  const calibrationError = +(mean(bins.map(b => Math.abs(b - expected))) / expected).toFixed(3);

  return {
    n: scores.length,
    crps: +mean(scores).toFixed(3),
    calibration_error: calibrationError,
    pit_histogram: bins,
    // Coverage of the central 80% interval — should land near 0.80.
    coverage_80: +(pits.filter(p => p >= 0.1 && p <= 0.9).length / pits.length).toFixed(3)
  };
}

/* ---------------------------------------------------------------- baselines */

/**
 * Reference forecasts every model has to beat. If a new model can't outscore
 * "last year's points", it isn't a model.
 */
export function baselines(season, scoring = PPR) {
  const prior = actuals(season - 1, scoring);
  const out = new Map();

  out.set('last season points', new Map([...prior].map(([pid, a]) => [pid, a.points])));
  // Prior ppg projected over a full season — separates "was good" from "was available".
  out.set('last season ppg x 17', new Map([...prior].map(([pid, a]) => [pid, +(a.ppg * 17).toFixed(1)])));

  const espn = new Map(rows(
    `SELECT player_id, fantasy_points FROM player_season_stats
     WHERE season = ? AND kind = 'projected' AND fantasy_points IS NOT NULL`, season)
    .map(r => [r.player_id, r.fantasy_points]));
  if (espn.size) out.set('ESPN projection', espn);

  return out;
}

/**
 * Run every baseline plus any supplied sources against one season.
 * @param sources Map<string, Map<player_id, number>>
 */
export function compare(season, sources = new Map(), { scoring = PPR, field = 'points', minGames = 4 } = {}) {
  const truth = actuals(season, scoring);
  if (!truth.size) return { error: `no weekly usage data for ${season} — sync nflverse first` };

  const all = new Map([...baselines(season, scoring), ...sources]);
  const table = [];
  for (const [name, preds] of all) {
    const g = gradePoint(preds, truth, { field, minGames });
    if (!g.error) table.push({ source: name, ...g });
  }
  // Rank correlation first: getting the order right matters more than the absolute level.
  table.sort((a, b) => (b.spearman ?? -1) - (a.spearman ?? -1));
  return { season, field, players_with_actuals: truth.size, table };
}

/**
 * Grades the decision the product actually makes: who should be started this
 * week. Season-total accuracy can look good while weekly ordering is useless,
 * so this reports realized points, oracle regret and top-player overlap by
 * position. Missing weeks count as zero; excluding them would use hindsight to
 * remove injuries and benchings the forecast failed to anticipate.
 */
export function weeklyDecisionBacktest(projections, truth, {
  weeks = 18, starters = { QB: 12, RB: 24, WR: 36, TE: 12 }
} = {}) {
  const byPos = {};
  for (const pos of Object.keys(starters)) {
    const pool = [...projections.values()].filter(p => p.position === pos && truth.has(p.player_id));
    const k = Math.min(starters[pos], pool.length);
    if (!k) continue;
    let chosenPoints = 0, oraclePoints = 0, overlap = 0, decisions = 0;
    const errors = [];

    for (let week = 1; week <= weeks; week++) {
      const ranked = [...pool].sort((a, b) => b.ppg - a.ppg);
      const actual = pool.map(p => ({
        id: p.player_id, pred: p.ppg,
        act: truth.get(p.player_id)?.weeks.get(week) ?? 0
      }));
      const picked = ranked.slice(0, k);
      const oracle = [...actual].sort((a, b) => b.act - a.act).slice(0, k);
      const oracleIds = new Set(oracle.map(x => x.id));
      chosenPoints += picked.reduce((s, p) => s + (truth.get(p.player_id)?.weeks.get(week) ?? 0), 0);
      oraclePoints += oracle.reduce((s, p) => s + p.act, 0);
      overlap += picked.filter(p => oracleIds.has(p.player_id)).length;
      decisions += k;
      errors.push(...actual.map(x => Math.abs(x.pred - x.act)));
    }

    byPos[pos] = {
      players: pool.length, weekly_starters: k, decisions,
      starter_hit_rate: +(overlap / decisions).toFixed(3),
      realized_points_per_start: +(chosenPoints / decisions).toFixed(2),
      oracle_points_per_start: +(oraclePoints / decisions).toFixed(2),
      regret_per_start: +((oraclePoints - chosenPoints) / decisions).toFixed(2),
      weekly_mae: +mean(errors).toFixed(2)
    };
  }
  const totalDecisions = Object.values(byPos).reduce((s, x) => s + x.decisions, 0);
  return {
    positions: byPos,
    decisions: totalDecisions,
    note: 'Pregame ranking versus realized weekly outcomes. DNPs remain zero so availability misses cannot disappear through hindsight.'
  };
}
