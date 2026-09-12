/**
 * Operational Wong teaser routing.
 *
 * A teaser is one ticket at one book, so "line shop every leg" means finding
 * two qualifying, different-game spreads that the SAME book posts and then
 * choosing the best reachable teaser payout among those books.  Splitting the
 * legs across books would create two unrelated bets and is never represented as
 * an executable candidate here.
 */
import crypto from 'node:crypto';
import { db, row, rows } from '../db/index.js';
import './line-shopping.js';
import './nfl-profitability.js';
import { simultaneousQuotes } from './nfl-shopping-board.js';
import { teaserEV, wongHistory, wongLeg } from './nfl-teasers.js';
import { ticketProbabilities } from '../betting/nfl/strategy/teaser-leg-rates.js';
import { payoutPerUnit } from './nfl-execution.js';
import { teamResolver } from './team-codes.js';
import { easternGameDate } from './nfl-contract-key.js';

export const TEASER_POLICY = Object.freeze({
  teaser_points: 6,
  legs: 2,
  operating_price_floor: -115,
  max_line_age_minutes: 18 * 60,
  max_price_age_hours: 7 * 24,
  max_candidates_per_book: 40
});

const r2 = value => (value == null || !Number.isFinite(value) ? null : +value.toFixed(2));
const r4 = value => (value == null || !Number.isFinite(value) ? null : +value.toFixed(4));
const bookKey = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ageMinutes = (timestamp, now) => (now.getTime() - new Date(timestamp).getTime()) / 60000;
const candidateId = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

function fairAmerican(probability) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  return Math.round(probability >= 0.5
    ? -(100 * probability) / (1 - probability)
    : (100 * (1 - probability)) / probability);
}

/**
 * The latest REACHABLE price per book.
 *
 * The `reachable = 1` filter is load-bearing and was missing. Without it this
 * took MAX(id) per book unconditionally, so recording a later unreachable
 * observation — a price seen but not offered to this account, which is exactly
 * the kind of row an honest capture process produces — would silently shadow a
 * good standing price and block the book with "the recorded teaser price was
 * not marked reachable". The most recent row is the right answer only among
 * rows that could actually have been bet.
 *
 * An unreachable row is still worth recording; it just is not a price you can
 * act on, and it should not be able to veto one you can.
 */
export function latestTeaserPrices({ points = 6, legs = 2 } = {}) {
  return rows(`SELECT p.* FROM nfl_teaser_price_ledger p
    WHERE p.teaser_points = ? AND p.legs = ? AND p.reachable = 1
      AND p.id = (SELECT MAX(p2.id) FROM nfl_teaser_price_ledger p2
                  WHERE lower(replace(replace(p2.book,' ',''),'-','')) =
                        lower(replace(replace(p.book,' ',''),'-',''))
                    AND p2.teaser_points = p.teaser_points AND p2.legs = p.legs
                    AND p2.reachable = 1)
    ORDER BY p.american_price DESC, p.book`, points, legs);
}

/** Pure route compiler, exported so the money gates can be tested in isolation. */
export function compileTeaserRoutes({ events = [], prices = [], history,
  now = new Date(), policy = TEASER_POLICY } = {}) {
  const clock = now instanceof Date ? now : new Date(now);
  // An unmeasured history is a refusal, not a zero. Without this, a database
  // with no games in the measurement window yields ticketProbability = 0, every
  // price fails the break-even gate, and the board reports "no candidates" as
  // though the market were the problem.
  // The same correction as `findTeaserLegs`: `history.win_rate` is conditional
  // on the leg being DECIDED, so raising it to the leg count answers "all legs
  // win given none pushed". The break-even price this gate compares against
  // must come from the ticket's real win probability, which includes the
  // reduced-push bucket. Pooled push share is used here because this compiler
  // prices the family before it knows which pair a caller will take; a pair's
  // own push exposure is applied downstream where the legs are known.
  const measured = Number.isFinite(history?.win_rate) && (history?.legs ?? 0) > 0;
  const pushShare = measured ? (history.push_share ?? 0) : 0;
  const perLeg = { w: (1 - pushShare) * history?.win_rate, t: pushShare };
  const ticketProbability = measured && policy.legs === 2
    ? ticketProbabilities([perLeg, perLeg]).win
    : measured ? Math.pow(history.win_rate, policy.legs) : 0;
  const mathematicalBreakEvenPrice = fairAmerican(ticketProbability);
  const pricesByBook = new Map(prices.map(price => [bookKey(price.book), price]));
  const byBook = new Map();

  for (const event of events) {
    for (const quote of event.quotes ?? []) {
      const teaser = wongLeg(quote.line, policy.teaser_points);
      if (!teaser?.qualifies || !quote.book || !quote.side) continue;
      const key = bookKey(quote.book);
      if (!byBook.has(key)) byBook.set(key, { book: quote.book, legs: [] });
      const legs = byBook.get(key).legs;
      if (legs.some(leg => leg.event_id === event.event_id && leg.team === quote.side)) continue;
      legs.push({
        event_id: event.event_id,
        team: quote.side,
        opponent: quote.side === event.home_team ? event.away_team : event.home_team,
        matchup: event.away_team && event.home_team
          ? `${event.away_team} at ${event.home_team}` : event.event_id,
        commence_time: event.commence_time,
        captured_at: quote.captured_at ?? event.captured_at,
        market_line: quote.line,
        teased_line: teaser.to,
        type: teaser.type,
        crosses: teaser.crosses
      });
    }
  }

  const books = [];
  const candidates = [];
  for (const [key, group] of byBook) {
    const price = pricesByBook.get(key) ?? null;
    const priceAgeHours = price ? ageMinutes(price.captured_at, clock) / 60 : null;
    const priceReachable = price?.reachable === 1 || price?.reachable === true;
    const priceFresh = priceAgeHours != null && priceAgeHours >= 0 && priceAgeHours <= policy.max_price_age_hours;
    const priceWithinMath = price && mathematicalBreakEvenPrice != null
      ? price.american_price >= mathematicalBreakEvenPrice : false;
    const priceWithinPolicy = price && price.american_price >= policy.operating_price_floor;
    const priceEligible = Boolean(priceReachable && priceFresh && priceWithinMath && priceWithinPolicy);
    const bookReasons = [];
    if (!measured) {
      bookReasons.push('No measured leg history — the qualifying window has no scored games in the ' +
        'measurement seasons, so no price can be judged against break-even.');
    }
    if (!price) bookReasons.push('Record this book\'s current two-team, six-point teaser price.');
    else {
      if (!priceReachable) bookReasons.push('The recorded teaser price was not marked reachable.');
      if (!priceFresh) bookReasons.push(`The recorded price is older than ${policy.max_price_age_hours} hours.`);
      if (!priceWithinMath) bookReasons.push(`Price ${price.american_price} is worse than mathematical break-even ${mathematicalBreakEvenPrice}.`);
      if (!priceWithinPolicy) bookReasons.push(`Price ${price.american_price} misses the conservative ${policy.operating_price_floor} operating gate.`);
    }

    const sortedLegs = group.legs.sort((a, b) => String(a.commence_time).localeCompare(String(b.commence_time)));
    const eventCounts = new Map();
    for (const leg of sortedLegs) eventCounts.set(leg.event_id, (eventCounts.get(leg.event_id) ?? 0) + 1);
    const pairCount = sortedLegs.length * (sortedLegs.length - 1) / 2
      - [...eventCounts.values()].reduce((sum, count) => sum + count * (count - 1) / 2, 0);
    let emitted = 0;
    outer: for (let i = 0; i < sortedLegs.length; i++) {
      for (let j = i + 1; j < sortedLegs.length; j++) {
        const legA = sortedLegs[i], legB = sortedLegs[j];
        if (legA.event_id === legB.event_id) continue;
        if (emitted >= policy.max_candidates_per_book) continue;
        const lineCapturedAt = [legA.captured_at, legB.captured_at].sort()[0];
        const lineAge = ageMinutes(lineCapturedAt, clock);
        const lineFresh = lineAge >= 0 && lineAge <= policy.max_line_age_minutes;
        const ev = price ? teaserEV({ americanPrice: price.american_price,
          legRate: history.win_rate, standardError: history.standard_error, legs: policy.legs }) : null;
        const reasons = [...bookReasons];
        if (!lineFresh) reasons.push(`At least one spread is older than ${policy.max_line_age_minutes} minutes.`);
        if (ev && !(ev.ev_per_bet > 0)) reasons.push('Expected value is not positive at this payout.');
        const identity = {
          book: group.book, price: price?.american_price ?? null,
          price_at: price?.captured_at ?? null, line_at: lineCapturedAt,
          legs: [legA, legB].map(leg => [leg.event_id, leg.team, leg.market_line, leg.teased_line])
        };
        candidates.push({
          candidate_id: candidateId(identity), book: group.book,
          american_price: price?.american_price ?? null,
          price_captured_at: price?.captured_at ?? null,
          line_captured_at: lineCapturedAt,
          line_age_minutes: r2(lineAge),
          legs: [legA, legB],
          expected_ticket_probability: r4(ticketProbability),
          expected_ev: ev?.ev_per_bet ?? null,
          eligible: reasons.length === 0,
          blocked_reasons: reasons
        });
        emitted++;
        if (emitted >= policy.max_candidates_per_book) {
          // Keep counting is not worth an O(n²) response-time tax. The exact
          // total is secondary to presenting a bounded set of executable pairs.
          break outer;
        }
      }
    }
    books.push({
      book: group.book, qualifying_legs: sortedLegs.length, cross_game_pairs: pairCount,
      price: price?.american_price ?? null, price_captured_at: price?.captured_at ?? null,
      price_age_hours: r2(priceAgeHours), eligible_price: priceEligible,
      candidates_shown: emitted,
      blocked_reasons: bookReasons
    });
  }

  candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible)
    || (b.american_price ?? -9999) - (a.american_price ?? -9999)
    || (a.line_age_minutes ?? Infinity) - (b.line_age_minutes ?? Infinity));
  books.sort((a, b) => Number(b.eligible_price) - Number(a.eligible_price)
    || (b.price ?? -9999) - (a.price ?? -9999));
  return {
    policy: { ...policy, mathematical_break_even_price: mathematicalBreakEvenPrice },
    historical: history,
    books,
    candidates,
    eligible_candidates: candidates.filter(candidate => candidate.eligible).length
  };
}

export function teaserExecutionBoard(options = {}) {
  const history = wongHistory();
  const events = simultaneousQuotes('spreads');
  const compiled = compileTeaserRoutes({ events, prices: latestTeaserPrices(), history,
    now: options.now ?? new Date(), policy: { ...TEASER_POLICY, ...(options.policy ?? {}) } });
  return {
    generated_at: new Date(options.now ?? Date.now()).toISOString(),
    source: 'Latest simultaneous multi-book spread snapshots plus manually verified teaser payouts.',
    ...compiled,
    status: !events.length ? 'no_multi_book_spreads'
      : !compiled.books.some(book => book.price != null) ? 'teaser_prices_required'
        : compiled.eligible_candidates ? 'ready' : 'blocked',
    instruction: 'Record reachable teaser payouts, then log only a server-validated cross-game pair. This tool records execution; it does not transmit a wager.'
  };
}

export function recordTeaserExecution(input = {}) {
  const mode = input.mode === 'placed' ? 'placed' : input.mode === 'paper' ? 'paper' : null;
  const units = Number(input.stake_units ?? 1);
  if (!input.candidate_id || !mode || !Number.isFinite(units) || units <= 0 || units > 5) {
    return { error: 'candidate_id, mode (paper or placed), and stake_units greater than 0 and at most 5 are required' };
  }
  const board = teaserExecutionBoard();
  const candidate = board.candidates.find(item => item.candidate_id === input.candidate_id);
  if (!candidate) return { error: 'candidate is no longer on the current execution board; refresh before logging' };
  if (!candidate.eligible) return { error: 'execution blocked', reasons: candidate.blocked_reasons };

  const history = board.historical;
  const existing = row('SELECT id FROM nfl_teaser_executions WHERE candidate_id=? AND mode=?',
    candidate.candidate_id, mode);
  if (existing) return { error: `this candidate is already logged as ${mode}`, execution_id: existing.id };

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`INSERT INTO nfl_teaser_executions
      (candidate_id,logged_at,mode,book,american_price,teaser_points,stake_units,
       expected_leg_rate,expected_ticket_probability,expected_ev,price_captured_at,
       line_captured_at,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidate.candidate_id, new Date().toISOString(), mode, candidate.book,
      candidate.american_price, TEASER_POLICY.teaser_points, units, history.win_rate,
      candidate.expected_ticket_probability, candidate.expected_ev,
      candidate.price_captured_at, candidate.line_captured_at,
      input.note ? String(input.note).slice(0, 500) : null);
    const executionId = Number(result.lastInsertRowid);
    const insertLeg = db.prepare(`INSERT INTO nfl_teaser_execution_legs
      (execution_id,slot,event_id,team,opponent,matchup,commence_time,market_line,teased_line)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    candidate.legs.forEach((leg, index) => insertLeg.run(executionId, index + 1,
      leg.event_id, leg.team, leg.opponent, leg.matchup, leg.commence_time,
      leg.market_line, leg.teased_line));
    db.exec('COMMIT');
    return { logged: true, execution_id: executionId, mode, candidate };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function executionRows({ limit = 100 } = {}) {
  const tickets = rows('SELECT * FROM nfl_teaser_executions ORDER BY logged_at DESC,id DESC LIMIT ?', limit);
  const legStmt = db.prepare('SELECT * FROM nfl_teaser_execution_legs WHERE execution_id=? ORDER BY slot');
  return tickets.map(ticket => ({ ...ticket, legs: legStmt.all(ticket.id) }));
}

export function teaserExecutionLedger({ limit = 100 } = {}) {
  const executions = executionRows({ limit });
  const totals = row(`SELECT COUNT(*) tickets,
      SUM(mode='paper') paper_tickets, SUM(mode='placed') placed_tickets,
      SUM(status='open') open_tickets,
      SUM(status IN ('won','lost')) settled_decisions,
      SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) losses,
      SUM(CASE WHEN mode='placed' THEN COALESCE(profit_units,0) ELSE 0 END) placed_profit_units
    FROM nfl_teaser_executions`) ?? {};
  const legs = row(`SELECT COUNT(*) graded_legs,
      SUM(result='won') leg_wins, SUM(result='lost') leg_losses
    FROM nfl_teaser_execution_legs WHERE result IN ('won','lost')`) ?? {};
  const decidedLegs = (legs.leg_wins ?? 0) + (legs.leg_losses ?? 0);
  return {
    summary: {
      tickets: totals.tickets ?? 0,
      paper_tickets: totals.paper_tickets ?? 0,
      placed_tickets: totals.placed_tickets ?? 0,
      open_tickets: totals.open_tickets ?? 0,
      ticket_wins: totals.wins ?? 0,
      ticket_losses: totals.losses ?? 0,
      forward_leg_rate: decidedLegs ? r4((legs.leg_wins ?? 0) / decidedLegs) : null,
      graded_legs: decidedLegs,
      placed_profit_units: r2(totals.placed_profit_units ?? 0)
    },
    executions,
    note: 'Paper and placed tickets are reported separately. Profit units include placed tickets only; forward leg rate includes every graded leg.'
  };
}

export function settleTeaserExecution(id, _input = {}) {
  const execution = row('SELECT * FROM nfl_teaser_executions WHERE id=?', Number(id));
  if (!execution) return { error: 'teaser execution not found' };
  if (execution.status !== 'open') return { error: `execution is already ${execution.status}` };
  const storedLegs = rows('SELECT * FROM nfl_teaser_execution_legs WHERE execution_id=? ORDER BY slot', execution.id);
  const resolve = teamResolver();

  // The final score used to grade a real stake must come from the same
  // authoritative source settleExecutionOpportunities() (nfl-execution-pipeline.js)
  // already trusts for this -- game_lines, cross-checked against the
  // opponent's own row -- never from the request body. This endpoint used to
  // take `input.scores` as given, which meant any caller could hand it
  // whatever final score it liked and settle a real stake off a fabricated
  // result.
  const graded = [];
  for (const leg of storedLegs) {
    const team = resolve(leg.team), opponent = resolve(leg.opponent);
    if (!team || !opponent) return { error: `cannot resolve teams for ${leg.team}` };
    const gameday = easternGameDate(leg.commence_time);
    if (!gameday) return { error: `cannot resolve game date for ${leg.team}` };
    const g = row(`SELECT * FROM game_lines WHERE gameday=? AND team=? AND opponent=?`,
      gameday, team.abbr, opponent.abbr);
    const other = row(`SELECT * FROM game_lines WHERE gameday=? AND team=? AND opponent=?`,
      gameday, opponent.abbr, team.abbr);
    if (!g || !other || !Number.isInteger(g.team_score) || !Number.isInteger(g.opp_score) ||
        g.team_score < 0 || g.opp_score < 0) {
      return { error: `final score not yet available for ${leg.team}` };
    }
    if (g.team_score !== other.opp_score || g.opp_score !== other.team_score) {
      return { error: `conflicting game result for ${leg.team}` };
    }
    const teamScore = g.team_score, opponentScore = g.opp_score;
    const coverMargin = teamScore - opponentScore + leg.teased_line;
    graded.push({ ...leg, team_score: teamScore, opponent_score: opponentScore,
      result: coverMargin > 0 ? 'won' : coverMargin < 0 ? 'lost' : 'push' });
  }
  // GRADING, AND THE ASSUMPTION IT MAKES ABOUT PUSHES.
  //
  // Any losing leg loses the ticket. All legs winning wins it. The remaining
  // case -- one leg pushes and the other wins -- is where books differ, and
  // this grades it as a stake refund (profit 0).
  //
  // That is NOT the rule the owner's book uses. DraftKings removes the pushed
  // leg and reduces the ticket to a single, which pays something rather than
  // nothing. Grading it at 0 is therefore deliberately CONSERVATIVE: it
  // understates a real ticket's return rather than crediting a payout this
  // system cannot verify.
  //
  // It is conservative rather than correct because the reduced-single price is
  // not knowable from anything recorded here. A one-leg six-point teaser prices
  // somewhere around -450 to -600, and until that price is captured per book
  // there is no honest number to multiply by. `push_rule` on the price ledger
  // records which rule the book applies; when a reduced-single price is
  // recorded alongside it, this branch should pay
  // `stake * payoutPerUnit(reducedSinglePrice)` and this comment should go.
  //
  // Push mass is small but not negligible: it is exactly zero on the four
  // half-point legs and 0.7%-2.5% on the four integer legs, so a ticket built
  // from half-points cannot reach this branch at all.
  const status = graded.some(leg => leg.result === 'lost') ? 'lost'
    : graded.every(leg => leg.result === 'won') ? 'won' : 'push';
  const profit = status === 'won' ? execution.stake_units * payoutPerUnit(execution.american_price)
    : status === 'lost' ? -execution.stake_units : 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    const updateLeg = db.prepare(`UPDATE nfl_teaser_execution_legs
      SET result=?,team_score=?,opponent_score=? WHERE execution_id=? AND slot=?`);
    for (const leg of graded) updateLeg.run(leg.result, leg.team_score, leg.opponent_score,
      execution.id, leg.slot);
    db.prepare(`UPDATE nfl_teaser_executions SET status=?,settled_at=?,profit_units=? WHERE id=?`)
      .run(status, new Date().toISOString(), r4(profit), execution.id);
    db.exec('COMMIT');
    return { settled: true, execution_id: execution.id, status, profit_units: r4(profit), legs: graded };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
