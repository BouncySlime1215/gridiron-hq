/**
 * WARROOM-CONTRACT: the one shape of the War Room plans file.
 *
 * The campaign producer writes this file offline; the War Room view
 * (server/services/war-room-view.js, PR #231) and Coach's War Room actions
 * (client/src/components/warroom/coach/warroomCoach.ts, PR #230) read it.
 * Nothing on the request thread computes a plan, so this file is the whole
 * interface between them, and a key one side renames silently becomes
 * "not computed yet" on the other. This module is the single list of keys.
 *
 * Plain JS, no dependencies. `validatePlans(doc)` returns every problem it
 * finds with its path; it never throws on bad input and never repairs it.
 * `schemaPaths()` lists every path a producer may write, so a test can prove
 * that each key a consumer reads is one the producer writes.
 *
 * Typed field (every section, and every number inside one):
 *   { status: 'ok' | 'unknown' | 'failed', value?, reason?, source, se?, clears_2se?, as_of?, n? }
 * `value` is present exactly when status is 'ok'. 'unknown' and 'failed'
 * carry a plain-words `reason` and no value, so a missing number can never
 * render as 0. `source` is a key of SOURCE_IDS (WAR-ROOM-UI.md 2.3).
 */

export const SCHEMA_VERSION = 'warroom-plans/1';

export const STATUSES = Object.freeze(['ok', 'unknown', 'failed']);

export const SOURCE_IDS = Object.freeze([
  'sim.title', 'clone.accept', 'clone.price', 'market.fc', 'plan.path',
  'coach.text', 'eval.check', 'audit.numbers', 'campaign.plan'
]);

// Vocabularies shared with Coach's action schema (PR #230,
// server/services/warroom-actions/schema.js). Same values, same spelling.
export const GOALS = Object.freeze(['title', 'playoffs', 'get_player', 'points']);
export const RISK_MODES = Object.freeze(['safe', 'balanced', 'all_in']);
export const STOP_KINDS = Object.freeze(['get', 'sell', 'flip', 'claim', 'cover_bye', 'untouchable', 'custom']);
export const TOLERANCE_KEYS = Object.freeze([
  'max_assets', 'max_offers_per_manager_week', 'max_downside_per_step', 'reputation_budget', 'ai_spend'
]);
export const STOP_STATUSES = Object.freeze(['next', 'waiting', 'done', 'dropped', 'blocked']);
export const REASONING_SLOTS = Object.freeze(['case_for', 'his_side', 'devils_advocate', 'news_check', 'confidence', 'counter']);
export const BRAIN_CHECK_IDS = Object.freeze(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']);
export const MAX_ALTERNATIVES = 5;

/**
 * stop_tradeoffs keys, exactly as Coach builds them (warroomCoach.ts tradeoffKey):
 *   add:<kind>:<player_id | week | label lower-cased>   remove:<stop_id>
 *   mode:<mode>[:until:<week>]   tolerance:<key>:<value>   objective:<goal>[:<player_id | points>]
 */
export const TRADEOFF_KEY = new RegExp('^(?:' + [
  `add:(?:${STOP_KINDS.join('|')}):.+`,
  'remove:[A-Za-z0-9:_.-]+',
  `mode:(?:${RISK_MODES.join('|')})(?::until:(?:[1-9]|1[0-8]))?`,
  `tolerance:(?:${TOLERANCE_KEYS.join('|')}):-?\\d+(?:\\.\\d+)?`,
  `objective:(?:${GOALS.join('|')})(?::[A-Za-z0-9_.-]+)?`
].join('|') + ')$');

/** The producer's side of Coach's tradeoffKey: the key a plan change is priced under. */
export function tradeoffKey(a) {
  switch (a?.type) {
    case 'add_stop': return `add:${a.stop.kind}:${a.stop.player_id ?? a.stop.week ?? a.stop.label.trim().toLowerCase()}`;
    case 'remove_stop': return `remove:${a.stop_id}`;
    case 'set_risk_mode': return `mode:${a.mode}${a.until_week ? `:until:${a.until_week}` : ''}`;
    case 'set_tolerance': return `tolerance:${a.key}:${a.value}`;
    case 'set_objective': return `objective:${a.goal}${a.player_id ? `:${a.player_id}` : a.points_per_week ? `:${a.points_per_week}` : ''}`;
    default: return '';
  }
}

/* ------------------------------------------------------------ type kit */

const str = { t: 'str' };
const int = (min = -Infinity, max = Infinity) => ({ t: 'int', min, max });
const num = { t: 'num' };
const prob = { t: 'prob' };
const bool = { t: 'bool' };
const iso = { t: 'iso' };
/** A player id: must also be a key of this league's `names`. */
const pid = { t: 'pid' };
/** A team id or other opaque id. */
const id = { t: 'id' };
const lit = v => ({ t: 'lit', v });
const oneOf = values => ({ t: 'enum', values });
const arr = (item, { min = 0, max = Infinity } = {}) => ({ t: 'arr', item, min, max });
const map = (key, value) => ({ t: 'map', key, value });
const nullable = inner => ({ t: 'nullable', inner });
/** obj(required, optional) */
const obj = (req, opt = {}) => ({ t: 'obj', req, opt });
/** A typed field; `value` follows `inner` when status is 'ok'. */
const field = inner => ({ t: 'field', inner });
/** A number with its uncertainty, as a typed field. */
const numF = field(num);
const probF = field(prob);

const reasoning = obj(
  { ...Object.fromEntries(REASONING_SLOTS.map(k => [k, str])), cites: arr(str) },
  { check_first: bool }
);

const reply = obj({ do: str }, {
  when: str, message: str, odds_after: numF, move_id: id,
  counter_rules: obj({ accept_if: str, counter_with: str, walk_away_if: str })
});

/** One offer in a plan, with its playbook. */
const step = obj({
  partner: id,
  give: arr(pid, { min: 1 }),
  get: arr(pid, { min: 1 }),
  p_yes: probF,
  title_odds_delta: numF,
  title_after: probF,
  message: field(str),
  opening: field(obj({ give: arr(pid, { min: 1 }), get: arr(pid, { min: 1 }) }, { text: str })),
  walk_away: field(obj({ text: str, max_give: arr(pid) })),
  send_when: field(str),
  reply_table: field(obj({ accept: field(reply), decline: field(reply), counter: field(reply), silence: field(reply) }))
}, { reasoning: field(reasoning) });

/** A plan: one deck card. */
const move = obj({
  move_id: id,
  rank: int(1, MAX_ALTERNATIVES),
  target: nullable(pid),
  target_owner: nullable(id),
  chained: bool,
  steps: arr(step, { min: 1 }),
  p_complete: probF,
  delta_final: numF,
  expected: numF,
  reasoning: field(reasoning)
});

const destination = obj({
  goal: field(obj({ kind: oneOf(GOALS), label: str }, { player_id: pid, points_per_week: num })),
  risk_mode: field(obj({ mode: oneOf(RISK_MODES) }, { until_week: int(1, 18) })),
  tolerances: field(obj({}, Object.fromEntries(TOLERANCE_KEYS.map(k => [k, num])))),
  arrive_by: field(int(1, 18)),
  eta_week: field(int(1, 18)),
  title_now: probF,
  title_planned_now: probF,
  path: field(arr(obj({ week: int(1, 18), planned: num }, { actual: num }))),
  ground_lost: numF
});

const stop = obj({
  id: id, order: int(1), kind: oneOf(STOP_KINDS), label: str,
  status: oneOf(STOP_STATUSES), added_by: oneOf(['plan', 'nick', 'coach'])
}, { player_id: pid, week: int(1, 18), move_id: id, p_yes: probF, title_odds_delta: numF });

const tradeoff = obj({
  stop_label: str, cost: numF, extra_steps: int(0), gain: numF, net: numF,
  verdict: oneOf(['worth_it', 'not_worth_it', 'close']), because: str, new_next_move_changes: bool
}, { gain_text: str });

const flip = obj({
  player: pid, buy_from: id, sell_to: id, spread: numF, price_a: numF, price_b: numF,
  legs: nullable(obj({ give_a: pid, get_b: pid, p1: probF, p2: probF, p_both: probF, nick_after: numF }))
}, { legs_why_not: str, reasoning: field(reasoning) });

const target = obj({
  player: pid, owner: id, gain_if_landed: numF, p_reach: probF,
  mode_fit: field(oneOf(['fits', 'needs_all_in', 'too_risky_for_safe'])),
  why: field(str), approved: bool, is_plan_target: bool
}, { reasoning: field(reasoning) });

const brainReport = obj({
  overall: oneOf(['passing', 'not_enough_data', 'failing']),
  checks: arr(obj({
    id: oneOf(BRAIN_CHECK_IDS), name: str, bar: str,
    status: oneOf(['passing', 'not_enough_data', 'failing', 'running', 'not_run'])
  }, { result: str, n: int(0), as_of: iso })),
  blocks: arr(str)
}, { fell_back_to: lit('balanced') });

/** Every section a league entry carries unless the whole run failed (`error`). */
export const SECTIONS = Object.freeze({
  attention: field(obj({ rank: int(1), of: int(1), reason: str })),
  destination: field(destination),
  feasibility: field(obj({
    points_per_week: num, projected_points: numF, p_hit: probF, by_week: field(int(1, 18))
  }, { cost_text: str })),
  finder_best_expected: numF,
  next_move: field(move),
  alternatives: field(arr(move, { max: MAX_ALTERNATIVES })),
  itinerary: field(obj({
    version: int(1), stops: arr(stop), stops_left: int(0), untouchables: arr(pid), conflicts: arr(obj({ text: str }))
  })),
  stop_tradeoffs: field(map(TRADEOFF_KEY, tradeoff)),
  flip_map: field(arr(flip)),
  targets: field(arr(target)),
  catch_up: field(arr(obj({ text: str, gain: numF, steps: int(0) }, { move_id: id }))),
  speed_curve: field(arr(obj({
    arrive_by: int(1, 18), cost: numF, net: numF, variance_note: str, offers_used: int(0), before_deadline: bool
  }))),
  brain_report: field(brainReport)
});

/**
 * His side, one row per team the plan may deal with (audit 4d R3). Read by the
 * reasoning panels (server/services/reasoning/cards.js). Optional on the league
 * until the producer writes it (FIX-03 moves it into SECTIONS). Chat enters as
 * short labels only, never text.
 */
const partner = obj({ team: id, p_responds: probF, basis: str }, {
  edge: num,
  chat_labels: arr(str),
  roster_holes: arr(obj({ pos: str, gap: num })),
  recent_moves: arr(obj({ type: str, summary: str })),
  offers_logged: int(0),
  paper_values: map(/^[A-Za-z0-9:_.-]{1,64}$/, num)
});

const league = obj(
  { league: int(1), me: id, names: map(/^[A-Za-z0-9_.:-]{1,64}$/, str) },
  { error: str, sanity_composed_equals_direct: bool, ...SECTIONS, partners: field(arr(partner)) }
);

const HEAD = { schema: lit(SCHEMA_VERSION), generated_at: iso, producer: str, producer_version: str };

export const PLANS_SCHEMA = obj({ ...HEAD, leagues: arr(league) });

/* ------------------------------------------------------------ validator */

const FIELD_META = ['status', 'reason', 'source', 'se', 'clears_2se', 'as_of', 'n'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9:_.-]{1,64}$/;

function check(node, v, path, ctx) {
  const err = msg => ctx.errors.push({ path, message: msg });
  switch (node.t) {
    case 'str': if (typeof v !== 'string' || !v.trim()) err('must be a non-empty string'); return;
    case 'iso': if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) err('must be an ISO date string'); return;
    case 'bool': if (typeof v !== 'boolean') err('must be true or false'); return;
    case 'num': if (typeof v !== 'number' || !Number.isFinite(v)) err('must be a finite number'); return;
    case 'prob': if (typeof v !== 'number' || !(v >= 0 && v <= 1)) err('must be a probability from 0 to 1'); return;
    case 'int':
      if (!Number.isInteger(v) || v < node.min || v > node.max) err(`must be a whole number from ${node.min} to ${node.max}`);
      return;
    case 'id': case 'pid':
      if (typeof v !== 'string' || !ID_RE.test(v)) { err('must be an id string'); return; }
      if (node.t === 'pid' && ctx.names && !Object.hasOwn(ctx.names, v)) err(`player ${v} is not in this league's names`);
      return;
    case 'lit': if (v !== node.v) err(`must be ${JSON.stringify(node.v)}`); return;
    case 'enum': if (!node.values.includes(v)) err(`must be one of ${node.values.join(', ')}`); return;
    case 'nullable': if (v !== null) check(node.inner, v, path, ctx); return;
    case 'arr':
      if (!Array.isArray(v)) { err('must be a list'); return; }
      if (v.length < node.min) err(`must have at least ${node.min} item(s)`);
      if (v.length > node.max) err(`must have at most ${node.max} items`);
      v.forEach((x, i) => check(node.item, x, `${path}[${i}]`, ctx));
      return;
    case 'map':
      if (!isObj(v)) { err('must be an object'); return; }
      for (const [k, x] of Object.entries(v)) {
        if (!node.key.test(k)) ctx.errors.push({ path: `${path}.${k}`, message: 'key does not match the contract' });
        check(node.value, x, `${path}.${k}`, ctx);
      }
      return;
    case 'obj': {
      if (!isObj(v)) { err('must be an object'); return; }
      for (const [k, sub] of Object.entries(node.req)) {
        if (!(k in v)) ctx.errors.push({ path: `${path}.${k}`, message: 'is required' });
        else check(sub, v[k], `${path}.${k}`, ctx);
      }
      for (const [k, x] of Object.entries(v)) {
        if (k in node.req) continue;
        if (k in node.opt) check(node.opt[k], x, `${path}.${k}`, ctx);
        else ctx.errors.push({ path: `${path}.${k}`, message: 'is not in the contract' });
      }
      return;
    }
    case 'field': {
      if (!isObj(v) || !('status' in v)) { err('must be a typed field { status, source, ... }'); return; }
      for (const k of Object.keys(v)) {
        if (k !== 'value' && !FIELD_META.includes(k)) ctx.errors.push({ path: `${path}.${k}`, message: 'is not a typed-field key' });
      }
      if (!STATUSES.includes(v.status)) { err(`status must be one of ${STATUSES.join(', ')}`); return; }
      if (!SOURCE_IDS.includes(v.source)) err(`source must be one of ${SOURCE_IDS.join(', ')}`);
      if ('se' in v && !(typeof v.se === 'number' && v.se >= 0)) err('se must be a number >= 0');
      if ('clears_2se' in v && typeof v.clears_2se !== 'boolean') err('clears_2se must be true or false');
      if ('as_of' in v) check(iso, v.as_of, `${path}.as_of`, ctx);
      if ('n' in v) check(int(0), v.n, `${path}.n`, ctx);
      if (v.status === 'ok') {
        if (!('value' in v)) err("an 'ok' field must carry a value");
        else check(node.inner, v.value, `${path}.value`, ctx);
      } else {
        if ('value' in v) err(`a '${v.status}' field must not carry a value`);
        if (typeof v.reason !== 'string' || !v.reason.trim()) err(`a '${v.status}' field must say why in reason`);
      }
      return;
    }
    default: throw new Error(`plans-schema: unknown node ${node.t}`);
  }
}

const okValue = f => (isObj(f) && f.status === 'ok' ? f.value : undefined);

/** Cross-key rules a shape check cannot see. */
function crossCheck(entry, path, ctx) {
  const err = (p, message) => ctx.errors.push({ path: `${path}.${p}`, message });
  if (entry.error === undefined) {
    for (const k of Object.keys(SECTIONS)) {
      if (!(k in entry)) err(k, "is required (write it as 'unknown' with a reason when it is not computed)");
    }
  }
  const deck = okValue(entry.alternatives);
  if (Array.isArray(deck)) {
    const seen = new Set();
    deck.forEach((m, i) => {
      if (m?.rank !== i + 1) err(`alternatives.value[${i}].rank`, `must be ${i + 1}: the deck is written best first`);
      if (seen.has(m?.move_id)) err(`alternatives.value[${i}].move_id`, 'is used twice in the deck');
      seen.add(m?.move_id);
    });
  }
  const next = okValue(entry.next_move);
  if (next && Array.isArray(deck) && deck.length && next.move_id !== deck[0]?.move_id) {
    err('next_move.value.move_id', 'must be the head of the deck (alternatives.value[0].move_id)');
  }
  if (next && entry.alternatives?.status === 'ok' && Array.isArray(deck) && !deck.length) {
    err('next_move', 'is ok but the deck is empty');
  }
}

/**
 * Validate a whole plans file.
 * @returns {{ ok: boolean, errors: { path: string, message: string }[] }}
 */
export function validatePlans(doc) {
  const ctx = { errors: [], names: null };
  if (!isObj(doc)) return { ok: false, errors: [{ path: '$', message: 'must be an object with leagues[]' }] };
  const { leagues, ...head } = doc;
  check(obj(HEAD), head, '$', ctx);
  if (!Array.isArray(leagues)) {
    ctx.errors.push({ path: '$.leagues', message: 'must be a list of league entries' });
    return { ok: false, errors: ctx.errors };
  }
  const seen = new Set();
  leagues.forEach((entry, i) => {
    const r = validateLeague(entry, `$.leagues[${i}]`);
    ctx.errors.push(...r.errors);
    if (seen.has(entry?.league)) ctx.errors.push({ path: `$.leagues[${i}].league`, message: 'is listed twice' });
    seen.add(entry?.league);
  });
  return { ok: ctx.errors.length === 0, errors: ctx.errors };
}

/** Validate one league entry. */
export function validateLeague(entry, path = '$.leagues[0]') {
  const ctx = { errors: [], names: isObj(entry?.names) ? entry.names : null };
  check(league, entry, path, ctx);
  if (isObj(entry)) crossCheck(entry, path, ctx);
  return { ok: ctx.errors.length === 0, errors: ctx.errors };
}

/* ---------------------------------------------------------------- paths */

/**
 * Every path a producer may write, in one notation: `.key` for an object key,
 * `[]` for a list item, `{}` for a map entry, and a typed field's value under
 * `.value`. Example: `leagues[].alternatives.value[].steps[].p_yes.value`.
 */
export function schemaPaths() {
  const out = new Set();
  const walk = (node, p) => {
    if (p) out.add(p);
    switch (node.t) {
      case 'nullable': walk(node.inner, p); return;
      case 'arr': walk(node.item, `${p}[]`); return;
      case 'map': walk(node.value, `${p}{}`); return;
      case 'obj':
        for (const [k, sub] of [...Object.entries(node.req), ...Object.entries(node.opt)]) walk(sub, p ? `${p}.${k}` : k);
        return;
      case 'field':
        for (const k of FIELD_META) out.add(`${p}.${k}`);
        walk(node.inner, `${p}.value`);
        return;
      default:
    }
  };
  walk(PLANS_SCHEMA, '');
  return out;
}

/** The same notation for a concrete document: which contract paths it actually writes. */
export function writtenPaths(doc) {
  const out = new Set();
  const walk = (v, p) => {
    if (p) out.add(p);
    if (Array.isArray(v)) { v.forEach(x => walk(x, `${p}[]`)); return; }
    if (!isObj(v)) return;
    // The maps: their keys are data, not contract keys.
    if (/(^|\.)stop_tradeoffs\.value$|^leagues\[\]\.names$|\.paper_values$/.test(p)) { for (const x of Object.values(v)) walk(x, `${p}{}`); return; }
    for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(doc, '');
  return out;
}
