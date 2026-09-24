/**
 * The reader for stored negotiation profiles (schema v2) and Nick's own notes
 * about each manager. Pure: no database access here. The caller
 * (counterparty-pricing.js#negotiationProfilesFor) reads the private chat DB
 * and hands the rows in; nothing read here is written anywhere.
 *
 * Why v2: the profiles rebuilt after 2026-09-18 carry new top-level keys and
 * write sentences where v1 had enum values ("rarely (… is the exception)",
 * "often (8 …)", "moderate"). v1 rejected every one of them, so every
 * counterparty read went blank. v2 declares the new keys and parses each enum
 * slot from its leading word, keeping the sentence beside it as `<slot>_text`.
 *
 * Seed of PEOPLE-01's reader: one place that says what a person's stored read
 * means.
 */

const strings = { type: 'array', items: { type: 'string' } };
const any = { type: 'any' };
const boolish = { anyOf: [{ type: 'boolean' }, { type: 'string' }] };

export const HOLDS = Object.freeze(['yes', 'usually', 'rarely', 'unknown']);
export const HOW_OFTEN = Object.freeze(['often', 'sometimes', 'once']);
export const INFLATION = Object.freeze(['none', 'mild', 'heavy', 'unknown']);
export const READING = Object.freeze(['belief', 'marketing', 'habit', 'mixed', 'unknown']);
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

// Keys Nick may set by hand on a profile. Anything else is a typo and is reported.
export const NICK_OVERRIDE_KEYS = Object.freeze(['active', 'difficulty', 'contactable', 'buyer', 'trades',
  'fan_of', 'note']);

const enumSlot = (values) => ({ type: 'string', enum: values });
const text = { type: 'string' };

export const NEGOTIATION_PROFILE_SCHEMA_V2 = Object.freeze({
  type: 'object',
  properties: {
    headline: text,
    says_no: { type: 'object', properties: {
      how: text, hard_no_looks_like: strings, soft_no_looks_like: strings,
      does_his_no_hold: enumSlot(HOLDS), does_his_no_hold_text: text, evidence: strings,
    }, required: ['how', 'does_his_no_hold', 'evidence'] },
    praise_means: { type: 'object', properties: {
      reading: enumSlot(READING), reading_text: text,
      why: text, hypes_before_selling: { type: 'boolean' }, agrees_with_numbers: text,
      evidence: strings,
    }, required: ['reading', 'why', 'evidence'] },
    techniques: { type: 'array', items: { type: 'object', properties: {
      name: text, how_he_does_it: text, evidence: strings,
      how_often: enumSlot(HOW_OFTEN), how_often_text: text,
    }, required: ['name', 'how_he_does_it', 'how_often'] } },
    calibration: { type: 'object', properties: {
      enthusiasm_scale: text, baseline_tone: text,
      inflation: enumSlot(INFLATION), inflation_text: text,
    }, required: ['enthusiasm_scale', 'inflation'] },
    roster_read: { type: 'object', properties: {
      really_untouchable: strings, quietly_available: strings, overvalues: strings, undervalues: strings,
      reasoning: text,
    } },
    what_moves_him: strings,
    what_shuts_him_down: strings,
    how_to_approach: text,
    best_bait: { anyOf: [text, { type: 'object' }] }, // an object on one live row (LOCAL run, a5598584)
    confidence: enumSlot(CONFIDENCE), confidence_text: text,
    caveats: strings,
    // v2 — shapes not fixed by the builder; any JSON, still checked for leaked markup.
    deal_feelings: any,
    values_talk: any,
    behaviour_vs_words: any,
    changes_since_0918: any,
    league_roster: any,
    subject: any,
    // Seen on live rows by the LOCAL run on a5598584; shapes not fixed either.
    relations_note: any,
    security_note: any,
    built_from: any,
    built_at: any,
    sources: any,
    league4_trade_record: any,
    // v2 — shapes known.
    as_of: text,
    messages_read: { type: 'number' },
    slug: text,
    name: text,
    aliases: strings,
    league4_roster_id: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    nick_override: { type: 'object', properties: {
      active: boolish,
      difficulty: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      contactable: boolish,
      buyer: boolish,
      trades: any,
      fan_of: { anyOf: [{ type: 'string' }, strings] },
      note: text,
    } },
  },
  required: ['headline', 'says_no', 'praise_means', 'techniques', 'calibration',
    'what_moves_him', 'how_to_approach', 'confidence', 'caveats'],
});

const MARKUP = /<\/?parameter\b/;

/**
 * Every violation of the schema, recursively: type, enum, required keys,
 * unexpected keys, and tool-call markup leaked into a string — the failure
 * that left six of nine profiles unusable on 2026-09-18 while still parsing.
 * Messages name the path, never the stored value.
 */
export function schemaErrors(schema, value, where = 'profile') {
  if (value == null) return [];
  if (schema.anyOf) {
    const each = schema.anyOf.map(s => schemaErrors(s, value, where));
    if (each.some(e => e.length === 0)) return [];
    const markup = each.flat().find(e => /leaked tool-call markup/.test(e));
    return [markup ?? `${where}: expected ${schema.anyOf.map(s => s.type).join(' or ')}`];
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return [`${where}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`];
      }
      if (!schema.properties) return anyMarkup(value, where); // an object of any shape
      const errs = [];
      for (const k of schema.required ?? []) if (value[k] == null) errs.push(`${where}.${k}: missing`);
      const known = schema.properties;
      for (const k of Object.keys(value)) {
        if (!(k in known)) errs.push(`${where}.${k}: unexpected key`);
        else errs.push(...schemaErrors(known[k], value[k], `${where}.${k}`));
      }
      return errs;
    }
    case 'array':
      if (!Array.isArray(value)) return [`${where}: expected array, got ${typeof value}`];
      return value.flatMap((v, i) => schemaErrors(schema.items, v, `${where}[${i}]`));
    case 'string':
      if (typeof value !== 'string') return [`${where}: expected string, got ${typeof value}`];
      if (MARKUP.test(value)) return [`${where}: leaked tool-call markup`];
      if (schema.enum && !schema.enum.includes(value)) return [`${where}: value not in ${schema.enum.join('/')}`];
      return [];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${where}: expected boolean, got ${typeof value}`];
    case 'number':
      return Number.isFinite(value) ? [] : [`${where}: expected number, got ${typeof value}`];
    case 'any':
      return anyMarkup(value, where);
    default:
      return [];
  }
}

function anyMarkup(value, where) {
  if (typeof value === 'string') return MARKUP.test(value) ? [`${where}: leaked tool-call markup`] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => anyMarkup(v, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => anyMarkup(v, `${where}.${k}`));
  }
  return [];
}

// ------------------------------------------------------------ enum parsing

// Words that only grade the next word ("very often"); the parser skips them.
const INTENSIFIERS = new Set(['very', 'fairly', 'pretty', 'quite', 'somewhat', 'really', 'extremely', 'a']);
// Hedges ("mostly marketing"): skipped only when the slot's own word map does
// not give them a meaning — "mostly" is `usually` for holds.
const HEDGES = new Set(['mostly', 'largely', 'mainly', 'primarily', 'partly', 'probably', 'likely', 'generally',
  'genuinely', 'seems', 'appears']);

/**
 * The first meaningful word of a free-text value, lowercased; null if none.
 * With `words`, a leading hedge the map does not know is skipped too.
 */
export function leadingToken(value, words = null) {
  if (typeof value !== 'string') return null;
  const all = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return all.find(w => !INTENSIFIERS.has(w) && !(words && HEDGES.has(w) && !words[w])) ?? null;
}

const HOLDS_WORDS = { yes: 'yes', always: 'yes', usually: 'usually', mostly: 'usually', generally: 'usually',
  often: 'usually', rarely: 'rarely', seldom: 'rarely', never: 'rarely', no: 'rarely', unknown: 'unknown',
  unclear: 'unknown' };
const OFTEN_WORDS = { often: 'often', frequently: 'often', repeatedly: 'often', regularly: 'often',
  constantly: 'often', always: 'often', usually: 'often', sometimes: 'sometimes', twice: 'sometimes',
  occasionally: 'sometimes', few: 'sometimes', several: 'sometimes', rarely: 'sometimes', once: 'once',
  single: 'once' };
const INFLATION_WORDS = { none: 'none', no: 'none', mild: 'mild', moderate: 'mild', slight: 'mild',
  minimal: 'mild', low: 'mild', some: 'mild', heavy: 'heavy', high: 'heavy', significant: 'heavy',
  strong: 'heavy', extreme: 'heavy', unknown: 'unknown', unclear: 'unknown' };
const READING_WORDS = { belief: 'belief', genuine: 'belief', sincere: 'belief', marketing: 'marketing',
  sales: 'marketing', salesmanship: 'marketing', selling: 'marketing', habit: 'habit', reflexive: 'habit',
  mixed: 'mixed', both: 'mixed', unknown: 'unknown', unclear: 'unknown' };

function parser(words, fallback, numeric = null) {
  return (value) => {
    const t = leadingToken(value, words);
    if (t != null && words[t]) return { value: words[t], parsed: true };
    if (t != null && numeric && /^\d+$/.test(t)) return { value: numeric(Number(t)), parsed: true };
    return { value: fallback, parsed: false };
  };
}

export const parseHolds = parser(HOLDS_WORDS, 'unknown');
export const parseHowOften = parser(OFTEN_WORDS, 'sometimes', n => (n <= 1 ? 'once' : n <= 3 ? 'sometimes' : 'often'));
export const parseInflation = parser(INFLATION_WORDS, 'unknown');
export const parseReading = parser(READING_WORDS, 'mixed');
const CONFIDENCE_WORDS = { high: 'high', medium: 'medium', moderate: 'medium', mid: 'medium', fair: 'medium',
  low: 'low' };
// Unparsed is `low`: the pricing layer weighs an unstated confidence as low too.
export const parseConfidence = parser(CONFIDENCE_WORDS, 'low');

/**
 * Parses each enum slot of one raw profile in a copy: the slot gets the enum
 * value, `<slot>_text` keeps what was stored. Returns the copy and the paths
 * whose leading word matched nothing (they got the fallback) — paths only,
 * never the stored text.
 */
export function normaliseProfile(raw) {
  const profile = structuredClone(raw);
  const unparsed = [];
  const slot = (obj, key, parse, where) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj[key] !== 'string') return;
    const stored = obj[key];
    const r = parse(stored);
    if (obj[`${key}_text`] == null) obj[`${key}_text`] = stored;
    obj[key] = r.value;
    if (!r.parsed) unparsed.push(`${where}.${key} -> ${r.value}`);
  };
  slot(profile.says_no, 'does_his_no_hold', parseHolds, 'says_no');
  slot(profile.praise_means, 'reading', parseReading, 'praise_means');
  slot(profile.calibration, 'inflation', parseInflation, 'calibration');
  slot(profile, 'confidence', parseConfidence, 'profile');
  if (Array.isArray(profile.techniques)) {
    profile.techniques.forEach((t, i) => slot(t, 'how_often', parseHowOften, `techniques[${i}]`));
  }
  return { profile, unparsed };
}

/**
 * One stored profile, read: `{ profile, errors, unparsed }`. `profile` is the
 * normalised copy, null when the input is not an object. Errors are checked on
 * the normalised copy, so a sentence in an enum slot passes and a wrong type
 * or an unknown key still fails.
 */
export function readProfile(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { profile: null, errors: ['profile: expected object'], unparsed: [] };
  }
  const { profile, unparsed } = normaliseProfile(raw);
  return { profile, errors: schemaErrors(NEGOTIATION_PROFILE_SCHEMA_V2, profile), unparsed };
}

// ------------------------------------------------------------ Nick's read

/** true / false / null from a boolean or a yes/no sentence. */
export function parseBool(value) {
  if (typeof value === 'boolean') return value;
  const t = leadingToken(value);
  if (['yes', 'true', 'y', 'active', 'contactable', 'buyer'].includes(t)) return true;
  if (['no', 'false', 'n', 'not', 'never', 'inactive'].includes(t)) return false;
  return null;
}

// Conservative reads from a note's wording. Negative forms are tested first,
// because "not active" contains "active".
const NOTE_RULES = {
  active: [[/\b(inactive|not active|checked out|abandoned|gone dark|quit)\b/, false], [/\bactive\b/, true]],
  contactable: [[/\b(not contactable|unreachable|(doesn'?t|won'?t|never) (respond|reply|answer)s?|no response|ignores)\b/, false],
    [/\b(contactable|responsive|easy to reach|replies fast|responds fast)\b/, true]],
  buyer: [[/\b(not a buyer|seller|selling|rebuild(ing)?)\b/, false], [/\b(buyer|buying|win[- ]now)\b/, true]],
  difficulty: [[/\b(difficult|stubborn|tough to deal)\b/, 'hard'], [/\b(easy to deal|easygoing|pushover)\b/, 'easy']],
};

function fromNotes(notes, field) {
  for (const n of notes) {
    const text = String(n.note ?? '').toLowerCase();
    for (const [re, v] of NOTE_RULES[field]) if (re.test(text)) return v;
  }
  return null;
}

/**
 * Nick's read of one manager: `{ contactable, active, difficulty, buyer,
 * notes[], from }`. `nick_override` on the profile beats anything read from
 * the notes; `from[field]` says which one each value came from
 * ('nick_override' | 'manager_notes' | null).
 *
 * @param {object|null} override  the profile's nick_override, if any
 * @param {Array<{note, source, noted_at}>} notes  manager_notes rows for this person
 */
export function nickRead(override, notes = []) {
  const ordered = [...notes].sort((a, b) => String(b.noted_at ?? '').localeCompare(String(a.noted_at ?? '')));
  const o = override && typeof override === 'object' ? override : {};
  const out = { contactable: null, active: null, difficulty: null, buyer: null,
    notes: ordered.map(n => ({ note: n.note, source: n.source ?? null, noted_at: n.noted_at ?? null })),
    from: { contactable: null, active: null, difficulty: null, buyer: null } };
  for (const field of ['contactable', 'active', 'buyer']) {
    const v = o[field] == null ? null : parseBool(o[field]);
    if (v != null) { out[field] = v; out.from[field] = 'nick_override'; continue; }
    const n = fromNotes(ordered, field);
    if (n != null) { out[field] = n; out.from[field] = 'manager_notes'; }
  }
  if (o.difficulty != null && o.difficulty !== '') {
    out.difficulty = o.difficulty; out.from.difficulty = 'nick_override';
  } else {
    const n = fromNotes(ordered, 'difficulty');
    if (n != null) { out.difficulty = n; out.from.difficulty = 'manager_notes'; }
  }
  if (typeof o.note === 'string' && o.note.trim()) {
    out.notes.unshift({ note: o.note, source: 'nick_override', noted_at: null });
  }
  return out;
}
