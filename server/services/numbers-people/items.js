/**
 * NUMBERS-PEOPLE: the plan's key items, read from the served plan (the War Room
 * plans file, one producer) and nothing else.
 *
 *   move     the next move and the deck cards after it (MAX_MOVES)
 *   target   the top Go get targets (MAX_TARGETS)
 *   partner  each league-mate with an open or likely deal: on a served move, an
 *            offer still open with him, or offers logged / a priced edge with him,
 *            never one Nick's rules block (MAX_PARTNERS)
 *
 * Each item carries `facts`: the plan's own numbers and labels for it, keyed by a
 * short name the lanes cite (never a number a lane computed). `rosters` and
 * `players` are the ids whose stored people signals lane B may read. No names:
 * the display label is added by the view, from the same plan, at read time.
 */
import crypto from 'node:crypto';
import { servedMoves } from '../coach/brief-claims.js';

export const MAX_MOVES = 3;
export const MAX_TARGETS = 5;
export const MAX_PARTNERS = 5;

const ok = f => f?.status === 'ok';
const val = f => (ok(f) && f.value != null ? f.value : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(4) : null);
const ids = a => (Array.isArray(a) ? a.map(String) : []);
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));

/** What each fact means, in the words the tab shows (never the key itself). */
export const FACT_LABELS = Object.freeze({
  title_gain_if_complete: '{Odds} gain if the whole move lands',
  expected_title_gain: 'Expected {odds} gain (after the chance it falls apart)',
  p_complete: 'Chance the whole move completes (a guess)',
  p_yes_first_step: 'Chance he says yes to the first step (a guess)',
  steps: 'Trades in the move',
  gain_if_landed: '{Odds} gain if you land him',
  p_reach: 'Chance you can reach a deal for him (a guess)',
  fits_risk_mode: 'Fits your risk mode',
  approved: 'You approved this target',
  plan_target: 'The plan is working toward him',
  p_responds: 'Chance he replies to an offer (a guess)',
  edge: '{Odds} edge the plan sees in a deal with him',
  offers_logged: 'Offers logged with him',
  reply_accept: 'His accept rate on past offers',
  on_served_move: 'He is on one of the plan\'s moves',
  open_offer: 'An offer with him is still open',
  checked_out: 'He looks checked out'
});

/** A fact's label in the plan's own unit (title odds, or playoff odds for a playoffs league). */
export function factLabel(key, unit = null) {
  const odds = unit === 'playoff_odds' ? 'playoff odds' : 'title odds';
  return (FACT_LABELS[key] ?? key).replace('{Odds}', odds[0].toUpperCase() + odds.slice(1)).replace('{odds}', odds);
}

const unitOf = f => (typeof f?.unit === 'string' ? f.unit : null);

function moveItem(move) {
  const first = move.steps?.[0] ?? {};
  const facts = compact({
    title_gain_if_complete: num(val(move.delta_final)),
    expected_title_gain: num(val(move.expected)),
    p_complete: num(val(move.p_complete)),
    p_yes_first_step: num(val(first.p_yes)),
    steps: move.steps?.length ?? null
  });
  const rosters = [...new Set((move.steps ?? []).map(s => String(s.partner)))];
  const players = [...new Set((move.steps ?? []).flatMap(s => [...ids(s.give), ...ids(s.get)]))];
  const units = compact({ title_gain_if_complete: unitOf(move.delta_final), expected_title_gain: unitOf(move.expected) });
  return { item_type: 'move', item_id: String(move.move_id), facts, units, rosters, players,
    ref: { steps: (move.steps ?? []).map(s => ({ partner: String(s.partner), give: ids(s.give), get: ids(s.get) })),
      target: move.target != null ? String(move.target) : null } };
}

function targetItem(t) {
  const facts = compact({
    gain_if_landed: num(val(t.gain_if_landed)),
    p_reach: num(val(t.p_reach)),
    fits_risk_mode: val(t.mode_fit) != null ? val(t.mode_fit) === 'fits' : null,
    approved: typeof t.approved === 'boolean' ? t.approved : null,
    plan_target: typeof t.is_plan_target === 'boolean' ? t.is_plan_target : null
  });
  const owner = t.owner != null ? String(t.owner) : null;
  return { item_type: 'target', item_id: String(t.player), facts, units: compact({ gain_if_landed: unitOf(t.gain_if_landed) }),
    rosters: owner ? [owner] : [], players: [String(t.player)],
    ref: { owner } };
}

function partnerItem(p, { onMove, openOffer }) {
  const team = String(p.team);
  const facts = compact({
    p_responds: num(p.p_responds),
    edge: num(val(p.edge)),
    offers_logged: Number.isFinite(p.offers_logged) ? p.offers_logged : null,
    reply_accept: num(p.reply_mix?.accept),
    on_served_move: onMove,
    open_offer: openOffer,
    checked_out: typeof p.checked_out === 'boolean' ? p.checked_out : null
  });
  return { item_type: 'partner', item_id: team, facts, units: compact({ edge: unitOf(p.edge) }), rosters: [team], players: [], ref: {} };
}

/**
 * The key items for one league's plan entry. `openOffers` is the set of roster
 * ids with an offer still open (trade_outcomes status 'proposed').
 */
export function keyItems(entry, { openOffers = new Set() } = {}) {
  if (!entry) return [];
  const moves = servedMoves(entry).slice(0, MAX_MOVES).map(moveItem);
  const targets = (val(entry.targets) ?? []).filter(t => t?.player != null).slice(0, MAX_TARGETS).map(targetItem);
  const onMove = new Set(moves.flatMap(m => m.rosters));
  const open = new Set([...openOffers].map(String));
  const me = entry.me != null ? String(entry.me) : null;
  const partners = (val(entry.partners) ?? [])
    .filter(p => p?.team != null && !p.blocked && String(p.team) !== me)
    .map(p => ({ p, onMove: onMove.has(String(p.team)), openOffer: open.has(String(p.team)) }))
    .filter(x => x.onMove || x.openOffer || (x.p.offers_logged ?? 0) > 0 || (val(x.p.edge) ?? 0) > 0)
    // Likeliest deal first: on a move, then an open offer, then the priced edge.
    .sort((a, b) => (b.onMove - a.onMove) || (b.openOffer - a.openOffer) || ((val(b.p.edge) ?? 0) - (val(a.p.edge) ?? 0)))
    .slice(0, MAX_PARTNERS)
    .map(x => partnerItem(x.p, x));
  return [...moves, ...targets, ...partners];
}

/**
 * The plan-change hash: which items are key and the categorical facts that can
 * flip a stance. Not the Monte Carlo numbers, which move a little on every
 * producer run and would read as a new plan each time.
 */
export function inputsHash(items) {
  const shape = items.map(i => [i.item_type, i.item_id, i.rosters, i.players,
    Object.fromEntries(Object.entries(i.facts).filter(([, v]) => typeof v !== 'number'))]);
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

export const itemKey = i => `${i.item_type}:${i.item_id}`;
