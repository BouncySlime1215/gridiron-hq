/**
 * FIX-230-1: the WR-3 tap controls as pure steps (no React), so each rule runs in a node test.
 *
 *  - sendAction: one validated plan change -> exactly one request (objective, tolerance).
 *  - reviewOf -> confirmReview: the two-step controls (risk mode, add a stop). reviewOf
 *    reads the producer's trade-off from plans.stop_tradeoffs through Coach's previewFor
 *    (the same lookup and key the Coach dock uses) and posts nothing. confirmReview posts
 *    only from a review step that carries that preview; from anywhere else it posts
 *    nothing and returns null.
 *
 * Validation is Coach's validateAction (the client mirror of the server schema), so a
 * malformed input is refused here with its reason before any request leaves.
 */
import { previewFor, validateAction, type CoachAction, type Preview } from './coach/warroomCoach';
import { planRequest, recordWarRoomRequest, type Poster, type Recorded, type WarRoomRequest } from './requests';

export type Review =
  | { phase: 'edit' }
  | { phase: 'review'; action: CoachAction; preview: Preview | null };

export const EDIT: Review = { phase: 'edit' };

function checked(action: unknown): CoachAction {
  const v = validateAction(action);
  if (!v.ok) throw new Error(v.error);
  return v.action;
}

/** The request one plan change records. An invalid action throws with its reason. */
export const requestOf = (action: unknown): WarRoomRequest => planRequest(checked(action));

/** Record one plan change straight away. An invalid one throws and posts nothing. */
export function sendAction(action: unknown, leagueId: number, post?: Poster, now?: number): Promise<Recorded> {
  let req: WarRoomRequest;
  try { req = requestOf(action); } catch (e) { return Promise.reject(e); }
  return recordWarRoomRequest(leagueId, req, post, now);
}

/** Move to the review step: the trade-off preview, read not computed. Posts nothing. */
export function reviewOf(action: CoachAction, plans: unknown): Review {
  const a = checked(action);
  return { phase: 'review', action: a, preview: previewFor(a, plans) };
}

/** Confirm is live only on a review step whose preview is on screen. */
export const canConfirm = (r: Review): r is Extract<Review, { phase: 'review' }> & { preview: Preview } =>
  r.phase === 'review' && r.preview != null;

/** The request Confirm records, or null when no preview is on screen (then nothing posts). */
export const confirmedRequest = (r: Review): WarRoomRequest | null => (canConfirm(r) ? planRequest(r.action) : null);

/** Nick's Confirm: one request from a review step with its preview; anything else posts nothing (null). */
export async function confirmReview(r: Review, leagueId: number, post?: Poster, now?: number): Promise<Recorded | null> {
  const req = confirmedRequest(r);
  return req ? recordWarRoomRequest(leagueId, req, post, now) : null;
}
