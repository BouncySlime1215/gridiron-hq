/**
 * Closing-line value for the ACCEPTED-ticket ledger (Codex audit finding E9).
 *
 * The finding: "accepted positions, CLV and staking learning are separate
 * systems." `nfl-execution-lifecycle.js` computes realized P&L for a real
 * accepted position, but closing-value grading lived entirely on
 * `nfl_bet_log` — a different table, populated by a different action
 * (`clv-core.js#recordBet`), reading a different source
 * (`nfl_line_snapshots`). Nothing mapped an accepted lifecycle event to its
 * own exact contract's close, so the quote history this project spent
 * months collecting never reached the accepted-bet learning loop at all.
 *
 * The audit's instruction is to make ONE accepted ticket/economic ledger
 * authoritative and give the scorecards ADAPTERS over it. That is what this
 * is: a read-only projection over `nfl_execution_opportunities`, not a
 * second ledger. Consequences that fall out of that choice, each of which
 * the audit asks for by name:
 *
 *   - "Retry idempotent" / "closing data arrives late -> grade once" is
 *     structural rather than defended: nothing is written, so recomputing
 *     after the close lands simply produces the now-gradeable answer. There
 *     is no graded_at to race, and no second row to reconcile.
 *   - "Missing close does not remove a losing bet from ROI": economics and
 *     CLV are reported side by side with SEPARATE denominators. A position
 *     with no usable close still counts in realized P&L and still appears in
 *     the coverage report, with the reason it could not be graded.
 *   - "Multiple books/same game do not inflate independent evidence count":
 *     `independent_events` counts distinct canonical events, never tickets.
 *
 * What this deliberately does NOT do: transform an unlike contract to
 * manufacture a comparison. If the close for this exact line is missing, it
 * says so and stops, rather than silently pricing a -3.5 ticket against a
 * -7.5 close.
 */
import { rows } from '../db/index.js';
import { listOpportunities, netRealizedUnits } from './nfl-execution-lifecycle.js';
import { nflKickoffDate } from './date-util.js';
import { teamCodeFor } from './team-codes.js';
import { impliedProbability, decimalReturn, americanFromDecimal }
  from '../betting/nfl/contracts/spread-probabilities.js';
import { signedClvPoints, recordClvGrade } from './clv-core.js';

/**
 * The grading method's own identity. Codex correction C13 requires a saved
 * grading-version artifact: a CLV number computed under one definition of
 * "the close" is not comparable with one computed under another, and a report
 * that does not say which definition it used cannot be re-checked later.
 */
export const CLV_GRADING_VERSION = 'nfl-clv-v2-c13-c14-canonical-event-full-game';

/**
 * The books whose quotes may define a close, and the period a full-game
 * spread may be graded against.
 *
 * `null` books means "every book present in the tape", which is what the
 * project has today. It is a DECLARED choice rather than an implicit one, and
 * it is recorded on every report, because a close computed across a different
 * set of books is a different benchmark.
 */
export const DEFAULT_CLOSING_BOOKS = null;
const GRADED_PERIOD = 'full_game';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const median = xs => {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Kickoff for one canonical event key ('nfl|2026-09-13|CHI@CAR'), from the
 * authoritative schedule. The contract key carries only the game DATE, so
 * the exact kickoff instant — which is what "before the close" means — has
 * to come from `game_lines`, the same source the execution pipeline itself
 * uses when it opens the opportunity.
 */
export function kickoffForEvent(eventKey) {
  const m = /^nfl\|(\d{4}-\d{2}-\d{2})\|([A-Za-z]+)@([A-Za-z]+)$/.exec(String(eventKey ?? ''));
  if (!m) return null;
  const [, gameday, away, home] = m;
  const g = rows(`SELECT gameday, gametime FROM game_lines
    WHERE gameday=? AND team=? AND opponent=? AND home=1 LIMIT 1`, gameday, home, away)[0];
  if (!g) return null;
  return nflKickoffDate(g.gameday, g.gametime)?.toISOString() ?? null;
}

/**
 * The last quote for this EXACT contract before kickoff, from the immutable
 * quote tape — the same source `nfl-execution-replay.js` replays against, so
 * a position is graded on the identical evidence its own execution replay
 * used rather than a parallel snapshot table that may disagree.
 *
 * Returns a reason instead of a number when it cannot grade, because "we
 * have no close for this contract" and "the close was equal to our price"
 * must never collapse into the same reported zero.
 */
export function closingQuoteForContract({ eventKey, market, side, line, kickoff,
  books = DEFAULT_CLOSING_BOOKS } = {}) {
  if (!kickoff) return { close: null, reason: 'no_kickoff_known' };
  const parsed = parseEventKey(eventKey);
  if (!parsed) return { close: null, reason: 'unparseable_event_key' };

  const homeCode = teamCodeFor(parsed.home), awayCode = teamCodeFor(parsed.away);
  if (!homeCode || !awayCode) return { close: null, reason: 'unresolvable_canonical_event' };

  // Codex correction C13. The old predicate was
  //
  //   WHERE q.market=? AND q.side_key=? AND julianday(q.commence_time)=julianday(?)
  //
  // -- market, side and kickoff DAY. It omitted the event and the period
  // entirely, so the audit's fixture graded a full-game ticket against a
  // LATER, DIFFERENT GAME'S FIRST-HALF quote at -2.5/-200. Both omissions
  // matter independently: nine games can share a kickoff, and a first-half
  // spread settles on a different set of points than the full-game spread
  // that has the same name.
  //
  // The kickoff is matched as a one-second range so the index is usable (and
  // so both ISO spellings present in the column sort inside it); the canonical
  // event is then resolved in JS, because the tape stores full team names
  // while the contract key stores abbreviations.
  const kickoffMs = new Date(kickoff).getTime();
  if (!Number.isFinite(kickoffMs)) return { close: null, reason: 'unparseable_kickoff' };
  const window = rows(`SELECT q.quote_id, q.bookmaker_key, q.home_team, q.away_team, q.line,
      q.american_price, q.snapshot_at, q.period, q.market, q.side_key
    FROM nfl_quote_tape q
    WHERE q.commence_time >= ? AND q.commence_time < ?
      AND q.market = ? AND q.period = ? AND q.side_key = ?
      AND q.snapshot_at < ?
    ORDER BY q.snapshot_at DESC`,
  new Date(kickoffMs - 8 * 3600_000).toISOString(), new Date(kickoffMs + 1000).toISOString(),
  market, GRADED_PERIOD, side, kickoff);

  const declared = books == null ? null : new Set(books);
  const scoped = window.filter(q => {
    const qHome = teamCodeFor(q.home_team), qAway = teamCodeFor(q.away_team);
    if (qHome == null || qAway == null) return false;
    if (qHome !== homeCode || qAway !== awayCode) return false;
    return declared == null || declared.has(q.bookmaker_key);
  });
  if (!scoped.length) return { close: null, reason: 'no_quote_tape_coverage' };

  // ONE closing quote PER BOOK, not "every row sharing the single latest
  // snapshot instant". Books do not update in lockstep, so the old rule both
  // dropped books that had stopped updating and double-counted books that
  // happened to post twice in the same second.
  const latestPerBook = new Map();
  for (const q of scoped) {
    const held = latestPerBook.get(q.bookmaker_key);
    if (!held || q.snapshot_at > held.snapshot_at) latestPerBook.set(q.bookmaker_key, q);
  }
  const closes = [...latestPerBook.values()];

  // The main line at the close, across books, regardless of our handicap.
  // C13: "a method requiring the exact accepted line naturally returns zero
  // point movement and cannot stand in for a moving main-line benchmark." So
  // handicap movement is measured against this, and price movement is measured
  // at the exact line below. They are two different questions and are never
  // allowed to answer each other.
  const mainLine = modeOf(closes.map(q => q.line));

  // Price movement needs the SAME contract: a price at -3.5 says nothing about
  // a price at -2.5.
  const atLine = closes.filter(q => q.line === line);

  return {
    close: {
      captured_at: closes.reduce((max, q) => (max == null || q.snapshot_at > max ? q.snapshot_at : max), null),
      main_line: mainLine,
      main_line_books: closes.filter(q => q.line === mainLine).length,
      observed_lines: [...new Set(closes.map(q => q.line))].sort((a, b) => a - b),
      // Present only when a book actually closed on our exact number.
      line, books: atLine.length,
      price: averageAmericanPrice(atLine.map(q => q.american_price)),
      quote_ids: atLine.map(q => q.quote_id).sort(),
      main_line_quote_ids: closes.map(q => q.quote_id).sort(),
      books_contributing: [...latestPerBook.keys()].sort(),
      declared_books: books == null ? 'all_books_present_in_tape' : [...books].sort()
    },
    reason: atLine.length ? null : 'no_close_at_this_exact_line',
    observed_close_lines: [...new Set(closes.map(q => q.line))].sort((a, b) => a - b)
  };
}

/** 'nfl|2026-09-13|CHI@CAR' -> { gameDate, away, home }. */
function parseEventKey(eventKey) {
  const m = /^nfl\|(\d{4}-\d{2}-\d{2})\|([A-Za-z]+)@([A-Za-z]+)$/.exec(String(eventKey ?? ''));
  return m ? { gameDate: m[1], away: m[2], home: m[3] } : null;
}

/** The most common value, ties broken toward the value closest to zero. */
function modeOf(values) {
  const counts = new Map();
  for (const v of values) if (Number.isFinite(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0][0];
}

/**
 * Average a set of American prices by converting to decimal return FIRST.
 *
 * Codex correction C14: the previous implementation took `median()` of raw
 * American prices. American odds are discontinuous across the -100/+100
 * boundary -- -105 and +105 differ by about 5% in value and by 210 in
 * magnitude -- so their median is not a price. Convert, average, convert back
 * for display.
 */
function averageAmericanPrice(prices) {
  const decimals = prices.map(decimalReturn).filter(Number.isFinite);
  if (!decimals.length) return null;
  return americanFromDecimal(decimals.reduce((s, d) => s + d, 0) / decimals.length);
}

/**
 * CLV in points for a spread ticket, signed so positive is always better for
 * the bettor: we beat the close when the number we took is more favorable
 * than the number the market closed at, on our own side.
 *
 * Audit-consolidation stage 3 (Giant Plan 8.1): delegates to clv-core.js's
 * shared `signedClvPoints` instead of its own copy of the same convention.
 * `opp.side` here is 'home'/'away' (never 'over'/'under' — this module only
 * grades spreads today), so `isUnder` is always false; passing `market:
 * 'spread'` takes the non-total branch, which is exactly the old behavior.
 */
function spreadClvPoints({ side, ourLine, closeLine }) {
  if (side !== 'home' && side !== 'away') return null;
  return signedClvPoints({ market: 'spread', ourLine, closeLine, isUnder: false });
}

/**
 * Grade every accepted position against its own exact contract's close.
 *
 * `positions` are the graded rows; `coverage` is the denominator the audit
 * asks for, including every position that could NOT be graded and why.
 */
export function executionClvReport({ limit = 5000, books = DEFAULT_CLOSING_BOOKS } = {}) {
  const accepted = [...listOpportunities({ status: 'accepted', limit }),
    ...listOpportunities({ status: 'settled', limit })];
  const positions = [];
  const ungraded = [];

  for (const opp of accepted) {
    const acceptedEvent = rows(`SELECT line, price, stake_units, occurred_at
      FROM nfl_execution_lifecycle_events WHERE opportunity_id=? AND state='accepted'`, opp.id)[0];
    if (!acceptedEvent) { ungraded.push({ id: opp.id, reason: 'no_accepted_event' }); continue; }

    const kickoff = kickoffForEvent(opp.event_key);
    const { close, reason, observed_close_lines } = closingQuoteForContract({
      eventKey: opp.event_key, market: opp.market, side: opp.side,
      line: acceptedEvent.line, kickoff, books
    });
    if (!close) {
      // Still carries its realized economics: a bet whose close we never
      // captured did not stop having a result.
      ungraded.push({ id: opp.id, event_key: opp.event_key, reason,
        observed_close_lines: observed_close_lines ?? null,
        realized_units: r4(netRealizedUnits(opp.id)) });
      continue;
    }

    // Codex correction C14. Price movement is reported in PROBABILITY space,
    // where positive unambiguously means the bettor did better.
    //
    //   accepted -110 -> implied 0.5238      close -120 -> implied 0.5455
    //   clv_probability = 0.5455 - 0.5238 = +0.0217
    //
    // The old field computed `close.price - accepted.price` and returned -10
    // for that same favourable case, while its own comment said positive was
    // better. It is preserved below under a name that states what it actually
    // is, so any number exported from an earlier report still reconciles --
    // "never silently reinterpret past reports."
    const acceptedImplied = impliedProbability(acceptedEvent.price);
    const closeImplied = impliedProbability(close.price);
    const priceClvProbability = acceptedImplied != null && closeImplied != null
      ? closeImplied - acceptedImplied : null;

    positions.push({
      id: opp.id, event_key: opp.event_key, contract_key: opp.contract_key,
      side: opp.side, accepted_line: acceptedEvent.line, accepted_price: acceptedEvent.price,
      accepted_at: acceptedEvent.occurred_at, stake_units: acceptedEvent.stake_units,

      // Two different questions, deliberately never merged.
      //
      // `clv_points` compares our handicap with the market's MAIN handicap at
      // the close. Comparing it with the close at our own exact line would be
      // guaranteed to return zero and would silently stand in for a benchmark
      // that actually moved.
      closing_main_line: close.main_line, closing_main_line_books: close.main_line_books,
      clv_points: r3(spreadClvPoints({ side: opp.side, ourLine: acceptedEvent.line,
        closeLine: close.main_line })),

      // `clv_probability` compares our PRICE with the close at the identical
      // handicap. Null when no book closed on our number -- which is a stated
      // coverage gap, not a zero.
      closing_line: close.books ? close.line : null,
      closing_price: close.price, closing_books: close.books,
      closing_captured_at: close.captured_at,
      closing_quote_ids: close.quote_ids,
      clv_probability: r4(priceClvProbability),
      clv_decimal_return: acceptedEvent.price != null && close.price != null
        ? r4(decimalReturn(acceptedEvent.price) - decimalReturn(close.price)) : null,

      // Legacy, version-named. Raw American difference: NOT positive-is-better,
      // NOT safe to average across the -100/+100 boundary. Retained only so an
      // older exported number can be matched against this report.
      clv_price_cents_v1_raw_american_difference:
        Number.isFinite(acceptedEvent.price) && Number.isFinite(close.price)
          ? r3(close.price - acceptedEvent.price) : null,

      realized_units: r4(netRealizedUnits(opp.id)),
      status: opp.status
    });
  }

  const graded = positions.filter(p => p.clv_points != null);
  const pricedAtOurLine = positions.filter(p => p.clv_probability != null);
  // Distinct EVENTS, never tickets: two books on the same game are one piece
  // of evidence about that game, not two.
  const independentEvents = new Set(positions.map(p => p.event_key).filter(Boolean)).size;

  return {
    positions, ungraded,
    coverage: {
      accepted_positions: accepted.length,
      graded_positions: graded.length,
      ungraded_positions: ungraded.length,
      coverage_rate: accepted.length ? r4(graded.length / accepted.length) : null,
      independent_events: independentEvents,
      ungraded_reasons: ungraded.reduce((acc, u) => { acc[u.reason] = (acc[u.reason] ?? 0) + 1; return acc; }, {})
    },
    // Economics stand on their own denominator. A missing close removes a
    // position from the CLV sample, never from realized P&L.
    economics: {
      realized_units: r4(accepted.reduce((sum, o) => sum + netRealizedUnits(o.id), 0)),
      positions_counted: accepted.length,
      note: 'Realized P&L covers every accepted position, including those with no gradeable close. ' +
        'CLV coverage above is a separate, smaller denominator by construction.'
    },
    mean_clv_points: graded.length ? r3(graded.reduce((s, p) => s + p.clv_points, 0) / graded.length) : null,
    // Averaged in probability space, which is where averaging is meaningful.
    mean_clv_probability: pricedAtOurLine.length
      ? r4(pricedAtOurLine.reduce((s, p) => s + p.clv_probability, 0) / pricedAtOurLine.length) : null,
    // Separate denominators on purpose: a ticket can have a gradeable
    // handicap benchmark and no price benchmark, because no book closed on
    // its exact number. Reporting one count for both would overstate whichever
    // is smaller.
    price_clv_coverage: {
      positions_priced_at_our_line: pricedAtOurLine.length,
      positions_with_a_close: positions.length,
      note: 'A position with no book closing on our exact handicap has no price CLV. That is a coverage ' +
        'gap, reported as null, never as zero movement.'
    },
    grading_version: CLV_GRADING_VERSION,
    declared_books: books == null ? 'all_books_present_in_tape' : [...books].sort(),
    method: 'read-only projection over the accepted-ticket ledger; nothing is written, so grading is ' +
      'idempotent and a late-arriving close simply becomes gradeable on the next read'
  };
}

/**
 * Persists a CLV grade for every currently-graded position into the
 * append-only `nfl_clv_grades` ledger (migration 037), via clv-core.js's
 * shared writer.
 *
 * Deliberately a SEPARATE call from `executionClvReport()` above, not a side
 * effect folded into it. That report's whole design — restated in its own
 * `method` field — is that reading it writes nothing, so re-reading after a
 * late close arrives is safe and idempotent by construction. Turning every
 * read into a write would both contradict that stated contract and flood an
 * append-only table with a new row every time anything merely displays the
 * report. This function exists for whatever explicitly wants a grade
 * recorded (a scheduled job, a one-off backfill) — call it, don't call it
 * from inside a read path.
 *
 * Idempotent per (opportunity, grading_version): recordClvGrade's
 * deterministic id means calling this again for a position already graded
 * under the same CLV_GRADING_VERSION is a no-op. A future bump of
 * CLV_GRADING_VERSION records a new row rather than rewriting the old one,
 * exactly as migration 037 requires.
 */
export function recordExecutionClvGrades({ limit = 5000, books = DEFAULT_CLOSING_BOOKS } = {}) {
  const { positions } = executionClvReport({ limit, books });
  const bookSet = books == null ? 'all_books_present_in_tape' : [...books].sort();
  let recorded = 0, skipped = 0;
  for (const p of positions) {
    const { inserted } = recordClvGrade({
      opportunityId: p.id,
      gradingVersion: CLV_GRADING_VERSION,
      bookSet,
      quoteIds: p.closing_quote_ids ?? [],
      pointClv: p.clv_points,
      priceClvProbability: p.clv_probability,
      closeSource: 'nfl_quote_tape',
      note: p.closing_line != null ? null : 'no book closed at the exact accepted line; point_clv only'
    });
    if (inserted) recorded++; else skipped++;
  }
  return { recorded, already_graded: skipped, graded_positions: positions.length, grading_version: CLV_GRADING_VERSION };
}
