import { api } from '../../api';

/**
 * The War Room's one write (WR-3, PR #230): every tap that should teach the planner
 * becomes one row in the request table via POST /api/warroom/:leagueId/requests.
 * The producer reads the rows (FIX-07); nothing here changes a plan or sends an offer.
 */
export type RequestKind = 'deck.skip' | 'offer.sent' | 'offer.reply' | 'target.approve' | 'aj.allow' | 'aj.revoke' | 'aj.confirm';
export interface WarRoomRequest { kind: RequestKind; payload: Record<string, unknown> }
export type Poster = (path: string, init: RequestInit) => Promise<unknown>;

/** Approve a suggested target: the producer's next run plans toward him. */
export const targetApprove = (playerId: string): WarRoomRequest =>
  ({ kind: 'target.approve', payload: { player_id: playerId, source: 'suggested' } });

/** AJ-PICK: allow (or stop allowing) A.J. Brown to be traded for this player. Nick's tap only. */
export const ajAllow = (playerId: string, on: boolean): WarRoomRequest =>
  ({ kind: on ? 'aj.allow' : 'aj.revoke', payload: { player_id: playerId } });

/** AJ-PICK: Nick's OK on one exact card that gives A.J. Brown. */
export const ajConfirm = (moveId: string): WarRoomRequest => ({ kind: 'aj.confirm', payload: { move_id: moveId } });

export const requestPath = (leagueId: number) => `/warroom/${leagueId}/requests`;

export function postWarRoomRequest(leagueId: number, req: WarRoomRequest, post: Poster = api): Promise<unknown> {
  return post(requestPath(leagueId), {
    method: 'POST',
    body: JSON.stringify({ kind: req.kind, payload: req.payload, source: 'nick' }),
  });
}

/** Post outbox[from..] in order; resolves to the new sent count. A failed post throws, with the count so far on the error. */
export async function flushOutbox(leagueId: number, outbox: WarRoomRequest[], from: number, post: Poster = api): Promise<number> {
  let i = from;
  try {
    for (; i < outbox.length; i++) await postWarRoomRequest(leagueId, outbox[i], post);
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sent: i });
  }
  return i;
}

/* ---------------------------------------------- negotiation mode (NEGOTIATE-UI) */

export const negotiationsPath = (leagueId: number) => `/warroom/${leagueId}/negotiations`;
const threadPath = (leagueId: number, id: number, action: string) => `${negotiationsPath(leagueId)}/${id}/${action}`;
const postJson = (post: Poster, path: string, body: Record<string, unknown>) =>
  post(path, { method: 'POST', body: JSON.stringify(body) });

/** "I sent it": the server reads the step from the served plan and opens the thread. */
export const openNegotiation = (leagueId: number, moveId: string, stepIndex = 0, post: Poster = api) =>
  postJson(post, negotiationsPath(leagueId), { move_id: moveId, step_index: stepIndex });

/** Log his reply; a counter carries his ask. */
export const logNegotiationReply = (leagueId: number, id: number, reply: string, ask: { give: string[]; get: string[] } | null = null, post: Poster = api) =>
  postJson(post, threadPath(leagueId, id, 'reply'), ask ? { reply, ...ask } : { reply });

export const counterSent = (leagueId: number, id: number, pkg: { give: string[]; get: string[] }, post: Poster = api) =>
  postJson(post, threadPath(leagueId, id, 'counter-sent'), pkg);

export const followedUp = (leagueId: number, id: number, post: Poster = api) =>
  postJson(post, threadPath(leagueId, id, 'follow-up'), {});

export const closeNegotiation = (leagueId: number, id: number, reason: 'walked_away' | 'undone', post: Poster = api) =>
  postJson(post, threadPath(leagueId, id, 'close'), { reason });

/** The counter builder's live rescore; `rosters` on the first call lists both sides. */
export const rescoreCounter = (leagueId: number, id: number, pkg: { give: string[]; get: string[] }, rosters = false, post: Poster = api) =>
  postJson(post, threadPath(leagueId, id, 'rescore'), { ...pkg, rosters });
