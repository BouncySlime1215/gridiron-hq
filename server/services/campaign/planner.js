/**
 * CAMPAIGN-01: one league's campaign, planned on injected inputs.
 *
 * planLeague(adapter, settings) runs the whole brain for one league on one
 * league state: values, flip map, path search for the targets, mode ranking
 * with the sliders, the deck (top 5 alternatives) and backup branch, the
 * confirm pass on an independent seed, the playbook for every step, targets,
 * itinerary + stop trade-offs, speed curve, feasibility, catch-up list,
 * partner ranking. It never reads the DB, the env or the clock: the producer
 * script (scripts/campaign/produce-plans.mjs) builds the adapter and hands in
 * its env as settings.env (the two FEAS-140 flags; absent, both are off);
 * tests hand in a fixture. Output is an internal result; view.js turns it into the War
 * Room JSON.
 */
import { dealKey, pathExpectation, combos, linearNick, screenPct } from './paths.js';
import { rankPlans, compareModes, tolerancesFor, MODES } from './modes.js';
import { metricOf, pointsFeasibility, targetFeasibility, weeklySummary } from './objectives.js';
import { priceLadder, stepMessage, replyTable } from './playbook.js';
import { coachMessagesOn } from './messages.js';
import { buildItinerary, stopTradeOff, speedCurve, arrivalWeek } from './itinerary.js';
import { orderCatchUp, freeMoves, isBehind } from './catchup.js';
import { rankPartners, planSkipWeight } from './partners.js';
import { confirmSeed, confirmVerdict, repricePlan } from './confirm.js';
import { waitOrAct, waitOrActOn } from './wait-or-act.js';
import { sidePanelFeasibility, SIDE_OPTIONS } from './feasibility.js';
import { makeScorer, playerValues, flipMap, searchTarget, publicPlan } from './search.js';
import { withCounterparts, targetTilt, priceCap, publicModel, M6_REPLY_PRIOR, M6_LABEL } from '../people/counterpart.js';

/** The his-screen % where the curve's P(yes) first reaches one half (the counterpart's yes point), or null. */
const yesPoint = curve => {
  const hit = (curve ?? []).filter(c => Number.isFinite(c.his_pct) && c.p >= 0.5).sort((a, b) => a.his_pct - b.his_pct)[0];
  return hit ? hit.his_pct : null;
};

export const DECK_SIZE = 5;
/** P(accept) curve window on his screen, wider than the finder's so the curve has a shape. */
const CURVE_WINDOW = { low: -35, high: 45 };

const firstKey = p => dealKey(p.steps[0]);

/** Top plans with distinct first moves (the swipe deck). */
export function deckOf(ranked, n = DECK_SIZE) {
  const seen = new Set(), out = [];
  for (const p of ranked) {
    const k = firstKey(p);
    if (seen.has(k)) continue;
    seen.add(k); out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

/** For each step i of `best`: the best other plan sharing steps 0..i-1 with a different step i. */
export function backupBranches(best, ranked) {
  return best.steps.map((_, i) => {
    const prefix = best.steps.slice(0, i).map(dealKey).join('>');
    const alt = ranked.find(p => p !== best && p.steps.length > i
      && p.steps.slice(0, i).map(dealKey).join('>') === prefix && dealKey(p.steps[i]) !== dealKey(best.steps[i]));
    return alt ? { step: alt.steps[i], expected: alt.expected, plan: alt } : null;
  });
}

function priceCurve(adapter, S, vals, step, stateBefore, maxGive, exactDelta) {
  const me = adapter.league.me;
  const val = id => Math.max(0, Number(adapter.players.get(id)?.value) || 0);
  const mine = S.rosterOf(stateBefore, me).filter(vals.tradable);
  const getV = step.get.reduce((s, id) => s + val(id), 0);
  const orig = adapter.rosters.get(me);
  const lin = st => linearNick(S.rosterOf(st, me), orig, vals.addN, vals.lossN);
  const chosenLin = lin(S.applyTrade(stateBefore, me, step.team, step.give, step.get));
  // Rescale the linear estimate so the chosen package matches its exact rescore (approximate elsewhere).
  const scale = Number.isFinite(exactDelta) && Math.abs(chosenLin) > 1e-9 ? exactDelta / chosenLin : 1;
  const out = [];
  for (const give of combos(mine, maxGive)) {
    const gv = give.reduce((s, id) => s + val(id), 0);
    const his = screenPct(gv, getV);
    if (his == null || his < CURVE_WINDOW.low || his > CURVE_WINDOW.high) continue;
    const p = adapter.priceStep(step.team, step.get, give).p;
    const delta = lin(S.applyTrade(stateBefore, me, step.team, give, step.get)) * scale;
    out.push({ give, his_pct: his, p, delta, nick_gain: p * delta });
  }
  return { curve: out.sort((a, b) => a.his_pct - b.his_pct).slice(0, 60), basis: 'linear single-player values, rescaled to the exact rescore of the planned package' };
}

/**
 * adapter: see scripts/campaign/league-adapter.mjs (the real one) and test/fixtures (the fake one).
 * settings: { objective, skips ({player, manager} Maps), previous (last entry or null), budget, env }
 */
export function planLeague(adapter, settings) {
  // ONE-COUNTERPART (flag GRIDIRON_COUNTERPART or preview, set by the producer): absent -> today's plan, unchanged.
  const CP = adapter.counterparts ?? null;
  if (CP) adapter = withCounterparts(adapter, CP);
  const clockNow = () => adapter.now?.() ?? 0;
  const t0 = clockNow();
  const phases = {};
  let tp = t0;
  const mark = name => { const t = clockNow(); phases[name] = t - tp; tp = t; };
  const { objective } = settings;
  const env = settings.env ?? {};
  const waitEnabled = waitOrActOn(env);
  const budget = { flipTopPer: 3, flipRealise: 6, targets: 3, ...(settings.budget ?? {}) };
  const L = adapter.league;
  const me = L.me;
  const W = adapter.world(adapter.seed);
  if (!W || W.fail) return { league: L.id, me, error: `world failed: ${W?.fail ?? 'no world'}` };
  mark('world');
  const S = makeScorer(W, adapter);
  const base = S.rescore(new Map(), me);
  const now = { title: base.me.title_before, playoff: base.me.playoff_before, metric: metricOf(base.me, objective).before };

  const vals = playerValues(S, adapter, objective);
  mark('values');
  const flip = flipMap(S, adapter, vals, { topPer: budget.flipTopPer, realise: budget.flipRealise,
    daysLeft: Number.isInteger(L.deadline_week) ? Math.max(1, (L.deadline_week - L.week) * 7) : 1 });

  mark('flip');
  // Targets: the objective's player, Nick's "get" stops, then the biggest single-player upgrades.
  const skipP = settings.skips?.player ?? new Map();
  const myIds = adapter.rosters.get(me);
  const tiltOf = pid => (CP ? targetTilt(CP, vals.lossO.get(pid)?.team, pid, myIds) : { tilt: 1, exclude: false, features: [] });
  const upgrades = [...vals.addN.entries()].filter(([pid]) => !adapter.managers.get(vals.lossO.get(pid)?.team)?.blocked && !tiltOf(pid).exclude)
    .sort((x, y) => y[1] * (skipP.get(String(y[0])) ?? 1) * tiltOf(y[0]).tilt - x[1] * (skipP.get(String(x[0])) ?? 1) * tiltOf(x[0]).tilt)
    .map(([pid]) => pid);
  // Nick's untouchables (the reader's nick block via the adapter) are never a target, even when asked for.
  const untouchable = adapter.untouchable ?? new Set();
  const refused = [];
  const wanted = [];
  const want = pid => {
    if (pid == null) return;
    if (untouchable.has(String(pid))) { if (!refused.includes(String(pid))) refused.push(String(pid)); return; }
    if (!wanted.some(w => String(w) === String(pid))) wanted.push(pid);
  };
  const idOf = s => [...adapter.players.keys()].find(k => String(k) === String(s)) ?? null;
  if (objective.kind === 'player') want(idOf(objective.target));
  for (const st of objective.stops) if (st.kind === 'get') want(idOf(st.player));
  for (const pid of upgrades.slice(0, budget.targets)) want(pid);

  let plans = [];
  for (const target of wanted) plans.push(...searchTarget(S, adapter, vals, objective, target));
  const skipW = { player: settings.skips?.player ?? new Map(), manager: settings.skips?.manager ?? new Map() };
  plans = plans.map(p => ({ ...p, skip_weight: planSkipWeight(p, skipW) }));
  mark('search');

  // Sliders and context per mode.
  const core = new Set([...vals.lossN.entries()].filter(([id]) => adapter.starters.has(id))
    .sort((a, b) => a[1] - b[1]).slice(0, 3).map(([id]) => String(id)));
  const sentThisWeek = new Map([...adapter.managers].map(([t, m]) => [String(t), m.sent_this_week ?? 0]));
  const ctxFor = mode => ({
    tol: mode === objective.risk_mode ? objective.tolerances : tolerancesFor(mode),
    ctx: { originalIds: adapter.rosters.get(me), sentThisWeek, core, untouchables: objective.untouchables },
  });
  const pool = objective.kind === 'player' ? plans.filter(p => String(p.target) === String(objective.target)) : plans;
  const { tol, ctx } = ctxFor(objective.risk_mode);
  const { ranked, dropped } = rankPlans(pool, objective.risk_mode, tol, ctx);

  // Confirm on fresh dice: re-price the deck on an independent seed, show those numbers, drop failures.
  let deck = deckOf(ranked, DECK_SIZE + 2);
  const cSeed = confirmSeed(adapter.seed, L.id, L.fetched_at ?? '');
  const W2 = adapter.world(cSeed);
  mark('confirm_world');
  let confirm = { seed: cSeed, plan_seed: adapter.seed, status: 'failed', reason: 'confirm world failed' };
  if (W2 && !W2.fail) {
    const S2 = makeScorer(W2, adapter);
    deck = deck.map(p => {
      const fresh = p.steps.map(st => metricOf(S2.rescore(st.state, me).me, objective));
      const re = repricePlan(p, fresh);
      const v = confirmVerdict(pathExpectation(p.steps), pathExpectation(re.steps));
      const scored = rankPlans([re], objective.risk_mode, { ...tol, max_downside_per_step: Infinity }, { ...ctx, core: null }).ranked[0];
      return { ...re, score: scored?.score ?? -Infinity, mode: objective.risk_mode, confirm: v, planned_on: p };
    }).filter(p => p.confirm.verdict !== 'failed')
      .sort((a, b) => b.score - a.score).slice(0, DECK_SIZE);
    confirm = { seed: cSeed, plan_seed: adapter.seed, status: 'ok', rescores: S2.count() };
  } else {
    deck = deck.slice(0, DECK_SIZE);
  }
  mark('confirm_rescore');
  const best = deck[0] ?? null;
  const backups = best ? backupBranches(best.planned_on ?? best, ranked) : [];

  // Playbook for every step of the chosen plan, and for each deck card's first step.
  const managers = adapter.managers;
  const names = id => adapter.players.get(id)?.name ?? `player ${id}`;
  const playbookFor = (plan, i, backup) => {
    const st = plan.steps[i];
    const stateBefore = i === 0 ? new Map() : plan.steps[i - 1].state ?? (plan.planned_on?.steps[i - 1].state) ?? new Map();
    const priced = priceCurve(adapter, S, vals, st, stateBefore, tol.max_give_per_step, st.delta);
    const m = managers.get(st.team) ?? {};
    // Nick's "hard" read is applied ONCE (RULINGS 17): FIX-02c's hard shift when the adapter carries his block
    // (m.nick, the real producer); otherwise the counterpart's cap at fair on his screen (the same reader flag).
    const cap = CP && !m.nick?.hard ? priceCap(CP.get(String(st.team))) : null;
    const curve = cap ? priced.curve.filter(c => c.his_pct <= cap.max_his_pct) : priced.curve;
    const basis = cap ? `${priced.basis}; capped at ${cap.max_his_pct}% on his screen (nick_override)` : priced.basis;
    const ladder = priceLadder(curve, { batna: Math.max(0, backup?.expected ?? 0), mode: objective.risk_mode, hard: !!m.nick?.hard });
    const offer = ladder.opening ? { ...st, give: ladder.opening.give } : st;
    const message = stepMessage(offer, { players: adapter.players, needs: m.needs ?? null });
    const next = plan.steps[i + 1] ?? null;
    return {
      step_index: i, of_steps: plan.steps.length,
      message, ladder: { ...ladder, basis }, nick_shift: ladder.nick_shift ?? null,
      opening: ladder.opening ? { give: ladder.opening.give, p: ladder.opening.p, his_pct: ladder.opening.his_pct } : null,
      walk_away: ladder.walk_away ? { give: ladder.walk_away.give, p: ladder.walk_away.p, his_pct: ladder.walk_away.his_pct,
        text: `Stop at ${ladder.walk_away.give.map(names).join(' + ')}: past that, your backup plan is worth more.` } : null,
      replies: replyTable(st, { next, backup, ladder, nudge: `Still open to ${st.give.map(names).join(' + ')} for ${st.get.map(names).join(' + ')}?` }),
      send_when: m.send_when ?? null,
      wait: waitOrAct(st, adapter.players, { enabled: waitEnabled }),
      ...(CP ? (() => {
        const ps = adapter.priceStep(offer.team, offer.get, offer.give);
        return { counterpart: { reply_mix: { ...M6_REPLY_PRIOR }, label: M6_LABEL, p_accept_challenger: ps.p,
          p_accept_served: ps.p_before_counterpart ?? ps.p, yes_point_his_pct: yesPoint(curve),
          reason_chain: [...(ps.features ?? []), ...(cap ? [cap.feature] : [])] } };
      })() : {}),
    };
  };
  const playbook = best ? best.steps.map((_, i) => playbookFor(best, i, i === 0 ? (deck[1] ? { step: deck[1].steps[0], expected: deck[1].expected } : backups[0]) : backups[i])) : [];
  // A card's BATNA is the next card: swiping past a card means the ones before it were skipped.
  // MSG-WIRE-2 (gated on coachMessagesOn): every step of every card gets its playbook, so Coach can
  // write a message for it; step 0's BATNA stays the next card, a later step's BATNA is that card's
  // own backup branch. Off, the deck is the incumbent's (step 0 only, no `playbooks` key).
  const allSteps = coachMessagesOn();
  const deckCards = deck.map((p, j) => {
    if (!allSteps) return { plan: p, playbook: j === 0 ? playbook[0]
      : playbookFor(p, 0, deck[j + 1] ? { step: deck[j + 1].steps[0], expected: deck[j + 1].expected } : null) };
    if (j === 0) return { plan: p, playbook: playbook[0], playbooks: playbook };
    const br = p.steps.length > 1 ? backupBranches(p.planned_on ?? p, ranked) : [];
    const pbs = p.steps.map((_, i) => playbookFor(p, i, i === 0
      ? (deck[j + 1] ? { step: deck[j + 1].steps[0], expected: deck[j + 1].expected } : null) : br[i] ?? null));
    return { plan: p, playbook: pbs[0], playbooks: pbs };
  });

  // Suggested targets: gain if landed x P(reach) x skip weight, with mode fit.
  const byMode = Object.fromEntries(MODES.map(mode => { const c = ctxFor(mode); return [mode, rankPlans(plans, mode, c.tol, c.ctx).ranked]; }));
  const suggestions = upgrades.slice(0, 5).map(pid => {
    const mine = byMode[objective.risk_mode].find(p => String(p.target) === String(pid));
    const any = MODES.map(md => byMode[md].find(p => String(p.target) === String(pid))).find(Boolean) ?? null;
    const reach = mine ?? any;
    const fit = mine ? 'fits' : byMode.all_in.some(p => String(p.target) === String(pid)) ? 'needs_all_in' : 'too_risky_for_safe';
    const gain = vals.addN.get(pid) ?? 0;
    const owner = vals.lossO.get(pid)?.team;
    const w = skipP.get(String(pid)) ?? 1;
    const tt = tiltOf(pid);
    return { player: pid, owner, gain_if_landed: gain, gain_se: vals.addSe.get(pid) ?? null,
      p_reach: reach ? reach.p_complete : null, expected: reach ? reach.expected : null, mode_fit: fit,
      rank_score: gain * (reach?.p_complete ?? 0) * w * tt.tilt, skipped: w < 1,
      ...(CP ? { reason_chain: tt.features } : {}),
      why: `${names(pid)} adds ${(gain * 100).toFixed(1)} pts if landed; `
        + (reach ? `${reach.steps.length}-step path from Team ${owner}, lands ${(reach.p_complete * 100).toFixed(0)}% of the time.` : 'no path fits the sliders yet.'),
      approved: objective.kind === 'player' && String(objective.target) === String(pid) };
  }).sort((a, b) => b.rank_score - a.rank_score);

  // Itinerary + trade-off of each of Nick's stops.
  const itinerary = buildItinerary(best, objective, { names: Object.fromEntries([...adapter.players].map(([k, v]) => [String(k), v.name])) });
  const stopPreviews = objective.stops.map(st => {
    if (st.kind === 'get') {
      const withStop = ranked.find(p => String(p.target) === String(st.player)) ?? null;
      return stopTradeOff({ label: `Get ${names(idOf(st.player))}`, without: ranked[0], with: withStop, se: ranked[0]?.expected_se ?? null });
    }
    if (st.kind === 'sell') {
      const withStop = ranked.find(p => p.steps.some(s => s.give.some(id => String(id) === String(st.player)))) ?? null;
      return stopTradeOff({ label: `Sell ${names(idOf(st.player))}`, without: ranked[0], with: withStop, se: ranked[0]?.expected_se ?? null });
    }
    return { stop_label: st.label ?? st.kind, status: 'not_priced', because: `${st.kind} stops are priced in points only (see feasibility)` };
  });

  const clock = { currentWeek: L.week, deadlineWeek: L.deadline_week, daysLeftInWeek: L.days_left_in_week ?? 7 };
  const speed = speedCurve(ranked, clock);

  // Feasibility (row 9): points objective in full; player objective by path; weekly outlook always.
  let feasibility = null;
  const weeklyOf = st => (W.weekly ? W.weekly(S.rosterOf(st, me)) : null);
  const nowWeeks = weeklyOf(new Map());
  const roster = adapter.rosters.get(me).map(id => ({ id, ...adapter.players.get(id), starter: adapter.starters.has(id) }));
  if (objective.kind === 'points' && nowWeeks) {
    feasibility = { kind: 'points', ...pointsFeasibility({ target: objective.points_per_week, now: nowWeeks, currentWeek: L.week, roster,
      options: ranked.slice(0, 3).map((p, j) => ({ label: `plan ${j + 1}`, weeks: weeklyOf(p.steps[p.steps.length - 1].state),
        p_complete: p.p_complete, arrive_week: arrivalWeek(p, L.week, { daysLeftInWeek: clock.daysLeftInWeek }),
        give: [...new Set(p.steps.flatMap(s => s.give))], steps: p.steps.length })) }) };
  } else if (objective.kind === 'player') {
    const tp = adapter.players.get(idOf(objective.target)) ?? {};
    feasibility = { kind: 'player', ...targetFeasibility({ target: objective.target, plan: best, currentWeek: L.week,
      deadlineWeek: L.deadline_week, daysLeftInWeek: clock.daysLeftInWeek, injured: !!tp.injury, bye: tp.bye ?? null }) };
  }
  // FEAS-140: a league not planned on points still gets the points question, as its own card
  // (feasibility_points) next to the league's card; a get-player league shows both, unnested.
  const feasibility_points = objective.kind === 'points' ? null : sidePanelFeasibility({ objective, nowWeeks, roster, currentWeek: L.week, env,
    plans: ranked.slice(0, SIDE_OPTIONS).map(p => ({ expected: p.expected, p_complete: p.p_complete,
      arrive_week: arrivalWeek(p, L.week, { daysLeftInWeek: clock.daysLeftInWeek }), weeks: weeklyOf(p.steps[p.steps.length - 1].state),
      give: [...new Set(p.steps.flatMap(s => s.give))], steps: p.steps.length })) });
  const outlook = nowWeeks ? weeklySummary(nowWeeks, 0) : null;

  // Catch-up list.
  const behind = isBehind(now.title, L.team_count ?? adapter.rosters.size);
  const items = [
    ...freeMoves(adapter.freeAgents ?? [], roster.filter(p => p.starter)),
    ...flip.realised.filter(f => f.legs && f.legs.expected > 0).map(f => ({ kind: 'flip', gain: f.legs.expected,
      text: `Buy ${names(f.player)} from Team ${f.a}, sell to Team ${f.b}.`, player: f.player })),
    ...ranked.filter(p => { const m = managers.get(p.steps[0].team) ?? {}; return m.checked_out || (Number.isFinite(m.title_now) && m.title_now < 0.03); })
      .slice(0, 2).map(p => ({ kind: 'desperate', gain: p.expected, steps: p.steps.length, plan_key: firstKey(p), text: `Team ${p.steps[0].team} is out of it: ${p.steps[0].get.map(names).join(' + ')} may come cheap.` })),
    ...(behind ? byMode.all_in.slice(0, 1).map(p => ({ kind: 'swing', gain: p.expected, steps: p.steps.length, plan_key: firstKey(p),
      text: `You are behind: the all-in plan reaches +${(p.delta_final * 100).toFixed(1)} pts if it lands.` })) : []),
    ...playbook.filter(pb => pb.wait.flag === 'wait').map(pb => ({ kind: 'timing', gain: pb.wait.option_value, text: `Wait ${pb.wait.days} days: ${pb.wait.reason}.` })),
    ...(Number.isInteger(L.deadline_week) ? [{ kind: 'timing', gain: null, text: `Trade deadline: week ${L.deadline_week} (${Math.max(0, L.deadline_week - L.week)} weeks left).` }] : []),
  ];
  const catchUp = orderCatchUp(items);

  mark('playbook_and_reports');
  const edge = new Map();
  for (const p of ranked) { const t = String(p.steps[0].team); edge.set(t, Math.max(edge.get(t) ?? 0, p.expected)); }
  const partners = rankPartners(managers, edge, CP ? { counterparts: CP, myIds } : null);
  // The Trade Lab finder's best single offer on the same league, and the composed-rescore probe:
  // both optional adapter hooks (the real adapter runs the served finder; a fixture may not).
  const finder_best = adapter.finderBest ? adapter.finderBest() : null;
  const sanity = adapter.sanity ? adapter.sanity() : null;
  mark('finder_and_sanity');

  return {
    league: L.id, me, seed: adapter.seed, confirm, objective, tolerances: tol,
    now, behind, week: L.week, deadline_week: L.deadline_week ?? null,
    eta_week: best ? arrivalWeek(best, L.week, { daysLeftInWeek: clock.daysLeftInWeek }) : null,
    finder_best, sanity,
    flip, targets: wanted, candidates_scored: plans.length, dropped: dropped.slice(0, 20).map(d => ({ first: d.plan.steps[0], why: d.why })),
    best: publicPlan(best), deck: deckCards.map(c => ({ plan: publicPlan(c.plan), confirm: c.plan.confirm ?? null, playbook: c.playbook, ...(c.playbooks ? { playbooks: c.playbooks } : {}) })),
    backups: backups.map(b => (b ? { step: b.step, expected: b.expected } : null)), playbook,
    suggestions, itinerary, stop_previews: stopPreviews, speed, feasibility, feasibility_points, outlook,
    risk_modes: compareModes(plans, ctxFor), catch_up: catchUp, partners,
    untouchable: { ids: [...untouchable], refused_targets: refused },
    ...(CP ? { counterpart: { status: 'on', models: [...CP.values()].map(publicModel) } } : {}),
    rescores: S.count() + (confirm.rescores ?? 0), runtime_ms: clockNow() - t0, phases_ms: phases,
  };
}
