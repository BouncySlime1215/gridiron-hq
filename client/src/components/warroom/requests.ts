import { api } from '../../api';
import { requestFor, type CoachAction } from './coach/warroomCoach';

/**
 * The War Room's one write (WR-3, PR #230): every tap that should teach the planner
 * becomes one row in the request table via POST /api/warroom/:leagueId/requests.
 * The producer reads the rows (FIX-07); nothing here changes a plan or sends an offer.
 *
 * Kinds and payload shapes are the server's (server/services/warroom-actions/schema.js
 * REQUEST_RULES). The plan-changing ones are built by Coach's requestFor, so a tap and a
 * confirmed Coach proposal record the same row. `retract` takes a request back inside
 * the server's 10-minute window (store.js RETRACT_WINDOW_MS).
 */
export type RequestKind = 'deck.skip' | 'offer.sent' | 'offer.reply' | 'target.approve'
  | 'objective.set' | 'mode.set' | 'tolerance.set' | 'stop.add' | 'stop.remove' | 'retract';
export interface WarRoomRequest { kind: RequestKind; payload: Record<string, unknown> }
export type Poster = (path: string, init: RequestInit) => Promise<unknown>;

/** Same as the server's RETRACT_WINDOW_MS. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

/** Approve a suggested target: the producer's next run plans toward him. */
export const targetApprove = (playerId: string): WarRoomRequest =>
  ({ kind: 'target.approve', payload: { player_id: playerId, source: 'suggested' } });

/** The request a plan-changing action records (objective, stop, mode, tolerance). */
export function planRequest(action: CoachAction): WarRoomRequest {
  const r = requestFor(action);
  if (!r) throw new Error(`${action.type} is not a plan change`);
  return r as WarRoomRequest;
}

type Objective = Omit<Extract<CoachAction, { type: 'set_objective' }>, 'type'>;
type Tolerance = Extract<CoachAction, { type: 'set_tolerance' }>;
type Mode = Extract<CoachAction, { type: 'set_risk_mode' }>['mode'];

export const objectiveSet = (o: Objective) => planRequest({ type: 'set_objective', ...o });
export const modeSet = (mode: Mode, untilWeek: number | null = null) => planRequest({ type: 'set_risk_mode', mode, until_week: untilWeek });
export const toleranceSet = (key: Tolerance['key'], value: number) => planRequest({ type: 'set_tolerance', key, value });
export const retractRequest = (requestId: number): WarRoomRequest => ({ kind: 'retract', payload: { request_id: requestId } });

export const requestPath = (leagueId: number) => `/warroom/${leagueId}/requests`;

export function postWarRoomRequest(leagueId: number, req: WarRoomRequest, post: Poster = api): Promise<unknown> {
  return post(requestPath(leagueId), {
    method: 'POST',
    body: JSON.stringify({ kind: req.kind, payload: req.payload, source: 'nick' }),
  });
}

/** A stored request: its row id (for Undo) and when this tab recorded it. */
export interface Recorded { id: number; kind: RequestKind; at: number }

/**
 * Post one request and hand back its stored row. An answer with no row (the War Room
 * switched off, say) is a failure, not a quiet success: it throws with the reason.
 */
export async function recordWarRoomRequest(leagueId: number, req: WarRoomRequest, post: Poster = api, now = Date.now()): Promise<Recorded> {
  const res = await postWarRoomRequest(leagueId, req, post) as { enabled?: boolean; request?: { id?: unknown } } | null;
  const id = res?.request?.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error(res?.enabled === false
      ? 'The War Room is off on the server, so this was not recorded.'
      : 'The server answered without a stored request, so this was not recorded.');
  }
  return { id, kind: req.kind, at: now };
}

export const canUndo = (rec: Recorded | null, now = Date.now()) => !!rec && rec.kind !== 'retract' && now - rec.at <= UNDO_WINDOW_MS;

/** Take a request back: one retract inside the 10-minute window, nothing after it. */
export async function undoWarRoomRequest(leagueId: number, rec: Recorded, post: Poster = api, now = Date.now()): Promise<{ posted: boolean; reason?: string }> {
  if (!canUndo(rec, now)) return { posted: false, reason: 'The 10-minute undo window for that request has passed.' };
  await recordWarRoomRequest(leagueId, retractRequest(rec.id), post, now);
  return { posted: true };
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
