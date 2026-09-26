/**
 * U4 CONSISTENT-CHIP: whether a Blue chip is a CONSISTENT weekly scorer now, the reader Nick's
 * A.J. Brown rule needs (never-give.js#ajMayMove: 277 moves only for a consistent Blue chip).
 * Rule D, frozen in docs/tdd/U4-CONSISTENT-CHIP-PREREG.md; the backtest
 * (scripts/rnd/u4-consistent-backtest.mjs) and the live reader call these same functions.
 *
 * consistent(i) only when ALL hold (anything missing = not consistent, fails closed):
 *   1. board score >= 83 and the board does not mark him hurt;
 *   2. active: his latest injury report is not Out or Doubtful;
 *   3. the last 6 weeks (1-17) his NFL team played, walking back into last season, all have a game
 *      from him (a missed week, an unknown team or no last season = not consistent);
 *   4. he scored >= his position's starter median M in at least 4 of those 6;
 *   5. next week's calibrated p25 (range-residuals.js#playerDraw at u = 0.25, the app's own player
 *      marginal, k in force) >= his position's starter line L.
 * M and L are last season's (a full season lagged): the top N at the position by points per game
 * (8+ games; N = 10 at QB/RB/TE, 20 at WR); M = the median of their weekly points, L = the N-th's ppg.
 *
 * SERVED_POSITIONS is the pre-registered test's outcome: a position is served only if it passed on its
 * own (docs/tdd/U4-CONSISTENT-CHIP.md). Every other position reads not consistent.
 * It lives under scripts/rnd, not server/, because it is not wired: the test failed (study code stays
 * out of production modules). If a later, committed addendum passes, it moves to server/services/campaign.
 *
 * NOT WIRED: the pre-registered test failed (too few consistent players to show a better floor), so
 * never-give.js#ajMayMove still gets no reader and 277 stays locked. No flag exists until a test
 * passes. Pure: no DB, no network.
 */
import { playerDraw } from '../../server/services/range-residuals.js';

export const RULE = Object.freeze({
  version: 1,
  starters: Object.freeze({ QB: 10, RB: 10, TE: 10, WR: 20 }),
  min_games: 8,
  window: 6,
  min_hits: 4,
  last_week: 17,
  p25: 0.25,
  min_score: 83,
  bad_status: Object.freeze(['Out', 'Doubtful']),
});

/** Positions the pre-registered test served (docs/tdd/U4-CONSISTENT-CHIP.md). Empty = nobody is consistent. */
export const SERVED_POSITIONS = Object.freeze([]);

const fin = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Last season's starter median M and starter line L per position.
 * games: [{ id, position, week, pts }] for ONE season (the season before the one being read).
 * -> Map position -> { median, line, n }
 */
export function starterBaselines(games, { rule = RULE } = {}) {
  const byPlayer = new Map();
  for (const g of games) {
    if (!rule.starters[g.position] || !(g.week >= 1 && g.week <= rule.last_week) || !fin(g.pts)) continue;
    const k = String(g.id);
    if (!byPlayer.has(k)) byPlayer.set(k, { position: g.position, pts: [] });
    byPlayer.get(k).pts.push(g.pts);
  }
  const out = new Map();
  for (const [pos, n] of Object.entries(rule.starters)) {
    const ranked = [...byPlayer.values()].filter(p => p.position === pos && p.pts.length >= rule.min_games)
      .map(p => ({ ppg: p.pts.reduce((s, x) => s + x, 0) / p.pts.length, pts: p.pts }))
      .sort((a, b) => b.ppg - a.ppg);
    if (ranked.length < n) continue;
    const top = ranked.slice(0, n);
    const all = top.flatMap(p => p.pts).sort((a, b) => a - b);
    const m = all.length % 2 ? all[(all.length - 1) / 2] : (all[all.length / 2 - 1] + all[all.length / 2]) / 2;
    out.set(pos, { median: +m.toFixed(2), line: +top[n - 1].ppg.toFixed(2), n });
  }
  return out;
}

/**
 * The last `window` weeks (1-17) before week `week` of `season` in which his NFL team played, walking
 * back into season-1. games: his [{ season, week, team, pts }]; teamWeeks: Map `${season}:${team}` ->
 * Set of weeks that team played. His team in a season = the team on his latest game there before the
 * cut. -> [{ season, week, pts | null }] (null = a team week with no game from him), or null when the
 * window cannot be built (no game this season or last, too few team weeks).
 */
export function teamWindow(games, teamWeeks, { season, week, rule = RULE }) {
  const out = [];
  for (const s of [season, season - 1]) {
    const cut = w => w <= rule.last_week && (s < season || w < week);
    const before = games.filter(g => g.season === s && cut(g.week));
    if (!before.length) return null;
    const team = before.reduce((a, b) => (b.week > a.week ? b : a)).team;
    const byWeek = new Map(before.map(g => [g.week, g.pts]));
    const weeks = [...(teamWeeks.get(`${s}:${team}`) ?? [])].filter(cut).sort((a, b) => b - a);
    for (const w of weeks) {
      out.push({ season: s, week: w, pts: fin(byWeek.get(w)) ? byWeek.get(w) : null });
      if (out.length === rule.window) return out;
    }
  }
  return null;
}

/**
 * Rule D for one player. -> { consistent: boolean, reasons: string[], p25: number|null, hits: number|null }
 * p: { position, score, hurt, injuryStatus, window, mean }; baseline: { median, line } for his position;
 * k: the width in force; table: the residual table (range-residuals.js#residuals()).
 * literal: D0 (clause 5 against the median, descriptive only). servedPositions: null in the backtest
 * (every position is read); the live reader passes SERVED_POSITIONS.
 */
export function consistentRead(p, { baseline, k, table, literal = false, servedPositions = null, rule = RULE } = {}) {
  const reasons = [];
  const pos = p?.position;
  if (!rule.starters[pos]) reasons.push('position');
  if (servedPositions && !servedPositions.includes(pos)) reasons.push('position_not_served');
  if (!fin(p?.score)) reasons.push('no_score');
  else if (p.score < rule.min_score) reasons.push('below_blue_chip');
  if (p?.hurt !== false) reasons.push('hurt');
  if (p?.injuryStatus != null && rule.bad_status.includes(p.injuryStatus)) reasons.push('inactive');
  if (p?.injuryStatus === undefined) reasons.push('injury_unread');
  const win = Array.isArray(p?.window) ? p.window : null;
  let hits = null;
  if (!win || win.length !== rule.window || win.some(w => !fin(w?.pts))) reasons.push('window_missing');
  if (!fin(baseline?.median) || !fin(baseline?.line)) reasons.push('no_baseline');
  else if (win && win.length === rule.window && win.every(w => fin(w?.pts))) {
    hits = win.filter(w => w.pts >= baseline.median).length;
    if (hits < rule.min_hits) reasons.push('history');
  }
  let p25 = null;
  if (!fin(p?.mean)) reasons.push('no_mean');
  else if (!fin(k) || !table) reasons.push('no_k');
  else if (rule.starters[pos]) {
    p25 = +playerDraw(p.mean, pos, rule.p25, k, table).toFixed(2);
    const bar = literal ? baseline?.median : baseline?.line;
    if (!fin(bar) || p25 < bar) reasons.push('p25');
  }
  return { consistent: reasons.length === 0, reasons, p25, hits };
}

/**
 * consistentOf for never-give.js#ajMayMove, built from ONE set of inputs so the gate and the reader
 * read the same data. inputs: Map id -> the consistentRead player input; baselines: Map position ->
 * { median, line }. Served positions default to SERVED_POSITIONS (empty today: always false).
 */
export function consistentOfFrom(inputs, { baselines, k, table, servedPositions = SERVED_POSITIONS } = {}) {
  return id => {
    const p = inputs?.get(String(id));
    if (!p) return false;
    return consistentRead(p, { baseline: baselines?.get(p.position), k, table, servedPositions }).consistent;
  };
}
