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
import { PPR, scoreLine } from './scoring.js';
import { cholesky, correlatedNormals, normalCdf, mean } from './stats-util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS correlation_estimates (
    key TEXT PRIMARY KEY,       -- e.g. 'QB|WR|team'
    correlation REAL,
    pairs INTEGER,
    fitted_at TEXT
  );
`);

const POS = ['QB', 'RB', 'WR', 'TE'];
// Below this many observed pairs an archetype estimate is not worth keeping.
const MIN_PAIRS = 200;

/* ----------------------------------------------------------- estimation */

/**
 * Fit archetype correlations from historical weekly boxscores.
 *
 * Correlation is measured on *residuals* — each player's score minus his own mean —
 * because otherwise the estimate is dominated by the fact that good players outscore
 * bad ones every week, which is not correlation in any useful sense.
 */
export function fitCorrelations({ scoring = PPR, minGames = 6 } = {}) {
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
export function correlatedSampler(players, sortedSamples) {
  const L = cholesky(correlationMatrix(players));
  const n = players.length;
  return () => {
    const z = correlatedNormals(L);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = sortedSamples[i];
      if (!s?.length) { out[i] = 0; continue; }
      const u = normalCdf(z[i]);
      out[i] = s[Math.min(s.length - 1, Math.max(0, Math.floor(u * s.length)))];
    }
    return out;
  };
}

/** Everything we have fitted, for display. */
export function correlationTable() {
  return rows('SELECT key, correlation, pairs, fitted_at FROM correlation_estimates ORDER BY correlation DESC')
    .map(r => {
      const [a, b, rel] = r.key.split('|');
      return { pair: `${a}-${b}`, relationship: rel === 'team' ? 'same team' : 'opponents', ...r };
    });
}
