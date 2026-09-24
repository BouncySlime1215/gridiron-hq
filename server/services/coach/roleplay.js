/**
 * COACH-ROLEPLAY (COACH-ANCHOR.md job 3, the PEOPLE READER): "what would he
 * say to this?" and "how do I come across?".
 *
 * simulateReply samples a manager's likely reply to a drafted message from
 * the counterpart model. It never writes his words: a reply is a STYLE
 * (ignore / counter / decline / accept) plus a template line built from
 * labels the model already holds (a player he said he wants, a player he
 * called untouchable, a roster hole), and every result is labelled as a
 * simulation. Where the plan has a pre-planned answer for that branch
 * (step.reply_table), it rides along, so the role-play ends in what to do.
 *
 * The reply mix, in order of precedence:
 *   ignore   1 - P(responds) from the plan's partners row (activity read,
 *            source campaign.plan); without one, the M6 prior's ignore,
 *            halved-responds when Nick's note says deprioritize.
 *   accept   the engine's P(yes) for this exact deal when the draft IS a
 *            plan step (same partner, same players), capped at P(responds);
 *            otherwise the prior's accept share, moved by the counterpart
 *            features COUNTERPART-01 defines (wants_player log-lift,
 *            shop_talk log-lift x credibility, untouchable_talk multiplier or
 *            exclude). The plan's P(yes) already carries those features, so
 *            they are never applied twice.
 *   counter / decline  split what is left in the prior's proportions.
 * A quiet manager (profile 'unknown') gets no chat feature: unknown is not
 * neutral. Nick's exclude note means no simulation at all.
 *
 * comesAcross is SELF-01's "how Nick comes across" for one counterpart:
 * offers Nick sent him in the last 7 days (the same window REP-01 counts),
 * his run of no's, an offer still unanswered, the draft's tone, and asking
 * for a player he called untouchable. Labels and counts only; no chat text
 * is quoted, the draft included.
 *
 * Nothing here is fitted. The M6 prior and the COUNTERPART-01 constants are
 * mirrored from server/services/people/counterpart.js (#254, not in this
 * tree yet; a test pins them equal once it is), and the tone lexicon is
 * hand-set. Pure except roleplayFor, which reads trade_outcomes.
 *
 * Flag: GRIDIRON_COACH_ROLEPLAY=1, or preview mode (preview-mode.js), in
 * which case the result carries preview fields and a prefixed label.
 */
import { previewUnconfirmed, previewFields, previewText } from '../preview-mode.js';

export const ROLEPLAY_ENV = 'GRIDIRON_COACH_ROLEPLAY';

/** A bad team, draft or argument: Coach hands it back to the model as a refusal. */
export class RoleplayInputError extends Error {
  constructor(message) { super(message); this.name = 'RoleplayInputError'; }
}
export const ROLEPLAY_LEAGUE_ID = 4;
export const ROLEPLAY_PREVIEW_REASON =
  'Coach role-play samples from an unfitted counterpart model (M6 prior + COUNTERPART-01 features)';
export const SIMULATION_LABEL =
  'Simulation: a likely reply sampled from the counterpart model, not his words';

export const REPLY_STYLES = Object.freeze(['ignore', 'counter', 'decline', 'accept']);
// Mirrors counterpart.js (#254). Not fitted.
export const M6_REPLY_PRIOR = Object.freeze({ ignore: 0.45, counter: 0.33, decline: 0.17, accept: 0.05 });
export const M6_LABEL = 'M6 reply prior (PEOPLE-LAB), league-wide, not fitted per manager';
const UNTOUCHABLE_EXCLUDE = 0.5;
const SHOP_LOG_LIFT = 0.5;
const OVERRIDE_DEPRIORITIZE = 0.5;

const DAY = 864e5;
const WEEK_DAYS = 7;
const NO_STATUSES = new Set(['declined', 'ignored', 'expired']);
const RESET_STATUSES = new Set(['accepted', 'countered']);
const BRANCH = { ignore: 'silence', counter: 'counter', decline: 'decline', accept: 'accept' };

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));
const ids = a => (Array.isArray(a) ? a : []).map(String);
const sameSet = (a, b) => { const x = ids(a).sort(), y = ids(b).sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
const ok = f => f?.status === 'ok' && 'value' in f;

/** { enabled, preview }: preview is true only when on because of preview mode. */
export function roleplayFlag() {
  if (process.env[ROLEPLAY_ENV] === '1') return { enabled: true, preview: false };
  if (previewUnconfirmed()) return { enabled: true, preview: true };
  return { enabled: false, preview: false };
}

function checkDraft(draft) {
  if (!draft || typeof draft !== 'object') throw new RoleplayInputError('draft must be { text, give, get }');
  if (draft.text != null && typeof draft.text !== 'string') throw new RoleplayInputError('draft.text must be a string');
  return { text: draft.text ?? '', give: ids(draft.give), get: ids(draft.get) };
}

function priorOf(counterpart) {
  const rp = counterpart?.reply_prior;
  const valid = rp && REPLY_STYLES.every(k => Number.isFinite(rp[k]) && rp[k] >= 0)
    && Math.abs(REPLY_STYLES.reduce((s, k) => s + rp[k], 0) - 1) < 1e-6;
  return valid ? { p: rp, label: rp.label ?? M6_LABEL } : { p: M6_REPLY_PRIOR, label: M6_LABEL };
}

/** COUNTERPART-01's step features on a draft the plan did not price. */
function counterpartAdjust(cp, draft) {
  const out = { lift: 0, mult: 1, basis: [] };
  if (cp?.status !== 'ok') return out;
  const w = (cp.wants ?? []).filter(x => draft.give.includes(String(x.player))).sort((a, b) => b.lift - a.lift)[0];
  if (w) {
    out.lift += w.lift;
    out.basis.push({ feature: 'wants_player', player: String(w.player), effect: 'log_odds', value: w.lift, n: w.n,
      text: 'he has said he wants a player you would give' });
  }
  const untouchable = new Set(ids(cp.untouchable)), shopping = new Set(ids(cp.shopping));
  for (const id of draft.get) {
    if (untouchable.has(id)) {
      const c = cp.credibility?.untouchable ?? { value: 0.5, n: 0 };
      const never = c.value >= UNTOUCHABLE_EXCLUDE;
      out.mult *= never ? 0 : 1 - c.value;
      out.basis.push({ feature: 'untouchable_talk', player: id, effect: never ? 'exclude' : 'multiplier',
        value: never ? 0 : 1 - c.value, n: c.n,
        text: `he called this player untouchable; credibility ${c.value.toFixed(2)}${never ? ': a yes would cost him face' : ''}` });
    } else if (shopping.has(id)) {
      const c = cp.credibility?.shop ?? { value: 0.5, n: 0 };
      out.lift += SHOP_LOG_LIFT * c.value;
      out.basis.push({ feature: 'shop_talk', player: id, effect: 'log_odds', value: SHOP_LOG_LIFT * c.value, n: c.n,
        text: `he said this player is available; credibility ${c.value.toFixed(2)}` });
    }
  }
  return out;
}

/**
 * The reply-style mix for one draft. partner: the plan's partners row for him;
 * step: a plan step with this partner (used only when the draft is that step).
 * @returns {{ mix: {ignore, counter, decline, accept}, guess: boolean, basis: object[] }}
 */
export function replyMix({ team, counterpart = null, partner = null, step = null, draft }) {
  const d = checkDraft(draft);
  const prior = priorOf(counterpart);
  const basis = [{ feature: 'reply_prior', value: { ...prior.p }, text: prior.label }];
  if (!counterpart) basis.push({ feature: 'profile', text: 'no counterpart model for him here: the prior stands in for him' });
  else if (counterpart.status !== 'ok') {
    basis.push({ feature: 'profile', text: `his profile is unknown (${counterpart.reason ?? 'no reason given'}): no chat feature is used; unknown is not neutral` });
  }

  let responds = 1 - prior.p.ignore;
  if (partner && Number.isFinite(partner.p_responds)) {
    responds = clamp(partner.p_responds, 0, 1);
    basis.push({ feature: 'p_responds', value: responds, source: 'campaign.plan', text: partner.basis ?? 'plan partners row' });
  } else if (counterpart?.override?.deprioritize) {
    responds *= OVERRIDE_DEPRIORITIZE;
    basis.push({ feature: 'nick_override', effect: 'multiplier', value: OVERRIDE_DEPRIORITIZE,
      text: `Nick's note: ${counterpart.override.basis ?? 'deprioritize'}` });
  }

  const acceptGivenResponds = prior.p.accept / (1 - prior.p.ignore);
  let accept, guess = false;
  const priced = step && String(step.partner) === String(team) && sameSet(step.give, d.give) && sameSet(step.get, d.get) && ok(step.p_yes);
  if (priced) {
    accept = Math.min(clamp(step.p_yes.value, 0, 1), responds);
    guess = step.p_yes.guess === true;
    basis.push({ feature: 'p_yes', value: step.p_yes.value, source: step.p_yes.source,
      text: `the engine's P(yes) for this exact deal${guess ? ' (a guess: unvalidated model)' : ''}, capped at P(responds)` });
  } else {
    const adj = counterpartAdjust(counterpart, d);
    basis.push(...adj.basis);
    const p0 = responds * acceptGivenResponds;
    accept = p0 > 0 && p0 < 1 ? sigmoid(logit(p0) + adj.lift) * adj.mult : p0 * adj.mult;
    accept = clamp(accept, 0, responds);
  }
  const rest = responds - accept;
  const cShare = prior.p.counter / (prior.p.counter + prior.p.decline);
  const mix = { ignore: 1 - responds, counter: rest * cShare, decline: rest * (1 - cShare), accept };
  return { mix, guess, basis };
}

/** mulberry32: a small seeded PRNG, so the same draft replays the same sample. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function draw(mix, u) {
  let acc = 0;
  for (const k of REPLY_STYLES) { acc += mix[k]; if (u < acc) return k; }
  return REPLY_STYLES.filter(k => mix[k] > 0).at(-1);
}

function planSteps(plans) {
  const moves = [ok(plans.next_move) ? plans.next_move.value : null, ...(ok(plans.alternatives) ? plans.alternatives.value : [])];
  return moves.filter(Boolean).flatMap(m => m.steps ?? []);
}

function replyText(style, { cp, d, partner, nameOf }) {
  if (style === 'accept') return 'Simulated: he takes it.';
  if (style === 'ignore') return 'Simulated: no answer.';
  if (style === 'decline') {
    const u = cp?.status === 'ok' ? d.get.find(id => ids(cp.untouchable).includes(id)) : null;
    return u ? `Simulated: he says no; he called ${nameOf(u)} untouchable.` : 'Simulated: he says no.';
  }
  const want = cp?.status === 'ok' ? (cp.wants ?? []).filter(w => !d.give.includes(String(w.player))).sort((a, b) => b.lift - a.lift)[0] : null;
  if (want) return `Simulated: he counters and asks for ${nameOf(String(want.player))}, a player he has said he wants.`;
  const hole = partner?.roster_holes?.[0];
  if (hole) return `Simulated: he counters and asks for help at ${hole}, his roster hole.`;
  return 'Simulated: he counters and asks for more.';
}

function traitsOf(cp, partner, d, nameOf) {
  const out = [];
  for (const l of partner?.chat_labels ?? []) out.push({ label: l, text: `chat label ${l}` });
  for (const h of partner?.roster_holes ?? []) out.push({ label: `roster_hole:${h}`, text: `roster hole at ${h}` });
  if (cp?.status !== 'ok') return out;
  for (const w of cp.wants ?? []) out.push({ label: 'wants_player', player: String(w.player), n: w.n, text: `has said he wants ${nameOf(String(w.player))} (${w.n}x)` });
  for (const id of d.get.filter(x => ids(cp.untouchable).includes(x))) out.push({ label: 'untouchable_talk', player: id, text: `called ${nameOf(id)} untouchable` });
  for (const id of d.get.filter(x => ids(cp.shopping).includes(x))) out.push({ label: 'shop_talk', player: id, text: `said ${nameOf(id)} is available` });
  for (const [kind, c] of Object.entries(cp.credibility ?? {})) {
    if (!c) continue;
    out.push({ label: `credibility:${kind}`, n: c.n, value: c.value, text: c.status === 'prior'
      ? `his ${kind} claims are not graded yet (prior ${c.value.toFixed(2)}, ${c.open ?? 0} open)`
      : `his ${kind} claims came true ${c.kept} of ${c.n} times (credibility ${c.value.toFixed(2)})` });
  }
  return out;
}

/**
 * Sample his likely reply. plans: ONE league section of the warroom-plans/1
 * contract; team: his team id; counterpart: COUNTERPART-01 publicModel or null.
 */
export function simulateReply({ plans, team, draft, counterpart = null, samples = 200, seed = null }) {
  if (team == null || String(team) === '') throw new RoleplayInputError('team is required');
  const t = String(team);
  if (t === String(plans.me)) throw new RoleplayInputError(`team ${t} is you; role-play needs a counterpart`);
  const d = checkDraft(draft);
  if (!Number.isInteger(samples) || samples < 1) throw new RoleplayInputError('samples must be a positive integer');
  const base = { simulation: true, label: SIMULATION_LABEL, team: t };
  if (counterpart?.override?.exclude) {
    return { ...base, status: 'blocked', sampled: null, reply_mix: null,
      reason: `Nick's note says not to deal with him (${counterpart.override.basis ?? 'exclude'}); nick_override beats the model` };
  }
  const partner = ok(plans.partners) ? plans.partners.value.find(p => String(p.team) === t) ?? null : null;
  const step = planSteps(plans).find(s => String(s.partner) === t && sameSet(s.give, d.give) && sameSet(s.get, d.get)) ?? null;
  const { mix, guess, basis } = replyMix({ team: t, counterpart, partner, step, draft: d });

  const next = rng(seed ?? hash(`${t}|${d.text}|${d.give.join(',')}|${d.get.join(',')}`));
  const draws = Object.fromEntries(REPLY_STYLES.map(k => [k, 0]));
  let first = null;
  for (let i = 0; i < samples; i++) { const s = draw(mix, next()); draws[s]++; first ??= s; }

  const nameOf = id => plans.names?.[id] ?? `player ${id}`;
  const branch = step && ok(step.reply_table) ? step.reply_table.value[BRANCH[first]] : null;
  return {
    ...base, status: 'ok', reply_mix: mix, guess, basis, samples, draws,
    most_likely: REPLY_STYLES.reduce((a, b) => (mix[b] > mix[a] ? b : a)),
    sampled: { style: first, text: replyText(first, { cp: counterpart, d, partner, nameOf }),
      planned_answer: ok(branch) ? branch.value.do ?? null : null },
    traits: traitsOf(counterpart, partner, d, nameOf),
    credibility: counterpart?.status === 'ok' ? counterpart.credibility ?? null : null,
    model: { counterpart_version: counterpart?.version ?? null, profile_status: counterpart?.status ?? 'absent', plan_step: !!step }
  };
}

/* ------------------------------------------------------ how Nick comes across */

// Hand-set lexicon, not fitted: each one is a flag for Nick to read, never a score.
const TONE = [
  { label: 'pressure', re: /\b(last chance|final offer|take it or leave it|need an answer|answer (?:today|now|asap)|asap|now or never|expires? (?:today|tonight))\b/i,
    text: 'Deadline or ultimatum wording reads as pushy.' },
  { label: 'mocking', re: /\b(lol|lmao|steal|fleece[ds]?|robbery|trash|garbage|a mess|your team sucks)\b/i,
    text: 'Joking at his expense costs face; he may say no so he does not look fleeced.' },
  { label: 'reveals_need', re: /\b(i (?:really |badly )?need|desperate|begging)\b/i,
    text: 'Saying you need it tells him to raise his price.' }
];
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'DST', 'IR', 'PPR', 'FLEX', 'ROS']);

export function toneFlags(text) {
  const s = String(text ?? '');
  const out = TONE.filter(t => t.re.test(s)).map(({ label, text: why }) => ({ label, text: why }));
  const caps = s.split(/\s+/).map(w => w.replace(/[^A-Za-z]/g, '')).filter(w => w.length >= 2 && w === w.toUpperCase() && !POSITIONS.has(w));
  if (caps.length >= 3) out.push({ label: 'all_caps', text: 'Several words in capitals read as shouting.' });
  return out;
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = n => ORDINAL[n - 1] ?? `${n}th`;
const ms = v => (v == null ? null : Date.parse(v));

/**
 * history: trade_outcomes rows (or the same shape); me: Nick's team id.
 * Counts only offers Nick's team sent him, as of `now`.
 */
export function comesAcross({ history = [], me, team, draft, now, counterpart = null }) {
  const nowMs = ms(now);
  if (!Number.isFinite(nowMs)) throw new RoleplayInputError('now must be a date');
  const d = checkDraft(draft);
  const t = String(team), mine = String(me);
  const sent = history.filter(h => String(h.counterparty_team_id) === t
      && h.source !== 'considered_only' && h.status !== 'not_proposed'
      && (String(h.proposer_team_id) === mine || (h.proposer_team_id == null && h.source === 'app_proposed')))
    .map(h => ({ status: h.status, proposed: ms(h.proposed_at), resolved: ms(h.resolved_at) ?? ms(h.proposed_at) }))
    .filter(h => Number.isFinite(h.proposed) && h.proposed <= nowMs);

  const offers7d = sent.filter(h => h.proposed > nowMs - WEEK_DAYS * DAY).length;
  let streak = 0;
  for (const h of [...sent].filter(x => x.status !== 'proposed').sort((a, b) => b.resolved - a.resolved)) {
    if (NO_STATUSES.has(h.status)) streak++;
    else if (RESET_STATUSES.has(h.status)) break;
  }
  const open = sent.filter(h => h.status === 'proposed').sort((a, b) => b.proposed - a.proposed)[0] ?? null;

  const warnings = [];
  const k = offers7d + 1;
  if (offers7d >= 1) {
    warnings.push({ code: 'offer_count', severity: offers7d >= 2 ? 'warn' : 'info', n: k,
      text: `This would be the ${ordinal(k)} offer to him in 7 days.`, basis: 'trade_outcomes: offers your team sent him' });
  }
  if (streak >= 2) {
    warnings.push({ code: 'decline_streak', severity: 'warn', n: streak,
      text: `He has said no to your last ${streak} offers (declined, ignored or expired).`, basis: 'trade_outcomes' });
  }
  if (open) {
    warnings.push({ code: 'open_offer', severity: 'warn',
      text: `Your offer from ${new Date(open.proposed).toISOString().slice(0, 10)} is still unanswered; another before he replies reads as pushy.`,
      basis: 'trade_outcomes status proposed' });
  }
  if (counterpart?.status === 'ok') {
    const u = d.get.filter(id => ids(counterpart.untouchable).includes(id));
    if (u.length) {
      warnings.push({ code: 'face_cost', severity: 'warn', players: u,
        text: 'You are asking for a player he called untouchable; a yes would cost him face.', basis: 'counterpart untouchable_talk' });
    }
  }
  for (const f of toneFlags(d.text)) warnings.push({ code: 'tone', severity: 'info', label: f.label, text: f.text, basis: 'hand-set tone lexicon, not fitted' });

  return { offers_7d: offers7d, this_would_be: k, decline_streak: streak,
    open_offer_at: open ? new Date(open.proposed).toISOString() : null, warnings };
}

/* ------------------------------------------------------ entry points */

/** Flagged: the simulation plus the comes-across warnings for one draft. */
export function roleplay({ leagueId, plans, team, draft, counterpart = null, history = [], now, samples, seed }) {
  const flag = roleplayFlag();
  if (!flag.enabled) return { enabled: false };
  if (Number(plans?.league) !== Number(leagueId)) {
    throw new RoleplayInputError(`plans section is for league ${plans?.league}, not ${leagueId}`);
  }
  const sim = simulateReply({ plans, team, draft, counterpart, samples, seed });
  const out = { enabled: true, ...sim,
    comes_across: comesAcross({ history, me: plans.me, team, draft, now, counterpart }) };
  if (flag.preview) return { ...out, label: previewText(SIMULATION_LABEL), ...previewFields(ROLEPLAY_PREVIEW_REASON) };
  return out;
}

/** roleplay() with the offer history read from trade_outcomes for the league. */
export async function roleplayFor({ leagueId = ROLEPLAY_LEAGUE_ID, season, ...rest }) {
  if (!roleplayFlag().enabled) return { enabled: false };
  if (!Number.isInteger(season)) throw new RoleplayInputError('season is required');
  const { outcomesFor } = await import('../trade-outcomes.js');
  return roleplay({ leagueId, ...rest, history: outcomesFor(leagueId, season) });
}

/** The descriptor COACH-TOOLS registers (COACH-ANCHOR.md tool table: roleplay). */
export const ROLEPLAY_TOOL = Object.freeze({
  name: 'roleplay', kind: 'simulation', writes: false,
  source: 'server/services/coach/roleplay.js#roleplayFor',
  description: "Role-play a league-mate's likely reply to a drafted message, sampled from the counterpart model " +
    '(reply mix, traits, credibility), always labelled as a simulation, plus how Nick comes across to him ' +
    '(offers this week, no-streak, open offer, tone). Read-only: Coach never sends anything.',
  input_schema: { type: 'object', required: ['team', 'text'], properties: {
    team: { type: 'string' }, text: { type: 'string' },
    give: { type: 'array', items: { type: 'string' } }, get: { type: 'array', items: { type: 'string' } }
  } }
});
