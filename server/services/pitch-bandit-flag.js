/**
 * The one reader of GRIDIRON_PITCH_BANDIT (M5 pitch bandit, #263; RULINGS 8).
 *
 * Switches POST /api/trades/:leagueId/pitch: the Thompson-sampling framing choice and
 * its `pitch_choices` log (migration 090). Off, the route answers
 * `{enabled:false, reason}` and logs nothing, so "I sent this" has no choice to link
 * and records the offer exactly as before (trade-outcomes.js#linkPitchChoice returns null).
 *
 * Preview mode (preview-mode.js) turns it on too; the response then carries
 * `preview: true` and the reason below.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const PITCH_BANDIT_ENV = 'GRIDIRON_PITCH_BANDIT';
export const PITCH_BANDIT_OFF_REASON =
  'Pitch bandit is default-off, unconfirmed forward: its priors come from negotiation profiles, ' +
  'not graded replies, and no framing has been scored against a real ESPN answer yet. ' +
  `Set ${PITCH_BANDIT_ENV}=1 to switch it on.`;

/** Read per call, so a test or a run can flip it. */
export function pitchBanditFields() {
  if (process.env[PITCH_BANDIT_ENV] === '1') return { enabled: true };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(PITCH_BANDIT_OFF_REASON) };
  return { enabled: false, reason: PITCH_BANDIT_OFF_REASON };
}
