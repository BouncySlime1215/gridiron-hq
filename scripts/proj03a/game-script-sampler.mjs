// PROJ-03-a STUDY CODE, not a production module. The keyed game-script sampler was
// DECLINED by its pre-registered calibration rule (docs/tdd/2026-09-23-proj-03a-game-script-sampler.tdd.md),
// so it lives under scripts/ and nothing in server/ or client/ may import it.
// Readers: scripts/proj03a-calibration.mjs and test/proj-03a-game-script.test.js only.
//
// One keyed score path per game, consistent with the line: both team totals, the margin,
// each side's quarter points and the home win probability after each quarter.
//   - team points ~ Gamma(mean = implied points, sd = the |spread| bucket's sd);
//   - the two teams joined by a Gaussian copula with the bucket's residual correlation;
//   - quarters split each final by Dirichlet(k/4 x 4), the bridge of a gamma process;
//   - win probability after quarter q from Stern's (1994) Brownian margin model.
// Pace (expected attempts) was removed: it duplicated the canonical producer
// gameScriptFor (server/services/gamescript.js) with a different OLS and disagreed with it.
// Params are fitted in memory at the (season, week) cutoff: no table, no store.
import { rows, row } from '../../server/db/index.js';
import { mean, stdev, keyedNormal, normalCdf } from '../../server/services/stats-util.js';

// Same arithmetic as the private impliedPoints in server/services/gamescript.js:31.
const impliedPoints = (spread, total) => total / 2 - spread / 2;

const _scoreCache = new Map();
export function clearScoreModelCache() { _scoreCache.clear(); }

export const SCORE_MODEL_FIRST_SEASON = 2021;
const MIN_BUCKET_TEAM_GAMES = 50;

/** |spread| bucket: 'lt3' (< 3), '3to7' (3..7 inclusive), 'gt7' (> 7). */
export function spreadBucket(spread) {
  const a = Math.abs(spread);
  return a < 3 ? 'lt3' : a <= 7 ? '3to7' : 'gt7';
}

/** Lanczos log-gamma (g = 7, n = 9). */
function logGamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x): series below a+1, continued fraction above. */
function gammaP(a, x) {
  if (x <= 0) return 0;
  const lg = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap += 1; term *= x / ap; sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-14) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lg) * h;
}

/** Regularized lower incomplete gamma, exported for the calibration script's chi-square and CRPS. */
export const regularizedGammaP = gammaP;

/** Gamma(shape, 1) quantile by safeguarded Newton from a Wilson-Hilferty start. */
export function gammaQuantile(u, shape) {
  if (!(u > 0)) return 0;
  if (!(u < 1)) return Infinity;
  const lg = logGamma(shape);
  const z = Math.sqrt(2) * erfInvApprox(2 * u - 1);
  const wh = shape * (1 - 1 / (9 * shape) + z / (3 * Math.sqrt(shape))) ** 3;
  let x = wh > 0 ? wh : Math.max(1e-8, Math.pow(u * Math.exp(lg + Math.log(shape)), 1 / shape));
  let lo = 0, hi = Infinity;
  for (let i = 0; i < 100; i++) {
    const f = gammaP(shape, x) - u;
    if (f > 0) hi = x; else lo = x;
    if (Math.abs(f) < 1e-12) break;
    const pdf = Math.exp((shape - 1) * Math.log(x) - x - lg);
    let next = pdf > 0 ? x - f / pdf : NaN;
    if (!(next > lo && next < hi)) next = Number.isFinite(hi) ? (lo + hi) / 2 : Math.max(2 * x, x + 1);
    if (Math.abs(next - x) < 1e-12 * Math.max(1, x)) { x = next; break; }
    x = next;
  }
  return x;
}

/** Inverse error function (Giles 2010 single-precision form), only used as a Newton start. */
function erfInvApprox(y) {
  let w = -Math.log((1 - y) * (1 + y)), p;
  if (w < 5) {
    w -= 2.5;
    p = 2.81022636e-08; p = 3.43273939e-07 + p * w; p = -3.5233877e-06 + p * w; p = -4.39150654e-06 + p * w;
    p = 0.00021858087 + p * w; p = -0.00125372503 + p * w; p = -0.00417768164 + p * w; p = 0.246640727 + p * w;
    p = 1.50140941 + p * w;
  } else {
    w = Math.sqrt(w) - 3;
    p = -0.000200214257; p = 0.000100950558 + p * w; p = 0.00134934322 + p * w; p = -0.00367342844 + p * w;
    p = 0.00573950773 + p * w; p = -0.0076224613 + p * w; p = 0.00943887047 + p * w; p = 1.00167406 + p * w;
    p = 2.83297682 + p * w;
  }
  return p * y;
}

const clampU = u => Math.min(1 - 1e-12, Math.max(1e-12, u));
const keyedUniform = (key, counter) => clampU(normalCdf(keyedNormal(key, counter)));

/** Training games (home row only, one per game), scored, before the cutoff, from 2021. */
function scoredGames(season, week) {
  return rows(`SELECT g.season, g.week, g.team, g.opponent,
                      COALESCE(g.closing_spread, g.spread) AS spread,
                      COALESCE(g.closing_total, g.total) AS total,
                      g.team_score, g.opp_score, COALESCE(g.neutral_site, 0) AS neutral
                 FROM game_lines g
                WHERE g.home = 1 AND g.team_score IS NOT NULL AND g.opp_score IS NOT NULL
                  AND COALESCE(g.closing_spread, g.spread) IS NOT NULL
                  AND COALESCE(g.closing_total, g.total) IS NOT NULL
                  AND g.season >= ?
                  AND (g.season < ? OR (g.season = ? AND g.week < ?))`,
    SCORE_MODEL_FIRST_SEASON, season, season, week);
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * Score-model params fitted on scored games strictly before (season, week).
 * Returns null when there are fewer than 100 training games.
 */
export function scoreModelAt(season, week) {
  const key = `${season}|${week}`;
  if (_scoreCache.has(key)) return _scoreCache.get(key);
  const games = scoredGames(season, week);
  if (games.length < 100) { _scoreCache.set(key, null); return null; }
  const all = { res: [], hres: [], ares: [], mres: [] };
  const by = { lt3: { res: [], hres: [], ares: [], mres: [] }, '3to7': { res: [], hres: [], ares: [], mres: [] }, gt7: { res: [], hres: [], ares: [], mres: [] } };
  for (const g of games) {
    const ih = impliedPoints(g.spread, g.total), ia = impliedPoints(-g.spread, g.total);
    const rh = g.team_score - ih, ra = g.opp_score - ia;
    const rm = (g.team_score - g.opp_score) - (-g.spread);
    for (const s of [all, by[spreadBucket(g.spread)]]) { s.res.push(rh, ra); s.hres.push(rh); s.ares.push(ra); s.mres.push(rm); }
  }
  const summarize = s => ({ n: s.res.length, sd: stdev(s.res), margin_sd: stdev(s.mres),
    rho: Math.max(-0.9, Math.min(0.9, pearson(s.hres, s.ares))) });
  const pooled = summarize(all);
  const buckets = {};
  for (const [b, s] of Object.entries(by)) {
    const fit = summarize(s);
    buckets[b] = fit.n >= MIN_BUCKET_TEAM_GAMES ? { ...fit, pooled_fallback: false }
      : { ...pooled, n: fit.n, pooled_fallback: true };
  }
  const out = {
    buckets, pooled_sd: pooled.sd, pooled_margin_sd: pooled.margin_sd,
    games: games.length, fitted_through: { season, week }
  };
  _scoreCache.set(key, out);
  return out;
}

/** Gamma(mean, sd) points quantile. */
function pointsQuantile(u, meanPts, sd) {
  const m = Math.max(1, meanPts);
  const shape = (m / sd) ** 2, scale = sd * sd / m;
  return gammaQuantile(u, shape) * scale;
}

/** The sampler's own team-points CDF and quantile, for calibration and range display. */
export function teamPointsDistribution(meanPts, spread, params) {
  const b = params.buckets[spreadBucket(spread)];
  const m = Math.max(1, meanPts), shape = (m / b.sd) ** 2, scale = b.sd * b.sd / m;
  return {
    mean: m, sd: b.sd, bucket: spreadBucket(spread),
    cdf: y => (y <= 0 ? 0 : gammaP(shape, y / scale)),
    quantile: u => gammaQuantile(u, shape) * scale
  };
}

/**
 * One keyed score path for a game.
 * @param {{home, away, home_spread, total, season, week, neutral?}} game  (gameFor's shape)
 * @param {number} key   a keyedSeed(...) value; the same key always gives the same path
 * @param {object} [params] scoreModelAt(game.season, game.week), passed in for loops
 */
export function sampleGameScript(game, key, params = scoreModelAt(game.season, game.week)) {
  if (!params) return null;
  const s = game.home_spread, T = game.total;
  const bucket = spreadBucket(s);
  const b = params.buckets[bucket];
  const ih = impliedPoints(s, T), ia = impliedPoints(-s, T);
  const z1 = keyedNormal(key, 0);
  const z2 = b.rho * z1 + Math.sqrt(1 - b.rho * b.rho) * keyedNormal(key, 1);
  const hp = pointsQuantile(clampU(normalCdf(z1)), ih, b.sd);
  const ap = pointsQuantile(clampU(normalCdf(z2)), ia, b.sd);
  const quarters = (pts, mu, base) => {
    const shape = (Math.max(1, mu) / b.sd) ** 2 / 4;
    const g = [0, 1, 2, 3].map(i => gammaQuantile(keyedUniform(key, base + i), shape));
    const sum = g.reduce((x, y) => x + y, 0);
    const q = g.map(v => (sum > 0 ? pts * v / sum : pts / 4));
    q[3] = pts - q[0] - q[1] - q[2];               // exact sum, no float drift
    if (q[3] < 0) { q[2] += q[3]; q[3] = 0; }
    return q;
  };
  const hq = quarters(hp, ih, 10), aq = quarters(ap, ia, 20);
  const mu = -s, sigma = b.margin_sd;
  const win = [normalCdf(mu / sigma)];
  let mh = 0;
  for (let q = 0; q < 3; q++) {
    mh += hq[q] - aq[q];
    const rest = 1 - (q + 1) / 4;
    win.push(normalCdf((mh + mu * rest) / (sigma * Math.sqrt(rest))));
  }
  const margin = hp - ap;
  win.push(margin > 0 ? 1 : margin < 0 ? 0 : 0.5);
  return {
    season: game.season, week: game.week, home_spread: s, total_line: T, bucket,
    home: { team: game.home, implied: ih, points: hp, quarters: hq },
    away: { team: game.away, implied: ia, points: ap, quarters: aq },
    total: hp + ap, margin, win_prob_home: win
  };
}

/**
 * The game a team plays in (season, week), as the sampler's input, from its line in
 * game_lines (historical close, or ESPN look-ahead). Null without a line. The earlier
 * power-rating fallback was dropped (an unmeasured second spread producer).
 */
export function gameFor(season, week, team) {
  const line = row(`SELECT team, opponent, home, COALESCE(closing_spread, spread) AS spread,
                           COALESCE(closing_total, total) AS total, COALESCE(neutral_site, 0) AS neutral, source
                      FROM game_lines WHERE season = ? AND week = ? AND team = ?`, season, week, team);
  if (line && line.spread != null && line.total != null && line.opponent) {
    const isHome = !!line.home;
    return { season, week, home: isHome ? team : line.opponent, away: isHome ? line.opponent : team,
      home_spread: isHome ? line.spread : -line.spread, total: line.total, neutral: !!line.neutral,
      source: 'line', line_source: line.source };
  }
  return null;
}
