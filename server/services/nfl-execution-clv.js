/**
 * Closing-line value for the ACCEPTED-ticket ledger (Codex audit finding E9).
 *
 * The finding: "accepted positions, CLV and staking learning are separate
 * systems." `nfl-execution-lifecycle.js` computes realized P&L for a real
 * accepted position, but closing-value grading lived entirely on
 * `nfl_bet_log` — a different table, populated by a different action
 * (`nfl-clv.js#recordBet`), reading a different source
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
export function closingQuoteForContract({ market, side, line, kickoff }) {
  if (!kickoff) return { close: null, reason: 'no_kickoff_known' };
  const quotes = rows(`SELECT q.bookmaker_key, q.line, q.american_price, q.snapshot_at
    FROM nfl_quote_tape q
    WHERE q.market=? AND q.side_key=? AND julianday(q.commence_time)=julianday(?)
      AND q.snapshot_at < ?
    ORDER BY q.snapshot_at DESC`, market, side, kickoff, kickoff);
  if (!quotes.length) return { close: null, reason: 'no_quote_tape_coverage' };

  const latestAt = quotes[0].snapshot_at;
  const atClose = quotes.filter(q => q.snapshot_at === latestAt);
  // The EXACT line only. A close at a different number is a different
  // contract, and pricing one against the other is the "blending unlike
  // contracts" the audit explicitly refuses.
  const exact = atClose.filter(q => q.line === line);
  if (!exact.length) {
    return { close: null, reason: 'no_close_at_this_exact_line',
      observed_close_lines: [...new Set(atClose.map(q => q.line))] };
  }
  return {
    close: { captured_at: latestAt, line, price: median(exact.map(q => q.american_price)),
      books: exact.length },
    reason: null
  };
}

/**
 * CLV in points for a spread ticket, signed so positive is always better for
 * the bettor: we beat the close when the number we took is more favorable
 * than the number the market closed at, on our own side.
 */
function spreadClvPoints({ side, ourLine, closeLine }) {
  if (!Number.isFinite(ourLine) || !Number.isFinite(closeLine)) return null;
  // Both lines are already expressed from the backed side's perspective by
  // the contract key, so a larger number is unambiguously better.
  return side === 'home' || side === 'away' ? ourLine - closeLine : null;
}

/**
 * Grade every accepted position against its own exact contract's close.
 *
 * `positions` are the graded rows; `coverage` is the denominator the audit
 * asks for, including every position that could NOT be graded and why.
 */
export function executionClvReport({ limit = 5000 } = {}) {
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
      market: opp.market, side: opp.side, line: acceptedEvent.line, kickoff
    });
    if (!close) {
      // Still carries its realized economics: a bet whose close we never
      // captured did not stop having a result.
      ungraded.push({ id: opp.id, event_key: opp.event_key, reason,
        observed_close_lines: observed_close_lines ?? null,
        realized_units: r4(netRealizedUnits(opp.id)) });
      continue;
    }

    positions.push({
      id: opp.id, event_key: opp.event_key, contract_key: opp.contract_key,
      side: opp.side, accepted_line: acceptedEvent.line, accepted_price: acceptedEvent.price,
      accepted_at: acceptedEvent.occurred_at, stake_units: acceptedEvent.stake_units,
      closing_line: close.line, closing_price: close.price, closing_books: close.books,
      closing_captured_at: close.captured_at,
      clv_points: r3(spreadClvPoints({ side: opp.side, ourLine: acceptedEvent.line, closeLine: close.line })),
      // Price CLV: how much better the number we paid was than the closing
      // number for the identical line. Positive means we got the better price.
      clv_price_cents: Number.isFinite(acceptedEvent.price) && Number.isFinite(close.price)
        ? r3(close.price - acceptedEvent.price) : null,
      realized_units: r4(netRealizedUnits(opp.id)),
      status: opp.status
    });
  }

  const graded = positions.filter(p => p.clv_points != null);
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
    method: 'read-only projection over the accepted-ticket ledger; nothing is written, so grading is ' +
      'idempotent and a late-arriving close simply becomes gradeable on the next read'
  };
}
