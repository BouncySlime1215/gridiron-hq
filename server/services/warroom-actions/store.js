/**
 * WR-3 + WR-COACH persistence: record requests, save layouts, log actions.
 *
 * Records only. Nothing here prices a stop or replans: the offline campaign
 * producer reads `warroom_requests` (consumed_at IS NULL) and does that work off
 * the request thread. Tables: server/migrations/076_warroom_requests.js.
 *
 * FIX-07: a request that names a card (`offer.sent`, `deck.skip`) stores the
 * card's partner and players as the plans file showed them, so the producer can
 * fold it after the deck has moved on. `offer.sent` is also the one "I sent it"
 * store: it writes the `trade_outcomes` row (trade-outcomes.js#recordSentOffer)
 * in the same transaction as the request, and a retract inside the undo window
 * takes the sent mark back off.
 */
import { db, row, rows, run } from '../../db/index.js';
import { previewFields } from '../preview-mode.js';
import { warRoomFlag } from '../warroom-flag.js';
import { recordSentOffer, unmarkSentOffer } from '../trade-outcomes.js';
import { findCard, sentDeal } from './cards.js';
import { validateRequest, validateAction } from './schema.js';

/**
 * Default off. On with the War Room's own switch or locally through preview mode.
 * server/services/warroom-flag.js is the one reader of both (WAR-ROOM-UI.md section 6).
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

/** What a stored request keeps of its card: enough to fold it after the deck moves on. */
const cardSummary = c => c && ({ partner: c.partner, give: c.give, get: c.get,
  title_odds_delta: c.title_odds_delta, title_odds_delta_se: c.title_odds_delta_se });

function playersById(ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!list.length) return new Map();
  return new Map(rows(`SELECT id, name, espn_id FROM players WHERE id IN (${list.map(() => '?').join(',')})`, ...list)
    .map(p => [String(p.id), { id: String(p.id), name: p.name, espn_id: p.espn_id ?? null }]));
}

/**
 * "I sent it" -> the one sent-offer store. Returns what the request row keeps:
 * `{ state, id }` from recordSentOffer, or `{ state: 'not_recorded', reason }`
 * when the card cannot be graded (so the response says so; nothing is dropped
 * silently).
 */
function sentOffer({ leagueId, card, sentAs, plans, now }) {
  if (!card) return { state: 'not_recorded', reason: 'that move is not in the current plans file, so there is no card to record' };
  const lg = row('SELECT season, my_team_id FROM leagues WHERE id = ?', leagueId);
  if (lg?.season == null) return { state: 'not_recorded', reason: 'this league has no season on file' };
  const built = sentDeal(card, sentAs, playersById([...card.give, ...card.get,
    ...(card.opening?.give ?? []), ...(card.opening?.get ?? []), ...(card.walk_away?.max_give ?? [])]));
  if (built.error) return { state: 'not_recorded', reason: built.error };
  const out = recordSentOffer({
    league_id: leagueId, season: lg.season,
    proposer_team_id: card.me ?? (lg.my_team_id == null ? null : String(lg.my_team_id)),
    deal: built.deal, model_version: `campaign-producer plans ${plans?.as_of ?? 'unknown'}`,
    sent_at: new Date(now).toISOString(), move_id: card.move_id, price_band: built.price_band,
  });
  return { state: out.state, id: out.id, price_band: built.price_band };
}

function inTransaction(fn) {
  const owned = !db.isTransaction;
  if (owned) db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    if (owned) db.exec('COMMIT');
    return out;
  } catch (e) {
    if (owned && db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Record one request. Returns the stored row (plus `trade_outcome` for "I sent
 * it"). A second "I sent it" for an offer already marked sent records nothing
 * and returns `{ already_sent: true, trade_outcome }`.
 * A retract must name an earlier request of the same user and league, made in
 * the last 10 minutes (the "I sent it" undo window, WAR-ROOM-UI.md 5.3).
 * `plans` is war-room-view.js#loadPlans's result; only card-naming kinds read it.
 */
export function recordRequest({ userId, leagueId, kind, payload, source = 'nick', confirmed = false, now = Date.now(),
  plans = null }) {
  const checked = validateRequest(kind, payload, { source, confirmed });
  if (!checked.ok) throw new WarRoomInputError(checked.error);
  let target = null;
  if (kind === 'retract') {
    target = row('SELECT * FROM warroom_requests WHERE id = ? AND user_id = ? AND league_id = ?',
      checked.payload.request_id, userId, leagueId);
    if (!target) throw new WarRoomInputError('there is no such request to take back');
    if (target.kind === 'retract') throw new WarRoomInputError('a take-back cannot itself be taken back');
    if (now - Date.parse(target.created_at) > RETRACT_WINDOW_MS) {
      throw new WarRoomInputError('the 10-minute undo window for that request has passed');
    }
  }
  const stored = { ...checked.payload };
  if (checked.kind === 'aj.confirm') {
    // AJ-PICK: Nick's OK names one exact card in the current plans that gives A.J. Brown.
    const legs = [0, 1, 2, 3].map(i => findCard(plans?.entries, leagueId, stored.move_id, i)).filter(Boolean);
    if (!legs.some(c => c.give.includes('277'))) {
      throw new WarRoomInputError('that card is not in the current plans or does not give A.J. Brown, so there is nothing to OK');
    }
    stored.card = legs.map(cardSummary);
  }
  const card = checked.kind === 'offer.sent' || checked.kind === 'deck.skip'
    ? findCard(plans?.entries, leagueId, stored.move_id, stored.step_index ?? 0) : null;
  if (checked.kind === 'offer.sent' || checked.kind === 'deck.skip') stored.card = cardSummary(card);

  return inTransaction(() => {
    if (checked.kind === 'offer.sent') {
      stored.trade_outcome = sentOffer({ leagueId, card, sentAs: stored.sent_as, plans, now });
      if (stored.trade_outcome.state === 'already_sent') {
        return { already_sent: true, trade_outcome: stored.trade_outcome };
      }
    }
    if (target?.kind === 'offer.sent') {
      const sent = parse(target.payload).trade_outcome;
      stored.undo = sent?.id != null && ['recorded', 'marked_sent'].includes(sent.state)
        ? unmarkSentOffer(sent.id) : { state: 'nothing_to_undo' };
    }
    const info = run(`INSERT INTO warroom_requests (user_id, league_id, kind, payload, source, confirmed)
      VALUES (?, ?, ?, ?, ?, ?)`, userId, leagueId, checked.kind, JSON.stringify(stored),
    source, confirmed ? 1 : 0);
    const out = requestOut(row('SELECT * FROM warroom_requests WHERE id = ?', Number(info.lastInsertRowid)));
    return stored.trade_outcome ? { ...out, trade_outcome: stored.trade_outcome } : out;
  });
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
