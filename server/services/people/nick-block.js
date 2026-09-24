/**
 * FIX-02c: Nick's own read of each manager, as one per-roster `nick` block.
 *
 * Two sources in the local private chat DB, both written by Nick (not by a model):
 *   negotiation_profiles.profile_json.nick_override   an object per chat name
 *   manager_notes (name, note, source, noted_at)      rows with source NICK_NOTES_SOURCE
 * A note whose text is a JSON object is read as override keys; any other note is
 * kept as a note (never parsed for meaning). nick_override beats a note on the same key.
 *
 * The block is Nick's ground truth: every consumer applies it over any chat-derived
 * read (campaign/partners.js). Keys, all optional:
 *   contactable:false  he cannot be reached: never a step, flip leg or target owner
 *   active:true        in the active trading pool
 *   buyer:false / trades:'probably none'   deprioritised
 *   difficulty:'hard to deal with'         tougher pricing
 *
 * FIX-00 (profile-reader.js) is meant to expose this block; until it lands this
 * file is the reader, and FIX-00 should absorb it rather than add a second one.
 * No chat text is read. Note text stays in memory: `publicNick` drops it.
 */

export const NICK_NOTES_SOURCE = 'nick-chat-2026-09-23';
export const OVERRIDE_KEYS = Object.freeze(['contactable', 'active', 'difficulty', 'buyer', 'trades', 'fan_of', 'note']);

const bool = v => (v === true || v === false ? v : v === 1 || v === 0 ? v === 1
  : typeof v === 'string' && /^(true|false)$/i.test(v.trim()) ? /^true$/i.test(v.trim()) : null);
const text = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 'probably none', 'none', 'no' -> this manager does not expect to trade. */
export function tradesNone(trades) {
  return typeof trades === 'string' && /\b(none|no|never)\b/i.test(trades);
}

/**
 * One manager's block from his override object and his notes.
 * override: object or null. notes: [{ note, noted_at }]. Returns null when there is nothing.
 */
export function nickBlock(override = null, notes = []) {
  const keys = {};
  const kept = [];
  const warnings = [];
  const take = (obj, from) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!OVERRIDE_KEYS.includes(k)) { warnings.push(`${from}.${k}: unexpected key, ignored`); continue; }
      keys[k] = { v, from };
    }
  };
  for (const n of notes ?? []) {
    const raw = text(n?.note);
    if (!raw) continue;
    let parsed = null;
    if (raw.startsWith('{')) {
      try { parsed = JSON.parse(raw); } catch { warnings.push('manager_notes: a note starting with { is not JSON; kept as text'); }
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) take(parsed, 'manager_notes');
    else kept.push({ text: raw, at: n?.noted_at ?? null });
  }
  if (override != null) {
    if (typeof override === 'object' && !Array.isArray(override)) take(override, 'nick_override');
    else warnings.push('nick_override: expected an object, ignored');
  }
  if (!Object.keys(keys).length && !kept.length) return warnings.length ? { empty: true, warnings } : null;

  const val = k => keys[k]?.v;
  const contactable = bool(val('contactable'));
  const active = bool(val('active'));
  const buyer = bool(val('buyer'));
  const difficulty = text(val('difficulty'));
  const trades = text(val('trades'));
  const unreachable = contactable === false;
  const hard = !!difficulty && /\bhard\b|\bdifficult\b|\btough\b/i.test(difficulty);
  const deprioritised = !unreachable && (buyer === false || tradesNone(trades));
  return {
    contactable, active, buyer, difficulty, trades,
    fan_of: val('fan_of') ?? null, note: text(val('note')),
    unreachable, deprioritised, hard,
    // The pool is who Nick says trades; an unreachable or deprioritised manager is never in it.
    in_active_pool: active === true && !unreachable && !deprioritised,
    sources: Object.fromEntries(Object.entries(keys).map(([k, x]) => [k, x.from])),
    notes: kept, warnings,
  };
}

/** The block without note text: what may go into the plans file. */
export function publicNick(block) {
  if (!block || block.empty) return null;
  const { notes, warnings, note, fan_of, ...rest } = block;
  return { ...rest, notes_n: notes.length + (note ? 1 : 0), warnings_n: warnings.length };
}

const missingTable = e => /no such table|no such column/.test(String(e?.message));

/**
 * Per-roster blocks for one league. chat: an open chat DB handle. ids: Map roster -> { chat_name }.
 * Returns { status, reason, byRoster: Map roster -> block, sources: { nick_override, manager_notes } }.
 * An absent table is 'absent' (said, not thrown); any other DB error throws.
 */
export function nickBlocksFrom(chat, ids) {
  const sources = { nick_override: 'absent', manager_notes: 'absent' };
  const overrides = new Map();
  try {
    for (const r of chat.prepare('SELECT name, profile_json FROM negotiation_profiles').all()) {
      let p;
      try { p = JSON.parse(r.profile_json); } catch { continue; }   // negotiation_profiles' own reader reports it
      if (p && p.nick_override != null) overrides.set(r.name, p.nick_override);
    }
    sources.nick_override = 'ok';
  } catch (e) { if (!missingTable(e)) throw e; }
  const notes = new Map();
  try {
    for (const r of chat.prepare('SELECT name, note, noted_at FROM manager_notes WHERE source = ?').all(NICK_NOTES_SOURCE)) {
      if (!notes.has(r.name)) notes.set(r.name, []);
      notes.get(r.name).push(r);
    }
    sources.manager_notes = 'ok';
  } catch (e) { if (!missingTable(e)) throw e; }
  const byRoster = new Map();
  for (const [rosterId, ident] of ids) {
    const b = nickBlock(overrides.get(ident.chat_name) ?? null, notes.get(ident.chat_name) ?? []);
    if (b && !b.empty) byRoster.set(String(rosterId), b);
  }
  const ok = sources.nick_override === 'ok' || sources.manager_notes === 'ok';
  return { status: ok ? 'ok' : 'unknown', reason: ok ? null : 'neither negotiation_profiles nor manager_notes is in the chat DB',
    byRoster, sources };
}
