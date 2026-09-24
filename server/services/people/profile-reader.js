/**
 * PEOPLE-01: the one typed per-manager profile reader (PEOPLE-WIRING.md,
 * "Target: one reader").
 *
 * Reads, from the private chat DB (GRIDIRON_CHAT_DB_PATH), for one league's
 * trusted chat identities:
 *   negotiation_profiles   the whole-corpus read of each person (profile_json)
 *   manager_chat_profile   volume, tone mix, open-to-trade rate
 *   manager_notes          Nick's own override on a manager (nick_override)
 * and returns one typed entry per roster. Labels and counts leave the chat DB;
 * message text never does (none of these tables holds any).
 *
 * Versioned: every read takes `asOf`. A row built after asOf is not visible,
 * so a backtest reads the profile that existed then. When a table keeps
 * several versions per person, the newest one at or before asOf is used; the
 * older visible ones come back as `history` (the claims follow-through grades).
 *
 * Typed absence: a person with no profile, or one whose profile read fewer than
 * QUIET_MESSAGES messages, is `status: 'unknown'` with a reason, and every
 * field reads UNKNOWN. Unknown is not neutral: consumers must not score it.
 *
 * Unlike counterparty-pricing.js#negotiationProfilesFor, this reader accepts
 * the fields added by the 9/23 rebuild (values_talk, deal_feelings,
 * behaviour_vs_words, changes_since_0918) instead of rejecting the profile
 * as "unexpected key". Unknown extra keys are kept under `extra`, typed as
 * such, never dropped silently.
 */

export const READER_VERSION = 'people-01.1';
export const UNKNOWN = 'unknown';
/** Below this many messages read, a profile is too thin to act on (hand-set; matches chat-labels 'low'). */
export const QUIET_MESSAGES = 30;

const KNOWN_KEYS = new Set(['headline', 'says_no', 'praise_means', 'techniques', 'calibration', 'roster_read',
  'what_moves_him', 'what_shuts_him_down', 'how_to_approach', 'best_bait', 'confidence', 'caveats',
  'values_talk', 'deal_feelings', 'behaviour_vs_words', 'changes_since_0918']);
const VALUES_TALK_KEYS = ['talks_up', 'talks_down', 'untouchable', 'wants', 'shopping'];

const toMs = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(/\dT\d|Z$|[+-]\d\d:?\d\d$/.test(String(v)) ? String(v) : `${String(v).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};
const unknown = reason => ({ status: UNKNOWN, reason });

function columns(chat, table) {
  try { return chat.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } catch (e) {
    if (/no such table/.test(String(e?.message))) return null;
    throw e;
  }
}

/** One player mention: a string or { player|name, at|date|last_at, n|count|mentions }. */
export function normaliseMention(x, fallbackAt = null) {
  if (typeof x === 'string') return x.trim() ? { player: x.trim(), at: fallbackAt, n: 1, dated: false } : null;
  if (!x || typeof x !== 'object') return null;
  const player = String(x.player ?? x.name ?? '').trim();
  if (!player) return null;
  const at = toMs(x.at ?? x.date ?? x.last_at ?? x.last_seen);
  const n = Number(x.n ?? x.count ?? x.mentions);
  return { player, at: at ?? fallbackAt, n: Number.isFinite(n) && n > 0 ? n : 1, dated: at != null };
}

const mentions = (list, at) => (Array.isArray(list) ? list.map(x => normaliseMention(x, at)).filter(Boolean) : []);

/**
 * values_talk -> { talks_up, talks_down, untouchable, wants, shopping } of mentions, or UNKNOWN.
 * roster_read (the 9/18 shape) fills untouchable / shopping when values_talk is absent,
 * so both profile generations answer the same questions.
 */
export function valuesTalk(profile, builtAt) {
  const vt = profile?.values_talk;
  const rr = profile?.roster_read;
  if (!vt && !rr) return unknown('profile has neither values_talk nor roster_read');
  const out = { status: 'ok', source: vt ? 'values_talk' : 'roster_read' };
  for (const k of VALUES_TALK_KEYS) out[k] = mentions(vt?.[k], builtAt);
  if (!vt?.untouchable) out.untouchable = mentions(rr?.really_untouchable, builtAt);
  if (!vt?.shopping) out.shopping = mentions(rr?.quietly_available, builtAt);
  return out;
}

/** manager_notes rows -> the override for one person. Returns { status, exclude, deprioritize, toughen, basis }. */
export function parseOverride(raw) {
  if (raw == null || raw === '') return { status: 'none', exclude: false, deprioritize: false, toughen: false, basis: 'no override' };
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { v = raw; } }
  if (v && typeof v === 'object') {
    const exclude = !!(v.exclude ?? v.never ?? v.do_not_trade);
    const deprioritize = !exclude && !!(v.deprioritize ?? v.deprioritise ?? v.low_priority);
    const toughen = !!(v.toughen ?? v.tough_price ?? v.price === 'tough') || exclude || deprioritize;
    return { status: 'ok', exclude, deprioritize, toughen, basis: 'structured override' };
  }
  const s = String(v).toLowerCase();
  if (/\b(never|exclude|do not trade|don'?t trade|no trades?|avoid)\b/.test(s)) {
    return { status: 'ok', exclude: true, deprioritize: false, toughen: true, basis: 'override text: exclude keyword' };
  }
  // Any other override Nick wrote is a caution flag: rank him later and price him harder.
  return { status: 'ok', exclude: false, deprioritize: true, toughen: true, basis: 'override text present (no exclude keyword)' };
}

/**
 * manager_notes has no schema in this repo (built by the local dossier step). Accept either shape:
 *   a `nick_override` column on a per-person row, or
 *   key/value rows whose kind|type|field|source|key column is 'nick_override' (value in value|note|body|text).
 * The person column is the first of name|chat_name|manager|person present.
 */
function readOverrides(chat, asOf) {
  const cols = columns(chat, 'manager_notes');
  if (!cols) return { status: UNKNOWN, reason: 'no manager_notes table', byName: new Map() };
  const who = ['name', 'chat_name', 'manager', 'person'].find(c => cols.includes(c));
  if (!who) return { status: UNKNOWN, reason: `manager_notes has no person column (${cols.length} columns)`, byName: new Map() };
  const stamp = ['updated_at', 'created_at', 'at'].find(c => cols.includes(c));
  const at = stamp ? `, ${stamp} AS at` : '';
  let found, valueCol;
  if (cols.includes('nick_override')) {
    valueCol = 'nick_override';
    found = chat.prepare(`SELECT ${who} AS who, nick_override AS v${at} FROM manager_notes
                          WHERE nick_override IS NOT NULL AND nick_override != ''`).all();
  } else {
    const kind = ['kind', 'type', 'field', 'source', 'key'].find(c => cols.includes(c));
    valueCol = ['value', 'note', 'body', 'text'].find(c => cols.includes(c));
    if (!kind || !valueCol) return { status: UNKNOWN, reason: 'manager_notes has no nick_override column or kind/value pair', byName: new Map() };
    found = chat.prepare(`SELECT ${who} AS who, ${valueCol} AS v${at} FROM manager_notes WHERE ${kind} = 'nick_override'`).all();
  }
  const byName = new Map();
  for (const r of found) {
    const t = toMs(r.at);
    if (t != null && asOf != null && t > asOf) continue;
    const prev = byName.get(r.who);
    if (!prev || (t ?? 0) >= (prev.at ?? 0)) byName.set(r.who, { raw: r.v, at: t });
  }
  return { status: 'ok', reason: null, shape: valueCol, byName };
}

function readNegotiation(chat, asOf) {
  const cols = columns(chat, 'negotiation_profiles');
  if (!cols) return { status: UNKNOWN, reason: 'no negotiation_profiles table', byName: new Map() };
  const extra = ['source', 'version', 'as_of'].filter(c => cols.includes(c));
  const all = chat.prepare(`SELECT name, profile_json, messages_read, model, built_at${extra.map(c => `, ${c}`).join('')}
                            FROM negotiation_profiles ORDER BY name, built_at`).all();
  const byName = new Map();
  let future = 0;
  for (const r of all) {
    const at = toMs(r.as_of ?? r.built_at);
    if (asOf != null && (at == null || at > asOf)) { future++; continue; }
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push({ ...r, at });
  }
  for (const list of byName.values()) list.sort((a, b) => a.at - b.at);
  return { status: 'ok', reason: future ? `${future} rows built after as_of not visible` : null, byName };
}

function readChatProfile(chat, asOf) {
  const cols = columns(chat, 'manager_chat_profile');
  if (!cols) return { status: UNKNOWN, reason: 'no manager_chat_profile table', byName: new Map() };
  const byName = new Map();
  for (const r of chat.prepare('SELECT * FROM manager_chat_profile').all()) {
    const at = toMs(r.computed_at);
    if (asOf != null && at != null && at > asOf) continue;
    byName.set(r.name, { ...r, at });
  }
  return { status: 'ok', reason: null, byName };
}

const num = v => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);

function typedNegotiation(row) {
  if (!row) return { entry: unknown('no negotiation profile'), history: [] };
  let profile;
  try { profile = JSON.parse(row.profile_json); } catch { return { entry: unknown('profile_json unparseable'), history: [] }; }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return { entry: unknown('profile_json not an object'), history: [] };
  const messages = num(row.messages_read) ?? 0;
  if (messages < QUIET_MESSAGES) return { entry: unknown(`quiet: ${messages} messages read (< ${QUIET_MESSAGES})`), history: [] };
  const extra = Object.fromEntries(Object.entries(profile).filter(([k]) => !KNOWN_KEYS.has(k)));
  const pick = k => (profile[k] == null ? unknown(`${k} absent`) : profile[k]);
  return {
    entry: {
      status: 'ok', built_at: row.at, messages_read: messages, model: row.model ?? null,
      source: row.source ?? (row.model ? 'model-built (source column absent)' : UNKNOWN), profile_version: row.version ?? null,
      confidence: profile.confidence ?? UNKNOWN,
      values_talk: valuesTalk(profile, row.at),
      says_no: pick('says_no'), praise_means: pick('praise_means'), calibration: pick('calibration'),
      deal_feelings: pick('deal_feelings'), behaviour_vs_words: pick('behaviour_vs_words'),
      changes_since: pick('changes_since_0918'),
      what_moves_him: pick('what_moves_him'), what_shuts_him_down: pick('what_shuts_him_down'),
      how_to_approach: pick('how_to_approach'), best_bait: pick('best_bait'), techniques: pick('techniques'),
      extra: Object.keys(extra).length ? { status: 'unread_keys', keys: Object.keys(extra) } : null,
    },
  };
}

function typedChat(row) {
  if (!row) return unknown('no manager_chat_profile row');
  const msgs = num(row.msgs) ?? 0;
  if (msgs < QUIET_MESSAGES) return unknown(`quiet: ${msgs} messages (< ${QUIET_MESSAGES})`);
  return { status: 'ok', msgs, computed_at: row.at ?? null, p_open_to_trade: num(row.p_open_to_trade),
    p_competitive: num(row.p_competitive), p_friendly: num(row.p_friendly), p_defensive: num(row.p_defensive) };
}

/**
 * Pure over handles: chat is an open node:sqlite DatabaseSync (or null), ids a Map roster -> { chat_name }
 * (manager-identity.js#identityMap, trusted rows only), myTeam Nick's roster id (never a counterparty).
 * Returns { status, reason, as_of, version, tables, byRoster: Map roster -> entry }.
 */
export function readProfiles({ chat, ids, asOf = Date.now(), myTeam = null }) {
  const base = { as_of: asOf, version: READER_VERSION, byRoster: new Map(), tables: {} };
  if (!ids?.size) return { ...base, status: UNKNOWN, reason: 'no confirmed chat identities for this league' };
  if (!chat) return { ...base, status: UNKNOWN, reason: 'chat DB not found (GRIDIRON_CHAT_DB_PATH)' };
  const neg = readNegotiation(chat, asOf);
  const cp = readChatProfile(chat, asOf);
  const ov = readOverrides(chat, asOf);
  base.tables = { negotiation_profiles: neg.reason ?? neg.status, manager_chat_profile: cp.reason ?? cp.status,
    manager_notes: ov.reason ?? ov.status };
  for (const [rosterId, ident] of ids) {
    if (myTeam != null && String(rosterId) === String(myTeam)) continue;
    const name = ident.chat_name;
    const versions = neg.byName.get(name) ?? [];
    const { entry } = typedNegotiation(versions.at(-1) ?? null);
    let unparseable = 0;
    const history = versions.map(v => {
      let p = null;
      try { p = JSON.parse(v.profile_json); } catch { unparseable++; return null; }
      const vt = valuesTalk(p, v.at);
      return vt.status === 'ok' ? { built_at: v.at, untouchable: vt.untouchable, shopping: vt.shopping } : null;
    }).filter(Boolean);
    const o = ov.byName.get(name);
    const override = ov.status !== 'ok' ? { ...unknown(ov.reason), exclude: false, deprioritize: false, toughen: false }
      : { ...parseOverride(o?.raw), at: o?.at ?? null };
    const negotiation = entry;
    const chatProfile = typedChat(cp.byName.get(name));
    const status = negotiation.status === 'ok' || chatProfile.status === 'ok' ? 'ok' : UNKNOWN;
    base.byRoster.set(String(rosterId), {
      roster_id: String(rosterId), status,
      reason: status === 'ok' ? null : `${negotiation.reason}; ${chatProfile.reason}`,
      as_of: asOf, version: READER_VERSION,
      negotiation, chat: chatProfile, override, history, history_unparseable: unparseable,
    });
  }
  return { ...base, status: 'ok', reason: null };
}

/** The app entry point: opens the chat DB and the identity map itself. Only this module parses profile_json. */
export async function profilesFor(leagueId, { asOf = Date.now() } = {}) {
  const { identityMap } = await import('../manager-identity.js');
  const { openChatDb } = await import('../manager-signals.js');
  const { rows } = await import('../../db/index.js');
  const ids = identityMap(leagueId);
  const myTeam = rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id ?? null;
  const chat = openChatDb();
  try { return readProfiles({ chat, ids, asOf, myTeam }); } finally { chat?.close(); }
}
