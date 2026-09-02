/**
 * Sharp lag — the "top-down" question, measured from our own hourly captures.
 *
 * When Pinnacle moves a number, how long does each soft book take to follow,
 * and what is the stale number worth while it lags? Nothing here forecasts a
 * game: the only claim is that a book still showing Pinnacle's PRE-move
 * number is offering a better price than the sharp reference at that instant,
 * and the grade is whether that price beat Pinnacle's close.
 *
 * Definitions (all per event and side, `market` defaults to spreads):
 *
 *   move        A change of at least `minMove` in Pinnacle's line between two
 *               consecutive captures. A move is attributed to the side the
 *               market moved TOWARD — the side whose number got worse (KC -3
 *               to -3.5 is a move toward KC; a total 47 to 46.5 is a move
 *               toward the Under). The mirrored side of the same game is the
 *               same move and is not counted twice.
 *   follow      The first capture, at or after the move, at which a soft
 *               book's line equals Pinnacle's new line or has gone past it in
 *               the same direction. Latency is in minutes from the capture
 *               that revealed the move, so it is quantised to the poll
 *               interval (hourly): "60 minutes" means "by the next poll".
 *   opportunity Any capture, from the move's own capture until the book
 *               follows, at which the book's line is still better for the
 *               moved-toward side than Pinnacle's line AT THAT CAPTURE. One
 *               record per (capture, event, side, book), whatever the number
 *               of outstanding moves. The move's own capture counts: it is the
 *               first instant the lag is visible and actionable.
 *   grade       For settled games (`game_lines` with scores), CLV in points
 *               toward the side against Pinnacle's last pre-kickoff line, and
 *               the ATS result at the soft line as context.
 *
 * Two things this module refuses to do, for the reasons the shopping board
 * and `book-feeds.js#isFreshQuote` document: it never compares a soft quote
 * with a stale `book_updated_at` (the aggregator serves cached prices for
 * books it has stopped polling, which would read as an eternal lag), and it
 * never reads a capture after kickoff (in-play prints are not the same
 * market). It also runs ONE SELECT and groups in memory — a SELECT per event
 * is what made the hub take 17 seconds before the board was rewritten.
 *
 * `provider LIKE 'free:%'` restricts the study to the free book feeds, where
 * Pinnacle is captured directly (`free:pinnacle`) and every book shares a
 * `captured_at` instant.
 */
import { rows } from '../db/index.js';
import { isFreshQuote } from './book-feeds.js';

export const READABLE_SETTLED = 30;

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const mean = list => (list.length ? r3(list.reduce((s, v) => s + v, 0) / list.length) : null);
function quantile(list, q) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return r3(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}
const share = (hits, n) => (n ? r3(hits / n) : null);
const ms = iso => new Date(iso).getTime();

/**
 * Sign that turns a line into "points in the bettor's favour" for a side:
 * a spread side and the Under want the larger number, the Over wants the
 * smaller one. `favour * (a - b) > 0` means line `a` is better than `b`.
 */
const favour = side => (side === 'Over' ? -1 : 1);

/** Pinnacle's last pre-kickoff capture for a side — the close this study grades against. */
function closeOf(series) { return series.length ? series[series.length - 1] : null; }

export function sharpLag({ sinceDays = 14, market = 'spreads', minMove = 0.5, now = new Date().toISOString() } = {}) {
  const since = new Date(ms(now) - sinceDays * 864e5).toISOString();
  const all = rows(`SELECT captured_at, event_id, commence_time, home_team, away_team, book, side, line, provider, book_updated_at
    FROM nfl_line_snapshots
    WHERE provider LIKE 'free:%' AND market = ? AND line IS NOT NULL AND captured_at >= ? AND captured_at <= ?
    ORDER BY captured_at`, market, since, now);

  // ---- group: (event, side) -> pinnacle series + per-book series, in capture order
  const groups = new Map();
  const captures = new Set();
  let staleDropped = 0, inPlayDropped = 0;
  for (const q of all) {
    if (q.commence_time && q.captured_at > q.commence_time) { inPlayDropped++; continue; }
    const isPin = q.provider === 'free:pinnacle';
    if (!isPin && q.book === 'pinnacle') continue; // an aggregator's copy of the reference is not the reference
    if (!isPin && !isFreshQuote(q.captured_at, q.book_updated_at)) { staleDropped++; continue; }
    captures.add(q.captured_at);
    const key = `${q.event_id}|${q.side}`;
    let g = groups.get(key);
    if (!g) {
      g = { event_id: q.event_id, side: q.side, home_team: q.home_team, away_team: q.away_team,
        commence_time: q.commence_time, pin: [], books: new Map() };
      groups.set(key, g);
    }
    if (isPin) g.pin.push({ at: q.captured_at, line: q.line });
    else {
      if (!g.books.has(q.book)) g.books.set(q.book, []);
      g.books.get(q.book).push({ at: q.captured_at, line: q.line });
    }
  }

  // ---- settled games, joined by the event's team names -> abbreviations -> game_lines
  const nameToAbbr = new Map(rows('SELECT abbr, name FROM nfl_teams').map(t => [t.name, t.abbr]));
  const sinceDate = new Date(ms(since) - 2 * 864e5).toISOString().slice(0, 10);
  const finals = new Map();
  for (const g of rows(`SELECT team, opponent, gameday, team_score, opp_score FROM game_lines
      WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL AND gameday >= ?`, sinceDate)) {
    const k = `${g.team}|${g.opponent}`;
    if (!finals.has(k)) finals.set(k, []);
    finals.get(k).push(g);
  }
  const finalFor = g => {
    if (!g.commence_time) return null;
    const home = nameToAbbr.get(g.home_team) ?? g.home_team, away = nameToAbbr.get(g.away_team) ?? g.away_team;
    const kickoff = ms(g.commence_time);
    let best = null, bestGap = Infinity;
    for (const row of finals.get(`${home}|${away}`) ?? []) {
      if (!row.gameday) continue;
      const gap = Math.abs(ms(`${row.gameday}T12:00:00Z`) - kickoff);
      if (gap <= 2 * 864e5 && gap < bestGap) { best = row; bestGap = gap; }
    }
    return best;
  };

  // ---- walk each (event, side): Pinnacle moves, follows, opportunities, grades
  const moves = [], opportunities = [];
  const byBook = new Map();
  const bookStats = book => {
    if (!byBook.has(book)) {
      byBook.set(book, { moves_seen: 0, followed: 0, follow_minutes: [], hours_unfollowed: [],
        opportunities: 0, gaps: [], settled: 0, clv: [], ats: { W: 0, L: 0, P: 0 } });
    }
    return byBook.get(book);
  };

  for (const g of groups.values()) {
    if (g.pin.length < 2) continue;
    const f = favour(g.side);
    // Pinnacle's line as of each capture, carried forward across polls it missed.
    const pinAt = new Map();
    const ats = [...new Set([...g.pin.map(p => p.at), ...[...g.books.values()].flatMap(s => s.map(p => p.at))])].sort();
    let pi = 0, current = null;
    for (const at of ats) {
      while (pi < g.pin.length && g.pin[pi].at <= at) current = g.pin[pi++].line;
      if (current != null) pinAt.set(at, current);
    }
    const bookIndex = new Map([...g.books].map(([book, series]) => [book, new Map(series.map((p, i) => [p.at, i]))]));
    const seenOpportunity = new Set();
    const final = finalFor(g);
    const close = closeOf(g.pin);
    const graded = Boolean(final && close && now >= (g.commence_time ?? now));

    for (let i = 1; i < g.pin.length; i++) {
      const prev = g.pin[i - 1], cur = g.pin[i];
      const delta = cur.line - prev.line;
      if (Math.abs(delta) < minMove) continue;
      if (f * delta > 0) continue; // the number got better for this side: the move is toward the other side
      const move = { captured_at: cur.at, event_id: g.event_id, side: g.side, commence_time: g.commence_time,
        from: prev.line, to: cur.line, follows: {} };
      moves.push(move);

      for (const [book, series] of g.books) {
        const start = bookIndex.get(book).get(cur.at);
        if (start == null) continue; // not quoted at the capture that revealed the move
        const stats = bookStats(book);
        stats.moves_seen++;
        let followedAt = null, lastAt = cur.at;
        for (let j = start; j < series.length; j++) {
          const e = series[j];
          lastAt = e.at;
          if (f * (e.line - cur.line) <= 0) { followedAt = e.at; break; }
          const pin = pinAt.get(e.at);
          const gap = pin == null ? 0 : f * (e.line - pin);
          const key = `${e.at}|${book}`;
          if (gap <= 1e-9 || seenOpportunity.has(key)) continue;
          seenOpportunity.add(key);
          const opp = { captured_at: e.at, event_id: g.event_id, side: g.side, commence_time: g.commence_time,
            book, soft_line: e.line, pinnacle_line: pin, gap: r3(gap),
            minutes_since_move: r3((ms(e.at) - ms(cur.at)) / 60000),
            close_line: null, clv_points: null, ats: null };
          stats.opportunities++;
          stats.gaps.push(gap);
          if (graded) {
            const clv = f * (e.line - close.line);
            opp.close_line = close.line; opp.close_at = close.at; opp.clv_points = r3(clv);
            const margin = final.team_score - final.opp_score, total = final.team_score + final.opp_score;
            const edge = g.side === 'Over' ? total - e.line
              : g.side === 'Under' ? e.line - total
                : (g.side === g.home_team ? margin : -margin) + e.line;
            opp.ats = edge > 0 ? 'W' : edge < 0 ? 'L' : 'P';
            stats.settled++; stats.clv.push(clv); stats.ats[opp.ats]++;
          }
          opportunities.push(opp);
        }
        if (followedAt) {
          const minutes = (ms(followedAt) - ms(cur.at)) / 60000;
          stats.followed++; stats.follow_minutes.push(minutes);
          move.follows[book] = { followed: true, minutes: r3(minutes) };
        } else {
          const hours = (ms(lastAt) - ms(cur.at)) / 3600000;
          stats.hours_unfollowed.push(hours);
          move.follows[book] = { followed: false, hours_observed: r3(hours) };
        }
      }
    }
  }

  moves.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  opportunities.sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.book.localeCompare(b.book));

  const by_book = {};
  for (const [book, s] of [...byBook].sort(([a], [b]) => a.localeCompare(b))) {
    by_book[book] = {
      moves_seen: s.moves_seen,
      followed: s.followed,
      not_followed: s.moves_seen - s.followed,
      median_follow_minutes: quantile(s.follow_minutes, 0.5),
      p90_follow_minutes: quantile(s.follow_minutes, 0.9),
      followed_within_60m_share: share(s.follow_minutes.filter(m => m <= 60).length, s.moves_seen),
      followed_within_180m_share: share(s.follow_minutes.filter(m => m <= 180).length, s.moves_seen),
      median_hours_observed_when_not_followed: quantile(s.hours_unfollowed, 0.5),
      opportunities: s.opportunities,
      mean_gap: mean(s.gaps),
      settled: s.settled,
      mean_clv_points: mean(s.clv),
      positive_clv_share: share(s.clv.filter(v => v > 0).length, s.settled),
      ats_record: s.settled ? `${s.ats.W}-${s.ats.L}-${s.ats.P}` : null,
      readable: s.settled >= READABLE_SETTLED
    };
  }

  return {
    window: { since, until: now, days: sinceDays, market, min_move: minMove,
      captures: captures.size, events: new Set([...groups.values()].map(g => g.event_id)).size,
      quotes: all.length, stale_dropped: staleDropped, in_play_dropped: inPlayDropped },
    pinnacle_moves: moves.length,
    by_book,
    moves: moves.slice(-50),
    opportunities: opportunities.slice(-50),
    readable_rule: `per-book numbers are readable at ≥ ${READABLE_SETTLED} settled opportunities`,
    note: 'Pinnacle (free:pinnacle) is the reference; a move is attributed to the side whose number got worse, ' +
      'so the mirrored side of the same game is not counted twice. Follow latency is quantised to the poll ' +
      'interval (hourly), so 60 minutes means "by the next poll". An opportunity is a fresh soft quote still ' +
      'better than Pinnacle\'s line at the same capture, from the capture that revealed the move until the book ' +
      'follows; stale book_updated_at stamps and post-kickoff captures are excluded. CLV is in points toward the ' +
      'side against Pinnacle\'s last pre-kickoff capture; the ATS result at the soft line is context, not the gate. ' +
      'Nulls mean no observations, never zero.'
  };
}
