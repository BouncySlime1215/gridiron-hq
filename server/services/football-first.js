/**
 * Football leads; the statistics check its work.
 *
 * Every forecasting attempt in this codebase has been the same shape: take a
 * pile of numbers, blend them, compare the blend to the market. Nineteen
 * component models arguing about a margin. It has been measured at 46.5% against
 * a 52.38% break-even, and the reasoning traces made the reason legible — there
 * is no football in it. Nothing in the pipeline knows that a team is missing a
 * third of its offence, that a defence cannot cover tight ends, that the coach
 * runs the ball at the second-highest rate in the league, or that the wind is up.
 *
 * This inverts it. The unit of analysis is a football fact with a mechanical
 * consequence, and the question is whether those facts predict WHERE THE MARKET
 * IS WRONG — which is the only question that matters, because the market is the
 * thing that has to be beaten.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A REGRESSION ON THE MARKET'S RESIDUAL
 *
 * The naive version builds a football-based margin projection and compares it to
 * the spread. That relearns the spread — most of any margin model's output is
 * just "the better team wins", which the market already knows, and the tiny
 * remainder is where all the information lives.
 *
 * So the target here is the RESIDUAL: actual margin minus market margin. If a
 * football feature has a non-zero coefficient on that, it is telling you
 * something the closing line did not contain, which is by definition an edge.
 * If every coefficient collapses to zero, the market has already priced the
 * football, and that is a real answer rather than a failure.
 *
 * THE HONEST PRIOR. The market prices obvious football aggressively. A starting
 * quarterback ruled out moves a line seven points within minutes. What it prices
 * less completely is second-order: cumulative skill-position attrition, a
 * specific positional mismatch, a staff whose tendencies fight the game script it
 * is about to face. Those are what this is built from, and they may still be
 * priced. Seven previous attempts to beat a closing line here have failed, so
 * this is fitted, preregistered and tested rather than shipped on plausibility.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CUTOFF SAFETY
 *
 * Every feature is computed from weeks strictly before the target, except the
 * injury report, which is published before kickoff and is therefore information
 * a bettor genuinely has. Coefficients are fitted on seasons strictly before the
 * one being scored.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RESULT, AND THE LESSON IN HOW IT ARRIVED
 *
 * Tested against closing spreads, preregistered and sealed:
 *
 *   Audit #14, held out on 2024-25:   33-24, 57.89%, z = 0.834, n = 57
 *   Audit #15, held out on 2021-25:  117-125, 48.35%, z = -1.256, n = 242
 *
 * The first looked like the best result this project has ever produced — five
 * and a half points clear of the -110 break-even. It was noise. Widening the
 * held-out sample to five seasons collapsed it below break-even, which is what
 * a 57.9% on fifty-seven bets at z = 0.834 always had a real chance of being.
 *
 * That sequence is the whole argument for the audit registry. The first number
 * would have been extremely easy to believe, and believing it would have meant
 * betting real money on a coin flip. The second look was filed as a separate
 * preregistration precisely so it was counted rather than quietly rerun until
 * the answer improved.
 *
 * This is the eighth distinct attempt in this codebase to beat a closing line
 * and the eighth failure. The market prices football, including the football
 * that feels like it should be missed.
 *
 * A NOTE ON THE SUB-SAMPLES, which are a trap. Broken out by leading feature,
 * wind ran 66.7% on twelve bets and the injury differential 56.5% on
 * twenty-three. Both are post-hoc slices of a losing sample, both are far too
 * small to mean anything, and chasing either is the same error as believing
 * audit #14. If wind is to be tested it needs its own preregistration and its
 * own held-out seasons.
 *
 * WHERE THIS MACHINERY IS STILL WORTH HAVING: fantasy. The opponents there are
 * nine people reading box scores rather than a market that employs people to
 * price exactly this, and the same features feed lineup and waiver decisions
 * where no closing line has to be beaten.
 */
import { rows, row } from '../db/index.js';
import { cached, fingerprint } from './compute-cache.js';
import { availabilityPicture, coachingProfile, weatherPicture } from './football-context.js';
import { efficiencyGap } from './nfl-spread-context.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * The football facts, each with a mechanical story for why it moves a game.
 *
 * Named and described here rather than discovered by a search, because a search
 * over hundreds of candidates on a few thousand games finds whatever it likes.
 * Six features, chosen in advance, each with a stated direction.
 */
export const FEATURES = [
  { key: 'availability_edge',
    label: 'usage-weighted injury differential',
    story: 'A team missing a fifth of its recent touches is worse than its season numbers say, and ' +
      'the market has to price a report it also only just received.' },
  { key: 'efficiency_edge',
    label: 'efficiency minus results',
    story: 'A team whose EPA runs ahead of its record has been unlucky, and luck does not persist ' +
      'while play does.' },
  { key: 'pace_edge',
    label: 'combined pace',
    story: 'Two fast offences produce more possessions, which widens the distribution of margins ' +
      'and matters more for a total than for a side.' },
  { key: 'script_conflict',
    label: 'tendency against likely game script',
    story: 'A run-heavy staff trailing by two scores is forced out of what it does well; a ' +
      'pass-heavy staff protecting a lead is forced into what it does badly.' },
  { key: 'wind',
    label: 'wind above the passing threshold',
    story: 'Above roughly 15 mph passing volume and accuracy fall away, which suppresses scoring ' +
      'and compresses margins.' },
  { key: 'rest_edge',
    label: 'rest differential',
    story: 'A bye or a long week against a short one is a real physical advantage the line ' +
      'sometimes underweights.' }
];

/**
 * Build the football feature vector for one game, from the home side's view.
 *
 * Returns null when the game or its market number is missing rather than
 * fabricating zeros, because a zero here is a claim ("no advantage either way")
 * rather than an absence.
 */
export function footballFeatures(season, week, home, away) {
  const g = row(
    `SELECT spread, total, rest_days, roof, temp, wind
     FROM game_lines WHERE season = ? AND week = ? AND team = ? AND home = 1`,
    season, week, home);
  if (!g || g.spread == null) return null;
  const awayRow = row(
    `SELECT rest_days FROM game_lines WHERE season = ? AND week = ? AND team = ?`,
    season, week, away);

  const homeAvail = availabilityPicture(home, season, week);
  const awayAvail = availabilityPicture(away, season, week);
  const homeEff = efficiencyGap(home, season, { throughWeek: week });
  const awayEff = efficiencyGap(away, season, { throughWeek: week });
  const homeCoach = coachingProfile(home, season, week);
  const awayCoach = coachingProfile(away, season, week);

  // Positive means the home side is advantaged, so every feature reads in one
  // direction and a coefficient's sign is interpretable without a lookup.
  const availabilityEdge = (awayAvail.usage_share_at_risk ?? 0) - (homeAvail.usage_share_at_risk ?? 0);
  const efficiencyEdge = (homeEff.gap ?? 0) - (awayEff.gap ?? 0);

  const paceOf = c => c?.traits?.find(t => t.metric === 'off_seconds_per_drive')?.percentile ?? 0.5;
  const passOf = c => c?.traits?.find(t => t.metric === 'off_proe')?.percentile ?? 0.5;
  const paceEdge = (paceOf(homeCoach) + paceOf(awayCoach)) - 1;

  // A run-heavy team getting points is likelier to be forced out of its identity.
  // `spread` is from the home team's view: positive means home is the underdog.
  const scriptConflict =
    (g.spread > 3 ? (0.5 - passOf(homeCoach)) : 0) -
    (g.spread < -3 ? (0.5 - passOf(awayCoach)) : 0);

  const indoors = g.roof === 'dome' || g.roof === 'closed';
  const wind = indoors || !Number.isFinite(g.wind) ? 0 : Math.max(0, g.wind - 15) / 10;
  const restEdge = Number.isFinite(g.rest_days) && Number.isFinite(awayRow?.rest_days)
    ? (g.rest_days - awayRow.rest_days) / 7 : 0;

  return {
    availability_edge: r3(availabilityEdge),
    efficiency_edge: r3(efficiencyEdge),
    pace_edge: r3(paceEdge),
    script_conflict: r3(scriptConflict),
    wind: r3(wind),
    rest_edge: r3(restEdge),
    market_margin: -g.spread, market_total: g.total
  };
}

/**
 * Fit the football features against the market's own error.
 *
 * Ridge-regularised least squares. The regularisation is not decoration: six
 * correlated features on a few hundred games will happily produce large opposing
 * coefficients that cancel, which looks like signal and generalises to nothing.
 */
function fitResidualModel(beforeSeason, target = 'margin') {
  const games = rows(
    `SELECT season, week, team home, opponent away, spread, total, team_score, opp_score
     FROM game_lines
     WHERE home = 1 AND season < ? AND season >= ? AND week >= 5
       AND spread IS NOT NULL AND team_score IS NOT NULL`,
    beforeSeason, beforeSeason - 5);

  const samples = [];
  for (const g of games) {
    const f = footballFeatures(g.season, g.week, g.home, g.away);
    if (!f) continue;
    const actualMargin = g.team_score - g.opp_score;
    const actualTotal = g.team_score + g.opp_score;
    const y = target === 'total'
      ? (g.total == null ? null : actualTotal - g.total)
      : actualMargin - (-g.spread);
    if (y == null || !Number.isFinite(y)) continue;
    const x = [1, ...FEATURES.map(k => f[k.key] ?? 0)];
    if (!x.every(Number.isFinite)) continue;
    samples.push({ x, y });
  }

  if (samples.length < 200) {
    return { fitted: false, n: samples.length,
      why: `Only ${samples.length} usable games before ${beforeSeason}; a six-feature fit needs ` +
        'several hundred to mean anything.' };
  }

  // Ridge: (XᵀX + λI)⁻¹ Xᵀy, solved by Gauss-Jordan on a 7×7. Small enough that
  // an explicit solve is clearer than an iterative method.
  const p = samples[0].x.length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (const s of samples) {
    for (let i = 0; i < p; i++) {
      Xty[i] += s.x[i] * s.y;
      for (let j = 0; j < p; j++) XtX[i][j] += s.x[i] * s.x[j];
    }
  }
  const lambda = 5;
  for (let i = 1; i < p; i++) XtX[i][i] += lambda;   // intercept unpenalised

  const beta = solve(XtX, Xty);
  if (!beta) return { fitted: false, n: samples.length, why: 'the normal equations were singular' };

  // In-sample residual variance, used only to report how little of the residual
  // this explains — which for a market residual should be almost all of it.
  const ssTot = samples.reduce((s, x) => s + x.y * x.y, 0);
  const ssRes = samples.reduce((s, x) => {
    const pred = beta.reduce((a, b, i) => a + b * x.x[i], 0);
    return s + (x.y - pred) ** 2;
  }, 0);

  return {
    fitted: true, n: samples.length, target,
    intercept: r3(beta[0]),
    coefficients: Object.fromEntries(FEATURES.map((f, i) => [f.key, r3(beta[i + 1])])),
    r_squared: r3(1 - ssRes / ssTot),
    trained_before_season: beforeSeason
  };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row_, i) => [...row_, b[i]]);
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
  return M.map((row_, i) => row_[n] / M[i][i]);
}

/** Cached per cutoff; the fit walks several hundred games and rarely changes. */
export function residualModel(beforeSeason, target = 'margin') {
  return cached(`football-first:${target}:${beforeSeason}`,
    fingerprint([{ table: 'game_lines', stamp: 'week' },
      { table: 'nfl_injuries', stamp: 'week' },
      { table: 'nfl_team_week_features', stamp: 'week' }], `${target}:${beforeSeason}`),
    () => fitResidualModel(beforeSeason, target));
}

/**
 * The football-first read on one game: where the market is wrong, and why.
 *
 * The lean is the fitted prediction of the market's residual. Each feature's
 * contribution is reported separately, so the explanation is the decomposition
 * rather than a story told afterwards — which is the difference between football
 * leading and football being quoted.
 */
export function footballFirstLean(season, week, home, away, { target = 'margin' } = {}) {
  const m = residualModel(season, target);
  const f = footballFeatures(season, week, home, away);
  if (!f) return { error: 'no market number on record for this game' };
  if (!m.fitted) return { error: m.why, features: f };

  const contributions = FEATURES.map(spec => ({
    feature: spec.key, label: spec.label,
    value: f[spec.key] ?? 0,
    coefficient: m.coefficients[spec.key],
    points: r3((f[spec.key] ?? 0) * m.coefficients[spec.key]),
    story: spec.story
  })).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  const lean = r3(m.intercept + contributions.reduce((s, c) => s + c.points, 0));

  return {
    season, week, home, away, target,
    market_number: target === 'total' ? f.market_total : f.market_margin,
    lean_points: lean,
    side: target === 'total'
      ? (lean > 0 ? 'over' : 'under')
      : (lean > 0 ? home : away),
    contributions,
    // The dominant football reason, which is what leads the explanation.
    leading_reason: contributions[0]?.label ?? null,
    leading_story: contributions[0]?.story ?? null,
    model: { n: m.n, r_squared: m.r_squared, trained_before_season: m.trained_before_season },
    caveat: `The fit explains ${((m.r_squared ?? 0) * 100).toFixed(1)}% of the market's residual. ` +
      'A closing line is close to unbeatable and most of what is left after it is genuine ' +
      'randomness, so a small number here is expected — what matters is whether the remainder is ' +
      'real, which only a preregistered forward test decides.'
  };
}
