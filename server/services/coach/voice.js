/**
 * VOICE-01: Coach writes the texts Nick sends the way Nick texts (BUILD-PLAN v2 Stage 3).
 *
 * Three parts, all local:
 *   1. buildVoiceProfiles(rows, threads)  Nick's own texts (is_from_me = 1) -> style profiles:
 *      casing, apostrophes, end punctuation, length, bursts, emoji, abbreviation swaps
 *      (you -> u, right now -> rn, ...), vocabulary and hype rates, openers. One profile per
 *      scope: 'all', 'phone' (what league-mates see), 'register:<r>' and 'thread:<chat>'.
 *      Counts and shares only; no message text goes into a profile.
 *   2. styleText(draft, profile, { keep })  the deterministic styler, no model: sentence ->
 *      burst split, the profile's swaps, casing, apostrophes, punctuation and emoji rules.
 *      Protected tokens (player names, positions, "Team N", numbers) pass through untouched,
 *      so the COACH-MSG grounding checker still sees every claim.
 *   3. rewrite(draft, { recipient, voice, callModel })  retrieves Nick's most similar texts
 *      (TF-IDF, same thread first) as few-shot examples plus a style guide built from the
 *      profile, asks the model, and gates the answer with `check`; any failure (or no
 *      model, or no paid-run opt-in) returns the styler's text.
 *
 * Storage: the profiles live in the private chat DB (table nick_voice_profile, written by
 * scripts/build-nick-voice.mjs), never in the repo. The texts used as few-shot examples are
 * read from that DB at load time and only ever leave the Mac inside a model call the paid-run
 * opt-in approved.
 *
 * Switch: GRIDIRON_NICK_VOICE=1 (default off). COACH-MSG (campaign/messages.js) styles its
 * outgoing texts with it when on.
 *
 * Hand-set (not fitted): the swap / vocabulary / hype word lists, the 0.5 share thresholds
 * that turn a rule on, MAX_BURSTS (3, NICK seed: 1-3 bursts per offer), BURST_GAP_S (120),
 * MIN_THREAD (40 texts before a thread gets its own profile), the retrieval boosts.
 */
import { createHash } from 'node:crypto';

export const NICK_VOICE_ENV = 'GRIDIRON_NICK_VOICE';
export const PROFILE_TABLE = 'nick_voice_profile';
export const MAX_BURSTS = 3;
export const BURST_GAP_S = 120;
export const MIN_THREAD = 40;
export const VOICE_SOURCE = 'voice.rules';

/** On with its own flag only (it rewrites what league-mates read). */
export const nickVoiceOn = (env = process.env) => env[NICK_VOICE_ENV] === '1';
const paidAllowed = env => nickVoiceOn(env)
  && typeof env.GRIDIRON_ALLOW_PAID_RUN === 'string' && env.GRIDIRON_ALLOW_PAID_RUN.trim() !== '';

/* ------------------------------------------------------------------ registers */

/** League registers are what league-mates see: phone texts, autocorrect on. */
export const PHONE_REGISTERS = Object.freeze(['league_group', 'league_dm']);

/**
 * Which register a chat-DB row belongs to. `messages` holds the league group chat and the DMs
 * with league-mates; `messages_ext` holds everything else, tagged by source_chat_kind.
 */
export function registerOf(table, kind) {
  if (table === 'messages') return kind === 'group' ? 'league_group' : 'league_dm';
  if (kind === 'fantasy_group') return 'league_group';
  return kind === 'group_other' ? 'other_group' : 'other_dm';
}

/* ------------------------------------------------------------------ word lists */

/** [long form, Nick's short form]. A swap is applied when the profile's short share is >= 0.5. */
export const SWAPS = Object.freeze([
  ['you', 'u'], ['your', 'ur'], ["you're", 'ur'], ['right now', 'rn'], ['please', 'pls'], ['tonight', 'tn'],
  ['yeah', 'yea'], ['going to', 'gonna'], ['want to', 'wanna'], ['okay', 'ok'], ['though', 'tho'],
  ['brother', 'bro'], ["i don't know", 'idk'], ['to be honest', 'tbh'], ['not gonna lie', 'ngl'],
  ['let me know', 'lmk'], ['because', 'bc'], ['i am going to', 'imma'],
]);
export const VOCAB = Object.freeze(['u', 'ur', 'rn', 'pls', 'bruh', 'tn', 'lol', 'bro', 'ok', 'bet', 'yea', 'gonna',
  'wanna', 'yo', 'nah', 'imma', 'idk', 'dude', 'ngl', 'fr', 'lmk', 'tho', 'hey', 'thanks', 'appreciate',
  'sounds good', 'no worries', 'deal', 'would', 'thoughts']);
export const HYPE = Object.freeze(['insane', 'lock', 'lock in', 'locked', 'crazy', 'huge', 'massive', 'lets go',
  "let's go", 'fire', 'nasty', 'cooked', 'elite', 'sick', 'goat', 'W', 'L']);
const CONTRACTIONS = /\b(i'm|don't|can't|it's|that's|won't|didn't|isn't|he's|you're|i'll|doesn't|wasn't|i've|let's|what's|there's|i'd|he'll|we're|they're|aren't|couldn't|wouldn't|shouldn't)\b/gi;
const BARE = /\b(im|dont|cant|thats|wont|didnt|isnt|youre|doesnt|wasnt|ive|whats|theres|arent|couldnt|wouldnt|shouldnt)\b/g;
const QUESTION_START = /^(would|do|does|did|u|you|what|how|why|when|where|who|are|is|can|could|wanna|want|any|thoughts|should|will|r)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

const norm = s => String(s ?? '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (p, flags = 'gi') => new RegExp(`(?<![A-Za-z0-9'])${esc(p).replace(/'/g, "'?")}(?![A-Za-z0-9'])`, flags);
const countOf = (text, p) => (text.match(phraseRe(p, 'g')) ?? []).length;
const quant = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
const r3 = x => Math.round(x * 1000) / 1000;
const share = (n, d) => (d ? r3(n / d) : null);

/* ------------------------------------------------------------------ 1. profile */

/**
 * One style profile from Nick's texts. texts: [string]; bursts: [int] run lengths (see burstRuns).
 * Returns shares in 0..1, rates per 1k words, and counts. Never any message text.
 */
export function profileOf(texts, bursts = []) {
  const rawApos = texts.map(x => String(x ?? '')).join(' ');
  const curly = (rawApos.match(/[’‘]/g) ?? []).length, straight = (rawApos.match(/'/g) ?? []).length;
  const t = texts.map(norm).map(s => s.trim()).filter(Boolean);
  const n = t.length;
  const wc = t.map(s => s.split(/\s+/).length);
  const words = wc.reduce((a, b) => a + b, 0);
  const lower = t.map(s => s.toLowerCase());
  const joined = ` ${lower.join(' \n ')} `;
  const per1k = c => (words ? r3((c * 1000) / words) : 0);
  const qs = t.filter(s => QUESTION_START.test(s));
  const iWords = t.join(' ').match(/(?<![A-Za-z'])[iI](?=$|[\s'.,!?])/g) ?? [];
  const opener = new Map();
  for (const s of lower) { const w = s.match(/^[a-z']+/)?.[0]; if (w) opener.set(w, (opener.get(w) ?? 0) + 1); }
  const withApos = (joined.match(CONTRACTIONS) ?? []).length;
  const bare = (joined.match(BARE) ?? []).length;
  return {
    n, words_total: words,
    words: { median: quant(wc, 0.5), p90: quant(wc, 0.9), mean: n ? r3(words / n) : 0 },
    chars: { median: quant(t.map(s => s.length), 0.5), p90: quant(t.map(s => s.length), 0.9) },
    first_cap: share(t.filter(s => /^[A-Z]/.test(s)).length, n),
    first_lower: share(t.filter(s => /^[a-z]/.test(s)).length, n),
    // Rest of the text lowercase (after the first character).
    rest_lower: share(t.filter(s => !/[A-Z]/.test(s.slice(1).replace(/\bI\b/g, ''))).length, n),
    all_lower: share(t.filter(s => !/[A-Z]/.test(s)).length, n),
    end_punct: share(t.filter(s => /[.!?]$/.test(s)).length, n),
    end_period: share(t.filter(s => /\.$/.test(s)).length, n),
    end_excl: share(t.filter(s => /!$/.test(s)).length, n),
    end_q: share(t.filter(s => /\?$/.test(s)).length, n),
    q_mark_on_questions: share(qs.filter(s => /\?/.test(s)).length, qs.length),
    exclaim: share(t.filter(s => s.includes('!')).length, n),
    comma: share(t.filter(s => s.includes(',')).length, n),
    emoji: share(t.filter(s => EMOJI.test(s)).length, n),
    apostrophe: share(withApos, withApos + bare),
    // The phone's smart punctuation types ’; a straight ' marks a desktop or a generated text.
    curly_apos: share(curly, curly + straight),
    inner_cap: share(t.filter(s => /[A-Z]/.test(s.slice(1))).length, n),
    i_cap: share(iWords.filter(w => w === 'I').length, iWords.length),
    swaps: Object.fromEntries(SWAPS.map(([long, short]) => {
      const s = countOf(joined, short), l = countOf(joined, long);
      return [long, { to: short, short: s, long: l, share: share(s, s + l) }];
    })),
    rates: Object.fromEntries(VOCAB.map(w => [w, per1k(countOf(joined, w))])),
    hype: Object.fromEntries(HYPE.map(w => [w, per1k(w.length === 1 ? (t.join(' ').match(new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`, 'g')) ?? []).length : countOf(joined, w))])),
    openers: [...opener].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w, c]) => [w, share(c, n)]),
    bursts: {
      runs: bursts.length,
      mean_len: bursts.length ? r3(bursts.reduce((a, b) => a + b, 0) / bursts.length) : null,
      multi_share: share(bursts.filter(b => b > 1).length, bursts.length),
      gap_s: BURST_GAP_S,
    },
  };
}

/**
 * Burst run lengths for one thread: consecutive texts from Nick with no one else in between
 * and at most BURST_GAP_S seconds apart. rows: [{ is_from_me, ts }] in time order.
 */
export function burstRuns(rows) {
  const out = [];
  let run = 0, last = null;
  for (const r of rows) {
    const ts = Date.parse(r.ts);
    if (!r.is_from_me) { if (run) out.push(run); run = 0; last = null; continue; }
    if (run && last != null && Number.isFinite(ts) && ts - last <= BURST_GAP_S * 1000) run++;
    else { if (run) out.push(run); run = 1; }
    last = ts;
  }
  if (run) out.push(run);
  return out;
}

/**
 * All scopes. mine: [{ text, register, thread }] (Nick's texts, tapbacks removed);
 * burstsBy: Map(thread -> [run lengths]).
 * Returns [{ scope, kind, n, profile }].
 */
export function buildVoiceProfiles(mine, { burstsBy = new Map() } = {}) {
  const runsFor = threads => threads.flatMap(th => burstsBy.get(th) ?? []);
  const threadsOf = rs => [...new Set(rs.map(r => r.thread))];
  const make = (scope, kind, rs) => ({ scope, kind, n: rs.length, profile: profileOf(rs.map(r => r.text), runsFor(threadsOf(rs))) });
  const out = [make('all', 'all', mine), make('phone', 'phone', mine.filter(r => PHONE_REGISTERS.includes(r.register)))];
  for (const reg of ['league_group', 'league_dm', 'other_group', 'other_dm']) {
    const rs = mine.filter(r => r.register === reg);
    if (rs.length) out.push(make(`register:${reg}`, 'register', rs));
  }
  const byThread = new Map();
  for (const r of mine) if (r.register === 'league_dm') (byThread.get(r.thread) ?? byThread.set(r.thread, []).get(r.thread)).push(r);
  for (const [th, rs] of byThread) if (rs.length >= MIN_THREAD) out.push(make(`thread:${th}`, 'thread', rs));
  return out;
}

/** A stable hash of the corpus a profile set was built from. */
export function corpusHash(mine) {
  const h = createHash('sha256');
  for (const r of mine) h.update(`${r.thread}\u0000${r.text}\u0001`);
  return h.digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ 2. the styler */

const POS = /\b(D\/ST|DST|QB|RB|WR|TE|FLEX|K)\b/g;
const TEAM = /\bTeam \d+\b/g;
const NUM = /[+-]?\d+(?:\.\d+)?%?/g;

/** Replace protected spans with inert placeholders; returns [masked, restore]. */
function protect(text, keep) {
  const saved = [];
  // Placeholders carry no digits or letters (private-use code points), so later passes never touch them.
  const hold = m => `⟦${String.fromCharCode(0xe000 + saved.push(m) - 1)}⟧`;
  let s = text;
  for (const k of [...new Set(keep.filter(x => x && x.length >= 2))].sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(?<![A-Za-z0-9])${esc(k)}(?![A-Za-z0-9])`, 'g'), hold);
  }
  s = s.replace(TEAM, hold).replace(POS, hold).replace(NUM, hold);
  return [s, x => x.replace(/⟦([\ue000-\uf8ff])⟧/g, (_, c) => saved[c.charCodeAt(0) - 0xe000])];
}

/**
 * [full name, surname] for the given names whose surname no other player in the league map
 * carries (as a surname or a first name), so the short form names one player only.
 * allNames: every player name in the league map; list: the full names to shorten.
 */
export function surnamePairs(allNames, list) {
  const words = new Map();
  for (const n of allNames) {
    const parts = String(n).split(/\s+/).filter(Boolean);
    const sur = lastName(n);
    for (const w of new Set([parts[0], sur])) if (w) words.set(w, (words.get(w) ?? 0) + 1);
  }
  return [...new Set(list)].map(n => [n, lastName(n)]).filter(([n, sur]) => sur.length >= 3 && sur !== n && words.get(sur) === 1);
}
const lastName = n => {
  const w = String(n).split(/\s+/).filter(Boolean);
  for (let i = w.length - 1; i >= 0; i--) if (!/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w[i])) return w[i].replace(/[.,]$/, '');
  return w[w.length - 1] ?? '';
};

/**
 * Hand-set phrase swaps: the COACH-MSG template sentences said the way Nick says things (short,
 * no "would you", no pleasantries). Runs on the masked text, so names and positions are safe.
 */
const PHRASES = [
  [/^(hey|hi|hello|yo)( man| there)?[!,.]?\s*/i, ''],
  [/\bbeen looking at our rosters and had an idea\b/gi, 'had an idea'],
  [/\bhad an idea that could work for both of us\b/gi, 'had an idea'],
  [/\bhad an idea for an? (\S+) swap that could help us both\b/gi, 'had an idea for a $1 swap'],
  [/\blooks like you could use a little help at (\S+), and /gi, 'looks like u need help at $1. '],
  [/\byou look a bit thin at (\S+), and /gi, 'u look thin at $1. '],
  [/\b(would|could) slot right in\b/gi, 'would slot right in'],
  [/\bcould step right in for you\b/gi, 'could step right in'],
  [/\bcould be a nice fit on your team\b/gi, 'would be a good fit for u'],
  [/\bmight be useful for you\b/gi, 'could help u'],
  [/\bwould you do\b/gi, 'wanna do'],
  [/\bany interest in\b/gi, 'u interested in'],
  [/\btried to keep it even\b/gi, 'kept it even'],
  [/\bno rush, and no worries if not\b/gi, 'no rush. all good if not'],
  [/\bif it is a no, all good\b/gi, 'all good if not'],
  [/\bno worries if not\b/gi, 'all good if not'],
  [/\bopen to tweaking it( if not)?\b/gi, 'can tweak it'],
  [/\bany thoughts on\b/gi, 'thoughts on'],
  [/\bhappy to tweak it\b/gi, 'can tweak it'],
  [/\ball good, totally get it\b/gi, 'all good i get it'],
  [/\bappreciate you looking( at it)?\b/gi, 'appreciate u looking'],
  [/\bsending it over now\b/gi, 'sending it now'],
  [/\bis about where i can be\b/gi, "is where i'm at"],
];
function phraseSwaps(s, p) {
  let out = s;
  for (const [re, to] of PHRASES) out = out.replace(re, to);
  if ((p.rates?.bet ?? 0) >= 1) out = out.replace(/\b(sounds good|deal)\b[!,.]?/gi, 'bet');
  return out;
}

/** Split into sentences (and, where he rarely uses commas, at commas), then merge to MAX_BURSTS. */
function toBursts(s, p) {
  let parts = s.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  if ((p.comma ?? 1) < 0.2) parts = parts.flatMap(x => x.split(/,\s+(?=(?:\S+\s+){1,}\S+)/));
  while (parts.length > MAX_BURSTS) {
    // Merge the shortest adjacent pair so no single burst grows much.
    let best = 0;
    for (let i = 1; i < parts.length - 1; i++) if (parts[i].length + parts[i + 1].length < parts[best].length + parts[best + 1].length) best = i;
    parts.splice(best, 2, `${parts[best].replace(/[.!,]+$/, '')} ${parts[best + 1]}`);
  }
  return parts;
}

/** A fixed number in [0, 1) per text and purpose, so the same draft always styles the same way. */
function unit(text, salt) {
  let h = 2166136261;
  for (const c of `${salt}|${text}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/**
 * Nick's style on a draft, no model. profile: a profileOf() result; keep: strings that must
 * pass through untouched (player names); short: [[full name, surname]] pairs to say the way the
 * chat does (he texts surnames, rarely full names; the caller passes only surnames that are
 * unique in the league, see surnamePairs). Swaps apply when his short share is >= 0.5; the
 * first capital, a closing mark and a question mark are kept at his own rates (a fixed draw per
 * burst), so styled texts vary the way his do instead of all looking the same.
 * Returns { text (bursts joined by '\n'), bursts, source }.
 */
export function styleText(draft, profile, { keep = [], short = [] } = {}) {
  const p = profile ?? {};
  let d = norm(draft).replace(/\s+/g, ' ').trim();
  for (const [full, sur] of [...short].sort((a, b) => b[0].length - a[0].length)) {
    d = d.replace(new RegExp(`(?<![A-Za-z0-9])${esc(full)}(?![A-Za-z0-9])`, 'g'), sur);
  }
  const [masked, restore] = protect(d, [...keep, ...short.map(([, sur]) => sur)]);
  const bursts = toBursts(phraseSwaps(masked, p), p).map(b => {
    let s = b;
    // Each swap at his own rate (a fixed draw per burst and swap): he writes "u" most of the time, not always.
    for (const [long, sw] of Object.entries(p.swaps ?? {})) if (unit(b, `sw:${long}`) < (sw.share ?? 0)) s = s.replace(phraseRe(long), sw.to);
    if ((p.apostrophe ?? 1) < 0.5) s = s.replace(CONTRACTIONS, m => m.replace(/'/g, ''));
    if ((p.emoji ?? 0) < 0.05) s = s.replace(new RegExp(EMOJI.source, 'gu'), '');
    if ((p.comma ?? 1) < 0.2) s = s.replace(/,(\s|$)/g, '$1');
    // Casing: a scope that texts all lowercase gets all lowercase. Otherwise the draft's capitals
    // inside the text stay (proper nouns: his phone capitalises them too) and only sentence starts
    // drop; then "I" and the phone's first capital where his texts have them.
    if ((p.all_lower ?? 0) >= 0.5) s = s.toLowerCase();
    else s = s.replace(/^([^A-Za-z⟦]*)([A-Z])(?![A-Z])/, (_, a, c) => a + c.toLowerCase()).replace(/([.!?]\s+)([A-Z])(?![A-Z])/g, (_, a, c) => a + c.toLowerCase());
    if ((p.i_cap ?? 0) >= 0.5) s = s.replace(/(?<![A-Za-z'])i(?=$|[\s'.,!?’])/g, 'I');
    else s = s.replace(/(?<![A-Za-z'])I(?=$|[\s'.,!?’])/g, 'i');
    if (unit(b, 'cap') < (p.first_cap ?? 0)) s = s.replace(/^([^A-Za-z⟦]*)([a-z])/, (_, a, c) => a + c.toUpperCase());
    // End punctuation: he rarely closes a text.
    const isQ = /\?$/.test(s) || QUESTION_START.test(s);
    s = s.replace(/[.!?]+$/, '');
    if (isQ && unit(b, 'q') < (p.q_mark_on_questions ?? 0)) s += '?';
    else if (!isQ && unit(b, 'end') < (p.end_period ?? 0)) s += '.';
    if ((p.exclaim ?? 0) < 0.05) s = s.replace(/!+/g, '');
    if ((p.curly_apos ?? 0) >= 0.5) s = s.replace(/'/g, '’');
    return restore(s.replace(/\s+/g, ' ').trim());
  }).filter(Boolean);
  return { text: bursts.join('\n'), bursts, source: VOICE_SOURCE };
}

/* ------------------------------------------------------------------ 3. retrieval + model */

const tokens = s => {
  const w = norm(s).toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return [...w, ...w.slice(1).map((x, i) => `${w[i]} ${x}`)];
};

/** TF-IDF index over Nick's texts. docs: [{ text, thread, register }]. Texts of 2-25 words, no links. */
export function buildIndex(docs) {
  const keep = docs.filter(d => { const n = norm(d.text).trim().split(/\s+/).length; return n >= 2 && n <= 25 && !/https?:\/\//.test(d.text); });
  const df = new Map();
  const tf = keep.map(d => {
    const m = new Map();
    for (const t of tokens(d.text)) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return m;
  });
  const N = keep.length;
  const idf = t => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
  const vec = m => {
    const v = new Map(); let nn = 0;
    for (const [t, c] of m) { const x = (1 + Math.log(c)) * idf(t); v.set(t, x); nn += x * x; }
    nn = Math.sqrt(nn) || 1;
    for (const [t, x] of v) v.set(t, x / nn);
    return v;
  };
  return { docs: keep, vecs: tf.map(vec), vec: s => { const m = new Map(); for (const t of tokens(s)) m.set(t, (m.get(t) ?? 0) + 1); return vec(m); } };
}

/** Nick's k most similar texts to the draft; same thread x1.5, same register x1.2. */
export function similar(index, draft, { thread = null, register = null, k = 8 } = {}) {
  if (!index?.docs?.length) return [];
  const q = index.vec(draft);
  const scored = index.docs.map((d, i) => {
    let s = 0;
    for (const [t, x] of q) s += x * (index.vecs[i].get(t) ?? 0);
    if (thread && d.thread === thread) s *= 1.5; else if (register && d.register === register) s *= 1.2;
    return { d, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  const seen = new Set(), out = [];
  for (const { d } of scored) { const key = d.text.trim().toLowerCase(); if (seen.has(key)) continue; seen.add(key); out.push(d.text); if (out.length >= k) break; }
  return out;
}

/** The style guide the model reads, built from the profile's numbers (no texts). */
export function styleGuide(p) {
  if (!p) return 'Short casual texts.';
  const on = Object.entries(p.swaps ?? {}).filter(([, s]) => (s.share ?? 0) >= 0.5).map(([l, s]) => `${s.to} (not ${l})`);
  const hype = Object.entries(p.hype ?? {}).filter(([, r]) => r >= 0.3).map(([w]) => w);
  return [
    `Texts are short: median ${p.words?.median} words, 90% at most ${p.words?.p90}. Send 1-${MAX_BURSTS} separate short texts, one per line, rather than one long one.`,
    `${Math.round((p.first_cap ?? 0) * 100)}% start with a capital letter (phone autocorrect); the rest is lowercase apart from names.`,
    `${Math.round((p.end_punct ?? 0) * 100)}% end with punctuation, so leave the end bare; ${Math.round((p.q_mark_on_questions ?? 0) * 100)}% of questions carry a question mark.`,
    (p.apostrophe ?? 1) >= 0.5 ? 'Contractions keep their apostrophes.' : 'Contractions drop the apostrophe (dont, im).',
    on.length ? `Write ${on.join(', ')}.` : '',
    hype.length ? `Words he uses: ${hype.join(', ')}.` : '',
    (p.emoji ?? 0) < 0.05 ? 'No emoji.' : 'An emoji now and then is fine.',
    'No greetings like Hey!, no sign-offs, no exclamation marks.',
  ].filter(Boolean).join('\n');
}

/** The prompt for the model rewrite. keep: names that must appear exactly as given. */
export function promptFor(draft, { profile, examples = [], keep = [] }) {
  return [
    'Rewrite the draft text so it reads exactly like the sender below wrote it. Same meaning, same facts.',
    '', 'Style guide:', styleGuide(profile),
    '', 'Real texts from the sender (style reference only; do not copy their content):',
    ...examples.map(e => `- ${norm(e).replace(/\s+/g, ' ').trim()}`),
    '', 'Rules: keep every player name exactly as written' + (keep.length ? ` (${keep.join(', ')})` : '') + '; add no player, number, position or name; no quotes.',
    'Answer with the texts only, one per line.',
    '', `Draft: ${norm(draft)}`,
  ].join('\n');
}

/**
 * The voice for one recipient: its thread profile when the thread has one, else its register,
 * else the phone profile. voice: loadNickVoice() result or { profiles: Map scope -> profile }.
 * recipient: { thread, register } (register defaults to league_dm when a thread is given).
 */
export function resolveProfile(voice, recipient = {}) {
  const P = voice?.profiles;
  if (!P) return null;
  const reg = recipient.register ?? (recipient.thread ? 'league_dm' : null);
  return (recipient.thread && P.get(`thread:${recipient.thread}`)) || (reg && P.get(`register:${reg}`)) || P.get('phone') || P.get('all') || null;
}

/**
 * rewrite(draft, { recipient, voice, keep, check, callModel, env, k })
 *   recipient  { thread, register } or { roster } (resolved through voice.forRoster)
 *   check      text -> bool; the model's answer must pass it burst by burst (default: accept)
 *   callModel  async ({ prompt }) -> string; used only when GRIDIRON_NICK_VOICE and the paid-run
 *              opt-in are both set. Otherwise, or on any failure, the styler's text is returned.
 * Returns { text, bursts, source: 'voice.model' | 'voice.rules', examples: <count>, fallback?: why the
 * model text was not used }.
 */
export async function rewrite(draft, { recipient = {}, voice = null, keep = [], check = () => true, callModel = null, env = process.env, k = 8 } = {}) {
  const rc = recipient.roster != null && voice?.forRoster ? voice.forRoster(recipient.roster) : recipient;
  const profile = resolveProfile(voice, rc);
  const rules = styleText(draft, profile, { keep });
  const examples = similar(voice?.index, draft, { thread: rc.thread, register: rc.register ?? (rc.thread ? 'league_dm' : 'league_group'), k });
  if (typeof callModel !== 'function' || !paidAllowed(env)) return { ...rules, examples: examples.length };
  try {
    const raw = String(await callModel({ prompt: promptFor(draft, { profile, examples, keep }) }));
    const bursts = raw.split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    const ok = bursts.length >= 1 && bursts.length <= MAX_BURSTS && bursts.every(b => check(b)) && keep.every(n => !draft.includes(n) || bursts.some(b => b.includes(n)));
    if (ok) return { text: bursts.join('\n'), bursts, source: 'voice.model', examples: examples.length };
    return { ...rules, examples: examples.length, fallback: 'model text failed the check' };
  } catch (e) {
    // The styler's text stands; the reason is returned so the caller can log it.
    return { ...rules, examples: examples.length, fallback: `model call failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

/* ------------------------------------------------------------------ loading from the chat DB */

/** Nick's texts from an open chat DB: [{ text, register, thread, ts }] (tapbacks and blanks removed). */
export function readMine(chat) {
  const q = t => chat.prepare(`SELECT chat_kind, ${t === 'messages_ext' ? 'source_chat_kind' : 'chat_kind AS source_chat_kind'},
      chat_name, ts_utc, text FROM ${t} WHERE is_from_me = 1 AND COALESCE(is_tapback, 0) = 0
      AND TRIM(COALESCE(text, '')) <> '' ORDER BY ts_utc`).all()
    .map(r => ({ text: r.text, thread: r.chat_name, ts: r.ts_utc, register: registerOf(t, r.source_chat_kind) }));
  return [...q('messages'), ...q('messages_ext')].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/** Burst runs per thread from an open chat DB (both tables, every speaker, in time order). */
export function readBursts(chat) {
  const out = new Map();
  for (const t of ['messages', 'messages_ext']) {
    const byThread = new Map();
    for (const r of chat.prepare(`SELECT chat_name, is_from_me, ts_utc AS ts FROM ${t}
        WHERE COALESCE(is_tapback, 0) = 0 ORDER BY chat_name, ts_utc`).all()) {
      (byThread.get(r.chat_name) ?? byThread.set(r.chat_name, []).get(r.chat_name)).push(r);
    }
    for (const [th, rs] of byThread) out.set(th, [...(out.get(th) ?? []), ...burstRuns(rs)]);
  }
  return out;
}

/**
 * Stored profiles from an open chat DB: Map scope -> profile (empty when the table is absent).
 * These are Nick's texting-style profiles (nick_voice_profile in the private chat DB), not
 * the negotiation profiles' JSON column, which only people/profile-reader.js parses (ONE-READER);
 * the column is read as style_json so the two are never confused.
 */
export function readProfiles(chat) {
  try {
    return new Map(chat.prepare(`SELECT scope, profile_json AS style_json FROM ${PROFILE_TABLE}`).all()
      .map(r => [r.scope, JSON.parse(r.style_json)]));
  } catch (e) {
    if (/no such table/.test(String(e?.message))) return new Map();
    throw e;
  }
}

const cache = new Map();
/**
 * The voice for one league, from the private chat DB: stored profiles, the retrieval index over
 * Nick's league texts, and roster -> thread from the trusted identity map. null when the chat DB
 * or the profile table is absent (COACH-MSG then keeps its unstyled text).
 */
export async function loadNickVoice(leagueId) {
  const { openChatDb, chatDbPath } = await import('../manager-signals.js');
  const { identityMap } = await import('../manager-identity.js');
  const chat = openChatDb();
  if (!chat) return null;
  try {
    const profiles = readProfiles(chat);
    if (!profiles.size) return null;
    const stamp = chat.prepare(`SELECT MAX(built_at) AS m FROM ${PROFILE_TABLE}`).get()?.m ?? '';
    const key = `${chatDbPath()}|${stamp}`;
    let base = cache.get(key);
    if (!base) {
      base = { profiles, index: buildIndex(readMine(chat).filter(r => PHONE_REGISTERS.includes(r.register))) };
      cache.clear(); cache.set(key, base);
    }
    const threadByRoster = new Map([...identityMap(leagueId)].map(([roster, r]) => [String(roster), r.chat_name]));
    return { ...base, forRoster: roster => ({ thread: threadByRoster.get(String(roster)) ?? null, register: 'league_dm' }) };
  } finally { chat.close(); }
}
