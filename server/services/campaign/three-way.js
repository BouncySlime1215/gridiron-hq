/**
 * THREE-WAY CYCLES (Batch D item 21, research M4): when no bilateral deal clears, search A -> B -> C
 * cycles executed as two linked two-team trades (ESPN has no multi-team trade), with Nick in both:
 *   leg 1: Nick gives X to team B for Y   (B's player that C values)
 *   leg 2: Nick gives Y (+ at most one of his own) to team C for Z, the target
 * Both legs are PRE-AGREED before leg 1 is sent, so the cycle completes with P(B yes) x P(C yes)
 * (the joint P(complete)) and a "no" from either leaves Nick where he started. Ranked by the paired
 * title-odds gain (the planning dice, the same world every served plan is priced on) x that joint P.
 *
 * Nick's rules, every leg and every holding in between (a pre-agreed leg 2 can still be withdrawn
 * after leg 1 executes, so what Nick holds between legs must be safe to be stuck with):
 *   - never give: X and the leg-2 extra come only from vals.tradable minus the untouchables
 *     (adapter.untouchable carries never-give.js's pins via withNeverGive, plus the objective's own);
 *   - never get / no buy-backs: Y and Z are never untouchable (Olave, 290) nor sold this season (trade memory);
 *   - the Blue chip floor on the final get Z (GETS-FLOOR) AND on Y, held between legs (FLIP-STRANDED's
 *     rule, floorRead: unscored fails closed);
 *   - no overpay on either leg, cap 0 (the +12% depth-only 2-for-1 premium is never used here);
 *   - trade memory per leg (no reversal of an executed trade), the planner's stepPasses;
 *   - and the backstop: never-give.js#ruleVerdict on each leg, from Nick's side.
 *
 * SHADOW ONLY. Flag GRIDIRON_THREE_WAY: unset/'0' off (no key in the result, served output
 * byte-identical); 'shadow' (or '1', the same until the pass bar is met) searches and reports under
 * _run.inputs.three_way. Nothing here enters the deck, the next move or any served number.
 * Pure: no DB, no env read, no clock.
 */
import { screenFair, fairBand, onesInBand, pairsInBand, linearNick, dealKey, pathExpectation, NOISE_K } from './paths.js';
import { nickOverpays } from './search.js';
import { floorRead, getFloorOf } from './gets-floor.js';
import { ruleVerdict, PINNED_NEVER_GIVE, PINNED_NEVER_GET } from './never-give.js';
import { excluded } from './partners.js';

export const THREE_WAY_ENV = 'GRIDIRON_THREE_WAY';

/** 'shadow' ('shadow' or '1') | 'off' (unset, '0', anything else). */
export function threeWayFlag(env = {}) {
  const v = env?.[THREE_WAY_ENV];
  return v === 'shadow' || v === '1' ? 'shadow' : 'off';
}

/** Search budget: candidates exact-rescored per target, rows kept in the report, leg-2 extras tried. */
export const CYCLE_DEFAULTS = Object.freeze({ exactPerTarget: 12, keep: 10, maxExtra: 1 });

/** Why a candidate cycle was not kept (every enumerated candidate lands in exactly one bucket or is kept). */
export const CYCLE_DROPS = Object.freeze(['floor_between', 'floor_final', 'overpay', 'unfair_screen', 'trade_memory',
  'rule_gate', 'not_better']);

const S_ = x => String(x);

/** A bilateral deal clears when a served plan (the confirmed best or a deck card) is a single trade. */
export function bilateralClears(plans) {
  return (plans ?? []).some(p => p && Array.isArray(p.steps) && p.steps.length === 1);
}

/**
 * never-give.js#ruleVerdict's rules object from the planner's own inputs (no DB): the pinned ids plus
 * the objective's untouchables, the pinned never-gets, the season's sold set, the adapter's market
 * value (FantasyCalc, fc_value) and the blue-chip score. The rules read here are the same the gate reads.
 */
export function cycleRules(adapter, { untouchables = [], sold = new Set() } = {}) {
  const fc = new Map();
  for (const [id, p] of adapter.players) { const v = Number(p?.value); if (Number.isFinite(v) && v >= 0) fc.set(S_(id), v); }
  const scoreOf = typeof adapter.scoreOf === 'function' ? id => { const r = adapter.scoreOf(id); const s = Number(r?.score); return r?.score != null && Number.isFinite(s) ? s : null; } : () => null;
  return { neverGive: new Set([...PINNED_NEVER_GIVE, ...untouchables.map(S_)]), neverGet: new Set(PINNED_NEVER_GET),
    sold: new Set([...sold].map(S_)), fc, scoreOf, closed: null };
}

/**
 * The cycle search for one league run.
 * S: makeScorer (planning dice); S2: the confirm scorer or null. vals: playerValues.
 * ctx: { targets, maxOverpay, tolerances, untouchables, soldOut(id), legOk(step), sold, opts }
 * -> { rows (top `keep`, ranked), sink counts }
 */
export function findCycles(S, S2, adapter, vals, ctx) {
  const o = { ...CYCLE_DEFAULTS, ...(ctx.opts ?? {}) };
  const me = adapter.league.me;
  const P = adapter.players;
  const val = id => Math.max(0, Number(P.get(id)?.value) || 0);
  const worth = ids => ids.reduce((s, id) => s + val(id), 0);
  // Nick's cap is 0 here whatever the adapter carries (the premium needs its own points/title gate).
  const cap = Math.min(Number.isFinite(ctx.maxOverpay) ? ctx.maxOverpay : 0, 0);
  const floor = getFloorOf(ctx.tolerances);
  const scoreOf = typeof adapter.scoreOf === 'function' ? adapter.scoreOf : null;
  const floorOk = id => floorRead(scoreOf, id, floor).passes;
  const untouchable = new Set([...(adapter.untouchable ?? []), ...(ctx.untouchables ?? [])].map(S_));
  const usable = id => vals.tradable(id) && !untouchable.has(S_(id));
  const soldOut = ctx.soldOut ?? (() => false);
  const legOk = ctx.legOk ?? (() => true);
  const rules = cycleRules(adapter, { untouchables: ctx.untouchables ?? [], sold: ctx.sold ?? new Set() });
  const open = t => t !== me && !excluded(adapter.managers.get(t)) && !adapter.managers.get(t)?.checked_out
    && !adapter.managers.get(t)?.blocked;
  const origMine = adapter.rosters.get(me);
  const mine = origMine.filter(usable);
  const drops = Object.fromEntries(CYCLE_DROPS.map(k => [k, 0]));
  const sink = { enumerated: 0, exact_scored: 0, dropped_by_reason: drops, per_target: [] };
  const rows = [];

  for (const Z of ctx.targets ?? []) {
    const C = S.ownerOf(new Map(), Z);
    const per = { target: S_(Z), owner: C == null ? null : S_(C), enumerated: 0, kept: 0 };
    sink.per_target.push(per);
    if (C == null || !open(C) || !usable(Z) || soldOut(Z)) continue;
    if (!floorOk(Z)) { drops.floor_final++; continue; }
    const zv = val(Z);
    const cands = [];
    for (const B of adapter.rosters.keys()) {
      if (B === C || !open(B)) continue;
      for (const Y of adapter.rosters.get(B).filter(usable)) {
        per.enumerated++; sink.enumerated++;
        if (soldOut(Y)) { drops.trade_memory++; continue; }
        // FLIP-STRANDED: Nick holds Y between the legs, so Y must pass the same floor as a final get.
        if (!floorOk(Y)) { drops.floor_between++; continue; }
        // Leg-2 packages: Y alone, or Y plus one of Nick's (never an untouchable); the fairest in-cap one per Y.
        const extras = [[], ...(o.maxExtra > 0 ? mine.map(m => [m]) : [])].filter(e => screenFair(worth([Y, ...e]), zv));
        if (!extras.length) { drops.unfair_screen++; continue; }
        const capped = extras.filter(e => !nickOverpays(worth([Y, ...e]), zv, cap));
        if (!capped.length) { drops.overpay++; continue; }
        let built = null, why = null;
        for (const extra of capped) {
          const give2 = [Y, ...extra];
          const left = mine.filter(id => !extra.includes(id)).map(id => ({ id, value: val(id) }));
          const band = fairBand(val(Y));
          const gives1 = [...onesInBand(left, band), ...pairsInBand(left, band, { limit: 60 })];
          const inCap = gives1.filter(g => !nickOverpays(worth(g), val(Y), cap));
          if (!gives1.length) { why ??= 'unfair_screen'; continue; }
          if (!inCap.length) { why = 'overpay'; continue; }
          const cost = g => g.reduce((s, id) => s + (vals.lossN.get(id) ?? 0), 0);
          const X = inCap.sort((a, b) => cost(b) - cost(a) || a.length - b.length)[0];
          const legs = [{ team: B, give: X, get: [Y] }, { team: C, give: give2, get: [Z] }];
          if (!legs.every(legOk)) { why = 'trade_memory'; continue; }
          if (!legs.every(l => ruleVerdict(rules, { give: l.give, get: l.get }).ok)) { why = 'rule_gate'; continue; }
          const p1 = adapter.priceStep(B, [Y], X).p, p2 = adapter.priceStep(C, [Z], give2).p;
          const s1 = S.applyTrade(new Map(), me, B, X, [Y]);
          const s2 = S.applyTrade(s1, me, C, give2, [Z]);
          const lin = linearNick(S.rosterOf(s2, me), origMine, vals.addN, vals.lossN);
          const c = { legs, s1, s2, p1, p2, lin, key: legs.map(dealKey).join('>') };
          if (!built || c.lin * c.p1 * c.p2 > built.lin * built.p1 * built.p2) built = c;
        }
        if (built) cands.push(built); else drops[why ?? 'unfair_screen']++;
      }
    }
    // Exact rescore of the best linear x joint P candidates (one distinct cycle each).
    const seen = new Set();
    const top = cands.sort((a, b) => b.lin * b.p1 * b.p2 - a.lin * a.p1 * a.p2)
      .filter(c => (seen.has(c.key) ? false : seen.add(c.key))).slice(0, o.exactPerTarget);
    drops.not_better += cands.length - top.length;
    for (const c of top) {
      sink.exact_scored++;
      const r1 = S.rescore(c.s1, me, c.legs[0].team).me, r2 = S.rescore(c.s2, me, c.legs[1].team).me;
      const delta = r2.title_delta, se = r2.title_delta_se ?? null;
      if (!(delta > 0)) { drops.not_better++; continue; }
      const pJoint = c.p1 * c.p2;
      const conf = S2 ? S2.rescore(c.s2, me, c.legs[1].team).me : null;
      per.kept++;
      rows.push({ target: S_(Z), legs: c.legs.map(l => ({ team: S_(l.team), give: l.give.map(S_), get: l.get.map(S_) })),
        between: { holds: S_(c.legs[0].get[0]), title_delta: r1.title_delta },
        p1: c.p1, p2: c.p2, p_joint: pJoint, title_delta: delta, title_se: se,
        clears: se != null && delta > NOISE_K * se,
        expected: pJoint * delta, rank_score: pJoint * delta,
        // The same two legs sent one after the other (not pre-agreed): a "no" on leg 2 strands leg 1.
        sequential_expected: pathExpectation([{ p: c.p1, delta: r1.title_delta }, { p: c.p2, delta, se }]).expected,
        confirm: conf ? { title_delta: conf.title_delta, clears: conf.title_delta_se != null && conf.title_delta > NOISE_K * conf.title_delta_se } : null,
        key: c.key });
    }
  }
  rows.sort((a, b) => b.rank_score - a.rank_score || a.key.localeCompare(b.key));
  return { rows: rows.slice(0, o.keep), found: rows.length, ...sink };
}

/**
 * The planner's shadow block. served: always false. status: 'off' is never written (the key is absent);
 * 'skipped_bilateral_clears' when a single trade already clears; 'ledger_missing' fails closed like the
 * served search; else 'ok'. chainKeys: dealKey chains the served search already scored, so a cycle it
 * already had is marked `also_chained` (what the cycle search adds is the rest).
 */
export function threeWayBlock({ flag, bilateral, ledgerMissing, run, chainKeys = new Set(), bestExpected = null }) {
  const base = { flag, served: false, bilateral_clears: !!bilateral };
  if (ledgerMissing) return { ...base, status: 'ledger_missing', rows: [] };
  if (bilateral) return { ...base, status: 'skipped_bilateral_clears', rows: [] };
  const r = run();
  const rows = r.rows.map(x => ({ ...x, also_chained: chainKeys.has(x.key),
    beats_best: bestExpected == null ? x.expected > 0 : x.expected > bestExpected }));
  return { ...base, status: 'ok', ...r, rows, new_cycles: rows.filter(x => !x.also_chained).length };
}
