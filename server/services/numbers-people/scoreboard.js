/**
 * NUMBERS-PEOPLE "Going forward": when the lanes differed, which one was right.
 *
 * Only DIFFER reads are scored (the last read of each item in each week), and
 * only once the outcome has settled:
 *
 *   move, partner   a trade with that move id / that league-mate, offered after
 *                   the read, that resolved (trade_outcomes). Accepted is a good
 *                   outcome; declined, expired or ignored is a bad one. Countered,
 *                   withdrawn and still-open offers have not settled.
 *   target          his realized points (player_week_usage, PPR): points per game
 *                   from the read's week on (at least MIN_POST_GAMES games) against
 *                   before it (at least one game). Up is a good outcome, down a bad one.
 *
 * On a good outcome "go" was right; on a bad one "wait" and "avoid" were. The
 * board says "not enough outcomes yet" until MIN_N reads have settled, and it
 * always shows n: a record of two is not a record.
 */
import { actuals } from '../backtest.js';
import { differReads } from './store.js';

export const MIN_N = 5;
export const MIN_POST_GAMES = 2;
const GOOD = new Set(['accepted']);
const BAD = new Set(['declined', 'expired', 'ignored']);

const rightFor = (stance, good) => (good ? stance === 'go' : stance === 'wait' || stance === 'avoid');
const day = iso => String(iso ?? '').slice(0, 10);

/** The settled outcome of a trade-shaped read, or null. */
function tradeOutcome(database, read, me) {
  const since = day(read.created_at);
  const resolved = [...GOOD, ...BAD];
  const marks = resolved.map(() => '?').join(', ');
  let r = null;
  if (read.item_type === 'move') {
    r = database.prepare(`SELECT status FROM trade_outcomes WHERE league_id = ? AND move_id = ?
      AND substr(COALESCE(proposed_at, created_at), 1, 10) >= ? AND status IN (${marks}) ORDER BY id LIMIT 1`)
      .get(read.league_id, read.item_id, since, ...resolved);
  } else if (me != null) {
    r = database.prepare(`SELECT status FROM trade_outcomes WHERE league_id = ?
      AND ((proposer_team_id = ? AND counterparty_team_id = ?) OR (proposer_team_id = ? AND counterparty_team_id = ?))
      AND source <> 'considered_only'
      AND substr(COALESCE(proposed_at, created_at), 1, 10) >= ? AND status IN (${marks}) ORDER BY id LIMIT 1`)
      .get(read.league_id, String(me), read.item_id, read.item_id, String(me), since, ...resolved);
  }
  return r ? { good: GOOD.has(r.status), basis: r.status } : null;
}

/** Up or down in points per game after the read, or null while too few games are in. */
function pointsOutcome(read, season, actualsFor) {
  if (season == null || read.week == null) return null;
  const a = actualsFor(season).get(Number(read.item_id));
  if (!a) return null;
  const pre = [], post = [];
  for (const [w, pts] of a.weeks) (w >= read.week ? post : pre).push(pts);
  if (post.length < MIN_POST_GAMES || !pre.length) return null;
  const avg = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
  const delta = avg(post) - avg(pre);
  if (delta === 0) return null;
  return { good: delta > 0, basis: delta > 0 ? 'points_up' : 'points_down' };
}

/**
 * { n, min_n, enough, numbers_right, people_right, both_right, pending, by_type }.
 * `actualsFor(season)` is backtest.js#actuals unless a test passes its own.
 */
export function scoreboard(database, leagueId, { me = null, season = null, actualsFor = actuals } = {}) {
  const latest = new Map();
  for (const r of differReads(database, leagueId)) latest.set(`${r.item_type}:${r.item_id}:${r.week ?? 0}`, r);
  const cache = new Map();
  const cachedActuals = s => { if (!cache.has(s)) cache.set(s, actualsFor(s)); return cache.get(s); };
  const out = { n: 0, min_n: MIN_N, enough: false, numbers_right: 0, people_right: 0, both_right: 0, pending: 0,
    by_type: { move: 0, target: 0, partner: 0 } };
  for (const r of latest.values()) {
    const o = r.item_type === 'target' ? pointsOutcome(r, season, cachedActuals) : tradeOutcome(database, r, me);
    if (!o) { out.pending += 1; continue; }
    out.n += 1;
    out.by_type[r.item_type] += 1;
    const a = rightFor(r.lane_a.stance, o.good);
    const b = rightFor(r.lane_b.stance, o.good);
    if (a && b) out.both_right += 1;
    else if (a) out.numbers_right += 1;
    else if (b) out.people_right += 1;
  }
  out.enough = out.n >= MIN_N;
  return out;
}
