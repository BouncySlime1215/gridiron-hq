/**
 * WR-COACH: the typed action schema and the pure dispatcher.
 *
 * No React, no fetch, no imports: every rule here runs in a node test. The
 * hook (useWarRoomCoach.ts) wires it to the server; the dock (CoachDock.tsx)
 * draws it.
 *
 * The server keeps the same schema in server/services/warroom-actions/schema.js
 * (Coach's tools validate there before an action ever leaves the server);
 * test/warroom-coach.test.js pins the lists here equal to the lists there.
 *
 * Guardrails (WAR-ROOM-UI.md v2 section 2), each enforced below:
 *  1. Numbers come only from the engine: plug_in binds to a whitelisted plans
 *     field; draft_message refuses digits; the dispatcher does no arithmetic
 *     on engine values.
 *  2. Reversible by default: every applied action pushes an undo snapshot.
 *  3. Plan changes wait for Confirm: a plan-changing action only sets
 *     `pending` (with the trade-off preview read from the plans JSON); the plan
 *     request exists only after confirm(). Nothing here can send to a league-mate.
 *  4. Typed actions only: an unknown type is refused and nothing changes.
 *  5. Every action is logged (session.log), refusals included.
 */

export const PANELS = ['next_move', 'itinerary', 'flip_map', 'targets', 'destination', 'catch_up', 'brain_check', 'cards'] as const;
export type Panel = typeof PANELS[number];

export const ACTION_TYPES = [
  'focus_panel', 'filter', 'sort', 'pin_card', 'plug_in', 'arrange_layout', 'reset_layout',
  'undo', 'next', 'set_objective', 'add_stop', 'remove_stop', 'set_risk_mode', 'set_tolerance',
  'explain', 'draft_message'
] as const;
export type ActionType = typeof ACTION_TYPES[number];

export const PLAN_CHANGING = ['set_objective', 'add_stop', 'remove_stop', 'set_risk_mode', 'set_tolerance'] as const;

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
export const SORT_KEYS = ['engine', 'p_yes', 'gain', 'spread'] as const;
export const RISK_MODES = ['safe', 'balanced', 'all_in'] as const;
export const GOALS = ['title', 'playoffs', 'get_player', 'points'] as const;
export const STOP_KINDS = ['get', 'sell', 'flip', 'claim', 'cover_bye', 'untouchable', 'custom'] as const;
export const TOLERANCE_KEYS = ['max_assets', 'max_offers_per_manager_week', 'max_downside_per_step', 'reputation_budget', 'ai_spend'] as const;
/** CAMPAIGN-01d slider ranges; same as server/services/warroom-actions/schema.js TOLERANCES. */
export const TOLERANCES: Record<typeof TOLERANCE_KEYS[number], { min: number; max: number; integer: boolean }> = {
  max_assets: { min: 0, max: 10, integer: true },
  max_offers_per_manager_week: { min: 0, max: 7, integer: true },
  max_downside_per_step: { min: 0, max: 100, integer: false },
  reputation_budget: { min: 0, max: 100, integer: false },
  ai_spend: { min: 0, max: 100, integer: false }
};

export const PLUG_IN_FIELDS: Record<string, readonly PlugView[]> = {
  'destination.title_now': ['number'],
  'destination.path': ['sparkline', 'table'],
  'itinerary.stops': ['list', 'table'],
  'suggestions': ['list', 'table'],
  'speed_curve': ['sparkline', 'table'],
  'flips': ['list', 'table'],
  'brain_check.checks': ['list', 'table'],
  'roster.bye_holes': ['list', 'sparkline', 'table'],
  'title.odds_by_week': ['sparkline', 'table']
};
export type PlugView = 'number' | 'list' | 'sparkline' | 'table';

export const PANEL_NAMES: Record<Panel, string> = {
  next_move: 'Next move', itinerary: 'Stops', flip_map: 'Flip map', targets: 'Targets',
  destination: 'Destination', catch_up: 'Catch-up', brain_check: 'Brain check', cards: 'Your cards'
};
const MODE_NAMES: Record<string, string> = { safe: 'Safe', balanced: 'Balanced', all_in: "Fuck it, let's go" };

export type StopInput = { kind: typeof STOP_KINDS[number]; label: string; player_id?: string | null; week?: number | null };
export type CoachAction =
  | { type: 'focus_panel'; panel: Panel; league?: number | null }
  | { type: 'filter'; panel: Panel; position?: typeof POSITIONS[number] | null }
  | { type: 'sort'; panel: Panel; by: typeof SORT_KEYS[number] }
  | { type: 'pin_card'; player_id?: string | null; move_id?: string | null }
  | { type: 'plug_in'; field: string; view: PlugView; title?: string | null }
  | { type: 'arrange_layout'; panel: Panel; size?: 'normal' | 'large'; order?: number | null }
  | { type: 'reset_layout' } | { type: 'undo' } | { type: 'next' }
  | { type: 'set_objective'; goal: typeof GOALS[number]; player_id?: string; points_per_week?: number; arrive_by?: number | null }
  | { type: 'add_stop'; stop: StopInput }
  | { type: 'remove_stop'; stop_id: string }
  | { type: 'set_risk_mode'; mode: typeof RISK_MODES[number]; until_week?: number | null }
  | { type: 'set_tolerance'; key: typeof TOLERANCE_KEYS[number]; value: number }
  | { type: 'explain'; panel?: Panel }
  | { type: 'draft_message'; text: string; tone?: 'softer' | 'firmer' | 'neutral' | null };

const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const wholeIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const idOk = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9:_.-]+$/.test(v);

/** Validate one action. Unknown types and malformed fields are refused with a reason. */
export function validateAction(raw: unknown): { ok: true; action: CoachAction } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'an action must be an object' };
  const a = raw;
  const bad = (error: string) => ({ ok: false as const, error });
  if (!has(ACTION_TYPES, a.type)) return bad(`unknown action ${JSON.stringify(a.type)}; refused`);
  const panelOk = (p: unknown) => has(PANELS, p);
  switch (a.type) {
    case 'focus_panel':
      if (!panelOk(a.panel)) return bad('panel is not a War Room panel');
      if (a.league != null && !wholeIn(a.league, 1, 99)) return bad('league must be a league number');
      break;
    case 'filter':
      if (!panelOk(a.panel)) return bad('panel is not a War Room panel');
      if (a.position != null && !has(POSITIONS, a.position)) return bad('position is not a position');
      break;
    case 'sort':
      if (!panelOk(a.panel) || !has(SORT_KEYS, a.by)) return bad('sort needs a panel and a known key');
      break;
    case 'pin_card':
      if (a.player_id == null && a.move_id == null) return bad('pin_card needs player_id or move_id');
      if ((a.player_id != null && !idOk(a.player_id)) || (a.move_id != null && !idOk(a.move_id))) return bad('pin_card ids are malformed');
      break;
    case 'plug_in': {
      const views = PLUG_IN_FIELDS[a.field as string];
      if (!views) return bad(`field ${JSON.stringify(a.field)} is not a whitelisted engine field`);
      if (!views.includes(a.view)) return bad(`view ${JSON.stringify(a.view)} is not allowed for ${a.field}`);
      break;
    }
    case 'arrange_layout':
      if (!panelOk(a.panel)) return bad('panel is not a War Room panel');
      if (a.size != null && a.size !== 'normal' && a.size !== 'large') return bad('size is normal or large');
      if (a.order != null && !wholeIn(a.order, 0, PANELS.length - 1)) return bad('order is out of range');
      break;
    case 'set_objective':
      if (!has(GOALS, a.goal)) return bad('goal is not a goal');
      if (a.goal === 'get_player' && !idOk(a.player_id)) return bad('get_player needs player_id');
      if (a.goal === 'points' && !wholeIn(a.points_per_week, 1, 400)) return bad('points needs points_per_week');
      if (a.arrive_by != null && !wholeIn(a.arrive_by, 1, 18)) return bad('arrive_by must be a week');
      break;
    case 'add_stop':
      if (!isObj(a.stop) || !has(STOP_KINDS, a.stop.kind) || typeof a.stop.label !== 'string' || !a.stop.label.trim()) {
        return bad('add_stop needs a stop with a kind and a label');
      }
      break;
    case 'remove_stop':
      if (!idOk(a.stop_id)) return bad('remove_stop needs stop_id');
      break;
    case 'set_risk_mode':
      if (!has(RISK_MODES, a.mode)) return bad('mode is safe, balanced or all_in');
      if (a.until_week != null && !wholeIn(a.until_week, 1, 18)) return bad('until_week must be a week');
      break;
    case 'set_tolerance':
      if (!has(TOLERANCE_KEYS, a.key) || typeof a.value !== 'number' || !Number.isFinite(a.value)) return bad('set_tolerance needs a known key and a number');
      {
        const rule = TOLERANCES[a.key];
        if (a.value < rule.min || a.value > rule.max || (rule.integer && !Number.isInteger(a.value))) return bad(`${a.key} must be from ${rule.min} to ${rule.max}`);
      }
      break;
    case 'explain':
      if (a.panel != null && !panelOk(a.panel)) return bad('panel is not a War Room panel');
      break;
    case 'draft_message':
      if (typeof a.text !== 'string' || !a.text.trim()) return bad('draft_message needs text');
      if (/\d/.test(a.text)) return bad('draft_message text carries a digit; numbers come only from the engine');
      break;
  }
  return { ok: true, action: a as CoachAction };
}

/* ------------------------------------------------------------------ state */

export interface PlugCard { id: string; field: string; view: PlugView; title: string | null; league: number | null }
export interface CoachUi {
  league: number | null;
  main: Panel | null;                           // panel swapped into the main slot; null = next move
  layout: { order: Panel[]; large: Panel[] };
  filters: Partial<Record<Panel, string | null>>;
  sorts: Partial<Record<Panel, string>>;
  pins: { player_id: string | null; move_id: string | null }[];
  cards: PlugCard[];
  deck: Record<string, number>;                 // league -> deck index
  explain: Panel | null;
  drafts: Record<string, string>;               // league -> draft text
  replanning: { league: number | null; kind: string; at: string }[];
}
export interface Preview { status: 'ok' | 'unknown'; reason?: string; value?: Record<string, any>; key: string }
export interface Pending { action: CoachAction; preview: Preview; asked: string | null }
export interface LogEntry { at: string; type: string; outcome: 'applied' | 'refused' | 'previewed' | 'confirmed' | 'cancelled' | 'undone'; asked: string | null; detail: string; action: unknown }
export interface CoachSession { ui: CoachUi; history: { ui: CoachUi; requestId: number | null }[]; pending: Pending | null; log: LogEntry[]; seq: number }

/** What the dispatcher needs to know about the screen. Read-only. */
export interface CoachCtx {
  leagues: number[];                            // league numbers on the switcher
  plans: any;                                   // this league's plans JSON (the dashboard's view); may be null
  now?: string;
}
export interface Outcome { status: LogEntry['outcome']; message: string; action?: CoachAction }

export const DEFAULT_LAYOUT: CoachUi['layout'] = { order: [...PANELS], large: [] };

export function newSession(saved?: Partial<CoachUi> | null): CoachSession {
  const ui: CoachUi = {
    league: null, main: null, layout: { order: [...DEFAULT_LAYOUT.order], large: [] }, filters: {}, sorts: {},
    pins: [], cards: [], deck: {}, explain: null, drafts: {}, replanning: [], ...(saved ?? {})
  };
  return { ui, history: [], pending: null, log: [], seq: ui.cards.length };
}

/** The part of the UI state that is saved per user (layout, pins, cards). */
export function savedLayoutOf(ui: CoachUi) {
  return { layout: ui.layout, pins: ui.pins, cards: ui.cards };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const stamp = (ctx: CoachCtx) => ctx.now ?? new Date().toISOString();

/** A Field<T> from the view carries its value under .value; a bare producer object is itself. */
function unwrap(f: any): any {
  if (f && typeof f === 'object' && typeof f.status === 'string' && 'producer' in f) {
    return ['ok', 'zero', 'thin', 'stale', 'fallback'].includes(f.status) ? f.value ?? null : null;
  }
  return f ?? null;
}

/** Read a whitelisted dotted field from the plans JSON. No arithmetic. */
export function readField(plans: any, field: string): any {
  if (!PLUG_IN_FIELDS[field]) return undefined;
  let node: any = plans;
  for (const part of field.split('.')) {
    node = unwrap(node);
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return unwrap(node);
}

/** The key the producer writes a trade-off under in plans.stop_tradeoffs. */
export function tradeoffKey(a: CoachAction): string {
  switch (a.type) {
    case 'add_stop': return `add:${a.stop.kind}:${a.stop.player_id ?? a.stop.week ?? a.stop.label.trim().toLowerCase()}`;
    case 'remove_stop': return `remove:${a.stop_id}`;
    case 'set_risk_mode': return `mode:${a.mode}${a.until_week ? `:until:${a.until_week}` : ''}`;
    case 'set_tolerance': return `tolerance:${a.key}:${a.value}`;
    case 'set_objective': return `objective:${a.goal}${a.player_id ? `:${a.player_id}` : a.points_per_week ? `:${a.points_per_week}` : ''}`;
    default: return '';
  }
}

/** The engine's trade-off for a plan change, or a typed "not computed yet". Never made up here. */
export function previewFor(a: CoachAction, plans: any): Preview {
  const key = tradeoffKey(a);
  const table = unwrap(plans?.stop_tradeoffs);
  const hit = table && typeof table === 'object' ? unwrap(table[key]) : null;
  if (hit && typeof hit === 'object') return { status: 'ok', key, value: hit };
  return { status: 'unknown', key, reason: 'Trade-off not computed yet: the planner has not priced this change. Confirming records it and the planner prices it on its next run.' };
}

/** The request a confirmed plan change records (server: schema.js#requestForAction). */
export function requestFor(a: CoachAction): { kind: string; payload: Record<string, unknown> } | null {
  switch (a.type) {
    case 'set_objective': { const { type, ...rest } = a; return { kind: 'objective.set', payload: rest }; }
    case 'add_stop': return { kind: 'stop.add', payload: { stop: a.stop } };
    case 'remove_stop': return { kind: 'stop.remove', payload: { stop_id: a.stop_id } };
    case 'set_risk_mode': return { kind: 'mode.set', payload: { mode: a.mode, until_week: a.until_week ?? null } };
    case 'set_tolerance': return { kind: 'tolerance.set', payload: { key: a.key, value: a.value } };
    default: return null;
  }
}

function deckOf(plans: any): any[] {
  const alts = unwrap(plans?.alternatives);
  return Array.isArray(alts) ? alts : [];
}

function withLog(s: CoachSession, ctx: CoachCtx, type: string, outcome: LogEntry['outcome'], asked: string | null, detail: string, action: unknown): CoachSession {
  return { ...s, log: [{ at: stamp(ctx), type, outcome, asked, detail, action }, ...s.log].slice(0, 200) };
}

function describePlanChange(a: CoachAction): string {
  switch (a.type) {
    case 'set_objective': return a.goal === 'get_player' ? 'Change the goal: go get this player' : a.goal === 'points' ? 'Change the goal: a points-per-week target' : `Change the goal to ${a.goal === 'title' ? 'win the title' : 'make the playoffs'}`;
    case 'add_stop': return `Add a stop: ${a.stop.label}`;
    case 'remove_stop': return 'Remove a stop';
    case 'set_risk_mode': return `Switch to ${MODE_NAMES[a.mode]}${a.until_week ? ' until a set week' : ''}`;
    case 'set_tolerance': return `Change the ${a.key.replace(/_/g, ' ')} tolerance`;
    default: return a.type;
  }
}

/**
 * Apply one action. Returns the next session and what happened.
 * An invalid or unknown action changes nothing but the log.
 */
export function dispatch(s: CoachSession, raw: unknown, ctx: CoachCtx, asked: string | null = null): { session: CoachSession; outcome: Outcome } {
  const checked = validateAction(raw);
  if (!checked.ok) {
    const type = isObj(raw) && typeof raw.type === 'string' ? raw.type.slice(0, 40) : 'unknown';
    const message = `I don't have that action, so nothing changed (${checked.error}).`;
    return { session: withLog(s, ctx, type, 'refused', asked, checked.error, raw), outcome: { status: 'refused', message } };
  }
  const a = checked.action;
  if (a.type === 'undo') return undo(s, ctx, asked);

  // A new ask drops an unconfirmed preview: the plan stays as it was.
  let base = s;
  if (s.pending) base = withLog({ ...s, pending: null }, ctx, s.pending.action.type, 'cancelled', asked, 'You asked something else; the plan is unchanged', s.pending.action);

  if ((PLAN_CHANGING as readonly string[]).includes(a.type)) {
    const preview = previewFor(a, ctx.plans);
    const session = withLog({ ...base, pending: { action: a, preview, asked } }, ctx, a.type, 'previewed', asked,
      preview.status === 'ok' ? 'Trade-off shown; waiting for your Confirm' : 'Trade-off not computed yet; waiting for your Confirm', a);
    return { session, outcome: { status: 'previewed', action: a,
      message: `${describePlanChange(a)}? Here's the trade-off first. Nothing changes until you tap Confirm.` } };
  }

  const ui = clone(base.ui);
  const refuse = (message: string) => ({ session: withLog(base, ctx, a.type, 'refused', asked, message, a), outcome: { status: 'refused' as const, message, action: a } });
  let message = '';
  switch (a.type) {
    case 'focus_panel':
      if (a.league != null) {
        if (!ctx.leagues.includes(a.league)) return refuse(`There is no League ${a.league} on your switcher.`);
        ui.league = a.league;
      }
      ui.main = a.panel === 'next_move' || a.panel === 'cards' ? null : a.panel;
      message = `Showing ${a.league != null ? `League ${a.league}'s ` : 'the '}${PANEL_NAMES[a.panel].toLowerCase()}${ui.main ? ' in the big slot' : ''}.`;
      break;
    case 'filter':
      ui.filters[a.panel] = a.position ?? null;
      message = a.position ? `${PANEL_NAMES[a.panel]} now shows only ${a.position}s.` : `${PANEL_NAMES[a.panel]} shows every position again.`;
      break;
    case 'sort':
      ui.sorts[a.panel] = a.by;
      message = a.by === 'engine' ? `${PANEL_NAMES[a.panel]} is back in the engine's order.` : `${PANEL_NAMES[a.panel]} sorted by ${a.by === 'p_yes' ? 'chance he says yes' : a.by}.`;
      break;
    case 'pin_card': {
      const pin = { player_id: a.player_id ?? null, move_id: a.move_id ?? null };
      if (ui.pins.some(p => p.player_id === pin.player_id && p.move_id === pin.move_id)) return refuse('That is already pinned.');
      ui.pins.push(pin);
      message = 'Pinned to Your cards. It stays on screen when you switch panels.';
      break;
    }
    case 'plug_in': {
      const id = `c${s.seq + 1}`;
      ui.cards.push({ id, field: a.field, view: a.view, title: a.title ?? null, league: ui.league });
      message = `Added a ${a.view} card from the engine field ${a.field}. I picked the field and the view; the numbers come from the engine, not me.`;
      const session = withLog({ ...base, ui, seq: s.seq + 1, history: [...base.history, { ui: base.ui, requestId: null }] }, ctx, a.type, 'applied', asked, message, a);
      return { session, outcome: { status: 'applied', message, action: a } };
    }
    case 'arrange_layout': {
      const size = a.size ?? 'large';
      ui.layout.large = size === 'large' ? [...new Set([...ui.layout.large, a.panel])] : ui.layout.large.filter(p => p !== a.panel);
      if (a.order != null) {
        const rest = ui.layout.order.filter(p => p !== a.panel);
        rest.splice(a.order, 0, a.panel);
        ui.layout.order = rest;
      }
      message = `${PANEL_NAMES[a.panel]} ${size === 'large' ? 'made bigger' : 'back to normal size'}${a.order != null ? ' and moved' : ''}. Say "undo" to put it back.`;
      break;
    }
    case 'reset_layout':
      ui.layout = { order: [...DEFAULT_LAYOUT.order], large: [] };
      ui.main = null;
      message = 'Layout reset to the default grid.';
      break;
    case 'next': {
      const key = String(ui.league ?? 'current');
      const size = deckOf(ctx.plans).length;
      const at = ui.deck[key] ?? 0;
      if (!size) return refuse('There is no deck of alternatives for this league yet.');
      if (at + 1 >= size) return refuse('That was the last move in the deck. Say "undo" to go back one, or ask me to look wider.');
      ui.deck[key] = at + 1;
      message = 'Skipped. Showing the next move in the deck.';
      break;
    }
    case 'explain':
      ui.explain = a.panel ?? 'next_move';
      ui.main = ui.explain === 'next_move' ? null : ui.explain;
      message = `Highlighted the reasons on the ${PANEL_NAMES[ui.explain].toLowerCase()}.`;
      break;
    case 'draft_message':
      ui.drafts[String(ui.league ?? 'current')] = a.text.trim();
      message = 'Put a draft in the message box. You copy it and send it yourself; I never send anything.';
      break;
  }
  const session = withLog({ ...base, ui, history: [...base.history, { ui: base.ui, requestId: null }] }, ctx, a.type, 'applied', asked, message, a);
  return { session, outcome: { status: 'applied', message, action: a } };
}

/**
 * Nick tapped Confirm. Returns the request to record (the hook POSTs it with
 * source 'coach', confirmed true). With nothing pending, nothing happens.
 */
export function confirm(s: CoachSession, ctx: CoachCtx): { session: CoachSession; outcome: Outcome; request: { kind: string; payload: Record<string, unknown> } | null } {
  if (!s.pending) return { session: s, outcome: { status: 'refused', message: 'There is nothing waiting for a Confirm.' }, request: null };
  const a = s.pending.action;
  const request = requestFor(a);
  const ui = clone(s.ui);
  ui.replanning = [...ui.replanning, { league: ui.league, kind: request?.kind ?? a.type, at: stamp(ctx) }];
  const message = `Confirmed: ${describePlanChange(a).toLowerCase()}. Replanning; usually a few minutes. Say "undo" to take it back.`;
  const session = withLog({ ...s, ui, pending: null, history: [...s.history, { ui: s.ui, requestId: null }] }, ctx, a.type, 'confirmed', s.pending.asked, message, a);
  return { session, outcome: { status: 'confirmed', message, action: a }, request };
}

export function cancel(s: CoachSession, ctx: CoachCtx): { session: CoachSession; outcome: Outcome } {
  if (!s.pending) return { session: s, outcome: { status: 'refused', message: 'There is nothing to cancel.' } };
  const session = withLog({ ...s, pending: null }, ctx, s.pending.action.type, 'cancelled', s.pending.asked, 'Preview dropped; plan unchanged', s.pending.action);
  return { session, outcome: { status: 'cancelled', message: 'Dropped it. The plan is unchanged.' } };
}

/** After the confirmed request is stored, remember its id so undo can retract it. */
export function markRecorded(s: CoachSession, requestId: number, index = s.history.length - 1): CoachSession {
  if (index < 0 || index >= s.history.length) return s;
  const history = s.history.slice();
  history[index] = { ...history[index], requestId };
  return { ...s, history };
}

/**
 * One-tap undo. A pending preview is dropped first; otherwise the last change
 * is reverted. If that change was a recorded plan request, `retractRequestId`
 * tells the hook to record a retract for it.
 */
export function undo(s: CoachSession, ctx: CoachCtx, asked: string | null = null): { session: CoachSession; outcome: Outcome; retractRequestId: number | null } {
  if (s.pending) {
    const { session, outcome } = cancel(s, ctx);
    return { session, outcome, retractRequestId: null };
  }
  if (!s.history.length) {
    return { session: withLog(s, ctx, 'undo', 'refused', asked, 'Nothing to undo yet', { type: 'undo' }), outcome: { status: 'refused', message: 'Nothing to undo yet.' }, retractRequestId: null };
  }
  const last = s.history[s.history.length - 1];
  const session = withLog({ ...s, ui: last.ui, history: s.history.slice(0, -1) }, ctx, 'undo', 'undone', asked,
    last.requestId ? 'Reverted the last change and took back its plan request' : 'Reverted the last change', { type: 'undo' });
  return { session, outcome: { status: 'undone', message: last.requestId ? 'Undone. I took back the plan change too.' : 'Undone. The screen is back to how it was.' }, retractRequestId: last.requestId };
}

/* ----------------------------------------------------------------- footer */

function dealLine(nm: any, names: Record<string, string>): string | null {
  if (!nm || typeof nm !== 'object') return null;
  const n = (id: string) => names[id] ?? id;
  const give = Array.isArray(nm.give) ? nm.give.map(n).join(' + ') : '';
  const get = Array.isArray(nm.get) ? nm.get.map(n).join(' + ') : '';
  if (!nm.partner || !give || !get) return null;
  const partner = /^team\b/i.test(String(nm.partner)) ? nm.partner : `Team ${nm.partner}`;
  return `send ${partner} ${give} for ${get}`;
}

/**
 * Every Coach reply ends with where we are going, how many stops are left and
 * the next move (CAMPAIGN-01f "never lose sight"). Read from the plans JSON;
 * anything the producer has not written says so.
 */
export function coachFooter(plans: any, ui?: CoachUi): { destination: string; stops_left: string; next_move: string; text: string } {
  const dest = unwrap(plans?.destination);
  const goal = dest?.goal?.label ?? null;
  const destination = goal ? `${goal}${dest.arrive_by ? ` by week ${dest.arrive_by}` : ''}` : 'no goal set yet';
  const itin = unwrap(plans?.itinerary);
  const stops = Array.isArray(itin?.stops) ? itin.stops : null;
  const left = typeof itin?.stops_left === 'number' ? String(itin.stops_left)
    : stops ? String(stops.filter((x: any) => x?.status !== 'done' && x?.status !== 'dropped').length) : null;
  const stops_left = left ?? 'not computed yet';
  const names = (plans?.names && typeof plans.names === 'object') ? plans.names : {};
  const deck = deckOf(plans);
  const at = ui ? (ui.deck[String(ui.league ?? 'current')] ?? 0) : 0;
  const move = deck.length ? deck[Math.min(at, deck.length - 1)] : unwrap(plans?.next_move);
  const next_move = dealLine(move, names) ?? 'not computed yet';
  return { destination, stops_left, next_move,
    text: `Destination: ${destination} / Stops left: ${stops_left} / Next move: ${next_move}` };
}
