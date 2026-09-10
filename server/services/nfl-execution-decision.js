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

export function attemptAcceptance(opportunityId, { occurredAt, book, line = null, price, stakeUnits,
  actor = 'user:nick', note = null,
  budget = DEFAULT_EXPOSURE_BUDGET, acknowledgeSuspectPrice = false,
  corridorPoints = MARKET_LINE_CORRIDOR_POINTS,
  acknowledgeCorridorBreach = false } = {}) {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    return { accepted: false, blocked_reason: 'opportunity_not_found',
      reason: `no persisted opportunity ${opportunityId} — an acceptance must be against a real, ` +
        'previously opened opportunity, never a bare identifier the caller asserts facts about' };
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

  const accepted = recordAcceptance(opportunityId, { occurredAt, book, line, price, stakeUnits, actor, note });
  return { accepted: true, opportunity: accepted, exposure, suspect, corridor };
}
