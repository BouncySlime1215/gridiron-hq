/**
 * WR-COACH + WR-3: the two typed vocabularies the War Room accepts.
 *
 * 1. UI ACTIONS (what Coach may do to the screen). Coach's War Room tools
 *    return one of these; the client dispatcher applies it. The client never
 *    runs free-form code from the model, and an action whose `type` is not in
 *    ACTION_TYPES is refused, not guessed at (WAR-ROOM-UI.md v2 section 2,
 *    guardrail 4). There is no "send" action and there never will be: sending
 *    an offer to a league-mate stays Nick's own tap in ESPN (guardrail 3).
 *
 * 2. REQUEST KINDS (what Nick asks the plan to do). The WR-3 route records a
 *    request row and nothing else. The offline campaign producer reads the rows
 *    and replans; the web server never computes a plan.
 *
 * The client keeps a mirror of the action half in
 * client/src/components/warroom/coach/warroomCoach.ts. test/warroom-coach.test.js
 * pins the two lists equal, so they cannot drift.
 *
 * Numbers inside actions are Nick's inputs (a week, a points target, a
 * tolerance), never engine values. An action that would put a number into
 * prose (draft_message) is refused if its text carries a digit: numbers come
 * only from the engine (guardrail 1).
 */

export const PANELS = Object.freeze([
  'next_move', 'itinerary', 'flip_map', 'targets', 'destination', 'catch_up', 'brain_check', 'cards'
]);

export const ACTION_TYPES = Object.freeze([
  'focus_panel', 'filter', 'sort', 'pin_card', 'plug_in', 'arrange_layout', 'reset_layout',
  'undo', 'next', 'set_objective', 'add_stop', 'remove_stop', 'set_risk_mode', 'set_tolerance',
  'explain', 'draft_message'
]);

/** Actions that change the plan: preview first, then Nick's Confirm tap, then a recorded request. */
export const PLAN_CHANGING = Object.freeze([
  'set_objective', 'add_stop', 'remove_stop', 'set_risk_mode', 'set_tolerance'
]);

export const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);
export const SORT_KEYS = Object.freeze(['engine', 'p_yes', 'gain', 'spread']);
export const RISK_MODES = Object.freeze(['safe', 'balanced', 'all_in']);
export const GOALS = Object.freeze(['title', 'playoffs', 'get_player', 'points']);
export const STOP_KINDS = Object.freeze(['get', 'sell', 'flip', 'claim', 'cover_bye', 'untouchable', 'custom']);
export const VIEWS = Object.freeze(['number', 'list', 'sparkline', 'table']);

/** CAMPAIGN-01d tolerance sliders, with the range a request may carry. */
export const TOLERANCES = Object.freeze({
  max_assets: { min: 0, max: 10, integer: true },
  max_offers_per_manager_week: { min: 0, max: 7, integer: true },
  max_downside_per_step: { min: 0, max: 100, integer: false },
  reputation_budget: { min: 0, max: 100, integer: false },
  ai_spend: { min: 0, max: 100, integer: false }
});

/**
 * plug_in may bind only to these fields of the plans JSON, and only with the
 * views listed. Coach picks WHICH field and HOW to show it; the value is read
 * from the plans JSON by the client and is never written by Coach.
 */
export const PLUG_IN_FIELDS = Object.freeze({
  'destination.title_now': ['number'],
  'destination.path': ['sparkline', 'table'],
  'itinerary.stops': ['list', 'table'],
  'suggestions': ['list', 'table'],
  'speed_curve': ['sparkline', 'table'],
  'flips': ['list', 'table'],
  'brain_check.checks': ['list', 'table'],
  'roster.bye_holes': ['list', 'sparkline', 'table'],
  'title.odds_by_week': ['sparkline', 'table']
});

export const DECLINE_REASONS = Object.freeze([
  'wants_more', 'likes_his_player', 'not_interested', 'not_now', 'other'
]);
export const SKIP_REASONS = Object.freeze([
  'dont_like_player', 'costs_too_much', 'dont_trust_manager', 'not_now'
]);
export const REPLIES = Object.freeze(['accept', 'decline', 'counter', 'silence']);

export const REQUEST_KINDS = Object.freeze([
  'objective.set', 'target.approve', 'offer.sent', 'offer.reply', 'deck.skip',
  'mode.set', 'tolerance.set', 'stop.add', 'stop.remove', 'retract'
]);

/** Requests that change the plan. When Coach proposed them, the row must say Nick confirmed. */
export const PLAN_REQUESTS = Object.freeze([
  'objective.set', 'target.approve', 'mode.set', 'tolerance.set', 'stop.add', 'stop.remove'
]);

const MAX_TEXT = 500;

class Refusal extends Error {}
const fail = msg => { throw new Refusal(msg); };

const oneOf = (value, list, field) => (list.includes(value) ? value : fail(`${field} must be one of ${list.join(', ')}`));
const optOneOf = (value, list, field) => (value == null ? null : oneOf(value, list, field));
const int = (value, field, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${field} must be a whole number from ${min} to ${max}`);
  return n;
};
const optInt = (value, field, min, max) => (value == null ? null : int(value, field, min, max));
const id = (value, field) => {
  const s = String(value ?? '').trim();
  if (!s || s.length > 64 || !/^[A-Za-z0-9:_.-]+$/.test(s)) fail(`${field} must be an id`);
  return s;
};
const optId = (value, field) => (value == null ? null : id(value, field));
const text = (value, field, { required = true } = {}) => {
  const s = String(value ?? '').trim();
  if (!s) return required ? fail(`${field} is required`) : null;
  if (s.length > MAX_TEXT) fail(`${field} is longer than ${MAX_TEXT} characters`);
  return s;
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function toleranceValue(key, value) {
  const rule = TOLERANCES[key] ?? fail(`tolerance must be one of ${Object.keys(TOLERANCES).join(', ')}`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))) {
    fail(`${key} must be ${rule.integer ? 'a whole number' : 'a number'} from ${rule.min} to ${rule.max}`);
  }
  return n;
}

function stopFrom(stop) {
  if (!plain(stop)) fail('stop must be an object');
  return {
    kind: oneOf(stop.kind, STOP_KINDS, 'stop.kind'),
    label: text(stop.label, 'stop.label'),
    player_id: optId(stop.player_id, 'stop.player_id'),
    week: optInt(stop.week, 'stop.week', 1, 18)
  };
}

function objectiveFrom(input) {
  const goal = oneOf(input.goal, GOALS, 'goal');
  const out = { goal, arrive_by: optInt(input.arrive_by, 'arrive_by', 1, 18) };
  if (goal === 'get_player') out.player_id = id(input.player_id, 'player_id');
  if (goal === 'points') out.points_per_week = int(input.points_per_week, 'points_per_week', 1, 400);
  return out;
}

/** Per-type validators for UI actions. Each returns the normalised action. */
const ACTION_RULES = {
  focus_panel: a => ({ panel: oneOf(a.panel, PANELS, 'panel'), league: optInt(a.league, 'league', 1, 99) }),
  filter: a => ({ panel: oneOf(a.panel, PANELS, 'panel'), position: optOneOf(a.position, POSITIONS, 'position') }),
  sort: a => ({ panel: oneOf(a.panel, PANELS, 'panel'), by: oneOf(a.by, SORT_KEYS, 'by') }),
  pin_card: a => {
    if (a.player_id == null && a.move_id == null) fail('pin_card needs player_id or move_id');
    return { player_id: optId(a.player_id, 'player_id'), move_id: optId(a.move_id, 'move_id') };
  },
  plug_in: a => {
    const views = PLUG_IN_FIELDS[a.field] ?? fail(`field must be one of ${Object.keys(PLUG_IN_FIELDS).join(', ')}`);
    return { field: a.field, view: oneOf(a.view, views, `view for ${a.field}`), title: text(a.title, 'title', { required: false }) };
  },
  arrange_layout: a => ({
    panel: oneOf(a.panel, PANELS, 'panel'),
    size: oneOf(a.size ?? 'large', ['normal', 'large'], 'size'),
    order: optInt(a.order, 'order', 0, PANELS.length - 1)
  }),
  reset_layout: () => ({}),
  undo: () => ({}),
  next: () => ({}),
  set_objective: a => objectiveFrom(a),
  add_stop: a => ({ stop: stopFrom(a.stop) }),
  remove_stop: a => ({ stop_id: id(a.stop_id, 'stop_id') }),
  set_risk_mode: a => ({ mode: oneOf(a.mode, RISK_MODES, 'mode'), until_week: optInt(a.until_week, 'until_week', 1, 18) }),
  set_tolerance: a => ({ key: a.key, value: toleranceValue(a.key, a.value) }),
  explain: a => ({ panel: oneOf(a.panel ?? 'next_move', PANELS, 'panel') }),
  draft_message: a => {
    const t = text(a.text, 'text');
    if (/\d/.test(t)) fail('draft_message text carries a digit; numbers come only from the engine');
    return { text: t, tone: optOneOf(a.tone, ['softer', 'firmer', 'neutral'], 'tone') };
  }
};

/**
 * Validate one UI action.
 * @returns {{ok: true, action: object} | {ok: false, error: string}}
 */
export function validateAction(action) {
  if (!plain(action)) return { ok: false, error: 'an action must be an object' };
  if (!ACTION_TYPES.includes(action.type)) {
    return { ok: false, error: `unknown action ${JSON.stringify(action.type)}; refused` };
  }
  try {
    return { ok: true, action: { type: action.type, ...ACTION_RULES[action.type](action) } };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.message };
    throw e;
  }
}

/** Per-kind validators for WR-3 requests. */
const REQUEST_RULES = {
  'objective.set': p => objectiveFrom(p),
  'target.approve': p => ({ player_id: id(p.player_id, 'player_id'), source: oneOf(p.source ?? 'suggested', ['suggested', 'own'], 'source') }),
  'offer.sent': p => ({ move_id: id(p.move_id, 'move_id') }),
  'offer.reply': p => {
    const reply = oneOf(p.reply, REPLIES, 'reply');
    return {
      move_id: id(p.move_id, 'move_id'), reply,
      decline_reason: reply === 'decline' ? optOneOf(p.decline_reason, DECLINE_REASONS, 'decline_reason') : null,
      counter_note: reply === 'counter' ? text(p.counter_note, 'counter_note', { required: false }) : null
    };
  },
  'deck.skip': p => ({ move_id: id(p.move_id, 'move_id'), reason: optOneOf(p.reason, SKIP_REASONS, 'reason') }),
  'mode.set': p => ({ mode: oneOf(p.mode, RISK_MODES, 'mode'), until_week: optInt(p.until_week, 'until_week', 1, 18) }),
  'tolerance.set': p => ({ key: p.key, value: toleranceValue(p.key, p.value) }),
  'stop.add': p => ({ stop: stopFrom(p.stop) }),
  'stop.remove': p => ({ stop_id: id(p.stop_id, 'stop_id') }),
  retract: p => ({ request_id: int(p.request_id, 'request_id', 1, Number.MAX_SAFE_INTEGER) })
};

/**
 * Validate one request.
 * @returns {{ok: true, kind: string, payload: object} | {ok: false, error: string}}
 */
export function validateRequest(kind, payload, { source = 'nick', confirmed = false } = {}) {
  if (!REQUEST_KINDS.includes(kind)) return { ok: false, error: `unknown request kind ${JSON.stringify(kind)}` };
  if (!plain(payload ?? {})) return { ok: false, error: 'payload must be an object' };
  if (!['nick', 'coach'].includes(source)) return { ok: false, error: 'source must be nick or coach' };
  if (source === 'coach' && PLAN_REQUESTS.includes(kind) && confirmed !== true) {
    return { ok: false, error: 'a plan change Coach proposed is recorded only after Nick taps Confirm' };
  }
  try {
    return { ok: true, kind, payload: REQUEST_RULES[kind](payload ?? {}) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.message };
    throw e;
  }
}

/** The request a confirmed plan-changing UI action records. */
export function requestForAction(action) {
  switch (action.type) {
    case 'set_objective': { const { type, ...rest } = action; return { kind: 'objective.set', payload: rest }; }
    case 'add_stop': return { kind: 'stop.add', payload: { stop: action.stop } };
    case 'remove_stop': return { kind: 'stop.remove', payload: { stop_id: action.stop_id } };
    case 'set_risk_mode': return { kind: 'mode.set', payload: { mode: action.mode, until_week: action.until_week } };
    case 'set_tolerance': return { kind: 'tolerance.set', payload: { key: action.key, value: action.value } };
    default: return null;
  }
}
