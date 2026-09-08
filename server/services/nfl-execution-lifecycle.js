/**
 * The state lifecycle a decided-on bet actually goes through, as a real ledger.
 *
 * `nfl-execution.js` logs one row after the fact: "here is where this got
 * routed." That is fine for what it does — it has no opinion about whether the
 * bet is good — but it cannot answer the question Package H exists to answer:
 * how much of a paper edge survives from the moment a price is first seen to
 * the moment it is (or is not) actually taken? Answering that needs the states
 * kept apart, not flattened into one row:
 *
 *   OFFERED    a book quoted this exact contract.
 *   OBSERVED   this system actually recorded that quote (a distinct instant —
 *              a quote can be offered by a book and never seen by anything
 *              here, which is a real and common way an "opportunity" evaporates).
 *   DECISION   a decision was made to act on it, at whatever price was known then.
 *   REFRESHED  the price was re-checked before acceptance — zero or more times.
 *              This is the only state allowed to recur; see the migration.
 *   ACCEPTED   NICK recorded taking it. This is the load-bearing distinction in
 *              the whole module: `fill_confirmed` is schema-constrained to 0
 *              (server/migrations/023_execution_lifecycle_ledger.js) because
 *              nothing in this project connects to a sportsbook account. An
 *              ACCEPTED row is a user's claim, never a confirmed execution.
 *   SETTLED    the real result, computed once and only from the price actually
 *              recorded as accepted — never from whatever looked best in
 *              hindsight.
 *
 * Both the JS transition guard below AND a partial unique index in the
 * migration refuse to let OFFERED/OBSERVED/DECISION/ACCEPTED/SETTLED happen
 * twice for one opportunity. That is deliberate double coverage: a ledger is
 * only as trustworthy as the thing that would catch a bug in it, and a state
 * machine that only enforces its own invariants in application code has a
 * single point of failure the database should not also have.
 */
import crypto from 'node:crypto';
import { db, rows, row, run } from '../db/index.js';
import { payoutPerUnit } from './nfl-execution.js';

export const STATES = Object.freeze(['offered', 'observed', 'decision', 'refreshed', 'accepted', 'settled']);
const ORDER_INDEX = Object.freeze({ offered: 0, observed: 1, decision: 2, refreshed: 2, accepted: 3, settled: 4 });
const SOURCES = Object.freeze(['quote_tape', 'user_recorded', 'replay_synthetic', 'settlement_result']);
const RESULTS = Object.freeze(['won', 'lost', 'push', 'void']);

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * What may legally follow the opportunity's current materialized status.
 * `null` current status only happens transiently inside `openOpportunity`.
 */
export function allowedNextStates(currentStatus) {
  switch (currentStatus) {
    case 'offered': return ['observed'];
    case 'observed': return ['decision'];
    case 'decision': return ['refreshed', 'accepted'];
    case 'refreshed': return ['refreshed', 'accepted'];
    case 'accepted': return ['settled'];
    case 'settled': return [];
    default: return ['offered'];
  }
}

function assertTransition(currentStatus, nextState) {
  const allowed = allowedNextStates(currentStatus);
  if (!allowed.includes(nextState)) {
    const error = new Error(`cannot record "${nextState}" from status "${currentStatus}" — ` +
      `allowed next state(s): ${allowed.length ? allowed.join(', ') : '(terminal — this opportunity is settled)'}`);
    error.code = 'invalid_transition';
    throw error;
  }
}

/**
 * Open a new opportunity, addressed by its exact Package-A contract — never by
 * a loosely-matched market/line string. `contract` must be the `{ ok: true, ... }`
 * result of `contractKey()`; a failed contract is refused rather than stored
 * under a guessed identity.
 *
 * This inserts the header AND its first (OFFERED) event atomically, so a
 * header with zero events can never exist — there is nothing to query that
 * has not already been observed to have been offered somewhere.
 */
export function openOpportunity({ contract, matchup = null, participant = null, decisionSource,
  occurredAt, book, line = null, price, quoteId = null, source = 'quote_tape', note = null } = {}) {
  if (!contract?.ok) throw new Error('openOpportunity requires a resolved contractKey() result');
  if (!decisionSource) throw new Error('decisionSource is required — an unattributed opportunity is not evidence');
  if (!occurredAt || !Number.isFinite(new Date(occurredAt).getTime())) throw new Error('occurredAt must be a timestamp');
  if (!book) throw new Error('book is required for the OFFERED state');
  if (!Number.isFinite(price)) throw new Error('price must be a finite American price');
  if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);

  const id = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    run(`INSERT INTO nfl_execution_opportunities
         (id, contract_key, contract_hash, event_key, matchup, market, side, participant,
          decision_source, status, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, contract.key, contract.key_hash ?? null, contract.event_key ?? null, matchup,
    contract.market, contract.side, participant, decisionSource, 'offered', note);
    run(`INSERT INTO nfl_execution_lifecycle_events
         (opportunity_id, state, occurred_at, book, line, price, source, quote_id, actor, detail_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, 'offered', new Date(occurredAt).toISOString(), book, line, price, source, quoteId, 'system', null);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getOpportunity(id);
}

/**
 * Record one lifecycle event. This is the low-level primitive every other
 * helper in this module (and `nfl-execution-decision.js`'s exposure/suspect
 * gates) is built on. It enforces the transition order and the "accepted is
 * not a confirmed fill" invariant; it does NOT know about exposure budgets or
 * suspicious prices — those are separate, composable checks a caller runs
 * before this, so this module stays a state machine and nothing else.
 */
export function recordState(opportunityId, state, { occurredAt, book = null, line = null, price = null,
  stakeUnits = null, quoteId = null, source, actor = 'system', detail = null,
  result = null, realizedPnlUnits = null } = {}) {
  if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`);
  if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);
  if (!occurredAt || !Number.isFinite(new Date(occurredAt).getTime())) throw new Error('occurredAt must be a timestamp');
  const opp = row('SELECT * FROM nfl_execution_opportunities WHERE id=?', opportunityId);
  if (!opp) throw new Error(`no opportunity ${opportunityId}`);
  assertTransition(opp.status, state);

  if (state === 'accepted' && source !== 'user_recorded') {
    throw new Error('an ACCEPTED state must be source="user_recorded" — this ledger never records a ' +
      'sportsbook as the source of an acceptance, because nothing here is connected to one');
  }
  if (state === 'accepted' && !Number.isFinite(stakeUnits)) {
    throw new Error('an ACCEPTED state requires stakeUnits — a bet Nick did not size was not actually taken');
  }
  if (state === 'settled') {
    if (!RESULTS.includes(result)) throw new Error(`settled state requires a result in ${RESULTS.join(', ')}`);
    if (source !== 'settlement_result') throw new Error('a SETTLED state must be source="settlement_result"');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    run(`INSERT INTO nfl_execution_lifecycle_events
         (opportunity_id, state, occurred_at, book, line, price, stake_units, source, quote_id,
          actor, detail_json, result, realized_pnl_units)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    opportunityId, state, new Date(occurredAt).toISOString(), book, line, price, stakeUnits, source,
    quoteId, actor, detail == null ? null : JSON.stringify(detail), result, r4(realizedPnlUnits));
    run('UPDATE nfl_execution_opportunities SET status=? WHERE id=?', state, opportunityId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getOpportunity(opportunityId);
}

/** OBSERVED — this system actually recorded a quote that a book had offered. */
export function recordObserved(opportunityId, args) {
  return recordState(opportunityId, 'observed', { ...args, source: args.source ?? 'quote_tape' });
}

/** DECISION — a decision was made, at whatever price was known at that instant. */
export function recordDecision(opportunityId, args) {
  return recordState(opportunityId, 'decision', { ...args, source: args.source ?? 'quote_tape', actor: args.actor ?? 'system' });
}

/** REFRESHED — the price was re-checked before acceptance. May recur. */
export function recordRefresh(opportunityId, args) {
  return recordState(opportunityId, 'refreshed', { ...args, source: args.source ?? 'quote_tape' });
}

/**
 * ACCEPTED — Nick recorded taking this. Always `source: 'user_recorded'`;
 * always `fill_confirmed: 0` at the schema level. This function does not
 * check exposure budgets or challenge suspicious prices — see
 * `nfl-execution-decision.js#attemptAcceptance` for the gated entry point;
 * this is the primitive it calls once those checks have already passed.
 */
export function recordAcceptance(opportunityId, { occurredAt, book, line = null, price, stakeUnits,
  actor = 'user:nick', note = null }) {
  return recordState(opportunityId, 'accepted', {
    occurredAt, book, line, price, stakeUnits, source: 'user_recorded', actor,
    detail: note ? { note } : null
  });
}

/**
 * SETTLED — the real result. Deliberately re-reads the ACCEPTED event from the
 * ledger for its price and stake, rather than accepting them again as
 * arguments: the number that gets graded must be the number that was actually
 * recorded as taken, never a number supplied fresh at settlement time that
 * could quietly drift from it.
 *
 * Realized P&L is exact by construction for the three cases the plan singles
 * out: PUSH and VOID always net exactly 0 (stake returned, no result to
 * grade); WON pays `stakeUnits * payoutPerUnit(acceptedPrice)`; LOST is
 * exactly `-stakeUnits`. An opportunity that never reached ACCEPTED cannot be
 * settled at all (see the guard below) — a missing fill therefore has no
 * settlement row and contributes exactly zero to any P&L sum, not an
 * estimate of zero.
 */
export function settleOpportunity(opportunityId, { occurredAt, result, actor = 'system', note = null } = {}) {
  const accepted = row(`SELECT * FROM nfl_execution_lifecycle_events
    WHERE opportunity_id=? AND state='accepted'`, opportunityId);
  if (!accepted) {
    const error = new Error('cannot settle an opportunity that was never ACCEPTED — there is no stake to grade');
    error.code = 'not_accepted';
    throw error;
  }
  const pnl = result === 'won' ? accepted.stake_units * payoutPerUnit(accepted.price)
    : result === 'lost' ? -accepted.stake_units
      : 0; // push and void both return the stake — zero net, by rule, not by estimate
  return recordState(opportunityId, 'settled', {
    occurredAt, book: accepted.book, line: accepted.line, price: accepted.price,
    stakeUnits: accepted.stake_units, source: 'settlement_result', actor, result,
    realizedPnlUnits: pnl, detail: note ? { note } : null
  });
}

/** One opportunity with its full, ordered event history. */
export function getOpportunity(opportunityId) {
  const opportunity = row('SELECT * FROM nfl_execution_opportunities WHERE id=?', opportunityId);
  if (!opportunity) return null;
  const events = rows(`SELECT * FROM nfl_execution_lifecycle_events
    WHERE opportunity_id=? ORDER BY id`, opportunityId)
    .map(e => ({ ...e, detail: e.detail_json ? JSON.parse(e.detail_json) : null, detail_json: undefined,
      fill_confirmed: undefined /* always 0 — the column exists only to make that a schema fact */ }));
  return { ...opportunity, events };
}

/** Every opportunity matching a filter, headers only (call getOpportunity for events). */
export function listOpportunities({ status = null, eventKey = null, market = null, limit = 200 } = {}) {
  const clauses = [];
  const args = [];
  if (status) { clauses.push('status=?'); args.push(status); }
  if (eventKey) { clauses.push('event_key=?'); args.push(eventKey); }
  if (market) { clauses.push('market=?'); args.push(market); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  args.push(limit);
  return rows(`SELECT * FROM nfl_execution_opportunities ${where} ORDER BY created_at DESC LIMIT ?`, ...args);
}

/** Opportunities currently sitting at ACCEPTED — i.e. real exposure, not yet settled. */
export function openExposure() {
  return listOpportunities({ status: 'accepted', limit: 5000 }).map(opp => {
    const accepted = row(`SELECT * FROM nfl_execution_lifecycle_events
      WHERE opportunity_id=? AND state='accepted'`, opp.id);
    return { ...opp, stake_units: accepted?.stake_units ?? null, book: accepted?.book ?? null,
      price: accepted?.price ?? null, line: accepted?.line ?? null };
  });
}

/**
 * How much of a decided ledger actually reached each stage. This is the
 * single most important number Package H produces: if most opportunities
 * never make it past DECISION, that is the realistic-delay finding the plan
 * expects this package to be capable of reporting, not a bug in the ledger.
 */
export function lifecycleFunnel({ market = null } = {}) {
  const args = market ? [market] : [];
  const where = market ? 'WHERE market=?' : '';
  const total = row(`SELECT COUNT(*) n FROM nfl_execution_opportunities ${where}`, ...args)?.n ?? 0;
  const byStatus = rows(`SELECT status, COUNT(*) n FROM nfl_execution_opportunities ${where}
    GROUP BY status`, ...args);
  const counts = Object.fromEntries(STATES.map(s => [s, 0]));
  for (const r of byStatus) counts[r.status] = r.n;
  const settled = rows(`SELECT o.id, e.result, e.realized_pnl_units FROM nfl_execution_opportunities o
    JOIN nfl_execution_lifecycle_events e ON e.opportunity_id=o.id AND e.state='settled'
    ${market ? 'WHERE o.market=?' : ''}`, ...args);
  const wins = settled.filter(s => s.result === 'won').length;
  const losses = settled.filter(s => s.result === 'lost').length;
  const pushes = settled.filter(s => s.result === 'push' || s.result === 'void').length;
  const totalPnl = settled.reduce((sum, s) => sum + (s.realized_pnl_units ?? 0), 0);
  return {
    total_opportunities: total,
    by_stage: counts,
    reached_decision: counts.decision + counts.refreshed + counts.accepted + counts.settled,
    reached_accepted: counts.accepted + counts.settled,
    survival_rate_decision_to_accepted: (counts.decision + counts.refreshed + counts.accepted + counts.settled) > 0
      ? r4((counts.accepted + counts.settled) / (counts.decision + counts.refreshed + counts.accepted + counts.settled))
      : null,
    settled: settled.length, wins, losses, pushes_or_voids: pushes,
    realized_pnl_units: r4(totalPnl),
    note: 'A low survival rate from DECISION to ACCEPTED is the expected, valuable result of a ' +
      'realistic delayed-execution replay — it means the ledger is correctly showing that most ' +
      'apparent opportunities do not survive the gap between seeing a price and being able to take it.'
  };
}
