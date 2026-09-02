/**
 * Polymarket as the line-movement source.
 *
 * Polymarket lists every NFL game as an event ("Patriots vs. Seahawks") with
 * a ladder of alternate spread markets ("Spread: Seahawks (-3.5)") and a
 * ladder of totals ("Patriots vs. Seahawks: O/U 44.5"), each quoted as the
 * probability that side wins, and polymarket.js has been storing their order
 * books every thirty minutes since late August. That ladder IS a line: the
 * point where P(cover) crosses 50% is the market's spread, the point where
 * P(over) crosses 50% is its total. Reading both off every capture gives a
 * free, continuous, exchange-priced movement series that does not depend on
 * any sportsbook feed or any credit.
 *
 * This module derives that implied line per game per capture, appends a row
 * to `polymarket_line_moves` whenever it moves materially, prices the move
 * against the empirical margin distribution (like the ESPN watcher does), and
 * enqueues a capture trigger so the paid/free book feeds are read when
 * something actually changed. Movement consumers (signal latency, the market
 * movement panel, the capture dispatcher) read this alongside the ESPN log.
 *
 * Titles put the away team first: "49ers vs. Rams" is SF at LAR.
 */
import { db, rows, run } from '../db/index.js';
import { lineMoveValue } from './nfl-execution-edge.js';
import { teamResolver } from './book-feeds.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS polymarket_line_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at TEXT NOT NULL, captured_at TEXT NOT NULL,
    season INTEGER, week INTEGER, event_title TEXT NOT NULL,
    home_team TEXT, away_team TEXT, commence_time TEXT,
    home_spread REAL, total REAL,
    prev_home_spread REAL, prev_total REAL,
    spread_delta REAL, total_delta REAL, spread_move_value REAL,
    spread_ladder INTEGER, total_ladder INTEGER,
    first_sighting INTEGER NOT NULL DEFAULT 0,
    UNIQUE(event_title, captured_at)
  );
  CREATE INDEX IF NOT EXISTS idx_pm_moves_time ON polymarket_line_moves(observed_at);
  CREATE INDEX IF NOT EXISTS idx_pm_moves_game ON polymarket_line_moves(season, week, home_team);
`);

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const SPREAD_STEP = 0.5;   // log a move once the implied spread has shifted this much
const TOTAL_STEP = 0.5;

/**
 * Pool-adjacent-violators: the closest monotone fit to a noisy ladder. Thin
 * exchange markets are not perfectly ordered — a 40.5 total can print 0.52
 * while 42.5 prints 0.55 — and reading the raw ladder for a 50% crossing
 * finds a spurious one wherever the noise dips. Fitting the ladder to the
 * shape it must have (P(over) falls as the number rises; P(home covers)
 * rises as the home number gets more generous) before interpolating removes
 * that failure mode without inventing information.
 */
export function isotonic(values, { increasing = true } = {}) {
  const v = increasing ? [...values] : values.map(x => -x);
  const blocks = v.map(x => ({ sum: x, n: 1 }));
  let i = 0;
  while (i < blocks.length - 1) {
    const a = blocks[i], b = blocks[i + 1];
    if (a.sum / a.n <= b.sum / b.n) { i++; continue; }
    blocks.splice(i, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    i = Math.max(0, i - 1);
  }
  const out = blocks.flatMap(b => Array(b.n).fill(b.sum / b.n));
  return increasing ? out : out.map(x => -x);
}

/** The x where a (noisy) monotone series of (x, p) crosses p = 0.5, by linear interpolation after an isotonic fit. */
export function crossing(points, { increasing = true, minPoints = 3 } = {}) {
  const pts = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.p)).sort((a, b) => a.x - b.x);
  if (pts.length < minPoints) return null;
  const fitted = isotonic(pts.map(p => p.p), { increasing });
  const f = pts.map((p, i) => ({ x: p.x, p: fitted[i] }));
  for (let i = 0; i < f.length - 1; i++) {
    const a = f[i], b = f[i + 1];
    if ((a.p - 0.5) * (b.p - 0.5) <= 0) {
      if (a.p === b.p) {
        // A flat run at exactly 0.5: the middle of the flat is the estimate.
        let j = i + 1;
        while (j + 1 < f.length && f[j + 1].p === a.p) j++;
        return { x: (f[i].x + f[j].x) / 2, extrapolated: false };
      }
      return { x: a.x + (0.5 - a.p) * (b.x - a.x) / (b.p - a.p), extrapolated: false };
    }
  }
  // No crossing inside the ladder: the nearest end is the honest answer, flagged.
  const nearest = f.reduce((best, p) => Math.abs(p.p - 0.5) < Math.abs(best.p - 0.5) ? p : best, f[0]);
  return { x: nearest.x, extrapolated: true };
}

/** Parse Polymarket's per-game market titles into ladder points. */
export function parseGameMarket(question, eventTitle) {
  const q = String(question ?? '');
  const spread = q.match(/^Spread:\s*(.+?)\s*\(([-+]?\d+(?:\.\d+)?)\)\s*$/i);
  if (spread) return { kind: 'spread', team: spread[1].trim(), line: Number(spread[2]) };
  const total = q.match(/^(.+?):\s*O\/U\s*(\d+(?:\.\d+)?)\s*$/i);
  if (total && total[1].trim() === String(eventTitle ?? '').trim()) return { kind: 'total', line: Number(total[2]) };
  return null;
}

/**
 * "Patriots vs. Seahawks" is usually away-first, but not always. When the
 * schedule knows the game, the schedule decides which side is home.
 */
function gameFromTitle(title, resolve) {
  const m = String(title ?? '').match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (!m) return null;
  const first = resolve(m[1]), second = resolve(m[2]);
  if (!first || !second) return null;
  const season = Number(process.env.NFL_SEASON) || new Date().getUTCFullYear();
  const scheduled = (home, away) => rows(`SELECT 1 ok FROM game_lines WHERE team=? AND opponent=? AND home=1
    AND season IN (?, ?) LIMIT 1`, home.abbr, away.abbr, season, season - 1).length > 0;
  if (scheduled(second, first)) return { away: first, home: second, orientation: 'title' };
  if (scheduled(first, second)) return { away: second, home: first, orientation: 'schedule_swapped' };
  return { away: first, home: second, orientation: 'assumed' };
}

/**
 * Implied home spread and total for one game at one capture, from that
 * capture's ladder quotes. Returns null when a ladder is absent.
 */
// NFL games do not have 23-point totals or 30-point spreads. A crossing
// outside these bands is a ladder artifact, not a market.
const SPREAD_BAND = [-24, 24];
const TOTAL_BAND = [30, 70];

/**
 * `quotesByCondition` maps condition_id -> { p, priced } where `priced` says
 * the leg had a real two-sided book at that capture. Unpriced legs still carry
 * a midpoint on Polymarket, but far from the market number it is a stale or
 * placeholder figure (a 25.5 total printing 0.90 next to a 27.5 printing 0.51).
 * When at least three legs have a book, only those are used.
 */
export function impliedLines(markets, quotesByCondition, game) {
  const spreadPts = [], totalPts = [];
  const read = id => {
    const q = quotesByCondition.get(id);
    if (q == null) return null;
    return typeof q === 'number' ? { p: q, priced: true } : q;
  };
  for (const m of markets) {
    const parsed = parseGameMarket(m.question, m.event_title);
    const q = read(m.condition_id);
    if (!parsed || !q || !Number.isFinite(q.p)) continue;
    if (parsed.kind === 'spread') {
      const team = m.resolve(parsed.team);
      if (!team) continue;
      // Home perspective: P(home covers home_line). A quoted away line of +3.5
      // at 60% is a home line of -3.5 at 40%.
      if (team.abbr === game.home.abbr) spreadPts.push({ x: parsed.line, p: q.p, priced: q.priced });
      else if (team.abbr === game.away.abbr) spreadPts.push({ x: -parsed.line, p: 1 - q.p, priced: q.priced });
    } else if (parsed.kind === 'total') {
      totalPts.push({ x: parsed.line, p: q.p, priced: q.priced }); // P(over) falls as the number rises
    }
  }
  const usable = pts => { const priced = pts.filter(p => p.priced); return priced.length >= 3 ? priced : pts; };
  const inBand = (v, [lo, hi]) => v != null && v >= lo && v <= hi;
  // P(home covers) rises as the home line gets more generous (larger x);
  // P(over) falls as the number rises. Both are fitted to that shape first.
  const spreadUse = usable(spreadPts), totalUse = usable(totalPts);
  const spread = spreadUse.length ? crossing(spreadUse, { increasing: true }) : null;
  const total = totalUse.length ? crossing(totalUse, { increasing: false }) : null;
  // An extrapolated crossing (the whole ladder on one side of 50%) is not a
  // market number; it is a ladder that has not been priced yet. Report null.
  const homeSpread = spread && !spread.extrapolated && inBand(spread.x, SPREAD_BAND) ? r3(spread.x) : null;
  const totalLine = total && !total.extrapolated && inBand(total.x, TOTAL_BAND) ? r3(total.x) : null;
  return { home_spread: homeSpread, total: totalLine,
    spread_ladder: spreadUse.length, total_ladder: totalUse.length,
    spread_priced_only: spreadUse.length && spreadUse.every(p => p.priced), total_priced_only: totalUse.length && totalUse.every(p => p.priced),
    spread_extrapolated: spread?.extrapolated ?? null, total_extrapolated: total?.extrapolated ?? null };
}

function scheduleFor(game, endDate) {
  const season = Number(process.env.NFL_SEASON) || new Date().getUTCFullYear();
  const candidates = rows(`SELECT season, week, gameday FROM game_lines
    WHERE team=? AND opponent=? AND home=1 AND season IN (?, ?) ORDER BY season DESC, week`,
  game.home.abbr, game.away.abbr, season, season - 1);
  if (!candidates.length) return { season: null, week: null };
  const target = endDate ? new Date(endDate).getTime() : null;
  const pick = target == null ? candidates[0]
    : candidates.reduce((best, c) => {
      const d = Math.abs(new Date(`${c.gameday}T12:00:00Z`).getTime() - target);
      return !best || d < best.d ? { ...c, d } : best;
    }, null);
  return { season: pick.season, week: pick.week };
}

/**
 * Walk every capture since the last logged one and append material moves.
 * Idempotent: rerunning never duplicates a (game, capture) row.
 */
export function pollPolymarketLines({ sinceHours = 72, rebuild = false } = {}) {
  const resolve = teamResolver();
  // A derivation change (ladder fit, orientation) is only honest if the whole
  // log is rebuilt from the stored quotes under the new rule.
  if (rebuild) run('DELETE FROM polymarket_line_moves');
  // Only games that have not been played: a title whose markets all ended
  // more than a day ago is last season's leftover, not a live line.
  const titles = rows(`SELECT event_title FROM polymarket_markets
    WHERE event_title LIKE '% vs. %' AND event_title NOT LIKE 'Pro Football:%'
    GROUP BY event_title HAVING MAX(COALESCE(end_date, '9999')) >= ?`, new Date(Date.now() - 86400e3).toISOString());
  const since = new Date(Date.now() - sinceHours * 3600e3).toISOString();
  const observedAt = new Date().toISOString();
  let games = 0, moves = 0, firstSeen = 0, unchanged = 0;
  const detected = [];
  for (const { event_title } of titles) {
    const game = gameFromTitle(event_title, resolve);
    if (!game) continue;
    const markets = rows(`SELECT condition_id, question, event_title, end_date FROM polymarket_markets WHERE event_title=?`, event_title)
      .map(m => ({ ...m, resolve }));
    const ladder = markets.filter(m => parseGameMarket(m.question, m.event_title));
    if (!ladder.length) continue;
    games++;
    const ids = ladder.map(m => m.condition_id);
    const lastLogged = rows(`SELECT captured_at, home_spread, total FROM polymarket_line_moves
      WHERE event_title=? ORDER BY captured_at DESC LIMIT 1`, event_title)[0] ?? null;
    const from = lastLogged ? lastLogged.captured_at : since;
    const captures = rows(`SELECT DISTINCT captured_at FROM polymarket_quotes
      WHERE condition_id IN (${ids.map(() => '?').join(',')}) AND captured_at > ? ORDER BY captured_at`, ...ids, from);
    let prev = lastLogged;
    for (const { captured_at } of captures) {
      const quotes = new Map(rows(`SELECT condition_id, mid_yes, best_bid, best_ask FROM polymarket_quotes
        WHERE captured_at=? AND condition_id IN (${ids.map(() => '?').join(',')})`, captured_at, ...ids)
        .map(q => [q.condition_id, { p: q.mid_yes, priced: q.best_bid != null && q.best_ask != null }]));
      const implied = impliedLines(ladder, quotes, game);
      if (implied.home_spread == null && implied.total == null) continue;
      const spreadDelta = prev?.home_spread != null && implied.home_spread != null ? implied.home_spread - prev.home_spread : null;
      const totalDelta = prev?.total != null && implied.total != null ? implied.total - prev.total : null;
      // A first sighting needs a priced spread; a later row needs a material move.
      const material = !prev ? implied.home_spread != null
        : Math.abs(spreadDelta ?? 0) >= SPREAD_STEP || Math.abs(totalDelta ?? 0) >= TOTAL_STEP;
      if (!material) { unchanged++; continue; }
      const { season, week } = scheduleFor(game, ladder[0].end_date);
      const moveValue = prev && spreadDelta ? lineMoveValue(prev.home_spread, implied.home_spread) : null;
      // Carry the previous number forward when this capture could not price
      // one side, so a momentarily unpriced ladder never reads as a move.
      const homeSpread = implied.home_spread ?? prev?.home_spread ?? null;
      const totalLine = implied.total ?? prev?.total ?? null;
      const result = run(`INSERT OR IGNORE INTO polymarket_line_moves
        (observed_at, captured_at, season, week, event_title, home_team, away_team, commence_time,
         home_spread, total, prev_home_spread, prev_total, spread_delta, total_delta, spread_move_value,
         spread_ladder, total_ladder, first_sighting)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      observedAt, captured_at, season, week, event_title, game.home.abbr, game.away.abbr, ladder[0].end_date ?? null,
      homeSpread, totalLine, prev?.home_spread ?? null, prev?.total ?? null,
      r3(spreadDelta), r3(totalDelta), r3(moveValue), implied.spread_ladder, implied.total_ladder, prev ? 0 : 1);
      if (!result.changes) continue;
      if (prev) {
        moves++;
        detected.push({ event_title, season, week, home: game.home.abbr, away: game.away.abbr,
          matchup: `${game.away.abbr} at ${game.home.abbr}`, captured_at,
          spread_delta: r3(spreadDelta), total_delta: r3(totalDelta), move_value: r3(moveValue) });
      } else firstSeen++;
      prev = { captured_at, home_spread: homeSpread, total: totalLine };
    }
  }
  return { observed_at: observedAt, games, moves, first_seen: firstSeen, unchanged, detected, source: 'polymarket', cost: 'free' };
}

/** Scheduler entry: log moves, then let the dispatcher decide whether a paid/free book capture is worth it. */
export async function refreshPolymarketLineWatch() {
  const result = pollPolymarketLines();
  if (result.detected.length) {
    // Map to the ESPN event id the capture dispatcher keys on.
    const espn = new Map(rows(`SELECT event_id, home_team, away_team FROM espn_line_moves
      WHERE id IN (SELECT MAX(id) FROM espn_line_moves GROUP BY event_id)`).map(r => [`${r.away_team}@${r.home_team}`, r.event_id]));
    const triggers = result.detected
      .map(d => ({ event_id: espn.get(`${d.away}@${d.home}`) ?? `pm:${d.event_title}`, spread_delta: d.spread_delta, move_value: d.move_value }));
    try {
      const dispatch = await import('./nfl-capture-dispatch.js');
      result.triggers = dispatch.enqueueEspnMoveTriggers(triggers, result.observed_at);
      result.capture = await dispatch.dispatchTriggeredCapture();
    } catch (error) { result.trigger_error = error.message; }
  }
  return result;
}

/** The current implied line per game, and recent movement, for the UI and diagnostics. */
export function polymarketMovement({ hours = 168, limit = 60 } = {}) {
  const latest = rows(`SELECT m.* FROM polymarket_line_moves m
    JOIN (SELECT event_title, MAX(id) id FROM polymarket_line_moves GROUP BY event_title) l ON l.id = m.id
    ORDER BY m.commence_time, m.event_title`);
  const recent = rows(`SELECT * FROM polymarket_line_moves
    WHERE first_sighting = 0 AND observed_at >= datetime('now', ?) ORDER BY captured_at DESC LIMIT ?`, `-${hours} hours`, limit);
  const opens = rows(`SELECT event_title, home_spread AS open_spread, total AS open_total FROM polymarket_line_moves
    WHERE first_sighting = 1`);
  const openBy = new Map(opens.map(o => [o.event_title, o]));
  return {
    source: 'polymarket', games: latest.length,
    current: latest.map(l => ({ event_title: l.event_title, season: l.season, week: l.week,
      matchup: `${l.away_team} at ${l.home_team}`, home_spread: l.home_spread, total: l.total,
      open_spread: openBy.get(l.event_title)?.open_spread ?? null, open_total: openBy.get(l.event_title)?.open_total ?? null,
      spread_from_open: r3(openBy.get(l.event_title)?.open_spread != null && l.home_spread != null
        ? l.home_spread - openBy.get(l.event_title).open_spread : null),
      as_of: l.captured_at, ladder: { spread: l.spread_ladder, total: l.total_ladder } })),
    recent_moves: recent,
    note: 'Implied line = the point on Polymarket\'s alternate-spread / total ladder where the cover probability crosses 50%. Exchange-priced, fee-free, captured every 30 minutes. Descriptive: movement is a fact about the market, not a forecast.'
  };
}

export const __test = { crossing, isotonic, parseGameMarket, impliedLines };
