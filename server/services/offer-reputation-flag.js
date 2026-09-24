/**
 * The one reader of GRIDIRON_REPUTATION (REP-01 offer fatigue + reputation, #264;
 * RULINGS 4 and 8, FIX-264-2).
 *
 * Switches two things, both default-off:
 *   - offer-reputation.js#gateDeals, the Trade Lab finder's hook: on, every deal
 *     from GET /api/trades/:leagueId/find carries a `reputation` verdict for its
 *     partner; off, the finder's result is served exactly as before.
 *   - the `reputation` factor in trade-acceptance.js#acceptanceBand, which the
 *     War Room producer (scripts/campaign/league-adapter.mjs) feeds from
 *     selfRead's lopsidedness ledger only while this is on.
 *
 * Preview mode (preview-mode.js previewUnconfirmed()) turns it on too; each
 * verdict then carries `preview: true` and the reason below.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const REPUTATION_ENV = 'GRIDIRON_REPUTATION';
export const REPUTATION_OFF_REASON =
  'Offer fatigue, the reputation gate and the reputation factor on P(accept) are default-off, '
  + 'unconfirmed forward: every limit, the half-life, the lowball line and the factor size are '
  + 'declared starting points, not fitted (no settled app offers yet). '
  + `Set ${REPUTATION_ENV}=1 to switch them on.`;

/** Read per call, so a test or a run can flip it. */
export function reputationFields() {
  if (process.env[REPUTATION_ENV] === '1') return { enabled: true };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(REPUTATION_OFF_REASON) };
  return { enabled: false, reason: REPUTATION_OFF_REASON };
}
