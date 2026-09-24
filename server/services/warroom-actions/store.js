/**
 * WR-3 + WR-COACH persistence: record requests, save layouts, log actions.
 *
 * Records only. Nothing here reads a plan, prices a stop or replans: the
 * offline campaign producer reads `warroom_requests` (consumed_at IS NULL) and
 * does that work off the request thread. Tables: server/migrations/076_warroom_requests.js.
 */
import { row, rows, run } from '../../db/index.js';
import { previewFields } from '../preview-mode.js';
import { warRoomFlag } from '../warroom-flag.js';
import { validateRequest, validateAction } from './schema.js';

/**
 * Default off. warroom-flag.js is the one reader of GRIDIRON_WARROOM_ENABLED
 * (and of preview mode for the War Room); the controls follow the same switch
 * as the dashboard.
 */
export function warRoomEnabled() {
  return warRoomFlag().enabled;
}

/** Fields a response carries when the War Room is on only because of preview mode. */
export function warRoomPreview() {
  return warRoomFlag().preview
    ? previewFields('War Room controls are default-off; on only because of preview mode')
    : {};
}

export class WarRoomInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const RETRACT_WINDOW_MS = 10 * 60 * 1000;

const parse = text => { try { return JSON.parse(text); } catch { return { unreadable: true, raw: String(text).slice(0, 200) }; } };
const requestOut = r => r && ({ ...r, payload: parse(r.payload), confirmed: !!r.confirmed });

/**
 * Record one request. Returns the stored row.
 * A retract must name an earlier request of the same user and league, made in
 * the last 10 minutes (the "I sent it" undo window, WAR-ROOM-UI.md 5.3).
 */
export function recordRequest({ userId, leagueId, kind, payload, source = 'nick', confirmed = false, now = Date.now() }) {
  const checked = validateRequest(kind, payload, { source, confirmed });
  if (!checked.ok) throw new WarRoomInputError(checked.error);
  if (kind === 'retract') {
    const target = row('SELECT * FROM warroom_requests WHERE id = ? AND user_id = ? AND league_id = ?',
      checked.payload.request_id, userId, leagueId);
    if (!target) throw new WarRoomInputError('there is no such request to take back');
    if (target.kind === 'retract') throw new WarRoomInputError('a take-back cannot itself be taken back');
    if (now - Date.parse(target.created_at) > RETRACT_WINDOW_MS) {
      throw new WarRoomInputError('the 10-minute undo window for that request has passed');
    }
  }
  const info = run(`INSERT INTO warroom_requests (user_id, league_id, kind, payload, source, confirmed)
    VALUES (?, ?, ?, ?, ?, ?)`, userId, leagueId, checked.kind, JSON.stringify(checked.payload),
  source, confirmed ? 1 : 0);
  return requestOut(row('SELECT * FROM warroom_requests WHERE id = ?', Number(info.lastInsertRowid)));
}

export function listRequests({ userId, leagueId, limit = 50 }) {
  return rows(`SELECT * FROM warroom_requests WHERE user_id = ? AND league_id = ?
    ORDER BY id DESC LIMIT ?`, userId, leagueId, Math.min(Math.max(1, limit | 0), 200)).map(requestOut);
}

const MAX_LAYOUT_CHARS = 20_000;

/** Save a new layout version for this user. Every save is kept. */
export function saveLayout({ userId, layout }) {
  if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new WarRoomInputError('layout must be an object');
  }
  const json = JSON.stringify(layout);
  if (json.length > MAX_LAYOUT_CHARS) throw new WarRoomInputError(`layout is ${json.length} characters, max ${MAX_LAYOUT_CHARS}`);
  const version = (row('SELECT MAX(version) v FROM warroom_layouts WHERE user_id = ?', userId)?.v ?? 0) + 1;
  run('INSERT INTO warroom_layouts (user_id, version, layout) VALUES (?, ?, ?)', userId, version, json);
  return { version, layout };
}

/** The latest saved layout, or null when this user never saved one (the client uses its default). */
export function latestLayout({ userId }) {
  const r = row('SELECT version, layout, saved_at FROM warroom_layouts WHERE user_id = ? ORDER BY version DESC LIMIT 1', userId);
  return r ? { version: r.version, layout: parse(r.layout), saved_at: r.saved_at } : null;
}

const OUTCOMES = ['applied', 'refused', 'previewed', 'confirmed', 'cancelled', 'undone'];

/**
 * Log one Coach UI action. An unknown action is logged as refused rather than
 * dropped: a refusal is part of the record of what Coach was asked to do.
 */
export function logAction({ userId, leagueId = null, action, outcome, asked = null, detail = null }) {
  if (!OUTCOMES.includes(outcome)) throw new WarRoomInputError(`outcome must be one of ${OUTCOMES.join(', ')}`);
  const checked = validateAction(action);
  const type = checked.ok ? checked.action.type : String(action?.type ?? 'unknown').slice(0, 40);
  const finalOutcome = checked.ok ? outcome : 'refused';
  const info = run(`INSERT INTO warroom_action_log (user_id, league_id, action_type, outcome, asked, action, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, userId, leagueId, type, finalOutcome,
  asked == null ? null : String(asked).slice(0, 2000),
  JSON.stringify(checked.ok ? checked.action : action ?? null).slice(0, 4000),
  detail == null ? (checked.ok ? null : checked.error) : String(detail).slice(0, 1000));
  return { id: Number(info.lastInsertRowid), action_type: type, outcome: finalOutcome };
}

export function listActionLog({ userId, leagueId = null, limit = 50 }) {
  const lim = Math.min(Math.max(1, limit | 0), 200);
  const out = leagueId == null
    ? rows('SELECT * FROM warroom_action_log WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, lim)
    : rows('SELECT * FROM warroom_action_log WHERE user_id = ? AND league_id = ? ORDER BY id DESC LIMIT ?', userId, leagueId, lim);
  return out.map(r => ({ ...r, action: r.action ? parse(r.action) : null }));
}
