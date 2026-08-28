/**
 * Correlation between the stats that actually trade as props — and what that
 * says about same-game parlay pricing.
 *
 * `correlation.js` already fits archetype correlations, but on FANTASY POINTS.
 * That is the right unit for a lineup simulation and the wrong one here: no
 * book prices "fantasy points over 14.5". The markets that exist are passing
 * yards, rushing yards, receiving yards, receptions and anytime touchdown, and
 * the correlation between *those* is what decides whether a same-game parlay is
 * mispriced.
 *
 * WHY THIS IS THE ONE MODELLING ANGLE WORTH PURSUING HERE:
 *
 * Every attempt to out-predict the market on sides and totals has failed — 0 of
 * 21 component models beat 15,096 closing lines, three independent ways. This
 * edge does not require beating the market on any single leg. A book can price
 * every individual prop perfectly fairly and still misprice the combination,
 * because SGP pricing is usually a crude correlation haircut — a blanket
 * multiplier or a rules table — rather than a real joint distribution. If our
 * joint distribution is better than their haircut, that gap is the edge, and it
 * survives even when our marginals are no better than theirs.
 *
 * Same evidence bar as everything else: this module MEASURES a disagreement. It
 * does not assert that the disagreement is profitable. That requires forward
 * CLV against real SGP prices, exactly like every other candidate signal.
 */
import { db, rows, run } from '../db/index.js';
import { cholesky, correlatedNormals, normalCdf } from './stats-util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS prop_correlation_estimates (
    key TEXT PRIMARY KEY,          -- 'passing_yards|QB|receiving_yards|WR|team'
    stat_a TEXT, position_a TEXT, stat_b TEXT, position_b TEXT, relation TEXT,
    correlation REAL, pairs INTEGER, fitted_at TEXT
  );
`);

/** Prop market → the column in player_week_usage it settles against. */
export const MARKET_STAT = {
  player_pass_yds: 'passing_yards',
  player_rush_yds: 'rushing_yards',
  player_reception_yds: 'receiving_yards',
  player_receptions: 'receptions',
  player_anytime_td: 'anytime_td'
};

const STATS = ['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions', 'anytime_td'];
const POS = ['QB', 'RB', 'WR', 'TE'];
// Below this an archetype estimate is noise, not a correlation.
const MIN_PAIRS = 150;

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Which stats a position is even quoted on. Fitting QB receiving yards against
 * anything would burn sample on an archetype no book will ever offer, and would
 * pollute the table with near-zero correlations that look like real findings.
 */
const QUOTED = {
  QB: ['passing_yards', 'rushing_yards', 'anytime_td'],
  RB: ['rushing_yards', 'receiving_yards', 'receptions', 'anytime_td'],
  WR: ['receiving_yards', 'receptions', 'anytime_td'],
  TE: ['receiving_yards', 'receptions', 'anytime_td']
};

/* --------------------------------------------------------------- fitting */

/**
 * Fit correlations on RESIDUALS — each observation minus that player's own mean
 * for that stat. Without this the estimate is dominated by the fact that high-
 * volume players post high numbers every week, which is not correlation in any
 * sense a parlay cares about. What we want is: when this QB throws for more than
 * he usually does, does this receiver also beat his own usual number?
 */
export function fitPropCorrelations({ minGames = 6 } = {}) {
  const log = rows(`SELECT u.player_id, u.season, u.week, u.team, u.opponent, p.position,
                           u.passing_yards, u.rushing_yards, u.receiving_yards, u.receptions,
                           u.rushing_tds, u.receiving_tds
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE p.position IN ('QB','RB','WR','TE') AND u.team IS NOT NULL`);

  // Per player+stat mean, for residuals. Players below minGames are dropped:
  // a mean from two games is not a baseline.
  const totals = new Map();
  const valueOf = (row, stat) => stat === 'anytime_td'
    ? ((row.rushing_tds ?? 0) + (row.receiving_tds ?? 0) > 0 ? 1 : 0)
    : (row[stat] ?? 0);

  for (const row of log) {
    for (const stat of STATS) {
      if (!QUOTED[row.position]?.includes(stat)) continue;
      const k = `${row.player_id}|${stat}`;
      const t = totals.get(k) ?? { sum: 0, n: 0 };
      t.sum += valueOf(row, stat); t.n++;
      totals.set(k, t);
    }
  }
  const meanOf = (playerId, stat) => {
    const t = totals.get(`${playerId}|${stat}`);
    return t && t.n >= minGames ? t.sum / t.n : null;
  };

  // Index every game so same-game pairs can be formed without an O(n^2) scan.
  const byGame = new Map();
  for (const row of log) {
    const g = `${row.season}|${row.week}`;
    if (!byGame.has(g)) byGame.set(g, []);
    byGame.get(g).push(row);
  }

  const acc = new Map();
  const add = (key, x, y) => {
    const a = acc.get(key) ?? { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.syy += y * y; a.sxy += x * y;
    acc.set(key, a);
  };

  for (const game of byGame.values()) {
    for (let i = 0; i < game.length; i++) {
      for (let j = i + 1; j < game.length; j++) {
        const A = game[i], B = game[j];
        const sameTeam = A.team === B.team;
        const opposed = A.team === B.opponent || B.team === A.opponent;
        if (!sameTeam && !opposed) continue;      // unrelated game, no relation to fit
        const relation = sameTeam ? 'team' : 'opp';

        for (const statA of QUOTED[A.position] ?? []) {
          const mA = meanOf(A.player_id, statA);
          if (mA == null) continue;
          const rA = valueOf(A, statA) - mA;
          for (const statB of QUOTED[B.position] ?? []) {
            const mB = meanOf(B.player_id, statB);
            if (mB == null) continue;
            const rB = valueOf(B, statB) - mB;
            // Canonical ordering so (QB,pass ↔ WR,rec) and its mirror land in
            // one bucket rather than two half-sized ones.
            const left = `${statA}|${A.position}`, right = `${statB}|${B.position}`;
            const [k1, k2, v1, v2] = left <= right ? [left, right, rA, rB] : [right, left, rB, rA];
            add(`${k1}|${k2}|${relation}`, v1, v2);
          }
        }
      }
    }
  }

  const now = new Date().toISOString();
  let stored = 0;
  const fitted = [];
  for (const [key, a] of acc) {
    if (a.n < MIN_PAIRS) continue;
    const cov = a.sxy / a.n - (a.sx / a.n) * (a.sy / a.n);
    const vx = a.sxx / a.n - (a.sx / a.n) ** 2;
    const vy = a.syy / a.n - (a.sy / a.n) ** 2;
    if (!(vx > 0) || !(vy > 0)) continue;
    const corr = r4(cov / Math.sqrt(vx * vy));
    const [sa, pa, sb, pb, relation] = key.split('|');
    run(`INSERT INTO prop_correlation_estimates
      (key, stat_a, position_a, stat_b, position_b, relation, correlation, pairs, fitted_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET correlation=excluded.correlation,
        pairs=excluded.pairs, fitted_at=excluded.fitted_at`,
      key, sa, pa, sb, pb, relation, corr, a.n, now);
    fitted.push({ key, correlation: corr, pairs: a.n });
    stored++;
  }
  _cache = null;
  return { archetypes: stored, considered: acc.size, min_pairs: MIN_PAIRS,
    strongest: fitted.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation)).slice(0, 12) };
}

let _cache = null;
function table() {
  if (!_cache) {
    _cache = new Map(rows('SELECT key, correlation FROM prop_correlation_estimates')
      .map(r => [r.key, r.correlation]));
  }
  return _cache;
}
export function clearPropCorrelationCache() { _cache = null; }

/** Correlation between two specific prop legs, or 0 when the archetype was never fit. */
export function propPairCorrelation(a, b) {
  if (a.player_id != null && a.player_id === b.player_id) {
    // Same player, two different stats — a receptions leg and a receiving-yards
    // leg on one receiver are the same underlying game, and treating them as
    // independent is the single biggest error in naive SGP pricing.
    return samePlayerCorrelation(a.stat, b.stat);
  }
  const relation = a.team && b.team ? (a.team === b.team ? 'team' : 'opp') : 'team';
  const left = `${a.stat}|${a.position}`, right = `${b.stat}|${b.position}`;
  const key = left <= right ? `${left}|${right}|${relation}` : `${right}|${left}|${relation}`;
  return table().get(key) ?? 0;
}

let _sameCache = null;
/**
 * Within-player correlation between two stats, fit separately because it is a
 * different question from the cross-player case: one player's receptions and
 * receiving yards on the same afternoon are near-mechanically linked.
 */
export function samePlayerCorrelation(statA, statB) {
  if (statA === statB) return 1;
  if (!_sameCache) {
    _sameCache = new Map();
    const log = rows(`SELECT u.player_id, p.position, u.passing_yards, u.rushing_yards,
                             u.receiving_yards, u.receptions, u.rushing_tds, u.receiving_tds
                      FROM player_week_usage u JOIN players p ON p.id = u.player_id
                      WHERE p.position IN ('QB','RB','WR','TE')`);
    const byPlayer = new Map();
    for (const row of log) {
      if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, []);
      byPlayer.get(row.player_id).push(row);
    }
    const val = (row, stat) => stat === 'anytime_td'
      ? ((row.rushing_tds ?? 0) + (row.receiving_tds ?? 0) > 0 ? 1 : 0) : (row[stat] ?? 0);

    const acc = new Map();
    for (const games of byPlayer.values()) {
      if (games.length < 6) continue;
      for (let i = 0; i < STATS.length; i++) {
        for (let j = i + 1; j < STATS.length; j++) {
          const sa = STATS[i], sb = STATS[j];
          const pos = games[0].position;
          if (!QUOTED[pos]?.includes(sa) || !QUOTED[pos]?.includes(sb)) continue;
          const mA = games.reduce((s, g) => s + val(g, sa), 0) / games.length;
          const mB = games.reduce((s, g) => s + val(g, sb), 0) / games.length;
          const key = `${sa}|${sb}`;
          const a = acc.get(key) ?? { n: 0, sxy: 0, sxx: 0, syy: 0 };
          for (const g of games) {
            const x = val(g, sa) - mA, y = val(g, sb) - mB;
            a.n++; a.sxy += x * y; a.sxx += x * x; a.syy += y * y;
          }
          acc.set(key, a);
        }
      }
    }
    for (const [key, a] of acc) {
      if (a.n < MIN_PAIRS || !(a.sxx > 0) || !(a.syy > 0)) continue;
      _sameCache.set(key, r4(a.sxy / Math.sqrt(a.sxx * a.syy)));
    }
  }
  return _sameCache.get(`${statA}|${statB}`) ?? _sameCache.get(`${statB}|${statA}`) ?? 0;
}

/* ------------------------------------------------------- SGP pricing */

/** Inverse standard normal CDF (Acklam), needed to turn a leg probability into a threshold. */
function probit(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Nudge a correlation matrix back to positive-definite so Cholesky can't fail. */
function conditioned(matrix) {
  const n = matrix.length;
  for (let ridge = 0; ridge <= 0.5; ridge += 0.02) {
    const m = matrix.map((row, i) => row.map((v, j) => (i === j ? v + ridge : v * (1 - ridge))));
    const L = cholesky(m);
    if (L) return L;
  }
  return null;
}

/**
 * Price a same-game parlay against the joint distribution instead of assuming
 * independence.
 *
 * @param legs [{player_id, player, team, position, stat, side:'over'|'under', probability}]
 *   `probability` is the marginal chance that leg hits — take it from the book's
 *   own no-vig price when the question is "does the book's correlation
 *   assumption hold", which isolates the correlation from any disagreement
 *   about the individual legs.
 */
export function sgpAnalysis({ legs, trials = 40000 } = {}) {
  const usable = (legs ?? []).filter(l => Number.isFinite(l.probability) && l.probability > 0 && l.probability < 1);
  if (usable.length < 2) return { error: 'at least two priced legs are required' };

  const n = usable.length;
  const independent = usable.reduce((p, l) => p * l.probability, 1);

  const matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i === j) return 1;
      let rho = propPairCorrelation(usable[i], usable[j]) ?? 0;
      // An 'under' is the mirror of the same underlying quantity, so a positive
      // co-movement between two stats becomes a negative one between an over
      // and an under. Missing this flips the sign of the whole adjustment.
      if ((usable[i].side === 'under') !== (usable[j].side === 'under')) rho = -rho;
      return Math.max(-0.95, Math.min(0.95, rho));
    }));

  const L = conditioned(matrix);
  if (!L) return { error: 'correlation matrix could not be conditioned' };

  // Each leg hits when its latent normal clears the threshold matching its own
  // marginal probability, so every leg keeps exactly the probability it was
  // given and only the dependence between them comes from the copula.
  const thresholds = usable.map(l => probit(1 - l.probability));
  let hits = 0;
  for (let t = 0; t < trials; t++) {
    const z = correlatedNormals(L);
    let all = true;
    for (let i = 0; i < n; i++) { if (z[i] <= thresholds[i]) { all = false; break; } }
    if (all) hits++;
  }
  const correlated = hits / trials;

  const toAmerican = p => (p <= 0 || p >= 1 ? null
    : p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));

  return {
    legs: usable.map(l => ({ player: l.player, stat: l.stat, side: l.side,
      probability: r4(l.probability) })),
    independent_probability: r4(independent),
    correlated_probability: r4(correlated),
    // >1 means the legs move together and a naive product UNDERSTATES the parlay;
    // <1 means they compete and independence overstates it.
    correlation_multiplier: independent > 0 ? r4(correlated / independent) : null,
    fair_odds_independent: toAmerican(independent),
    fair_odds_correlated: toAmerican(correlated),
    pairwise: usable.flatMap((a, i) => usable.slice(i + 1).map((b, k) => ({
      a: `${a.player ?? a.position} ${a.stat} ${a.side}`,
      b: `${b.player ?? b.position} ${b.stat} ${b.side}`,
      correlation: r4(matrix[i][i + 1 + k])
    }))),
    trials,
    note: 'Marginals are taken as given; only the dependence between legs is modelled. ' +
      'A multiplier far from 1 is where a blanket book haircut is most likely to be wrong — ' +
      'it is a measured disagreement, not yet a proven edge.'
  };
}

export function propCorrelationTable({ limit = 40 } = {}) {
  return rows(`SELECT key, stat_a, position_a, stat_b, position_b, relation, correlation, pairs
               FROM prop_correlation_estimates
               ORDER BY ABS(correlation) DESC LIMIT ?`, limit);
}

export { normalCdf };
