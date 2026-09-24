/**
 * THE ONE READER of the chat psychology (PEOPLE-01).
 *
 * Before this file, three services each read the private chat DB's people
 * tables their own way: counterparty-pricing parsed `negotiation_profiles`,
 * manager-signals read `manager_chat_profile` and `manager_player_sentiment`,
 * and coach/people/variables read `manager_chat_profile` again. Every table
 * below is now read HERE and nowhere else in server/ or scripts/ outside the
 * allowlist in test/people-profile-reader-ratchet.test.js:
 *
 *   negotiation_profiles       the model's read of each person (profile_json)
 *   manager_chat_profile       the extractor's per-person chat aggregates
 *   manager_player_sentiment   per person, per player chat sentiment
 *   manager_notes              Nick's own reads (schema not pinned; see below)
 *   entity_map                 chat alias -> canonical chat name
 *
 * and roster ids come from `league_member_identity` through identityMap(), so
 * a person is attached to a roster only on a trusted identity.
 *
 * TWO LAYERS.
 *   - Handle-level reads (`chatStyleRow`, `negotiationProfileRows`, ...) take
 *     an open chat handle and return rows as stored. The existing consumers
 *     call these, so what they serve is unchanged.
 *   - `readPeopleProfiles(leagueId)` returns the typed per-roster profile the
 *     north-star pieces read: every key, the new keys, as_of, messages_read,
 *     version, source, and TYPED ABSENCE — a person with a thin chat or no
 *     profile row is `unknown`, never a neutral default.
 *
 * PRECEDENCE. nick_override beats manager_notes beats the model read. A model
 * read is evidence; Nick's word on a field is a decision.
 *
 * NO MESSAGE TEXT is read here. Profiles are labels the builder already wrote.
 */
import { db, rows } from '../../db/index.js';
import { identityMap } from '../manager-identity.js';
import { openChatDb } from '../manager-signals.js';

/** Bumped whenever the typed profile's shape changes. */
export const PROFILE_READER_VERSION = 1;

/**
 * Under this many messages read, the model's profile of a person is reported
 * `unknown`. The 9/18 build read 39-399 messages per person; 30 keeps every
 * one of those and refuses a read built on a handful of lines.
 */
export const THIN_CHAT_MESSAGES = 30;

/** Keys the 9/23 rebuild adds beside the original schema. */
export const EXTENSION_KEYS = Object.freeze(['deal_feelings', 'values_talk', 'behaviour_vs_words',
  'changes_since_0918']);
const OVERRIDE_KEY = 'nick_override';

/** Typed absence. A field holding this is not known; it is never zero or neutral. */
export const unknown = reason => Object.freeze({ state: 'unknown', reason });
export const isUnknown = v => v != null && typeof v === 'object' && v.state === 'unknown';

/* ------------------------------------------------------------ the schema */

const strings = { type: 'array', items: { type: 'string' } };
// The input schema scripts/build-negotiation-profiles.mjs forces the model to
// call. Moved here from counterparty-pricing.js unchanged: the one reader is
// the one validator.
const NEGOTIATION_PROFILE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    headline: { type: 'string' },
    says_no: { type: 'object', properties: {
      how: { type: 'string' }, hard_no_looks_like: strings, soft_no_looks_like: strings,
      does_his_no_hold: { type: 'string', enum: ['yes', 'usually', 'rarely', 'unknown'] }, evidence: strings,
    }, required: ['how', 'does_his_no_hold', 'evidence'] },
    praise_means: { type: 'object', properties: {
      reading: { type: 'string', enum: ['belief', 'marketing', 'habit', 'mixed', 'unknown'] },
      why: { type: 'string' }, hypes_before_selling: { type: 'boolean' }, agrees_with_numbers: { type: 'string' },
      evidence: strings,
    }, required: ['reading', 'why', 'evidence'] },
    techniques: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, how_he_does_it: { type: 'string' }, evidence: strings,
      how_often: { type: 'string', enum: ['often', 'sometimes', 'once'] },
    }, required: ['name', 'how_he_does_it', 'how_often'] } },
    calibration: { type: 'object', properties: {
      enthusiasm_scale: { type: 'string' }, baseline_tone: { type: 'string' },
      inflation: { type: 'string', enum: ['none', 'mild', 'heavy', 'unknown'] },
    }, required: ['enthusiasm_scale', 'inflation'] },
    roster_read: { type: 'object', properties: {
      really_untouchable: strings, quietly_available: strings, overvalues: strings, undervalues: strings,
      reasoning: { type: 'string' },
    } },
    what_moves_him: strings,
    what_shuts_him_down: strings,
    how_to_approach: { type: 'string' },
    best_bait: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    caveats: strings,
  },
  required: ['headline', 'says_no', 'praise_means', 'techniques', 'calibration',
    'what_moves_him', 'how_to_approach', 'confidence', 'caveats'],
});
const CORE_KEYS = Object.freeze(Object.keys(NEGOTIATION_PROFILE_SCHEMA.properties));

/**
 * Every violation of the schema, recursively: type, enum, required keys,
 * unexpected keys, and tool-call markup leaked into a string — the failure
 * that left six of nine profiles unusable on 2026-09-18 while still parsing.
 */
function schemaErrors(schema, value, where = 'profile') {
  if (value == null) return [];
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return [`${where}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`];
      }
      const errs = [];
      for (const k of schema.required ?? []) if (value[k] == null) errs.push(`${where}.${k}: missing`);
      const known = schema.properties ?? {};
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
      if (/<\/?parameter\b/.test(value)) return [`${where}: leaked tool-call markup`];
      if (schema.enum && !schema.enum.includes(value)) return [`${where}: "${value}" not in ${schema.enum.join('/')}`];
      return [];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${where}: expected boolean, got ${typeof value}`];
    default:
      return [];
  }
}

const leaked = v => typeof v === 'string' ? /<\/?parameter\b/.test(v)
  : Array.isArray(v) ? v.some(leaked)
    : v != null && typeof v === 'object' ? Object.values(v).some(leaked) : false;

/** Split a stored profile into the original schema's keys, the new keys, and Nick's override. */
function splitProfile(profile) {
  const core = {};
  const extensions = {};
  let override = null;
  for (const [k, v] of Object.entries(profile)) {
    if (EXTENSION_KEYS.includes(k)) extensions[k] = v;
    else if (k === OVERRIDE_KEY) override = v;
    else core[k] = v;
  }
  return { core, extensions, override };
}

/**
 * Errors in the original-schema part of a profile. The new keys and
 * nick_override are checked by `readProfile`, and a bad one costs only that
 * key, never the whole profile.
 */
export function negotiationProfileErrors(profile) {
  if (profile == null || typeof profile !== 'object') return ['profile: expected object'];
  if (Array.isArray(profile)) return schemaErrors(NEGOTIATION_PROFILE_SCHEMA, profile);
  return schemaErrors(NEGOTIATION_PROFILE_SCHEMA, splitProfile(profile).core);
}

/* ------------------------------------------------- handle-level table reads */

const tableIn = (handle, table) =>
  !!handle.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);

/**
 * One person's `manager_chat_profile` row, or null. A missing table throws
 * (`missing: 'throw'`, the default) — manager-signals reports that as the
 * league's error — or reads as null with `missing: 'null'`.
 */
export function chatStyleRow(chat, name, { missing = 'throw' } = {}) {
  if (missing === 'null' && !tableIn(chat, 'manager_chat_profile')) return null;
  return chat.prepare('SELECT * FROM manager_chat_profile WHERE name = ?').get(name) ?? null;
}

/** Every named person the rollup has profiled, in name order. Throws on a missing table. */
export function chatStyleNames(chat) {
  return chat.prepare('SELECT name FROM manager_chat_profile WHERE name IS NOT NULL ORDER BY name').all()
    .map(r => r.name);
}

/** Row count and both stamps of the rollup. `as_of` is the newest message; `computed_at` the rollup run. */
export function chatStyleStamp(chat) {
  return chat.prepare(`SELECT COUNT(*) AS n, MAX(last_msg) AS as_of, MAX(computed_at) AS computed_at
                       FROM manager_chat_profile`).get();
}

/** One person's per-player chat sentiment. Throws on a missing table. */
export function playerSentimentRows(chat, name) {
  return chat.prepare(`SELECT player, sentiment_mean, n, last_mention
                       FROM manager_player_sentiment WHERE name = ?`).all(name);
}

/** Every stored negotiation profile, raw. Throws `no such table` when the builder has not run. */
export function negotiationProfileRows(chat) {
  return chat.prepare(`SELECT name, profile_json, messages_read, model, built_at, corpus_hash
                       FROM negotiation_profiles ORDER BY name`).all();
}

/** Count and newest build stamp, for cache keys: `n:m`, or 'absent'. */
export function negotiationProfilesStamp(chat) {
  try {
    const r = chat.prepare('SELECT COUNT(*) AS n, MAX(built_at) AS m FROM negotiation_profiles').get();
    return `${r.n}:${r.m ?? ''}`;
  } catch (e) {
    if (/no such table/.test(String(e?.message))) return 'absent';
    throw e;
  }
}

/* ------------------------------------- Nick's notes and the alias map */

// Neither table has a schema in any migration or script on main: both were
// written by hand on Nick's machine on 2026-09-17. So the columns are found,
// not assumed, from these candidates; a table with none of them is reported
// as unrecognised (its column NAMES, never its content) instead of guessed at.
const NOTE_COLUMNS = { name: ['chat_name', 'name', 'manager', 'person'], roster: ['roster_id'],
  text: ['note', 'text', 'body', 'read'], field: ['field', 'key'], league: ['league_id'],
  at: ['updated_at', 'written_at', 'created_at', 'at'] };
const ALIAS_COLUMNS = { alias: ['alias', 'from_name', 'name'], canonical: ['canonical', 'canonical_name',
  'maps_to', 'to_name', 'person'], in_league: ['in_league'] };

function locate(chat, table) {
  if (chat && tableIn(chat, table)) return { handle: chat, where: 'chat' };
  if (tableIn(db, table)) return { handle: db, where: 'app' };
  return null;
}

function readByColumns(chat, table, wanted, need) {
  const at = locate(chat, table);
  if (!at) return { state: 'absent', rows: [] };
  const cols = at.handle.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r => r.name);
  const pick = Object.fromEntries(Object.entries(wanted).map(([k, cands]) => [k, cands.find(c => cols.includes(c))]));
  if (!need.every(group => group.some(k => pick[k]))) {
    return { state: 'unrecognised', rows: [], reason: `${table} has columns ${cols.join(', ')}; none matched` };
  }
  // Identifiers come from the fixed candidate lists above, never from input.
  const select = Object.entries(pick).filter(([, c]) => c).map(([k, c]) => `"${c}" AS ${k}`).join(', ');
  return { state: 'present', where: at.where, rows: at.handle.prepare(`SELECT ${select} FROM ${table}`).all() };
}

/** Nick's own reads. `{ state, rows: [{ name?, roster?, text, field?, league?, at? }] }`. */
export function managerNotesRows(chat) {
  return readByColumns(chat, 'manager_notes', NOTE_COLUMNS, [['name', 'roster'], ['text']]);
}

/** Alias -> canonical chat name. `{ state, rows: [{ alias, canonical, in_league? }] }`. */
export function entityMapRows(chat) {
  return readByColumns(chat, 'entity_map', ALIAS_COLUMNS, [['alias'], ['canonical']]);
}

/* ------------------------------------------------ profiles, per roster */

function sourceOf(model) {
  if (!model) return null;
  return /claude-code|local/i.test(model) ? 'claude-code-local' : 'api';
}

/** Parse one stored row: validated core, the new keys, and Nick's override applied. */
function readProfile(r, notes) {
  let parsed;
  try { parsed = JSON.parse(r.profile_json); } catch { return { errors: ['unparseable JSON'] }; }
  const errors = negotiationProfileErrors(parsed);
  if (errors.length) return { errors };
  const { core, extensions, override } = splitProfile(parsed);
  const warnings = [];
  const sources = Object.fromEntries(Object.keys(core).map(k => [k, 'model']));
  const ext = {};
  for (const k of EXTENSION_KEYS) {
    const v = extensions[k];
    if (v == null) { ext[k] = unknown(`the stored profile has no ${k}`); continue; }
    if (leaked(v)) { ext[k] = unknown(`${k} carries leaked tool-call markup`); warnings.push(`${k}: leaked markup`); continue; }
    ext[k] = v;
    sources[k] = 'model';
  }
  // manager_notes: a note that names a text field replaces the model's text.
  for (const n of notes) {
    if (!n.field) continue;
    if (CORE_KEYS.includes(n.field)) {
      const spec = NEGOTIATION_PROFILE_SCHEMA.properties[n.field];
      if (spec.type === 'string' && !spec.enum) core[n.field] = n.text;
      else if (spec.type === 'array' && spec.items?.type === 'string') core[n.field] = [n.text];
      else { warnings.push(`manager_notes: ${n.field} is structured; the note is attached, not merged`); continue; }
      sources[n.field] = 'manager_notes';
    } else if (EXTENSION_KEYS.includes(n.field)) {
      ext[n.field] = n.text;
      sources[n.field] = 'manager_notes';
    }
  }
  // nick_override: whole-key replacement, checked against the schema key by key.
  if (override != null) {
    if (typeof override !== 'object' || Array.isArray(override)) warnings.push('nick_override: expected object');
    else {
      for (const [k, v] of Object.entries(override)) {
        if (CORE_KEYS.includes(k)) {
          const errs = schemaErrors(NEGOTIATION_PROFILE_SCHEMA.properties[k], v, `nick_override.${k}`);
          if (errs.length) { warnings.push(...errs); continue; }
          core[k] = v;
        } else if (EXTENSION_KEYS.includes(k)) {
          if (leaked(v)) { warnings.push(`nick_override.${k}: leaked tool-call markup`); continue; }
          ext[k] = v;
        } else { warnings.push(`nick_override.${k}: unexpected key`); continue; }
        sources[k] = 'nick_override';
      }
    }
  }
  return { errors: [], core, ext, override: override ?? null, sources, warnings };
}

/**
 * Notes and aliases, and the roster-id resolver built from identityMap plus
 * entity_map. Shared by both readers below.
 */
function context(leagueId, chat) {
  const ids = identityMap(leagueId);
  const rosterByName = new Map([...ids.values()].map(i => [i.chat_name, String(i.roster_id)]));
  const aliases = entityMapRows(chat);
  const canonical = new Map(aliases.rows.filter(a => (a.in_league == null || Number(a.in_league) !== 0) && a.alias && a.canonical)
    .map(a => [a.alias, a.canonical]));
  const rosterOf = name => rosterByName.get(name) ?? rosterByName.get(canonical.get(name)) ?? null;
  const notes = managerNotesRows(chat);
  const notesFor = (name, rosterId) => notes.rows.filter(n =>
    (n.league == null || Number(n.league) === Number(leagueId))
    && ((n.roster != null && String(n.roster) === String(rosterId))
      || (n.name != null && (n.name === name || canonical.get(n.name) === name
        || (rosterId != null && rosterOf(n.name) === String(rosterId))))));
  return { ids, rosterByName, rosterOf, notes, notesFor, aliases };
}

/**
 * The negotiation profiles of one league, in the shape counterparty-pricing
 * has always served:
 *   byRoster  roster_id -> { name, profile, built_at, messages_read, model, corpus_hash, roster_id }
 *   self      'ME', never a counterparty
 *   invalid   [{ name, errors }]
 *   unmapped  valid profiles with no trusted identity in this league
 * `profile` is the original schema's keys with Nick's notes and override applied.
 * A league with no trusted chat identity is available=false.
 */
export function negotiationProfileEntries(leagueId, { chat: given } = {}) {
  const result = (available, reason = null) => ({
    league_id: leagueId, available, reason, byRoster: new Map(), self: null, invalid: [], unmapped: [],
  });
  if (!identityMap(leagueId).size) return result(false, 'no chat corpus for this league (no confirmed chat identities)');
  const chat = given ?? openChatDb();
  if (!chat) return result(false, 'chat DB not found');
  let stored;
  let ctx;
  try {
    try { stored = negotiationProfileRows(chat); } catch (e) {
      if (/no such table/.test(String(e?.message))) {
        return result(false, 'no negotiation_profiles table (scripts/build-negotiation-profiles.mjs has not run)');
      }
      throw e;
    }
    ctx = context(leagueId, chat);
  } finally { if (!given) chat.close(); }

  const out = result(true);
  const myTeam = rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id ?? null;
  out.read = new Map();
  for (const r of stored) {
    const rosterId = r.name === 'ME'
      ? (ctx.rosterByName.get('ME') ?? (myTeam == null ? null : String(myTeam)))
      : ctx.rosterOf(r.name);
    const read = readProfile(r, ctx.notesFor(r.name, rosterId));
    if (read.errors.length) { out.invalid.push({ name: r.name, errors: read.errors }); continue; }
    const entry = { name: r.name, profile: read.core, built_at: r.built_at, messages_read: r.messages_read,
      model: r.model, corpus_hash: r.corpus_hash };
    if (r.name === 'ME') {
      out.self = { ...entry, roster_id: rosterId, scope: 'how the league chat sees Nick' };
      out.read.set('ME', read);
      continue;
    }
    if (rosterId == null || String(rosterId) === String(myTeam)) { out.unmapped.push(r.name); continue; }
    out.byRoster.set(String(rosterId), { ...entry, roster_id: String(rosterId) });
    out.read.set(String(rosterId), read);
  }
  // Not part of the served shape: the typed reader below uses it.
  Object.defineProperty(out, 'read', { enumerable: false });
  return out;
}

/**
 * THE TYPED PROFILE, one per trusted roster in the league.
 *
 * {
 *   league_id, available, reason, version, as_of (newest built_at),
 *   sources: { negotiation_profiles, manager_chat_profile, manager_player_sentiment, manager_notes, entity_map },
 *   profiles: Map roster_id -> {
 *     roster_id, chat_name, status: 'known' | 'unknown', reason,
 *     as_of, messages_read, version, row_version, source, model,
 *     fields: { <every original key>, deal_feelings, values_talk, behaviour_vs_words, changes_since_0918 },
 *     field_sources: { key: 'model' | 'manager_notes' | 'nick_override' },
 *     nick_override, nick_notes: [{ text, field, at }],
 *     chat_style (manager_chat_profile row | unknown), sentiment ([...] | unknown), warnings
 *   },
 *   self: the same shape for 'ME', or null,
 *   invalid, unmapped
 * }
 *
 * A roster whose person has no profile row, a profile that failed validation,
 * or fewer than THIN_CHAT_MESSAGES messages read is `status: 'unknown'` and
 * every field is `unknown(reason)`.
 */
export function readPeopleProfiles(leagueId, { chat: given } = {}) {
  const base = { league_id: leagueId, version: PROFILE_READER_VERSION, as_of: null, profiles: new Map(), self: null,
    invalid: [], unmapped: [], sources: {} };
  if (!identityMap(leagueId).size) {
    return { ...base, available: false, reason: 'no chat corpus for this league (no confirmed chat identities)' };
  }
  const chat = given ?? openChatDb();
  if (!chat) return { ...base, available: false, reason: 'chat DB not found' };
  try {
    const entries = negotiationProfileEntries(leagueId, { chat });
    const ctx = context(leagueId, chat);
    const hasStyle = tableIn(chat, 'manager_chat_profile');
    const hasSentiment = tableIn(chat, 'manager_player_sentiment');
    const out = { ...base, available: true, reason: entries.available ? null : entries.reason,
      invalid: entries.invalid, unmapped: entries.unmapped,
      sources: {
        negotiation_profiles: entries.available ? 'present' : 'absent',
        manager_chat_profile: hasStyle ? 'present' : 'absent',
        manager_player_sentiment: hasSentiment ? 'present' : 'absent',
        manager_notes: ctx.notes.state, entity_map: ctx.aliases.state,
      } };
    const invalidByName = new Map(entries.invalid.map(i => [i.name, i.errors]));
    const stamps = [];
    const build = (rosterId, chatName, entry, read) => {
      const style = hasStyle ? chatStyleRow(chat, chatName) : null;
      const sentiment = hasSentiment ? playerSentimentRows(chat, chatName) : null;
      const notes = ctx.notesFor(chatName, rosterId).map(n => ({ text: n.text, field: n.field ?? null, at: n.at ?? null }));
      let reason = null;
      if (!entry) {
        reason = invalidByName.has(chatName)
          ? `the stored profile failed validation (${invalidByName.get(chatName).length} errors)`
          : entries.available ? 'no negotiation profile has been built for this person' : entries.reason;
      } else if (!(entry.messages_read >= THIN_CHAT_MESSAGES)) {
        reason = `thin chat: the profile read ${entry.messages_read ?? 0} messages, under ${THIN_CHAT_MESSAGES}`;
      }
      if (entry?.built_at) stamps.push(entry.built_at);
      const known = reason == null;
      const keys = [...CORE_KEYS, ...EXTENSION_KEYS];
      const fields = Object.fromEntries(keys.map(k => [k, !known ? unknown(reason)
        : (k in read.core ? read.core[k] : read.ext[k] ?? unknown(`the stored profile has no ${k}`))]));
      return {
        roster_id: rosterId, chat_name: chatName, status: known ? 'known' : 'unknown', reason,
        as_of: entry?.built_at ?? null, messages_read: entry?.messages_read ?? null,
        version: PROFILE_READER_VERSION, row_version: entry?.corpus_hash ?? null,
        source: sourceOf(entry?.model), model: entry?.model ?? null,
        fields, field_sources: known ? read.sources : {},
        nick_override: read?.override ?? null, nick_notes: notes,
        chat_style: style ?? unknown(hasStyle ? 'the chat rollup has no row for this person'
          : 'manager_chat_profile is not in the chat DB'),
        sentiment: sentiment ?? unknown('manager_player_sentiment is not in the chat DB'),
        warnings: read?.warnings ?? [],
      };
    };
    const myTeam = rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id ?? null;
    for (const ident of ctx.ids.values()) {
      const rosterId = String(ident.roster_id);
      if (ident.chat_name === 'ME' || rosterId === String(myTeam)) continue;
      out.profiles.set(rosterId, build(rosterId, ident.chat_name, entries.byRoster.get(rosterId),
        entries.read?.get(rosterId)));
    }
    if (entries.self) out.self = build(entries.self.roster_id, 'ME', entries.self, entries.read.get('ME'));
    out.as_of = stamps.length ? stamps.sort().at(-1) : null;
    return out;
  } finally { if (!given) chat.close(); }
}
