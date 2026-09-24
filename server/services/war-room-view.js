/**
 * WR-1 + WR-2: the War Room's one read (WAR-ROOM-UI.md sections 2 and 3).
 *
 * The War Room serves no new number. It reads one plans JSON written ahead of time by
 * the ACQ-FLIP study script (scripts/study/acq-flip-proto.mjs --json, PR #227; later
 * the campaign producer) and reshapes it into typed fields. Nothing here simulates,
 * prices or re-ranks: every number on the page is a number the producer wrote, and a
 * number the producer did not write is `unknown`, never 0.
 *
 * Typed field (every section, and every number inside a section, is one):
 *   { status: 'ok' | 'unknown' | 'failed', value?, reason?, source, producer, producer_version,
 *     se?, clears_2se?, guess?, preview? }
 * `value` exists only for 'ok'. finalize() strips it from any failed or unknown field
 * wherever it sits in the view, so a bug upstream still cannot leak a digit.
 *
 * Request-thread cost: one async stat of the plans file per request; the file is read
 * and parsed only when its mtime or size changes, and the per-league reshaping is a
 * field copy. No producer module is imported here.
 */
import fs from 'node:fs/promises';
import { previewFields, previewText } from './preview-mode.js';
import { warRoomFlag, warRoomPlansPath, WARROOM_PREVIEW_REASON } from './warroom-flag.js';

export const PRODUCER = 'acq-flip-proto';
export const PRODUCER_VERSION = 'study v3 (PR #227)';

/** Every number carries one of these (WAR-ROOM-UI.md 2.3). None is calibrated today. */
export const SOURCES = Object.freeze({
  'sim.title': { label: 'Season sim, 1,200 runs', calibrated: false },
  'clone.accept': { label: 'Trade model: chance he says yes', calibrated: false },
  'clone.price': { label: 'His price (from his moves)', calibrated: false },
  'market.fc': { label: 'FantasyCalc market value', calibrated: true },
  'plan.path': { label: 'Planner, paths searched', calibrated: false },
  'coach.text': { label: 'Written by Coach, facts checked', calibrated: false },
  'eval.check': { label: 'Brain check E1-E7', calibrated: false },
  'audit.numbers': { label: 'Number check', calibrated: false },
  'campaign.plan': { label: 'Campaign planner', calibrated: false }
});

const HIDDEN = new Set(['failed', 'unknown']);
const REASONING_SLOTS = ['case_for', 'his_side', 'devils_advocate', 'news_check', 'confidence', 'counter'];
const MAX_DECK = 5;

const NOT_BUILT = {
  message: "Message not written yet: Coach's playbook (CAMPAIGN-01b) is not live.",
  walk_away: 'Walk-away price not computed yet: the concession schedule (CAMPAIGN-01b) is not built.',
  send_when: 'Send-by time not computed yet: the campaign producer does not time offers yet.',
  why: 'Reason chain not computed yet: the study run keeps its reasons in memory and drops them.',
  reasoning: 'Not computed yet: the reasoning step (REASON-01) is not built.',
  counter: 'Not planned yet: counter rules come from Coach\'s playbook (CAMPAIGN-01b).',
  silence: 'Not planned yet: the no-reply nudge comes from Coach\'s playbook (CAMPAIGN-01b).',
  decline_other: 'Not planned yet: the study run only writes a backup for its best plan.',
  goal: 'No goal set yet: objectives (CAMPAIGN-01a) are not built.',
  risk_mode: 'Risk mode not set yet: risk modes (CAMPAIGN-01d) are not built.',
  arrive_by: 'No arrive-by week yet: the speed curve (CAMPAIGN-01g) is not built.',
  eta: 'ETA not computed yet: the planned path (CAMPAIGN-01c) is not built.',
  title_now: 'Title odds now not computed yet: the study run keeps deltas only (it drops title_before).',
  title_after: 'Odds after this deal not computed yet: the study run keeps the change, not the level.',
  planned: 'Planned odds not computed yet: the planned path (CAMPAIGN-01c) is not built.',
  path: 'Planned path not computed yet (CAMPAIGN-01c).',
  ground_lost: 'Ground lost not computed yet (CAMPAIGN-01g).',
  catch_up: 'Catch-up list not computed yet: the campaign producer (CAMPAIGN-01g) is not built.',
  speed_curve: 'Speed curve not computed yet: the planner does not price deadlines yet.',
  target_gain: 'Gain if landed not computed yet: the study run computes it and drops it.',
  target_reach: 'Chance to land him not computed yet: only the chosen target keeps its best path.',
  target_owner: 'Owner not written by the study run for this target.',
  target_fit: 'Mode fit not computed yet: risk modes (CAMPAIGN-01d) are not built.',
  brain_check: 'Brain check (EVAL-01) not built yet: E1-E7 have not run.',
  number_health: 'Number check (BROKEN-01a) not built yet. Treat numbers as unchecked.',
  attention: 'League ranking ("needs you this week") is not produced yet (IDEA-007).',
  legs_not_tried: 'Legs not searched: the study only tries two fair legs for its top spreads that clear 2 SE.'
};

/* ------------------------------------------------------------------ fields */

function field(status, value, source, reason) {
  const f = { status, source, producer: PRODUCER, producer_version: PRODUCER_VERSION };
  if (!HIDDEN.has(status) && value !== undefined) f.value = value;
  if (reason) f.reason = reason;
  return f;
}
const ok = (value, source = 'plan.path') => field('ok', value, source);
const unknown = (reason, source = 'plan.path') => field('unknown', undefined, source, reason);
const failed = (reason, source = 'plan.path') => field('failed', undefined, source, reason);

/** A producer-written number, or unknown when the producer did not write one. */
function num(v, source, { se, clears, reason } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return unknown(reason ?? 'Not computed yet: the study run did not write this number.', source);
  }
  const f = ok(v, source);
  if (typeof se === 'number' && Number.isFinite(se)) f.se = se;
  if (typeof clears === 'boolean') f.clears_2se = clears;
  if (!SOURCES[source]?.calibrated) f.guess = true;
  return f;
}

/**
 * The last word on "failed and unknown carry no value": walks the whole view, drops
 * `value` from every hidden field, and (in preview) marks every field and prefixes
 * every sentence the server wrote.
 */
export function finalize(view, { preview = false } = {}) {
  const TEXT_KEYS = new Set(['reason', 'do', 'legs_why_not', 'banner', 'deck_note']);
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const isField = typeof node.status === 'string' && typeof node.producer === 'string';
    if (isField && HIDDEN.has(node.status)) delete node.value;
    if (isField && preview) node.preview = true;
    for (const [k, v] of Object.entries(node)) {
      if (preview && TEXT_KEYS.has(k) && typeof v === 'string') node[k] = previewText(v);
      else walk(v);
    }
  };
  walk(view);
  return view;
}

/* ------------------------------------------------------------- plans file */

let cache = null;

/** Test hook: forget the parsed file. */
export function __resetPlansCache() { cache = null; }

/**
 * Read the plans JSON. Returns { status: 'ok', doc, as_of, id } or a hidden state with
 * a reason. The path itself never goes into a reason (it names a home directory).
 */
export async function loadPlans(file = warRoomPlansPath()) {
  let st;
  try { st = await fs.stat(file); } catch (e) {
    if (e.code === 'ENOENT') return { status: 'unknown', reason: 'No plan has been run yet: the plans file does not exist.' };
    return { status: 'failed', reason: `The plans file could not be opened (${e.code ?? 'error'}).` };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.result;
  let result;
  try {
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    const entries = Array.isArray(doc) ? doc : Array.isArray(doc?.results) ? doc.results
      : Array.isArray(doc?.leagues) ? doc.leagues : null;
    if (!entries) result = { status: 'failed', reason: 'The plans file has no list of leagues in it.' };
    else {
      const asOf = typeof doc?.generated_at === 'string' ? doc.generated_at : new Date(st.mtimeMs).toISOString();
      result = { status: 'ok', entries, as_of: asOf, id: `plans@${Math.round(st.mtimeMs)}` };
    }
  } catch {
    result = { status: 'failed', reason: 'The plans file is not valid JSON, so every plan is hidden.' };
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, result };
  return result;
}

/* -------------------------------------------------------------- reshaping */

const team = id => `Team ${id}`;

function namer(entry) {
  const names = entry?.names && typeof entry.names === 'object' ? entry.names : {};
  const one = id => ({ id: String(id), name: names[id] ?? `Player ${id}` });
  const list = ids => (Array.isArray(ids) ? ids : []).map(one);
  const text = ids => list(ids).map(p => p.name).join(' + ');
  return { one, list, text };
}

const planKey = p => JSON.stringify((p?.steps ?? []).map(s => [s.team, s.give, s.get]));

/** The deck: the producer's alternatives if it wrote them, else the study's named plans in its order. */
function deckPlans(acq) {
  if (Array.isArray(acq?.alternatives) && acq.alternatives.length) {
    return acq.alternatives.slice(0, MAX_DECK).map((p, i) => ({ plan: p, origin: 'alternative', rank: i + 1 }));
  }
  const named = [
    ['best', 'Best plan by expected gain'], ['best_direct', 'Best one-step deal'], ['best_two', 'Best two-step path'],
    ['best_three', 'Best three-step path'], ['best_chained', 'Best path that passes a player through you'],
    ['fallback', 'Backup if the best plan\'s last step is declined']
  ];
  const seen = new Set(), out = [];
  for (const [k, label] of named) {
    const p = acq?.[k];
    if (!p || !Array.isArray(p.steps) || !p.steps.length) continue;
    const key = planKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ plan: p, origin: k, origin_label: label, rank: out.length + 1 });
    if (out.length >= MAX_DECK) break;
  }
  return out;
}

function stepLine(n, s) {
  return `${team(s.team)}: give ${n.text(s.give)} for ${n.text(s.get)}`;
}

function replies(n, plan, acq, isBest) {
  const steps = plan.steps;
  const accept = steps.length > 1
    ? ok({ kind: 'accept', do: `Send step 2 to ${stepLine(n, steps[1])}`, odds_after: num(steps[1].delta, 'sim.title', { se: steps[1].se, clears: steps[1].clears }) })
    : ok({ kind: 'accept', do: 'That completes this plan: he is yours.', odds_after: num(steps[0].delta, 'sim.title', { se: steps[0].se, clears: steps[0].clears }) });
  let decline = unknown(NOT_BUILT.decline_other);
  const fb = acq?.fallback;
  if (isBest && fb && Array.isArray(fb.steps) && fb.steps.length && planKey(fb) !== planKey(plan)) {
    const at = Math.min(Math.max(steps.length - 1, 0), fb.steps.length - 1);
    decline = ok({ kind: 'decline', do: `Switch to the backup: ${stepLine(n, fb.steps[at])}`,
      odds_after: num(fb.steps[at].delta, 'sim.title', { se: fb.steps[at].se, clears: fb.steps[at].clears }) });
  }
  return {
    accept, decline,
    counter: unknown(NOT_BUILT.counter, 'coach.text'),
    silence: unknown(NOT_BUILT.silence, 'coach.text')
  };
}

function reasoning(plan) {
  const out = {};
  for (const k of REASONING_SLOTS) {
    const v = plan?.reasoning?.[k];
    out[k] = typeof v === 'string' && v.trim() ? ok(v, 'coach.text') : unknown(NOT_BUILT.reasoning, 'coach.text');
  }
  return out;
}

function card(n, entry, d) {
  const { plan } = d, s = plan.steps[0], acq = entry.acq;
  const isBest = d.origin === 'best' || (d.origin === 'alternative' && d.rank === 1);
  const titleNow = num(acq?.title_now, 'sim.title', { reason: NOT_BUILT.title_now });
  return {
    rank: d.rank, origin: d.origin, origin_label: d.origin_label ?? `Alternative ${d.rank}`,
    step_index: 1, of_steps: plan.steps.length,
    target: plan.target != null ? n.one(plan.target) : null,
    target_owner: plan.owner != null ? team(plan.owner) : null,
    partner: String(s.team), partner_label: team(s.team),
    give: n.list(s.give), get: n.list(s.get),
    deal_line: `Offer ${team(s.team)}: ${n.text(s.give)} for ${n.text(s.get)}`,
    p_yes: num(s.p, 'clone.accept'),
    odds_effect: {
      before: titleNow,
      after: num(s.title_after, 'sim.title', { reason: NOT_BUILT.title_after }),
      delta: num(s.delta, 'sim.title', { se: s.se, clears: s.clears })
    },
    path_effect: {
      delta_final: num(plan.delta_final, 'sim.title'),
      p_complete: num(plan.p_complete, 'plan.path'),
      expected: num(plan.expected, 'plan.path', { se: plan.expected_se ?? undefined }),
      chained: typeof plan.chained === 'boolean' ? plan.chained : null
    },
    vs_finder: {
      finder_expected: num(entry.baseline?.best_expected?.expected, 'plan.path',
        { se: entry.baseline?.best_expected?.expected_se ?? undefined, reason: 'The served finder had no priced single offer in this run.' }),
      this_expected: num(plan.expected, 'plan.path', { se: plan.expected_se ?? undefined })
    },
    message: typeof plan.message === 'string' && plan.message.trim() ? ok({ text: plan.message }, 'coach.text') : unknown(NOT_BUILT.message, 'coach.text'),
    walk_away: typeof plan.walk_away === 'string' && plan.walk_away.trim() ? ok(plan.walk_away, 'coach.text') : unknown(NOT_BUILT.walk_away, 'coach.text'),
    send_when: typeof plan.send_when === 'string' && plan.send_when.trim() ? ok(plan.send_when, 'campaign.plan') : unknown(NOT_BUILT.send_when, 'campaign.plan'),
    why: unknown(NOT_BUILT.why),
    replies: replies(n, plan, acq, isBest),
    reasoning: reasoning(plan)
  };
}

function itinerary(n, best) {
  const steps = best.steps;
  const stops = steps.map((s, i) => {
    const passedOn = steps.slice(i + 1).some(later => (later.give ?? []).some(id => (s.get ?? []).includes(id)));
    return {
      id: `plan-${i + 1}`, order: i + 1, kind: passedOn ? 'flip' : 'get',
      label: passedOn
        ? `Get ${n.text(s.get)} from ${team(s.team)}, then pass him on`
        : `Get ${n.text(s.get)} from ${team(s.team)}`,
      give: n.list(s.give), get: n.list(s.get),
      status: i === 0 ? 'next' : 'waiting', added_by: 'plan',
      p_yes: num(s.p, 'clone.accept'),
      odds_after: num(s.delta, 'sim.title', { se: s.se, clears: s.clears })
    };
  });
  return ok({ target: best.target != null ? n.one(best.target) : null, stops, untouchables: [], conflicts: [] });
}

function suggestions(n, acq) {
  const list = Array.isArray(acq?.targets) ? acq.targets : [];
  const best = acq?.best;
  return ok(list.map(t => {
    const obj = t && typeof t === 'object' ? t : { id: t };
    const id = obj.id ?? obj.player;
    const isBestTarget = best && String(best.target) === String(id);
    const owner = obj.owner ?? (isBestTarget ? best.owner : null);
    return {
      player: n.one(id),
      owner: owner != null ? ok(team(owner)) : unknown(NOT_BUILT.target_owner),
      gain_if_landed: num(obj.gain, 'sim.title', { se: obj.se, reason: NOT_BUILT.target_gain }),
      p_reach: num(obj.p_complete ?? (isBestTarget ? best.p_complete : undefined), 'plan.path', { reason: NOT_BUILT.target_reach }),
      mode_fit: unknown(NOT_BUILT.target_fit, 'campaign.plan'),
      approved: false,
      is_plan_target: !!isBestTarget
    };
  }));
}

function flips(n, flip) {
  const realised = Array.isArray(flip?.realised) ? flip.realised : [];
  const key = f => `${f.player}|${f.a}|${f.b}`;
  const byKey = new Map(realised.map(f => [key(f), f]));
  return ok((Array.isArray(flip?.top) ? flip.top : []).map(f => {
    const r = byKey.get(key(f));
    const g = r?.legs ?? null;
    return {
      player: n.one(f.player), buy_from: team(f.a), sell_to: team(f.b),
      spread: num(f.spread, 'sim.title', { se: f.se, clears: f.clears }),
      price_a: num(f.price_a, 'clone.price'), price_b: num(f.price_b, 'clone.price'),
      legs: g ? {
        give_a: n.one(g.give_a), get_b: n.one(g.get_b),
        p1: num(g.p1, 'clone.accept'), p2: num(g.p2, 'clone.accept'),
        p_both: num(g.p_complete, 'clone.accept'),
        nick_after: num(g.d2, 'sim.title', { se: g.se2, clears: g.clears2 })
      } : null,
      legs_why_not: g ? null : (r?.why ?? NOT_BUILT.legs_not_tried)
    };
  }));
}

/** Every section hidden for one reason (no plan for this league, or the file is unreadable). */
function allHidden(make, reason) {
  return {
    attention: unknown(NOT_BUILT.attention, 'campaign.plan'),
    destination: destination(null),
    next_move: make(reason), itinerary: make(reason), suggestions: make(reason),
    speed_curve: unknown(NOT_BUILT.speed_curve, 'campaign.plan'),
    catch_up: unknown(NOT_BUILT.catch_up, 'campaign.plan'),
    flips: make(reason),
    brain_check: unknown(NOT_BUILT.brain_check, 'eval.check'),
    number_health: unknown(NOT_BUILT.number_health, 'audit.numbers')
  };
}

function destination(acq) {
  return {
    goal: unknown(NOT_BUILT.goal, 'campaign.plan'),
    risk_mode: unknown(NOT_BUILT.risk_mode, 'campaign.plan'),
    arrive_by: unknown(NOT_BUILT.arrive_by, 'campaign.plan'),
    eta_week: unknown(NOT_BUILT.eta, 'campaign.plan'),
    title_now: num(acq?.title_now, 'sim.title', { reason: NOT_BUILT.title_now }),
    title_planned_now: unknown(NOT_BUILT.planned, 'campaign.plan'),
    path: unknown(NOT_BUILT.path, 'campaign.plan'),
    ground_lost: unknown(NOT_BUILT.ground_lost, 'campaign.plan')
  };
}

/**
 * Pure: the view for one league from an already-loaded plans result.
 * `plans` is loadPlans()'s return; `flag` is warRoomFlag()'s.
 */
export function buildWarRoomView(leagueId, plans, flag) {
  if (!flag?.enabled) return { enabled: false };
  const base = {
    enabled: true, league_id: Number(leagueId),
    ...(flag.preview ? previewFields(WARROOM_PREVIEW_REASON) : {}),
    banner: 'These plans come from a study run, not the live engine. Every chance and every odds change is a guess until the brain check passes.',
    sources: SOURCES
  };
  if (plans.status !== 'ok') {
    const make = plans.status === 'failed' ? r => failed(r) : r => unknown(r);
    return finalize({ ...base, me: null, snapshot: null, names: {}, ...allHidden(make, plans.reason) }, flag);
  }
  const entry = plans.entries.find(e => String(e?.league) === String(leagueId));
  const snapshot = { id: plans.id, as_of: plans.as_of };
  if (!entry) {
    return finalize({ ...base, me: null, snapshot, names: {},
      ...allHidden(unknown, 'No plan has been run for this league yet.') }, flag);
  }
  const n = namer(entry);
  const view = { ...base, me: entry.me != null ? String(entry.me) : null, snapshot, names: { ...(entry.names ?? {}) },
    ...allHidden(unknown, 'Not computed yet.'), destination: destination(entry.acq) };

  if (entry.error) {
    const r = `The planner run failed for this league (${String(entry.error)}), so its plans are hidden.`;
    return finalize({ ...view, next_move: failed(r), itinerary: failed(r), suggestions: failed(r), flips: failed(r, 'sim.title') }, flag);
  }
  if (entry.sanity_composed_equals_direct === false) {
    const r = 'The study run failed its own check (its composed rescore did not match the served trade impact), so its numbers are hidden. Trust Trade Lab meanwhile.';
    return finalize({ ...view, next_move: failed(r), itinerary: failed(r), suggestions: failed(r), flips: failed(r, 'sim.title') }, flag);
  }

  const acq = entry.acq;
  if (!acq) {
    const r = 'Only the finder baseline ran for this league; the planner did not.';
    view.next_move = unknown(r); view.itinerary = unknown(r); view.suggestions = unknown(r);
  } else {
    const deck = deckPlans(acq);
    view.next_move = deck.length
      ? ok({ cards: deck.map(d => card(n, entry, d)),
        deck_note: Array.isArray(acq.alternatives) ? 'Top alternatives from the producer, best first.'
          : 'The study run\'s named plans, best first. Not yet re-checked on fresh dice.' })
      : unknown(`No path found: the planner scored ${Number.isFinite(acq.candidates_scored) ? acq.candidates_scored : 'no'} paths and none completes.`);
    view.itinerary = acq.best?.steps?.length ? itinerary(n, acq.best) : unknown('No best plan, so no stops yet.');
    view.suggestions = Array.isArray(acq.targets) && acq.targets.length ? suggestions(n, acq) : unknown('The planner wrote no targets for this league.');
  }
  view.flips = entry.flip ? flips(n, entry.flip) : unknown('The flip map did not run for this league.', 'sim.title');
  return finalize(view, flag);
}

/** The route's whole job: flag, then one cached file read, then reshape. */
export async function warRoomView(leagueId) {
  const flag = warRoomFlag();
  if (!flag.enabled) return { enabled: false };
  return buildWarRoomView(leagueId, await loadPlans(), flag);
}
