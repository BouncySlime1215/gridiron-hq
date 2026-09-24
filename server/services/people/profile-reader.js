/**
 * PEOPLE-01 / ONE-READER: the one reader of the stored people profiles
 * (negotiation_profiles.profile_json, schema v2) and of Nick's own read of each
 * manager (profile_json.nick_override + manager_notes rows whose source starts
 * 'nick': 'nick', 'nick+data', 'nick-chat-*'). It is the ONE producer of the field `people.profile`
 * (docs/handoff/local/FIELD-REGISTRY.md); no other file may parse profile_json
 * (test/people-reader-ratchet.test.js holds that line).
 *
 * Layers, top to bottom:
 *   schema v2 + enum parsing   readProfile / normaliseProfile (pure)
 *   Nick's read                nickBlock (the FIX-02 #276 block, folded in; RULINGS 1
 *                              and 17: the ONE owner of the Nick flags), nickBlocksFrom
 *                              (per roster, from an open chat handle), untouchables
 *                              ('untouchable: <player>' notes -> player ids per roster)
 *   people.profile             peopleProfileFromRows (pure) <- peopleProfileFromChat
 *                              (an open chat DB handle) <- peopleProfile (opens it)
 *
 * Why v2: the profiles rebuilt after 2026-09-18 carry new top-level keys and
 * write sentences where v1 had enum values ("rarely (… is the exception)",
 * "often (8 …)", "moderate"). v1 rejected every one of them, so every
 * counterparty read went blank. v2 declares the new keys and parses each enum
 * slot from its leading word, keeping the sentence beside it as `<slot>_text`.
 *
 * Typed absence: a manager with no profile, an invalid profile, or fewer than
 * QUIET_MESSAGES messages read is `status: 'unknown'` with a reason. Unknown is
 * not neutral: consumers must not score it. Nick's block still applies to him.
 * Nothing read here is written anywhere; labels and counts only leave the chat DB.
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
    // an object on one live row (LOCAL run, a5598584); a list of strings on another (ONE-READER local copy, 9/24)
    best_bait: { anyOf: [text, { type: 'object' }, strings] },
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

// ------------------------------------------------------------ one parse of profile_json

/**
 * The only JSON.parse of a stored profile_json in the codebase (ratchet:
 * test/people-reader-ratchet.test.js). `{ raw, error }`; error is a fixed
 * message, never the stored text.
 */
export function parseProfileJson(json) {
  if (json != null && typeof json === 'object') return { raw: json, error: null };
  if (typeof json !== 'string') return { raw: null, error: 'profile_json: missing' };
  try { return { raw: JSON.parse(json), error: null }; } catch { return { raw: null, error: 'unparseable JSON' }; }
}

// ------------------------------------------------------------ Nick's block (FIX-02 #276, folded in)

/**
 * Every manager_notes row Nick authored carries a source starting 'nick' (SQL: source LIKE 'nick%'):
 * 'nick' (his notes of 9/17), 'nick+data' (his correction backed by data), 'nick-chat-<date>'
 * (what he told Claude in chat). Any other source (a model, 'chat') is not Nick's word.
 */
export const NICK_NOTES_PREFIX = 'nick';
export const isNickNote = n => typeof n?.source === 'string' && n.source.toLowerCase().startsWith(NICK_NOTES_PREFIX);
/** The source of the notes Nick wrote in chat on 2026-09-23 (one of the NICK_NOTES_PREFIX sources). */
export const NICK_NOTES_SOURCE = 'nick-chat-2026-09-23';

const boolOf = v => (v === true || v === false ? v : v === 1 || v === 0 ? v === 1 : parseBool(v));
const textOf = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Notes oldest first by noted_at (ISO dates and timestamps sort as text); stable, missing noted_at first. */
const byNotedAt = notes => [...(notes ?? [])].sort((a, b) => String(a?.noted_at ?? '').localeCompare(String(b?.noted_at ?? '')));

/** 'probably none', 'none', 'no' -> this manager does not expect to trade. */
export function tradesNone(trades) {
  return typeof trades === 'string' && /\b(none|no|never)\b/i.test(trades);
}

/**
 * One manager's Nick block from his nick_override object and his notes.
 * Notes with a source are used only when it starts NICK_NOTES_PREFIX. A note
 * whose text is a JSON object is read as override keys; a note 'untouchable: <player>'
 * names a player his owner will not trade (untouchable_names; resolveUntouchables turns
 * them into player ids against that roster); any other note is kept as a note, never
 * parsed for meaning. Notes apply oldest first by noted_at, so the newest note wins a key
 * two notes both set (a note without noted_at counts as oldest). nick_override beats a note on the same key.
 * Returns null when there is nothing; `{ empty: true, warnings }` when there
 * was input but none of it usable.
 *
 *   contactable:false  he cannot be reached: never a step, flip leg or target owner
 *   active:true        in the active trading pool
 *   buyer:false / trades:'probably none'   deprioritised
 *   difficulty         tougher pricing when it says hard / difficult / tough
 */
export function nickBlock(override = null, notes = []) {
  const keys = {};
  const kept = [];
  const warnings = [];
  const untouchable = [];
  const take = (obj, from) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!NICK_OVERRIDE_KEYS.includes(k)) { warnings.push(`${from}.${k}: unexpected key, ignored`); continue; }
      keys[k] = { v, from };
    }
  };
  for (const n of byNotedAt(notes)) {
    if (n?.source != null && !isNickNote(n)) continue;
    const raw = textOf(n?.note);
    if (!raw) continue;
    let parsed = null;
    if (raw.startsWith('{')) {
      try { parsed = JSON.parse(raw); } catch { warnings.push('manager_notes: a note starting with { is not JSON; kept as text'); }
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { take(parsed, 'manager_notes'); continue; }
    const player = untouchableName(raw);
    if (player && !untouchable.includes(player)) untouchable.push(player);
    kept.push({ text: raw, at: n?.noted_at ?? null });
  }
  if (override != null) {
    if (typeof override === 'object' && !Array.isArray(override)) take(override, 'nick_override');
    else warnings.push('nick_override: expected an object, ignored');
  }
  if (!Object.keys(keys).length && !kept.length) return warnings.length ? { empty: true, warnings } : null;

  const val = k => keys[k]?.v;
  const contactable = boolOf(val('contactable'));
  const active = boolOf(val('active'));
  const buyer = boolOf(val('buyer'));
  const difficulty = val('difficulty') == null ? null : textOf(String(val('difficulty')));
  const trades = textOf(val('trades'));
  const unreachable = contactable === false;
  const hard = !!difficulty && /\bhard\b|\bdifficult\b|\btough\b/i.test(difficulty);
  const deprioritised = !unreachable && (buyer === false || tradesNone(trades));
  return {
    contactable, active, buyer, difficulty, trades,
    fan_of: val('fan_of') ?? null, note: textOf(val('note')),
    unreachable, deprioritised, hard,
    // The pool is who Nick says trades; an unreachable or deprioritised manager is never in it.
    in_active_pool: active === true && !unreachable && !deprioritised,
    // Nick's word: these players are never a target, a get or a flip leg. Names until
    // resolveUntouchables matches them against the roster; `untouchable` holds the ids.
    untouchable_names: untouchable, untouchable: null, untouchable_unmatched: [],
    sources: Object.fromEntries(Object.entries(keys).map(([k, x]) => [k, x.from])),
    notes: kept, warnings,
  };
}

/** 'untouchable: Jahmyr Gibbs (Nick 9/24: ...)' -> 'Jahmyr Gibbs'; anything else -> null. */
export function untouchableName(note) {
  const m = /^\s*untouchable\s*[:\-]\s*([^()\n;]+?)\s*(?:\(|;|$)/i.exec(String(note ?? ''));
  return m && m[1].trim() ? m[1].trim() : null;
}

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
/** A player name for matching: lowercase letters and digits only, suffixes dropped ('Smith-Njigba Jr.' -> 'smithnjigba'). */
export const nameKey = name => String(name ?? '').toLowerCase().replace(/[.']/g, '').replace(SUFFIX, '').replace(/[^a-z0-9]/g, '');

/**
 * A block with its untouchable names matched against that roster's players
 * ([{ id, name }]): `untouchable` = matched player ids, `untouchable_unmatched` = names
 * with no single match on the roster (said, never guessed). No block -> null.
 */
export function resolveUntouchables(block, players = []) {
  if (!block || block.empty) return block ?? null;
  const names = block.untouchable_names ?? [];
  const byKey = new Map();
  for (const p of players ?? []) {
    const k = nameKey(p?.name);
    if (!k || p?.id == null) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(String(p.id));
  }
  const ids = [];
  const unmatched = [];
  for (const n of names) {
    const hit = byKey.get(nameKey(n)) ?? [];
    if (hit.length === 1) { if (!ids.includes(hit[0])) ids.push(hit[0]); } else unmatched.push(n);
  }
  return { ...block, untouchable: ids, untouchable_unmatched: unmatched };
}

/** Every untouchable player id across a Map/iterable of nick blocks (the planner's one exclusion set). */
export function untouchableIds(blocks) {
  const out = new Set();
  for (const b of blocks ?? []) for (const id of b?.untouchable ?? []) out.add(String(id));
  return out;
}

/** The block without note text: what may go into a plans file or a page. */
export function publicNick(block) {
  if (!block || block.empty) return null;
  const { notes, warnings, note, fan_of, untouchable_names, untouchable_unmatched, ...rest } = block;
  // untouchable: player ids once resolved against his roster; null = not resolved here (names_n says how many).
  return { ...rest, untouchable: rest.untouchable ?? null, untouchable_names_n: (untouchable_names ?? []).length,
    untouchable_unmatched_n: (untouchable_unmatched ?? []).length,
    notes_n: notes.length + (note ? 1 : 0), warnings_n: warnings.length };
}

const missingRelation = e => /no such table|no such column/.test(String(e?.message));

/**
 * Nick's block per roster from an open chat DB handle, without the rest of
 * people.profile (campaign partners read only this; FIX-02c's nick-block.js folded in,
 * RULINGS 1). ids: Map roster -> { chat_name }. playersByRoster (optional): Map roster ->
 * [{ id, name }] resolves each block's untouchable names to that roster's player ids.
 * Returns { status, reason, byRoster: Map roster -> block, sources: { nick_override, manager_notes } }.
 * An absent table is 'absent' (said, not thrown); any other DB error throws.
 */
export function nickBlocksFrom(chat, ids, { playersByRoster = null } = {}) {
  const sources = { nick_override: 'absent', manager_notes: 'absent' };
  const overrides = new Map();
  try {
    for (const r of chat.prepare('SELECT name, profile_json FROM negotiation_profiles').all()) {
      const { raw } = parseProfileJson(r.profile_json);   // an unparseable row is reported by peopleProfile
      if (raw?.nick_override != null) overrides.set(r.name, raw.nick_override);
    }
    sources.nick_override = 'ok';
  } catch (e) { if (!missingRelation(e)) throw e; }
  const notes = new Map();
  try {
    for (const r of chat.prepare(`SELECT name, note, source, noted_at FROM manager_notes WHERE source LIKE '${NICK_NOTES_PREFIX}%'`).all()) {
      if (!isNickNote(r)) continue;
      if (!notes.has(r.name)) notes.set(r.name, []);
      notes.get(r.name).push(r);
    }
    sources.manager_notes = 'ok';
  } catch (e) { if (!missingRelation(e)) throw e; }
  const byRoster = new Map();
  for (const [rosterId, ident] of ids) {
    let b = nickBlock(overrides.get(ident.chat_name) ?? null, notes.get(ident.chat_name) ?? []);
    if (!b || b.empty) continue;
    const players = playersByRoster?.get(String(rosterId)) ?? playersByRoster?.get(Number(rosterId));
    if (players) b = resolveUntouchables(b, players);
    byRoster.set(String(rosterId), b);
  }
  const ok = sources.nick_override === 'ok' || sources.manager_notes === 'ok';
  return { status: ok ? 'ok' : 'unknown', reason: ok ? null : 'neither negotiation_profiles nor manager_notes is in the chat DB',
    byRoster, sources };
}

// ------------------------------------------------------------ people.profile

export const PEOPLE_PROFILE_FIELD = 'people.profile';
export const READER_VERSION = 'people-profile.1';
export const UNKNOWN = 'unknown';
/**
 * THE quiet threshold: below this many messages read, a profile is too thin to
 * act on and reads `unknown`. One number for every consumer: #254 used 30,
 * #270 used 25; 30 is also where campaign partners' engagement band stops
 * being 'low' (partners.js, msgs >= 30 -> 'medium').
 */
export const QUIET_MESSAGES = 30;

const SELF = 'ME';
const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * One manager's typed entry. `row` is a negotiation_profiles row (or null),
 * `notes` his manager_notes rows.
 *   { name, roster_id, status: 'ok'|'unknown', reason, valid, errors, unparsed,
 *     profile, as_of, messages_read, built_at, model, corpus_hash, nick }
 * `profile` (normalised, enum slots parsed) is null unless status is 'ok'.
 */
export function peopleProfileEntry({ name, rosterId = null, row = null, notes = [], quietBelow = QUIET_MESSAGES }) {
  const parsed = row ? parseProfileJson(row.profile_json) : { raw: null, error: null };
  const read = parsed.raw != null ? readProfile(parsed.raw) : null;
  const errors = parsed.error ? [parsed.error] : read?.errors ?? [];
  const override = read?.profile?.nick_override ?? null;
  const nick = nickBlock(override, notes);
  const messagesRead = num(row?.messages_read) ?? num(read?.profile?.messages_read);
  const valid = !!row && errors.length === 0;
  let reason = null;
  if (!row) reason = 'no chat profile built for this manager';
  else if (!valid) reason = 'stored profile fails schema v2';
  else if (messagesRead == null || messagesRead < quietBelow) {
    reason = `quiet in chat (${messagesRead ?? 0} messages read, under ${quietBelow}): no personal read`;
  }
  return {
    name, roster_id: rosterId == null ? null : String(rosterId),
    status: reason ? UNKNOWN : 'ok', reason, valid, errors, unparsed: read?.unparsed ?? [],
    profile: reason ? null : read.profile,
    as_of: read?.profile?.as_of ?? null, messages_read: messagesRead,
    built_at: row?.built_at ?? null, model: row?.model ?? null, corpus_hash: row?.corpus_hash ?? null,
    nick: nick && !nick.empty ? nick : null,
  };
}

/**
 * people.profile for one league, from rows already read. Pure.
 *   profiles  negotiation_profiles rows { name, profile_json, messages_read, built_at, model, corpus_hash }
 *   notes     manager_notes rows { name, note, source, noted_at } (any source; nickBlock keeps source LIKE 'nick%')
 *   ids       Map roster_id -> { chat_name } (trusted identities)
 *   myTeam    Nick's roster id: his entry is `self`, never a counterparty
 *   playersByRoster  optional Map roster -> [{ id, name }]: resolves each nick block's untouchables
 *   asOf      optional: a profile built after it is not visible (backtests read what existed then)
 * Every trusted non-Nick roster gets an entry, typed unknown when there is no read.
 */
export function peopleProfileFromRows({ leagueId = null, profiles = [], notes = [], ids = new Map(), myTeam = null,
  asOf = null, quietBelow = QUIET_MESSAGES, notesReason = null, playersByRoster = null } = {}) {
  const visible = profiles.filter(r => asOf == null || r.built_at == null || String(r.built_at) <= String(asOf));
  const rowByName = new Map(visible.map(r => [r.name, r]));
  const notesByName = new Map();
  for (const n of notes) {
    if (!notesByName.has(n.name)) notesByName.set(n.name, []);
    notesByName.get(n.name).push(n);
  }
  const byRoster = new Map();
  let self = null;
  const mapped = new Set();
  for (const [rosterId, ident] of ids) {
    const name = ident?.chat_name;
    if (name == null) continue;
    mapped.add(name);
    const entry = peopleProfileEntry({ name, rosterId, row: rowByName.get(name) ?? null,
      notes: notesByName.get(name) ?? [], quietBelow });
    if (name === SELF || (myTeam != null && String(rosterId) === String(myTeam))) {
      self = { ...entry, nick: null, scope: 'how the league chat sees Nick' };
      continue;
    }
    const players = playersByRoster?.get(String(rosterId)) ?? playersByRoster?.get(Number(rosterId));
    if (players && entry.nick) entry.nick = resolveUntouchables(entry.nick, players);
    byRoster.set(String(rosterId), entry);
  }
  if (!self && rowByName.has(SELF)) {
    self = { ...peopleProfileEntry({ name: SELF, rosterId: myTeam, row: rowByName.get(SELF), quietBelow }),
      nick: null, scope: 'how the league chat sees Nick' };
    mapped.add(SELF);
  }
  const entries = [...byRoster.values()];
  return {
    field: PEOPLE_PROFILE_FIELD, source: 'server/services/people/profile-reader.js', version: READER_VERSION,
    league_id: leagueId, as_of: asOf, available: true, reason: null, notes_reason: notesReason,
    quiet_below: quietBelow, byRoster, self,
    unmapped: visible.map(r => r.name).filter(n => !mapped.has(n)),
    counts: { rosters: entries.length, ok: entries.filter(e => e.status === 'ok').length,
      unknown: entries.filter(e => e.status === UNKNOWN).length, invalid: entries.filter(e => e.errors.length).length,
      nick: entries.filter(e => e.nick).length, unreachable: entries.filter(e => e.nick?.unreachable).length },
  };
}

const missingTable = e => /no such table/.test(String(e?.message));
const unavailable = (leagueId, reason) => ({ field: PEOPLE_PROFILE_FIELD, source: 'server/services/people/profile-reader.js',
  version: READER_VERSION, league_id: leagueId, available: false, reason, byRoster: new Map(), self: null, unmapped: [] });

/**
 * people.profile from an open chat DB handle. An absent negotiation_profiles
 * table is `available: false` with a reason; an absent manager_notes table is
 * `notes_reason`; any other DB error throws.
 */
export function peopleProfileFromChat(chat, { leagueId = null, ids = new Map(), myTeam = null, asOf = null,
  quietBelow = QUIET_MESSAGES, playersByRoster = null } = {}) {
  let profiles;
  try {
    profiles = chat.prepare(`SELECT name, profile_json, messages_read, model, built_at, corpus_hash
                             FROM negotiation_profiles ORDER BY name`).all();
  } catch (e) {
    if (missingTable(e)) return unavailable(leagueId, 'no negotiation_profiles table (the profile build has not run)');
    throw e;
  }
  let notes = [];
  let notesReason = null;
  try {
    notes = chat.prepare('SELECT name, note, source, noted_at FROM manager_notes').all();
  } catch (e) {
    if (!missingTable(e)) throw e;
    notesReason = 'no manager_notes table';
  }
  return peopleProfileFromRows({ leagueId, profiles, notes, ids, myTeam, asOf, quietBelow, notesReason, playersByRoster });
}

/**
 * people.profile for one league: opens the private chat DB read-only and the
 * league's trusted identities. Async only because the DB modules load lazily,
 * so importing this file never opens a database.
 */
export async function peopleProfile(leagueId, { asOf = null, quietBelow = QUIET_MESSAGES, playersByRoster = null } = {}) {
  const { identityMap } = await import('../manager-identity.js');
  const { openChatDb } = await import('../manager-signals.js');
  const { rows } = await import('../../db/index.js');
  const ids = identityMap(leagueId);
  if (!ids.size) return unavailable(leagueId, 'no chat corpus for this league (no confirmed chat identities)');
  const chat = openChatDb();
  if (!chat) return unavailable(leagueId, 'chat DB not found');
  const myTeam = rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id ?? null;
  try {
    return peopleProfileFromChat(chat, { leagueId, ids, myTeam, asOf, quietBelow, playersByRoster });
  } finally { chat.close(); }
}
