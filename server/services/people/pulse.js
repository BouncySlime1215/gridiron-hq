/**
 * PULSE-01: the chat pulse (PEOPLE-FLOW §2, M9).
 *
 * Each refresh tick, scripts/people/pulse.mjs calls `pulseTick` for the target league. It
 * reads the league-mates' chat messages that arrived since the last pass (never Nick's own:
 * is_from_me), labels each one with statement types (the PEOPLE-LAB set: WANT_PLAYER, SHOP,
 * UNTOUCHABLE, HYPE, FRUSTRATED, URGENCY, REFUSAL, ACCEPT_TALK, TRADE_REACTION, WANT_POS),
 * the players and position it names and the speaker's roster, and appends one
 * `people_pulse` row per statement (migration 098). The text is read in memory and dropped:
 * a row holds labels and ids only, never a quote or a name.
 *
 * Weight. A statement's weight is its follow-through: how much more often this kind of talk
 * from this manager turned into the matching action than the base rate (PEOPLE-FLOW §3).
 * CRED-01 (server/services/people/credibility.js, per manager, nightly) supplies it when it
 * is present; `credibility` is injected so this module never guesses its interface. Without
 * it the pooled PEOPLE-LAB result is the prior: WANT_PLAYER -> acquires that player within
 * 7 days at 17x base (CI 9.7-25.5, n=53). Every other type is proven noise or untested
 * pooled, so it has no weight (typed 'unknown', never 'neutral') until CRED-01 gives this
 * manager one. A statement is CREDIBLE when its weight is at least CREDIBLE_LIFT; a live
 * credible statement is what asks the planner to replan the league (pulse.mjs).
 *
 * The labeller is deterministic text rules plus a player lexicon built from the league's
 * own rostered players (full names, unique surnames, rare first names, initialisms like
 * the ones league chats use). It is graded against the PEOPLE-LAB hand labels by
 * `scripts/people/pulse.mjs --grade` (per-type precision / recall; counts only).
 *
 * PULSE-02 (all of this paragraph only with GRIDIRON_PULSE_02=1; off, the tick is PULSE-01
 * and PULSE-02 is grading only): with GRIDIRON_PULSE_JEV=1 the pulse also asks Jev its own questions per message
 * (pulse-jev.js, scripts/people/jev-pulse.mjs), with the thread's last lines and whose team
 * every named player is on; WANT_PLAYER / SHOP / URGENCY / REFUSAL then need the rules and
 * Jev to agree (PULSE_CUTS). A type asks for a replan only when its label is proven on the
 * held-out labels (replanGate: F1 >= 0.7); today that is WANT_PLAYER on the Jev path alone.
 * Ownership at a message's time now reads the chat's zone-less UTC stamps as UTC (chatTime)
 * and counts trades the feed logged only as a proposal when a weekly snapshot shows them.
 *
 * The web server only calls `recentPulse` (the ticker read). Nothing here imports the
 * engine: the refresh role never does (engine/role.js); the engine adapter `people_pulse`
 * (engine/backfill.js) reads the table on its own.
 */
import { db as appDb } from '../../db/index.js';
import { previewUnconfirmed } from '../preview-mode.js';
import { TRUSTED_CONFIDENCE } from '../manager-identity.js';
import { threadContext, pulseJevFeatures } from './pulse-jev.js';

export const PULSE_VERSION = 'pulse-1';
/** labeller_version of rows written with GRIDIRON_PULSE_02=1. */
export const PULSE_02_VERSION = 'pulse-2';
export const STATEMENT_TYPES = Object.freeze(['WANT_PLAYER', 'SHOP', 'UNTOUCHABLE', 'HYPE', 'FRUSTRATED', 'URGENCY',
  'REFUSAL', 'ACCEPT_TALK', 'TRADE_REACTION', 'WANT_POS']);
/** A statement whose follow-through is at least this multiple of the base rate is credible. */
export const CREDIBLE_LIFT = 2;
/** Pooled PEOPLE-LAB priors (rnd/meta/people-lab.md, prereg 04b7c034): only proven lifts carry weight. */
export const POOLED_PRIOR = Object.freeze({
  WANT_PLAYER: Object.freeze({ lift: 17.0, n: 53, basis: 'people-lab pooled: acquires that player within 7d (CI 9.7-25.5)' }),
});
export const TICKER_HOURS = 72;
/**
 * PULSE-02: how the pulse's Jev answer and the rules combine per type (labelMessage): a rule
 * hit counts at Jev >= lo, Jev alone at >= hi. Chosen on the TRAIN half of the PEOPLE-LAB
 * labels only (messages before PULSE_SPLIT_AT; `pulse.mjs --grade <dir> --tune`).
 */
export const PULSE_SPLIT_AT = '2026-09-17T00:00:00Z';
export const PULSE_CUTS = Object.freeze({
  WANT_PLAYER: Object.freeze({ lo: 0.35, hi: 1 }),
  SHOP: Object.freeze({ lo: 0.5, hi: 0.6 }),
  URGENCY: Object.freeze({ lo: 0.6, hi: 1 }),
  REFUSAL: Object.freeze({ lo: 0.6, hi: 0.85 }),
});
/**
 * PULSE-02 replan gate. A statement type may ask for a replan only when its label is proven:
 * F1 >= REPLAN_MIN_F1 against the PEOPLE-LAB hand labels on the held-out half (messages from
 * PULSE_SPLIT_AT on, never used to choose PULSE_CUTS), for the path that labelled it: 'jev'
 * (the pulse's own Jev answers + rules) or 'rules' (rules alone: no Jev answer for the
 * message). Re-measure with `pulse.mjs --grade <labels dir>` and update these numbers with
 * the labeller; a type that is missing here is unmeasured and gated.
 */
export const REPLAN_MIN_F1 = 0.7;
export const LABEL_QUALITY = Object.freeze({
  measured: 'PULSE-02 2026-09-24: people-lab labels (league_ref L4), test = league-mates\' messages from 2026-09-17 (809 msgs), pulse-jev-3',
  jev: Object.freeze({ WANT_PLAYER: 0.73, SHOP: 0.603, UNTOUCHABLE: 0.25, HYPE: 0.368, FRUSTRATED: 0.138, URGENCY: 0,
    REFUSAL: 0.452, ACCEPT_TALK: 0, TRADE_REACTION: 0.244, WANT_POS: 0.25 }),
  rules: Object.freeze({ WANT_PLAYER: 0.651, SHOP: 0.611, UNTOUCHABLE: 0.25, HYPE: 0.368, FRUSTRATED: 0.138, URGENCY: 0,
    REFUSAL: 0.286, ACCEPT_TALK: 0, TRADE_REACTION: 0.244, WANT_POS: 0.25 }),
});

/** May a statement of `type`, labelled by `source`, ask for a replan? {ok, f1, reason}. */
export function replanGate(type, source = 'rules', quality = LABEL_QUALITY, minF1 = REPLAN_MIN_F1) {
  const f1 = quality?.[source]?.[type];
  if (!Number.isFinite(f1)) return { ok: false, f1: null, reason: `label unmeasured (${type}, ${source})` };
  if (f1 < minF1) return { ok: false, f1, reason: `label F1 ${f1} < ${minF1} (${type}, ${source})` };
  return { ok: true, f1, reason: null };
}
export const PULSE_FLAG = 'GRIDIRON_PULSE_ENABLED';
/**
 * PULSE-02 is grading only until this flag is on (its own flag; preview mode never turns it
 * on). Off, the live tick labels, stores and replans exactly as PULSE-01: no new aliases, no
 * proposal-only trades, no zone fix, no pulse Jev answers, no replan gate. The grader
 * (`pulse.mjs --grade`) and the Jev step always measure the PULSE-02 path. Read per call.
 */
export const PULSE_02_FLAG = 'GRIDIRON_PULSE_02';
export const pulse02On = (env = process.env) => env[PULSE_02_FLAG] === '1';

/** Default off (RULES §3): on with GRIDIRON_PULSE_ENABLED=1 or local preview mode. Read per call. */
export const pulseEnabled = (env = process.env) => env[PULSE_FLAG] === '1' || previewUnconfirmed();

const POS_WORDS = [
  ['QB', /\b(qbs?|quarterbacks?)\b/], ['RB', /\b(rbs?|running ?backs?)\b/], ['WR', /\b(wrs?|wide ?receivers?|receivers?)\b/],
  ['TE', /\b(tes|te|tight ?ends?)\b/], ['DST', /\b(dst|d\/st|defen[cs]es?)\b/], ['K', /\b(kickers?)\b/], ['FLEX', /\bflex\b/],
];
const POS_ALT = '(?:qbs?|quarterbacks?|rbs?|running ?backs?|wrs?|wide ?receivers?|receivers?|tes?|tight ?ends?|dst|d/st|defen[cs]es?|kickers?|flex)';

// Surnames that are also everyday English words (or team / chat words): never an alias on
// their own. Ambiguity between players is handled by uniqueness in the lexicon, and the
// league-mates' own names by `excludeWords` at runtime, so no person's name is listed here.
const COMMON_WORDS = new Set(['will', 'love', 'hill', 'white', 'brown', 'young', 'price', 'rice', 'hall', 'chase',
  'mark', 'cook', 'bell', 'best', 'long', 'green', 'gray', 'grey', 'king', 'hunt', 'banks', 'fields', 'swift', 'lamb',
  'baker', 'ford', 'moss', 'dart', 'tank', 'waddle', 'week', 'game', 'pick', 'trade', 'team', 'jets', 'bears',
  'saints', 'giants', 'chiefs', 'london']);

// Chat shorthand that is also some player's initials: never a player alias in lower case.
const CHAT_ACRONYMS = new Set(['lol', 'lmao', 'lmk', 'idk', 'imo', 'tbh', 'btw', 'omg', 'wtf', 'smh', 'ngl', 'fyi', 'irl',
  'jk', 'nvm', 'ofc', 'tho', 'bro', 'wyd', 'hmu', 'ily', 'dm', 'gg', 'ppr', 'dst', 'qb', 'rb', 'wr', 'te', 'ok', 'ya', 'yo',
  'fr', 'rn', 'tf', 'af', 'ik', 'ur', 'nfl', 'espn', 'mvp', 'ot', 'td', 'tds', 'ir', 'pup', 'dnp', 'nba', 'mlb', 'lfg',
  'bet', 'ass', 'jmo', 'hbu', 'wbu', 'atp', 'asap', 'etc', 'aka', 'yds', 'pts', 'gm', 'ceo', 'usa', 'dal', 'phi', 'nyg',
  'kc', 'sf', 'la', 'lv', 'tb', 'ne', 'no', 'gb', 'jax', 'ind', 'hou', 'ten', 'cin', 'cle', 'pit', 'bal', 'buf', 'mia',
  'nyj', 'det', 'chi', 'min', 'atl', 'car', 'ari', 'sea', 'lar', 'lac', 'den', 'was', 'wsh', 'pls', 'plz', 'thx', 'ppl',
  'hmm', 'brr', 'shh', 'nth', 'bff', 'tmrw', 'tmr', 'rly', 'pcs', 'pts', 'nfc', 'wrs', 'rbs', 'tes', 'qbs', 'dsts', 'flx',
  'and', 'all', 'add', 'art', 'ask', 'act', 'its', 'off', 'odd', 'ill', 'inn', 'egg', 'end', 'err', 'arm', 'ant', 'apt',
  'elf', 'ohh', 'uhh', 'umm', 'ugh', 'eff', 'est', 'ext', 'amp', 'ops', 'irs', 'afc', 'ahh', 'ugh']);
const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019]/g, "'");
const words = name => norm(name).replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i, '').split(/[\s-]+/).filter(Boolean);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Initialism of a name: "A.J. Brown" -> AJB, "Jaxon Smith-Njigba" -> JSN, "Christian McCaffrey" -> CMC. */
export function initialism(name) {
  const parts = norm(name).replace(/\b(jr|sr|ii|iii|iv)\.?$/i, '').split(/[\s-]+/).filter(Boolean);
  let out = '';
  for (const p of parts) {
    const dotted = p.split('.').filter(Boolean);
    if (dotted.length > 1) { out += dotted.map(d => d[0]).join(''); continue; }
    const caps = p.match(/^(Mc|Mac)([A-Z])/);
    out += caps ? `${p[0]}${caps[2]}` : p[0];
  }
  return out.toUpperCase();
}

/**
 * The league's player lexicon. `players`: [{espn_id, name, pos, roster_id|null}] (rostered
 * players, and any others the caller wants resolvable). `firstNameCounts` (optional): how
 * many fantasy-relevant players share each first name, so only rare first names alias.
 * `excludeWords`: words that never alias alone (the league-mates' own first names, read at
 * runtime from league_member_identity, so talking TO someone is not talking about a player).
 * Returns {aliases: [{re, ids}], owner: Map(espn_id -> roster_id), pos: Map(espn_id -> pos)}.
 */
export function buildLexicon(players, { firstNameCounts = null, excludeWords = [], pulse02 = pulse02On() } = {}) {
  const excluded = new Set([...excludeWords].map(w => String(w).toLowerCase()));
  const byAlias = new Map();
  const add = (alias, id, kind) => {
    const key = `${kind}:${alias}`;
    if (!byAlias.has(key)) byAlias.set(key, { alias, kind, ids: new Set() });
    byAlias.get(key).ids.add(id);
  };
  const owner = new Map(); const pos = new Map();
  const surnameCount = new Map(); const firstCount = new Map();
  for (const p of players) {
    const w = words(p.name);
    if (w.length < 2) continue;
    const last = w.at(-1).toLowerCase(); const first = w[0].toLowerCase().replace(/\./g, '');
    surnameCount.set(last, (surnameCount.get(last) ?? 0) + 1);
    firstCount.set(first, (firstCount.get(first) ?? 0) + 1);
  }
  for (const p of players) {
    const id = Number(p.espn_id);
    if (!Number.isFinite(id)) continue;
    if (p.roster_id != null) owner.set(id, Number(p.roster_id));
    if (p.pos) pos.set(id, String(p.pos).toUpperCase().replace('D/ST', 'DST'));
    const w = words(p.name);
    if (w.length < 2) continue;
    add(w.join(' ').toLowerCase(), id, 'word');
    if (pulse02) {
      // PULSE-02: the spellings chats use for the same full name: "aj brown" (no dots), "amonra"
      // (hyphenated first name run together), "st brown" (the last two words of a 3-word name).
      const dotless = norm(p.name).replace(/\./g, '').replace(/\b(jr|sr|ii|iii|iv|v)$/i, '').trim().toLowerCase();
      const dw = dotless.split(/[\s-]+/).filter(Boolean);
      if (dw.length >= 2) add(dw.join(' '), id, 'word');
      const firstRaw = norm(p.name).split(/\s+/)[0];
      if (firstRaw.includes('-')) add(firstRaw.replace(/[-.]/g, '').toLowerCase(), id, 'word');
      if (dw.length >= 3) add(dw.slice(-2).join(' '), id, 'word');
      // "DK", "CJ": an all-capitals first name is how that player is called; it aliases alone when unique.
      if (/^[A-Z]{2,3}$/.test(firstRaw.replace(/\./g, '')) && dw.length === 2) add(firstRaw.replace(/\./g, '').toLowerCase(), id, 'first');
    }
    const last = w.at(-1).toLowerCase(); const first = w[0].toLowerCase().replace(/\./g, '');
    if (last.length >= 4 && surnameCount.get(last) === 1 && !COMMON_WORDS.has(last) && !excluded.has(last)) add(last, id, 'word');
    const rareFirst = firstNameCounts ? (firstNameCounts.get(first) ?? 0) <= 1 : firstCount.get(first) === 1;
    if (first.length >= 4 && rareFirst && firstCount.get(first) === 1 && !COMMON_WORDS.has(first) && !excluded.has(first)) {
      add(first, id, 'word');
    }
    const ini = initialism(p.name);
    if (ini.length >= 3) {
      add(ini, id, 'caps');
      // PULSE-02: chats type "ajb", "cmc", "jsn" in lower case too. Only vowel-less ones (never an
      // English word) that are not chat shorthand.
      const lower = ini.toLowerCase();
      if (pulse02 && /^[aeiou]?[^aeiouy]+$/.test(lower) && !CHAT_ACRONYMS.has(lower)) add(lower, id, 'word');
    }
  }
  const aliases = [...byAlias.values()].filter(a => a.ids.size === 1)
    .filter(a => !(a.kind === 'first' && (excluded.has(a.alias) || CHAT_ACRONYMS.has(a.alias))))
    .sort((a, b) => b.alias.length - a.alias.length)
    .map(a => ({
      ids: [...a.ids],
      // word aliases match case-insensitively (possessive allowed); initialisms only in capitals
      re: a.kind === 'caps' ? new RegExp(`(^|[^A-Za-z])${esc(a.alias)}('?s)?(?![A-Za-z])`)
        : new RegExp(`(^|[^a-z])${esc(a.alias)}('?s)?(?![a-z])`, 'i'),
    }));
  return { aliases, owner, pos };
}

/** Player ids named in the thread's lines just before `msg` ({msg_id, chat_name}), in order. */
export function contextPlayers(chat, msg, lexicon) {
  const ids = [];
  for (const c of threadContext(chat, msg, msg.name)) for (const id of resolvePlayers(c.text, lexicon)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Player ids a message names, longest alias first (a full name is not also counted as its surname). */
export function resolvePlayers(text, lexicon) {
  let rest = norm(text);
  const out = [];
  for (const a of lexicon?.aliases ?? []) {
    if (a.re.test(rest)) {
      for (const id of a.ids) if (!out.includes(id)) out.push(id);
      rest = rest.replace(new RegExp(a.re.source, a.re.flags.includes('g') ? a.re.flags : `${a.re.flags}g`), '$1 ');
    }
  }
  return out;
}

const positionIn = t => POS_WORDS.find(([, re]) => re.test(t))?.[0] ?? null;

const RX = {
  wantPlayer: /\b(would|will|could|can) (you|u|ya) (trade|move|sell|deal|part with|give( up)?|do)\b|\bwhat (would|will|do) (it|you|u) (take|want)\b|\bwhat('?s| is) (it|the price)\b.*\bfor\b|\bhow much (for|would)\b|\bi('d| would)? ?(really )?(love|want|like|take)\b|\bi want\b|\binterested in\b|\bany interest in (moving|trading|selling)\b|\b(is|are) \S+( \S+)? (available|on the block|for sale)\b|\b(you|u) (shopping|selling|moving)\b|\bgive (you|u) .* for\b|\boffer(ing)? (for|you)\b|\btrade (me|for)\b|\bi('ll| will) (give|trade|offer)\b|\bwilling to (give|pay|trade)\b|\bin the market for\b|\bi('m| am) (after|eyeing|targeting)\b|\bhow about\b|\bwhat about\b/,
  shop: /\b(available|for sale|on the block|shopping|anyone want|anybody want|who wants|(i'?d|i would|i'?ll|i will|willing to|open to|looking to|trying to|want to|wanna) (move|trade|sell|dump|deal|part with|moving|trading)|taking offers|open to offers|make me an offer|send (me )?(an )?offers?|selling|he'?s yours|up for grabs)\b/,
  untouchable: /\b(untouchable|not (trading|moving|selling|dealing|giving up) (him|her|them|that|\w+)|not available|not for sale|off the table|not going anywhere|(never|wouldn'?t|won'?t|will not|would not|not gonna|not going to) (trade|move|sell|give up|part with)|keeping (him|them)|he'?s not (going|moving)|hands off)\b/,
  frustrated: /\b(killing me|killed me|done with|cutting|cut him|drop(ping|ped)? (him|this|that)|benching|bust|trash|garbage|sucks?|terrible|awful|useless|can'?t stand|frustrat\w*|worst|hate (him|this|that)|fraud|washed|dud|disappointing|disaster|so bad|stinks)\b/,
  hype: /\b(stud|beast|goat|elite|monster|going off|went off|league ?winner|smash(ed|ing)?|breakout|dominat\w*|cooking|cooked|special|legit|baller|dawg|superstar|top \d+|wr1|rb1|te1|qb1|best (player|wr|rb|te|qb)|value|steal|love (him|this|that guy)|studs?|filthy|nasty|insane|unreal)\b|\u{1F525}|\u{1F410}/u,
  urgency: /\b(need (a|to make a|to make|to) (move|trade|something|shake)|have to (trade|make a move|do something)|gotta (make a move|trade|do something)|season('?s| is) (over|done|cooked)|desperate|panic\w*|need help (at|with)|0-[2-9]|1-[4-9]|must win|win now)\b/,
  wantPos: new RegExp(`\\b(need|needs|needing|looking for|look for|want|in the market for|searching for|could use|shopping for|hunting for|after)\\s+(a |an |some |another |one more |more |\\d |two |2 )?(good |solid |real |starting |reliable |better |top |stud |elite )?${POS_ALT}\\b`),
  refusalLead: /^\s*(no+|nah+|nope|pass|hard pass|no chance|hell no|not a chance|no way|lol no|lmao no|haha no|i'?m good|im good|not interested|not right now|no thanks|no thank you|decline[d]?|absolutely not|not happening|never)\b/,
  refusalAny: /\b(no chance|hell no|not a chance|no way|hard pass|not interested|i'?m good on that|im good on that|not for that|that'?s a no|gonna pass|i'?ll pass|going to pass|declin(e|ed|ing)|rejected?|not doing that|not even close|lowball\w*|insulting)\b/,
  tradeWords: /\b(trade|offer|deal|for (him|her|them)|give|package|swap|counter|proposal|accept|take|move)\b/,
  accept: /^\s*(deal|accepted|accept(ing)?|done deal|send it|you got a deal|i accept|let'?s do (it|this|that)|i'?ll take (it|that|this)|lock it in|smash accept|sounds good,? send)\b|\b(i'?ll accept|accepting (it|that|now)|i accepted|just accepted|deal done|we have a deal|you have a deal|let'?s do it)\b/,
  reaction: /\b(fleece\w*|robbery|robbed|rip ?off|ripped off|highway robbery|veto\w*|collusion|great trade|good trade|fair trade|bad trade|terrible trade|won (that|the) trade|lost (that|the) trade|who won|why didn'?t you (offer|ask|hit) me|regret\w*|smart trade|love (that|the) trade|nice trade|solid trade|steal of a trade|what a trade)\b/,
};

function reactionOf(t) {
  if (/\b(fleece\w*|robbery|robbed|rip ?off|ripped off|highway robbery|veto\w*|collusion|bad trade|terrible trade)\b/.test(t)) return 'fleece';
  if (/\bwhy didn'?t you (offer|ask|hit) me\b/.test(t)) return 'envy';
  if (/\bregret\w*\b/.test(t)) return 'regret';
  return 'approve';
}
function refusalStyle(t) {
  if (/\b(lol|lmao|haha|hahaha|lmfao)\b/.test(t) || /\u{1F602}|\u{1F923}/u.test(t)) return 'laugh_no';
  if (/\b(how about|what about|would do|if you (add|throw|include)|counter|instead)\b/.test(t)) return 'counter';
  if (/\b(let me think|i'?ll (look|think)|think about it|maybe|later|not yet|we'?ll see)\b/.test(t)) return 'stall';
  if (/\b(i'?m good|im good|not right now|no thanks|no thank you|pass|not interested|appreciate)\b/.test(t)) return 'soft_no';
  return 'flat_no';
}

/**
 * The Jev classifier's reading of one message (jev_chat_signals, written by the league_chat
 * step before this runs), as the few probabilities the labeller uses; null when the message
 * has no Jev row (the classifier failed or has not reached it): the rules then run alone.
 */
export function jevFeatures(chat, msgId) {
  const rowsOut = chat.prepare('SELECT question, probability FROM jev_chat_signals WHERE msg_id = ?').all(msgId);
  if (!rowsOut.length) return null;
  const j = Object.fromEntries(rowsOut.map(r => [r.question, Number(r.probability) || 0]));
  return {
    open_to_trade: j.open_to_trade ?? 0, trade_talk: j['topic.trade_talk'] ?? 0,
    untouchable: j['own_roster.untouchable'] ?? 0, complaining: j['own_roster.complaining'] ?? 0,
    praising: j['own_roster.praising'] ?? 0,
    positive: (j['player_sentiment.positive'] ?? 0) + (j['player_sentiment.very_positive'] ?? 0),
    negative: (j['player_sentiment.negative'] ?? 0) + (j['player_sentiment.very_negative'] ?? 0),
  };
}

/**
 * Label one message. `ctx`: {speakerRoster, lexicon, owners (Map espn_id -> roster at the
 * message's time; defaults to lexicon.owner), jev (jevFeatures or null), pulse (the pulse's
 * own Jev answers, pulse-jev.js#pulseJevFeatures, or null), contextPlayers (ids named in the
 * thread's lines just before this one), cuts (PULSE_CUTS override, for tuning)}. Returns
 * statement objects [{type, players, pos, own, style, reaction, conf, source}] (most
 * messages: []). Pure: no I/O. WANT_PLAYER needs a named player the speaker does not own;
 * SHOP / UNTOUCHABLE one he does.
 *
 * With `pulse` (PULSE-02) WANT_PLAYER / SHOP / URGENCY / REFUSAL are decided by the Jev answer
 * and the rules together (PULSE_CUTS): a rule hit needs a Jev probability of at least `lo`,
 * and a Jev probability of at least `hi` stands on its own. A bare "me" / "yes" to a player
 * being shopped takes its player from the thread. `source` says which path labelled it
 * ('jev' or 'rules'), because the replan gate (LABEL_QUALITY) is measured per path.
 */
export function labelMessage(text, { speakerRoster = null, lexicon = null, owners = null, jev = null, pulse = null,
  contextPlayers = [], cuts = PULSE_CUTS } = {}) {
  const raw = norm(text);
  if (!raw.trim()) return [];
  const t = raw.toLowerCase();
  const ownerOf = owners ?? lexicon?.owner ?? new Map();
  const players = resolvePlayers(raw, lexicon);
  const mine = id => speakerRoster != null && ownerOf.get(id) === Number(speakerRoster);
  const owned = players.filter(mine);
  const others = players.filter(id => !owned.includes(id));
  const ctxOthers = players.length ? [] : contextPlayers.filter(id => !mine(id));
  const ctxOwned = players.length ? [] : contextPlayers.filter(mine);
  const pos = positionIn(t);
  const J = jev;
  const Q = pulse;
  const source = Q ? 'jev' : 'rules';
  const out = [];
  const push = (type, extra) => out.push({ type, players: [], pos: null, own: null, style: null, reaction: null, conf: 0.6, source, ...extra });
  const refusing = RX.refusalLead.test(t);
  const openToTrade = !!J && J.open_to_trade > 0.6;
  // rule AND jev >= lo, or jev >= hi alone
  const joint = (ruleHit, p, cut) => (ruleHit && p >= cut.lo) || p >= cut.hi;

  const wantRule = others.length > 0 && !refusing && (RX.wantPlayer.test(t) || openToTrade);
  if (Q) {
    const cand = others.length ? others : ctxOthers;
    if (cand.length && joint(wantRule, Q.want_player ?? 0, cuts.WANT_PLAYER)) {
      push('WANT_PLAYER', { players: cand, own: 0, conf: +(Q.want_player ?? 0).toFixed(2) });
    }
  } else if (wantRule) {
    push('WANT_PLAYER', { players: others, own: 0, conf: RX.wantPlayer.test(t) && openToTrade ? 0.8 : 0.6 });
  }
  const untouchable = owned.length && (RX.untouchable.test(t) || (!!J && J.untouchable > 0.3 && !RX.shop.test(t)));
  const shopRule = owned.length > 0 && !refusing && (RX.shop.test(t) || openToTrade);
  if (untouchable) push('UNTOUCHABLE', { players: owned, own: 1 });
  else if (Q) {
    const cand = owned.length ? owned : ctxOwned;
    if (cand.length && joint(shopRule, Q.shop ?? 0, cuts.SHOP)) push('SHOP', { players: cand, own: 1, conf: +(Q.shop ?? 0).toFixed(2) });
  } else if (shopRule) push('SHOP', { players: owned, own: 1 });
  const ownFlag = owned.length ? 1 : 0;
  if (players.length && (RX.frustrated.test(t) || (!!J && J.complaining > 0.5 && J.negative > 0.3))) {
    push('FRUSTRATED', { players: owned.length ? owned : players, own: ownFlag, conf: 0.55 });
  } else if (players.length && (RX.hype.test(t) || (!!J && (J.praising > 0.3 || J.positive > 0.4)))) {
    push('HYPE', { players: owned.length ? owned : players, own: ownFlag, conf: 0.55 });
  }
  const urgencyRule = RX.urgency.test(t);
  if (Q ? joint(urgencyRule, Q.urgency ?? 0, cuts.URGENCY) : urgencyRule) push('URGENCY', { pos, conf: 0.55 });
  const wantPos = t.match(RX.wantPos);
  if (wantPos) push('WANT_POS', { pos: positionIn(wantPos[0]) });
  const tradeContext = RX.tradeWords.test(t) || (!!J && (J.trade_talk > 0.5 || J.open_to_trade > 0.5));
  const refusalRule = (refusing && (t.length <= 60 || RX.tradeWords.test(t)) && (!J || tradeContext)) || RX.refusalAny.test(t);
  if (Q ? joint(refusalRule, Q.refusal ?? 0, cuts.REFUSAL) : refusalRule) {
    push('REFUSAL', { style: refusalStyle(t), players: owned, conf: 0.5 });
  } else if (RX.accept.test(t) && (!J || tradeContext)) {
    push('ACCEPT_TALK', { players, conf: 0.55 });
  }
  if (RX.reaction.test(t)) push('TRADE_REACTION', { reaction: reactionOf(t), conf: 0.55 });
  return out;
}

/**
 * The weight a statement carries: its follow-through lift. `credibility(rosterId, type)` is
 * CRED-01's per-manager reading ({lift, n, basis} | null). Falls back to the pooled prior;
 * otherwise weight null (unknown). credible = weight >= CREDIBLE_LIFT.
 */
export function statementWeight(type, rosterId, credibility = null) {
  const own = credibility ? credibility(rosterId, type) : null;
  if (own && Number.isFinite(own.lift)) {
    return { weight: own.lift, basis: `cred-01: ${own.basis ?? `roster follow-through n=${own.n ?? '?'}`}`,
      credible: own.lift >= CREDIBLE_LIFT };
  }
  const prior = POOLED_PRIOR[type];
  if (prior) return { weight: prior.lift, basis: prior.basis, credible: prior.lift >= CREDIBLE_LIFT };
  return { weight: null, basis: 'unknown: no proven follow-through for this type (CRED-01 absent)', credible: false };
}

/* ----------------------------------------------------------------- the tick */

/** The league's rostered players with their owners, from its latest roster snapshot. */
export function leaguePlayers(leagueId, database = appDb) {
  const latest = database.prepare(`SELECT MAX(season) AS s FROM league_roster_snapshots WHERE league_id = ?`).get(leagueId)?.s;
  if (latest == null) return [];
  const period = database.prepare(`SELECT MAX(scoring_period_id) AS p FROM league_roster_snapshots
      WHERE league_id = ? AND season = ?`).get(leagueId, latest)?.p;
  return database.prepare(`SELECT espn_player_id AS espn_id, MAX(player_name) AS name, MAX(position) AS pos,
        MAX(CASE WHEN on_roster = 1 THEN team_id END) AS roster_id
      FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND scoring_period_id = ?
      GROUP BY espn_player_id`).all(leagueId, latest, period);
}

/**
 * A chat timestamp as a Date. The chat DB's ts_utc is true UTC written without a zone
 * ('2026-09-15T16:39:43'), which `new Date` would read as the machine's local time: on
 * Nick's Mac that put every message 4 hours late, after trades that had not happened yet
 * (PULSE-02). Strings with a zone and Date/number inputs pass through.
 */
export function chatTime(ts) {
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(ts.trim())) {
    return new Date(`${ts.trim().replace(' ', 'T')}Z`);
  }
  return new Date(ts);
}

/**
 * Who owned each player at a given time, from the league's own log: the latest roster
 * snapshot for times after it was captured (plus transactions since), otherwise a replay of
 * league_transactions_raw (draft, executed adds / drops / trades) up to that time. The
 * ESPN feed misses some trades (PEOPLE-LAB: 17 players), so a player the replay never saw
 * falls back to the snapshot owner. Returns {at(ts) -> Map(espn_id -> roster_id)}.
 */
export function ownershipTimeline(leagueId, database = appDb, { pulse02 = pulse02On() } = {}) {
  const snap = leaguePlayers(leagueId, database);
  const snapOwner = new Map(snap.filter(p => p.roster_id != null).map(p => [Number(p.espn_id), Number(p.roster_id)]));
  const season = database.prepare('SELECT MAX(season) AS s FROM league_roster_snapshots WHERE league_id = ?').get(leagueId)?.s;
  const snapAt = season == null ? null : database.prepare(`SELECT MAX(changed_at) AS t FROM league_roster_snapshots
      WHERE league_id = ? AND season = ?`).get(leagueId, season)?.t ?? null;
  const moves = [];
  // The collector creates league_transactions_raw on its first run; before that there is
  // nothing to replay and the snapshot is the only owner.
  const hasTx = !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'league_transactions_raw'`).get();
  const txRows = season == null || !hasTx ? [] : database.prepare(`SELECT type, status, COALESCE(processed_at, proposed_at) AS t, items_json
      FROM league_transactions_raw WHERE league_id = ? AND season = ?
        AND ((type = 'DRAFT') OR (type IN ('FREEAGENT', 'WAIVER', 'TRADE_ACCEPT') AND status = 'EXECUTED'))`).all(leagueId, season);
  for (const r of txRows) {
    if (!r.t) continue;
    let items;
    try { items = JSON.parse(r.items_json || '[]'); } catch { continue; }
    for (const it of items) {
      if (['DRAFT', 'ADD', 'TRADE'].includes(it.type) && it.toTeamId > 0) moves.push([r.t, Number(it.playerId), Number(it.toTeamId)]);
      else if (it.type === 'DROP') moves.push([r.t, Number(it.playerId), null]);
    }
  }
  // PULSE-02: trades the feed logged only as a proposal (the accept row never arrived, or it
  // is still marked pending/canceled) but that did happen: a weekly roster snapshot shows the
  // player on the receiving team and no executed move ever took him there. The move is dated
  // at the latest such proposal (its processing time when it has one).
  const executedTo = new Set(moves.map(([, pid, to]) => `${pid}:${to}`));
  const seenOn = new Set(!pulse02 || season == null ? [] : database.prepare(`SELECT DISTINCT espn_player_id AS p, team_id AS t
      FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND on_roster = 1`).all(leagueId, season)
    .map(r => `${r.p}:${r.t}`));
  const inferred = new Map();
  const proposals = !pulse02 || season == null || !hasTx ? [] : database.prepare(`SELECT COALESCE(processed_at, proposed_at) AS t, items_json
      FROM league_transactions_raw WHERE league_id = ? AND season = ? AND type IN ('TRADE_PROPOSAL', 'TRADE_ACCEPT')
        AND status <> 'EXECUTED'`).all(leagueId, season);
  for (const r of proposals) {
    if (!r.t) continue;
    let items;
    try { items = JSON.parse(r.items_json || '[]'); } catch { continue; }
    for (const it of items) {
      if (it.type !== 'TRADE' || !(it.toTeamId > 0)) continue;
      const key = `${Number(it.playerId)}:${Number(it.toTeamId)}`;
      if (!seenOn.has(key) || executedTo.has(key)) continue;
      if (!inferred.has(key) || inferred.get(key)[0] < r.t) inferred.set(key, [r.t, Number(it.playerId), Number(it.toTeamId)]);
    }
  }
  moves.push(...inferred.values());
  moves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const replayed = new Set(moves.map(mv => mv[1]));
  return {
    at(ts) {
      const iso = (pulse02 ? chatTime(ts) : new Date(ts)).toISOString();
      const fromSnap = snapAt != null && iso >= snapAt;
      const m = fromSnap ? new Map(snapOwner) : new Map();
      for (const [t, pid, to] of moves) {
        if (t > iso) break;
        if (fromSnap && t <= snapAt) continue;
        if (to == null) m.delete(pid); else m.set(pid, to);
      }
      if (!fromSnap) for (const [pid, r] of snapOwner) if (!replayed.has(pid)) m.set(pid, r);
      return m;
    },
  };
}

/** First-name frequency among fantasy-relevant players (a first name used by one player is an alias). */
export function firstNameCounts(database = appDb) {
  const out = new Map();
  for (const r of database.prepare('SELECT name FROM players WHERE fantasy_relevant = 1').all()) {
    const w = words(r.name);
    if (w.length < 2) continue;
    const f = w[0].toLowerCase().replace(/\./g, '');
    out.set(f, (out.get(f) ?? 0) + 1);
  }
  return out;
}

/** chat name -> roster id for the league's trusted identities (never Nick's own messages). */
export function speakerMap(leagueId, database = appDb) {
  const cols = database.prepare('PRAGMA table_info(league_member_identity)').all().map(c => c.name);
  if (!cols.length) return new Map();
  return new Map(database.prepare(`SELECT chat_name, roster_id FROM league_member_identity
      WHERE league_id = ? AND chat_name IS NOT NULL AND confidence IN (${TRUSTED_CONFIDENCE.map(() => '?').join(',')})`)
    .all(leagueId, ...TRUSTED_CONFIDENCE)
    .map(r => [r.chat_name, Number(r.roster_id)]));
}

/** Every word of the league-mates' chat and ESPN names: never a player alias on its own. */
export function memberWords(leagueId, database = appDb) {
  const out = new Set();
  for (const r of database.prepare(`SELECT chat_name, espn_name FROM league_member_identity WHERE league_id = ?`).all(leagueId)) {
    for (const n of [r.chat_name, r.espn_name]) for (const w of words(n ?? '')) out.add(w.toLowerCase());
  }
  return out;
}

export function lastCursor(leagueId, database = appDb) {
  return database.prepare(`SELECT MAX(to_msg_id) AS m FROM people_pulse_runs WHERE league_id = ?`).get(leagueId)?.m ?? null;
}

/**
 * One pulse pass for one league. Reads chat rows with msg_id past the league's cursor (or,
 * on the first pass, from `backfillSince`, marked backfill: they never trigger a replan),
 * labels them and appends people_pulse rows plus one people_pulse_runs row.
 * Returns {read, statements, credible, liveCredible: [row], gated: [row], with_jev, run_id, from, to, backfill}.
 * With GRIDIRON_PULSE_02=1 (`pulse02`), a credible live statement whose type fails replanGate
 * is stored and counted in `gated`, never in liveCredible: it cannot ask for a replan. Off,
 * `gated` is empty and every row is labelled as PULSE-01 (labeller_version pulse-1).
 * nickByRoster (FIX-316-3): Map roster -> Nick's block (profile-reader.js#nickBlocksFrom). A
 * statement from a manager Nick marked unreachable or not trading is stored, never credible,
 * and never asks for a replan (Nick's read beats every chat signal, PEOPLE-FLOW).
 */
export function nickMuted(block) {
  if (block?.unreachable) return "Nick's read: unreachable (stored, never credible, never replans)";
  if (block?.deprioritised) return "Nick's read: not trading (stored, never credible, never replans)";
  return null;
}

export function pulseTick({ database = appDb, chat, leagueId, now = new Date(), credibility = null,
  backfillSince = null, maxMessages = 5000, nickByRoster = null, env = process.env, pulse02 = pulse02On(env) } = {}) {
  if (!chat) throw new Error('pulseTick: chat DB is required');
  const speakers = speakerMap(leagueId, database);
  const cursor = lastCursor(leagueId, database);
  const backfill = cursor == null;
  const since = backfillSince ?? new Date(Date.parse(new Date(now).toISOString()) - TICKER_HOURS * 3600e3).toISOString();
  const names = [...speakers.keys()];
  const msgs = names.length ? chat.prepare(`SELECT msg_id, chat_kind, chat_name, name, ts_utc, text FROM messages
      WHERE is_from_me = 0 AND COALESCE(is_tapback, 0) = 0 AND text IS NOT NULL
        AND name IN (${names.map(() => '?').join(',')})
        AND ${backfill ? 'ts_utc >= ?' : 'msg_id > ?'}
      ORDER BY msg_id LIMIT ?`).all(...names, backfill ? since : cursor, maxMessages) : [];
  const lexicon = buildLexicon(leaguePlayers(leagueId, database),
    { firstNameCounts: firstNameCounts(database), excludeWords: memberWords(leagueId, database), pulse02 });
  const ownership = ownershipTimeline(leagueId, database, { pulse02 });
  const version = pulse02 ? PULSE_02_VERSION : PULSE_VERSION;
  const insert = database.prepare(`INSERT OR IGNORE INTO people_pulse (league_id, roster_id, msg_id, chat_kind, as_of,
      statement_type, stmt_key, player_ids_json, pos, own, style, conf, weight, weight_basis, credible, live,
      labeller_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let statements = 0; let credible = 0;
  const liveCredible = []; const gated = [];
  let withJev = 0;
  database.exec('BEGIN');
  try {
    for (const m of msgs) {
      const roster = speakers.get(m.name);
      const pulse = pulse02 ? pulseJevFeatures(chat, m.msg_id) : null;
      if (pulse) withJev += 1;
      const labels = labelMessage(m.text, { speakerRoster: roster, lexicon, owners: ownership.at(m.ts_utc),
        jev: jevFeatures(chat, m.msg_id), pulse, contextPlayers: pulse02 ? contextPlayers(chat, m, lexicon) : [] });
      for (const s of labels) {
        const raw = statementWeight(s.type, roster, credibility);
        const muted = nickMuted(nickByRoster?.get(String(roster)));
        const w = muted ? { weight: raw.weight, basis: muted, credible: false } : raw;
        const playersJson = JSON.stringify([...s.players].sort((a, b) => a - b));
        const r = insert.run(leagueId, roster, m.msg_id, m.chat_kind ?? null, (pulse02 ? chatTime(m.ts_utc) : new Date(m.ts_utc)).toISOString(), s.type,
          `${s.type}|${playersJson}|${s.pos ?? ''}`, playersJson, s.pos, s.own, s.style ?? s.reaction, s.conf,
          w.weight, w.basis, w.credible ? 1 : 0, backfill ? 0 : 1, version);
        if (!r.changes) continue;
        statements += 1;
        if (w.credible) {
          credible += 1;
          if (!backfill) {
            const row = { id: Number(r.lastInsertRowid), roster_id: roster, type: s.type, weight: w.weight, source: s.source };
            const gate = pulse02 ? replanGate(s.type, s.source) : { ok: true };
            if (gate.ok) liveCredible.push(row); else gated.push({ ...row, reason: gate.reason });
          }
        }
      }
    }
    const to = msgs.length ? msgs.at(-1).msg_id : (cursor ?? chat.prepare('SELECT MAX(msg_id) AS m FROM messages').get()?.m ?? 0);
    const run = database.prepare(`INSERT INTO people_pulse_runs (league_id, ran_at, from_msg_id, to_msg_id, messages_read,
        statements, credible, backfill, labeller_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(leagueId, new Date(now).toISOString(), msgs[0]?.msg_id ?? null, to, msgs.length, statements, credible,
        backfill ? 1 : 0, version);
    database.exec('COMMIT');
    return { read: msgs.length, statements, credible, liveCredible, gated, with_jev: withJev, run_id: Number(run.lastInsertRowid),
      from: msgs[0]?.msg_id ?? null, to, backfill, speakers: speakers.size };
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

/** Record what the replan request came to on a pulse run. */
export function recordReplan(runId, status, detail, database = appDb) {
  database.prepare('UPDATE people_pulse_runs SET replan_status = ?, replan_detail = ? WHERE id = ?')
    .run(status, detail == null ? null : String(detail).slice(0, 300), runId);
}

/* --------------------------------------------------------------- the ticker */

const agoText = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/** A label phrase for the ticker. Labels only, never a quote: "in-market for WR", "shopping a RB". */
export function tickerPhrase(item, playerName = () => null) {
  const names = (item.player_ids ?? []).map(id => playerName(id)).filter(Boolean);
  const who = names.length ? names.slice(0, 2).join(', ') : null;
  const posText = item.pos ?? (item.player_pos?.[0] ?? null);
  switch (item.type) {
    case 'WANT_PLAYER': return `in-market for ${who ?? posText ?? 'a player'}`;
    case 'WANT_POS': return `looking for ${posText ?? 'a starter'}`;
    case 'SHOP': return `shopping ${who ?? posText ?? 'a player'}`;
    case 'UNTOUCHABLE': return `calls ${who ?? 'a player'} untouchable`;
    case 'HYPE': return `talking up ${who ?? 'a player'}`;
    case 'FRUSTRATED': return `down on ${who ?? 'a player'}`;
    case 'URGENCY': return `needs a move${posText ? ` at ${posText}` : ''}`;
    case 'REFUSAL': return 'turned a deal down';
    case 'ACCEPT_TALK': return 'ready to deal';
    case 'TRADE_REACTION': return 'reacting to a trade';
    default: return item.type.toLowerCase();
  }
}

/**
 * The ticker: the league's labelled statements from the last `hours`, newest first.
 * Returns {status, items: [{id, roster_id, team_name, type, phrase, player_ids, pos,
 * credible, weight, ago, as_of}]}. 'table_absent' when migration 098 has not run.
 */
export function recentPulse(leagueId, { database = appDb, now = new Date(), hours = TICKER_HOURS, limit = 20 } = {}) {
  const has = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'people_pulse'`).get();
  if (!has) return { status: 'table_absent', items: [] };
  const nowMs = Date.parse(new Date(now).toISOString());
  const from = new Date(nowMs - hours * 3600e3).toISOString();
  const rowsOut = database.prepare(`SELECT id, roster_id, statement_type AS type, player_ids_json, pos, credible, weight,
      as_of FROM people_pulse WHERE league_id = ? AND as_of >= ? AND as_of <= ?
      ORDER BY as_of DESC, id DESC LIMIT ?`).all(leagueId, from, new Date(nowMs).toISOString(), limit);
  const teams = new Map(database.prepare(`SELECT roster_id, team_name FROM league_member_identity WHERE league_id = ?`)
    .all(leagueId).map(r => [Number(r.roster_id), r.team_name]));
  const nameOf = database.prepare('SELECT name, position FROM players WHERE espn_id = ?');
  const cache = new Map();
  const player = id => {
    if (!cache.has(id)) cache.set(id, nameOf.get(id) ?? null);
    return cache.get(id);
  };
  const lastRun = database.prepare(`SELECT ran_at, replan_status FROM people_pulse_runs WHERE league_id = ?
      ORDER BY id DESC LIMIT 1`).get(leagueId) ?? null;
  const items = rowsOut.map(r => {
    const ids = JSON.parse(r.player_ids_json || '[]');
    const item = { id: r.id, roster_id: r.roster_id, team_name: teams.get(Number(r.roster_id)) ?? null, type: r.type,
      player_ids: ids, pos: r.pos, player_pos: ids.map(id => player(id)?.position).filter(Boolean),
      credible: !!r.credible, weight: r.weight, as_of: r.as_of, ago: agoText(nowMs - Date.parse(r.as_of)) };
    return { ...item, phrase: tickerPhrase(item, id => player(id)?.name ?? null) };
  });
  return { status: 'ok', items, last_run: lastRun };
}
