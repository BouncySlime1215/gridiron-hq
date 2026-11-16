/**
 * FIX-184-3: the one reader of LIVE_INACTIVE_WARNINGS (RL-3-2).
 *
 * Switches the user-visible half of the live gameday-inactive source: the Start/Sit
 * "Check before kickoff" warning and the SS-01 dead-starter card's second inactive
 * source, both fed by availability-claims.js#claimInactiveHook (one set). The Jetstream
 * listener (scheduler.js `live_inactives`) and the `live_inactive_claims` table are not
 * behind it: they keep recording, so the forward test has data.
 *
 * Default off (standing rule b): the only 2026 weeks played (W1-W2) are the weeks the
 * parser was designed on, so there is no forward holdout yet. It goes on when the W3-W5
 * forward test passes (docs/tdd/2026-09-23-live-inactive-monitor.tdd.md section 3).
 *
 * Preview mode (preview-mode.js) turns it on too; the hook and every warning then carry
 * `preview: true` and the reason below. Read per call, so a test or a run can flip it
 * with no restart (test/live-inactive-flag.test.js).
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const LIVE_INACTIVE_ENV = 'LIVE_INACTIVE_WARNINGS';
export const LIVE_INACTIVE_OFF_REASON =
  'Live gameday inactive warnings (public Bluesky posts and verified news, latest pre-kickoff claim) are ' +
  'default-off, unconfirmed forward: the parser was designed on the only 2026 weeks played, and the W3-W5 ' +
  `forward test has not run. Set ${LIVE_INACTIVE_ENV}=1 to switch it on.`;

/** { enabled } | { enabled: true, preview: true, preview_reason } | { enabled: false, reason }. */
export function liveInactiveFields() {
  if (process.env[LIVE_INACTIVE_ENV] === '1') return { enabled: true };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(LIVE_INACTIVE_OFF_REASON) };
  return { enabled: false, reason: LIVE_INACTIVE_OFF_REASON };
}
