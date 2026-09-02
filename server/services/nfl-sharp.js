/**
 * Following the sharp money, which is the only group that reliably beats the
 * closing line.
 *
 * Everything else in this project tried to out-forecast the market and failed
 * (docs/NFL_MODEL_STATUS.md). This does not forecast anything. It starts from
 * the observation that "the market" is not one number: a handful of books set
 * prices and the rest copy them, slowly and imperfectly.
 *
 * Pinnacle and the low-margin offshore books survive on accuracy. They take
 * large bets from winning players, hold a thin margin, and move the instant
 * money that has been right before arrives. A recreational book makes its money
 * on volume and stickiness instead, so it can afford to shade a number toward
 * whichever side the public likes and to move late.
 *
 * That difference is measurable, it is free, and it does not require predicting
 * a single snap. When the sharp consensus says a game is -2.5 and a
 * recreational book is still hanging -1.5, the recreational number is stale, and
 * taking it is positive expectation by construction — the same reasoning that
 * makes line shopping work, applied to the number instead of the price.
 *
 * This is also self-verifying. A bet placed against a stale number should show
 * up as positive closing line value once the book catches up, and nfl-clv.js
 * grades exactly that. If the divergences found here do not produce positive
 * CLV, the premise is wrong and the ledger will say so.
 */
import { rows } from '../db/index.js';
import { hasKey, gameOdds, reserveStatus } from './odds-api.js';
import { latestSnapshotPayload } from './line-shopping.js';
import { americanToProb, americanToDecimal, noVigProbability } from './nfl-clv.js';

/**
 * Books that price for accuracy, in rough order of how much their number is
 * worth. Pinnacle is the reference price in this sport; the rest are thin-margin
 * shops that take real money and move early.
 *
 * Reaching Pinnacle requires the `eu` region, which costs an extra credit per
 * market — `sharpBoard` asks for it deliberately rather than by default.
 */
export const SHARP_BOOKS = ['pinnacle', 'lowvig', 'betonlineag', 'bookmaker', 'betcris', 'matchbook', 'betfair_ex_eu'];

/**
 * Books that price for volume. These shade toward public sentiment and update
 * late, which is what makes them the place to actually bet.
 */
export const REC_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'bovada', 'mybookieag', 'betrivers', 'betus', 'espnbet', 'fanatics', 'williamhill_us'];

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Points of spread per unit of win probability, near a typical NFL number. */
const SIGMA = { spreads: 12.66, totals: 13.08 };

/**
 * Collapses one market at one book into a two-sided, vig-free view.
 * Without removing the margin, a book with wide juice would look like it
 * disagreed with a sharp book that merely charges less.
 */
function twoSided(outcomes) {
  if (!outcomes || outcomes.length < 2) return null;
  const [a, b] = outcomes;
  const pa = noVigProbability(a.price, b.price);
  if (pa == null) return null;
  return {
    a: { side: a.name, line: a.point ?? null, price: a.price, fair: pa },
    b: { side: b.name, line: b.point ?? null, price: b.price, fair: 1 - pa }
  };
}

/**
 * The sharp consensus for every game on the board.
 *
 * Consensus is the median across sharp books rather than Pinnacle alone, so one
 * book with a stale or erroneous number cannot define the reference. When only
 * Pinnacle is present the median is Pinnacle, which is the intended behaviour.
 */
export async function sharpBoard({ markets = 'spreads,totals', includePinnacle = true, source = 'auto' } = {}) {
  // Stored quotes first. The free book feeds write Pinnacle and ten other
  // books every hour into nfl_line_snapshots, which is the same evidence the
  // metered `eu` call would buy for four credits. Only fall through to the
  // paid call when nothing recent is stored and the reserve allows it.
  let data = source === 'live' ? null : latestSnapshotPayload({ markets, maxAgeMinutes: 180 });
  let provenance = 'stored_snapshots';
  if (!data?.length && source !== 'snapshots') {
    if (!hasKey()) return { error: 'no ODDS_API_KEY configured and no stored quotes in the last 3 hours' };
    if (reserveStatus().exhausted) return { error: 'odds quota at reserve and no stored quotes in the last 3 hours; the free book feeds fill this hourly' };
    // us covers the books worth betting into; eu is the only route to Pinnacle.
    const regions = includePinnacle ? 'us,eu' : 'us';
    data = await gameOdds({ markets, regions });
    provenance = 'the_odds_api';
  }
  if (!data?.length) return { error: 'no quotes available (quota, or no slate posted)' };

  const games = [];
  for (const ev of data) {
    const perMarket = {};
    for (const market of markets.split(',')) {
      const sharp = [], rec = [];
      for (const b of ev.bookmakers ?? []) {
        const m = (b.markets ?? []).find(x => x.key === market);
        const two = twoSided(m?.outcomes);
        if (!two) continue;
        const entry = { book: b.key, ...two };
        if (SHARP_BOOKS.includes(b.key)) sharp.push(entry);
        else if (REC_BOOKS.includes(b.key)) rec.push(entry);
      }
      if (!sharp.length) { perMarket[market] = { sharp_books: 0, note: 'no sharp book quoting — no reference price' }; continue; }

      // Orient every book the same way before taking a median, otherwise home
      // and away quotes would average into nonsense.
      const ref = sharp[0].a.side;
      const orient = e => (e.a.side === ref ? e.a : e.b);
      const sharpLine = median(sharp.map(e => orient(e).line).filter(v => v != null));
      const sharpFair = median(sharp.map(e => orient(e).fair).filter(v => v != null));

      perMarket[market] = {
        reference_side: ref,
        sharp_line: r2(sharpLine), sharp_fair_prob: r4(sharpFair),
        sharp_books: sharp.length,
        books: { sharp: sharp.map(e => ({ book: e.book, line: orient(e).line, price: orient(e).price })),
          rec: rec.map(e => ({ book: e.book, line: orient(e).line, price: orient(e).price })) },
        _sharp: sharp, _rec: rec, _ref: ref
      };
    }
    games.push({
      event_id: ev.id, commence_time: ev.commence_time,
      matchup: `${ev.away_team} at ${ev.home_team}`,
      home_team: ev.home_team, away_team: ev.away_team,
      markets: perMarket
    });
  }
  return { games, provenance, as_of: data[0]?.captured_at ?? new Date().toISOString(),
    sharp_books_seen: [...new Set(data.flatMap(e => (e.bookmakers ?? []).map(b => b.key)))].filter(k => SHARP_BOOKS.includes(k)) };
}

/**
 * Recreational numbers that have not caught up to the sharp consensus.
 *
 * `edge_pct` is the expected return of taking the stale number, priced against
 * the sharp book's implied distribution — the same calculation nfl-clv.js uses
 * to grade a bet against the close, applied before kickoff instead of after.
 * A positive number here is a claim that will be checked automatically later.
 */
export async function sharpDivergence({ minEdgePct = 0.01, markets = 'spreads,totals' } = {}) {
  const board = await sharpBoard({ markets });
  if (board.error) return board;

  const { fairProbabilityOfOurBet } = await import('./nfl-clv.js');
  const out = [];
  for (const g of board.games) {
    for (const [market, m] of Object.entries(g.markets)) {
      if (!m?._sharp?.length) continue;
      for (const rec of m._rec) {
        for (const sideKey of ['a', 'b']) {
          const q = rec[sideKey];
          // The sharp reference for this exact side.
          const sharpSame = m._ref === q.side ? m.sharp_fair_prob : 1 - m.sharp_fair_prob;
          const sharpLine = m._ref === q.side ? m.sharp_line
            : (market === 'totals' ? m.sharp_line : -m.sharp_line);
          if (sharpSame == null || q.line == null) continue;

          const fair = fairProbabilityOfOurBet({
            market, ourLine: q.line, closeLine: sharpLine,
            closeFairProb: sharpSame, side: q.side
          });
          const dec = americanToDecimal(q.price);
          if (fair == null || dec == null) continue;
          const edge = fair * dec - 1;
          if (edge < minEdgePct) continue;

          out.push({
            matchup: g.matchup, event_id: g.event_id, commence_time: g.commence_time,
            market, side: q.side,
            take: `${q.side} ${q.line > 0 ? '+' : ''}${q.line} (${q.price > 0 ? '+' : ''}${q.price})`,
            book: rec.book, line: q.line, price: q.price,
            sharp_line: sharpLine, sharp_fair_prob: r4(sharpSame),
            // Signed so positive always means "we got the better number":
            // an Over wants a lower total, an Under and any spread want a higher one.
            line_gap: r2(market === 'totals' && q.side === 'Over'
              ? sharpLine - q.line
              : q.line - sharpLine),
            edge_pct: r4(edge),
            sharp_books: m.sharp_books,
            reasoning: `${rec.book} is offering ${q.line} where the sharp consensus (${m.sharp_books} book${m.sharp_books === 1 ? '' : 's'}) sits at ${sharpLine}. Taking the stale number is worth ${(edge * 100).toFixed(1)}% if the sharp price is the accurate one.`
          });
        }
      }
    }
  }
  out.sort((a, b) => b.edge_pct - a.edge_pct);
  return {
    opportunities: out,
    sharp_books_seen: board.sharp_books_seen,
    note: board.sharp_books_seen.length
      ? 'Every opportunity here is a claim that a recreational book is stale. Bet it, log it with recordBet(), and the CLV ledger will confirm or refute the premise within about fifty bets.'
      : 'No sharp book was quoting this slate. Without a reference price these are not divergences — enable the eu region so Pinnacle is included.'
  };
}

/**
 * Synchronised moves across books — the fingerprint of money, not opinion.
 *
 * One book moving is a bookmaker adjusting. Several books moving the same
 * direction within a short window is a syndicate hitting all of them, and it is
 * the clearest public trace of sharp action there is. This reads the stored
 * snapshots, so it improves as the capture job accumulates history.
 */
export function steamMoves({ windowMinutes = 180, minBooks = 3, minPoints = 0.5 } = {}) {
  const snaps = rows(`SELECT captured_at, event_id, home_team, away_team, book, market, side, line
                      FROM nfl_line_snapshots WHERE line IS NOT NULL
                      ORDER BY event_id, market, side, book, captured_at`);
  if (!snaps.length) return { available: false, note: 'no line snapshots captured yet' };

  const captures = [...new Set(snaps.map(s => s.captured_at))].sort();
  if (captures.length < 2) {
    return {
      available: false, captures: captures.length,
      note: 'Steam detection needs at least two captures of the same game. The scheduled snapshot job builds this up over a few days.'
    };
  }

  // Per book/side, the movement between consecutive captures.
  const series = new Map();
  for (const s of snaps) {
    const k = `${s.event_id}|${s.market}|${s.side}|${s.book}`;
    if (!series.has(k)) series.set(k, []);
    series.get(k).push(s);
  }

  const moves = new Map();     // event|market|side|window -> [{book, delta}]
  for (const [k, list] of series) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      const delta = cur.line - prev.line;
      if (Math.abs(delta) < minPoints) continue;
      const gap = (new Date(cur.captured_at) - new Date(prev.captured_at)) / 60000;
      if (gap > windowMinutes) continue;
      const [event_id, market, side] = k.split('|');
      const bucket = `${event_id}|${market}|${side}|${cur.captured_at}`;
      if (!moves.has(bucket)) {
        moves.set(bucket, { event_id, market, side, at: cur.captured_at,
          home_team: cur.home_team, away_team: cur.away_team, books: [] });
      }
      moves.get(bucket).books.push({ book: cur.book, from: prev.line, to: cur.line, delta: r2(delta) });
    }
  }

  const out = [];
  for (const m of moves.values()) {
    // Only a move in the *same direction* across books counts as steam; books
    // drifting apart is noise, not coordination.
    const up = m.books.filter(b => b.delta > 0), down = m.books.filter(b => b.delta < 0);
    const agreed = up.length >= down.length ? up : down;
    if (agreed.length < minBooks) continue;
    out.push({
      matchup: `${m.away_team} at ${m.home_team}`,
      market: m.market, side: m.side, detected_at: m.at,
      books_moved: agreed.length,
      direction: agreed[0].delta > 0 ? 'up' : 'down',
      average_move: r2(agreed.reduce((s, b) => s + b.delta, 0) / agreed.length),
      moves: agreed,
      reasoning: `${agreed.length} books moved ${m.side} ${agreed[0].delta > 0 ? 'up' : 'down'} together. Simultaneous movement across independent books is money arriving, not opinion changing.`
    });
  }
  out.sort((a, b) => b.books_moved - a.books_moved || Math.abs(b.average_move) - Math.abs(a.average_move));
  return { available: true, captures: captures.length, steam: out };
}

/**
 * Whether the sharp premise is actually holding up, judged only by CLV.
 *
 * This is the check that keeps the whole idea honest. Divergence picks claim a
 * recreational number is stale; if that claim were false, bets on them would
 * close at or worse than where they were taken.
 */
export function sharpScorecard() {
  const bets = rows(`SELECT * FROM nfl_bet_log
                     WHERE source IN ('sharp_divergence','steam') AND graded_at IS NOT NULL`);
  if (bets.length < 10) {
    return {
      available: false, bets: bets.length,
      note: `Only ${bets.length} graded sharp-sourced bets. Log divergence picks with source 'sharp_divergence' and this becomes readable at around fifty.`
    };
  }
  const pcts = bets.map(b => b.clv_pct).filter(v => v != null);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const beat = pcts.filter(v => v > 0).length;
  return {
    available: true, bets: bets.length,
    mean_clv_pct: r4(mean(pcts)),
    beat_close_rate: r4(beat / pcts.length),
    verdict: mean(pcts) > 0
      ? 'Sharp-sourced bets are closing better than they were taken. The premise is holding.'
      : 'Sharp-sourced bets are not beating the close. The divergences being found are not real staleness.'
  };
}
