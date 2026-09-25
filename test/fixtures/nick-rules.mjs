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
 *   no_olave       Chris Olave is never a get, a target, a suggestion or a flip.
 *   no_reversal    no step with a manager moves back a player that moved between Nick and that
 *                  manager in a trade this season (Nick gets back one he sent, or sends back one he got).
 */
import { NICO_COLLINS, CHASE_BROWN, AJ_BROWN, OLAVE_ID, BLUE_CHIP } from './rule-fuzz-league.mjs';

export const RULES = Object.freeze(['never_give', 'aj_brown', 'final_get', 'overpay', 'no_olave', 'no_reversal']);
export const DEPTH_PREMIUM = 0.12;
const EPS = 1e-9;
const S = x => String(x);

/**
 * Every offer the result shows Nick: plan steps (best, deck, backups, risk-mode sheet), each step's
 * opening, walk-away and ladder packages, and flip legs. { surface, team, give, get, step }.
 */
export function offersOf(res) {
  const out = [];
  const plans = [];
  if (res.best) plans.push(['best', res.best]);
  for (const [j, c] of (res.deck ?? []).entries()) {
    if (c.plan) plans.push([`deck[${j}]`, c.plan]);
    for (const pb of c.playbooks ?? [c.playbook]) {
      const st = c.plan?.steps?.[pb?.step_index ?? 0];
      if (!pb || !st) continue;
      const priced = [['opening', pb.ladder?.opening ?? pb.opening], ['walk_away', pb.ladder?.walk_away ?? pb.walk_away],
        ...(pb.ladder?.ladder ?? []).map((l, i) => [`ladder[${i}]`, l])];
      for (const [name, x] of priced) if (x?.give) out.push({ surface: `deck[${j}].${name}`, team: st.team, give: x.give, get: st.get, step: st });
    }
  }
  for (const pb of res.playbook ?? []) {
    const st = res.best?.steps?.[pb.step_index];
    if (!st) continue;
    for (const [name, x] of [['opening', pb.ladder?.opening], ['walk_away', pb.ladder?.walk_away]]) {
      if (x?.give) out.push({ surface: `playbook[${pb.step_index}].${name}`, team: st.team, give: x.give, get: st.get, step: st });
    }
  }
  for (const [i, b] of (res.backups ?? []).entries()) if (b?.step) out.push({ surface: `backup[${i}]`, team: b.step.team, give: b.step.give, get: b.step.get, step: b.step });
  for (const m of res.risk_modes ?? []) if (m.first_step) out.push({ surface: `risk_modes.${m.mode}`, team: m.first_step.team, give: m.first_step.give, get: m.first_step.get, step: m.first_step });
  for (const [name, p] of plans) for (const [i, st] of p.steps.entries()) out.push({ surface: `${name}.step[${i}]`, team: st.team, give: st.give, get: st.get, step: st });
  for (const f of res.flip?.realised ?? []) {
    if (!f.legs) continue;
    const gx = f.legs.give_a_ids ?? [f.legs.give_a], gy = f.legs.get_b_ids ?? [f.legs.get_b];
    out.push({ surface: `flip ${f.player} leg 1`, team: f.a, give: gx, get: [f.player], step: null });
    out.push({ surface: `flip ${f.player} leg 2`, team: f.b, give: [f.player], get: gy, step: null, final: true });
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

/** Nick's season trades with one manager: { sent: Set (Nick -> him), got: Set (him -> Nick) }. */
function seasonMoves(ledger, me, team) {
  const sent = new Set(), got = new Set();
  for (const t of ledger?.trades ?? []) {
    for (const m of t.moves) {
      if (S(m.from) === S(me) && S(m.to) === S(team)) sent.add(S(m.player));
      if (S(m.from) === S(team) && S(m.to) === S(me)) got.add(S(m.player));
    }
  }
  return { sent, got };
}

/** Every rule break in one planner result: [{ rule, surface, detail }]. */
export function ruleViolations(adapter, res) {
  const me = adapter.league.me;
  const P = adapter.players;
  const val = id => Math.max(0, Number(P.get(Number(id))?.value ?? P.get(id)?.value) || 0);
  const score = id => Number(adapter.scoreOf(id)?.score);
  const blue = id => score(id) >= BLUE_CHIP;
  const consistent = id => !!adapter.scoreOf(id)?.consistent;
  const isOlave = id => S(id) === S(OLAVE_ID) || (P.get(Number(id)) ?? P.get(id))?.name === 'Chris Olave';
  const pinned = new Set([NICO_COLLINS, CHASE_BROWN, AJ_BROWN].map(S));
  const sum = ids => ids.reduce((s, id) => s + val(id), 0);
  const out = [];
  const bad = (rule, surface, detail) => out.push({ rule, surface, detail });
  const { offers, plans } = offersOf(res);

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
    const moved = seasonMoves(adapter.tradeLedger, me, o.team);
    const back = [...get.filter(id => moved.sent.has(id)), ...give.filter(id => moved.got.has(id))];
    if (back.length) bad('no_reversal', o.surface, `${tag} moves back ${back.join('+')}`);
  }
  const start = adapter.rosters.get(me);
  for (const [name, p] of plans) for (const id of finalGets(p, start)) if (!blue(id)) bad('final_get', name, `${id} scores ${score(id)}`);
  for (const s of res.suggestions ?? []) {
    if (!blue(s.player)) bad('final_get', 'suggestions', `${s.player} scores ${score(s.player)}`);
    if (isOlave(s.player)) bad('no_olave', 'suggestions', S(s.player));
  }
  for (const t of res.targets ?? []) if (isOlave(t)) bad('no_olave', 'targets', S(t));
  return out;
}

/** Counts per rule, every rule present (0 when clean). */
export function countByRule(violations) {
  const c = Object.fromEntries(RULES.map(r => [r, 0]));
  for (const v of violations) c[v.rule]++;
  return c;
}
