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
 * Known gap: spelled-out numbers ("two") are not parsed as numbers; the rules
 * phraser never writes them and the model phraser is told not to.
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

  // Players: full names first, then capitalised surnames outside an allowed full name.
  let masked = t;
  const entries = Object.entries(facts.names).map(([id, raw]) => [id, splitName(raw).name]).filter(([, n]) => n.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [id, name] of entries) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${esc(name)}(?![A-Za-z0-9])`, 'g');
    if (!re.test(masked)) continue;
    if (facts.allowed.has(id)) { claims.players.push(id); masked = masked.replace(re, (m, pre) => `${pre}${'_'.repeat(name.length)}`); }
    else errors.push(`names a player not in this step: ${name}`);
  }
  const allowedWords = new Set();
  for (const id of facts.allowed) for (const w of splitName(facts.names[id]).name.split(/\s+/)) allowedWords.add(w.replace(/[.,]$/, ''));
  for (const [id, name] of entries) {
    if (facts.allowed.has(id)) continue;
    const sn = surname(name);
    if (sn.length < 3 || allowedWords.has(sn)) continue;
    if (new RegExp(`(^|[^A-Za-z0-9])${esc(sn)}(?![A-Za-z0-9])`).test(masked)) errors.push(`names a player not in this step: ${sn}`);
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
