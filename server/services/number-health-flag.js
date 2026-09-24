/**
 * FIX-10: the one reader of GRIDIRON_NUMBER_HEALTH.
 *
 * Switches the user-visible half of BROKEN-01 (#237): the Settings "Number health" card,
 * the red dot on the Settings nav icon, and GET /api/number-audit that both read. The
 * refresh-loop audit job (number-audit.js#runNumberAudit) is not behind it: it only
 * writes the `number_audit` table, so the rows are there the day the card is switched on.
 *
 * Preview mode (preview-mode.js) turns it on too; the response then carries
 * `preview: true` and the reason below, and the card shows the preview label.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const NUMBER_HEALTH_ENV = 'GRIDIRON_NUMBER_HEALTH';
export const NUMBER_HEALTH_OFF_REASON =
  'Number health card is default-off, unconfirmed forward: its tolerances are a first cut ' +
  'not yet tuned on live rows, and the known-nonzero control on a copy of the live database ' +
  `has not run. Set ${NUMBER_HEALTH_ENV}=1 to switch it on.`;

/** Read per call, so a test or a run can flip it. */
export function numberHealthFields() {
  if (process.env[NUMBER_HEALTH_ENV] === '1') return { enabled: true };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(NUMBER_HEALTH_OFF_REASON) };
  return { enabled: false, reason: NUMBER_HEALTH_OFF_REASON };
}
