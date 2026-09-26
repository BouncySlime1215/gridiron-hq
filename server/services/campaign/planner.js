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
import { rankPlans, compareModes, tolerancesFor, MODES, shadowShrink, riskRuleOn, beatsNoTrade as beatsNoTradeUnder } from './modes.js';
import { metricOf, pointsFeasibility, targetFeasibility, weeklySummary } from './objectives.js';
import { priceLadder, stepMessage, replyTable } from './playbook.js';
import { coachMessagesOn } from './messages.js';
import { negotiatorDefaultsOn, defensibleLadder, secondPackage, firmOfferText, negotiationFor, altWithinCap } from './negotiator-defaults.js';
import { buildItinerary, stopTradeOff, arrivalWeek } from './itinerary.js';
import { stopsMode, findHoles, priceHoles } from './stops.js';
import { speedCurve, concededPlan, sideLevers } from './speed.js';
import { deadlineMode, deadlineReport } from './deadline-mode.js';
import { orderCatchUp, freeMoves, isBehind, sellersRead, desperateMoves } from './catchup.js';
import { rankPartners, planSkipWeight, pResponds } from './partners.js';
import { confirmSeed, confirmVerdict, repricePlan } from './confirm.js';
import { probesOn } from '../p-yes-blend.js';
import { waitOrAct, waitOrActOn } from './wait-or-act.js';
import { sidePanelFeasibility, SIDE_OPTIONS } from './feasibility.js';
import { makeScorer, playerValues, flipMap, searchTarget, publicPlan, maxOverpayOf, nickOverpays, newOverpaySink,
  depthPremiumOf, boardOf, newPremiumSink, premiumHolds } from './search.js';
import { makeGetsFloor, heldAtEnd, makeStranded, floorRead, DEFAULT_GET_FLOOR } from './gets-floor.js';
import { AJ_ID, AJ_CARDS_MAX, ajPickOn, givesAj } from './aj-pick.js';
import { PROTECTED_IDS, MODE_LABEL, tierUpGets, upgradeRises, protectedGiven } from './protected-upgrade.js';
import { moveId } from './view.js';
import { ladderFlag, ladderCards, tierOfPlayer } from './ladder.js';
import { withNeverGive, perLeagueRulesOn, resolveLeagueRules } from './never-give.js';
import { reachFlag, reachBound, targetReach, droppedByReason } from './reach.js';
import { excluded } from './partners.js';
import { tradeMemory, applyTradeMemory, memorySummary, stepPasses, floorOn as tmFloorOn, tradeMemoryOn } from './trade-memory.js';
import { searchWideFlag, wideBudget, newWideSink, makeDropOk, claimPoolOf, modesFirstSteps, isClaim, claimProbability,
  claimRule, strandedBranch, CLAIM_CONFIRM_MAX } from './search-wide.js';
import { withCounterparts, targetTilt, priceCap, publicModel, M6_REPLY_PRIOR, M6_LABEL } from '../people/counterpart.js';
import { playoffPathFor } from '../playoff-path.js';
import { wantsOn, wantsShadow } from './wants.js';

/** The his-screen % where the curve's P(yes) first reaches one half (the counterpart's yes point), or null. */
const yesPoint = curve => {
  const hit = (curve ?? []).filter(c => Number.isFinite(c.his_pct) && c.p >= 0.5).sort((a, b) => a.his_pct - b.his_pct)[0];
  return hit ? hit.his_pct : null;
};

export const DECK_SIZE = 5;
const sameIds = (a, b) => a.length === b.length && a.map(String).sort().join() === b.map(String).sort().join();
/** P(accept) curve window on his screen, wider than the finder's so the curve has a shape. */
const CURVE_WINDOW = { low: -35, high: 45 };

const firstKey = p => dealKey(p.steps[0]);

/**
 * LIVE-BLEND: Nick's rule "a served move must beat doing nothing on the confirm dice", read on the
 * GATE p (each step's p_gate: the activity baseline, what GRIDIRON_PYES_BLEND=0 serves; the served
 * p when a step has none, i.e. the clone path). The blend's weights therefore cannot change which
 * moves pass; they move the ranking and the shown P(yes) only. The verdict's shown numbers stay on
 * the served p; `gate` says which p decided 'failed'.
 */
export const STEP_REGRET_ENV = 'GRIDIRON_STEP_REGRET';

/**
 * STEP-REGRET: the index of the first step whose own gain on the confirm dice (its cumulative delta
 * minus the step before's) is not above 0, or -1 when every step gains. A step with no finite delta fails.
 * A free-agent claim step (FLIP-CLAIMS) is a flip piece, not a move on its own: it is exempt here and
 * judged by claim_stranded (the path with the flip declined must still beat doing nothing); the trade
 * step after it must still gain on its own.
 */
export function stepRegretIndex(steps) {
  let before = 0;
  for (let i = 0; i < steps.length; i++) {
    const d = Number(steps[i].delta);
    if (!Number.isFinite(d)) return i;
    if (!isClaim(steps[i]) && !(d - before > 0)) return i;
    before = d;
  }
  return -1;
}

export function confirmGate(planned, reconfirmed) {
  const shown = confirmVerdict(pathExpectation(planned.steps), pathExpectation(reconfirmed.steps));
  // The clone path carries no p_gate: the verdict is today's, object and all.
  if (!planned.steps.some(s => s.p_gate != null)) return shown;
  const gate = steps => steps.map(s => (s.p_gate != null ? { ...s, p: s.p_gate } : s));
  const g = confirmVerdict(pathExpectation(gate(planned.steps)), pathExpectation(gate(reconfirmed.steps)));
  const verdict = g.verdict === 'failed' ? 'failed' : shown.verdict === 'failed' ? g.verdict : shown.verdict;
  return { ...shown, verdict, gate_expected: g.confirmed_expected, gate: 'p_gate' };
}

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
export function backupBranches(best, ranked, ok = null) {
  return best.steps.map((_, i) => {
    const prefix = best.steps.slice(0, i).map(dealKey).join('>');
    // integration-7: ok(plan) -> the plan re-priced on the confirm dice when it still beats doing nothing, else null.
    for (const p of ranked) {
      if (p === best || p.steps.length <= i || p.steps.slice(0, i).map(dealKey).join('>') !== prefix || dealKey(p.steps[i]) === dealKey(best.steps[i])) continue;
      const alt = ok ? ok(p) : p;
      if (alt) return { step: alt.steps[i], expected: alt.expected, plan: alt };
    }
    return null;
  });
}

function priceCurve(adapter, S, vals, step, stateBefore, maxGive, exactDelta, maxOverpay) {
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
    // NO-OVERPAY: the ladder (opening, walk-away) never climbs past Nick's cap on market value given.
    // CAP-1C: above the cap, only the planned premium package itself (the one pair gated on points and title odds).
    if (nickOverpays(gv, getV, maxOverpay) && !(step.depth_premium && sameIds(give, step.give))) continue;
    const pr = adapter.priceStep(step.team, step.get, give);
    const p = pr.p;
    const delta = lin(S.applyTrade(stateBefore, me, step.team, give, step.get)) * scale;
    // LIVE-BLEND (integration-8): each package keeps its own gate p, so a rule that re-checks a ladder package
    // (the second package's confirm-dice gate) reads that package's baseline, never the planned give's.
    out.push({ give, his_pct: his, p, ...(pr.p_gate != null ? { p_gate: pr.p_gate } : {}), delta, nick_gain: p * delta });
  }
  return { curve: out.sort((a, b) => a.his_pct - b.his_pct).slice(0, 60),
    basis: `linear single-player values, rescaled to the exact rescore of the planned package; never past +${Math.round(maxOverpay * 100)}% market value given`
      + (step.depth_premium ? ` (a depth-only 2-for-1 up to its planned +${Math.max(1, Math.round(step.depth_premium.pct * 100))}%)` : '') };
}

/**
 * adapter: see scripts/campaign/league-adapter.mjs (the real one) and test/fixtures (the fake one).
 * settings: { objective, skips ({player, manager} Maps), previous (last entry or null), budget, env,
 *   aj? ({ allow: Set<id>, confirmed: Set<move_id> }, campaign/aj-pick.js: AJ-PICK; absent -> 277 stays locked),
 *   protect? ({ upgrade: Set<id> }, campaign/protected-upgrade.js: the protected players in 'blue_chips_only';
 *     absent -> 160 and 80 stay locked, exactly as before) }
 */
export function planLeague(adapter, settings) {
  // ONE-COUNTERPART (flag GRIDIRON_COUNTERPART or preview, set by the producer): absent -> today's plan, unchanged.
  const CP = adapter.counterparts ?? null;
  if (CP) adapter = withCounterparts(adapter, CP);
  // PER-LEAGUE RULES (flag GRIDIRON_PER_LEAGUE_RULES=1; never-give.js#resolveLeagueRules): the league's own
  // never-give / never-get ids, floor and overpay caps from its objectives row, tighten-only. Off, or no block:
  // null, and every line below runs exactly as before. A block that does not read fails closed: no plan.
  const leagueRules = perLeagueRulesOn(settings.env ?? {}) && settings.objective?.rules != null
    ? resolveLeagueRules(settings.objective.rules) : null;
  if (leagueRules?.errors.length) {
    return { league: adapter.league.id, me: adapter.league.me, error: `league rules block invalid: ${leagueRules.errors.join('; ')}` };
  }
  // NEVER-GIVE: Nico Collins, Chase Brown and A.J. Brown are never offered, notes or no notes.
  adapter = withNeverGive(adapter, leagueRules);
  const clockNow = () => adapter.now?.() ?? 0;
  const t0 = clockNow();
  const phases = {};
  let tp = t0;
  const mark = name => { const t = clockNow(); phases[name] = t - tp; tp = t; };
  const { objective } = settings;
  const env = settings.env ?? {};
  const waitEnabled = waitOrActOn(env);
  // RISK-RULE (shadow, GRIDIRON_RISK_RULE=1): each mode's own decision rule ranks the plans; off, unchanged.
  const rule = riskRuleOn(env);
  // STEP-REGRET: on unless GRIDIRON_STEP_REGRET=0 (a kill switch for one release, not a model choice).
  const stepRegretOn = env?.[STEP_REGRET_ENV] !== '0';
  const budget = { flipTopPer: 3, flipRealise: 6, targets: 3, ...(settings.budget ?? {}) };
  const L = adapter.league;
  const me = L.me;
  const W = adapter.world(adapter.seed);
  if (!W || W.fail) return { league: L.id, me, error: `world failed: ${W?.fail ?? 'no world'}` };
  mark('world');
  const S = makeScorer(W, adapter);
  const base = S.rescore(new Map(), me);
  // U1: title_now's run-to-run SE rides with it when the rescore reports one (null otherwise, never invented).
  const now = { title: base.me.title_before, title_se: Number.isFinite(base.me.title_before_se) ? base.me.title_before_se : null,
    playoff: base.me.playoff_before, metric: metricOf(base.me, objective).before };

  // NO-OVERPAY: Nick's cap on market value given (destination tolerance max_overpay; default 0).
  // An adapter may carry its own cap (adapter.maxOverpay; the pre-cap test fixtures set Infinity); the destination's wins.
  const capOf = (v, rule) => (leagueRules ? Math.min(v, rule) : v);
  const maxOverpay = capOf(maxOverpayOf({ max_overpay: objective.tolerances?.max_overpay ?? adapter.maxOverpay }), leagueRules?.overpay_cap);
  const overpay = newOverpaySink(maxOverpay);
  // GETS-FLOOR (flag GRIDIRON_GETS_FLOOR: 1 on, shadow, unset off): the final get must score 83+ on the blue-chip
  // score. On, a target under the floor is never searched and the next one that passes takes its slot.
  const floor = makeGetsFloor(adapter, { env, tolerances: leagueRules
    ? { ...objective.tolerances, min_get_score: Math.max(objective.tolerances?.min_get_score ?? leagueRules.floor, leagueRules.floor) }
    : objective.tolerances });
  const floorOn = floor.sink.mode === 'on';
  // Every final get (targets, final-leg fillers, flip leg 2) passes through this; null when off.
  const getOk = floor.sink.mode === 'off' ? null : floor.keep;
  // FLIP-STRANDED (flag GRIDIRON_FLIP_STRANDED, on by default): what Nick holds after every leg but the last
  // (a chained path's chip, a flip's leg-1 player) passes the same floor, so a "no" on the next leg never
  // strands him under it. Shadow counts; '0' is off, loudly.
  const stranded = makeStranded(adapter, { env, tolerances: objective.tolerances });
  // CAP-1C: up to +12% on a depth-only 2-for-1 (destination tolerance depth_premium; an adapter may carry its own).
  const depthPremium = capOf(depthPremiumOf({ depth_premium: objective.tolerances?.depth_premium ?? adapter.depthPremium }), leagueRules?.depth_premium_max);
  const board = boardOf(adapter);
  const premium = newPremiumSink(depthPremium, board);
  overpay.depth_premium = premium;
  const vals = playerValues(S, adapter, objective);
  mark('values');
  // REACH-01 (flag GRIDIRON_REACH=1 only; default off): off, the chained finish and flipReach stay at 2 gives
  // and every top-N upgrade is searched, as before. On, both follow the risk mode's max give and a
  // target no package could read fair for is skipped before the top-N slice (reach.js).
  const reachMode = reachFlag(env);
  const reachOn = reachMode !== 'off';
  const objTol = objective.tolerances ?? tolerancesFor(objective.risk_mode);
  // Capped at 3: the search never builds a package bigger than that (combos, maxGiveFinal).
  const chainGive = reachOn ? Math.min(3, Math.max(2, Number(objTol.max_give_per_step) || 2)) : 2;
  const flipAll = flipMap(S, adapter, vals, { topPer: budget.flipTopPer, realise: budget.flipRealise, maxOverpay, maxGive: chainGive, getOk,
    daysLeft: Number.isInteger(L.deadline_week) ? Math.max(1, (L.deadline_week - L.week) * 7) : 1 });
  // TRADE-MEMORY (ONE-PLAN 4c): this season's executed trades, when the adapter carries the ledger.
  // On by default (Nick's rules); only GRIDIRON_TRADE_MEMORY=0 turns it off, and the summary then warns.
  const tmOn = tradeMemoryOn(env);
  const TM = tmOn && adapter.tradeLedger
    ? // FC-VALUE: trade memory compares with trade-day prices on the engine's format scale, so it reads market_value.
    tradeMemory(adapter.tradeLedger, { me, valueNow: id => { const pl = adapter.players.get(id); return Math.max(0, Number(pl?.market_value ?? pl?.value) || 0); },
      positionOf: id => adapter.players.get(id)?.position ?? null,
      holderOf: id => [...adapter.rosters].find(([, ids]) => ids.some(x => String(x) === String(id)))?.[0] ?? null })
    : null;
  const tmCount = { targets: 0, flips: 0, ladderRows: 0, refused: [] };
  const tmFloor = tmFloorOn(env);
  // (a) a flip that buys a player Nick just sold is a buy-back like any other; (c) neither leg may undo a trade.
  const flipFails = f => {
    if (TM.excluded(f.player)) return true;
    if (!f.legs) return false;
    const gx = f.legs.give_a_ids ?? [f.legs.give_a], gy = f.legs.get_b_ids ?? [f.legs.get_b];
    return !stepPasses(TM, { team: f.a, give: gx, get: [f.player] }, tmFloor) || !stepPasses(TM, { team: f.b, give: [f.player], get: gy }, tmFloor);
  };
  // integration-7: the destination's untouchables (objectives file) are never a flip's leg-1 give either.
  const objUntouch = new Set((objective.untouchables ?? []).map(String));
  const flipUntouched = f => !f.legs || !(f.legs.give_a_ids ?? [f.legs.give_a]).some(id => objUntouch.has(String(id)));
  const flipKeep = f => flipUntouched(f) && !(TM && flipFails(f));
  // integration-7: FAIL CLOSED when the league has executed trades this season but the ledger came back
  // missing or empty: Nick's no-buy-back / no-reversal rules cannot be checked, so no move is served.
  const ledgerMissing = tmOn && Number(adapter.executedTradeRows) > 0 && !(adapter.tradeLedger?.trades?.length > 0);
  const flipRuled = ledgerMissing ? { ...flipAll, top: [], realised: [] }
    : TM || objUntouch.size ? { ...flipAll, top: flipAll.top.filter(flipKeep), realised: flipAll.realised.filter(flipKeep) } : flipAll;
  if (TM) tmCount.flips = flipAll.realised.filter(f => flipUntouched(f) && flipFails(f)).length;
  // FLIP-STRANDED: leg 1 buys the player; if leg 2 is turned down Nick keeps him, so he must pass the floor.
  const unstranded = list => list.filter(f => !stranded.flipStrands(f) || !stranded.on);
  const flip = { ...flipRuled, top: unstranded(flipRuled.top), realised: unstranded(flipRuled.realised) };

  mark('flip');
  // Targets: the objective's player, Nick's "get" stops, then the biggest single-player upgrades.
  const skipP = settings.skips?.player ?? new Map();
  const myIds = adapter.rosters.get(me);
  const tiltOf = pid => (CP ? targetTilt(CP, vals.lossO.get(pid)?.team, pid, myIds) : { tilt: 1, exclude: false, features: [] });
  // integration-7: each sold player is counted once, however many times the target list asks about him.
  const soldCounted = new Set();
  const soldOut = pid => { const x = !!TM?.excluded(pid); if (x && !soldCounted.has(String(pid))) { soldCounted.add(String(pid)); tmCount.targets++; } return x; };
  const upgrades = [...vals.addN.entries()].filter(([pid]) => !adapter.managers.get(vals.lossO.get(pid)?.team)?.blocked && !tiltOf(pid).exclude && !soldOut(pid))
    .sort((x, y) => y[1] * (skipP.get(String(y[0])) ?? 1) * tiltOf(y[0]).tilt - x[1] * (skipP.get(String(x[0])) ?? 1) * tiltOf(x[0]).tilt)
    .map(([pid]) => pid);
  // Nick's untouchables (the reader's nick block via the adapter) are never a target, even when asked for.
  const untouchable = adapter.untouchable ?? new Set();
  const refused = [];
  const wanted = [];
  // Shadow scans the same candidates as on (so would_drop matches on's dropped) and serves the unfloored list.
  const floored = n => {
    if (floor.sink.mode === 'off') return upgrades.slice(0, n);
    const out = [];
    for (const pid of upgrades) { if (out.length >= n) break; if (floor.read(pid).passes) out.push(pid); }
    return floorOn ? out : upgrades.slice(0, n);
  };
  const want = (pid, named = false) => {
    if (pid == null) return;
    if (untouchable.has(String(pid))) { if (!refused.includes(String(pid))) refused.push(String(pid)); return; }
    if (wanted.some(w => String(w) === String(pid))) return;
    if (soldOut(pid)) { if (!tmCount.refused.includes(String(pid))) tmCount.refused.push(String(pid)); return; }
    if (named && floorOn && !floor.keep(pid)) { floor.refuse(pid); return; }
    if (!wanted.some(w => String(w) === String(pid))) wanted.push(pid);
  };
  const idOf = s => [...adapter.players.keys()].find(k => String(k) === String(s)) ?? null;
  if (objective.kind === 'player') want(idOf(objective.target), true);
  for (const st of objective.stops) if (st.kind === 'get') want(idOf(st.player), true);
  const pval = id => Math.max(0, Number(adapter.players.get(id)?.value) || 0);
  const bound = reachBound({ mine: myIds.filter(vals.tradable).map(pval),
    outside: [...adapter.rosters].filter(([t]) => t !== me && !excluded(adapter.managers.get(t))).flatMap(([, ids]) => ids.filter(vals.tradable).map(pval)),
    maxGiveDirect: 3, maxGiveChain: chainGive, maxOverpay });
  const reachRows = [];
  const inReach = pid => {
    const r = targetReach(pval(pid), bound);
    reachRows.push({ player: String(pid), owner: vals.lossO.get(pid)?.team != null ? String(vals.lossO.get(pid).team) : null,
      value: pval(pid), need: r.need, in_reach: r.in_reach, min_gives: r.min_gives });
    return r.in_reach;
  };
  // Filtered lazily, so only the upgrades the slice reaches (and the ones it skipped) are reported.
  // integration-7: with REACH on, GETS-FLOOR (on) also skips an under-floor upgrade before the slice.
  const auto = [];
  for (const pid of upgrades) {
    if (auto.length >= budget.targets) break;
    if (untouchable.has(String(pid)) || wanted.some(w => String(w) === String(pid))) continue;
    if (reachOn && !inReach(pid)) continue;
    if (floorOn && !floor.read(pid).passes) continue;
    auto.push(pid);
  }
  for (const pid of reachOn ? auto : floored(budget.targets)) want(pid);
  const ledgerSkipped = ledgerMissing ? { targets: wanted.length, flips: flipAll.realised.length } : null;
  if (ledgerMissing) wanted.length = 0;
  // Shadow: read what is searched, count what the floor would drop, change nothing.
  if (floor.sink.mode === 'shadow') for (const pid of wanted) floor.keep(pid);

  // SEARCH-WIDE (flag GRIDIRON_SEARCH_WIDE=1 only; default off): a league-wide node budget split across the
  // targets, a wider depth 3, laterals held to the floor, claims as steps (search-wide.js). Off: today's search.
  // #406 finding 2: one read of the flag. A real adapter carries it (league-adapter.mjs#buildAdapter read it
  // from the producer's env and built the world on it); the planner follows. Fixtures without it read env.
  const wideOn = (adapter.searchWide ?? searchWideFlag(env)) === 'on';
  const wideSink = wideOn ? newWideSink(wideBudget(env)) : null;
  // Fresh rescores: PRODUCER-FAST cache misses when the adapter has the cache (hits are free), else memo misses.
  const fresh = () => adapter.cacheStats?.()?.misses ?? S.count();
  const fresh0 = wideOn ? fresh() : 0;
  let wideBase = null;
  let claimCtx = null;
  if (wideOn) {
    const tierFloor = floor.sink.floor;
    const scoreOf = typeof adapter.scoreOf === 'function' ? adapter.scoreOf : null;
    const neverDrop = new Set([...untouchable, ...(objective.untouchables ?? [])].map(String));
    // #406 finding 1: a claim carries the league's waiver-win rate as its p; no rate, no claims.
    const claimP = claimProbability(adapter.waiverRecord);
    wideSink.claims.p_yes = claimP;
    // FLIP-CLAIMS: no player Nick sold this season is claimable (whole season, no price-fall exception).
    const soldAll = new Set(TM ? [...TM.sold.keys()].map(String) : []);
    const claimPool = claimP.status === 'ok' ? claimPoolOf(adapter, neverDrop, soldAll) : [];
    wideSink.claims.pool = claimPool.length;
    const dropOk = makeDropOk({ scoreOf, floor: tierFloor, untouchable: neverDrop });
    claimCtx = { dropOk, valueOf: id => adapter.players.get(id)?.value ?? adapter.players.get(Number(id))?.value ?? null,
      maxOverpay, sold: soldAll };
    wideBase = { beam: wideSink.budget.beam, sink: wideSink, claimPool, claimP: claimP.p,
      // #406 finding 5b: LADDER-01 owns the tier; the lateral rule reads it (one classification, not two).
      tierOk: id => tierOfPlayer(scoreOf, id, tierFloor) === 'blue_chip',
      dropOk };
  }
  let plans = [];
  wanted.forEach((target, i) => {
    // Budget fix (#435): both budgets are split across the targets left, as candidates always were, so an
    // early target can no longer spend the whole rescore budget and leave the rest silently unscored.
    let wide = null, r0 = 0, e0 = 0, rShare = 0;
    if (wideOn) {
      r0 = fresh(); e0 = wideSink.used.extras;
      rShare = Math.floor((wideSink.budget.rescores - (r0 - fresh0)) / (wanted.length - i));
      wide = { ...wideBase, candidates: e0 + Math.floor((wideSink.budget.candidates - e0) / (wanted.length - i)),
        rescoresLeft: () => rShare - (fresh() - r0) };
    }
    plans.push(...searchTarget(S, adapter, vals, objective, target, { maxOverpay, overpaySink: overpay, getOk, chainGive,
      depthPremium, board, premiumSink: premium, untouchables: objective.untouchables, wide }));
    if (wide) {
      wideSink.per_target.push({ target: String(target), candidates: wide.candidates - e0, rescores: rShare,
        extras: wideSink.used.extras - e0, rescores_used: fresh() - r0, budget_hit: wide.target_hit ?? null });
    }
  });
  if (wideOn) wideSink.used.rescores = fresh() - fresh0;
  // AJ-PICK (Nick 2026-09-25): A.J. Brown (277) may be given only for a player Nick picked (aj.allow) who is a
  // Blue chip (83+, or the destination's higher floor) on the board now. Those targets are searched once more
  // with 277 on the table; a path is kept only when EVERY step that gives 277 gets one of those picks (never a
  // chip for him). The paths then go through every rule below like any other (FC value, the held floor,
  // FLIP-STRANDED, trade memory, the confirm dice, STEP-REGRET); the overpay cap is 0 (277 is never depth).
  const ajIn = settings.aj ?? null;
  const ajSink = { status: 'off', allow: ajIn?.allow?.size ?? 0, picks: [], refused: [], paths: 0, waiting: 0, confirmed_served: 0 };
  let ajPicks = new Set();
  if (!ajPickOn(env)) ajSink.status = 'off';
  else if (!ajSink.allow) ajSink.status = 'no_picks';
  else if (!myIds.some(id => String(id) === AJ_ID)) ajSink.status = 'not_on_roster';
  else if (ledgerMissing) ajSink.status = 'trade_ledger_missing';
  else if ((objective.untouchables ?? []).map(String).includes(AJ_ID)) ajSink.status = 'objective_untouchable';
  else {
    ajSink.status = 'on';
    const ajFloor = Math.max(DEFAULT_GET_FLOOR, floor.sink.floor);
    const scoreOf = typeof adapter.scoreOf === 'function' ? adapter.scoreOf : null;
    for (const raw of ajIn.allow) {
      const pid = idOf(raw);
      const fr = pid == null ? null : floorRead(scoreOf, pid, ajFloor);
      const owner = pid == null ? null : vals.lossO.get(pid)?.team;
      const why = pid == null ? 'unknown_player' : !fr.passes ? fr.why : owner == null ? 'not_on_another_roster'
        : adapter.managers.get(owner)?.blocked ? 'owner_blocked' : TM?.excluded(pid) ? 'sold_this_season' : null;
      if (why) ajSink.refused.push({ player: String(raw), why, ...(fr?.score != null ? { score: fr.score } : {}) });
      else { ajPicks.add(String(pid)); ajSink.picks.push(String(pid)); }
    }
    if (ajPicks.size) {
      const ajNum = myIds.find(id => String(id) === AJ_ID);
      const without = new Map([[me, adapter.rosters.get(me).filter(id => String(id) !== AJ_ID)]]);
      const lossN = new Map(vals.lossN).set(ajNum, metricOf(S.rescore(without, me).me, objective).delta);
      const tradable = id => vals.tradable(id) || (String(id) === AJ_ID && (Number(adapter.players.get(id)?.value) || 0) > 0);
      const ajAdapter = { ...adapter, untouchable: new Set([...untouchable].filter(id => String(id) !== AJ_ID)), searchStats: null };
      const ajVals = { ...vals, lossN, tradable };
      const stepOk = st => !givesAj(st) || st.get.some(id => ajPicks.has(String(id)));
      for (const target of [...ajPicks].map(idOf)) {
        const found = searchTarget(S, ajAdapter, ajVals, objective, target, { maxOverpay, overpaySink: null, getOk, chainGive,
          depthPremium: 0, board: null, premiumSink: null, untouchables: objective.untouchables, wide: null })
          .filter(p => p.steps.some(givesAj) && p.steps.every(stepOk))
          .map(p => ({ ...p, aj: { for: [...new Set(p.steps.filter(givesAj).flatMap(st => st.get.map(String).filter(id => ajPicks.has(id))))] } }));
        ajSink.paths += found.length;
        plans.push(...found);
      }
    }
  }
  // PROTECTED-UPGRADE (Nick 2026-09-26): a protected player (160, 80) whose setting is 'blue_chips_only' may be
  // given only for a true tier up. The Blue chips whose score AND FantasyCalc value both beat his are searched
  // once more with him on the table; a path is kept only when EVERY step that gives him (a) gets such a player,
  // (b) gives no more market value than it gets (cap 0: a protected star is never depth) with every get 83+, and
  // (c) raises Nick's playoff odds and lineup points on its own, and (coordinator's addition) Nick still holds that
  // tier-up player at the end of the path (never a stepping stone flipped on). The paths then go through every rule below
  // like any other (FC value, the held floor, FLIP-STRANDED, trade memory, the confirm dice, STEP-REGRET), and
  // each is a "Needs your OK" card (AJ-PICK's slot, marked aj.uses) until Nick OKs that exact card.
  const protIn = settings.protect ?? null;
  const protSink = { status: 'off', players: [], targets: [], refused: [], paths: 0,
    gated_out: { not_tier_up: 0, overpay: 0, below_floor: 0, lineup_points: 0, playoff_odds: 0, unread: 0, upgrade_not_kept: 0 }, waiting: 0, confirm_failed: 0 };
  const hardLocked = new Set((objective.untouchables ?? []).map(String));
  const protIds = protIn?.upgrade instanceof Set
    ? [...protIn.upgrade].map(String).filter(id => PROTECTED_IDS.includes(id) && myIds.some(m => String(m) === id)) : [];
  for (const id of protIds.filter(x => hardLocked.has(x))) protSink.refused.push({ player: id, why: 'objective_untouchable' });
  const protOn = protIds.filter(id => !hardLocked.has(id));
  if (!protIn) protSink.status = 'off';
  else if (!protOn.length) protSink.status = 'all_locked';
  else if (ledgerMissing) protSink.status = 'trade_ledger_missing';
  else {
    protSink.status = 'on';
    protSink.players = [...protOn];
    const scoreRow = typeof adapter.scoreOf === 'function' ? adapter.scoreOf : null;
    const scoreNum = id => { const x = scoreRow?.(id); const v = x != null && typeof x === 'object' ? x.score : x; return v == null || !Number.isFinite(Number(v)) ? null : Number(v); };
    const fcOf = id => { const v = adapter.players.get(id)?.value ?? adapter.players.get(Number(id))?.value; return Number.isFinite(v) ? v : null; };
    const protFloor = Math.max(DEFAULT_GET_FLOOR, floor.sink.floor);
    const protSet = new Set(protOn);
    // Targets: a tier up over at least one unlocked protected player, on another roster, dealable, not sold.
    const tiers = new Map();
    for (const [t, ids] of adapter.rosters) {
      if (String(t) === String(me) || adapter.managers.get(t)?.blocked) continue;
      for (const pid of ids) {
        if (untouchable.has(String(pid)) || TM?.excluded(pid)) continue;
        const over = protOn.filter(id => tierUpGets(id, [pid], { scoreOf: scoreNum, fcOf, floor: protFloor }).length);
        if (over.length) tiers.set(pid, over);
      }
    }
    const targets = [...tiers.keys()].sort((a, b) => (scoreNum(b) - scoreNum(a)) || (fcOf(b) - fcOf(a)))
      .slice(0, Math.max(1, budget.targets ?? 4));
    protSink.targets = targets.map(String);
    if (targets.length) {
      const lossN = new Map(vals.lossN);
      for (const id of protOn) {
        const num = myIds.find(m => String(m) === id);
        const without = new Map([[me, adapter.rosters.get(me).filter(m => String(m) !== id)]]);
        lossN.set(num, metricOf(S.rescore(without, me).me, objective).delta);
      }
      const tradable = id => vals.tradable(id) || (protSet.has(String(id)) && (Number(adapter.players.get(id)?.value) || 0) > 0);
      const protAdapter = { ...adapter, untouchable: new Set([...untouchable].filter(id => !protSet.has(String(id)))), searchStats: null };
      const protVals = { ...vals, lossN, tradable };
      // Each step that gives a protected player, checked on (a), (b) and (c); the stamp carries the rise.
      const checkPath = p => {
        let prevMe = null, why = null;
        const steps = p.steps.map(st => {
          const r = S.rescore(st.state, me).me;
          const given = protectedGiven(st, protOn);
          let out = st;
          if (given.length && !why) {
            const fors = given.map(id => tierUpGets(id, st.get, { scoreOf: scoreNum, fcOf, floor: protFloor }));
            const gv = st.give.reduce((a, id) => a + (fcOf(id) ?? Infinity), 0);
            const tv = st.get.reduce((a, id) => a + (fcOf(id) ?? 0), 0);
            const h = upgradeRises(r, prevMe);
            if (fors.some(f => !f.length)) why = 'not_tier_up';
            else if (nickOverpays(gv, tv, 0)) why = 'overpay';
            else if (st.get.some(id => !((scoreNum(id) ?? -1) >= protFloor))) why = 'below_floor';
            else if (!h.ok) why = h.why;
            else out = { ...st, protected_upgrade: { players: given, for: [...new Set(fors.flat())], points_delta: h.points_delta, playoff_delta: h.playoff_delta, confirmed: null } };
          }
          prevMe = r;
          return out;
        });
        if (why) return { why };
        // Coordinator's addition (labelled in the PR): the upgrade is what Nick keeps. A path that gives a
        // protected player and then trades every one of his tier-up gets on (a stepping stone) is refused.
        const held = heldAtEnd(steps);
        if (steps.some(st => st.protected_upgrade && !st.protected_upgrade.for.some(id => held.has(String(id))))) return { why: 'upgrade_not_kept' };
        return { plan: { ...p, steps } };
      };
      for (const target of targets) {
        const found = searchTarget(S, protAdapter, protVals, objective, target, { maxOverpay, overpaySink: null, getOk, chainGive,
          depthPremium: 0, board: null, premiumSink: null, untouchables: objective.untouchables, wide: null })
          .filter(p => p.steps.some(st => protectedGiven(st, protOn).length));
        for (const p of found) {
          const c = checkPath(p);
          if (c.why) { protSink.gated_out[c.why] = (protSink.gated_out[c.why] ?? 0) + 1; continue; }
          const uses = [...new Set(c.plan.steps.flatMap(st => protectedGiven(st, protOn)))];
          const fors = [...new Set(c.plan.steps.flatMap(st => st.protected_upgrade?.for ?? []))];
          protSink.paths += 1;
          plans.push({ ...c.plan, aj: { for: fors, uses, mode: 'blue_chips_only' } });
        }
      }
    }
  }
  // FLIP-CLAIMS: every claim path passes the one claim rule (search-wide.js#claimRule) or is dropped by reason.
  const claimDrops = wideSink?.claims.dropped_by_reason;
  const hasClaim = p => p.steps.some(isClaim);
  const countClaimDrops = (before, after, why) => {
    if (claimDrops) claimDrops[why] += before.filter(hasClaim).length - after.filter(hasClaim).length;
  };
  if (claimCtx) {
    plans = plans.filter(p => {
      const why = hasClaim(p) ? claimRule(p.steps, claimCtx) : null;
      if (why) claimDrops[why]++;
      return !why;
    });
  }
  const skipW = { player: settings.skips?.player ?? new Map(), manager: settings.skips?.manager ?? new Map() };
  plans = plans.map(p => ({ ...p, skip_weight: planSkipWeight(p, skipW) }));
  // FC-VALUE (integration-8): every player a served move gives or gets must carry a FantasyCalc value (the one
  // reader, fc-value.js); none -> the path is not served (fail closed). search.js#playerValues already keeps
  // unpriced players out of targets, gives and flips; this is the backstop and the count.
  const unpricedId = id => { const v = adapter.players.get(id)?.value ?? adapter.players.get(Number(id))?.value; return !(Number.isFinite(v) && v >= 0); };
  const noFc = p => p.steps.some(st => [...st.give, ...st.get].some(unpricedId));
  const fcDropped = plans.filter(p => noFc(p) && !hasClaim(p)).length;
  if (claimDrops) claimDrops.no_fc_value += plans.filter(p => noFc(p) && hasClaim(p)).length;
  if (plans.some(noFc)) plans = plans.filter(p => !noFc(p));
  // GETS-FLOOR (integration-7): a chip picked up on the way and never given on is a final get too. With the
  // floor on, every player Nick still holds at the end of the path (gets minus later gives) must pass it;
  // shadow counts the paths it would drop.
  const failsHeld = p => [...heldAtEnd(p.steps)].some(id => !floor.read(id).passes);
  if (floor.sink.mode !== 'off') {
    const bad = plans.filter(p => failsHeld(p) && !hasClaim(p)).length;
    floor.sink[floorOn ? 'paths_dropped' : 'paths_would_drop'] = bad;
    if (floorOn && claimDrops) claimDrops.floor += plans.filter(p => failsHeld(p) && hasClaim(p)).length;
    if (floorOn) plans = plans.filter(p => !failsHeld(p));
  }
  // FLIP-STRANDED: every holding between legs, too (off: no read; shadow: counted, nothing dropped).
  if (stranded.sink.mode !== 'off') plans = plans.filter(p => !stranded.pathStrands(p) || !stranded.on);
  // (a) sold players, (c) reversals: dropped; (b) floor + currency: shadow unless its flag is on.
  // FLIP-CLAIMS: claim paths go through trade memory on their own, so the served counts are today's.
  const tmApplied = TM ? applyTradeMemory(plans.filter(p => !hasClaim(p)), TM, { env }) : null;
  const tmClaims = TM && claimDrops ? applyTradeMemory(plans.filter(hasClaim), TM, { env }).plans : plans.filter(hasClaim);
  if (claimDrops) countClaimDrops(plans, tmClaims, 'trade_memory');
  if (tmApplied) plans = [...tmApplied.plans, ...tmClaims];
  // #406 finding 3: the War Room has no claim step yet (NextMoveDeck, HeroCard, Negotiate and the
  // "I sent it" flow treat every partner as a team), so a served claim would read "send to free_agent"
  // with send buttons. Until a UI unit renders "Claim X, drop Y", claim paths are SHADOW: scored and
  // reported (search_wide.claims), never ranked into the deck, next move or any served number.
  // FLIP-CLAIMS: they are re-priced on the confirm dice below (stranded branch included) before one is kept.
  let claimPlans = [];
  if (wideSink) {
    claimPlans = plans.filter(hasClaim);
    plans = plans.filter(p => !hasClaim(p));
    wideSink.claims.served = false;
    wideSink.claims.why_not_served = 'the War Room has no claim step yet, so claim paths are shadow (never in the deck)';
  }
  mark('search');

  // AJ-PICK: a path giving 277 that Nick has not OK'd (aj.confirm on its exact move id) never ranks into the
  // deck, the next move, a backup or any served number; it is shown only as a "Needs your OK" card (below).
  const ajConfirmed = ajIn?.confirmed instanceof Set ? ajIn.confirmed : new Set();
  const ajWaitingOf = p => !!p.aj && !ajConfirmed.has(moveId(L.id, p));
  const ajWaiting = plans.filter(ajWaitingOf);
  if (ajWaiting.length) plans = plans.filter(p => !ajWaitingOf(p));

  // Sliders and context per mode.
  const core = new Set([...vals.lossN.entries()].filter(([id]) => adapter.starters.has(id))
    .sort((a, b) => a[1] - b[1]).slice(0, 3).map(([id]) => String(id)));
  const sentThisWeek = new Map([...adapter.managers].map(([t, m]) => [String(t), m.sent_this_week ?? 0]));
  const ctxFor = mode => ({
    tol: mode === objective.risk_mode ? objective.tolerances : tolerancesFor(mode),
    ctx: { originalIds: adapter.rosters.get(me), sentThisWeek, core, untouchables: objective.untouchables, probes: probesOn(env) },
  });
  const pool = objective.kind === 'player' ? plans.filter(p => String(p.target) === String(objective.target)) : plans;
  const { tol, ctx } = ctxFor(objective.risk_mode);
  const { ranked, dropped } = rankPlans(pool, objective.risk_mode, tol, ctx, { rule });

  // Confirm on fresh dice: re-price the deck on an independent seed, show those numbers, drop failures.
  // NO-TRADE-SHRINK: a card must also beat keeping the roster (score 0) under its mode on the fresh dice.
  const cSeed = confirmSeed(adapter.seed, L.id, L.fetched_at ?? '');
  const W2 = adapter.world(cSeed);
  mark('confirm_world');
  let confirm = { seed: cSeed, plan_seed: adapter.seed, status: 'failed', reason: 'confirm world failed' };
  const S2 = W2 && !W2.fail ? makeScorer(W2, adapter) : null;
  // REACH-01: the objective mode's confirm counts (null when the confirm world failed).
  let confirmCounts = null;
  // RB-DELTAS shadow: the active mode's confirm-priced paths (rb-shadow.js logs their steps as served: false).
  let confirmChecked = [];
  // integration-7: one confirm pass for every mode (NO-TRADE-SHRINK) that keeps CAP-1C's premium re-check
  // (a premium step must raise lineup points and title odds on the fresh dice too; no fresh dice, no premium card).
  // One plan re-priced on the confirm dice under a mode (S2 required).
  const priceOnConfirm = (p, mode, tolM, ctxM, active) => {
    const freshMe = p.steps.map(st => S2.rescore(st.state, me).me);
    const fresh = freshMe.map(r => metricOf(r, objective));
    const re = repricePlan(p, fresh);
    // RB-DELTAS shadow: each step's title delta on both estimators (confirm dice), for the shadow table.
    re.steps = re.steps.map((st, i) => (Number.isFinite(freshMe[i]?.title_delta_rb) ? { ...st, title_pair: {
      rb_delta: freshMe[i].title_delta_rb, rb_se: freshMe[i].title_delta_rb_se,
      plain_delta: freshMe[i].title_delta_plain, plain_se: freshMe[i].title_delta_plain_se } } : st));
    // LIVE-BLEND: the verdict that can fail a plan reads each step's gate p (planner.js#confirmGate).
    let v = confirmGate(p, re);
    // CAP-1C: a premium step must still raise lineup points and title odds on fresh dice, or the card goes.
    re.steps = re.steps.map((st, i) => {
      if (!st.depth_premium) return st;
      const h = premiumHolds(freshMe[i], i ? freshMe[i - 1] : null);
      if (!h.ok) v = { ...v, verdict: 'failed', premium_failed: h.why };
      return { ...st, depth_premium: { ...st.depth_premium, confirmed: h.ok ? { points_delta: h.points_delta, title_delta: h.title_delta } : null } };
    });
    if (v.premium_failed && active) premium.confirm_failed++;
    // PROTECTED-UPGRADE: a step that gives a protected player must still raise playoff odds and lineup points on fresh dice.
    re.steps = re.steps.map((st, i) => {
      if (!st.protected_upgrade) return st;
      const h = upgradeRises(freshMe[i], i ? freshMe[i - 1] : null);
      if (!h.ok) v = { ...v, verdict: 'failed', protected_failed: h.why };
      return { ...st, protected_upgrade: { ...st.protected_upgrade, confirmed: h.ok ? { points_delta: h.points_delta, playoff_delta: h.playoff_delta } : null } };
    });
    if (v.protected_failed && active) protSink.confirm_failed++;
    const scored = rankPlans([re], mode, { ...tolM, max_downside_per_step: Infinity }, { ...ctxM, core: null }, { rule }).ranked[0];
    // LIVE-BLEND: "beats doing nothing" is Nick's rule, so it is decided on the gate p too (the served p ranks).
    const onGate = re.steps.some(st => st.p_gate != null)
      ? rankPlans([{ ...re, steps: re.steps.map(st => (st.p_gate != null ? { ...st, p: st.p_gate } : st)) }], mode,
        { ...tolM, max_downside_per_step: Infinity }, { ...ctxM, core: null }, { rule }).ranked[0]
      : scored;
    // STEP-REGRET (Nick 2026-09-25, "every move beats doing nothing", per step): each step must itself gain on the
    // confirm dice given the state after the steps before it. Step deltas are cumulative, so its own gain is
    // delta_i - delta_(i-1); a path with any step at or below 0 is dropped whole (a truncated prefix would leave
    // Nick holding a flip leg the floor never cleared as a final get).
    const regretAt = stepRegretOn ? stepRegretIndex(re.steps) : -1;
    return { ...re, score: scored?.score ?? -Infinity,
      beats_no_trade: regretAt < 0 && beatsNoTradeUnder(onGate, mode, { rule }), mode, confirm: v, planned_on: p,
      ...(regretAt >= 0 ? { step_regret: regretAt } : {}) };
  };
  // Nick's rule, kept apart from the ranking score: the move must beat doing nothing on the confirm dice.
  const beatsNoTrade = p => p.confirm.verdict !== 'failed' && p.beats_no_trade;
  // RISK-RULE: Balanced regret is scored against the other cards that beat doing nothing on the confirm dice.
  const regretRescore = (priced, mode, tolM, ctxM) => {
    if (!rule || mode !== 'balanced') return priced;
    const regretPool = priced.filter(beatsNoTrade);
    const tolR = { ...tolM, max_downside_per_step: Infinity }, ctxR = { ...ctxM, core: null, regretPool };
    return priced.map(q => ({ ...q, score: rankPlans([q], mode, tolR, ctxR, { rule }).ranked[0]?.score ?? -Infinity }));
  };
  const confirmDeck = (rankedM, mode, tolM, ctxM) => {
    const active = mode === objective.risk_mode;
    const top = deckOf(rankedM, DECK_SIZE + 2);
    // integration-7: no confirm dice, no served move (Nick's rule: a move must beat doing nothing on them).
    if (!S2) {
      if (active) premium.confirm_failed += top.filter(p => p.steps.some(st => st.depth_premium)).length;
      return [];
    }
    const priced = regretRescore(top.map(p => priceOnConfirm(p, mode, tolM, ctxM, active)), mode, tolM, ctxM);
    const kept = priced.filter(beatsNoTrade);
    // RB-DELTAS shadow: every path the active mode priced on the confirm dice (served or not), for the table.
    if (active) confirmChecked = priced;
    if (active) {
      const failed = priced.filter(p => p.confirm.verdict === 'failed').length;
      const regret = priced.filter(p => p.confirm.verdict !== 'failed' && p.step_regret != null).length;
      confirmCounts = { checked: top.length, failed, not_above_no_trade: priced.length - failed - kept.length - regret, step_regret: regret };
    }
    return kept.sort((a, b) => (b.score - a.score) || (rule ? b.expected - a.expected : 0)).slice(0, DECK_SIZE);
  };
  // integration-7: backups, BATNAs and catch-up moves come only from plans that beat doing nothing on the
  // confirm dice under the active mode (memoised; null when they do not, or when there are no confirm dice).
  const confirmMemo = new Map();
  const confirmedActive = p => {
    if (!S2) return null;
    if (!confirmMemo.has(p)) { const c = priceOnConfirm(p, objective.risk_mode, tol, ctx, false); confirmMemo.set(p, beatsNoTrade(c) ? c : null); }
    return confirmMemo.get(p);
  };
  const deck = confirmDeck(ranked, objective.risk_mode, tol, ctx);
  // AJ-PICK: the A.J. cards shown after the deck, held to the same confirm-dice gate as a deck card (STEP-REGRET
  // included): first a card Nick OK'd that did not rank into the deck (so an OK never makes it vanish), then the
  // "Needs your OK" cards. The deck's tail makes room (the contract holds MAX_ALTERNATIVES cards); an OK'd A.J.
  // card already in the deck stays.
  const idOfPlan = p => moveId(L.id, p);
  const inDeck = new Set(deck.map(idOfPlan));
  const ajSlot = (pool, n) => (!S2 || !pool.length || n <= 0 ? []
    : deckOf(rankPlans(pool, objective.risk_mode, tol, ctx, { rule }).ranked, n + 2)
      .map(p => priceOnConfirm(p, objective.risk_mode, tol, ctx, false)).filter(beatsNoTrade)
      .sort((a, b) => b.score - a.score).slice(0, n));
  const ajOkdOut = ajSlot(plans.filter(p => p.aj && !inDeck.has(idOfPlan(p))), AJ_CARDS_MAX);
  const ajWaitingCards = ajSlot(ajWaiting, AJ_CARDS_MAX - ajOkdOut.length);
  const ajCards = [...ajOkdOut.map(p => ({ plan: p, waiting: false })), ...ajWaitingCards.map(p => ({ plan: p, waiting: true }))];
  ajSink.waiting = ajWaitingCards.filter(c => !c.aj?.uses).length;
  protSink.waiting = ajWaitingCards.filter(c => c.aj?.uses).length;
  for (let i = deck.length - 1; i >= 1 && deck.length + ajCards.length > DECK_SIZE; i--) if (!deck[i].aj) deck.splice(i, 1);
  ajSink.confirmed_served = deck.filter(p => p.aj).length + ajOkdOut.length;
  // Each mode's pick on the same fresh dice; the active mode's is the served deck itself.
  const confirmedBest = Object.fromEntries(MODES.map(mode => {
    if (mode === objective.risk_mode) return [mode, deck[0] ?? null];
    const c = ctxFor(mode);
    return [mode, confirmDeck(rankPlans(plans, mode, c.tol, c.ctx, { rule }).ranked, mode, c.tol, c.ctx)[0] ?? null];
  }));
  if (S2) confirm = { seed: cSeed, plan_seed: adapter.seed, status: 'ok', rescores: S2.count() };
  mark('confirm_rescore');
  // FLIP-CLAIMS (Nick 2026-09-25): a claim path is kept only when it beats doing nothing on the confirm dice
  // under the active mode, the same gate as a served card. The confirm price holds the stranded branch (the
  // claim went through, the flip leg did not: Nick holds the free agent and has lost the drop) at the flip
  // leg's P(yes). Shadow: after the served confirm counts are taken, so no served number moves.
  if (wideSink) {
    const cd = wideSink.claims.dropped_by_reason;
    const byPlan = [...claimPlans].sort((a, b) => b.expected - a.expected);
    cd.not_confirmed += Math.max(0, byPlan.length - CLAIM_CONFIRM_MAX);
    const kept = [], stranded = [];
    for (const p of byPlan.slice(0, CLAIM_CONFIRM_MAX)) {
      // No confirm dice, no claim (fails closed, as a served card).
      if (!S2) { cd.confirm_failed++; continue; }
      const c = priceOnConfirm(p, objective.risk_mode, tol, ctx, false);
      // confirm.js#confirmVerdict fails exactly when the confirm-dice expected is <= 0: it does not beat doing nothing.
      if (c.confirm.verdict !== 'failed' && !Number.isFinite(c.score)) { cd.mode_tolerance++; continue; }
      if (c.confirm.verdict === 'failed' || !(c.beats_no_trade && c.expected > 0)) { cd.claim_stranded++; stranded.push(c); continue; }
      kept.push(c);
    }
    kept.sort((a, b) => b.expected - a.expected);
    const pathOf = c => ({ expected: c.expected, dice: 'confirm', target: String(c.target), stranded_branch: strandedBranch(c.steps),
      steps: c.steps.map(st => ({ partner: String(st.team), give: st.give.map(String), get: st.get.map(String), p: st.p, delta: st.delta,
        ...(st.claim ? { claim: true } : {}), ...(st.depth_premium ? { depth_premium: st.depth_premium } : {}) })) });
    wideSink.claims.kept = kept.length;
    wideSink.claims.paths = kept.slice(0, 10).map(pathOf);
    wideSink.claims.shadow_best = wideSink.claims.paths[0] ?? null;
    // The closest claim path that lost on the confirm dice (why no claim survives, when none does). Never served.
    const miss = stranded.reduce((b, c) => (b == null || c.expected > b.expected ? c : b), null);
    wideSink.claims.best_stranded = miss ? { ...pathOf(miss), why: 'claim_stranded' } : null;
  }
  // LADDER-01 (flag GRIDIRON_LADDER, default off): ladder cards read the ranked paths (already floored and
  // filtered by trade memory); shadow, they move nothing served. Built after the confirm counts are taken, so
  // their extra confirm rescores change no served count. A backup at a "no" is main's confirmedActive: it must
  // beat doing nothing on the confirm dice, like a deck card; no confirm dice, no backup.
  const ladders = ladderFlag(env) === 'on'
    ? ladderCards(ranked, { mode: objective.risk_mode, scoreOf: adapter.scoreOf ?? null, floor: floor.sink.floor,
      players: adapter.players, untouchable: adapter.untouchable ?? new Set(), objectiveUntouchables: objective.untouchables ?? [],
      memory: TM, env, confirmed: confirmedActive, maxOverpay })
    : null;
  const best = deck[0] ?? null;
  // CAP-1C + integration-7: a backup is re-priced on the confirm dice (premium steps re-checked there) and
  // must beat doing nothing, like a deck card.
  const backupPool = ranked;
  const backups = best ? backupBranches(best.planned_on ?? best, backupPool, confirmedActive) : [];

  // Playbook for every step of the chosen plan, and for each deck card's first step.
  const managers = adapter.managers;
  const names = id => adapter.players.get(id)?.name ?? `player ${id}`;
  const ND = negotiatorDefaultsOn(env);
  // NEGOTIATOR-DEFAULTS: the "Or X for Y" package is the plan with step i's give swapped, and goes out only when
  // that whole plan passes the same rules as a served plan: the overpay cap (above it, only the planned premium
  // package), the held floor (GETS-FLOOR on), trade memory (no buy-back, no reversal) and main's confirm-dice
  // gate (priceOnConfirm + beatsNoTrade: it must beat doing nothing). Returns { alt, dropped }, dropped one of
  // null, 'over_cap', 'path_conflict', 'floor', 'trade_memory', 'confirm_dice'.
  const altValue = id => adapter.players.get(id)?.value;
  const altPlanOf = (plan, i, give, p, pGate) => {
    const base = plan.planned_on ?? plan;
    const steps = [];
    let state = i === 0 ? new Map() : base.steps[i - 1].state;
    for (let k = 0; k < base.steps.length; k++) {
      if (k < i) { steps.push(base.steps[k]); continue; }
      // LIVE-BLEND: the swapped step carries the second package's own gate p (none on the clone path), never
      // the planned give's, so "beats doing nothing" is decided on the right baseline.
      const swapped = () => {
        const { p_gate: _planned, ...rest } = base.steps[k];
        return { ...rest, give, p, ...(pGate != null ? { p_gate: pGate } : {}),
          depth_premium: sameIds(give, base.steps[k].give) ? base.steps[k].depth_premium : undefined };
      };
      const st = k === i ? swapped() : base.steps[k];
      const mine = new Set(S.rosterOf(state, me).map(String));
      if (st.give.some(id => !mine.has(String(id)))) return null;
      state = S.applyTrade(state, me, st.team, st.give, st.get);
      const r = metricOf(S.rescore(state, me).me, objective);
      steps.push({ ...st, state, delta: r.delta, se: r.se, clears: r.clears });
    }
    return { ...base, steps, ...pathExpectation(steps) };
  };
  const confirmAlt = (alt, plan, i) => {
    if (!alt) return { alt: null, dropped: null };
    const st = plan.steps[i];
    if (!altWithinCap({ give: alt.give, step: st, valueOf: altValue, maxOverpay })) return { alt: null, dropped: 'over_cap' };
    const ap = altPlanOf(plan, i, alt.give, alt.p, alt.p_gate);
    if (!ap) return { alt: null, dropped: 'path_conflict' };
    if (floorOn && failsHeld(ap)) return { alt: null, dropped: 'floor' };
    if (TM && !applyTradeMemory([ap], TM, { env }).plans.length) return { alt: null, dropped: 'trade_memory' };
    if (!S2) return { alt: null, dropped: 'confirm_dice' };
    const c = priceOnConfirm(ap, objective.risk_mode, tol, ctx, false);
    if (!beatsNoTrade(c)) return { alt: null, dropped: 'confirm_dice' };
    return { alt: { ...alt, confirm_expected: c.expected }, dropped: null };
  };
  const who = id => { const p = adapter.players.get(id) ?? adapter.players.get(Number(id)); return { name: p?.name ?? `player ${id}`, position: p?.position ?? null }; };
  const playbookFor = (plan, i, backup) => {
    const st = plan.steps[i];
    // SEARCH-WIDE: a free-agent claim has nobody to ask, so no price ladder, message or reply table.
    if (isClaim(st)) return claimPlaybook(st, i, plan.steps.length);
    const stateBefore = i === 0 ? new Map() : plan.steps[i - 1].state ?? (plan.planned_on?.steps[i - 1].state) ?? new Map();
    const priced = priceCurve(adapter, S, vals, st, stateBefore, tol.max_give_per_step, st.delta, maxOverpay);
    const m = managers.get(st.team) ?? {};
    // Nick's "hard" read is applied ONCE (RULINGS 17): FIX-02c's hard shift when the adapter carries his block
    // (m.nick, the real producer); otherwise the counterpart's cap at fair on his screen (the same reader flag).
    const cap = CP && !m.nick?.hard ? priceCap(CP.get(String(st.team))) : null;
    const capped = cap ? priced.curve.filter(c => c.his_pct <= cap.max_his_pct) : priced.curve;
    // TRADE-MEMORY: the ladder (opening, walk-away, the counters the reply table names) is held to the
    // same rules as the planned step: no package that undoes a trade, none under his floor with the flag on.
    const allowed = objUntouch.size ? capped.filter(c => !c.give.some(id => objUntouch.has(String(id)))) : capped;
    const curve = TM ? allowed.filter(c => stepPasses(TM, { team: st.team, give: c.give, get: st.get }, tmFloor)) : allowed;
    if (TM) tmCount.ladderRows += allowed.length - curve.length;
    const basis = cap ? `${priced.basis}; capped at ${cap.max_his_pct}% on his screen (nick_override)` : priced.basis;
    const priced0 = priceLadder(curve, { batna: Math.max(0, backup?.expected ?? 0), mode: objective.risk_mode, hard: !!m.nick?.hard });
    // NEGOTIATOR-DEFAULTS (flag, default off): a defensible opening, a second genuine package, the firm text.
    const ladder = ND ? defensibleLadder(priced0) : priced0;
    const offer = ladder.opening ? { ...st, give: ladder.opening.give } : st;
    const altChecked = ND ? confirmAlt(secondPackage(ladder), plan, i) : { alt: null, dropped: null };
    const alt = altChecked.alt;
    const holes = Array.isArray(m.needs) ? m.needs : m.needs ? Object.keys(m.needs) : [];
    const message = ND
      ? { text: firmOfferText({ who, give: offer.give, get: st.get, alt: alt?.give ?? null, holes }), facts: [], checked: true, source: 'template' }
      : stepMessage(offer, { players: adapter.players, needs: m.needs ?? null });
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
      ...(ND ? { negotiation: negotiationFor({ who, give: offer.give, get: st.get, ladder, alt, altDropped: altChecked.dropped, holes, sendWhen: m.send_when, message: message.text }) } : {}),
      ...(CP ? (() => {
        const ps = adapter.priceStep(offer.team, offer.get, offer.give);
        return { counterpart: { reply_mix: { ...M6_REPLY_PRIOR }, label: M6_LABEL, p_accept_challenger: ps.p,
          p_accept_served: ps.p_before_counterpart ?? ps.p, yes_point_his_pct: yesPoint(curve),
          reason_chain: [...(ps.features ?? []), ...(cap ? [cap.feature] : [])] } };
      })() : {}),
    };
  };
  const claimPlaybook = (st, i, n) => ({
    step_index: i, of_steps: n, claim: true,
    message: { text: `Claim ${names(st.get[0])} off free agency and drop ${names(st.give[0])}.`, facts: [] },
    ladder: { opening: null, walk_away: null, reason: 'a free-agent claim has no price', basis: 'free agent: no counterpart' },
    nick_shift: null, opening: null, walk_away: null, replies: [], send_when: null,
    wait: waitOrAct(st, adapter.players, { enabled: waitEnabled }),
  });
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
    const br = p.steps.length > 1 ? backupBranches(p.planned_on ?? p, backupPool, confirmedActive) : [];
    const pbs = p.steps.map((_, i) => playbookFor(p, i, i === 0
      ? (deck[j + 1] ? { step: deck[j + 1].steps[0], expected: deck[j + 1].expected } : null) : br[i] ?? null));
    return { plan: p, playbook: pbs[0], playbooks: pbs };
  });
  // AJ-PICK: each "Needs your OK" card gets its own playbook (no BATNA: it is never the move a decline falls to).
  for (const { plan: p, waiting } of ajCards) {
    const pbs = allSteps ? p.steps.map((_, i) => playbookFor(p, i, null)) : [playbookFor(p, 0, null)];
    deckCards.push({ plan: p, playbook: pbs[0], ...(allSteps ? { playbooks: pbs } : {}), aj_waiting: waiting });
  }

  // Suggested targets: gain if landed x P(reach) x skip weight, with mode fit.
  const rankedByMode = Object.fromEntries(MODES.map(mode => { const c = ctxFor(mode); return [mode, rankPlans(plans, mode, c.tol, c.ctx, { rule })]; }));
  const byMode = Object.fromEntries(MODES.map(mode => [mode, rankedByMode[mode].ranked]));
  const suggestions = floored(5).map(pid => {
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
  // Speed levers priced on the same ranked paths: the walk-away price of the best plan (its playbook
  // ladder) and the all-in mode's best plan are the two re-priced routes (speed.js).
  const conceded = best && playbook[0] ? concededPlan(best.planned_on ?? best, playbook[0].ladder) : null;
  const speed = speedCurve({ ranked, conceded, allIn: byMode.all_in[0] ?? null }, clock);
  // TM-34 DEADLINE MODE (GRIDIRON_DEADLINE_MODE, shadow only, default off): countdown, send_by per deck step,
  // last-call offer per partner, hold list, who goes quiet and the cost of waiting, all on the ranked paths.
  const dlM = deadlineMode(env);
  const deadline = dlM === 'off' ? undefined : deadlineReport({ mode: dlM, deadlineAt: L.deadline_at ?? null,
    reviewHours: L.review_hours ?? null, now: settings.now ?? clockNow(), currentWeek: L.week, deadlineWeek: L.deadline_week ?? null,
    ranked, deck, managers, roster: adapter.rosters.get(me) ?? [], excluded,
    blocked: new Set([...(adapter.untouchable ?? []), ...(objective.untouchables ?? [])].map(String)) });

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
  // STOPS-01 (GRIDIRON_STOPS: 1 serves, shadow reports, default off): bye / injury holes in Nick's weekly lineup,
  // each priced as a plan-added stop on the ranked (rule-filtered) plans; off, nothing is computed.
  const stopsM = stopsMode(env);
  let stops;
  if (stopsM !== 'off') {
    const holes = nowWeeks ? findHoles({ weeks: nowWeeks, roster, currentWeek: L.week }) : [];
    const blocked = new Set([...(adapter.untouchable ?? []), ...(objective.untouchables ?? [])].map(String));
    stops = { mode: stopsM, holes, rows: priceHoles({ holes, ranked, nowWeeks, currentWeek: L.week, daysLeftInWeek: clock.daysLeftInWeek,
      weeklyOf: p => weeklyOf(p.steps[p.steps.length - 1].state), names: id => names(idOf(id)), blocked,
      // integration-10a: priced against the served move's plan, covers only from plans that beat doing nothing on the confirm dice.
      served: best?.planned_on ?? best ?? null, confirmed: p => !!confirmedActive(p) }) };
  }

  // Catch-up list.
  const behind = isBehind(now.title, L.team_count ?? adapter.rosters.size);
  const free = freeMoves(adapter.freeAgents ?? [], roster.filter(p => p.starter));
  const sellers = sellersRead(managers);
  // integration-7: each seller's move is the first plan through him that beats doing nothing on the confirm dice.
  const desperatePool = sellers.map(sl => { for (const p of ranked) if (String(p.steps[0]?.team) === sl.team) { const c = confirmedActive(p); if (c) return c; } return null; }).filter(Boolean);
  const desperate = desperateMoves(desperatePool, sellers, { names,
    playerValue: id => adapter.players.get(id)?.value, pResponds: t => pResponds(managers.get(t)).p });
  // integration-7: a flip in the catch-up list is priced on the confirm dice (both legs), or not listed.
  const flipOnConfirm = f => {
    if (!S2) return null;
    const gx = f.legs.give_a_ids ?? [f.legs.give_a], gy = f.legs.get_b_ids ?? [f.legs.get_b];
    const s1 = S2.applyTrade(new Map(), me, f.a, gx, [f.player]);
    const s2 = S2.applyTrade(s1, me, f.b, [f.player], gy);
    const r1 = S2.rescore(s1, me, f.a), r2 = S2.rescore(s2, me, f.b);
    return pathExpectation([{ p: f.legs.p1, delta: r1.me.title_delta }, { p: f.legs.p2, delta: r2.me.title_delta, se: r2.me.title_delta_se }]).expected;
  };
  const items = [
    ...free,
    ...flip.realised.map(f => (f.legs ? { ...f, confirmed_expected: flipOnConfirm(f) } : f))
      .filter(f => f.legs && f.confirmed_expected > 0).map(f => ({ kind: 'flip', gain: f.confirmed_expected,
      text: `Buy ${names(f.player)} from Team ${f.a}, sell to Team ${f.b}.`, player: f.player })),
    ...desperate.items,
    ...(behind ? [confirmedBest.all_in].filter(Boolean).map(p => ({ kind: 'swing', gain: p.expected, steps: p.steps.length, plan_key: firstKey(p),
      text: `You are behind: the all-in plan reaches +${(p.delta_final * 100).toFixed(1)} pts if it lands.` })) : []),
    ...playbook.filter(pb => pb.wait.flag === 'wait').map(pb => ({ kind: 'timing', gain: pb.wait.option_value, text: `Wait ${pb.wait.days} days: ${pb.wait.reason}.` })),
    ...(Number.isInteger(L.deadline_week) ? [{ kind: 'timing', gain: null, text: `Trade deadline: week ${L.deadline_week} (${Math.max(0, L.deadline_week - L.week)} weeks left).` }] : []),
  ];
  const catchUp = orderCatchUp(items);

  mark('playbook_and_reports');
  const edge = new Map();
  for (const p of ranked) { const t = String(p.steps[0].team); edge.set(t, Math.max(edge.get(t) ?? 0, p.expected)); }
  // PARTNER-KERNEL: the league lets rankPartners build the who-trades-with-whom kernel when its flag is on
  // (off: output unchanged). A fixture league without a season gets no kernel.
  const partners = rankPartners(managers, edge, CP ? { counterparts: CP, myIds } : null, { league: { id: L.id, me, season: L.season } });
  // The Trade Lab finder's best single offer on the same league, and the composed-rescore probe:
  // both optional adapter hooks (the real adapter runs the served finder; a fixture may not).
  const finder_best = adapter.finderBest ? adapter.finderBest() : null;
  const sanity = adapter.sanity ? adapter.sanity() : null;
  mark('finder_and_sanity');

  return {
    league: L.id, me, seed: adapter.seed, confirm, objective, tolerances: { ...tol, max_overpay: maxOverpay, depth_premium: depthPremium },
    no_overpay: overpay,
    gets_floor: floor.sink,
    flip_stranded: stranded.sink,
    now, behind, week: L.week, deadline_week: L.deadline_week ?? null,
    eta_week: best ? arrivalWeek(best, L.week, { daysLeftInWeek: clock.daysLeftInWeek }) : null,
    finder_best, sanity,
    flip, targets: wanted, candidates_scored: plans.length, dropped: dropped.slice(0, 20).map(d => ({ first: d.plan.steps[0], why: d.why })),
    confirm_checked: confirmChecked.filter(p => p.steps.some(st => st.title_pair)).map(p => ({ target: p.target ?? null,
      steps: p.steps.map(st => ({ team: st.team, give: st.give, get: st.get, delta: st.delta, title_pair: st.title_pair ?? null })) })),
    best: publicPlan(best), deck: deckCards.map(c => ({ plan: publicPlan(c.plan), confirm: c.plan.confirm ?? null, playbook: c.playbook, ...(c.playbooks ? { playbooks: c.playbooks } : {}),
      ...(c.plan.aj ? { aj: { for: c.plan.aj.for, requires_nick_confirm: true, nick_confirmed: !c.aj_waiting,
        ...(c.plan.aj.uses ? { uses: c.plan.aj.uses, mode: c.plan.aj.mode, label: `Uses ${c.plan.aj.uses.map(id => adapter.players.get(id)?.name ?? adapter.players.get(Number(id))?.name ?? id).join(' and ')}, ${MODE_LABEL[c.plan.aj.mode]}` } : {}) } } : {}) })),
    aj_pick: ajSink,
    protected_upgrade: protSink,
    backups: backups.map(b => (b ? { step: b.step, expected: b.expected } : null)), playbook,
    suggestions, itinerary, stop_previews: stopPreviews, ...(stops ? { stops } : {}), ...(deadline ? { deadline } : {}), speed, feasibility, feasibility_points, outlook,
    risk_modes: compareModes(plans, ctxFor, mode => ({ best: confirmedBest[mode], confirmed: !!S2 }), { rule }), catch_up: catchUp, partners,
    // NO-TRADE-SHRINK: pre-rank shrinkage, SHADOW (reported under _run.shrink; nothing served reads it).
    shrink: shadowShrink(plans, ctxFor),
    // PLAYOFF-SEEDING (shadow, GRIDIRON_PLAYOFF_SEEDING): the world's seed values, win targets and must-win
    // weeks for Nick (ids only); the producer writes it to _run.inputs.playoff_path and nothing served reads it.
    playoff_path: playoffPathFor(W.base, me),
    untouchable: { ids: [...untouchable], refused_targets: refused },
    ...(ladders ? { ladders } : {}),
    // LIVE-BLEND: which P(yes) the adapter served, with each model's weight and record (plans.json p_yes_basis).
    p_yes_basis: adapter.pYesBasis ?? null,
    // REACH-01: diagnostics only (no number is priced here); the producer writes them to _run.inputs.reach.
    reach: { flag: reachMode, targets_budget: budget.targets, chain_give: chainGive,
      bound: { direct: bound.direct, chain: bound.chain, best: bound.best }, targets: reachRows,
      // The objective mode counts the pool its deck was ranked from (a get-player objective keeps only that target's paths).
      // integration-7: named drops_by_gate so `dropped_by_reason` means one thing (the served _run count).
      drops_by_gate: droppedByReason({ candidates: plans.length, byMode: { ...rankedByMode, [objective.risk_mode]: { ranked, dropped } },
        objectiveMode: objective.risk_mode, notObjectiveTarget: plans.length - pool.length,
        confirm: confirmCounts, noOverpay: overpay.rejected, outOfReach: reachRows.filter(r => !r.in_reach).length }) },
    ...(wideSink ? { search_wide: { ...wideSink, ...modesFirstSteps(confirmedBest, dealKey) } } : {}),
    ...(ledgerSkipped ? { trade_ledger_missing: { executed_rows: Number(adapter.executedTradeRows), ...ledgerSkipped } } : {}),
    // FC-VALUE: rostered players with no FantasyCalc value (never searched) and paths dropped for one.
    no_fc_value: { players: (adapter.valueSource?.unpriced ?? []).length, paths: fcDropped,
      ...(adapter.valueSource ? { status: adapter.valueSource.status, source: adapter.valueSource.source,
        ...(adapter.valueSource.reason ? { reason: adapter.valueSource.reason } : {}) } : {}) },
    trade_memory: memorySummary(tmOn ? (ledgerMissing ? 'ledger_missing' : TM) : 'off', { dropped: tmApplied?.dropped ?? {}, shadow: tmApplied?.shadow ?? {}, floorOn: tmApplied?.floor_on ?? false,
      targets: tmCount.targets, flips: tmCount.flips, ladderRows: tmCount.ladderRows, refused: tmCount.refused, unmapped: adapter.tradeLedger?.unmapped ?? 0 }),
    // HIS-SIDE-WIRE: ESPN's trade block as the adapter read it (null: not read); the view reads it per target.
    trade_block: adapter.tradeBlock ?? null,
    // CHAT-TRADE-INTEREST (shadow): the adapter's read of chat_trade_interest (null: not read).
    chat_interest: adapter.chatInterest ?? null,
    // U8 WANTS-MENU (flag GRIDIRON_WANTS=1 only, SHADOW): stated vs revealed menus and the tie-break it would make; nothing served reads it.
    ...(wantsOn(env) ? { wants: wantsShadow(adapter, { me, ranked, models: CP ? [...CP.values()].map(publicModel) : null,
      sold: TM ? new Set([...TM.sold.keys()]) : null }) } : {}),
    ...(CP ? { counterpart: { status: 'on', models: [...CP.values()].map(publicModel) } } : {}),
    sellers: { read: sellers, unreached: desperate.unreached.map(s => s.team) },
    speed_levers: sideLevers({ free, waits: playbook.map(pb => pb.wait) }),
    rescores: S.count() + (confirm.rescores ?? 0), runtime_ms: clockNow() - t0, phases_ms: phases,
  };
}
