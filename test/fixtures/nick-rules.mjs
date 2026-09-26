/**
 * RULE-FUZZ oracle: Nick's hard rules (project rule 6, ONE-PLAN 10b, Nick 2026-09-24) checked on a
 * planner result, independently of how the planner enforces them. It reads only what the planner
 * returns (res from planner.js#planLeague) and the league it planned on (the adapter), and lists
 * every offer Nick could see that breaks a rule.
 *
 * Rules (ids are test/fixtures/rule-fuzz-league.mjs's):
 *   never_give     Nico Collins (160) and Chase Brown (80) are never in a give.
 *   aj_brown       A.J. Brown (277) is given only in a step whose get holds a Blue chip (83+) who is a
 *                  consistent weekly scorer now (scoreOf(id).consistent).
 *   final_get      every player a plan leaves Nick holding that he did not start with scores 83+; a
 *                  flip's leg-2 players and every suggested target are final gets too.
 *   overpay        market value given <= value got, except CAP-1C: exactly 2 for 1, neither given
 *                  player 83+ or pinned, at most +12%, and the step carries a confirmed rise in
 *                  lineup points AND title odds (step.depth_premium.confirmed, CAP-1C #382's field).
 *   no_olave       Chris Olave is never a get, a give, a target, a suggestion or a flip.
 *   no_buyback     no get, from any team, of a player Nick sent away in any trade this season (whole
 *                  season, no price-fall exception).
 *   no_undo        no step with a manager both takes back from him a player Nick sent him and gives him
 *                  back a player he sent Nick, in one trade this season between the two.
 *   stranded_hold  FLIP-STRANDED: after every leg but the last of a move served as a sequence (a plan's
 *                  steps, a flip's leg 1, a LADDER-01 card's rungs), every player Nick then holds that he
 *                  did not start with scores 83+: if the next leg is turned down he keeps him. Each leg's
 *                  own never-give, overpay and buy-back checks are the offer rules above (every leg is an
 *                  offer), so this rule only adds the floor on what he holds in between. Flip claims
 *                  (Nick 2026-09-25): a player got by a waiver claim (step.claim) and traded away in a
 *                  later trade (not claim) leg of the same path is exempt; claimed and kept, he is not.
 *   beats_no_trade every move served as something to send beats doing nothing on the confirm dice:
 *                  - deck cards: confirm.verdict is not 'failed', beats_no_trade is not false, and the
 *                    confirm-dice expected gain (plan.expected) is > 0;
 *                  - backups: expected > 0;
 *                  - catch-up items that name a deal (desperate with a plan_key, swing) and flips: gain > 0;
 *                  - LADDER-01 cards, each rung's on_no backup, and the negotiation.alt_package second
 *                    package (#386): must carry a confirm-dice number, i.e. `dice: 'confirm'` with
 *                    `expected` > 0 (or `confirmed_expected` > 0). A number on the planning dice, or none,
 *                    is a violation: Nick's rule is the confirm dice, not the dice the plan was found on.
 *   FLIP-CLAIMS (Nick 2026-09-25), on every claim path SEARCH-WIDE reports (search_wide.claims.paths, shadow;
 *   every rule above applies to them too, the claim step read as Nick giving the drop for the claimed player):
 *   claim_not_flipped    every claimed player is given away by a later trade step of the same path.
 *   claim_protected_drop the drop is never 160 / 80 / 277, one of Nick's untouchables (notes or the
 *                        objective's), a Blue chip (83+) or unscored.
 *   claim_stranded       the path is priced on the confirm dice (`dice: 'confirm'`) and its expected gain,
 *                        recomputed here from the steps' p and delta with the stranded branch (claim done,
 *                        flip declined) in it, is > 0.
 *
 * Surfaces covered (offersOf): best plan; every deck card, each of its playbooks' opening, walk-away,
 * ladder packages, reply-table next moves and negotiation.alt_package (#386); backups; the risk-mode
 * sheet's first steps; flip legs; catch-up items that name a deal (plan_key: desperate, swing);
 * LADDER-01 cards' rungs and each rung's on_no move (#394); suggestions and targets; SEARCH-WIDE's claim
 * paths (search_wide.claims.paths and shadow_best, FLIP-CLAIMS). A surface a PR
 * adds that is not listed here is NOT checked.
 */
import { NICO_COLLINS, CHASE_BROWN, AJ_BROWN, OLAVE_ID, BLUE_CHIP } from './rule-fuzz-league.mjs';

export const RULES = Object.freeze(['never_give', 'aj_brown', 'final_get', 'overpay', 'no_olave', 'no_buyback', 'no_undo', 'beats_no_trade',
  'claim_not_flipped', 'claim_protected_drop', 'claim_stranded',
  'stranded_hold']);
export const DEPTH_PREMIUM = 0.12;
const EPS = 1e-9;
const S = x => String(x);

/** A catch-up item's plan_key (paths.js#dealKey: 'team|give+ids|get+ids') back to a deal, or null. */
export function dealOfKey(key) {
  const parts = typeof key === 'string' ? key.split('|') : [];
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { team: parts[0], give: parts[1].split('+'), get: parts[2].split('+') };
}

/** SEARCH-WIDE's reported claim paths ({ partner } steps) as plans ({ team } steps): [[surface, plan]]. */
export function claimPathsOf(res) {
  const c = res.search_wide?.claims;
  const asPlan = p => ({ ...p, steps: (p.steps ?? []).map(st => ({ ...st, team: st.team ?? st.partner })) });
  return [...(c?.paths ?? []).map((p, i) => [`search_wide.claims.paths[${i}]`, asPlan(p)]),
    ...(c?.shadow_best ? [['search_wide.claims.shadow_best', asPlan(c.shadow_best)]] : [])];
}

/** A path's expected gain from its own steps (p, delta): every place it can stop, the stranded branches included. */
export function ownExpected(steps) {
  let reach = 1, ev = 0, before = 0;
  for (const st of steps) {
    ev += reach * (1 - Number(st.p)) * before;
    reach *= Number(st.p);
    before = Number(st.delta);
  }
  return ev + reach * before;
}

/** Every offer the result shows Nick: { surface, team, give, get, step, final }, plus the plans. */
export function offersOf(res) {
  const out = [];
  const plans = [];
  const add = (surface, team, give, get, step = null, extra = {}) => {
    if (Array.isArray(give) && Array.isArray(get) && give.length && get.length) out.push({ surface, team, give, get, step, ...extra });
  };
  const playbookOffers = (name, pb, st) => {
    if (!pb || !st) return;
    const L = pb.ladder ?? {};
    const priced = [['opening', L.opening ?? pb.opening], ['walk_away', L.walk_away ?? pb.walk_away],
      ...(L.ladder ?? []).map((l, i) => [`ladder[${i}]`, l])];
    for (const [k, x] of priced) if (x?.give) add(`${name}.${k}`, st.team, x.give, st.get, st);
    for (const r of pb.replies ?? []) if (r.next) add(`${name}.replies.${r.kind}`, r.next.partner, r.next.give, r.next.get);
    const alt = pb.negotiation?.alt_package;
    if (alt) add(`${name}.negotiation.alt_package`, st.team, alt.give, alt.get ?? st.get, st);
  };
  if (res.best) plans.push(['best', res.best]);
  plans.push(...claimPathsOf(res));
  for (const [j, c] of (res.deck ?? []).entries()) {
    if (!c.plan) continue;
    plans.push([`deck[${j}]`, c.plan]);
    for (const pb of c.playbooks ?? [c.playbook]) playbookOffers(`deck[${j}].playbook[${pb?.step_index ?? 0}]`, pb, c.plan.steps[pb?.step_index ?? 0]);
  }
  for (const pb of res.playbook ?? []) playbookOffers(`playbook[${pb.step_index}]`, pb, res.best?.steps?.[pb.step_index]);
  for (const [i, b] of (res.backups ?? []).entries()) if (b?.step) add(`backup[${i}]`, b.step.team, b.step.give, b.step.get, b.step);
  for (const m of res.risk_modes ?? []) if (m.first_step) add(`risk_modes.${m.mode}`, m.first_step.team, m.first_step.give, m.first_step.get, m.first_step);
  for (const [name, p] of plans) for (const [i, st] of p.steps.entries()) add(`${name}.step[${i}]`, st.team, st.give, st.get, st);
  for (const f of res.flip?.realised ?? []) {
    if (!f.legs) continue;
    const gx = f.legs.give_a_ids ?? [f.legs.give_a], gy = f.legs.get_b_ids ?? [f.legs.get_b];
    add(`flip ${f.player} leg 1`, f.a, gx, [f.player]);
    add(`flip ${f.player} leg 2`, f.b, [f.player], gy, null, { final: true });
  }
  for (const [i, it] of (res.catch_up ?? []).entries()) {
    const d = dealOfKey(it?.plan_key);
    if (d) add(`catch_up[${i}].${it.kind}`, d.team, d.give, d.get);
  }
  for (const [j, card] of (res.ladders?.cards ?? []).entries()) {
    const rungs = card.rungs ?? [];
    for (const [i, r] of rungs.entries()) {
      add(`ladders[${j}].rung[${i}]`, r.partner, r.give, r.get, null, { final: i === rungs.length - 1 });
      if (r.on_no?.give) add(`ladders[${j}].rung[${i}].on_no`, r.on_no.partner, r.on_no.give, r.on_no.get);
    }
  }
  return { offers: out, plans };
}

/** Players a plan leaves Nick holding that were not his at the start. */
export function finalGets(plan, startIds) {
  const start = new Set(startIds.map(S));
  const held = new Set(start);
  for (const st of plan.steps) {
    for (const id of st.give) held.delete(S(id));
    for (const id of st.get) held.add(S(id));
  }
  return [...held].filter(id => !start.has(id));
}

/**
 * FLIP-STRANDED: what Nick holds between legs. For each leg but the last, the players he holds right
 * after it that he did not start with: [{ leg, player }] (leg is 0-based).
 */
export function strandedAfterLegs(steps, startIds) {
  const start = new Set((startIds ?? []).map(S));
  const held = new Set(start);
  const out = [];
  const flipClaim = new Set();
  for (const [i, st] of steps.entries()) {
    if (st.claim) for (const id of st.get) if (steps.slice(i + 1).some(x => !x.claim && x.give.map(S).includes(S(id)))) flipClaim.add(S(id));
  }
  for (const [i, st] of steps.entries()) {
    for (const id of st.give) held.delete(S(id));
    for (const id of st.get) held.add(S(id));
    if (i < steps.length - 1) for (const id of held) if (!start.has(id) && !flipClaim.has(id)) out.push({ leg: i, player: id });
  }
  return out;
}

/** Every player Nick sent away in any trade this season. */
export function soldThisSeason(ledger, me) {
  return new Set((ledger?.trades ?? []).flatMap(t => t.moves).filter(m => S(m.from) === S(me)).map(m => S(m.player)));
}

/** Nick's season trades with one manager, one entry per trade: { sent: Set (Nick -> him), got: Set (him -> Nick) }. */
function tradesWith(ledger, me, team) {
  return (ledger?.trades ?? []).map(t => ({
    sent: new Set(t.moves.filter(m => S(m.from) === S(me) && S(m.to) === S(team)).map(m => S(m.player))),
    got: new Set(t.moves.filter(m => S(m.from) === S(team) && S(m.to) === S(me)).map(m => S(m.player))),
  })).filter(t => t.sent.size && t.got.size);
}

/** Every rule break in one planner result: [{ rule, surface, detail }]. */
export function ruleViolations(adapter, res) {
  const me = adapter.league.me;
  const P = adapter.players;
  const player = id => P.get(Number(id)) ?? P.get(id);
  const val = id => Math.max(0, Number(player(id)?.value) || 0);
  const score = id => Number(adapter.scoreOf(id)?.score);
  const blue = id => score(id) >= BLUE_CHIP;
  const consistent = id => !!adapter.scoreOf(id)?.consistent;
  const isOlave = id => S(id) === S(OLAVE_ID) || player(id)?.name === 'Chris Olave';
  const pinned = new Set([NICO_COLLINS, CHASE_BROWN, AJ_BROWN].map(S));
  const sold = soldThisSeason(adapter.tradeLedger, me);
  const sum = ids => ids.reduce((s, id) => s + val(id), 0);
  const out = [];
  const bad = (rule, surface, detail) => out.push({ rule, surface, detail });
  const { offers, plans } = offersOf(res);
  /** A served move with no confirm-dice gain, or one <= 0, does not beat doing nothing. */
  const confirmedGain = (surface, x) => {
    const num = v => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
    const g = num(x?.confirmed_expected) ?? (x?.dice === 'confirm' ? num(x?.expected) : null);
    if (g == null) bad('beats_no_trade', surface, `no confirm-dice gain (dice ${x?.dice ?? 'none'})`);
    else if (!(g > 0)) bad('beats_no_trade', surface, `confirm-dice gain ${g}`);
  };

  for (const o of offers) {
    const give = o.give.map(S), get = o.get.map(S);
    const tag = `${give.join('+')} for ${get.join('+')} (team ${o.team})`;
    if (give.includes(S(NICO_COLLINS)) || give.includes(S(CHASE_BROWN))) bad('never_give', o.surface, tag);
    if (give.includes(S(AJ_BROWN)) && !get.some(id => blue(id) && consistent(id))) bad('aj_brown', o.surface, tag);
    const gv = sum(give), tv = sum(get);
    if (gv > tv * (1 + EPS)) {
      const pct = tv > 0 ? gv / tv - 1 : Infinity;
      const shape = give.length === 2 && get.length === 1 && !give.some(id => blue(id) || pinned.has(id));
      const c = o.step?.depth_premium?.confirmed;
      const rose = c && Number(c.points_delta) > 0 && Number(c.title_delta) > 0;
      if (!(shape && pct <= DEPTH_PREMIUM + EPS && rose)) bad('overpay', o.surface, `${tag}: +${(pct * 100).toFixed(1)}%`);
    }
    if (get.some(isOlave) || give.some(isOlave)) bad('no_olave', o.surface, tag);
    if (o.final) for (const id of get) if (!blue(id)) bad('final_get', o.surface, `${id} scores ${score(id)}`);
    const back = get.filter(id => sold.has(id));
    if (back.length) bad('no_buyback', o.surface, `${tag} buys back ${back.join('+')}`);
    const undo = tradesWith(adapter.tradeLedger, me, o.team).find(t => get.some(id => t.sent.has(id)) && give.some(id => t.got.has(id)));
    if (undo) bad('no_undo', o.surface, `${tag} undoes a trade with team ${o.team}`);
  }
  const start = adapter.rosters.get(me);
  for (const [name, p] of plans) for (const id of finalGets(p, start)) if (!blue(id)) bad('final_get', name, `${id} scores ${score(id)}`);
  const stranded = (surface, steps) => {
    for (const h of strandedAfterLegs(steps, start)) if (!blue(h.player)) bad('stranded_hold', surface, `after leg ${h.leg + 1}: ${h.player} scores ${score(h.player)}`);
  };
  for (const [name, p] of plans) stranded(name, p.steps);
  for (const f of res.flip?.realised ?? []) if (f.legs) stranded(`flip ${f.player}`, [{ give: f.legs.give_a_ids ?? [f.legs.give_a], get: [f.player] }, { give: [f.player], get: f.legs.get_b_ids ?? [f.legs.get_b] }]);
  for (const [j, card] of (res.ladders?.cards ?? []).entries()) stranded(`ladders[${j}]`, (card.rungs ?? []).filter(r => r.give && r.get));
  for (const [j, c] of (res.deck ?? []).entries()) {
    if (!c.plan) continue;
    if (c.confirm?.verdict === 'failed') bad('beats_no_trade', `deck[${j}]`, 'confirm verdict failed');
    if (!(Number(c.plan.expected) > 0)) bad('beats_no_trade', `deck[${j}]`, `confirm-dice expected ${c.plan.expected}`);
  }
  for (const [j, c] of (res.deck ?? []).entries()) {
    if (c.plan && c.beats_no_trade === false) bad('beats_no_trade', `deck[${j}]`, 'beats_no_trade false');
    for (const pb of c.playbooks ?? [c.playbook]) {
      const alt = pb?.negotiation?.alt_package;
      if (alt) confirmedGain(`deck[${j}].playbook[${pb.step_index ?? 0}].negotiation.alt_package`, alt);
    }
  }
  for (const pb of res.playbook ?? []) {
    const alt = pb?.negotiation?.alt_package;
    if (alt) confirmedGain(`playbook[${pb.step_index}].negotiation.alt_package`, alt);
  }
  for (const [i, b] of (res.backups ?? []).entries()) {
    if (b?.step && !(Number(b.expected) > 0)) bad('beats_no_trade', `backup[${i}]`, `expected ${b.expected}`);
  }
  for (const [i, it] of (res.catch_up ?? []).entries()) {
    const deal = (it?.kind === 'desperate' && it.plan_key) || it?.kind === 'swing' || it?.kind === 'flip';
    if (deal && !(Number(it.gain) > 0)) bad('beats_no_trade', `catch_up[${i}].${it.kind}`, `gain ${it.gain}`);
  }
  for (const [j, card] of (res.ladders?.cards ?? []).entries()) {
    confirmedGain(`ladders[${j}]`, { dice: res.ladders.dice, ...card });
    for (const [i, r] of (card.rungs ?? []).entries()) {
      if (r.on_no?.give) confirmedGain(`ladders[${j}].rung[${i}].on_no`, r.on_no);
    }
  }
  for (const s of res.suggestions ?? []) {
    if (!blue(s.player)) bad('final_get', 'suggestions', `${s.player} scores ${score(s.player)}`);
    if (isOlave(s.player)) bad('no_olave', 'suggestions', S(s.player));
    if (sold.has(S(s.player))) bad('no_buyback', 'suggestions', S(s.player));
  }
  // FLIP-CLAIMS: the claim paths SEARCH-WIDE reports.
  const untouched = new Set([...(adapter.untouchable ?? []), ...(res.objective?.untouchables ?? [])].map(S));
  for (const [name, p] of claimPathsOf(res)) {
    for (const [i, st] of p.steps.entries()) {
      if (!st.claim) continue;
      for (const id of st.get.map(S)) {
        if (!p.steps.slice(i + 1).some(x => !x.claim && x.give.map(S).includes(id))) bad('claim_not_flipped', name, `${id} claimed and never traded away`);
      }
      for (const id of st.give.map(S)) {
        const sc = score(id);
        if (pinned.has(id) || untouched.has(id) || !Number.isFinite(sc) || sc >= BLUE_CHIP) bad('claim_protected_drop', name, `drops ${id} (score ${sc})`);
      }
    }
    if (p.steps.some(st => st.claim)) {
      const ev = ownExpected(p.steps);
      if (p.dice !== 'confirm') bad('claim_stranded', name, `priced on the ${p.dice ?? 'no'} dice`);
      else if (!(ev > 0)) bad('claim_stranded', name, `confirm-dice expected ${ev} with the stranded branch`);
    }
  }
  for (const t of res.targets ?? []) {
    if (isOlave(t)) bad('no_olave', 'targets', S(t));
    if (sold.has(S(t))) bad('no_buyback', 'targets', S(t));
  }
  return out;
}

/** Counts per rule, every rule present (0 when clean). */
export function countByRule(violations) {
  const c = Object.fromEntries(RULES.map(r => [r, 0]));
  for (const v of violations) c[v.rule]++;
  return c;
}
