/**
 * Player correlation.
 *
 * Fantasy scores are not independent. A quarterback and his top receiver score on the
 same
 * plays. Two backs in one committee eat each other's carries. A shootout lifts everyone
 * on both sidelines. Sampling players independently — which is what the app did before —
 * understates the spread of a lineup badly, because it quietly assumes all that shared
 * variance cancels out.
 *
 * Correlations are estimated per *archetype* rather than per player pair:
 *
 *     (position A, position B, same team | opponents)
 *
 * A specific pair of players might share a dozen games, which is far too few to estimate
 * a correlation from. Every QB-WR pair in the league across four seasons is tens of
 * thousands of observations, and the archetype is what actually generalises to a pair
 * that has never played together — which is the case that matters, since rosters change.
 *
 * Correlated draws use a Gaussian copula: correlated normals are pushed through the
 * normal CDF to get correlated uniforms, and each uniform indexes that player's own
 * empirical distribution. The dependence structure comes from the copula, the shape of
 * each player's outcomes stays exactly as the projection model produced it.
 */
import { db, rows } from '../db/index.js';
import { servedTableState } from './data-freshness.js';
import { previewUnconfirmed } from './preview-mode.js';
import { PPR, scoreLine } from './scoring.js';
import { cholesky, correlatedNormals, keyedNormal, keyedSeed, normalCdf, randn, mean } from './stats-util.js';

const POS = ['QB', 'RB', 'WR', 'TE'];
// Below this many observed pairs an archetype estimate is not worth keeping.
const MIN_PAIRS = 200;

/* ----------------------------------------------------------- estimation */

/**
 * Every player-week with a standardised residual `z` (score minus his own mean, over
 * his own SD), grouped by NFL game: `${season}|${week}|${fixture}` -> rows. Players with
 * fewer than `minGames` weeks are left out. The one reader of the weekly log for
 * dependence work: fitCorrelations and the GAME-SHOCKS tail measurement share it.
 */
export function sameGameResiduals({ scoring = PPR, minGames = 6 } = {}) {
  const log = rows(`SELECT u.player_id, u.season, u.week, u.team, u.opponent, p.position,
                           u.passing_yards, u.passing_tds, u.interceptions,
                           u.rushing_yards, u.rushing_tds,
                           u.receptions, u.receiving_yards, u.receiving_tds, u.fumbles_lost
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE p.position IN ('QB','RB','WR','TE') AND u.team IS NOT NULL`);

  // Per-player mean and spread, for residuals.
  const byPlayer = new Map();
  const scored = log.map(u => ({ ...u, pts: Number(scoreLine(u, scoring)) }));
  for (const u of scored) {
    const a = byPlayer.get(u.player_id) ?? { pts: [] };
    a.pts.push(u.pts);
    byPlayer.set(u.player_id, a);
  }
  for (const a of byPlayer.values()) {
    a.mean = mean(a.pts);
    a.sd = Math.sqrt(mean(a.pts.map(x => (x - a.mean) ** 2))) || 1;
  }

  // Index by game so we only pair players who were actually on the same field.
  const games = new Map();   // `${season}|${week}|${gameKey}` -> rows
  for (const u of scored) {
    const p = byPlayer.get(u.player_id);
    if (p.pts.length < minGames) continue;
    // A stable key for the fixture regardless of which side we are looking from.
    const fixture = [u.team, u.opponent].sort().join('-');
    const k = `${u.season}|${u.week}|${fixture}`;
    (games.get(k) ?? games.set(k, []).get(k)).push({ ...u, z: (u.pts - p.mean) / p.sd });
  }

  return games;
}

/**
 * Fit archetype correlations from historical weekly boxscores.
 *
 * Correlation is measured on *residuals* — each player's score minus his own mean —
 * because otherwise the estimate is dominated by the fact that good players outscore
 * bad ones every week, which is not correlation in any useful sense.
 */
export function fitCorrelations({ scoring = PPR, minGames = 6 } = {}) {
  const games = sameGameResiduals({ scoring, minGames });

  const buckets = new Map();  // key -> { sxy, sxx, syy, n }
  const add = (key, a, b) => {
    const s = buckets.get(key) ?? { sxy: 0, sxx: 0, syy: 0, n: 0 };
    s.sxy += a * b; s.sxx += a * a; s.syy += b * b; s.n++;
    buckets.set(key, s);
  };

  for (const list of games.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.player_id === b.player_id) continue;
        const rel = a.team === b.team ? 'team' : 'opp';
        // Sort the position pair so QB|WR and WR|QB land in one bucket.
        const [p1, p2] = [a.position, b.position].sort();
        const key = `${p1}|${p2}|${rel}`;
        // Residuals are already standardised, so this is a correlation directly.
        if (a.position <= b.position) add(key, a.z, b.z);
        else add(key, b.z, a.z);
      }
    }
  }

  const out = [];
  const stmt = db.prepare(`INSERT INTO correlation_estimates (key, correlation, pairs, fitted_at)
    VALUES (?,?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET correlation=excluded.correlation, pairs=excluded.pairs, fitted_at=excluded.fitted_at`);
  for (const [key, s] of buckets) {
    if (s.n < MIN_PAIRS) continue;
    const r = s.sxx && s.syy ? s.sxy / Math.sqrt(s.sxx * s.syy) : 0;
    // Guard against a degenerate estimate making the matrix unusable later.
    const clamped = Math.max(-0.6, Math.min(0.85, r));
    stmt.run(key, clamped, s.n);
    out.push({ key, correlation: +clamped.toFixed(4), pairs: s.n });
  }
  _cache = null;
  return out.sort((a, b) => b.correlation - a.correlation);
}

/* -------------------------------------------------------------- lookup */

let _cache = null;
export function clearCorrelationCache() { _cache = null; }

function table() {
  if (_cache) return _cache;
  _cache = new Map(rows('SELECT key, correlation FROM correlation_estimates').map(r => [r.key, r.correlation]));
  return _cache;
}

/** Fallbacks used when an archetype was never fitted, so the matrix is always complete. */
const DEFAULTS = { team: 0.05, opp: 0.02 };

/**
 * What the correlated draws are built from, for a surface that shows a spread, a
 * ceiling or an odd to carry beside it. The state comes from the one entry for
 * `correlation_estimates` (data-freshness.js servedTableEntry): a coverage rule, "fitted
 * rows exist", not an age. `fitCorrelations` is the store's only writer and only
 * `POST /api/model/sync` calls it, so on an install where nobody ran the sync the store
 * is empty and every archetype is DEFAULTS. `fallback` is that pair of defaults when the
 * store holds nothing, and null otherwise — an archetype below MIN_PAIRS still falls
 * back alone, which the row count does not show.
 */
export function correlationBasis() {
  const s = servedTableState('correlation_estimates');
  return {
    ...s,
    writer: 'correlation.js#fitCorrelations, called only by POST /api/model/sync',
    fallback: s.rows === 0 ? { ...DEFAULTS } : null
  };
}

/**
 * Correlation between two players in one week.
 * Returns 0 when they are not in the same game — different fixtures are independent
 * for our purposes, which is very nearly true.
 */
export function pairCorrelation(a, b) {
  if (!a.team || !b.team) return 0;
  const sameGame = a.team === b.team || a.opponent === b.team;
  if (!sameGame) return 0;
  const rel = a.team === b.team ? 'team' : 'opp';
  const [p1, p2] = [a.position, b.position].sort();
  const base = table().get(`${p1}|${p2}|${rel}`) ?? DEFAULTS[rel];

  // The fitted archetype pools every pass catcher on a roster, so it averages a true
  // stack partner together with a WR4 who sees two targets a game. Scaling by how much
  // of the passing game actually runs through the receiver recovers that: a QB's fate
  // is tied to his WR1 and almost unrelated to his WR4.
  //
  // OPEN, per the 2026-09-17 audit, not changed here because it moves every stack
  // ceiling and title odd: (a) the scale `target_share / 0.19` and its clamps
  // [0.3, 2.2] appear in no fit — the audit measured the realised QB-WR1 copula
  // correlation at ~0.22 against an observed 0.3155 in this repo's own data (2021+,
  // n=2,174), partly because a Gaussian copula on skewed marginals attenuates the
  // input rho; (b) the scaling touches QB-catcher pairs only, so two receivers each
  // tied to the same QB are left at the pooled WR-WR estimate (~0.01) and the matrix
  // is internally incoherent. Fit the QB-catcher and catcher-catcher correlations
  // on WR1/WR2/WR3 strata directly, and invert the copula attenuation so the
  // REALISED correlation matches the target.
  if (rel === 'team' && (a.position === 'QB') !== (b.position === 'QB')) {
    const catcher = a.position === 'QB' ? b : a;
    if (['WR', 'TE'].includes(catcher.position) && catcher.target_share != null) {
      const scale = Math.max(0.3, Math.min(2.2, catcher.target_share / 0.19));
      return Math.max(-0.6, Math.min(0.85, base * scale));
    }
  }
  return base;
}

/**
 * Correlation matrix for a set of players in one week.
 * @param players [{ id, position, team, opponent }]
 */
export function correlationMatrix(players) {
  const n = players.length;
  const m = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const r = pairCorrelation(players[i], players[j]);
      m[i][j] = r; m[j][i] = r;
    }
  }
  return m;
}

/* ------------------------------------------------------- game shocks */

/**
 * GAME-SHOCKS (ONE-PLAN §4d block 1; pre-registration
 * docs/tdd/2026-09-25-game-shocks.tdd.md): degrees of freedom of the grouped-t copula.
 * Fixed at 6, not fitted and not swept; a different value is a new registration.
 */
export const GAME_SHOCK_NU = 6;

/**
 * GRIDIRON_GAME_SHOCKS: '1' on, '0' off (vetoes preview), unset = off unless preview
 * mode. Read by the season sim (the one title-odds producer) and league-world.js's
 * snapshot key; no other sampler caller passes the shock.
 */
export const GAME_SHOCKS_ENV = 'GRIDIRON_GAME_SHOCKS';
const GAME_SHOCKS_PREVIEW_REASON =
  'Season sim shares one shock per NFL game in the copula (GAME-SHOCKS); default off until the pre-registered tail check passes on local data';

/** { on, preview }: read per call, so a test or a run can flip it. */
export function gameShocksFlag() {
  const v = process.env[GAME_SHOCKS_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/** What a sim result says about the shock: null when off (the result is unchanged). */
export function gameShockFields(flag) {
  if (!flag.on) return null;
  return { game_shocks: { nu: GAME_SHOCK_NU, ...(flag.preview ? { preview: true, preview_reason: GAME_SHOCKS_PREVIEW_REASON } : {}) } };
}

/**
 * Student-t CDF for a positive integer `nu` (Abramowitz & Stegun 26.7.3 / 26.7.4, the
 * closed-form series in theta = atan(x / sqrt(nu))). A non-integer nu is rounded.
 */
export function studentTCdf(x, nu) {
  const n = Math.max(1, Math.round(nu));
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const theta = Math.atan(x / Math.sqrt(n));
  const c2 = Math.cos(theta) ** 2;
  let a;
  if (n % 2 === 1) {
    // Odd: A = (2/pi)(theta + sin cos (1 + 2/3 c2 + 2.4/(3.5) c2^2 + ...)), n - 3 over 2 terms.
    let term = 1, sum = n > 1 ? 1 : 0;
    for (let k = 3; k <= n - 2; k += 2) { term *= ((k - 1) / k) * c2; sum += term; }
    a = (2 / Math.PI) * (theta + Math.sin(theta) * Math.cos(theta) * sum);
  } else {
    // Even: A = sin (1 + 1/2 c2 + 1.3/(2.4) c2^2 + ...), (n - 2) / 2 extra terms.
    let term = 1, sum = 1;
    for (let k = 2; k <= n - 2; k += 2) { term *= ((k - 1) / k) * c2; sum += term; }
    a = Math.sin(theta) * sum;
  }
  return Math.min(1, Math.max(0, (1 + a) / 2));
}

/**
 * One game's shock in one draw: 1 / sqrt(W), W ~ chi2(nu) / nu, keyed by
 * (key, fixture, counter). Every player in that game shares it, which is what makes
 * them extreme together. `key` null draws W off the shared stream instead.
 */
export function gameShockScale(key, fixture, counter, nu = GAME_SHOCK_NU) {
  const n = Math.max(1, Math.round(nu));
  let w = 0;
  for (let j = 0; j < n; j++) {
    const z = key == null ? randn() : keyedNormal(keyedSeed(key, 'game-shock', fixture, j), counter);
    w += z * z;
  }
  return 1 / Math.sqrt(Math.max(w / n, 1e-12));
}

/** The NFL game a player is in, side-independent ('BUF-KC' from either sideline); null without a team. */
const fixtureOf = p => (p?.team ? [p.team, p.opponent ?? ''].sort().join('-') : null);

/**
 * Measurement helper (M1): share of `draws` bivariate draws at correlation `rho` where
 * both land above their own `q` quantile, Gaussian (`nu` null) or grouped-t with one
 * shared shock (`nu`). Keyed, so a fixed `key` repeats exactly.
 */
export function simulatedJointExceedance(rho, { q = 0.9, nu = null, draws = 20000, key = 1 } = {}) {
  const r = Math.max(-0.99, Math.min(0.99, Number(rho) || 0));
  const s = Math.sqrt(1 - r * r);
  let both = 0;
  for (let i = 0; i < draws; i++) {
    const z1 = keyedNormal(keyedSeed(key, 'jx', 1), i);
    const z2 = r * z1 + s * keyedNormal(keyedSeed(key, 'jx', 2), i);
    let u1, u2;
    if (nu == null) { u1 = normalCdf(z1); u2 = normalCdf(z2); }
    else {
      const g = gameShockScale(key, 'jx', i, nu);
      u1 = studentTCdf(z1 * g, nu); u2 = studentTCdf(z2 * g, nu);
    }
    if (u1 > q && u2 > q) both++;
  }
  return both / draws;
}

/**
 * M1's empirical side: from `sameGameResiduals` output, per group, the share of
 * same-game pairs where BOTH players are above their own `q` quantile of z, the pair
 * count, and the mean pairwise correlation of z (what the sampler is compared at).
 * Groups: `qb_wr_team` (a QB and a WR on one team) and `same_game` (every pair in one
 * game). Only seasons >= `since` count, for the quantiles and the pairs alike.
 */
export function tailCoexceedance(games, { q = 0.9, since = 2021 } = {}) {
  const zs = new Map();
  for (const list of games.values()) for (const u of list) {
    if (u.season < since) continue;
    (zs.get(u.player_id) ?? zs.set(u.player_id, []).get(u.player_id)).push(u.z);
  }
  const cut = new Map([...zs].map(([id, a]) => {
    const sorted = [...a].sort((x, y) => x - y);
    // Strictly above this cut is the top (1 - q) share: 1 of 10 values at q = 0.9.
    return [id, sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]];
  }));
  const acc = { qb_wr_team: { pairs: 0, both: 0, sxy: 0, sxx: 0, syy: 0 }, same_game: { pairs: 0, both: 0, sxy: 0, sxx: 0, syy: 0 } };
  const add = (g, a, b) => {
    g.pairs++; g.sxy += a.z * b.z; g.sxx += a.z * a.z; g.syy += b.z * b.z;
    if (a.z > cut.get(a.player_id) && b.z > cut.get(b.player_id)) g.both++;
  };
  for (const list of games.values()) {
    const cur = list.filter(u => u.season >= since);
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
      const a = cur[i], b = cur[j];
      if (a.player_id === b.player_id) continue;
      add(acc.same_game, a, b);
      const pos = [a.position, b.position].sort().join('|');
      if (a.team === b.team && pos === 'QB|WR') add(acc.qb_wr_team, a, b);
    }
  }
  const out = {};
  for (const [k, g] of Object.entries(acc)) {
    out[k] = {
      pairs: g.pairs,
      rate: g.pairs ? g.both / g.pairs : null,
      rho: g.sxx && g.syy ? g.sxy / Math.sqrt(g.sxx * g.syy) : 0
    };
  }
  return out;
}

/**
 * The pre-registered M1 bar for one group: the shocks-on rate is closer to the
 * empirical rate than shocks-off, and not above it by more than 25% relative.
 */
export function gameShockVerdict({ empirical, off, on }) {
  if (!(empirical > 0)) return { pass: false, reason: 'no empirical rate' };
  const closer = Math.abs(on - empirical) < Math.abs(off - empirical);
  const overshoot = (on - empirical) / empirical;
  if (!closer) return { pass: false, reason: 'shocks-on is not closer to the empirical rate' };
  if (overshoot > 0.25) return { pass: false, reason: `overshoots the empirical rate by ${(overshoot * 100).toFixed(0)}%` };
  return { pass: true, reason: 'closer, within +25%' };
}

/**
 * A sampler that draws correlated weekly outcomes for a fixed set of players.
 *
 * Each player supplies a sorted array of possible outcomes (from the projection model).
 * The copula picks *which* outcome each player gets, jointly — so a good week for a
 * quarterback tends to select a good week for his receiver.
 *
 * The Cholesky factor is computed once and reused across every draw, which is what
 * makes a ten-thousand-run season simulation affordable.
 */
export function correlatedSampler(players, sortedSamples, keys = null, { gameShock = null } = {}) {
  const L = cholesky(correlationMatrix(players));
  const n = players.length;
  // GAME-SHOCKS: with `gameShock` ({ nu, key }), each NFL game's players share one
  // chi2(nu)/nu mixing variable per counter (grouped-t copula). Marginals are unchanged
  // (z / sqrt(W) is t(nu), read through the t CDF); joint extremes inside a game rise.
  // A player with no team is his own group. Null: today's Gaussian draws exactly.
  const shock = gameShock ? { nu: Math.max(1, Math.round(gameShock.nu ?? GAME_SHOCK_NU)), key: keys ? gameShock.key ?? null : null } : null;
  const groups = shock ? players.map((p, i) => fixtureOf(p) ?? `solo-${keys ? keys[i] : i}`) : null;
  const uniform = (z, i, scales) => {
    if (!shock) return normalCdf(z);
    const g = groups[i];
    if (!scales.has(g)) scales.set(g, gameShockScale(shock.key, g, scales.counter, shock.nu));
    return studentTCdf(z * scales.get(g), shock.nu);
  };
  // `keys` (one per player) makes each draw identity-addressed: sample(counter) gives
  // player i the independent normal keyedNormal(keys[i], counter) before the Cholesky
  // mix, so the same player in the same counter gets the same football however the
  // list around him changes. Without keys, draws come off the shared stream as before.
  const sample = (counter = 0) => {
    const z = correlatedNormals(L, keys ? keys.map(k => keyedNormal(k, counter)) : null);
    const out = new Float64Array(n);
    const scales = shock ? Object.assign(new Map(), { counter }) : null;
    for (let i = 0; i < n; i++) {
      const s = sortedSamples[i];
      if (!s?.length) { out[i] = 0; continue; }
      const u = uniform(z[i], i, scales);
      out[i] = s[Math.min(s.length - 1, Math.max(0, Math.floor(u * s.length)))];
    }
    return out;
  };
  // True when the correlation matrix could not be factorised and the draws are
  // silently independent. Callers that report spreads or odds should surface it.
  sample.uncorrelated = Boolean(L.fallbackIdentity);
  sample.gameShock = shock ? { nu: shock.nu } : null;
  return sample;
}

/** Everything we have fitted, for display. */
export function correlationTable() {
  return rows('SELECT key, correlation, pairs, fitted_at FROM correlation_estimates ORDER BY correlation DESC')
    .map(r => {
      const [a, b, rel] = r.key.split('|');
      return { pair: `${a}-${b}`, relationship: rel === 'team' ? 'same team' : 'opponents', ...r };
    });
}
