/**
 * The gated entry point for recording an ACCEPTED state.
 *
 * `nfl-execution-lifecycle.js#recordAcceptance` is a state-machine primitive —
 * it only knows about transition order and the "this is not a confirmed
 * sportsbook fill" invariant. Two more things must be true before a ledger
 * entry becomes an acceptance, per the plan, and this is where they are
 * enforced together so nothing can call `recordAcceptance` around them:
 *
 *   1. The aggregate game/player exposure budget is not breached
 *      (nfl-execution-exposure.js).
 *   2. A fair-price EV far beyond anything ever measured here is challenged
 *      first, rather than treated as free money (nfl-execution-attribution.js).
 *
 * Both gates return the reason they blocked rather than throwing, because a
 * blocked acceptance is a normal, expected outcome here — this module's job
 * is to make blocking the easy path, not an exception to catch.
 */
import { recordAcceptance, openExposure } from './nfl-execution-lifecycle.js';
import { checkExposureBudget, DEFAULT_EXPOSURE_BUDGET } from './nfl-execution-exposure.js';
import { challengeExtremePrice } from './nfl-execution-attribution.js';

export function attemptAcceptance(opportunityId, { occurredAt, book, line = null, price, stakeUnits,
  actor = 'user:nick', note = null, eventKey = null, participant = null, fairProbability = null,
  budget = DEFAULT_EXPOSURE_BUDGET, acknowledgeSuspectPrice = false } = {}) {
  const exposure = checkExposureBudget({
    openExposures: openExposure(),
    candidate: { event_key: eventKey, participant, stake_units: stakeUnits },
    budget
  });
  if (!exposure.allowed) {
    return { accepted: false, blocked_reason: 'exposure_budget', exposure };
  }

  let suspect = null;
  if (Number.isFinite(fairProbability)) {
    suspect = challengeExtremePrice({ price, fairProbability });
    if (suspect.suspect && !acknowledgeSuspectPrice) {
      return { accepted: false, blocked_reason: 'suspect_price', suspect, exposure };
    }
  }

  const opportunity = recordAcceptance(opportunityId, { occurredAt, book, line, price, stakeUnits, actor, note });
  return { accepted: true, opportunity, exposure, suspect };
}
