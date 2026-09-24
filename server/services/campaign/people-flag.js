/**
 * CAMPAIGN-PEOPLE ship switch. GRIDIRON_CAMPAIGN_PEOPLE_ENABLED=1 turns the counterpart
 * model on in the campaign producer, =0 forces it off; unset, it follows preview mode
 * (preview-mode.js) and the plans carry preview: true.
 */
import { previewUnconfirmed, previewFields } from '../preview-mode.js';

export const PEOPLE_ENV = 'GRIDIRON_CAMPAIGN_PEOPLE_ENABLED';
export const PEOPLE_PREVIEW_REASON = 'Counterpart model from chat profiles: hand-set weights, ungraded (EVAL E1/E2/C7 pending)';

export function campaignPeople(env = process.env) {
  const v = env[PEOPLE_ENV];
  if (v === '1') return { enabled: true, preview: false };
  if (v === '0') return { enabled: false, preview: false };
  if (v == null && previewUnconfirmed()) return { enabled: true, ...previewFields(PEOPLE_PREVIEW_REASON) };
  return { enabled: false, preview: false };
}
