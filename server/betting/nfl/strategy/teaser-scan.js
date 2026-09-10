/**
 * The weekly two-team, six-point teaser scan.
 *
 * This turns the measurement in `teaser-leg-rates.js` into a board: which legs
 * are on offer at a given book right now, which pairs of them are legal, what
 * each pair is worth at the price that book actually charges, and — when the
 * answer is nothing — exactly which gate said no.
 *
 * WHY THIS IS NOT BUILT ON `simultaneousQuotes`.
 *
 * The obvious move is to reuse the line-shopping board. It is the wrong shape,
 * and wrong in a way that silently deletes the only book that matters here.
 * `simultaneousQuotes` takes each event's MAX(captured_at) and keeps only rows
 * stamped at that exact instant, because comparing books is only meaningful if
 * the quotes are contemporaneous. But the capture tiers run at different
 * cadences — roughly 6 minutes for the fast tier, hourly for everything else —
 * so a book on the slow tier is shadowed by a fresher row from a fast-tier book
 * on essentially every event, and vanishes.
 *
 * A teaser scan does not need contemporaneity. It needs the newest quote from
 * ONE book. So this ranks per (event, book) over a window instead of pinning to
 * a single instant, which is the difference between seeing DraftKings and not.
 *
 * WHERE DRAFTKINGS ACTUALLY LIVES.
 *
 * Not in the quote tape. `nfl_quote_tape` holds no DraftKings row for the 2026
 * season at all — its newest DK row is from January, left over from a
 * the-odds-api backfill. The live DK board is in `nfl_line_snapshots`, written
 * hourly by `book-feeds-extra.js`, which says at its own top that it does not
 * feed the tape.
 *
 * That is a real difference in evidentiary weight, not a detail of plumbing, so
 * every leg this module emits carries its `provenance`. A first-hand tape quote
 * and a second-hand hourly aggregator scrape are not the same claim, and a
 * board that presents them identically is lying by omission.
 */
import { db } from '../../../db/index.js';
import {
  CROSS_BOTH_LINES, familyRate, teasedLegRate, ticketEV, ticketProbabilities,
} from './teaser-leg-rates.js';

/**
 * Where a book's spreads come from, and how old a quote may be before it stops
 * being a price and starts being a memory.
 *
 * The budgets are sized off measured cadence, not taste: the fast tier's worst
 * observed gap is ~44 minutes and the hourly tier's is ~97, so a single global
 * threshold would either reject live fast-tier quotes or admit dead hourly
 * ones. `kickoff` is a separate gate because the tables are append-only — a
 * played game keeps its last quote forever and will look perfectly fresh.
 */
export const SPREAD_SOURCES = Object.freeze({
  tape: Object.freeze({
    table: 'nfl_quote_tape', provenance: 'first_hand_tape',
    maxAgeMinutes: 30,
    books: Object.freeze(['pinnacle', 'betonlineag', 'sportsbetting', 'lowvig', 'heritage',
      'bodog', 'unibet', 'bovada', 'gtbets', 'everygame', 'betrivers', 'fanduel']),
  }),
  snapshots: Object.freeze({
    table: 'nfl_line_snapshots', provenance: 'second_hand_aggregator',
    maxAgeMinutes: 120,
    books: Object.freeze(['draftkings', 'betmgm', 'caesars', 'circa', 'bet365',
      'hardrock', 'fanatics', 'thescore', 'betr']),
  }),
});

export function sourceForBook(book) {
  const key = String(book ?? '').toLowerCase().replace(/[\s-]/g, '');
  if (SPREAD_SOURCES.snapshots.books.includes(key)) return { key, ...SPREAD_SOURCES.snapshots };
  if (SPREAD_SOURCES.tape.books.includes(key)) return { key, ...SPREAD_SOURCES.tape };
  return null;
}

const CROSS_BOTH = new Set(CROSS_BOTH_LINES);

/**
 * The newest spread each side of each upcoming game is quoted at, for one book.
 *
 * `event_id LIKE 'nfl:%'` is load-bearing. Both tables also hold rows keyed by
 * the-odds-api's opaque hex ids from historical backfills, and those are a
 * different key space describing earlier seasons. Mixing them silently drags
 * last season's board into this week's scan.
 *
 * Ordering is on the capture clock rather than the book's own change stamp.
 * `book_updated_at` does not advance while a line holds, so ordering by it
 * returns an older capture of the same number — and for feeds that supply no
 * stamp the field is backfilled with the capture clock anyway.
 */
export function bookSpreadBoard({ book, now = new Date(), fromCommence = null } = {}) {
  const source = sourceForBook(book);
  if (!source) return { book, error: `no known spread source for book '${book}'`, sides: [] };
  const nowIso = new Date(now).toISOString();
  const floor = fromCommence ?? nowIso;

  const sides = source.table === 'nfl_line_snapshots'
    ? db.prepare(`
        WITH ranked AS (
          SELECT event_id, commence_time, home_team, away_team, side, line, price,
                 captured_at, provider,
                 ROW_NUMBER() OVER (PARTITION BY event_id, side
                                    ORDER BY captured_at DESC) rn
            FROM nfl_line_snapshots
           WHERE book = ? AND market = 'spreads'
             AND event_id LIKE 'nfl:%' AND commence_time > ?)
        SELECT * FROM ranked WHERE rn = 1 ORDER BY commence_time, event_id`).all(source.key, floor)
    : db.prepare(`
        WITH ranked AS (
          SELECT provider_event_id AS event_id, commence_time, home_team, away_team,
                 side_name AS side, line, american_price AS price,
                 snapshot_at AS captured_at, provider,
                 ROW_NUMBER() OVER (PARTITION BY provider_event_id, side_key
                                    ORDER BY snapshot_at DESC, created_at DESC) rn
            FROM nfl_quote_tape
           WHERE bookmaker_key = ? AND market = 'spreads' AND period = 'full_game'
             AND provider_event_id LIKE 'nfl:%' AND commence_time > ?)
        SELECT * FROM ranked WHERE rn = 1 ORDER BY commence_time, event_id`).all(source.key, floor);

  const ageMinutes = at => (new Date(nowIso) - new Date(at)) / 60000;
  const priced = sides.map(side => ({
    ...side,
    provenance: source.provenance,
    age_minutes: Math.round(ageMinutes(side.captured_at) * 10) / 10,
    fresh: ageMinutes(side.captured_at) <= source.maxAgeMinutes,
  }));

  // A mirror check, free and worth doing: the two sides of a game must be equal
  // and opposite. A one-sided or non-mirrored game means the capture is torn,
  // and a torn capture is exactly how a leg gets priced off a number that was
  // never really offered.
  const byEvent = new Map();
  for (const side of priced) {
    if (!byEvent.has(side.event_id)) byEvent.set(side.event_id, []);
    byEvent.get(side.event_id).push(side);
  }
  const torn = [...byEvent.entries()]
    .filter(([, s]) => s.length !== 2 || Math.abs(s[0].line + s[1].line) > 1e-9)
    .map(([id]) => id);

  return {
    book: source.key, source: source.table, provenance: source.provenance,
    max_age_minutes: source.maxAgeMinutes,
    captured_at: priced[0]?.captured_at ?? null,
    games: byEvent.size, sides: priced, torn_events: torn,
  };
}

/**
 * Per-leg win and push probabilities.
 *
 * The split matters and is easy to get backwards. The DECIDED rate is pooled
 * across the whole eight-number family, because the per-line differences are
 * noise (chi-square 5.994 on 7 df, p = 0.54 — less dispersion than one common
 * rate predicts). The PUSH share is not pooled, because it is structural rather
 * than sampled: a half-point leg cannot push at all, and an integer leg pushes
 * whenever the game lands exactly on the teased number.
 *
 * So: take the family's decided rate, take this line's own push share, and
 * split the remaining mass between win and loss at that rate.
 */
export function legProbabilities(line, { decidedRate = null, pushShare = null } = {}) {
  const rate = decidedRate ?? familyRate({ side: 'all' }).rate_of_decided;
  const t = pushShare ?? teasedLegRate(line).push_share;
  if (!Number.isFinite(rate) || rate <= 0) {
    // An empty or unmeasurable history must not quietly price a ticket at zero.
    throw new Error('teaser leg rates are unavailable — the measurement window has no games in it');
  }
  return { line, w: (1 - t) * rate, t, decided_rate: rate };
}

/**
 * The scan.
 *
 * Returns every legal ticket at this book with what it is worth, and — when a
 * gate refuses — the reason, because "no candidates" and "no candidates because
 * your recorded price expired on Thursday" are different problems.
 */
export function scanTeaserBoard({ book = 'draftkings', now = new Date(),
  priceFloor = -115, maxPriceAgeHours = 168, reducedPayout = 'stake_back',
  legProbability = legProbabilities } = {}) {
  const nowIso = new Date(now).toISOString();
  const board = bookSpreadBoard({ book, now });
  if (board.error) return { ...board, candidates: [], blocked_reasons: [board.error] };

  const blocked = [];
  const legs = board.sides
    .filter(side => CROSS_BOTH.has(side.line))
    .map(side => ({ ...side, ...legProbability(side.line) }));
  const stale = legs.filter(leg => !leg.fresh);
  const usable = legs.filter(leg => leg.fresh);
  if (stale.length) {
    blocked.push(`${stale.length} qualifying leg(s) older than ${board.max_age_minutes} minutes.`);
  }

  // The teaser payout, which is the only price that decides anything here. The
  // juice on the underlying spread is irrelevant — a teaser does not pay it.
  const price = db.prepare(`SELECT * FROM nfl_teaser_price_ledger
    WHERE teaser_points = 6 AND legs = 2 AND reachable = 1
      AND lower(replace(replace(book,' ',''),'-','')) = ?
    ORDER BY captured_at DESC, id DESC LIMIT 1`).get(board.book);

  if (!price) {
    blocked.push(`No reachable two-team six-point teaser price recorded for ${board.book}. Record one.`);
  } else {
    const ageHours = (new Date(nowIso) - new Date(price.captured_at)) / 3600000;
    if (ageHours > maxPriceAgeHours) {
      blocked.push(`The recorded ${board.book} price is ${Math.round(ageHours)}h old, past the ${maxPriceAgeHours}h limit. Re-record it.`);
    }
    if (price.american_price < priceFloor) {
      blocked.push(`Price ${price.american_price} is worse than the ${priceFloor} operating floor.`);
    }
  }

  const candidates = [];
  if (price && !blocked.length) {
    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        const a = usable[i]; const b = usable[j];
        // Different games. On this family it is automatic — a game's two sides
        // can never both qualify, since the counterpart of a -7..-8.5 favourite
        // is a +7..+8.5 dog, which is not in the set — but it is asserted
        // rather than assumed, because it is also a book rule and a schema
        // constraint, and the day it stops being automatic is the day it
        // matters most.
        if (a.event_id === b.event_id) continue;
        const pair = [{ w: a.w, t: a.t }, { w: b.w, t: b.t }];
        const ev = ticketEV({ legs: pair, americanPrice: price.american_price, reducedPayout });
        if (ev.ev <= 0) continue;
        candidates.push({
          legs: [a, b].map(l => ({ event_id: l.event_id, team: l.side, line: l.line,
            teased_to: l.line + 6, commence_time: l.commence_time,
            spread_price: l.price, captured_at: l.captured_at,
            age_minutes: l.age_minutes, provenance: l.provenance })),
          american_price: price.american_price,
          probabilities: ticketProbabilities(pair),
          ev: ev.ev, ev_percent: ev.ev_percent,
          reduced_payout: reducedPayout, reduced_payout_verified: false,
        });
      }
    }
    // Every pair shares one family rate, so EV separates only on push mass —
    // which is exactly the right tiebreak. Half-point legs cannot push, so they
    // sort to the top on their own without anyone hand-picking "good numbers".
    candidates.sort((x, y) => y.ev - x.ev);
  }

  return {
    book: board.book, source: board.source, provenance: board.provenance,
    scanned_at: nowIso, board_captured_at: board.captured_at,
    games_on_board: board.games, torn_events: board.torn_events,
    qualifying_legs: legs.length, usable_legs: usable.length, stale_legs: stale.length,
    price: price ?? null,
    candidates, candidate_count: candidates.length,
    blocked_reasons: blocked,
  };
}
