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
import { P_ACCEPT_LABEL, teamLabel, acceptDo, declineDo } from './playbook.js';
import { PYES_BASIS, PYES_LABEL, BLEND_BASIS, BLEND_LABEL } from '../p-yes.js';
import { dealKey } from './paths.js';
import { M6_REPLY_PRIOR } from '../people/counterpart.js';
import { hash } from './confirm.js';
import { ladderSection } from './ladder.js';
import { floorName as getsFloorName } from './gets-floor.js';
import { hisSide, hisSideSummary } from './his-side.js';
import { deadlineSummary } from './deadline-mode.js';
import { titlePathSummary } from './title-path.js';

const M6_MIX = Object.freeze({ ignore: M6_REPLY_PRIOR.ignore, counter: M6_REPLY_PRIOR.counter, decline: M6_REPLY_PRIOR.decline, accept: M6_REPLY_PRIOR.accept });
/** One counterpart feature for the plans file: named, typed, no names or note text. */
const featureOut = f => ({ feature: String(f.feature), effect: String(f.effect ?? ''),
  ...(Number.isFinite(f.value) ? { value: f.value } : {}), ...(f.basis ? { basis: String(f.basis) } : {}),
  ...(f.player != null ? { player: String(f.player) } : {}), ...(Number.isFinite(f.n) ? { n: f.n } : {}) });
/** The acceptance-model bases trade_outcomes accepts (migration 067 CHECK on model_basis). */
const BAND_BASES = ['no_information', 'heuristic_unanchored', 'heuristic_anchored'];
/** PYES-ONE: where a served P(yes) came from. The E1 activity baseline (p-yes.js, flag on) is its own source. */
const pSrc = basis => (basis === PYES_BASIS ? 'activity.accept' : basis === BLEND_BASIS ? 'blend.accept' : 'clone.accept');
/**
 * A step's P(yes) source. SEARCH-WIDE x LIVE-BLEND (#406 finding 5 / #404): a free-agent claim asks
 * nobody, so its p is never an acceptance model's (clone, activity baseline or blend): it is the
 * planner's waiver-win rate (search-wide.js#claimProbability), labelled 'plan.path', whatever
 * p_basis a step object might carry. Every place a step's p_yes is shown reads this one helper.
 */
export const stepPSource = st => (st?.claim ? 'plan.path' : pSrc(st?.p_basis));
/** LIVE-BLEND: the source id a p_yes_basis section names. */
const pSrcOf = b => (['activity.accept', 'blend.accept', 'clone.accept'].includes(b.source) ? b.source : 'clone.accept');
const PYES_NOTE = `${PYES_LABEL}: every offer to one manager gets the same number, so ladder rungs differ by your gain, not by P(yes), until E1 grades a model that reads the offer`;
/** integration-8: the label for a P(yes), by the basis that served it (LIVE-BLEND is on by default). */
const pLabelOf = basis => (basis === PYES_BASIS ? PYES_NOTE : basis === BLEND_BASIS ? BLEND_LABEL : P_ACCEPT_LABEL);
/** The same by a plans.json source ('blend.accept' | 'activity.accept' | 'clone.accept'). */
const pLabelOfSource = src => (src === 'activity.accept' ? PYES_NOTE : src === 'blend.accept' ? BLEND_LABEL : P_ACCEPT_LABEL);

export const PRODUCER = 'campaign-producer';
export const PRODUCER_VERSION = '2';

/** ground_lost's reason when the earlier plan was made under another model (PLAN-BASELINE). */
export const PLAN_RESTARTED = 'Plan restarted: the model changed since the last plan, so this week\'s plan starts at today\'s odds.';

/**
 * PLAN-BASELINE: which earlier trajectory this run compares with. prevRun: the previous
 * entry's `_run` (or null). model: this run's model key (produce-plans.mjs#planModelKey), or
 * null when the caller has none (tests, the contract fixture), which keeps the incumbent
 * compare. The key is stamped at `_run.inputs.model`. A previous run stamped with another key,
 * or with none while this run has one
 * (a file written before the stamp), is a different model: the plan restarts.
 * -> { trajectory: array | null, restarted: boolean }
 */
export function planBaseline(prevRun, model = null) {
  const trajectory = Array.isArray(prevRun?.trajectory) ? prevRun.trajectory : null;
  if (!trajectory) return { trajectory: null, restarted: false };
  const prevModel = prevRun.inputs?.model ?? null;
  if (model == null && prevModel == null) return { trajectory, restarted: false };
  return prevModel === model ? { trajectory, restarted: false } : { trajectory: null, restarted: true };
}

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

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric',
  day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

/**
 * CARD-CLARITY: the send-when line in words Nick reads, never a raw ISO time.
 * { when: 'wait', until, why } -> "Wait until Fri 9/25, 11:51 AM ET: <why>." (America/New_York);
 * { when: 'now', why } -> "Now: <why>.". A wait whose time does not parse says "Wait: <why>.".
 */
export function sendWhenText({ when, until, why }) {
  if (when !== 'wait') return `Now: ${why}.`;
  const t = typeof until === 'string' || typeof until === 'number' ? new Date(until) : null;
  if (!t || !Number.isFinite(t.getTime())) return `Wait: ${why}.`;
  const p = Object.fromEntries(ET.formatToParts(t).map(x => [x.type, x.value]));
  return `Wait until ${p.weekday} ${p.month}/${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ET: ${why}.`;
}

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

/** STOPS-01: the stops run for `_run.inputs.stops` (ids and numbers only). */
function stopsSummary(st) {
  return { mode: st.mode, priced: st.rows.filter(r => r.status === 'ok').length, unreachable: st.rows.filter(r => r.status !== 'ok').length,
    holes: st.holes.map(h => ({ week: h.week, kind: h.kind, drop: h.drop, se: h.se, players: h.players })),
    rows: st.rows.map(r => ({ week: r.week, kind: r.hole_kind, status: r.status, stop_label: r.stop_label, because: r.because,
      ...(r.status === 'ok' ? { cost: r.cost, net: r.net, verdict: r.verdict, extra_steps: r.extra_steps, gain_text: r.gain_text,
        new_next_move_changes: r.new_next_move_changes, cover: r.cover } : {}) })) };
}

/**
 * res: planLeague result. ctx: { names, as_of, previous (last entry), changed (diffNextMove result),
 *   brain (brain-gate.js#applyBrainReport result), number_health (brain-gate.js#readNumberHealth result),
 *   teams (league-adapter.mjs#teamNames: roster -> { name, manager }; none -> 'unknown') }
 * FIX-05: without `brain` / `number_health` the two sections are 'unknown' and say they were not read.
 */
export function toEntry(res, { names = {}, as_of, previous = null, changed = null, brain = null, number_health: health = null, model = null, teams = null, blue_chips: board = null,
  his_side_on: hisSideServed = false } = {}) {
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
  // TEAM-NAMES-2: every team a sentence names reads playbook.js#teamLabel on this entry's teams map
  // (the manager Nick knows when the league adapter read one, else 'Team N', as in public fixtures).
  const tl = id => teamLabel(teams, id);
  // Sentences the planner wrote with 'Team N' (planner.js targets / catch-up): the same label, applied
  // only to a roster the teams map names; any other 'Team N' is left as written.
  const relabel = text => (typeof text === 'string' && teams
    ? text.replace(/\bTeam ([A-Za-z0-9_.:-]*[A-Za-z0-9_])(?![A-Za-z0-9_])/g, (m, id) => (Object.hasOwn(teams, id) ? tl(id) : m)) : text);

  /* ---------------------------------------------------------- the deck */
  const deck = res.deck;
  const moveIds = deck.map(c => moveId(res.league, c.plan));
  const idByFirstKey = new Map(deck.map((c, j) => [dealKey(c.plan.steps[0]), moveIds[j]]));

  const reasoning = ({ team, p, pBasis, delta, clears, pb, verdict, whole }) => {
    const needs = needsOf(team);
    const shrank = verdict?.verdict === 'shrank';
    return ok({
      case_for: whole ?? `If ${tl(team)} says yes you move ${fmt(delta)}.`,
      his_side: (needs.length ? `${tl(team)}'s roster read lists ${needs.join(', ')} as thin, and the offer is built on it.`
        : `There is no read of ${tl(team)}'s needs, so the offer leans on market value alone.`)
        + (pb?.nick_shift ? ` ${pb.nick_shift.text}` : ''), // FIX-02c: Nick's read shifts the price (hand-set)
      devils_advocate: shrank ? `On fresh dice the plan shrank by ${fmt(verdict.shrink)}: the first read was lucky.`
        : clears === false ? 'The gain does not clear two standard errors of simulation noise.'
          : verdict?.verdict === 'holds' ? 'The gain clears the noise and held on fresh dice; the weak link is whether he says yes.'
            : 'The gain clears the noise but was not re-checked on fresh dice.',
      news_check: pb?.wait ? (pb.wait.flag === 'wait' ? `Wait ${pb.wait.days} days: ${pb.wait.reason}.` : `Act now: ${pb.wait.reason}.`)
        : 'Not checked: this offer has no playbook yet.',
      confidence: `Chance he says yes is ${pct(p)}, from ${pLabelOf(pBasis)}.`,
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
      // SEARCH-WIDE: a free-agent claim asks nobody; its p is the waiver-win rate (stepPSource), never a clone or blend read.
      p_yes: num(st.p, stepPSource(st), { prob: true, unit: 'probability', guess: true }),
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
        ? ok(sendWhenText(pb.send_when), 'plan.path')
        : unknown("No timing read for this manager.", 'plan.path');
      const row = kind => pb.replies.find(r => r.kind === kind);
      out.reply_table = ok({
        accept: replyField(row('accept'), r => ({ do: r.next ? acceptDo(r.next.partner, teams) : r.do,
          ...(r.next ? { move_id: thisId } : {}),
          odds_after: num(nowMetric + st.delta, 'sim.title', { unit, se: st.se, clears: st.clears }) })),
        decline: replyField(row('decline'), r => ({ do: r.next ? declineDo(r.next.partner, teams) : r.do,
          ...(backupId ? { move_id: backupId } : {}),
          ...(fin(r.expected_after) ? { odds_after: num(nowMetric + r.expected_after, 'plan.path', { unit }) } : {}) })),
        counter: replyField(row('counter'), r => ({ do: r.do, ...(r.counter_rules ? { counter_rules: r.counter_rules } : {}) })),
        silence: replyField(row('silence'), r => ({ do: r.do, when: r.when, message: r.message })),
      }, 'plan.path');
      out.reasoning = reasoning({ team: st.team, p: st.p, pBasis: st.p_basis, delta: st.delta - before, clears: st.clears, pb, verdict });
      // NEGOTIATOR-DEFAULTS (flag, default off): the levers this offer uses, its feeler, expiry and withdraw rule.
      if (pb.negotiation) {
        const n = pb.negotiation;
        out.negotiation = ok({ levers: [...n.levers], feeler: n.feeler, expires_hours: n.expires_hours, withdraw_if: n.withdraw_if,
          ...(n.alt_package ? { alt_package: { give: ids(n.alt_package.give), get: ids(n.alt_package.get),
            ...(fin(n.alt_package.his_pct) ? { his_pct: n.alt_package.his_pct } : {}),
            ...(n.alt_package.dice === 'confirm' && fin(n.alt_package.expected) ? { dice: 'confirm', expected: n.alt_package.expected } : {}) } } : {}),
          ...(n.anchor ? { anchor: { ...n.anchor } } : {}),
          ...(n.cool_off ? { cool_off: true } : {}), ...(n.alt_dropped ? { alt_dropped: n.alt_dropped } : {}) }, 'plan.template');
      }
    }
    // CAP-1C: a depth-only 2-for-1 planned above the 0 cap says so, with the lineup and title gains that allowed it.
    const dp = st.depth_premium;
    if (dp) {
      const c = dp.confirmed ?? null;
      out.depth_premium = ok({ pct: dp.pct, cap: dp.cap, lineup_points_delta: dp.points_delta, title_odds_delta: dp.title_delta,
        ...(c ? { confirmed_lineup_points_delta: c.points_delta, confirmed_title_odds_delta: c.title_delta } : {}),
        text: `Depth-only 2-for-1 at +${Math.max(1, Math.round(dp.pct * 100))}% market value (cap +${Math.round(dp.cap * 100)}%): `
          + `your lineup gains ${dp.points_delta.toFixed(1)} pts a week and your title odds ${(dp.title_delta * 100).toFixed(2)} pts on the same dice`
          + (c ? `, and ${c.points_delta.toFixed(1)} pts a week and ${(c.title_delta * 100).toFixed(2)} pts on fresh dice.` : '; not yet re-checked on fresh dice.'),
      }, 'plan.path', { unit: 'market_value' });
    }
    if (st.band && isProb(st.band.low) && isProb(st.band.high)) {
      out.p_yes_band = { low: st.band.low, high: st.band.high };
      // The acceptance model's own basis (trade-acceptance.js): the offer ledger refuses a band without one.
      if (BAND_BASES.includes(st.band.basis)) out.p_yes_band.basis = st.band.basis;
    }
    // ONE-COUNTERPART (RULINGS 17): the counterpart's served numbers, typed (plans-schema.js `counterpart`).
    const cp = pb?.counterpart;
    if (cp) {
      out.counterpart = isProb(cp.p_accept_challenger) ? ok({
        reply_mix: { ignore: cp.reply_mix.ignore, counter: cp.reply_mix.counter, decline: cp.reply_mix.decline, accept: cp.reply_mix.accept },
        reply_mix_label: cp.label, p_accept_challenger: cp.p_accept_challenger,
        p_accept_served: isProb(cp.p_accept_served) ? cp.p_accept_served : cp.p_accept_challenger,
        yes_point_his_pct: fin(cp.yes_point_his_pct) ? cp.yes_point_his_pct : null,
        reason_chain: (cp.reason_chain ?? []).map(featureOut),
      }, 'clone.accept', { guess: true }) : unknown('The counterpart model gave no P(accept) for this step.', 'clone.accept');
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
      return step(plan, i, i === 0 ? c.playbook : c.playbooks?.[i] ?? null, { thisId, backupId: i === 0 ? moveIds[j + 1] ?? null : null,
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
      reasoning: reasoning({ team: s0.team, p: s0.p, pBasis: s0.p_basis, delta: s0.delta, clears: s0.clears, pb: c.playbook, verdict: c.confirm,
        whole: `If all ${plan.steps.length} step(s) land you gain ${fmt(plan.delta_final)}; across yes and no outcomes that is ${fmt(plan.expected)} expected, and the path completes ${pct(plan.p_complete)} of the time.` }),
    };
  });
  const best = moves[0] ?? null;
  const alternatives = ok(moves, 'plan.path');
  // NO-OVERPAY: with no move, say when the cap on market value given is what stopped it, and name the closest overpay.
  const op = res.no_overpay ?? null;
  const cl = op?.closest && fin(op.closest.pct) ? op.closest : null;
  // REACH-01: a chained miss prints its whole chain (the legs before the overpaying finish), in order.
  const legs = (cl?.chain ?? []).map(x => `${x.give.map(nm).join(' + ')} for ${x.get.map(nm).join(' + ')} (Team ${x.team})`);
  const finish = cl ? `${cl.give.map(nm).join(' + ')} for ${cl.get.map(nm).join(' + ')}` : '';
  const closestText = cl ? `the closest is ${legs.length ? `${legs.join(', then ')}, then ${finish}` : finish} at +${Math.max(1, Math.round(cl.pct * 100))}% market value (your cap: +${Math.round((op.max_overpay ?? 0) * 100)}%)` : null;
  // NO-TRADE-SHRINK: with no move, say that keeping the roster is the active mode's pick (its no-trade row).
  const keepRow = (res.risk_modes ?? []).find(m => m.mode === o.risk_mode)?.no_trade;
  const keepText = keepRow?.pick === 'no_trade' ? ` Keeping your roster is the pick in ${MODE_LABELS[o.risk_mode]} mode.` : '';
  // GETS-FLOOR: with the floor on and no move, say first that the floor is what emptied the deck.
  const gf = res.gets_floor?.mode === 'on' ? res.gets_floor : null;
  const floorName = gf ? getsFloorName(gf.floor) : null;
  const floorText = !gf ? null
    : gf.source === 'none' ? `The ${floorName} is on but there is no player score this run, so no get can be certified.`
      : gf.refused.length ? `${gf.refused.map(r => `${nm(r.player)} ${r.score == null ? 'has no score' : `scores ${Math.round(r.score)}`}`).join('; ')}, under the ${floorName}.`
        : gf.dropped ? `${gf.dropped} candidate get${gf.dropped === 1 ? '' : 's'} under the ${floorName} ${gf.dropped === 1 ? 'was' : 'were'} skipped.` : null;
  // integration-7: no move because the trade ledger is missing (the planner failed closed).
  const tlm = res.trade_ledger_missing ?? null;
  const ledgerText = tlm ? `No move this run: the league has ${tlm.executed_rows} executed trade${tlm.executed_rows === 1 ? '' : 's'} this season but the trade ledger could not be read, so Nick's no-buy-back and no-reversal rules cannot be checked.` : null;
  const why = res.candidates_scored
    ? `None of the ${res.candidates_scored} paths searched clears the sliders and the fresh-dice check this week.${keepText}${closestText ? ` Nothing clears without overpaying; ${closestText}.` : ''} Try another target or risk mode.`
    : closestText ? `Nothing clears without overpaying; ${closestText}.`
      : floorText || ledgerText ? null : 'The planner found no trade path worth sending this week.';
  const next_move = best ? ok(best, 'plan.path') : unknown([ledgerText, floorText, why].filter(Boolean).join(' '), 'plan.path');

  /* ------------------------------------------------------- destination */
  // PLAN-BASELINE: an earlier trajectory is compared with only when it was made under this run's model.
  const base = planBaseline(previous?._run ?? null, model);
  const prevTraj = base.trajectory;
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
    title_now: num(res.now.title, 'sim.title', { prob: true, unit: 'title_odds', se: res.now.title_se }),
    title_planned_now: metric !== 'title' ? unknown(`The plan is tracked in ${LABEL[metric]}, not title odds.`, 'plan.path')
      : num(plannedNow ?? nowMetric, 'plan.path', { prob: true, unit: 'title_odds' }),
    path: path.length ? ok(path, 'plan.path') : unknown('The current week is unknown, so there is no path.', 'plan.path'),
    ground_lost: plannedNow != null ? num(plannedNow - nowMetric, 'plan.path', { unit })
      : unknown(base.restarted ? PLAN_RESTARTED : 'No earlier plan for this week to compare with.', 'plan.path'),
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
      // itinerary.js#planStopLabel wrote ' from Team N' (the planner has no teams map): name him here.
      const tail = ` from ${teamLabel(null, st.team)}`;
      if (out.label.endsWith(tail)) out.label = `${out.label.slice(0, -tail.length)} from ${tl(st.team)}`;
      out.p_yes = num(st.p, stepPSource(st), { prob: true, unit: 'probability', guess: true });
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
  // STOPS-01: the planner's bye / injury stops, served only when GRIDIRON_STOPS=1 (shadow: _run.inputs.stops).
  if (res.stops?.mode === 'on') {
    for (const r of res.stops.rows) {
      if (r.status !== 'ok' || !fin(r.cost) || !fin(r.net)) continue;
      const key = tradeoffKey({ type: 'add_stop', stop: r.stop });
      if (TRADEOFF_KEY.test(key) && !tradeoffs[key]) tradeoffs[key] = row(r);
    }
  }
  const cur = res.risk_modes.find(m => m.mode === o.risk_mode);
  // integration-7: a mode whose pick is keeping the roster is worth exactly 0 (no move), not unpriced.
  const expOf = m => (fin(m?.expected) ? m.expected : m?.no_trade?.pick === 'no_trade' ? 0 : null);
  for (const m of res.risk_modes) {
    if (m.mode === o.risk_mode || !cur || !fin(expOf(cur)) || !fin(expOf(m))) continue;
    const cost = expOf(cur) - expOf(m);
    const verdict = verdictOf(-cost, res.best?.expected_se);
    tradeoffs[tradeoffKey({ type: 'set_risk_mode', mode: m.mode })] = row({
      stop_label: `Switch to ${MODE_LABELS[m.mode]}`, cost, extra_steps: (m.steps ?? 0) - (cur.steps ?? 0), gain: 0, net: 0 - cost, verdict,
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
  // HIS-SIDE-WIRE: the owner's side, read for every target; served only with GRIDIRON_HIS_SIDE=1.
  const hisRows = [];
  const hisOf = t => {
    const hs = hisSide({ player: t.player, owner: t.owner, partner: res.partners.find(p => p.team === String(t.owner)) ?? null,
      model: (res.counterpart?.models ?? []).find(m => String(m.team) === String(t.owner)) ?? null,
      block: res.trade_block ?? null, memory: res.trade_memory ?? null, inNames, nm, tl });
    hisRows.push({ player: String(t.player), owner: String(t.owner), hs });
    return hs;
  };
  const hisField = hs => (hs.status === 'ok' ? ok(hs.value, 'plan.template') : unknown(hs.reason, 'plan.template'));
  const targetList = res.suggestions.filter(t => t.owner != null && inNames(t.player)).map(t => ({ t, hs: hisOf(t) })).map(({ t, hs }) => ({
    player: String(t.player), owner: String(t.owner),
    gain_if_landed: num(t.gain_if_landed, 'sim.title', { se: t.gain_se, unit }),
    p_reach: num(t.p_reach, 'plan.path', { prob: true, unit: 'probability', guess: true, missing: 'No path to him fits any risk mode yet.' }),
    mode_fit: ok(t.mode_fit, 'plan.path'), why: ok(relabel(t.why), 'plan.template'),
    approved: !!t.approved, is_plan_target: bestTarget === String(t.player),
    reasoning: ok({
      case_for: relabel(t.why),
      his_side: hisSideServed && hs.status === 'ok' ? hs.value.text
        : needsOf(t.owner).length ? `${tl(t.owner)}'s roster read lists ${needsOf(t.owner).join(', ')} as thin.` : `There is no read of ${tl(t.owner)}'s needs.`,
      devils_advocate: t.mode_fit === 'fits' ? 'A path fits the current risk mode; landing him still takes every step saying yes.'
        : t.mode_fit === 'needs_all_in' ? 'Only an all-in plan reaches him.' : 'No plan inside the sliders reaches him.',
      news_check: 'Not checked for targets: the news read runs on the offers in a plan.',
      confidence: fin(t.p_reach) ? `The path lands ${pct(t.p_reach)} of the time, on ${pLabelOfSource(res.p_yes_basis?.source)}.` : 'No path, so no landing chance.',
      counter: 'No offer yet, so no counter plan.',
      cites: ['gain_if_landed', 'p_reach'], check_first: t.mode_fit !== 'fits',
    }, 'plan.template'),
    ...(hisSideServed ? { his_side: hisField(hs) } : {}),
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
        ...(Array.isArray(r.legs.give_a_ids) && r.legs.give_a_ids.length ? { give_a_ids: r.legs.give_a_ids.map(String) } : {}),
        ...(Array.isArray(r.legs.get_b_ids) && r.legs.get_b_ids.length ? { get_b_ids: r.legs.get_b_ids.map(String) } : {}),
        p1: num(r.legs.p1, pSrc(r.legs.p_basis), { prob: true, unit: 'probability', guess: true }),
        p2: num(r.legs.p2, pSrc(r.legs.p_basis), { prob: true, unit: 'probability', guess: true }),
        p_both: num(r.legs.p_complete, pSrc(r.legs.p_basis), { prob: true, unit: 'probability', guess: true }),
        nick_after: num(r.legs.d2, 'sim.title', { se: r.legs.se2, clears: r.legs.clears2, unit: 'title_odds' }),
      } : null,
    };
    if (r && !r.legs && typeof r.why === 'string' && r.why.trim()) out.legs_why_not = r.why;
    if (r?.legs || f.chat_hint) {
      out.reasoning = ok({
        case_for: `${tl(f.a)} and ${tl(f.b)} price ${nm(f.player)} differently: the spread is ${(f.spread * 100).toFixed(1)} pts of title odds.`,
        his_side: f.chat_hint ? 'From chat: one side is louder about him than the other.' : 'No chat read on either side.',
        devils_advocate: f.clears ? 'The spread clears the noise; both legs still have to land.' : 'The spread does not clear two standard errors of noise.',
        news_check: 'Not checked for flips: the news read runs on the offers in a plan.',
        confidence: r?.legs && isProb(r.legs.p_complete) ? `Both legs land ${pct(r.legs.p_complete)} of the time, on ${pLabelOf(r.legs.p_basis)}.` : 'The two legs were not priced.',
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
        : c.kind === 'desperate' ? unknown('No plan through this manager fits the sliders yet.', 'plan.path')
          : unknown('The deadline clock carries no gain of its own.', 'plan.path');
    const out = { text: relabel(c.text), gain, steps: Number.isInteger(c.steps) ? c.steps : c.kind === 'flip' ? 2 : 0, kind: c.kind };
    if (c.plan_key && idByFirstKey.has(c.plan_key)) out.move_id = idByFirstKey.get(c.plan_key);
    if (c.team != null) out.partner = String(c.team);
    if (c.kind === 'desperate') out.discount_pct = num(c.discount_pct, 'plan.path', { unit: 'market_value', missing: 'No price ladder for this step.' });
    return out;
  }), 'plan.path');

  const speed = res.speed.filter(s => week(s.arrive_by));
  const speed_curve = speed.length ? ok(speed.map(s => ({
    arrive_by: s.arrive_by, cost: num(s.cost, 'plan.path', { unit }), net: num(s.net, 'plan.path', { unit }),
    variance_note: s.variance_note, offers_used: s.offers_used, before_deadline: s.before_deadline,
    ...(s.lever ? { lever: s.lever } : {}),
    ...(fin(s.p_land) ? { p_land: num(s.p_land, 'plan.path', { prob: true, unit: 'probability', guess: true }) } : {}),
    ...(Array.isArray(s.levers) ? { levers: s.levers.map(l => ({ lever: l.lever, cost: num(l.cost, 'plan.path', { unit }),
      p_land: num(l.p_land, 'plan.path', { prob: true, unit: 'probability', guess: true }), offers_used: l.offers_used })) } : {}),
  })), 'plan.path') : unknown('No plan to put on a clock.', 'plan.path');

  const risk_modes = ok(res.risk_modes.map(m => ({
    mode: m.mode, label: m.label, active: m.mode === o.risk_mode,
    expected: num(m.expected, 'plan.path', { unit, missing: 'No plan fits this mode.' }),
    if_complete: num(m.if_complete, 'plan.path', { unit, missing: 'No plan fits this mode.' }),
    p_complete: num(m.p_complete, 'plan.path', { prob: true, unit: 'probability', guess: true, missing: 'No plan fits this mode.' }),
    first_step: m.first_step ? { partner: String(m.first_step.team), give: ids(m.first_step.give), get: ids(m.first_step.get) } : null,
    // NO-TRADE-SHRINK: keeping today's roster, scored by the same objective (exactly 0 gain, lands for sure).
    ...(m.no_trade ? { no_trade: { expected: num(m.no_trade.expected, 'plan.path', { unit }),
      p_complete: num(m.no_trade.p_complete, 'plan.path', { prob: true, unit: 'probability' }),
      pick: m.no_trade.pick, why: m.no_trade.why } } : {}),
  })), 'plan.path');

  const chatLabels = c => (c?.status === 'ok'
    ? ['engagement', 'tone', 'open_to_trade', 'no_holds'].filter(k => c[k] && c[k] !== 'unknown').map(k => `${k}:${c[k]}`) : []);
  const partners = ok(res.partners.map(p => {
    const out = { team: p.team, p_responds: p.p_responds, basis: p.basis, edge: num(p.edge, 'plan.path', { unit }) };
    const labels = chatLabels(p.chat);
    if (labels.length) out.chat_labels = labels;
    if (p.needs?.length) out.roster_holes = p.needs;
    if (Number.isInteger(p.sent_this_week)) out.offers_logged = p.sent_this_week;
    // Nick's untouchables on this roster (the reader's nick block): never a target, a get or a flip leg.
    const untouchable = (p.untouchable ?? []).filter(inNames).map(String);
    if (untouchable.length) out.untouchable = untouchable;
    // ONE-COUNTERPART (RULINGS 17): P(responds) before the model and every named adjustment, typed.
    if (isProb(p.p_responds_before_counterpart)) {
      out.p_responds_before_counterpart = p.p_responds_before_counterpart;
      out.reason_chain = (p.reason_chain ?? []).map(featureOut);
    }
    if (res.counterpart) out.reply_mix = { ...M6_MIX };
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

  // FEAS-140: the points side panel, its own card. Title-odds (or playoff-odds) cost is the best
  // plan's expected gain minus the option's, on the same rescores: priced in the league's metric.
  const sp = res.feasibility_points;
  const GOAL_OF = { title: 'title', playoffs: 'playoffs', playoff: 'playoffs', player: 'get_player' }; // FIX-300-2: objectives.js says 'playoffs'
  const feasibility_points = sp?.kind === 'points' && GOAL_OF[sp.league_objective] ? ok({
    points_per_week: sp.target, league_objective: GOAL_OF[sp.league_objective], outlook: sp.status,
    projected_points: num(sp.options?.[0]?.season_mean_after ?? sp.now?.season_mean, 'sim.title', { unit: 'points_per_week' }),
    p_hit: num(sp.p_reach, 'sim.title', { prob: true, unit: 'probability' }),
    by_week: week(sp.arrive_week) ? ok(sp.arrive_week, 'sim.title') : unknown(`No plan reaches ${sp.target} points a week inside the weeks simulated.`, 'sim.title'),
    cost_players: sp.cost.players, cost_offers: sp.cost.steps,
    objective_cost: sp.cost.basis === 'no plan to price' ? unknown('No plan on the league objective to price against.', 'sim.title')
      : num(sp.cost.title_odds, 'sim.title', { unit, missing: 'No plan to price against.' }),
    bye_warnings: sp.warnings_count.bye, injury_warnings: sp.warnings_count.injury,
    ...(sp.cost.players ? { cost_text: `${sp.cost.players} player(s) over ${sp.cost.steps} offer(s)` } : {}),
  }, 'sim.title') : unknown(o.kind === 'points' ? 'This league is already planned on points: see feasibility.'
    : 'Points side panel is off (GRIDIRON_POINTS_FEASIBILITY), or the world has no weekly lineup points.', 'sim.title');

  const fb = res.finder_best;
  const finder_best_expected = fb && fin(fb.expected)
    ? num(fb.expected, 'sim.title', { se: fb.se, unit: 'title_odds', guess: true, n: fb.n })
    : unknown(fb?.error ? `The Trade Lab finder baseline failed (${fb.error}).` : 'The Trade Lab finder baseline was not run for this league.', 'sim.title');

  return {
    league: res.league, me: String(res.me), names,
    ...(typeof res.sanity === 'boolean' ? { sanity_composed_equals_direct: res.sanity } : {}),
    attention: unknown('Not ranked yet.', 'campaign.plan'),
    destination, feasibility, feasibility_points, finder_best_expected, next_move, alternatives, itinerary, stop_tradeoffs,
    flip_map, targets, catch_up, speed_curve,
    brain_report: brain
      ? ok(brain.section, 'eval.check', brain.as_of ? { as_of: brain.as_of } : {})
      : unknown('The brain report was not read for this run.', 'eval.check'),
    number_health: !health ? unknown('The number audit was not read for this run.', 'audit.numbers')
      : health.status === 'ok' ? ok(health.value, 'audit.numbers', health.as_of ? { as_of: health.as_of } : {})
        : { status: health.status, source: 'audit.numbers', reason: health.reason },
    risk_modes, partners,
    teams: teams && Object.keys(teams).length ? ok(teams, 'campaign.plan') : unknown('The league adapter read no team or manager names.', 'campaign.plan'),
    blue_chips: blueChipsSection(board, res),
    // LADDER-01: the planner's ladder cards (flag GRIDIRON_LADDER); off, 'unknown' with the reason.
    ladders: ladderSection(res.ladders ?? null, { names, unit }),
    // LIVE-BLEND: which P(yes) the steps serve; unknown when the adapter read no table (a fixture).
    p_yes_basis: res.p_yes_basis ? ok(res.p_yes_basis, pSrcOf(res.p_yes_basis))
      : unknown('This run read no P(yes) table, so the steps carry the adapter\'s own p.', 'clone.accept'),
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
      feasibility_points_detail: sp ?? null,
      candidates_scored: res.candidates_scored, rescores: res.rescores ?? 0, runtime_ms: res.runtime_ms ?? 0, phases_ms: res.phases_ms ?? {},
      // PLAN-BASELINE: the model this run's trajectory was made under (the contract keeps `_run` keys fixed; inputs is free-form).
      inputs: { ...(model != null ? { model } : {}), his_side: hisSideSummary(hisRows, hisSideServed, res.trade_block ?? null, res.chat_interest ?? null),
        ...(res.stops ? { stops: stopsSummary(res.stops) } : {}),
        ...(res.deadline ? { deadline_mode: deadlineSummary(res.deadline) } : {}),
        // TITLE-PATH (shadow, GRIDIRON_TITLE_PATH=1): the three explainer lines and the numbers they print; no screen reads it.
        ...(res.title_path ? { title_path: titlePathSummary(res.title_path) } : {}),
        ...(res.no_fc_value?.source ? { value_source: { status: res.no_fc_value.status, source: res.no_fc_value.source, unpriced_players: res.no_fc_value.players, paths_dropped: res.no_fc_value.paths, ...(res.no_fc_value.reason ? { reason: res.no_fc_value.reason } : {}) } } : {}) },
      // TRADE-MEMORY: paths the season's trade ledger removed, and the memory itself (ids only).
      dropped_by_reason: { trade_memory: res.trade_memory?.dropped_total ?? 0,
        // FC-VALUE: rostered players with no FantasyCalc value (never given, got or flipped) plus paths dropped for one.
        ...(res.no_fc_value && (res.no_fc_value.players || res.no_fc_value.paths) ? { no_fc_value: res.no_fc_value.players + res.no_fc_value.paths } : {}),
        // integration-7: targets (and flips) not searched because the season's trade ledger was missing.
        ...(res.trade_ledger_missing ? { trade_ledger_missing: res.trade_ledger_missing.targets + res.trade_ledger_missing.flips } : {}) },
      trade_memory: res.trade_memory ?? { status: 'no_ledger', dropped_total: 0 },
      // NO-TRADE-SHRINK: the shadow pre-rank shrinkage report (modes.js#shadowShrink); bookkeeping only.
      ...(res.shrink ? { shrink: res.shrink } : {}),
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

/**
 * PLAYER-SCORE: the blue-chip board section. `board` is the adapter's blueChips() (people/player-score.js
 * via league-adapter.mjs#blueChipBoard); the planner's own title-odds value of adding a player to
 * Nick's roster (res.suggestions gain_if_landed, where the planner computed it) rides on his row.
 * Each number is typed: model value = the engine's market value (market.fc), FantasyPros' rest-of-season
 * rank (fp.ros) unknown with the reason when he did not join.
 */
export function blueChipsSection(board, res = {}) {
  if (!board) return unknown('The blue-chip board was not built for this run.', 'people.score');
  if (board.status === 'off') return unknown('Blue-chip scores are off (GRIDIRON_PLAYER_SCORE; on under preview).', 'people.score');
  const gain = new Map((res.suggestions ?? []).filter(x => fin(x.gain_if_landed)).map(x => [String(x.player), x]));
  const fpWhy = board.fp?.status === 'ok' ? 'The consensus has no rest-of-season rank for him (or his name did not match one player).'
    : board.fp?.reason ?? 'Consensus rest-of-season ranks were not read.';
  const rows = board.rows.map(r => {
    const g = gain.get(String(r.player));
    const parts = { pick_pct: r.parts.pick_pct, prod_basis: r.parts.prod_basis, prod_pct: r.parts.prod_pct,
      games: r.parts.games, team_games: r.parts.team_games, missed: r.parts.missed,
      ...(Number.isInteger(r.parts.pick) ? { pick: r.parts.pick } : {}),
      ...(fin(r.parts.prod_value) ? { prod_value: r.parts.prod_value } : {}),
      ...(Number.isInteger(r.parts.pos_rank) ? { pos_rank: r.parts.pos_rank, pos_n: r.parts.pos_n } : {}) };
    return {
      player: String(r.player), name: String(r.name ?? `player ${r.player}`), position: r.position, mine: !!r.mine,
      ...(r.owner != null ? { owner: String(r.owner) } : {}),
      score: r.score, label: r.label, hurt: !!r.hurt, parts,
      model_value: fin(r.model_value) ? ok(r.model_value, 'market.fc', { unit: 'market_value' })
        : unknown('The market has no price for him.', 'market.fc'),
      ...(Number.isInteger(r.model_rank) ? { model_rank: r.model_rank } : {}),
      // Nick's 9/23 ruling: the consensus rank is an internal input only (it drives `gaps`); its number is never served.
      fp_ros_rank: unknown(fin(r.fp_ros_rank) ? 'internal only: consensus ranks are not shown' : fpWhy, 'fp.ros'),
      ...(g ? { title_add: num(g.gain_if_landed, 'sim.title', { se: g.gain_se, unit: 'title_odds', guess: true }) } : {}),
      gaps: [...r.gaps], protected: !!r.protected,
    };
  });
  const fp = board.fp ?? { status: 'unknown', sync: 'not_run' };
  return ok({
    weights: { pick: board.weights.pick, production: board.weights.production, basis: board.weights.basis },
    labels: [...board.labels], rows, coverage: { ...board.coverage },
    fp: { status: fp.status, sync: String(fp.sync ?? 'not_run'), ...(fp.reason ? { reason: fp.reason } : {}),
      ...(fp.scrape_date ? { scrape_date: fp.scrape_date } : {}), ...(fp.prev_date ? { prev_date: fp.prev_date } : {}) },
    draft: { season: board.draft.season, picks: board.draft.picks, ...(board.draft.reason ? { reason: board.draft.reason } : {}) },
  }, 'people.score', { guess: true });
}
