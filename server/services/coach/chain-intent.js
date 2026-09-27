/**
 * COACH-CHAIN intent: "what if I get Amon-Ra for Nico, Etienne and Price" / "after that, who fills RB?".
 *
 * Coach plans in chains, like a GM: the move, the lineup it leaves, the new hole, the move that fills it.
 * The numbers are the chain producer's (campaign/chain.js via chain-engine.js, in the Coach engine
 * worker: the War Room plan's world, seed and rules). This module:
 *   1. reads the question into moves (parseChainQuestion; words only, names resolved in the worker);
 *   2. runs the chain (negotiator.js#engineChain, off the request thread);
 *   3. records every number it may say as one `chain_read` ledger entry (a brain tool for verify.js:
 *      every player a line names must be in a cell that line cites);
 *   4. answers in the verdict format: a verb-first line, the steps with lineup and playoff change vs
 *      doing nothing, the hole and its best fill, "Needs your OK" for a step that uses a protected player;
 *   5. with the model on, the model may NARRATE those rows in the same format; its answer ships only
 *      when verify.js grounds every number and player in the rows (else the $0 lines ship). It never
 *      computes a number.
 * The chain view (chain-view.js) rides with the answer for the drawer's Chain card.
 *
 * Behind GRIDIRON_COACH_CHAIN (default off; '1' on, preview mode turns it on locally, '0' vetoes preview).
 */
import { callClaude, parseJson } from '../claude.js';
import { previewUnconfirmed } from '../preview-mode.js';
import { newLedger } from './ledger.js';
import { verifyAnswer } from './verify.js';
import { SHAPED_SCHEMA, SHAPE_PROMPT, toAnswer, enforceShape, claimsOf } from './answer-shape.js';
import { engineChain } from './negotiator.js';
import { COACH_MODEL } from './ask.js';
import { chainView, namer, moveText, RULE_WORDS, noFillNote } from './chain-view.js';

export const CHAIN_ENV = 'GRIDIRON_COACH_CHAIN';
export const CHAIN_TOOL = 'chain_read';
/** The narration model: Coach's normal model (ask.js), thinking off. */
export const NARRATE_MODEL = COACH_MODEL;

/** On with its own flag or preview mode; its own flag set to '0' vetoes preview. */
export function chainOn(env = process.env) {
  if (env[CHAIN_ENV] === '1') return true;
  if (env[CHAIN_ENV] === '0') return false;
  return env === process.env ? previewUnconfirmed() : env.GRIDIRON_PREVIEW_UNCONFIRMED === '1';
}

/* ------------------------------------------------------------ words -> moves */

const clean = t => String(t ?? '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
/** "Nico, Etienne and Price" -> ['Nico', 'Etienne', 'Price']. */
export const splitNames = t => clean(t).replace(/[?.!]+$/, '').split(/\s*(?:,|\+|&|\band\b|\bplus\b)\s*/i)
  .map(x => x.replace(/^(?:and|plus|my|his|their)\s+/i, '').trim()).filter(Boolean);

const GET = String.raw`(?:get|got|trade for|acquire|land|grab|add|bring in)`;
const GIVE = String.raw`(?:trade|give|send|deal|move|flip|offer)`;
const TEAM = String.raw`(?:\s*(?:with|from|to)\s+team\s+(\d+))?`;
const MOVE_GET = new RegExp(String.raw`^(?:i\s+)?${GET}\s+(.+?)\s+(?:for|by giving|by trading|by sending)\s+(.+?)${TEAM}$`, 'i');
const MOVE_GIVE = new RegExp(String.raw`^(?:i\s+)?${GIVE}\s+(.+?)${TEAM}\s+for\s+(.+?)${TEAM}$`, 'i');
const LEAD = /^(?:so\s+|ok(?:ay)?\s+|and\s+)?(?:what\s+if|what\s+about\s+if|what\s+happens\s+if|if|say|suppose|imagine)\s+/i;
const AFTER = /\b(?:after (?:that|this|it|those|these)|then what|what'?s next|next move|and then|who (?:fills|fixes|plugs)|fill (?:the|my|that) hole|what fills)\b/i;

/** One clause ("I get A for B, C", "I trade A for B with team 10") -> a move in names, or null. */
export function parseMove(clause) {
  const t = clean(clause).replace(LEAD, '').replace(/[?.!]+$/, '');
  let m = MOVE_GET.exec(t);
  if (m) return { get: splitNames(m[1]), give: splitNames(m[2]), ...(m[3] ? { team: m[3] } : {}) };
  m = MOVE_GIVE.exec(t);
  if (m) return { give: splitNames(m[1]), get: splitNames(m[3]), ...(m[2] || m[4] ? { team: m[2] ?? m[4] } : {}) };
  return null;
}

/**
 * The chain a question asks for, or null (not a chain question).
 *   { kind: 'new', moves }       "what if I get A for B, C and D (with team 10)", clauses joined by "then"
 *   { kind: 'extend', moves }    "after that, what if I trade X for Y": appended to the chain in focus
 *   { kind: 'after' }            "after that, who fills RB?": the chain in focus, read again
 */
export function parseChainQuestion(question, { focus = {} } = {}) {
  const q = clean(question);
  if (!q || q.length > 300) return null;
  const hasChain = Array.isArray(focus.chain) && focus.chain.length > 0;
  const after = AFTER.test(q);
  const body = q.replace(/^.*?\b(?:after (?:that|this|it)|and then|then)\b[,:]?\s*/i, m => (after && hasChain ? '' : m));
  const clauses = body.split(/[,;]?\s*\b(?:and\s+)?then\b\s*/i).map(x => x.trim()).filter(Boolean);
  const moves = clauses.map(parseMove);
  if (moves.length && moves.every(Boolean) && (LEAD.test(q) || (after && hasChain) || /^i\s/i.test(body))) {
    return after && hasChain ? { kind: 'extend', moves } : { kind: 'new', moves };
  }
  if (after && hasChain) {
    const pos = /\b(qb|rb|wr|te)s?\b/i.exec(q)?.[1]?.toUpperCase() ?? null;
    return { kind: 'after', ...(pos ? { prefer: pos } : {}) };
  }
  return null;
}

/* ------------------------------------------------------------ engine */

const sources = { engine: engineChain };
/** Swap the engine (tests): fn(leagueId, moves, { prefer }) -> Promise<chain result>; null restores the worker. */
export function setChainEngine(fn) { sources.engine = fn ?? engineChain; }

/* ------------------------------------------------------------ ledger + $0 answer */

const r1 = x => (Number.isFinite(x) ? +x.toFixed(4) : null);
const S = x => String(x);

/** The chain's numbers as ledger rows (one per step, then the totals). Every value the answer may say. */
export function chainRows(res) {
  const nm = namer(res);
  const team = t => res.teams?.[String(t)] ?? 'another team';
  const rows = res.steps.filter(s => !s.error).map(s => {
    const best = s.fills_status === 'ok' ? s.fills[0] : null;
    return {
      step: s.index, source: s.source, move_text: moveText(s.move, nm),
      give_name: s.move.give.map(nm).join('; '), get_name: s.move.get.map(nm).join('; '), partner_team: s.move.claim ? 'waiver claim' : team(s.move.team),
      lineup_after: r1(s.lineup.after), lineup_step_delta: r1(s.lineup.step_delta), lineup_total_delta: r1(s.lineup.total_delta),
      playoff_after: r1(s.playoff.after), playoff_step_delta: r1(s.playoff.step_delta), playoff_total_delta: r1(s.playoff.total_delta),
      chance_yes: s.p?.value != null ? r1(s.p.value) : null,
      needs_ok: !!s.rules?.needs_ok, rules_ok: !!s.rules?.ok,
      rule_break: s.rules && !s.rules.ok ? [...new Set(s.rules.reasons.map(r => RULE_WORDS[r] ?? 'breaks one of your rules'))].join('; ') : null,
      hole_label: s.hole?.label ?? null, hole_player: s.hole?.player ? nm(s.hole.player) : null, hole_ppg: r1(s.hole?.ppg ?? NaN),
      hole_rank: s.hole?.rank ?? null, hole_of: s.hole?.of ?? null, hole_median: r1(s.hole?.league_median ?? NaN),
      fill_text: best ? (best.kind === 'flip_claim' ? moveText({ ...best.steps[1], via_claim: { ...best.steps[0], claim: true } }, nm) : moveText(best, nm)) : null,
      fill_get_name: best ? best.get.map(nm).join('; ') : null, fill_give_name: best ? best.give.map(nm).join('; ') : null,
      fill_partner_team: best ? team(best.team) : null,
      fill_lineup_delta: best ? r1(best.lineup.step_delta) : null, fill_playoff_delta: best ? r1(best.playoff.step_delta) : null,
      fill_chance_yes: best?.p != null ? r1(best.p) : null,
      no_fill_text: best ? null : noFillNote(s, nm),
    };
  });
  // LOOKAHEAD: the first moves ranked by continuation value, Nick's own move, and the wait-then-best baseline.
  const L = res.lookahead;
  if (L) {
    const same = (x, y) => !!x && !!y && S(x.team) === S(y.team) && x.give.map(S).sort().join() === y.give.map(S).sort().join() && x.get.map(S).sort().join() === y.get.map(S).sort().join();
    const yours = L.yours?.move ?? null;
    rows.push({ step: 'baseline', baseline_delta: r1(L.baseline.value_delta), best_delta: r1(L.best.value_delta), depth: L.depth, metric: L.stats?.metric ?? null });
    L.first_moves.forEach((f, k) => rows.push({ step: 'first', rank: k + 1, move_text: moveText(f.move, nm), give_name: f.move.give.map(nm).join('; '),
      get_name: f.move.get.map(nm).join('; '), partner_team: team(f.move.team), now_delta: r1(f.now_delta), if_yes_delta: r1(f.if_yes_delta),
      cont_delta: r1(f.cont_delta), chance_yes: f.p != null ? r1(f.p) : null, needs_ok: !!f.move.needs_ok, is_yours: same(f.move, yours) }));
    if (L.yours) {
      const rank = 1 + L.first_moves.filter(f => f.cont_delta > L.yours.cont_delta && !same(f.move, yours)).length;
      rows.push({ step: 'yours', rank, move_text: moveText(L.yours.move, nm), give_name: L.yours.move.give.map(nm).join('; '),
        get_name: L.yours.move.get.map(nm).join('; '), now_delta: r1(L.yours.now_delta), if_yes_delta: r1(L.yours.if_yes_delta),
        cont_delta: r1(L.yours.cont_delta), chance_yes: L.yours.p != null ? r1(L.yours.p) : null });
    }
  }
  const t = res.totals;
  if (t) rows.push({ step: 'total', steps: t.steps, lineup_nothing: r1(t.lineup.nothing), lineup_after: r1(t.lineup.after), lineup_total_delta: r1(t.lineup.delta),
    playoff_nothing: r1(t.playoff.nothing), playoff_after: r1(t.playoff.after), playoff_total_delta: r1(t.playoff.delta), needs_ok: !!t.needs_ok });
  return rows;
}

/** A number at d places, rounded the way verify.js reads a stated number (Math.round, not toFixed's binary rounding). */
const fixed = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${fixed(x, d)}`;

/** The $0 answer: every line built from the rows and cited to them (verify.js checks each one). */
export function chainClaims(rows, cite) {
  const steps = rows.filter(r => Number.isInteger(r.step));
  const firsts = rows.filter(r => r.step === 'first');
  const yours = rows.find(r => r.step === 'yours');
  const base = rows.find(r => r.step === 'baseline');
  // Lookahead values are on the objective: odds (fractions, said in points) or lineup points a week.
  const lv = base?.metric === 'points' ? x => `${signed(x)} pts/wk` : x => `${signed(x * 100)} pts`;
  const total = rows.find(r => r.step === 'total');
  const last = steps.at(-1);
  if (!steps.length) return null;
  const i = k => rows.indexOf(k);
  const c = (row, ...cols) => cols.map(col => cite(i(row), col));
  const first = steps[0];
  let verdict;
  const top = firsts[0];
  if (yours && top && !top.is_yours && top.cont_delta > yours.cont_delta && steps[0]?.rules_ok) {
    verdict = { text: `Prefer ${top.move_text}: ${lv(top.cont_delta)} expected vs ${lv(yours.cont_delta)} for yours.`,
      cites: [...c(top, 'move_text', 'give_name', 'get_name', 'cont_delta'), ...c(yours, 'cont_delta')] };
  } else if (steps.some(s => !s.rules_ok)) {
    const bad = steps.find(s => !s.rules_ok);
    verdict = { text: `No: step ${bad.step} breaks your rules (${bad.rule_break}).`, cites: c(bad, 'rule_break') };
  } else if (last.fill_text) {
    verdict = { text: `Make step 1, then target ${last.fill_get_name} to fill ${last.hole_label}.`, cites: c(last, 'fill_get_name', 'hole_label') };
  } else {
    verdict = { text: `Weigh step 1: nothing inside your rules fills ${last.hole_label} after it.`, cites: c(last, 'hole_label') };
  }
  const why = steps.slice(0, 3).map(s => ({
    text: `Step ${s.step}: ${s.move_text}; lineup ${signed(s.lineup_total_delta)} pts/wk, playoff odds ${signed(s.playoff_total_delta * 100)} pts vs doing nothing.`,
    cites: c(s, 'move_text', 'give_name', 'get_name', 'lineup_total_delta', 'playoff_total_delta'),
  }));
  if (yours) why.push({ text: `With the best follow-ups: ${lv(yours.if_yes_delta)} if they say yes, ${lv(yours.cont_delta)} expected.`,
    cites: c(yours, 'if_yes_delta', 'cont_delta') });
  const risks = [];
  const okStep = steps.find(s => s.needs_ok);
  if (okStep) risks.push({ text: `Needs your OK: step ${okStep.step} gives a protected player for a true tier up.`, cites: c(okStep, 'needs_ok') });
  const hole = { text: `Hole after step ${last.step}: ${last.hole_label}, ${last.hole_player} at ${fixed(last.hole_ppg)} pts/game, ${last.hole_rank} of ${last.hole_of} teams.`,
    cites: c(last, 'hole_label', 'hole_player', 'hole_ppg', 'hole_rank', 'hole_of') };
  const fill = last.fill_text
    ? { text: `Best fill: ${last.fill_text} with ${last.fill_partner_team}: playoff odds ${signed(last.fill_playoff_delta * 100)} pts, lineup ${signed(last.fill_lineup_delta)} pts/wk.`,
      cites: c(last, 'fill_text', 'fill_give_name', 'fill_get_name', 'fill_partner_team', 'fill_playoff_delta', 'fill_lineup_delta') }
    : { text: last.no_fill_text, cites: c(last, 'no_fill_text', 'hole_label') };
  const more = [hole, fill];
  // LOOKAHEAD: the first moves ranked by what they set up, and the baseline every first move must beat.
  for (const f of firsts.slice(0, 3)) {
    more.push({ text: `#${f.rank} by what it sets up: ${f.move_text}; now ${lv(f.now_delta)}, with follow-ups ${lv(f.if_yes_delta)}, expected ${lv(f.cont_delta)}.`,
      cites: c(f, 'rank', 'move_text', 'give_name', 'get_name', 'now_delta', 'if_yes_delta', 'cont_delta') });
  }
  if (base) more.push({ text: `Doing nothing now, then the best moves: ${lv(base.baseline_delta)} expected.`, cites: c(base, 'baseline_delta') });
  if (total) more.push({ text: `Whole chain vs doing nothing: lineup ${fixed(total.lineup_nothing)} to ${fixed(total.lineup_after)} pts/wk; playoff odds ${fixed(total.playoff_nothing * 100)}% to ${fixed(total.playoff_after * 100)}%.`,
    cites: [cite(i(total), 'lineup_nothing'), cite(i(total), 'lineup_after'), cite(i(total), 'playoff_nothing'), cite(i(total), 'playoff_after')] });
  if (first.chance_yes != null) risks.push({ text: `Risk: they say yes to step 1 about ${fixed(first.chance_yes * 100, 0)}% of the time (estimate).`, cites: c(first, 'chance_yes') });
  return { verdict, why, risks: risks.slice(0, 2), more };
}

/** Ground every line; what fails is dropped (never softened). */
function groundShape(shape, ledger) {
  const keep = l => l && verifyAnswer({ answer: { claims: [{ text: l.text, cites: l.cites }], as_of: 'chain' }, ledger }).ok;
  const dropped = [];
  const f = list => list.filter(l => { const ok = keep(l); if (!ok) dropped.push(l.text); return ok; });
  const verdict = keep(shape.verdict) ? shape.verdict : { text: 'Here is the chain Coach priced.', cites: [] };
  return { shape: { ...shape, verdict, why: f(shape.why), risks: f(shape.risks), more: f(shape.more ?? []) }, dropped };
}

const NARRATE_SYSTEM = `You are Coach, narrating a trade chain that the app already priced. The chain rows are the ONLY evidence: every number and player you write must be in a row cell you cite as r1#<row>.<column>. Never compute, round differently, add or subtract numbers: say the cells as they are (a fraction such as 0.0525 is "+5.3 pts" or "5.3%"). Lead with what Nick should do; list each step with its lineup and playoff odds change vs doing nothing; name the hole after the last step and its best fill (or why none fits); say "Needs your OK" when a row's needs_ok is true. Every player you name must be in a cell the same line cites (the *_name, move_text, hole_player or fill_text columns); a slot label such as RB1 is the hole_label cell, cited. Refer to a league-mate only as they or their team; never name them. A number goes in a line only when that line cites the cell holding it.`;

/** The model's narration of the rows, verified; null when it fails or grounds nothing. Cost is the caller's. */
async function narrate({ question, rows, ledger }) {
  const msg = await callClaude({ feature: 'coach:chain', model: NARRATE_MODEL, maxTokens: 700, system: NARRATE_SYSTEM + SHAPE_PROMPT, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `Question: ${String(question).slice(0, 300)}\n\nChain rows (r1):\n${JSON.stringify(rows.map((r, k) => ({ row: k, ...r })))}` }],
    outputSchema: SHAPED_SCHEMA });
  const parsed = toAnswer(parseJson(msg));
  const shaped = enforceShape(parsed).answer;
  const v = verifyAnswer({ answer: { claims: shaped.claims, as_of: 'chain' }, ledger, question });
  // A line that does not ground is dropped (as every Coach answer); a verdict that does not ground, or no
  // why line left, and the narration does not ship at all.
  const bad = new Set(v.violations.filter(x => Number.isInteger(x.claim_index)).map(x => shaped.claims[x.claim_index]));
  const why = v.violations.map(x => `${x.kind}${x.number ? ` ${x.number}` : ''}${x.player ? ` ${x.player}` : ''}${x.cite ? ` ${x.cite}` : ''}`).slice(0, 6);
  const kept = { ...shaped.shape, why: shaped.shape.why.filter(l => ![...bad].some(c => c.text === l.text)),
    risks: shaped.shape.risks.filter(l => ![...bad].some(c => c.text === l.text)) };
  const verdictBad = [...bad].some(c => c.block === 'verdict');
  if (!shaped.shape.verdict || verdictBad || !kept.why.length) return { answer: null, cost_usd: msg.cost_usd ?? 0, dropped: bad.size, why };
  const answer = { ...shaped, shape: kept, claims: claimsOf(kept), as_of: null };
  if (!verifyAnswer({ answer: { claims: answer.claims, as_of: 'chain' }, ledger }).ok) return { answer: null, cost_usd: msg.cost_usd ?? 0, dropped: bad.size, why };
  return { answer, cost_usd: msg.cost_usd ?? 0, dropped: bad.size, why };
}

/**
 * One chain turn. focus.chain: the moves of the chain in focus (ids). -> { answer, ledger, view, chain_moves,
 * verification, cost_usd, model } | null (not a chain question).
 */
export async function chainAnswer({ question, leagueId, focus = {}, hasModel = false, parsed = null }) {
  const ask = parsed ?? parseChainQuestion(question, { focus });
  if (!ask) return null;
  const moves = ask.kind === 'new' ? ask.moves : [...(focus.chain ?? []), ...(ask.moves ?? [])];
  const ledger = newLedger();
  let res;
  try { res = await sources.engine(leagueId, moves, { prefer: ask.prefer ?? null }); } catch (e) { res = { error: `the chain could not be priced right now (${e?.message ?? e})` }; }
  const view = chainView(res);
  if (!res || res.error) {
    const refusal = res?.ask?.length ? `${res.error}: say which (${res.ask.slice(0, 4).join(', ')}).` : `Coach could not build that chain: ${res?.error ?? 'no answer'}.`;
    return { answer: { claims: [], refusals: [refusal], as_of: null }, ledger: ledger.toJson(), view, chain_moves: focus.chain ?? [],
      verification: { ok: true, violations: [], warnings: [], deterministic: true, intent: 'chain', question, numbers_checked: 0 }, cost_usd: 0, model: 'none:chain' };
  }
  const rows = chainRows(res);
  const entry = ledger.record({ tool: CHAIN_TOOL, sql: null, params: [], tables: ['chain'], columns: [...new Set(rows.flatMap(Object.keys))], rows,
    provenance: { chain: { producer: 'campaign/chain.js', seed: res.seed, as_of: res.as_of ?? null } } });
  const cite = (row, col) => `${entry.id}#${row}.${col}`;
  const draft = chainClaims(rows, cite);
  const { shape, dropped } = groundShape({ ...draft, stance: res.totals?.breaks_rules ? 'avoid' : res.totals?.needs_ok ? 'wait' : 'go',
    basis: 'roster fit', basis_key: 'roster_fit' }, ledger);
  let answer = { claims: claimsOf(shape), refusals: [], as_of: res.as_of ? `league data of ${res.as_of}` : null, shape };
  let cost = 0, model = 'none:chain', narration = hasModel ? null : { status: 'off' };
  if (hasModel) {
    try {
      const n = await narrate({ question, rows, ledger });
      cost = n.cost_usd;
      if (n.answer) {
        // A step that needs Nick's OK is never "Send": the $0 verdict stands in for a narrated one that says it.
        const needsOk = rows.some(r => Number.isInteger(r.step) && r.needs_ok);
        const verdict = needsOk && /^send\b/i.test(n.answer.shape.verdict?.text ?? '') ? shape.verdict : n.answer.shape.verdict;
        const narrated = { ...n.answer.shape, verdict, more: shape.more };
        answer = { ...n.answer, shape: narrated, claims: claimsOf(narrated), as_of: answer.as_of }; model = NARRATE_MODEL;
      }
      narration = n.answer ? { status: 'shipped', dropped: n.dropped, why: n.why } : { status: 'not_grounded', dropped: n.dropped, why: n.why ?? [] };
    } catch (e) {
      if (e?.code === 'ai_credit' || e?.name === 'LlmBudgetError') { /* the $0 lines ship */ } else console.warn(`[coach] chain narration failed (${e?.message ?? e}); the $0 lines ship`);
    }
  }
  const v = verifyAnswer({ answer: { claims: answer.claims, as_of: answer.as_of ?? 'chain' }, ledger, question });
  const chainMoves = res.steps.filter(s => !s.error && s.source === 'you').map(s => ({ team: s.move.team, give: s.move.give, get: s.move.get }));
  return { answer, ledger: ledger.toJson(), view, chain_moves: chainMoves, cost_usd: cost, model, dropped, narration,
    verification: { ...v, deterministic: model === 'none:chain', intent: 'chain', numbers_checked: v.numbers_checked } };
}
