/**
 * COACH-MSG: the grounding checker for the messages Nick sends (NORTH-STAR row 6).
 *
 * Rule: every player, number and position a message names must exist in the
 * step's own engine fields. Anything else is an ungrounded claim and the message
 * is rejected (the caller falls back to the template). The checker is the gate
 * for the rules phraser (messages.js) and for the optional model phraser alike;
 * it never repairs a message, it only says yes or no and why.
 *
 * What it checks (pure; no DB, no env):
 *   length        at most MAX_CHARS characters
 *   players       a full name, or a capitalised surname, of any player in the
 *                 league's `names` map must belong to an allowed id
 *   numbers       every digit run (with its % sign) must be one of the step's
 *                 numbers, spelled as the step spells it
 *   positions     QB / RB / WR / TE / K / DST / D/ST / FLEX must be an allowed
 *                 position (the positions of the allowed players and the
 *                 partner's engine-read roster holes)
 *   proper nouns  a capitalised word that is not the start of a sentence, not
 *                 part of an allowed player's name and not in the small house
 *                 vocabulary is treated as an invented name and rejected
 *   quotes        no double quotes or backticks: chat text is never quoted
 *
 * MSG-CHECK-FIX: player names match case-insensitively (a styled draft may lowercase
 * a name the way Nick does), and curly apostrophes read as straight ones. A surname
 * inside a longer name token is not that player when the token is itself a league
 * name word ("Smith" inside "Smith-Njigba"); any other token still counts
 * ("Jefferson's", "Jefferson-for-Addison"). A lowercase surname that is also a common
 * word (COMMON_WORDS: "rush", "love", "brown") is read as the word; capitalised, it
 * is still a name.
 *
 * Known gap: spelled-out numbers ("two") are not parsed as numbers; the rules
 * phraser never writes them and the model phraser is told not to. A lowercase
 * surname in COMMON_WORDS naming a player outside the step is not caught.
 */

export const MAX_CHARS = 280;
export const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'FLEX']);

/** Capitalised words any message may use without being a name (sentence case aside). */
export const HOUSE_WORDS = Object.freeze(new Set([
  'I', "I'm", "I'd", "I'll", "I've", 'Team', 'ESPN', 'OK', 'No', 'Yes', 'Deal', 'Hey', 'Yo',
]));

/** "Deebo Samuel Sr. (WR)" -> { name: 'Deebo Samuel Sr.', position: 'WR' } */
export function splitName(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(.*?)\s*\(([A-Z/]{1,5})\)\s*$/.exec(s);
  return m ? { name: m[1].trim(), position: m[2] === 'D/ST' ? 'DST' : m[2] } : { name: s, position: null };
}

const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_CH = /[A-Za-z0-9'-]/;
const straight = s => String(s).replace(/[\u2018\u2019]/g, "'");

/** Lowercase words that are also player surnames: read as the word when lowercase. Hand-set. */
export const COMMON_WORDS = Object.freeze(new Set([
  'rush', 'love', 'brown', 'white', 'black', 'green', 'gray', 'hill', 'chase', 'will', 'rice', 'cook', 'hunt',
  'young', 'price', 'ward', 'wood', 'woods', 'hall', 'king', 'bell', 'lock', 'swift', 'cross', 'strange', 'free',
  'fields', 'banks', 'rivers', 'lane', 'hurts', 'knight', 'long', 'still', 'ford', 'reed', 'moss', 'best', 'hope',
  'worthy', 'means', 'mack', 'mills', 'person', 'wells', 'waters', 'hardy', 'sweat', 'pierce', 'lamb', 'baker',
  'carter', 'miller', 'walker', 'turner', 'hunter', 'cooper', 'mason', 'guy', 'marks', 'little', 'major', 'day',
  'field', 'golden', 'sanders', 'judge', 'page', 'fuller', 'booth', 'bishop', 'cash', 'foster', 'likely', 'flowers',
  'bass', 'downs', 'strong',
]));

/**
 * True when the match at [i, i + len) sits inside a longer name token (letters, digits, hyphens,
 * apostrophes) that is itself a word of some league player's name, so it names that player instead.
 * A trailing possessive is dropped first ("Smith-Njigba's" -> "smith-njigba").
 */
function insideOtherName(text, i, len, nameWords) {
  let s = i, e = i + len;
  while (s > 0 && NAME_CH.test(text[s - 1])) s--;
  while (e < text.length && NAME_CH.test(text[e])) e++;
  if (s === i && e === i + len) return false;
  const tok = text.slice(s, e).replace(/'s$/i, '').replace(/^['-]+|['-]+$/g, '').toLowerCase();
  return tok !== text.slice(i, i + len).toLowerCase() && nameWords.has(tok);
}

/** The surname a group chat would use: the last word that is not a suffix. */
export function surname(name) {
  const words = String(name).split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) if (!SUFFIX.test(words[i])) return words[i].replace(/[.,]$/, '');
  return words[words.length - 1] ?? '';
}

/** Numbers as a message would spell them: 12, 12.5, 4%, -4%, +4%. */
export function numberTokens(text) {
  return [...String(text).matchAll(/[+-]?\d+(?:\.\d+)?%?/g)].map(m => m[0].replace(/^\+/, ''));
}

/**
 * The facts a step's messages may use.
 * names: league `names` map (id -> "Name (POS)"); ids: allowed player ids;
 * holes: the partner's engine-read roster holes (positions); numbers: strings.
 */
export function factsFor({ names = {}, ids = [], holes = [], numbers = [] }) {
  const allowed = new Set(ids.map(String).filter(id => Object.hasOwn(names, id)));
  const positions = new Set(holes.map(p => (String(p).toUpperCase() === 'D/ST' ? 'DST' : String(p).toUpperCase())));
  for (const id of allowed) {
    const { position } = splitName(names[id]);
    if (position) positions.add(position);
  }
  return { names, allowed, positions, numbers: new Set(numbers.map(String).map(n => n.replace(/^\+/, ''))) };
}

/**
 * Check one message against the step's facts.
 * Returns { ok, errors: [string], claims: { players: [id], numbers: [str], positions: [str] } }.
 */
export function checkMessage(text, facts) {
  const errors = [];
  const claims = { players: [], numbers: [], positions: [] };
  const t = String(text ?? '');
  if (!t.trim()) return { ok: false, errors: ['empty message'], claims };
  if (t.length > MAX_CHARS) errors.push(`too long: ${t.length} > ${MAX_CHARS} characters`);
  if (/["`“”]/.test(t)) errors.push('contains a quote mark: chat text is never quoted');

  // Players: full names first, then surnames outside an allowed full name. Curly apostrophes read
  // as straight ones for every check below (same length, so positions line up).
  let masked = straight(t);
  const entries = Object.entries(facts.names).map(([id, raw]) => [id, straight(splitName(raw).name)]).filter(([, n]) => n.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [id, name] of entries) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${esc(name)}(?![A-Za-z0-9])`, 'gi');
    if (!re.test(masked)) continue;
    re.lastIndex = 0;
    if (facts.allowed.has(id)) { claims.players.push(id); masked = masked.replace(re, (m, pre) => `${pre}${'_'.repeat(name.length)}`); }
    else errors.push(`names a player not in this step: ${name}`);
  }
  const allowedWords = new Set();
  for (const id of facts.allowed) for (const w of straight(splitName(facts.names[id]).name).split(/\s+/)) allowedWords.add(w.replace(/[.,]$/, ''));
  const allowedLower = new Set([...allowedWords].map(w => w.toLowerCase()));
  const nameWords = new Set(entries.flatMap(([, n]) => n.split(/\s+/).map(w => w.replace(/[.,]$/, '').toLowerCase())));
  for (const [id, name] of entries) {
    if (facts.allowed.has(id)) continue;
    const sn = surname(name);
    if (sn.length < 3 || allowedLower.has(sn.toLowerCase())) continue;
    for (const m of masked.matchAll(new RegExp(`(?<![A-Za-z0-9])${esc(sn)}(?![A-Za-z0-9])`, 'gi'))) {
      if (insideOtherName(masked, m.index, m[0].length, nameWords)) continue;
      if (m[0] === m[0].toLowerCase() && COMMON_WORDS.has(m[0])) continue;
      errors.push(`names a player not in this step: ${sn}`);
      break;
    }
  }

  // Positions.
  for (const m of masked.matchAll(/\b(D\/ST|DST|QB|RB|WR|TE|FLEX|K)\b/g)) {
    const p = m[1] === 'D/ST' ? 'DST' : m[1];
    if (facts.positions.has(p)) claims.positions.push(p);
    else errors.push(`names a position the engine did not read for this step: ${m[1]}`);
  }

  // Numbers.
  for (const n of numberTokens(masked)) {
    if (facts.numbers.has(n)) claims.numbers.push(n);
    else errors.push(`states a number not in this step's fields: ${n}`);
  }

  // Invented proper nouns: capitalised words that are not sentence starts, names, positions or house words.
  const words = masked.replace(/\b(D\/ST|DST|QB|RB|WR|TE|FLEX|K)\b/g, ' ').split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[^A-Za-z']+|[^A-Za-z'.]+$/g, '').replace(/\.$/, '');
    if (!/^[A-Z]/.test(w)) continue;
    const prev = words[i - 1] ?? '';
    const sentenceStart = i === 0 || /[.!?:]$/.test(prev) || /^[-(]$/.test(prev);
    if (sentenceStart || HOUSE_WORDS.has(w) || allowedWords.has(w)) continue;
    errors.push(`capitalised word that is not a known name: ${w}`);
  }
  return { ok: errors.length === 0, errors, claims };
}

/**
 * VOICE-01: a message sent as several short texts (bursts, one per line). Each burst is checked
 * on its own (so a burst's capitalised first word counts as a sentence start) and the whole
 * message keeps the MAX_CHARS limit. A one-line message checks exactly as checkMessage.
 */
export function checkBursts(text, facts) {
  const lines = String(text ?? '').split('\n');
  if (lines.length === 1) return checkMessage(text, facts);
  const out = { ok: true, errors: [], claims: { players: [], numbers: [], positions: [] } };
  if (String(text).length > MAX_CHARS) out.errors.push(`too long: ${String(text).length} > ${MAX_CHARS} characters`);
  for (const line of lines) {
    const c = checkMessage(line, facts);
    out.errors.push(...c.errors);
    for (const k of Object.keys(out.claims)) out.claims[k].push(...c.claims[k]);
  }
  out.ok = out.errors.length === 0;
  return out;
}
