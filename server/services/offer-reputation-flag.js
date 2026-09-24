/**
 * The one reader of GRIDIRON_REP_GATE (REP-01 offer fatigue + reputation gate, #264;
 * RULINGS 4 and 8).
 *
 * Switches offer-reputation.js#gateDeals, the Trade Lab finder's hook: on, every deal
 * from GET /api/trades/:leagueId/find carries a `reputation` verdict for its partner;
 * off, the finder's result is served exactly as before (no `reputation` field).
 *
 * Preview mode (preview-mode.js) turns it on too; each verdict then carries
 * `preview: true` and the reason below.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const REP_GATE_ENV = 'GRIDIRON_REP_GATE';
export const REP_GATE_OFF_REASON =
  'Offer fatigue and reputation gate is default-off, unconfirmed forward: every limit, the ' +
  'half-life and the lowball line are declared starting points, not fitted (no settled app ' +
  `offers yet). Set ${REP_GATE_ENV}=1 to switch it on.`;

/** Read per call, so a test or a run can flip it. */
export function repGateFields() {
  if (process.env[REP_GATE_ENV] === '1') return { enabled: true };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(REP_GATE_OFF_REASON) };
  return { enabled: false, reason: REP_GATE_OFF_REASON };
}
