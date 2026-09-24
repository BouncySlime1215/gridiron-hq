/**
 * FIX-10: the one reader of GRIDIRON_OFFER_LOOP.
 *
 * Switches the user-visible half of CLONE-01b b1 (#239): the TradeCard "I sent this"
 * button and POST/GET /api/trades/:leagueId/offers/sent. The post-sync settler
 * (trade-outcomes.js#settleOfferLoop) is not behind it: with the route off it has no
 * new sent offers to settle, and it still settles any recorded earlier.
 *
 * Preview mode (preview-mode.js) turns it on too; the response then carries
 * `preview: true` and the reason below, and the button shows the preview label.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const OFFER_LOOP_ENV = 'GRIDIRON_OFFER_LOOP';
export const OFFER_LOOP_OFF_REASON =
  '"I sent this" offer loop is default-off, unconfirmed forward: the 7-day expiry and 48-hour ' +
  "match window are guesses, ESPN's counter-offer shape is unverified, and no live ESPN reply " +
  `has been matched yet. Set ${OFFER_LOOP_ENV}=1 to switch it on.`;

/** Read per call, so a test or a run can flip it. */
export function offerLoopFields() {
  if (process.env[OFFER_LOOP_ENV] === '1') return { enabled: true };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(OFFER_LOOP_OFF_REASON) };
  return { enabled: false, reason: OFFER_LOOP_OFF_REASON };
}
