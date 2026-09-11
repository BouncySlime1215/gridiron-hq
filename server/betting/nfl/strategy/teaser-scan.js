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
  CROSS_BOTH_LINES, TEASER_POINTS, familyRate, teasedLegRate, ticketEV, ticketProbabilities,
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
export function bookSpreadBoard({ book, now = new Date(), fromCommence = null,
  toCommence = null } = {}) {
  const source = sourceForBook(book);
  if (!source) return { book, error: `no known spread source for book '${book}'`, sides: [] };
  const nowIso = new Date(now).toISOString();
  const floor = fromCommence ?? nowIso;

  // `toCommence` is optional and exists only so a caller can ask for one week
  // rather than "everything not yet kicked off". It is never a substitute for
  // the kickoff floor above: the floor is a correctness gate (an append-only
  // table keeps a played game's last quote forever), the ceiling is a filter.
  const ceiling = toCommence ? new Date(toCommence).toISOString() : null;
  const bounds = ceiling ? ' AND commence_time < ?' : '';
  const params = ceiling ? [source.key, floor, ceiling] : [source.key, floor];

  const sides = source.table === 'nfl_line_snapshots'
    ? db.prepare(`
        WITH ranked AS (
          SELECT event_id, commence_time, home_team, away_team, side, line, price,
                 captured_at, provider,
                 ROW_NUMBER() OVER (PARTITION BY event_id, side
                                    ORDER BY captured_at DESC) rn
            FROM nfl_line_snapshots
           WHERE book = ? AND market = 'spreads'
             AND event_id LIKE 'nfl:%' AND commence_time > ?${bounds})
        SELECT * FROM ranked WHERE rn = 1 ORDER BY commence_time, event_id`).all(...params)
    : db.prepare(`
        WITH ranked AS (
          SELECT provider_event_id AS event_id, commence_time, home_team, away_team,
                 side_name AS side, line, american_price AS price,
                 snapshot_at AS captured_at, provider,
                 ROW_NUMBER() OVER (PARTITION BY provider_event_id, side_key
                                    ORDER BY snapshot_at DESC, created_at DESC) rn
            FROM nfl_quote_tape
           WHERE bookmaker_key = ? AND market = 'spreads' AND period = 'full_game'
             AND provider_event_id LIKE 'nfl:%' AND commence_time > ?${bounds})
        SELECT * FROM ranked WHERE rn = 1 ORDER BY commence_time, event_id`).all(...params);

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

  // `captured_at` is the FIRST row's stamp (rows are ordered by kickoff), kept
  // as it was because callers already read it. `newest_captured_at` is the one
  // an operator actually wants next to a refresh button — "when did this book
  // last say anything" — and `age_minutes` is that in the unit the UI shows.
  const newest = priced.reduce((max, s) => (max == null || s.captured_at > max ? s.captured_at : max), null);

  return {
    book: source.key, source: source.table, provenance: source.provenance,
    max_age_minutes: source.maxAgeMinutes,
    captured_at: priced[0]?.captured_at ?? null,
    newest_captured_at: newest,
    age_minutes: newest == null ? null : Math.round(ageMinutes(newest) * 10) / 10,
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
  legProbability = legProbabilities, fromCommence = null, toCommence = null } = {}) {
  const board = bookSpreadBoard({ book, now, fromCommence, toCommence });
  return scanFromBoard(board, { now, priceFloor, maxPriceAgeHours, reducedPayout, legProbability });
}

/**
 * The pricing half of the scan, split out from the query half.
 *
 * `scanAllBooks` needs each book's raw board TWICE — once to price that book's
 * own tickets and once to put its number next to every other book's in the
 * comparison. Splitting here means it reads each book's table once instead of
 * twice; the single-book entry point above is unchanged in behaviour.
 */
function scanFromBoard(board, { now = new Date(), priceFloor = -115,
  maxPriceAgeHours = 168, reducedPayout = 'stake_back',
  legProbability = legProbabilities } = {}) {
  const nowIso = new Date(now).toISOString();
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
    // The contract the client renders against: `captured_at`/`age_minutes` are
    // this book's NEWEST quote, which is the number an operator reads next to a
    // refresh button. `board_captured_at` is kept as it was.
    captured_at: board.newest_captured_at ?? null,
    age_minutes: board.age_minutes ?? null,
    max_age_minutes: board.max_age_minutes,
    games_on_board: board.games, torn_events: board.torn_events,
    qualifying_legs: legs.length, usable_legs: usable.length, stale_legs: stale.length,
    price: price ?? null,
    candidates, candidate_count: candidates.length,
    blocked_reasons: blocked,
  };
}

/* =========================================================================
 * THE MULTI-BOOK SCAN, AND WHY ITS COMPARISON RANKS BY MEASURED RATE
 *
 * Scanning several books at once is not just three copies of the scan above.
 * The moment two boards sit side by side, the operator has a new decision to
 * make — "book A says -7, book B says -7.5, which do I take?" — and that
 * decision has a measured answer that is the OPPOSITE of the intuitive one.
 *
 * THE SHOP-IN TRAP. The folklore Wong window is -7.5/-8/-8.5 and +1.5/+2/+2.5.
 * `teaser-leg-rates.js` derives the real crossing condition instead and finds
 * eight lines, adding -7.0 and +3.0. So an operator who learned the folklore
 * window sees a -7.0 on their board and reads it as "not quite a Wong leg",
 * then shops until some book shows -7.5 and takes that. Measured on this
 * database, 1999-2024:
 *
 *     -7.0  75.22% of decided legs (n = 472)
 *     -7.5  74.91% of decided legs (n = 275)
 *
 * The shop-in is a DOWNGRADE. It is also the single most common one available,
 * because -7/-7.5 is the most frequently offered pair in the family. Half a
 * point of "more qualifying" costs 0.31 points of measured rate, and the leg
 * that felt marginal was the better leg.
 *
 * So the comparison below ranks a book's number by `teasedLegRate(line)` — the
 * measured rate for that EXACT line — and never by whether the line is inside
 * anybody's window. Qualification is a filter on what is playable at all, not
 * an ordering over what is playable.
 *
 * WHY USING A PER-LINE RATE HERE DOES NOT CONTRADICT `use_for_ev: false`.
 * `teaser-leg-rates.js` is emphatic that per-line rates must not price a
 * ticket, and that stands: `scanFromBoard` above still prices every candidate
 * off the pooled `familyRate`. The two uses are different questions.
 *
 *   PRICING asks "what is this bet worth?" — a question about a leg drawn from
 *   the family, where the per-line spread is noise (chi-square 5.99 on 7 df,
 *   p = 0.54) and selecting on it is selecting on sampling error.
 *   SHOPPING asks "these two numbers are on the SAME GAME right now, which is
 *   the better one?" — where the football is held fixed and the only thing that
 *   differs is the posted number. There is no other measurement that answers
 *   it, and refusing to answer it does not make the operator not shop; it makes
 *   them shop on folklore.
 *
 * READ THE `rate_delta_within_noise` FLAG. The honest reading of -7.0 vs -7.5
 * is not "-7.0 is 0.31pp better"; it is "there is no measurable reason to move,
 * so do not pay a half point for one". Every ranking this module emits carries
 * whether the gap it is ranking on is larger than the standard error of the
 * two cells, so a UI can say "these are the same number" rather than implying
 * a precision the data does not have.
 *
 * WHERE MEASURED RATE AND QUALIFICATION AGREE. At the family's BOUNDARY they
 * agree, and that is the evidence the family is real rather than a window
 * somebody liked: -7.0 (75.22%) beats its non-crossing neighbour -6.5 (71.00%)
 * and +3.0 (72.67%) beats +3.5 (68.12%). They disagree only WITHIN the family,
 * which is exactly where the ordering is doing work.
 * ========================================================================= */

/**
 * The classic window, kept only so the comparison can NAME the trap.
 *
 * This is not a gate and nothing filters on it. It is here so that when the
 * best-measured number is one folklore excludes, the comparison can say why an
 * operator will be tempted to move off it.
 */
export const FOLKLORE_WONG_LINES = Object.freeze([-8.5, -8, -7.5, 1.5, 2, 2.5]);
const FOLKLORE = new Set(FOLKLORE_WONG_LINES);

/** The books the weekly scan looks at unless told otherwise. */
export const DEFAULT_WONG_BOOKS = Object.freeze(['draftkings', 'fanduel', 'pinnacle']);

/**
 * The measured record of one exact posted line, in the shape the comparison
 * ranks on. Thin over `teasedLegRate`, which caches its own table scan.
 *
 * Injectable everywhere it is used, because a fixture database has no
 * `game_lines` and the comparison's job is ordering, not measurement.
 */
export function measuredLineRate(line) {
  if (!Number.isFinite(line)) return null;
  const measured = teasedLegRate(line);
  return {
    line,
    teased_to: measured.teased_to,
    qualifies: measured.crosses_both,
    rate: measured.rate_of_decided,
    n: measured.n,
    decided: measured.decided,
    push_share: measured.push_share,
    standard_error: measured.standard_error,
  };
}

/** Is a gap between two measured rates bigger than the two cells' own noise? */
function gapWithinNoise(a, b) {
  if (a?.rate == null || b?.rate == null) return null;
  const se = Math.sqrt((a.standard_error ?? 0) ** 2 + (b.standard_error ?? 0) ** 2);
  if (!(se > 0)) return null;
  return Math.abs(a.rate - b.rate) < se;
}

const round = (value, dp = 4) =>
  (value == null || !Number.isFinite(value) ? null : +value.toFixed(dp));

/**
 * One game, every book's number on it, ranked.
 *
 * ANCHORING. A game has two sides and the two numbers are mirrors, so a
 * per-book comparison has to pick a side to speak about or it will compare
 * -7.5 against +7.5 and call it a disagreement. The anchor is the side that
 * the most books have inside the family (at most one side of a game can ever
 * qualify — the counterpart of a -7..-8.5 favourite is a +7..+8.5 dog, which is
 * not in the set), falling back to the home side when no book qualifies. Every
 * entry carries its own `side` so the choice is never implicit.
 */
export function compareBooks(boards, { lineRate = measuredLineRate } = {}) {
  const usable = boards.filter(board => board && !board.error && Array.isArray(board.sides));
  const bookOrder = usable.map(board => board.book);

  const events = new Map();
  for (const board of usable) {
    for (const side of board.sides) {
      let event = events.get(side.event_id);
      if (!event) {
        event = { event_id: side.event_id, home_team: side.home_team, away_team: side.away_team,
          commence_time: side.commence_time, byBook: new Map() };
        events.set(side.event_id, event);
      }
      if (!event.byBook.has(board.book)) event.byBook.set(board.book, new Map());
      event.byBook.get(board.book).set(side.side, { ...side, source: board.source });
    }
  }

  const comparison = [];
  for (const event of events.values()) {
    // Which side to speak about — see ANCHORING above.
    const qualifyingCount = new Map();
    const seenSides = new Set();
    for (const sides of event.byBook.values()) {
      for (const [name, quote] of sides) {
        seenSides.add(name);
        if (CROSS_BOTH.has(quote.line)) qualifyingCount.set(name, (qualifyingCount.get(name) ?? 0) + 1);
      }
    }
    const anchor = [...seenSides].sort((a, b) =>
      (qualifyingCount.get(b) ?? 0) - (qualifyingCount.get(a) ?? 0)
      || Number(b === event.home_team) - Number(a === event.home_team)
      || a.localeCompare(b))[0] ?? event.home_team;

    const byBook = bookOrder.map(book => {
      const board = usable.find(candidate => candidate.book === book);
      const quote = event.byBook.get(book)?.get(anchor) ?? null;
      const measured = quote ? lineRate(quote.line) : null;
      const qualifies = quote ? CROSS_BOTH.has(quote.line) : false;
      return {
        book,
        line: quote?.line ?? null,
        side: anchor,
        price: quote?.price ?? null,
        qualifies,
        measured_rate: round(measured?.rate),
        provenance: quote?.provenance ?? board.provenance,
        age_minutes: quote?.age_minutes ?? null,
        // Beyond the fixed contract, and all of it load-bearing for a decision:
        teased_to: quote ? round(quote.line + TEASER_POINTS, 1) : null,
        fresh: quote?.fresh ?? false,
        // A number can qualify and still be unbettable because it is a memory.
        playable: Boolean(quote && qualifies && quote.fresh),
        source: board.source,
        captured_at: quote?.captured_at ?? null,
        max_age_minutes: board.max_age_minutes,
        measured_sample: measured?.n ?? null,
        measured_standard_error: round(measured?.standard_error, 6),
        push_share: round(measured?.push_share, 6),
        in_folklore_window: quote ? FOLKLORE.has(quote.line) : null,
        missing_reason: quote ? null
          : `${book} has no spread for this game in ${board.source} inside the freshness window`,
        _measured: measured,
      };
    });

    // The ranking. Qualification decides WHETHER a number is a candidate at
    // all; measured rate decides the order among candidates. Nothing here
    // prefers a number for being deeper inside anybody's window.
    const playable = byBook.filter(entry => entry.qualifies && entry.line != null);
    const ranked = [...playable].sort((a, b) =>
      (b._measured?.rate ?? -Infinity) - (a._measured?.rate ?? -Infinity)
      || (a.age_minutes ?? Infinity) - (b.age_minutes ?? Infinity)
      || bookOrder.indexOf(a.book) - bookOrder.indexOf(b.book));
    const top = ranked[0] ?? null;

    // Every move OFF the best number, and what it costs. This is the shop-in
    // trap made explicit: the entries with a negative `rate_delta` are moves an
    // operator is tempted to make because the destination is "more Wong".
    const shopMoves = [];
    for (const entry of ranked.slice(1)) {
      if (entry.line === top.line) continue;
      const delta = (entry._measured?.rate ?? null) == null || top._measured?.rate == null
        ? null : entry._measured.rate - top._measured.rate;
      const noise = gapWithinNoise(entry._measured, top._measured);
      shopMoves.push({
        from_book: top.book, from_line: top.line, to_book: entry.book, to_line: entry.line,
        rate_delta: round(delta),
        rate_delta_within_noise: noise,
        verdict: delta == null ? 'unmeasured'
          : delta < 0 ? (noise ? 'downgrade, but inside the noise — no reason to move'
            : 'measured downgrade')
            : 'no gain',
        folklore_trap: Boolean(entry.in_folklore_window && top.in_folklore_window === false),
        note: entry.in_folklore_window && top.in_folklore_window === false
          ? `${top.line} is outside the classic Wong window and ${entry.line} is inside it, which is `
            + `why this move is tempting. It is not an upgrade: ${top.line} measures `
            + `${round((top._measured?.rate ?? 0) * 100, 2)}% against ${entry.line}'s `
            + `${round((entry._measured?.rate ?? 0) * 100, 2)}%.`
          : null,
      });
    }

    const offered = new Map();
    for (const entry of byBook) {
      if (entry.line == null) continue;
      if (!offered.has(entry.line)) {
        offered.set(entry.line, { line: entry.line, qualifies: entry.qualifies,
          measured_rate: entry.measured_rate, books: [] });
      }
      offered.get(entry.line).books.push(entry.book);
    }
    const lines = [...offered.values()].sort((a, b) => (b.measured_rate ?? -1) - (a.measured_rate ?? -1));
    const numbers = [...offered.keys()];

    comparison.push({
      event_id: event.event_id,
      home_team: event.home_team,
      away_team: event.away_team,
      commence_time: event.commence_time,
      anchor_side: anchor,
      by_book: byBook.map(({ _measured, ...entry }) => entry),
      best: top
        ? {
          ...Object.fromEntries(Object.entries(top).filter(([key]) => key !== '_measured')),
          reason: 'highest measured teased rate among the numbers on offer that cross both key '
            + 'numbers — NOT the number deepest inside the classic window',
          measured_rate_percent: round((top._measured?.rate ?? 0) * 100, 2),
          alternatives_cost: shopMoves.length,
        }
        : null,
      best_blocked_reason: top ? null
        : (playable.length ? null : 'no book has this game on a line that crosses both 3 and 7'),
      books_on_board: byBook.filter(entry => entry.line != null).length,
      books_qualifying: playable.length,
      books_playable: byBook.filter(entry => entry.playable).length,
      books_missing: byBook.filter(entry => entry.line == null).map(entry => entry.book),
      books_stale: byBook.filter(entry => entry.line != null && !entry.fresh).map(entry => entry.book),
      lines_offered: lines,
      books_disagree: numbers.length > 1,
      line_spread: numbers.length > 1 ? round(Math.max(...numbers) - Math.min(...numbers), 1) : 0,
      shop_moves: shopMoves,
      shop_in_downgrades: shopMoves.filter(move => move.rate_delta != null && move.rate_delta < 0).length,
    });
  }

  comparison.sort((a, b) => String(a.commence_time).localeCompare(String(b.commence_time))
    || a.event_id.localeCompare(b.event_id));
  return comparison;
}

/**
 * The whole board, every book at once, plus the cross-book comparison.
 *
 * An unknown book is reported as an entry with an `error` rather than dropped
 * or thrown on: asking for four books and silently getting three is how a book
 * disappears from an operator's routine without anyone noticing.
 */
export function scanAllBooks({ books = DEFAULT_WONG_BOOKS, now = new Date(),
  priceFloor = -115, maxPriceAgeHours = 168, reducedPayout = 'stake_back',
  legProbability = legProbabilities, lineRate = measuredLineRate,
  fromCommence = null, toCommence = null } = {}) {
  const nowIso = new Date(now).toISOString();
  const requested = [...new Set((books ?? [])
    .map(book => String(book ?? '').trim().toLowerCase().replace(/[\s-]/g, ''))
    .filter(Boolean))];

  const boards = requested.map(book => bookSpreadBoard({ book, now, fromCommence, toCommence }));
  const scans = boards.map(board => {
    const scan = scanFromBoard(board, { now, priceFloor, maxPriceAgeHours, reducedPayout, legProbability });
    // One shape for the client whether or not the book resolved, so a rendering
    // loop never has to branch on which kind of entry it got.
    return {
      book: scan.book, provenance: scan.provenance ?? null, source: scan.source ?? null,
      captured_at: scan.captured_at ?? null, age_minutes: scan.age_minutes ?? null,
      max_age_minutes: scan.max_age_minutes ?? null,
      games_on_board: scan.games_on_board ?? 0,
      qualifying_legs: scan.qualifying_legs ?? 0,
      usable_legs: scan.usable_legs ?? 0,
      stale_legs: scan.stale_legs ?? 0,
      torn_events: scan.torn_events ?? [],
      price: scan.price ?? null,
      candidates: scan.candidates ?? [],
      candidate_count: scan.candidate_count ?? 0,
      blocked_reasons: scan.blocked_reasons ?? [],
      error: scan.error ?? null,
    };
  });

  const comparison = compareBooks(boards, { lineRate });

  return {
    scanned_at: nowIso,
    requested_books: requested,
    books: scans,
    comparison,
    summary: {
      books_scanned: scans.filter(scan => !scan.error).length,
      books_unresolved: scans.filter(scan => scan.error).map(scan => scan.book),
      books_with_a_price: scans.filter(scan => scan.price).map(scan => scan.book),
      games_compared: comparison.length,
      games_with_a_playable_number: comparison.filter(game => game.books_playable > 0).length,
      games_where_books_disagree: comparison.filter(game => game.books_disagree).length,
      shop_in_downgrades_available: comparison.reduce((sum, game) => sum + game.shop_in_downgrades, 0),
      total_candidates: scans.reduce((sum, scan) => sum + scan.candidate_count, 0),
    },
    ranking_basis: 'Numbers are ranked by the measured teased rate of that exact line over '
      + '1999-2024, never by whether the line sits inside the classic Wong window. Shopping a leg '
      + 'from -7.0 to -7.5 is a measured downgrade (75.22% -> 74.91%) and is the most common '
      + 'shop-in available; see the module header.',
    window: { from_commence: fromCommence, to_commence: toCommence },
  };
}
