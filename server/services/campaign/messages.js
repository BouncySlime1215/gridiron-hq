/**
 * COACH-MSG: the message Nick sends at each campaign step (NORTH-STAR row 6).
 *
 * For every step of the next move and the deck alternatives this writes, into the
 * contract's existing slots (plans-schema.js; no new keys):
 *   message              what Nick pastes, in plain group-chat style, framed on the
 *                        partner's side (his engine-read roster holes, the profile's
 *                        approach labels, a way to say no without losing face)
 *   reply_table.*.do     accept / decline / counter / silence -> the next thing to do,
 *                        with player names instead of ids
 *   reply_table.*.message  the short reply for that branch (counter offer, nudge, thanks)
 *   walk_away            the most Nick gives, in names
 * Every text goes through message-check.js#checkMessage against the step's own
 * engine fields; a text that fails keeps the producer's template text (the
 * fallback), so a message can never state a player, number or position the
 * engine did not attach to that step.
 *
 * Inputs are the plans entry (warroom-plans/1) plus, optionally, the league's
 * negotiation profiles (roster id -> stored profile). Profiles are reduced to
 * LABELS by profileLabels (keyword classes such as short_clean, need_frame,
 * no_pressure); no profile or chat text is ever copied into a message.
 *
 * Switch: GRIDIRON_COACH_MESSAGES=1, or the local preview switch
 * (preview-mode.js#previewUnconfirmed). Off: applyCoachMessages returns the entry
 * untouched. The optional model phraser (phraseWithModel) additionally needs
 * GRIDIRON_ALLOW_PAID_RUN set and goes through the same checker; the rules
 * phraser below is deterministic and costs nothing.
 *
 * VOICE-01 (GRIDIRON_NICK_VOICE=1 and a voice passed in opts.voice, see coach/voice.js): every
 * outgoing text (the message and each reply-table message) is restyled the way Nick texts that
 * partner, as 1-3 short bursts on separate lines. The unstyled text must pass the checker first
 * and every burst must pass it again; otherwise the unstyled text stays.
 *
 * Hand-set (not fitted): the phrasing choices, EVEN_PCT (5: the his-screen band
 * called "even"), and the label keyword classes.
 */
import { previewUnconfirmed } from '../preview-mode.js';
import { NUDGE_HOURS, SWITCH_HOURS, teamLabel } from './playbook.js';
import { checkMessage, checkBursts, factsFor, splitName, surname, numberTokens, MAX_CHARS } from './message-check.js';
import { nickVoiceOn, resolveProfile, styleText, surnamePairs, loadNickVoice } from '../coach/voice.js';
import { firmOfferText } from './negotiator-defaults.js';

export const COACH_MESSAGES_ENV = 'GRIDIRON_COACH_MESSAGES';
export const COACH_SOURCE = 'coach.text';
export const EVEN_PCT = 5;

/** On with its own flag, or with the local preview switch. */
export const coachMessagesOn = (env = process.env) => env[COACH_MESSAGES_ENV] === '1' || previewUnconfirmed();

/** The paid path needs the flag AND the paid-run opt-in (presence only; the value is never read into text). */
export const paidPhrasingAllowed = (env = process.env) =>
  coachMessagesOn(env) && typeof env.GRIDIRON_ALLOW_PAID_RUN === 'string' && env.GRIDIRON_ALLOW_PAID_RUN.trim() !== '';

/* ------------------------------------------------------------------ profile -> labels */

const LABEL_RULES = [
  ['short_clean', /\b(short|clean|concise|one (exact|concrete|clear)|1-for-1|complete|zero effort|simple)\b/i],
  ['casual', /\b(casual|casually|banter|joke|jokes|friends?|bet)\b/i],
  ['need_frame', /\b(need|needs|hole|thin|helping his|fixes|stronger|upgrade)\b/i],
  ['fair_frame', /\b(fair|value-fair|even)\b/i],
  ['his_call', /\b(his call|let him|face|publicly|public|private|privately|loses face|status)\b/i],
  ['no_pressure', /\b(hurr\w*|rush\w*|pressure|impatien\w*|deadline|pushy|on the spot)\b/i],
  ['expect_counter', /\b(counter|counters|haggl\w*|anchors?)\b/i],
  ['slow_reply', /\b(slow|delay|let me (look|see)|defers?|takes? (a while|time)|patient)\b/i],
];
const SHUT_RULES = [
  ['no_lowball', /\b(lowball\w*|scam|fleece|throw-ins?|bench fluff|quantity-for-quality)\b/i],
  ['no_pressure', /\b(pressure|hurry|deadline|rush|on the spot)\b/i],
  ['his_call', /\b(publicly|public|called out|mocked|loses face)\b/i],
];

const textOf = v => (Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : '');

/**
 * A stored negotiation profile -> labels for one step. Never returns profile text.
 * giveIds / getIds: the step's players; names: the league names map.
 * Returns { labels: Set, bait: id | null, avoid_lead: Set ids, core_ask: Set ids }
 *   bait        a player Nick gives whom the profile's bait line names (not negated)
 *   avoid_lead  a player Nick gives whom the bait line says not to lead with
 *   core_ask    a player Nick asks for whom the profile lists as untouchable or a shut-down ask
 */
export function profileLabels(profile, { giveIds = [], getIds = [], names = {} } = {}) {
  const out = { labels: new Set(), bait: null, avoid_lead: new Set(), core_ask: new Set() };
  if (!profile || typeof profile !== 'object') return out;
  const approach = textOf(profile.how_to_approach);
  const shut = textOf(profile.what_shuts_him_down);
  for (const [k, re] of LABEL_RULES) if (re.test(approach)) out.labels.add(k);
  for (const [k, re] of SHUT_RULES) if (re.test(shut)) out.labels.add(k);
  const holds = String(profile.says_no?.does_his_no_hold ?? '');
  if (/^\s*(yes|usually|mostly yes|likely yes)/i.test(holds)) out.labels.add('no_holds');
  const bait = textOf(profile.best_bait);
  const mentions = (text, id) => {
    const { name } = splitName(names[String(id)]);
    const sn = surname(name);
    const hits = [];
    for (const needle of [name, sn].filter(s => s && s.length > 2)) {
      for (const m of text.matchAll(new RegExp(`(^|[^A-Za-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'g'))) hits.push(m.index);
    }
    return hits;
  };
  for (const id of giveIds) {
    for (const at of mentions(bait, id)) {
      const before = bait.slice(Math.max(0, at - 30), at);
      if (/\b(not|never|don't|do not|poor bait|avoid)\b[^.]*$/i.test(before)) out.avoid_lead.add(String(id));
      else if (!out.bait) out.bait = String(id);
    }
  }
  const core = [textOf(profile.roster_read?.really_untouchable), shut].join(' ');
  for (const id of getIds) if (mentions(core, id).length) out.core_ask.add(String(id));
  return out;
}

/* ------------------------------------------------------------------ helpers */

const ids = a => (Array.isArray(a) ? a.map(String) : []);
const okv = f => (f && f.status === 'ok' ? f.value : null);
const pick = (seed, arr) => arr[Math.abs(seed) % arr.length];
function seedOf(...parts) {
  let h = 2166136261;
  for (const c of parts.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const chatLabel = (partner, key) => (partner?.chat_labels ?? []).find(l => l.startsWith(`${key}:`))?.split(':')[1] ?? null;

/** Player display name (no position) and position, from the league names map. */
const who = (names, id) => splitName(names[String(id)] ?? '');
const joinNames = (names, list) => {
  const n = list.map(id => who(names, id).name).filter(Boolean);
  return n.length <= 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};
const plus = (names, list) => list.map(id => who(names, id).name).join(' + ');

/** "his screen -4%" inside a producer string -> -4 (the number the engine wrote), else null. */
const screenPct = s => {
  const m = /his screen ([+-]?\d+)%/.exec(String(s ?? ''));
  return m ? Number(m[1]) : null;
};
const sgn = p => `${p >= 0 ? '+' : ''}${p}%`;
/** Player ids written inside a producer string ("the next rung: 408 + 478 (...)") that are league players. */
const idsInText = (s, names) => [...String(s ?? '').split('(')[0].matchAll(/\b\d+\b/g)].map(m => m[0]).filter(id => Object.hasOwn(names, id));

/* ------------------------------------------------------------------ the rules phraser */

/**
 * The outgoing offer for one step (pure, deterministic).
 * ctx: { names, partner (partners[] row), prof (profileLabels result), give (ids offered), get, even (bool|null), seed }
 */
export function offerText({ names, partner, prof, give, get, even, seed }) {
  const L = prof?.labels ?? new Set();
  const tone = chatLabel(partner, 'tone');
  const engagement = chatLabel(partner, 'engagement');
  const holes = (partner?.roster_holes ?? []).map(p => String(p).toUpperCase());
  const short = L.has('short_clean') || engagement === 'low';
  const casual = L.has('casual');

  const greet = short ? '' : casual ? 'Yo! ' : tone === 'friendly' ? pick(seed, ['Hey! ', 'Hey man! ']) : 'Hey! ';

  // Hook: his side first. Need (engine roster holes) > bait (profile) > position swap > neutral.
  const fit = give.find(id => holes.includes(who(names, id).position ?? ''));
  const baitId = prof?.bait && give.includes(prof.bait) && !prof.avoid_lead?.has(prof.bait) ? prof.bait : null;
  let hook = '';
  if (fit) {
    const { name, position } = who(names, fit);
    hook = pick(seed, [`Looks like you could use a little help at ${position}, and ${name} would slot right in. `,
      `You look a bit thin at ${position}, and ${name} could step right in for you. `]);
  } else if (baitId) {
    hook = pick(seed, [`Thought ${who(names, baitId).name} could be a nice fit on your team. `,
      `Figured ${who(names, baitId).name} might be useful for you. `]);
  } else if (!short) {
    const gp = [...new Set(give.map(id => who(names, id).position).filter(Boolean))];
    const tp = [...new Set(get.map(id => who(names, id).position).filter(Boolean))];
    hook = gp.length === 1 && tp.length === 1 && gp[0] !== tp[0]
      ? `Had an idea for a ${gp[0]}-for-${tp[0]} swap that could help us both. `
      : pick(seed, ['Had an idea that could work for both of us. ', 'Been looking at our rosters and had an idea. ']);
  }

  const g = joinNames(names, give), t = joinNames(names, get);
  const ask = L.has('his_call') || short
    ? `${g} for ${t}? Your call.`
    : casual ? pick(seed, [`Would you do ${g} for ${t}?`, `Any interest in ${g} for ${t}?`])
      : `Would you do ${g} for ${t}?`;
  const fair = even && (L.has('fair_frame') || L.has('no_lowball')) ? ' Tried to keep it even.' : '';

  const close = L.has('no_pressure') || L.has('his_call') ? ' No rush, and no worries if not.'
    : L.has('no_holds') ? ' If it is a no, all good.'
      : L.has('expect_counter') ? ' Open to tweaking it.'
        : pick(seed, [' No worries if not.', ' Open to tweaking it if not.']);

  let text = `${greet}${hook}${ask}${fair}${close}`.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_CHARS) text = `${ask}${close}`.trim();
  if (text.length > MAX_CHARS) text = `${plus(names, give)} for ${plus(names, get)}?`;
  return text;
}

/* ------------------------------------------------------------------ one step */

/**
 * Coach texts for one step. Returns { step (new object), grounded (bool), errors: [..] }.
 * ctx: { names, partners (by team), profiles (roster -> profile), plan (move), i, moveById, phrase (optional sync override),
 *        teams (the entry's teams map; optional) }
 */
export function coachStep(step, { names, partnerByTeam, profiles, plan, i, moveById, phrase = offerText, voice = null, teams = null }) {
  const out = structuredClone(step);
  // A step the producer gave no playbook (view.js PLAYBOOK_LATER / PLAYBOOK_FIRST_ONLY: its opening,
  // walk_away and reply_table are 'unknown') gets the offer message only. Its reply table and walk-away
  // stay the producer's 'unknown': nothing was priced and no backup was chosen, so there is nothing
  // true to say about them.
  const priced = isPriced(step);
  const partner = partnerByTeam.get(String(step.partner)) ?? null;
  const opening = okv(step.opening);
  const walk = okv(step.walk_away);
  const table = okv(step.reply_table);
  const counterRules = okv(table?.counter)?.counter_rules ?? null;
  const rung = counterRules ? idsInText(counterRules.counter_with, names) : [];
  const next = plan.steps[i + 1] ?? null;
  const backupId = okv(table?.decline)?.move_id ?? null;
  const backup = backupId ? moveById.get(backupId)?.steps?.[0] ?? null : null;

  const give = opening ? ids(opening.give) : ids(step.give);
  const get = ids(step.get);
  // NEGOTIATOR-DEFAULTS: the producer wrote this step's levers (flag on there); the texts follow them.
  const nego = okv(step.negotiation);
  const alt = nego?.alt_package ? ids(nego.alt_package.give) : [];
  const maxGive = walk ? ids(walk.max_give) : ids(step.give);
  const pctOpen = opening ? screenPct(opening.text) : null;
  const pctWalk = counterRules ? screenPct(counterRules.accept_if) : null;
  const pctRung = counterRules ? screenPct(counterRules.counter_with) : null;

  // Facts this step's texts may use: its own players, its ladder, the next / backup offer, his holes,
  // the team ids, the silence clock and the his-screen numbers the producer wrote.
  const allowIds = [...ids(step.give), ...get, ...give, ...maxGive, ...rung,
    ...(next ? [...ids(next.give), ...ids(next.get)] : []), ...(backup ? [...ids(backup.give), ...ids(backup.get)] : [])];
  const numbers = [String(step.partner), next?.partner, backup?.partner, NUDGE_HOURS, SWITCH_HOURS]
    .filter(v => v != null).map(String);
  for (const p of [pctOpen, pctWalk, pctRung]) if (p != null) numbers.push(`${p}%`);
  for (const s of [okv(step.send_when)]) if (typeof s === 'string') numbers.push(...numberTokens(s));
  const facts = factsFor({ names, ids: allowIds, holes: partner?.roster_holes ?? [], numbers });
  // Outgoing texts (what the partner reads) get a stricter fact set: players and positions only.
  const outFacts = factsFor({ names, ids: [...give, ...get, ...maxGive, ...rung, ...alt], holes: partner?.roster_holes ?? [], numbers: [] });

  const prof = profileLabels(profiles?.get?.(String(step.partner)) ?? null, { giveIds: give, getIds: get, names });
  const seed = seedOf(step.partner, ...give, ...get, i);
  const errors = [];
  // TEAM-NAMES-2: the checker grades the 'Team N' spelling (a manager's name is not a player, number or
  // position, and would read as an invented proper noun); the text Nick reads then names the team with
  // playbook.js#teamLabel on the entry's teams map. Only the next / backup partner is ever named.
  const named = text => [next?.partner, backup?.partner].filter(v => v != null).map(String)
    .reduce((t, id) => t.split(`Team ${id} `).join(`${teamLabel(teams, id)} `), text);
  const put = (text, f, label) => {
    const c = checkBursts(text, f);
    if (!c.ok) errors.push(`${label}: ${c.errors.join('; ')}`);
    return c.ok ? text : null;
  };
  // VOICE-01: an outgoing text that passed the checker, in Nick's voice for this partner. The
  // styled bursts must pass the checker again; if not, the unstyled text stands.
  const vProfile = voice ? resolveProfile(voice, voice.forRoster?.(step.partner) ?? {}) : null;
  const keepNames = [...outFacts.allowed].map(id => splitName(names[id]).name);
  const short = vProfile ? surnamePairs(Object.values(names).map(n => splitName(n).name), keepNames) : [];
  let voiced = 0;
  const say = (text, label) => {
    const plain = put(text, outFacts, label);
    if (!plain || !vProfile) return plain;
    const styled = styleText(plain, vProfile, { keep: keepNames, short }).text;
    const c = checkBursts(styled, outFacts);
    if (!c.ok) { errors.push(`${label} (voice): ${c.errors.join('; ')}`); return plain; }
    voiced++;
    return styled;
  };

  // 1. The message.
  const firm = () => firmOfferText({ who: id => who(names, id), give, get, alt: alt.length ? alt : null,
    holes: partner?.roster_holes ?? [], maxChars: MAX_CHARS });
  const msg = say(nego ? firm() : phrase({ names, partner, prof, give, get, even: pctOpen != null ? Math.abs(pctOpen) <= EVEN_PCT : null, seed }), 'message');
  if (msg) out.message = { status: 'ok', value: msg, source: COACH_SOURCE };

  if (!priced) return { step: out, grounded: !!msg, priced, errors, voiced };

  // 2. Walk-away, in names. Only where the engine priced one; otherwise the producer's reason stands.
  if (walk) {
    const w = put(`Most you give: ${plus(names, maxGive)} for ${plus(names, get)}. Past that, ${backup ? 'your backup plan is worth more' : 'say no'}.`, facts, 'walk_away');
    if (w) out.walk_away = { status: 'ok', value: { text: w, max_give: maxGive }, source: step.walk_away.source };
  }

  // 3. Reply table, in names.
  const rows = {};
  const deal = s => `${plus(names, ids(s.give))} for ${plus(names, ids(s.get))}`;
  const row = (kind, value) => {
    const prev = okv(table?.[kind]) ?? {};
    const doOk = put(value.do, facts, `${kind}.do`);
    const message = value.message ? say(value.message, `${kind}.message`) : undefined;
    const good = doOk && (value.message ? message : true);
    rows[kind] = good ? { status: 'ok', value: { ...prev, ...value, do: named(value.do), ...(message ? { message } : {}) }, source: table?.[kind]?.source ?? 'plan.path' } : table?.[kind] ?? null;
  };
  const faceSave = prof.labels.has('his_call') || prof.labels.has('no_pressure');
  row('accept', {
    do: next ? `He's in. Accept it in the app, then offer Team ${next.partner} ${deal(next)}.`
      : 'He\'s in. Accept it in the app; that completes this plan and the next one comes on the next refresh.',
    message: pick(seed, ['Deal! Sending it over now.', 'Sounds good, sending it now.']),
  });
  const coreNote = prof.core_ask.size ? ` Do not ask for ${joinNames(names, [...prof.core_ask])} again.` : '';
  row('decline', {
    do: (backup ? `Thank him, log why he passed, then offer Team ${backup.partner} ${deal(backup)} instead.`
      : 'Thank him and log why he passed. No backup is set for this step; the plan is redone on the next refresh.') + coreNote,
    message: faceSave ? 'All good, totally get it. Appreciate you looking.' : 'All good, appreciate you looking at it.',
  });
  if (counterRules && rung.length) {
    row('counter', {
      do: `If his ask is no more than ${plus(names, maxGive)}, take it. Otherwise offer ${plus(names, rung)} for ${plus(names, get)}. Anything richer: say no${backup ? ' and use the backup' : ''}.`,
      message: `What if I did ${joinNames(names, rung)} for ${joinNames(names, get)} instead?`,
      counter_rules: {
        accept_if: `his ask is no richer than ${plus(names, maxGive)}${pctWalk != null ? ` (his screen ${sgn(pctWalk)})` : ''}`,
        counter_with: `${plus(names, rung)}${pctRung != null ? ` (his screen ${sgn(pctRung)})` : ''}`,
        walk_away_if: backup ? 'his ask is richer than that: your backup plan is worth more' : 'his ask is richer than that: say no',
      },
    });
  } else {
    row('counter', {
      do: `No walk-away was priced, so hold at ${plus(names, give)} for ${plus(names, get)}. Say no to a counter that adds players on your side.`,
      message: `I think ${joinNames(names, give)} for ${joinNames(names, get)} is about where I can be.`,
    });
  }
  const slow = prof.labels.has('slow_reply');
  row('silence', {
    when: `no reply in ${NUDGE_HOURS} h`,
    do: `${slow ? 'He tends to take a while. ' : ''}Send one nudge after ${NUDGE_HOURS} h. After ${SWITCH_HOURS} h with no answer, withdraw${backup ? ` and offer Team ${backup.partner} ${deal(backup)}` : '; the plan is redone on the next refresh'}.`,
    message: `Any thoughts on ${joinNames(names, give)} for ${joinNames(names, get)}?${nego ? ' It stands until tomorrow.' : ' Happy to tweak it.'}`,
  });
  if (['accept', 'decline', 'counter', 'silence'].every(k => rows[k])) {
    out.reply_table = { status: 'ok', value: rows, source: step.reply_table.source };
  }
  return { step: out, grounded: !!msg, priced, errors, voiced };
}

/* ------------------------------------------------------------------ the entry */

/** True when the producer wrote this step a playbook (its reply table is 'ok'). */
export const isPriced = step => step?.reply_table?.status === 'ok';

/** The steps the metric grades: next move + up to five alternatives, deduplicated by move id. */
export function targetMoves(entry) {
  const seen = new Set(), out = [];
  for (const m of [okv(entry.next_move), ...(okv(entry.alternatives) ?? []).slice(0, 5)]) {
    if (!m || seen.has(m.move_id)) continue;
    seen.add(m.move_id); out.push(m);
  }
  return out;
}

/**
 * The plans entry with coach texts in place (pure; returns a new entry). Off -> the same entry.
 * opts: { profiles: Map roster -> stored negotiation profile, force (tests/measurement), phrase,
 *         voice: coach/voice.js#loadNickVoice(league) result; used only with GRIDIRON_NICK_VOICE=1 }
 * Returns { entry, stats: { steps, grounded, fallback, voiced, errors: [{ move_id, i, errors }] } }.
 */
export function applyCoachMessages(entry, { profiles = null, force = false, phrase, voice = null } = {}) {
  const stats = { steps: 0, grounded: 0, fallback: 0, unpriced: 0, voiced: 0, errors: [] };
  const v = voice && nickVoiceOn() ? voice : null;
  if ((!force && !coachMessagesOn()) || !entry || entry.error) return { entry, stats };
  const out = structuredClone(entry);
  const names = out.names ?? {};
  const partnerByTeam = new Map((okv(out.partners) ?? []).map(p => [String(p.team), p]));
  const teams = okv(out.teams) ?? null;
  const allMoves = [okv(out.next_move), ...(okv(out.alternatives) ?? [])].filter(Boolean);
  const moveById = new Map(allMoves.map(m => [m.move_id, m]));
  const done = new Map();
  for (const m of allMoves) {
    if (done.has(m.move_id)) { m.steps = done.get(m.move_id); continue; }
    m.steps = m.steps.map((s, i) => {
      const r = coachStep(s, { names, partnerByTeam, profiles, plan: m, i, moveById, voice: v, teams, ...(phrase ? { phrase } : {}) });
      stats.steps++;
      stats.voiced += r.voiced;
      if (r.grounded) stats.grounded++; else stats.fallback++;
      if (!r.priced) stats.unpriced++;
      if (r.errors.length) stats.errors.push({ move_id: m.move_id, i, errors: r.errors });
      return r.step;
    });
    done.set(m.move_id, m.steps);
  }
  return { entry: out, stats };
}

/**
 * The caller's one line (the producer, MSG-WIRE): applyCoachMessages with Nick's voice loaded from
 * the private chat DB when GRIDIRON_NICK_VOICE=1. The chat DB is not opened when the flag is off or
 * COACH-MSG is off; no chat DB or no profile table -> voice null -> the unstyled texts.
 * opts: applyCoachMessages opts plus loadVoice (league -> voice; default coach/voice.js#loadNickVoice).
 */
export async function coachMessagesFor(entry, { loadVoice = loadNickVoice, ...opts } = {}) {
  const want = nickVoiceOn() && (opts.force || coachMessagesOn()) && entry && !entry.error;
  const voice = want ? await loadVoice(entry.league) : null;
  return applyCoachMessages(entry, { ...opts, voice });
}

/**
 * The metric: over next_move + top-5 alternatives (deduplicated), the share of steps whose
 * message is a coach message that passes the checker, the number of coach messages that FAIL
 * the checker (must be 0), and the longest message.
 */
export function gradeEntry(entry) {
  const r = { steps: 0, coach: 0, template: 0, missing: 0, ungrounded: 0, template_ungrounded: 0, max_len: 0,
    priced_steps: 0, priced_coach: 0, full_coach: 0, invented_playbook: 0 };
  if (!entry || entry.error) return r;
  const names = entry.names ?? {};
  const partnerByTeam = new Map((okv(entry.partners) ?? []).map(p => [String(p.team), p]));
  for (const m of targetMoves(entry)) {
    for (const s of m.steps) {
      r.steps++;
      const priced = isPriced(s);
      if (priced) r.priced_steps++;
      // A reply table or walk-away on a step with no playbook would be invented (must stay 0).
      if (!priced && (s.reply_table?.status === 'ok' || s.walk_away?.status === 'ok')) r.invented_playbook++;
      const msg = s.message;
      if (msg?.status !== 'ok') { r.missing++; continue; }
      const opening = okv(s.opening);
      const walk = okv(s.walk_away);
      const rung = idsInText(okv(okv(s.reply_table)?.counter)?.counter_rules?.counter_with, names);
      const f = factsFor({ names, ids: [...ids(s.give), ...ids(s.get), ...ids(opening?.give), ...ids(walk?.max_give), ...rung],
        holes: partnerByTeam.get(String(s.partner))?.roster_holes ?? [], numbers: [] });
      const c = checkBursts(msg.value, f);
      r.max_len = Math.max(r.max_len, String(msg.value).length);
      if (msg.source === COACH_SOURCE) {
        r.coach++;
        if (!c.ok) r.ungrounded++;
        else if (priced) {
          r.priced_coach++;
          const rt = okv(s.reply_table);
          if (['accept', 'decline', 'counter', 'silence'].every(k => rt?.[k]?.status === 'ok')) r.full_coach++;
        }
      } else { r.template++; if (!c.ok) r.template_ungrounded++; }
    }
  }
  return r;
}

/**
 * The metric over a whole plans file. apply: run applyCoachMessages first (forced on; profilesFor(league)
 * -> Map or null). Returns totals, the grounded share, and whether the (applied) file passes validatePlans
 * is left to the caller (plans-schema.js#validatePlans on `doc`).
 */
export function gradePlansFile(file, { apply = false, profilesFor = () => null, voiceFor = () => null } = {}) {
  const doc = apply ? { ...file, leagues: file.leagues.map(e => applyCoachMessages(e, { force: true, profiles: profilesFor(e.league), voice: voiceFor(e.league) }).entry) } : file;
  const t = { steps: 0, coach: 0, template: 0, missing: 0, ungrounded: 0, template_ungrounded: 0, max_len: 0,
    priced_steps: 0, priced_coach: 0, full_coach: 0, invented_playbook: 0 };
  for (const e of doc.leagues) {
    const g = gradeEntry(e);
    for (const k of Object.keys(t)) t[k] = k === 'max_len' ? Math.max(t[k], g[k]) : t[k] + g[k];
  }
  return {
    doc, totals: t,
    grounded_share: t.steps ? (t.coach - t.ungrounded) / t.steps : null,
    // Steps with a playbook whose message AND reply table are coach texts, over all graded steps.
    full_share: t.steps ? t.full_coach / t.steps : null,
  };
}

/* ------------------------------------------------------------------ optional model phraser */

/**
 * Behind paidPhrasingAllowed(): ask a model for the outgoing message from LABELS and engine facts
 * only, then gate it with the checker; any failure returns null and the rules text stands.
 * callModel: async ({ prompt }) -> string (inject callClaude from claude.js; tests inject a fake).
 */
export async function phraseWithModel(ctx, { callModel, env = process.env } = {}) {
  if (!paidPhrasingAllowed(env) || typeof callModel !== 'function') return null;
  const { names, give, get, partner, prof } = ctx;
  const facts = factsFor({ names, ids: [...give, ...get], holes: partner?.roster_holes ?? [], numbers: [] });
  const prompt = [
    'Write one fantasy-football trade message, friendly group-chat style, at most 240 characters.',
    `Offer: ${joinNames(names, give)} for ${joinNames(names, get)}.`,
    `His roster holes (engine read): ${(partner?.roster_holes ?? []).join(', ') || 'none read'}.`,
    `Approach labels: ${[...(prof?.labels ?? [])].join(', ') || 'none'}.`,
    'Rules: name no other players, no numbers, no quotes; frame it on his side; give him an easy way to say no.',
  ].join('\n');
  try {
    const text = String(await callModel({ prompt })).trim();
    return checkMessage(text, facts).ok ? text : null;
  } catch { return null; }
}
