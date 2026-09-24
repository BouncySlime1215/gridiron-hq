/**
 * The War Room plans file, built from planLeague's result (pure). FIX-03: it
 * writes the shared contract (plans-schema.js, `warroom-plans/1`) and nothing
 * else, so the War Room view (#231), Coach (#230) and REASON-01 (#234) read one
 * shape.
 *
 * File:   { schema, generated_at, producer, producer_version, leagues: [entry] }
 * Entry:  { league, me, names, sanity_composed_equals_direct?, _run, ...SECTIONS }
 *         or, when the run failed, exactly { league, me, names, error }.
 * Every section, and every number inside one, is a typed field
 * ({ status: ok | unknown | failed, value?, reason?, source, se?, clears_2se?, n?, unit?, guess? }).
 * A number that is not finite is written `unknown` with its reason, never null
 * or 0. `_run` is the producer's own bookkeeping (seeds, trajectory, the
 * change diff); no consumer reads it.
 *
 * Text built here (messages, reasoning panels) states engine facts only and is
 * sourced 'plan.template'. REASON-01 (FIX-08) replaces the reasoning panels
 * with its own when its gates are on.
 */
import { versionWithFlags } from './model-flags.js';
import { SCHEMA_VERSION, TOLERANCE_KEYS, TRADEOFF_KEY, tradeoffKey } from './plans-schema.js';
import { metricKey, objectiveLabel } from './objectives.js';
import { MODE_LABELS } from './modes.js';
import { P_ACCEPT_LABEL } from './playbook.js';
import { dealKey } from './paths.js';
import { hash } from './confirm.js';

/** The acceptance-model bases trade_outcomes accepts (migration 067 CHECK on model_basis). */
const BAND_BASES = ['no_information', 'heuristic_unanchored', 'heuristic_anchored'];

export const PRODUCER = 'campaign-producer';
export const PRODUCER_VERSION = '2';

const UNIT = { title: 'title_odds', playoff: 'playoff_odds', points: 'points_per_week' };
const LABEL = { title: 'title odds', playoff: 'playoff odds', points: 'points a week' };
const PLAYBOOK_LATER = "This step's playbook is written when the step before it lands (the producer replans on every refresh).";
const PLAYBOOK_FIRST_ONLY = "The playbook is built for this card's first offer; later steps get theirs if this card becomes the plan.";

const ids = a => (a ?? []).map(String);
const fin = v => typeof v === 'number' && Number.isFinite(v);
const isProb = v => fin(v) && v >= 0 && v <= 1;
const week = v => (Number.isInteger(v) && v >= 1 && v <= 18 ? v : null);
const pct = p => `${Math.round(p * 100)}%`;
const signed = x => `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`;

const ok = (value, source, meta = {}) => ({ status: 'ok', value, source, ...meta });
const unknown = (reason, source) => ({ status: 'unknown', source, reason });

/** A number as a typed field: ok when finite (and inside 0..1 for a probability), else unknown with the reason. */
function num(value, source, { se, clears, unit, guess, n, prob = false, missing = 'Not computed for this league.' } = {}) {
  if (!fin(value)) return unknown(missing, source);
  if (prob && !isProb(value)) return unknown('The computed value fell outside 0 to 1, so it is not shown.', source);
  const out = ok(value, source);
  if (fin(se) && se >= 0) out.se = se;
  if (typeof clears === 'boolean') out.clears_2se = clears;
  if (unit) out.unit = unit;
  if (guess) out.guess = true;
  if (Number.isInteger(n) && n >= 0) out.n = n;
  return out;
}

/** A deck card's id: stable across refreshes while the plan's steps are the same. */
export function moveId(league, plan) {
  return `L${league}-${hash(league, plan.target ?? '', ...plan.steps.map(dealKey)).toString(36)}`;
}

/** The contract's failed-run shape: nothing but the error. */
export function failedEntry(res, { names = {} } = {}) {
  return { league: res.league, me: res.me != null ? String(res.me) : 'unknown', names, error: String(res.error) };
}

/**
 * res: planLeague result. ctx: { names, as_of, previous (last entry), changed (diffNextMove result),
 *   brain (brain-gate.js#applyBrainReport result), number_health (brain-gate.js#readNumberHealth result) }
 * FIX-05: without `brain` / `number_health` the two sections are 'unknown' and say they were not read.
 */
export function toEntry(res, { names = {}, as_of, previous = null, changed = null, brain = null, number_health: health = null } = {}) {
  if (res.error) return failedEntry(res, { names });
  const o = res.objective;
  const metric = metricKey(o);
  const unit = UNIT[metric];
  const fmt = x => (metric === 'points' ? `${x.toFixed(1)} pts a week` : `${(x * 100).toFixed(1)} pts of ${LABEL[metric]}`);
  const nowMetric = res.now.metric;
  const nm = id => names[String(id)] ?? `player ${id}`;
  const list = a => a.map(nm).join(' + ');
  const inNames = id => id != null && Object.hasOwn(names, String(id));
  const needsOf = team => (res.partners.find(p => p.team === String(team))?.needs ?? []);

  /* ---------------------------------------------------------- the deck */
  const deck = res.deck;
  const moveIds = deck.map(c => moveId(res.league, c.plan));
  const idByFirstKey = new Map(deck.map((c, j) => [dealKey(c.plan.steps[0]), moveIds[j]]));

  const reasoning = ({ team, p, delta, clears, pb, verdict, whole }) => {
    const needs = needsOf(team);
    const shrank = verdict?.verdict === 'shrank';
    return ok({
      case_for: whole ?? `If Team ${team} says yes you move ${fmt(delta)}.`,
      his_side: (needs.length ? `Team ${team}'s roster read lists ${needs.join(', ')} as thin, and the offer is built on it.`
        : `There is no read of Team ${team}'s needs, so the offer leans on market value alone.`)
        + (pb?.nick_shift ? ` ${pb.nick_shift.text}` : ''), // FIX-02c: Nick's read shifts the price (hand-set)
      devils_advocate: shrank ? `On fresh dice the plan shrank by ${fmt(verdict.shrink)}: the first read was lucky.`
        : clears === false ? 'The gain does not clear two standard errors of simulation noise.'
          : verdict?.verdict === 'holds' ? 'The gain clears the noise and held on fresh dice; the weak link is whether he says yes.'
            : 'The gain clears the noise but was not re-checked on fresh dice.',
      news_check: pb?.wait ? (pb.wait.flag === 'wait' ? `Wait ${pb.wait.days} days: ${pb.wait.reason}.` : `Act now: ${pb.wait.reason}.`)
        : 'Not checked: this offer has no playbook yet.',
      confidence: `Chance he says yes is ${pct(p)}, from ${P_ACCEPT_LABEL}.`,
      counter: (() => {
        const row = pb?.replies?.find(r => r.kind === 'counter');
        return row?.counter_rules ? `If he counters, counter with ${row.counter_rules.counter_with}.` : row?.do ?? 'No counter plan: decline any counter that adds players on your side.';
      })(),
      cites: ['steps[0].p_yes', 'steps[0].title_odds_delta'],
      check_first: clears === false || shrank,
    }, 'plan.template');
  };

  const replyField = (row, build) => (row ? ok(build(row), 'plan.path') : unknown('No reply row was planned.', 'plan.path'));

  /** One offer. pb: its playbook (null when the step has none yet); backupId: the deck card a decline switches to. */
  const step = (plan, i, pb, { thisId, backupId, verdict, laterReason }) => {
    const st = plan.steps[i];
    const before = i === 0 ? 0 : plan.steps[i - 1].delta;
    const out = {
      partner: String(st.team), give: ids(st.give), get: ids(st.get),
      p_yes: num(st.p, 'clone.accept', { prob: true, unit: 'probability', guess: true }),
      title_odds_delta: num(st.delta - before, 'sim.title', { se: st.se, clears: st.clears, unit }),
      title_after: metric === 'title' ? num(nowMetric + st.delta, 'sim.title', { prob: true, unit: 'title_odds' })
        : unknown(`This plan is scored on ${LABEL[metric]}; title odds after the step are not computed.`, 'sim.title'),
    };
    const later = unknown(laterReason, 'plan.path');
    if (!pb) {
      Object.assign(out, { message: later, opening: later, walk_away: later, send_when: later, reply_table: later });
    } else {
      out.message = pb.message ? ok(pb.message.text, 'plan.template') : unknown('No message was written for this step.', 'plan.template');
      out.opening = pb.opening
        ? ok({ give: ids(pb.opening.give), get: ids(st.get),
          text: `Open with ${list(pb.opening.give)} for ${list(st.get)} (his screen ${signed(pb.opening.his_pct)}).` }, 'clone.price')
        : unknown(`No opening price: ${pb.ladder?.reason ?? 'the ladder is empty'}.`, 'clone.price');
      out.walk_away = pb.walk_away ? ok({ text: pb.walk_away.text, max_give: ids(pb.walk_away.give) }, 'clone.price')
        : unknown(`No walk-away: ${pb.ladder?.reason ?? 'the ladder is empty'}.`, 'clone.price');
      out.send_when = pb.send_when
        ? ok(pb.send_when.when === 'wait' ? `After ${pb.send_when.until}: ${pb.send_when.why}.` : `Now: ${pb.send_when.why}.`, 'plan.path')
        : unknown("No timing read for this manager.", 'plan.path');
      const row = kind => pb.replies.find(r => r.kind === kind);
      out.reply_table = ok({
        accept: replyField(row('accept'), r => ({ do: r.do,
          ...(r.next ? { move_id: thisId } : {}),
          odds_after: num(nowMetric + st.delta, 'sim.title', { unit, se: st.se, clears: st.clears }) })),
        decline: replyField(row('decline'), r => ({ do: r.do,
          ...(backupId ? { move_id: backupId } : {}),
          ...(fin(r.expected_after) ? { odds_after: num(nowMetric + r.expected_after, 'plan.path', { unit }) } : {}) })),
        counter: replyField(row('counter'), r => ({ do: r.do, ...(r.counter_rules ? { counter_rules: r.counter_rules } : {}) })),
        silence: replyField(row('silence'), r => ({ do: r.do, when: r.when, message: r.message })),
      }, 'plan.path');
      out.reasoning = reasoning({ team: st.team, p: st.p, delta: st.delta - before, clears: st.clears, pb, verdict });
    }
    if (st.band && isProb(st.band.low) && isProb(st.band.high)) {
      out.p_yes_band = { low: st.band.low, high: st.band.high };
      // The acceptance model's own basis (trade-acceptance.js): the offer ledger refuses a band without one.
      if (BAND_BASES.includes(st.band.basis)) out.p_yes_band.basis = st.band.basis;
    }
    return out;
  };

  const moves = deck.map((c, j) => {
    const plan = c.plan;
    const thisId = moveIds[j];
    const steps = plan.steps.map((_, i) => {
      if (j === 0) {
        const backup = i === 0 ? moveIds[1] ?? null : null;
        return step(plan, i, res.playbook[i] ?? null, { thisId, backupId: backup, verdict: c.confirm, laterReason: PLAYBOOK_LATER });
      }
      return step(plan, i, i === 0 ? c.playbook : null, { thisId, backupId: i === 0 ? moveIds[j + 1] ?? null : null,
        verdict: c.confirm, laterReason: PLAYBOOK_FIRST_ONLY });
    });
    const s0 = plan.steps[0];
    return {
      move_id: thisId, rank: j + 1,
      target: plan.target != null ? String(plan.target) : null,
      target_owner: plan.owner != null ? String(plan.owner) : null,
      chained: !!plan.chained, steps,
      p_complete: num(plan.p_complete, 'plan.path', { prob: true, unit: 'probability', guess: true }),
      delta_final: num(plan.delta_final, 'sim.title', { unit }),
      expected: num(plan.expected, 'plan.path', { se: plan.expected_se, unit }),
      reasoning: reasoning({ team: s0.team, p: s0.p, delta: s0.delta, clears: s0.clears, pb: c.playbook, verdict: c.confirm,
        whole: `If all ${plan.steps.length} step(s) land you gain ${fmt(plan.delta_final)}; across yes and no outcomes that is ${fmt(plan.expected)} expected, and the path completes ${pct(plan.p_complete)} of the time.` }),
    };
  });
  const best = moves[0] ?? null;
  const alternatives = ok(moves, 'plan.path');
  const next_move = best ? ok(best, 'plan.path')
    : unknown(res.candidates_scored ? `None of the ${res.candidates_scored} paths searched clears the sliders and the fresh-dice check this week. Try another target or risk mode.`
      : 'The planner found no trade path worth sending this week.', 'plan.path');

  /* ------------------------------------------------------- destination */
  const prevTraj = previous?._run?.trajectory ?? null;
  const plannedNow = prevTraj?.find(p => p.week === res.week)?.planned ?? null;
  const w = week(res.week);
  const trajectory = !w ? [] : res.best
    ? [{ week: w, planned: nowMetric }, { week: Math.min(18, Math.max(res.speed[0]?.arrive_by ?? w, w + 1)), planned: nowMetric + res.best.expected }]
    : [{ week: w, planned: nowMetric }];
  const path = (prevTraj ?? trajectory).map(p => ({ week: p.week, planned: p.planned, ...(p.week === w ? { actual: nowMetric } : {}) }));
  const goal = o.kind === 'player' ? { kind: 'get_player', label: objectiveLabel(o, names), ...(inNames(o.target) ? { player_id: String(o.target) } : {}) }
    : o.kind === 'points' ? { kind: 'points', label: objectiveLabel(o, names), points_per_week: o.points_per_week }
      : { kind: o.goal === 'playoffs' ? 'playoffs' : 'title', label: objectiveLabel(o, names) };
  const tolerances = Object.fromEntries(TOLERANCE_KEYS.filter(k => fin(res.tolerances?.[k])).map(k => [k, res.tolerances[k]]));
  const destination = ok({
    goal: ok(goal, 'campaign.plan'),
    risk_mode: ok({ mode: o.risk_mode, ...(week(o.risk_until_week) ? { until_week: o.risk_until_week } : {}) }, 'campaign.plan'),
    tolerances: ok(tolerances, 'campaign.plan'),
    arrive_by: week(o.arrive_by) ? ok(o.arrive_by, 'campaign.plan') : unknown('No arrive-by week is set.', 'campaign.plan'),
    eta_week: week(res.eta_week) ? ok(res.eta_week, 'plan.path') : unknown('No plan, so no arrival week.', 'plan.path'),
    title_now: num(res.now.title, 'sim.title', { prob: true, unit: 'title_odds' }),
    title_planned_now: metric !== 'title' ? unknown(`The plan is tracked in ${LABEL[metric]}, not title odds.`, 'plan.path')
      : num(plannedNow ?? nowMetric, 'plan.path', { prob: true, unit: 'title_odds' }),
    path: path.length ? ok(path, 'plan.path') : unknown('The current week is unknown, so there is no path.', 'plan.path'),
    ground_lost: plannedNow != null ? num(plannedNow - nowMetric, 'plan.path', { unit })
      : unknown('No earlier plan for this week to compare with.', 'plan.path'),
  }, 'campaign.plan');

  /* --------------------------------------------------------- itinerary */
  const itin = res.itinerary;
  const stops = itin.stops.map((s, k) => {
    const out = { id: s.id, order: k + 1, kind: s.kind, label: s.label || s.kind, status: s.status, added_by: s.added_by };
    const pi = /^plan-(\d+)$/.exec(s.id);
    if (pi && res.best) {
      const i = Number(pi[1]), st = res.best.steps[i], before = i === 0 ? 0 : res.best.steps[i - 1].delta;
      if (st.get.length === 1) out.player_id = String(st.get[0]);
      out.move_id = moveIds[0];
      out.p_yes = num(st.p, 'clone.accept', { prob: true, unit: 'probability', guess: true });
      out.title_odds_delta = num(st.delta - before, 'sim.title', { se: st.se, clears: st.clears, unit });
    }
    const ni = /^nick-(\d+)$/.exec(s.id);
    if (ni) {
      const src = o.stops[Number(ni[1])] ?? {};
      if (inNames(src.player)) out.player_id = String(src.player);
      if (week(src.week)) out.week = src.week;
    }
    return out;
  });
  const itinerary = ok({
    version: Math.max(1, itin.version ?? 0), stops,
    stops_left: stops.filter(s => !['done', 'dropped'].includes(s.status)).length,
    untouchables: ids(itin.untouchables).filter(inNames), conflicts: itin.conflicts.map(c => ({ text: c.text })),
  }, 'plan.path');

  /* ---------------------------------------------------- stop trade-offs */
  const tradeoffs = {};
  const verdictOf = (net, se) => (Math.abs(net) <= (se ?? 0) ? 'close' : net >= 0 ? 'worth_it' : 'not_worth_it');
  const row = t => ({
    stop_label: t.stop_label, cost: num(t.cost, 'plan.path', { unit }), extra_steps: Math.max(0, t.extra_steps),
    gain: num(t.gain, 'plan.path', { unit }), net: num(t.net, 'plan.path', { unit }), verdict: t.verdict,
    because: t.because, new_next_move_changes: !!t.new_next_move_changes, ...(t.gain_text ? { gain_text: t.gain_text } : {}),
  });
  res.stop_previews.forEach((p, j) => {
    const st = o.stops[j];
    if (!st || !fin(p.cost) || !fin(p.net)) return;
    const key = tradeoffKey({ type: 'add_stop', stop: { kind: st.kind, player_id: st.player != null ? String(st.player) : undefined,
      week: st.week, label: st.label ?? p.stop_label } });
    if (TRADEOFF_KEY.test(key)) tradeoffs[key] = row(p);
  });
  const cur = res.risk_modes.find(m => m.mode === o.risk_mode);
  for (const m of res.risk_modes) {
    if (m.mode === o.risk_mode || !cur || !fin(cur.expected) || !fin(m.expected)) continue;
    const cost = cur.expected - m.expected;
    const verdict = verdictOf(-cost, res.best?.expected_se);
    tradeoffs[tradeoffKey({ type: 'set_risk_mode', mode: m.mode })] = row({
      stop_label: `Switch to ${MODE_LABELS[m.mode]}`, cost, extra_steps: (m.steps ?? 0) - (cur.steps ?? 0), gain: 0, net: -cost, verdict,
      because: verdict === 'close' ? 'the difference in expected gain is inside the simulation noise'
        : verdict === 'worth_it' ? 'it raises the expected gain' : 'it gives up expected gain',
      new_next_move_changes: dealKey(m.first_step) !== dealKey(cur.first_step),
      gain_text: fin(m.if_complete) && fin(cur.if_complete)
        ? `If it lands: ${fmt(m.if_complete)} against ${fmt(cur.if_complete)}; it lands ${pct(m.p_complete)} of the time against ${pct(cur.p_complete)}.` : '',
    });
  }
  const stop_tradeoffs = Object.keys(tradeoffs).length ? ok(tradeoffs, 'plan.path')
    : unknown('No stop or mode change could be priced this week.', 'plan.path');

  /* ------------------------------------------------ targets and flips */
  const bestTarget = res.best?.target != null ? String(res.best.target) : null;
  const targetList = res.suggestions.filter(t => t.owner != null && inNames(t.player)).map(t => ({
    player: String(t.player), owner: String(t.owner),
    gain_if_landed: num(t.gain_if_landed, 'sim.title', { se: t.gain_se, unit }),
    p_reach: num(t.p_reach, 'plan.path', { prob: true, unit: 'probability', guess: true, missing: 'No path to him fits any risk mode yet.' }),
    mode_fit: ok(t.mode_fit, 'plan.path'), why: ok(t.why, 'plan.template'),
    approved: !!t.approved, is_plan_target: bestTarget === String(t.player),
    reasoning: ok({
      case_for: t.why,
      his_side: needsOf(t.owner).length ? `Team ${t.owner}'s roster read lists ${needsOf(t.owner).join(', ')} as thin.` : `There is no read of Team ${t.owner}'s needs.`,
      devils_advocate: t.mode_fit === 'fits' ? 'A path fits the current risk mode; landing him still takes every step saying yes.'
        : t.mode_fit === 'needs_all_in' ? 'Only an all-in plan reaches him.' : 'No plan inside the sliders reaches him.',
      news_check: 'Not checked for targets: the news read runs on the offers in a plan.',
      confidence: fin(t.p_reach) ? `The path lands ${pct(t.p_reach)} of the time, on ${P_ACCEPT_LABEL}.` : 'No path, so no landing chance.',
      counter: 'No offer yet, so no counter plan.',
      cites: ['gain_if_landed', 'p_reach'], check_first: t.mode_fit !== 'fits',
    }, 'plan.template'),
  }));
  const targets = targetList.length ? ok(targetList, 'plan.path') : unknown('No single-player upgrade found on the other rosters.', 'plan.path');

  const flip_map = ok(res.flip.top.map(f => {
    const r = res.flip.realised.find(x => x.player === f.player && x.a === f.a && x.b === f.b);
    const out = {
      player: String(f.player), buy_from: String(f.a), sell_to: String(f.b),
      spread: num(f.spread, 'sim.title', { se: f.se, clears: f.clears, unit: 'title_odds' }),
      price_a: num(f.price_a, 'clone.price', { unit: 'market_value' }), price_b: num(f.price_b, 'clone.price', { unit: 'market_value' }),
      legs: r?.legs ? {
        give_a: String(r.legs.give_a), get_b: String(r.legs.get_b),
        p1: num(r.legs.p1, 'clone.accept', { prob: true, unit: 'probability', guess: true }),
        p2: num(r.legs.p2, 'clone.accept', { prob: true, unit: 'probability', guess: true }),
        p_both: num(r.legs.p_complete, 'clone.accept', { prob: true, unit: 'probability', guess: true }),
        nick_after: num(r.legs.d2, 'sim.title', { se: r.legs.se2, clears: r.legs.clears2, unit: 'title_odds' }),
      } : null,
    };
    if (r && !r.legs && typeof r.why === 'string' && r.why.trim()) out.legs_why_not = r.why;
    if (r?.legs || f.chat_hint) {
      out.reasoning = ok({
        case_for: `Team ${f.a} and Team ${f.b} price ${nm(f.player)} differently: the spread is ${(f.spread * 100).toFixed(1)} pts of title odds.`,
        his_side: f.chat_hint ? 'From chat: one side is louder about him than the other.' : 'No chat read on either side.',
        devils_advocate: f.clears ? 'The spread clears the noise; both legs still have to land.' : 'The spread does not clear two standard errors of noise.',
        news_check: 'Not checked for flips: the news read runs on the offers in a plan.',
        confidence: r?.legs && isProb(r.legs.p_complete) ? `Both legs land ${pct(r.legs.p_complete)} of the time, on ${P_ACCEPT_LABEL}.` : 'The two legs were not priced.',
        counter: 'Each leg is a separate offer; decline a counter that breaks the other leg.',
        cites: ['spread', 'legs.p_both'], check_first: !f.clears,
      }, 'plan.template');
    }
    return out;
  }), 'sim.title', { n: res.flip.pairs });

  /* ----------------------------------------------------------- reports */
  const catch_up = ok(res.catch_up.map(c => {
    const gain = fin(c.gain) ? num(c.gain, 'plan.path', { unit, guess: c.kind === 'timing' })
      : c.kind === 'free' ? unknown(`A claim is priced in points a game (+${(c.ppg_gain ?? 0).toFixed(1)}), not in ${LABEL[metric]}.`, 'asset.ros')
        : unknown('The deadline clock carries no gain of its own.', 'plan.path');
    const out = { text: c.text, gain, steps: Number.isInteger(c.steps) ? c.steps : c.kind === 'flip' ? 2 : 0 };
    if (c.plan_key && idByFirstKey.has(c.plan_key)) out.move_id = idByFirstKey.get(c.plan_key);
    return out;
  }), 'plan.path');

  const speed = res.speed.filter(s => week(s.arrive_by));
  const speed_curve = speed.length ? ok(speed.map(s => ({
    arrive_by: s.arrive_by, cost: num(s.cost, 'plan.path', { unit }), net: num(s.net, 'plan.path', { unit }),
    variance_note: s.variance_note, offers_used: s.offers_used, before_deadline: s.before_deadline,
  })), 'plan.path') : unknown('No plan to put on a clock.', 'plan.path');

  const risk_modes = ok(res.risk_modes.map(m => ({
    mode: m.mode, label: m.label, active: m.mode === o.risk_mode,
    expected: num(m.expected, 'plan.path', { unit, missing: 'No plan fits this mode.' }),
    if_complete: num(m.if_complete, 'plan.path', { unit, missing: 'No plan fits this mode.' }),
    p_complete: num(m.p_complete, 'plan.path', { prob: true, unit: 'probability', guess: true, missing: 'No plan fits this mode.' }),
    first_step: m.first_step ? { partner: String(m.first_step.team), give: ids(m.first_step.give), get: ids(m.first_step.get) } : null,
  })), 'plan.path');

  const chatLabels = c => (c?.status === 'ok'
    ? ['engagement', 'tone', 'open_to_trade', 'no_holds'].filter(k => c[k] && c[k] !== 'unknown').map(k => `${k}:${c[k]}`) : []);
  const partners = ok(res.partners.map(p => {
    const out = { team: p.team, p_responds: p.p_responds, basis: p.basis, edge: num(p.edge, 'plan.path', { unit }) };
    const labels = chatLabels(p.chat);
    if (labels.length) out.chat_labels = labels;
    if (p.needs?.length) out.roster_holes = p.needs;
    if (Number.isInteger(p.sent_this_week)) out.offers_logged = p.sent_this_week;
    // FIX-02c: a manager Nick marked unreachable is excluded everywhere; the contract says so as `blocked`.
    return { ...out, checked_out: !!p.checked_out, blocked: !!p.blocked || !!p.excluded };
  }), 'campaign.plan');

  const f = res.feasibility;
  const feasibility = f?.kind === 'points' ? ok({
    points_per_week: f.target,
    projected_points: num(f.options?.[0]?.season_mean_after ?? f.now?.season_mean, 'sim.title', { unit: 'points_per_week' }),
    p_hit: num(f.how_likely, 'sim.title', { prob: true, unit: 'probability' }),
    by_week: week(f.by_when) ? ok(f.by_when, 'sim.title') : unknown('No option reaches the target inside the weeks simulated.', 'sim.title'),
    ...(f.at_what_cost ? { cost_text: `${f.at_what_cost.players} player(s) over ${f.at_what_cost.steps} offer(s)` } : {}),
  }, 'sim.title') : unknown(`points objective not set: this league is planned on ${LABEL[metric]}.`, 'sim.title');

  const fb = res.finder_best;
  const finder_best_expected = fb && fin(fb.expected)
    ? num(fb.expected, 'sim.title', { se: fb.se, unit: 'title_odds', guess: true, n: fb.n })
    : unknown(fb?.error ? `The Trade Lab finder baseline failed (${fb.error}).` : 'The Trade Lab finder baseline was not run for this league.', 'sim.title');

  return {
    league: res.league, me: String(res.me), names,
    ...(typeof res.sanity === 'boolean' ? { sanity_composed_equals_direct: res.sanity } : {}),
    attention: unknown('Not ranked yet.', 'campaign.plan'),
    destination, feasibility, finder_best_expected, next_move, alternatives, itinerary, stop_tradeoffs,
    flip_map, targets, catch_up, speed_curve,
    brain_report: brain
      ? ok(brain.section, 'eval.check', brain.as_of ? { as_of: brain.as_of } : {})
      : unknown('The brain report was not read for this run.', 'eval.check'),
    number_health: !health ? unknown('The number audit was not read for this run.', 'audit.numbers')
      : health.status === 'ok' ? ok(health.value, 'audit.numbers', health.as_of ? { as_of: health.as_of } : {})
        : { status: health.status, source: 'audit.numbers', reason: health.reason },
    risk_modes, partners,
    _run: {
      seed: res.seed ?? null, confirm_seed: res.confirm?.seed ?? null, week: w, deadline_week: week(res.deadline_week),
      behind: !!res.behind, objective_version: o.version, objective_source: o.source, risk_mode: o.risk_mode,
      next_step: res.best ? res.best.steps[0] : null, trajectory: prevTraj ?? trajectory,
      changed: changed ?? { changed: false, reason: 'not compared' },
      roster_key: null,
      confirm: { status: res.confirm.status, ...(res.confirm.reason ? { reason: res.confirm.reason } : {}), plan_seed: res.confirm.plan_seed,
        cards: deck.map(c => c.confirm) },
      outlook: res.outlook ? { season_mean: res.outlook.season_mean, per_week: res.outlook.per_week.map(x => ({ week: x.week, mean: x.mean })) } : null,
      feasibility_detail: f ?? null,
      candidates_scored: res.candidates_scored, rescores: res.rescores ?? 0, runtime_ms: res.runtime_ms ?? 0, phases_ms: res.phases_ms ?? {},
      inputs: {},
    },
  };
}

/**
 * The whole file: the contract head and the league entries. flags: model-flags.js#modelFlags() for this
 * run; they go into the head's producer_version (FIX-02b), so plans priced with other flags than Trade Lab say so.
 */
export function plansFile(entries, { generated_at, flags = null } = {}) {
  return { schema: SCHEMA_VERSION, generated_at, producer: PRODUCER, producer_version: versionWithFlags(PRODUCER_VERSION, flags), leagues: entries };
}
