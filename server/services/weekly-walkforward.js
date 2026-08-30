/**
 * Refit every week, on everything known by that week, and predict the next one.
 *
 * The football-first model was fitted once per season on the five seasons before
 * it, then applied to all seventeen weeks. That is cutoff-safe but it is not how
 * anybody would actually operate, and it wastes the most useful information in
 * the file: what happened last Sunday.
 *
 * This walks the calendar properly. Standing at the start of week W of season S,
 * it fits on every completed game through week W−1 — including the weeks of S
 * already played — and predicts week W. Then week W settles, joins the training
 * set, and the process repeats. Every prediction used exactly what was knowable
 * at the moment it was made, and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE HONEST TEST OF "IT GETS BETTER WITH MORE DATA"
 *
 * A per-season fit cannot answer that question. It produces one model per year
 * and any apparent trend across years is confounded with which years happened to
 * be lucky — which is exactly the trap that made a 57.9% on 57 bets look like an
 * edge until the sample widened and it collapsed to 48.4%.
 *
 * A weekly walk-forward answers it directly, because the training set grows by
 * one week at a time and the prediction is recorded against it. If the model
 * genuinely improves as evidence accumulates, accuracy rises with training size
 * and the rise is visible within a single season rather than across five. If it
 * does not, the line is flat and that is the answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON COST
 *
 * Seventy refits, each walking a thousand games whose features cost several
 * database reads apiece, is minutes of work done naively. The features for a
 * given game never change once the week is complete, so they are computed once
 * and reused across every fit that includes them. That turns the walk-forward
 * from quadratic into roughly linear and is the only reason this is runnable.
 */
import { rows } from '../db/index.js';
import { footballFeatures, FEATURES } from './football-first.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const BREAK_EVEN = 0.5238;

/**
 * Feature cache keyed on the game.
 *
 * Module-level rather than per-call: a walk-forward asks for the same game's
 * features once per remaining week of the season, and recomputing them is the
 * entire cost of the exercise.
 */
const _features = new Map();

function featuresFor(season, week, home, away) {
  const key = `${season}|${week}|${home}|${away}`;
  if (!_features.has(key)) {
    let f = null;
    try { f = footballFeatures(season, week, home, away); } catch { f = null; }
    _features.set(key, f);
  }
  return _features.get(key);
}

export function clearWalkForwardCache() { _features.clear(); }

/** Ridge solve, shared with football-first's fitter. */
function ridgeFit(samples, lambda = 5) {
  if (!samples.length) return null;
  const p = samples[0].x.length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (const s of samples) {
    for (let i = 0; i < p; i++) {
      Xty[i] += s.x[i] * s.y;
      for (let j = 0; j < p; j++) XtX[i][j] += s.x[i] * s.x[j];
    }
  }
  for (let i = 1; i < p; i++) XtX[i][i] += lambda;
  const n = p;
  const M = XtX.map((r, i) => [...r, Xty[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}

/**
 * Walk one or more seasons a week at a time.
 *
 * @param minTrain games required before the model is allowed to predict at all.
 *   Below this it abstains rather than guessing from a handful of rows, which is
 *   both correct and the reason early weeks are absent from the output.
 */
export function walkForward({
  seasons = [2021, 2022, 2023, 2024, 2025],
  historyFrom = 2016,
  startWeek = 5,
  endWeek = 18,
  minLean = 1.0,
  minTrain = 300
} = {}) {
  // Every completed home-team row, in chronological order. One query; the walk
  // slices it rather than re-querying per week.
  const all = rows(
    `SELECT season, week, team home, opponent away, spread, total, team_score, opp_score
     FROM game_lines
     WHERE home = 1 AND season >= ? AND spread IS NOT NULL AND team_score IS NOT NULL
     ORDER BY season, week`, historyFrom);

  const chronological = all.map(g => ({
    ...g,
    residual: (g.team_score - g.opp_score) - (-g.spread)
  }));

  const picks = [];
  const weekly = [];

  for (const season of seasons) {
    for (let week = startWeek; week <= endWeek; week++) {
      // TRAIN: everything strictly before this week, across all prior seasons
      // and the completed weeks of this one.
      const train = [];
      for (const g of chronological) {
        if (g.season > season) break;
        if (g.season === season && g.week >= week) continue;
        const f = featuresFor(g.season, g.week, g.home, g.away);
        if (!f) continue;
        const x = [1, ...FEATURES.map(k => f[k.key] ?? 0)];
        if (!x.every(Number.isFinite) || !Number.isFinite(g.residual)) continue;
        train.push({ x, y: g.residual });
      }
      if (train.length < minTrain) continue;

      const beta = ridgeFit(train);
      if (!beta) continue;

      // PREDICT: this week only.
      const target = chronological.filter(g => g.season === season && g.week === week);
      const weekPicks = [];
      for (const g of target) {
        const f = featuresFor(g.season, g.week, g.home, g.away);
        if (!f) continue;
        const x = [1, ...FEATURES.map(k => f[k.key] ?? 0)];
        if (!x.every(Number.isFinite)) continue;
        const lean = beta.reduce((s, b, i) => s + b * x[i], 0);
        if (Math.abs(lean) < minLean) continue;
        if (g.residual === 0) continue;                 // push
        const won = (lean > 0) === (g.residual > 0);
        const pick = {
          season, week, home: g.home, away: g.away,
          side: lean > 0 ? g.home : g.away,
          lean: r3(lean), residual: g.residual,
          won: won ? 1 : 0,
          training_games: train.length
        };
        weekPicks.push(pick);
        picks.push(pick);
      }

      if (weekPicks.length) {
        const w = weekPicks.reduce((s, p) => s + p.won, 0);
        weekly.push({
          season, week, bets: weekPicks.length, wins: w,
          win_rate: r3(w / weekPicks.length),
          training_games: train.length,
          coefficients: Object.fromEntries(FEATURES.map((f, i) => [f.key, r3(beta[i + 1])]))
        });
      }
    }
  }

  return summarise(picks, weekly, { minLean, minTrain, seasons });
}

function summarise(picks, weekly, opts) {
  const n = picks.length;
  if (!n) return { error: 'no picks cleared the lean threshold', ...opts };
  const wins = picks.reduce((s, p) => s + p.won, 0);
  const rate = wins / n;
  const se = Math.sqrt(BREAK_EVEN * (1 - BREAK_EVEN) / n);
  const z = (rate - BREAK_EVEN) / se;

  // THE QUESTION THIS EXISTS TO ANSWER: does accuracy rise with training size?
  //
  // Split at the median rather than into arbitrary buckets, and report the
  // significance of the difference — a rising win rate across two halves is the
  // easiest thing in the world to see in noise.
  const sorted = picks.slice().sort((a, b) => a.training_games - b.training_games);
  const mid = Math.floor(sorted.length / 2);
  const lessData = sorted.slice(0, mid);
  const moreData = sorted.slice(mid);
  const rateOf = l => (l.length ? l.reduce((s, p) => s + p.won, 0) / l.length : null);
  const pLess = rateOf(lessData), pMore = rateOf(moreData);
  const pooled = wins / n;
  const seDiff = Math.sqrt(pooled * (1 - pooled) * (1 / lessData.length + 1 / moreData.length));
  const zTrend = seDiff > 0 ? (pMore - pLess) / seDiff : null;

  // Per season, so a year-by-year read is available without re-slicing by hand.
  const bySeason = {};
  for (const p of picks) {
    bySeason[p.season] ??= { bets: 0, wins: 0 };
    bySeason[p.season].bets++; bySeason[p.season].wins += p.won;
  }

  return {
    ...opts,
    bets: n, wins, losses: n - wins,
    win_rate: r3(rate),
    break_even: BREAK_EVEN,
    vs_break_even_pp: r3((rate - BREAK_EVEN) * 100),
    z: r3(z),
    by_season: Object.fromEntries(Object.entries(bySeason).map(([s, v]) =>
      [s, { bets: v.bets, wins: v.wins, win_rate: r3(v.wins / v.bets) }])),
    learning_curve: {
      less_training_data: { n: lessData.length, win_rate: r3(pLess),
        median_training_games: lessData[lessData.length - 1]?.training_games ?? null },
      more_training_data: { n: moreData.length, win_rate: r3(pMore),
        median_training_games: moreData[moreData.length - 1]?.training_games ?? null },
      difference_pp: r3((pMore - pLess) * 100),
      z: r3(zTrend),
      significant: zTrend != null && Math.abs(zTrend) >= 1.96,
      reading: zTrend == null ? 'not computable'
        : Math.abs(zTrend) < 1.96
          ? `More training data moved the win rate by ${r3((pMore - pLess) * 100)} points at ` +
            `z = ${r3(zTrend)}, which is inside noise. On this evidence the model does not ` +
            'measurably improve as the season accumulates — which is the claim a weekly ' +
            'walk-forward exists to test, and it does not hold.'
          : pMore > pLess
            ? `The model is measurably better with more training data (+${r3((pMore - pLess) * 100)} ` +
              `points, z = ${r3(zTrend)}). Accuracy rising with evidence is the signature of a real ` +
              'signal rather than a lucky sample.'
            : `The model gets WORSE with more training data (z = ${r3(zTrend)}), which usually means ` +
              'it is fitting a relationship that has changed rather than one that holds.'
    },
    weekly,
    note: 'Standing at week W, the fit uses every completed game through W-1 including earlier weeks ' +
      'of the same season, and predicts W. Each prediction used exactly what was knowable when it ' +
      'was made.'
  };
}
