/**
 * The plans JSON the War Room reads (WAR-ROOM-UI.md sections 2-4), built from
 * planLeague's result (pure).
 *
 * File shape (what WR-1's war-room-view.js#normalisePlans accepts):
 *   { producer, producer_version, study, generated_at, labels, attention, pushes, leagues: [entry] }
 * Each entry keeps the prototype's keys (`league`, `me`, `names`, `acq`, `flip`) so
 * the WR-1 adapter reads it today, and adds `view`: every War Room section as a
 * typed field ({ status, value?, reason, producer, source, ... }). A `failed` or
 * `unknown` field never carries a value (checked by validateEntry).
 *
 * Contract extensions (additive; a reader that ignores them loses nothing):
 *   Num.unit ('title_odds' | 'playoff_odds' | 'points_per_week' | 'probability' | 'market_value')
 *   SourceId 'plan.template' (message written from engine facts by a template; Coach text pending)
 *   view.deck, view.risk_modes, view.catch_up, view.partners, view.feasibility, view.confirm
 */
import { metricKey, objectiveLabel } from './objectives.js';
import { MODE_LABELS } from './modes.js';
import { P_ACCEPT_LABEL } from './playbook.js';

export const PRODUCER = 'campaign-producer';
export const PRODUCER_VERSION = '1';
export const FIELD_STATUSES = Object.freeze(['ok', 'zero', 'thin', 'stale', 'fallback', 'unknown', 'failed']);
export const SOURCE_IDS = Object.freeze(['sim.title', 'clone.accept', 'clone.price', 'market.fc', 'plan.path',
  'coach.text', 'plan.template', 'eval.check', 'audit.numbers', 'chat.labels', 'asset.ros']);
export const PREVIEW_REASON = "Plans use today's unvalidated chance-he-says-yes model (E1 pending)";
export const SECTIONS = Object.freeze(['destination', 'next_move', 'replies', 'deck', 'itinerary', 'suggestions',
  'speed_curve', 'flips', 'brain_check', 'number_health', 'risk_modes', 'catch_up', 'partners', 'feasibility', 'confirm']);

const VALUELESS = new Set(['failed', 'unknown']);

export function field(status, value, meta) {
  const out = { status, ...meta };
  if (!VALUELESS.has(status) && value !== undefined) out.value = value;
  return out;
}

const UNIT = { title: 'title_odds', playoff: 'playoff_odds', points: 'points_per_week' };

function makeNum(unit) {
  return (value, source, extra = {}) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const out = { value, source, unit: extra.unit ?? unit, preview: true };
    if (Number.isFinite(extra.se)) out.se = extra.se;
    if (typeof extra.clears === 'boolean') out.clears_2se = extra.clears;
    if (extra.guess) out.guess = true;
    return out;
  };
}

const ids = a => (a ?? []).map(String);

/** One War Room card (NextMove shape) for plan step `i` with its playbook. */
function card(plan, pb, i, ctx) {
  const { num, nowMetric, names } = ctx;
  const st = plan.steps[i];
  const before = i === 0 ? 0 : plan.steps[i - 1].delta;
  const nm = id => names[String(id)] ?? `player ${id}`;
  const why = [
    { text: `If he says yes you move ${((st.delta - before) * (ctx.unit === 'points_per_week' ? 1 : 100)).toFixed(1)} ${ctx.unit === 'points_per_week' ? 'pts a week' : 'pts of title odds'}.`,
      delta: num(st.delta - before, 'sim.title', { se: st.se, clears: st.clears }), source: 'sim.title' },
    { text: `Chance he says yes: ${(st.p * 100).toFixed(0)}% (${P_ACCEPT_LABEL}).`, source: 'clone.accept' },
  ];
  if (plan.confirm) why.push({ text: `Re-checked on fresh dice: ${plan.confirm.verdict}.`, source: 'sim.title' });
  if (pb?.wait?.flag === 'wait') why.push({ text: `Wait ${pb.wait.days} days: ${pb.wait.reason}.`, source: 'plan.path' });
  return {
    step_index: i, of_steps: plan.steps.length, partner: String(st.team), give: ids(st.give), get: ids(st.get),
    target: plan.target != null ? String(plan.target) : null,
    message: pb?.message ? { text: pb.message.text, source: 'plan.template', checked: pb.message.checked, facts: pb.message.facts } : null,
    opening: pb?.opening ? { give: ids(pb.opening.give), p_yes: num(pb.opening.p, 'clone.accept', { guess: true, unit: 'probability' }) } : null,
    p_yes: num(st.p, 'clone.accept', { guess: true, unit: 'probability' }),
    odds_effect: {
      before: num(nowMetric + before, 'sim.title'),
      after: num(nowMetric + st.delta, 'sim.title'),
      delta: num(st.delta - before, 'sim.title', { se: st.se, clears: st.clears }),
    },
    path_effect: {
      delta_final: num(plan.delta_final, 'plan.path'),
      p_complete: plan.p_complete,
      expected: num(plan.expected, 'plan.path', { se: plan.expected_se ?? undefined }),
    },
    walk_away: pb?.walk_away ? { text: pb.walk_away.text, max_give: ids(pb.walk_away.give) } : null,
    send_when: pb?.send_when ? (pb.send_when.when === 'wait' ? `after ${pb.send_when.until}: ${pb.send_when.why}` : `now: ${pb.send_when.why}`) : null,
    wait: pb?.wait ?? null,
    why, vs_finder: null, sent: null,
    confirm: plan.confirm ?? null,
    label: `Offer Team ${st.team}: ${st.give.map(nm).join(' + ')} for ${st.get.map(nm).join(' + ')}`,
  };
}

/**
 * res: planLeague result. ctx: { names, as_of, previous (last entry), changed ({changed, reason}) }
 */
export function toEntry(res, { names = {}, as_of, previous = null, changed = null } = {}) {
  const meta = { producer: PRODUCER, producer_version: PRODUCER_VERSION, as_of, preview: true, preview_reason: PREVIEW_REASON };
  const src = s => ({ ...meta, source: s });
  if (res.error) {
    const failed = field('failed', undefined, { ...src('plan.path'),
      reason: `The planner run for this league failed (${res.error}), so no move is shown. Trust the Trade Lab finder meanwhile.` });
    return { league: res.league, me: res.me, as_of, error: res.error, names,
      view: Object.fromEntries(SECTIONS.map(k => [k, failed])), changed };
  }
  const o = res.objective;
  const unit = UNIT[metricKey(o)];
  const num = makeNum(unit);
  const nowMetric = res.now.metric;
  const ctx = { num, nowMetric, names, unit };
  const unknown = (reason, s = 'plan.path') => field('unknown', undefined, { ...src(s), reason });

  const best = res.best;
  const deckCards = res.deck.map(c => card(c.plan, c.playbook, 0, ctx));
  const next_move = best ? field('ok', deckCards[0], src('plan.path'))
    : unknown(res.candidates_scored ? 'No path clears the sliders and the fresh-dice check this week. Try another target or risk mode.'
      : 'The planner found no trade path worth sending this week.');

  const pb0 = res.playbook[0];
  const replies = best && pb0 ? field('ok', pb0.replies.map(r => ({ ...r,
    next: r.next ? { partner: String(r.next.partner), give: ids(r.next.give), get: ids(r.next.get) } : undefined,
    odds_after: r.expected_after != null ? num(nowMetric + r.expected_after, 'plan.path') : undefined,
    walk_away_give: r.walk_away_give ? ids(r.walk_away_give) : undefined,
    next_rung_give: r.next_rung_give ? ids(r.next_rung_give) : undefined,
  })), src('plan.path')) : unknown('No move, so no replies to plan.');

  const prevTraj = previous?.trajectory ?? null;
  const plannedNow = prevTraj?.find(p => p.week === res.week)?.planned ?? null;
  const arrive = res.speed[0]?.arrive_by ?? res.week;
  const trajectory = best ? [{ week: res.week, planned: nowMetric }, { week: Math.max(arrive, res.week + 1), planned: nowMetric + best.expected }]
    : [{ week: res.week, planned: nowMetric }];
  const firstCatch = res.catch_up[0] ?? null;
  const destination = field('ok', {
    goal: { kind: o.kind === 'player' ? o.goal : o.kind, label: objectiveLabel(o, names), target: o.target,
      points_per_week: o.points_per_week ?? undefined },
    risk_mode: o.risk_mode, risk_label: MODE_LABELS[o.risk_mode], arrive_by: o.arrive_by ?? undefined,
    tolerances: res.tolerances,
    title_now: num(res.now.title, 'sim.title', { unit: 'title_odds' }),
    metric_now: num(nowMetric, 'sim.title'),
    title_planned_now: num(plannedNow ?? nowMetric, 'plan.path'),
    path: (prevTraj ?? trajectory).map(p => ({ week: p.week, planned: p.planned, ...(p.week === res.week ? { actual: nowMetric } : {}) })),
    ground_lost: plannedNow != null ? num(plannedNow - nowMetric, 'plan.path') : null,
    catch_up: firstCatch ? { text: firstCatch.text, gain: num(firstCatch.gain, 'plan.path'), steps: 1 } : null,
    behind: res.behind, deadline_week: res.deadline_week,
  }, src('sim.title'));

  const itinerary = field('ok', { ...res.itinerary,
    stops: res.itinerary.stops.map(s => ({ ...s, p_yes: num(s.p_yes, 'clone.accept', { guess: true, unit: 'probability' }) ?? undefined,
      odds_after: num(s.odds_after != null ? nowMetric + s.odds_after : null, 'sim.title') ?? undefined })),
    stop_previews: res.stop_previews.map(p => ({ ...p,
      ...(Number.isFinite(p.cost) ? { cost: num(p.cost, 'plan.path'), gain: num(p.gain, 'plan.path'), net: num(p.net, 'plan.path') } : {}) })),
  }, src('plan.path'));

  const suggestions = res.suggestions.length ? field('ok', res.suggestions.map(t => ({
    player: String(t.player), owner: String(t.owner),
    gain_if_landed: num(t.gain_if_landed, 'sim.title', { se: t.gain_se ?? undefined }),
    p_reach: num(t.p_reach, 'plan.path', { guess: true, unit: 'probability' }),
    expected: num(t.expected, 'plan.path'),
    mode_fit: t.mode_fit, why: t.why, approved: t.approved, skipped: t.skipped,
    ...(t.reason_chain ? { reason_chain: t.reason_chain } : {}),
  })), src('plan.path')) : unknown('No single-player upgrade found on the other rosters.');

  const speed_curve = res.speed.length ? field('ok', res.speed.map(s => ({
    arrive_by: s.arrive_by, cost: num(s.cost, 'plan.path'), net: num(s.net, 'plan.path'),
    variance_note: s.variance_note, offers_used: s.offers_used, parallel: s.parallel, before_deadline: s.before_deadline,
    first_step: { partner: String(s.first_step.team), give: ids(s.first_step.give), get: ids(s.first_step.get) },
  })), src('plan.path')) : unknown('No plan to put on a clock.');

  const tNum = makeNum('title_odds');
  const flips = field('ok', res.flip.top.map(f => {
    const r = res.flip.realised.find(x => x.player === f.player && x.a === f.a && x.b === f.b);
    return {
      player: String(f.player), buy_from: String(f.a), sell_to: String(f.b),
      spread: tNum(f.spread, 'sim.title', { se: f.se, clears: f.clears }),
      price_a: tNum(f.price_a, 'clone.price', { unit: 'market_value' }), price_b: tNum(f.price_b, 'clone.price', { unit: 'market_value' }),
      chat_hint: f.chat_hint ? 'from chat: one side is louder about him' : null,
      legs: r?.legs ? { give_a: String(r.legs.give_a), get_b: String(r.legs.get_b),
        p1: tNum(r.legs.p1, 'clone.accept', { guess: true, unit: 'probability' }), p2: tNum(r.legs.p2, 'clone.accept', { guess: true, unit: 'probability' }),
        p_both: r.legs.p_complete, nick_after: tNum(r.legs.d2, 'sim.title', { se: r.legs.se2, clears: r.legs.clears2 }) } : null,
      ...(r && !r.legs ? { legs_why_not: r.why } : {}),
    };
  }), { ...src('sim.title'), n: res.flip.pairs });

  const brain_check = field('ok', {
    overall: 'not_enough_data',
    checks: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'].map(id => ({ id, status: 'not_run' })),
    blocks: ['Until E1 passes, every "chance he says yes" is a guess.', "All-in mode uses no testing-tier signals (none pass yet)."],
  }, { ...src('eval.check'), producer: 'eval-01', producer_version: 'not-built' });
  const number_health = field('unknown', undefined, { ...src('audit.numbers'), producer: 'broken-01a', producer_version: 'not-built',
    reason: 'Number check not built yet.' });

  const risk_modes = field('ok', res.risk_modes.map(m => ({ ...m,
    expected: num(m.expected, 'plan.path'), if_complete: num(m.if_complete, 'plan.path'),
    p_complete: m.p_complete, first_step: m.first_step ? { partner: String(m.first_step.team), give: ids(m.first_step.give), get: ids(m.first_step.get) } : null,
    active: m.mode === o.risk_mode })), src('plan.path'));
  const catch_up = field(res.catch_up.length ? 'ok' : 'zero', res.catch_up.map(c => ({ rank: c.rank, kind: c.kind, text: c.text,
    gain: num(c.gain, 'plan.path') })), src('plan.path'));
  const partners = field('ok', res.partners.map(p => ({ team: p.team, p_responds: p.p_responds, basis: p.basis,
    edge: num(p.edge, 'plan.path'), score: p.score, shadow_score: p.shadow_score, chat: p.chat,
    checked_out: p.checked_out, blocked: p.blocked,
    ...(p.reason_chain ? { p_responds_before_counterpart: p.p_responds_before_counterpart, reason_chain: p.reason_chain } : {}) })),
  { ...src('chat.labels'), reason: res.counterpart ? 'counterpart model on (GRIDIRON_COUNTERPART): activity x edge, adjusted by named counterpart features'
    : 'chat labels run in shadow; ranking uses activity x edge' });
  const feasibility = res.feasibility ? field('ok', res.feasibility, src('sim.title'))
    : res.outlook ? field('ok', { kind: 'outlook', season_mean: res.outlook.season_mean, per_week: res.outlook.per_week.map(w => ({ week: w.week, mean: w.mean })) }, src('sim.title'))
      : unknown('The weekly points outlook was not computed.', 'sim.title');
  const confirm = field(res.confirm.status === 'ok' ? 'ok' : 'failed', res.confirm.status === 'ok' ? {
    plan_seed: res.confirm.plan_seed, confirm_seed: res.confirm.seed,
    cards: res.deck.map(c => c.confirm),
  } : undefined, { ...src('sim.title'), reason: res.confirm.status === 'ok' ? 'numbers shown are the fresh-dice ones' : res.confirm.reason });

  const view = { destination, next_move, replies,
    deck: deckCards.length ? field('ok', deckCards, src('plan.path')) : unknown('No alternatives cleared the sliders.'),
    itinerary, suggestions, speed_curve, flips, brain_check, number_health, risk_modes, catch_up, partners, feasibility, confirm };

  // Prototype-compatible keys (WR-1 reads acq.best / acq.fallback / acq.title_now / flip).
  const acq = { targets: ids(res.targets), candidates_scored: res.candidates_scored, title_now: nowMetric,
    best: best, fallback: res.deck[1]?.plan ?? null, alternatives: res.deck.slice(1).map(c => c.plan) };
  return {
    league: res.league, me: String(res.me), as_of, names, seed: res.seed, confirm_seed: res.confirm.seed,
    week: res.week, deadline_week: res.deadline_week,
    objective: { ...o, tolerances: res.tolerances }, next_step: best ? best.steps[0] : null,
    objective_version: o.version, risk_mode: o.risk_mode, trajectory: prevTraj ?? trajectory,
    acq, flip: { pairs: res.flip.pairs, clears: res.flip.clears, top: res.flip.top, realised: res.flip.realised },
    view, changed, ...(res.counterpart ? { counterpart: res.counterpart } : {}), rescores: res.rescores, runtime_ms: res.runtime_ms, phases_ms: res.phases_ms,
  };
}

/** Contract check for one entry. Returns a list of problems (empty = matches WAR-ROOM-UI). */
export function validateEntry(entry) {
  const errs = [];
  if (entry.league == null) errs.push('entry.league missing');
  if (!entry.view || typeof entry.view !== 'object') return [...errs, 'entry.view missing'];
  const walk = (node, where) => {
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    if ('status' in node && FIELD_STATUSES.includes(node.status) && node.producer) {
      if (VALUELESS.has(node.status) && 'value' in node) errs.push(`${where}: ${node.status} field carries a value`);
      if (VALUELESS.has(node.status) && !node.reason) errs.push(`${where}: ${node.status} field has no reason`);
      if (!SOURCE_IDS.includes(node.source)) errs.push(`${where}: unknown source ${node.source}`);
    }
    if ('value' in node && 'source' in node && 'unit' in node) {
      if (typeof node.value !== 'number' || !Number.isFinite(node.value)) errs.push(`${where}: Num value not finite`);
      if (!SOURCE_IDS.includes(node.source)) errs.push(`${where}: Num has unknown source ${node.source}`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  for (const s of SECTIONS) {
    const f = entry.view[s];
    if (!f) { errs.push(`view.${s} missing`); continue; }
    if (!FIELD_STATUSES.includes(f.status)) errs.push(`view.${s}: bad status ${f.status}`);
    if (!f.producer || !f.producer_version) errs.push(`view.${s}: producer missing`);
  }
  walk(entry.view, 'view');
  const nm = entry.view.next_move;
  if (nm?.status === 'ok') {
    const v = nm.value;
    for (const k of ['step_index', 'of_steps', 'partner', 'give', 'get', 'p_yes', 'odds_effect', 'path_effect', 'why']) {
      if (!(k in v)) errs.push(`next_move.value.${k} missing`);
    }
    if (!Array.isArray(v.give) || v.give.some(x => typeof x !== 'string')) errs.push('next_move.value.give must be string ids');
  }
  const rp = entry.view.replies;
  if (rp?.status === 'ok') {
    const kinds = rp.value.map(r => r.kind).sort().join(',');
    if (kinds !== 'accept,counter,decline,silence') errs.push(`replies must cover accept/decline/counter/silence, got ${kinds}`);
  }
  const d = entry.view.destination;
  if (d?.status === 'ok') {
    if (!['title', 'playoffs', 'points'].includes(d.value.goal?.kind)) errs.push('destination.goal.kind invalid');
    if (!['safe', 'balanced', 'all_in'].includes(d.value.risk_mode)) errs.push('destination.risk_mode invalid');
  }
  return errs;
}

/** The whole file. */
export function plansFile(entries, { generated_at, attention = [], pushes = [] } = {}) {
  return {
    producer: PRODUCER, producer_version: PRODUCER_VERSION, study: true, generated_at,
    labels: { p_accept: P_ACCEPT_LABEL, preview_reason: PREVIEW_REASON },
    attention, pushes, leagues: entries,
  };
}
