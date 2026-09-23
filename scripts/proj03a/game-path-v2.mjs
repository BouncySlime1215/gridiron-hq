// PROJ-03-a-v2 STUDY CODE: shared game-path sampler. Not a production module; nothing in
// server/ or client/ imports it. Pre-registration: docs/tdd/2026-09-23-proj-03a-v2-game-path.tdd.md.
//
// One seeded path per game. Each team's points are EXACTLY the incumbent baseline,
// Normal(Vegas implied team total, one pooled sd). The only new value is the shared path:
// the two teams' residual z-scores are joined by one pooled correlation rho, and every
// player in the game reads the same keyed path (same key -> same draw).
// v1 (PR #215, declined) fitted per-|spread|-bucket sd, which made CRPS worse: v2 has no buckets.
import { rows } from '../../server/db/index.js';
import { mean, stdev, keyedNormal, keyedSeed } from '../../server/services/stats-util.js';

// Same arithmetic as the private impliedPoints in server/services/gamescript.js.
export const impliedPoints = (spread, total) => total / 2 - spread / 2;

export function pearson(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Scored games, one home row each, closing line preferred, seasons [from, to]. */
export function scoredGames(fromSeason, toSeason) {
  return rows(`SELECT season, week, team AS home, opponent AS away,
                      COALESCE(closing_spread, spread) AS spread,
                      COALESCE(closing_total, total) AS total,
                      team_score AS home_pts, opp_score AS away_pts
                 FROM game_lines
                WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL
                  AND COALESCE(closing_spread, spread) IS NOT NULL
                  AND COALESCE(closing_total, total) IS NOT NULL
                  AND season BETWEEN ? AND ?
                ORDER BY season, week, team`, fromSeason, toSeason);
}

/** Residuals of a game list: points minus implied, home and away. */
export function residuals(games) {
  const h = [], a = [];
  for (const g of games) {
    h.push(g.home_pts - impliedPoints(g.spread, g.total));
    a.push(g.away_pts - impliedPoints(-g.spread, g.total));
  }
  return { h, a };
}

/** Path params from a list of scored games: one pooled sd, one pooled rho. */
export function fitGamePath(games) {
  if (games.length < 100) return null;
  const { h, a } = residuals(games);
  return { sd: stdev([...h, ...a]), rho: Math.max(-0.9, Math.min(0.9, pearson(h, a))), games: games.length };
}

/** The key of one game's path, shared by both teams and every player in the game. */
export const gamePathKey = (season, week, teamA, teamB, draw = 0) =>
  keyedSeed('game-path-v2', season, week, [teamA, teamB].sort().join('-'), draw);

/**
 * One draw of a game's path. `z.home` / `z.away` are the standard-normal team shocks
 * (players condition on these), `points` the team points.
 * `rho` override (e.g. 0) gives the independent pair with common random numbers.
 */
export function sampleGamePath(game, key, params, rho = params.rho) {
  const z1 = keyedNormal(key, 0);
  const z2 = rho * z1 + Math.sqrt(1 - rho * rho) * keyedNormal(key, 1);
  const ih = impliedPoints(game.spread, game.total), ia = impliedPoints(-game.spread, game.total);
  return {
    z: { home: z1, away: z2 },
    points: { home: ih + params.sd * z1, away: ia + params.sd * z2 },
    implied: { home: ih, away: ia }
  };
}
