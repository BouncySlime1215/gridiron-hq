import { api } from '../../api';

/**
 * The War Room's one write (WR-3, PR #230): every tap that should teach the planner
 * becomes one row in the request table via POST /api/warroom/:leagueId/requests.
 * The producer reads the rows (FIX-07); nothing here changes a plan or sends an offer.
 */
export type RequestKind = 'deck.skip' | 'offer.sent' | 'offer.reply' | 'target.approve';
export interface WarRoomRequest { kind: RequestKind; payload: Record<string, unknown> }
export type Poster = (path: string, init: RequestInit) => Promise<unknown>;

/** Approve a suggested target: the producer's next run plans toward him. */
export const targetApprove = (playerId: string): WarRoomRequest =>
  ({ kind: 'target.approve', payload: { player_id: playerId, source: 'suggested' } });

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
