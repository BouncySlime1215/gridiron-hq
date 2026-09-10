/**
 * The gated entry point for recording an ACCEPTED state.
 *
 * `nfl-execution-lifecycle.js#recordAcceptance` is a state-machine primitive —
 * it only knows about transition order and the "this is not a confirmed
 * sportsbook fill" invariant. Three more things must be true before a ledger
 * entry becomes an acceptance, per the plan, and this is where they are
 * enforced together so nothing can call `recordAcceptance` around them:
 *
 *   1. The aggregate game/player exposure budget is not breached
 *      (nfl-execution-exposure.js).
 *   2. The model line is not so far from the market's own line that it is
 *      more likely a bad join or stale feed than found alpha — Package H's
 *      Market Line Corridor, Rule 1 of the two stress-test rules the
 *      architecture assessment asks for (nfl-execution-corridor.js).
 *   3. A fair-price EV far beyond anything ever measured here is challenged
 *      first, rather than treated as free money (nfl-execution-attribution.js).
 *
 * All three gates return the reason they blocked rather than throwing,
 * because a blocked acceptance is a normal, expected outcome here — this
 * module's job is to make blocking the easy path, not an exception to catch.
 * Both the corridor and suspect-price gates are OPTIONAL evidence (an
 * opportunity opened with no calibrated model line/probability at decision
 * time gets an ordinary acceptance with those checks reported
 * `not_evaluated` / absent) — this module never manufactures a review it has
 * no evidence for.
 *
 * CORRECTED 2026-09-10 (Codex audit finding E4): `modelLine`, `marketLine`
 * and `fairProbability` used to be plain caller-supplied options here, the
 * same shape as `eventKey`/`participant` were before an earlier fix moved
 * those to the persisted opportunity instead. The actual UI never sent them
 * at all, so both safety gates silently reported `not_evaluated` on every
 * real acceptance — a missing input read exactly like a passing check. All
 * three are now read from `getOpportunity(opportunityId)` (populated at
 * `openOpportunity()` time from the frozen decision-board candidate, see
 * nfl-execution-pipeline.js and migration 026) instead of trusted from the
 * request body, for the identical reason `eventKey`/`participant` already
 * are: a caller cannot bypass a safety gate merely by omitting a field, and
 * the check is provably about the actual contract being accepted.
 */
import { recordAcceptance, openExposure, getOpportunity } from './nfl-execution-lifecycle.js';
import { checkExposureBudget, DEFAULT_EXPOSURE_BUDGET } from './nfl-execution-exposure.js';
import { challengeExtremePrice } from './nfl-execution-attribution.js';
import { marketLineCorridorCheck, MARKET_LINE_CORRIDOR_POINTS } from './nfl-execution-corridor.js';
import { NFL_PRODUCTION_POLICY, normalizeNflPolicy } from './nfl-policy.js';
import { expectedNetReturn, isHalfPoint } from '../betting/nfl/contracts/spread-probabilities.js';
import { spreadContractTerms, assertExecutionPrice, assertSpreadLine, executionInputError }
  from './nfl-execution-validation.js';

/**
 * Re-check the policy's economics at the price and line actually being
 * accepted (Codex correction C15).
 *
 * The selection-time gate proves a bet was worth taking at the price the board
 * saw. By the time a human accepts, the price has usually moved, and the plan
 * is explicit: "Acceptance checks do not re-enforce the new expected-return
 * threshold at the refreshed offered price."
 *
 * Two refusals here are deliberate and are not the same thing:
 *
 *   'line_changed_no_qualified_distribution' -- the handicap moved, and the
 *       frozen forecast is a probability for the OLD number. The plan: "If the
 *       line changes, re-evaluate that handicap under the same legally
 *       available distribution; do not apply a probability for -2.5 to -3.5."
 *       There is no such distribution stored yet, so this abstains rather than
 *       reusing a probability that describes a different contract.
 *
 *   'push_probability_unknown' -- the accepted line is an integer and no push
 *       estimate exists. An unknown push is unavailable, not zero.
 */
export function refreshedEconomics({ opportunity, line, price, policy = NFL_PRODUCTION_POLICY }) {
  const active = normalizeNflPolicy(policy);
  const frozenProbability = opportunity.model_probability;

  // The handicap the forecast was made about is the CONTRACT's own line, read
  // back out of the immutable contract key. `market_line_at_decision` is the
  // market's expected margin at decision time, which is a different quantity
  // entirely -- comparing an accepted handicap against it would report a line
  // change on every ordinary acceptance.
  const contractLine = spreadContractTerms(opportunity.contract_key)?.line ?? null;

  if (!Number.isFinite(frozenProbability)) {
    return { evaluated: false, reason: 'no_frozen_forecast',
      detail: 'this opportunity was opened without a calibrated probability, so there is nothing to '
        + 'refresh against. It can still be recorded as an off-policy ticket.' };
  }
  const acceptedLine = line ?? contractLine;
  if (Number.isFinite(contractLine) && Number.isFinite(acceptedLine) && acceptedLine !== contractLine) {
    return { evaluated: false, reason: 'line_changed_no_qualified_distribution',
      frozen_line: contractLine, accepted_line: acceptedLine,
      detail: 'the handicap moved after the forecast was frozen. A probability for one number is not a '
        + 'probability for another, and no stored distribution can answer the new one.' };
  }

  const pushProbability = isHalfPoint(acceptedLine) ? 0 : opportunity.push_probability ?? null;
  if (pushProbability == null) {
    return { evaluated: false, reason: 'push_probability_unknown', accepted_line: acceptedLine,
      detail: 'an integer handicap pushes, and no estimate of that mass exists. Unknown is not zero.' };
  }

  const decided = 1 - pushProbability;
  const conditionalWin = Math.min(Math.max(frozenProbability - active.probabilityHaircut, 0), 1);
  const expected = expectedNetReturn({
    win: decided * conditionalWin, loss: decided * (1 - conditionalWin), americanPrice: price });

  if (expected == null) {
    return { evaluated: false, reason: 'unpriceable_offer', accepted_price: price };
  }
  const threshold = active.minExpectedReturn;
  return {
    evaluated: true,
    expected_net_return: +expected.toFixed(5),
    threshold, policy_id: active.id, policy_version: active.version,
    haircut: active.probabilityHaircut,
    push_probability: pushProbability,
    passes: threshold == null || expected >= threshold
  };
}

export function attemptAcceptance(opportunityId, { occurredAt, book, line = null, price, stakeUnits,
  actor = 'user:nick', note = null,
  budget = DEFAULT_EXPOSURE_BUDGET, acknowledgeSuspectPrice = false,
  corridorPoints = MARKET_LINE_CORRIDOR_POINTS,
  acknowledgeCorridorBreach = false,
  policy = NFL_PRODUCTION_POLICY,
  /**
   * Codex correction C15: "Separate an authorized recommendation from
   * recording a ticket the user actually placed: the latter must remain
   * truthfully recordable as off-policy, even when it was a bad bet."
   *
   * Nick placing a bet is a fact about the world. Refusing to write it down
   * because the policy would not have recommended it does not un-place the
   * bet; it removes a real loss from the ledger and quietly improves the
   * record. So an off-policy ticket is always recordable -- and always
   * LABELLED, so it can be excluded from any evaluation of what the policy
   * itself would have earned.
   */
  offPolicy = false } = {}) {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    return { accepted: false, blocked_reason: 'opportunity_not_found',
      reason: `no persisted opportunity ${opportunityId} — an acceptance must be against a real, ` +
        'previously opened opportunity, never a bare identifier the caller asserts facts about' };
  }
  // Validate the OFFER before any gate looks at it. A malformed price or stake
  // is a bad request, not a policy refusal, and the two must not be reported
  // as the same thing: the route maps a throw to 400 and a blocked result to
  // 409, and a caller debugging a typo should not be told the policy declined
  // their bet. These are the same assertions recordAcceptance makes; running
  // them here only moves the failure earlier, never widens what is accepted.
  assertExecutionPrice(price);
  if (opportunity.market === 'spreads') assertSpreadLine(opportunity.contract_key, line);
  if (!Number.isFinite(stakeUnits) || stakeUnits <= 0) {
    throw executionInputError('stakeUnits must be a positive finite number');
  }
  if (typeof book !== 'string' || !book.trim()) {
    throw executionInputError('book is required to record an acceptance');
  }

  const modelLine = opportunity.model_line;
  const marketLine = opportunity.market_line_at_decision;
  const fairProbability = opportunity.model_probability;

  const exposure = checkExposureBudget({
    openExposures: openExposure(),
    candidate: { event_key: opportunity.event_key, participant: opportunity.participant, stake_units: stakeUnits },
    budget
  });
  if (!exposure.allowed) {
    return { accepted: false, blocked_reason: 'exposure_budget', exposure };
  }

  let corridor = null;
  if (Number.isFinite(modelLine) && Number.isFinite(marketLine)) {
    corridor = marketLineCorridorCheck({ modelLine, marketLine, corridorPoints });
    if (corridor.verdict === 'needs_review' && !acknowledgeCorridorBreach) {
      return { accepted: false, blocked_reason: 'market_line_corridor', corridor, exposure };
    }
  }

  let suspect = null;
  if (Number.isFinite(fairProbability)) {
    suspect = challengeExtremePrice({ price, fairProbability });
    if (suspect.suspect && !acknowledgeSuspectPrice) {
      return { accepted: false, blocked_reason: 'suspect_price', suspect, exposure, corridor };
    }
  }

  // The refreshed-price gate. Everything above checks the shape of the bet;
  // this checks whether it is still worth taking at the number now on offer.
  const economics = refreshedEconomics({ opportunity, line, price, policy });
  if (!offPolicy && (!economics.evaluated || !economics.passes)) {
    return { accepted: false,
      blocked_reason: economics.evaluated ? 'expected_return_below_threshold' : economics.reason,
      economics, exposure, suspect, corridor,
      detail: 'the policy will not authorize this at the refreshed price. It can still be recorded as '
        + 'an off-policy ticket if it was actually placed, which keeps the ledger honest.' };
  }

  const accepted = recordAcceptance(opportunityId, { occurredAt, book, line, price, stakeUnits, actor,
    note: offPolicy
      ? `${note ? `${note} · ` : ''}OFF-POLICY: recorded because it was placed, not because the policy `
        + `authorized it (${economics.evaluated ? `EV ${economics.expected_net_return} vs threshold `
          + `${economics.threshold}` : economics.reason})`
      : note });
  return { accepted: true, opportunity: accepted, exposure, suspect, corridor, economics,
    off_policy: offPolicy === true,
    // Forecast authority comes from a qualified, frozen forecast -- never from
    // the fact that a row was written by the execution path. C15: "Do not
    // grant forecast authority merely through source:'execution'."
    policy_authorized: offPolicy !== true };
}
