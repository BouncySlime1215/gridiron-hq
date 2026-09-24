/**
 * The typed per-manager profile read, in the FIX-00 shape (INTEGRATION-AUDIT-0923.md,
 * FIX-00; PEOPLE-WIRING.md, PEOPLE-01).
 *
 * The rebuilt `negotiation_profiles` rows carry new top-level keys and put sentences in
 * their enum slots ("rarely (<player> is the exception)", "often (8 ...)", "moderate"),
 * so main's validator drops every one of them. This reader accepts that shape and
 * reduces it to LABELS:
 *
 *   - every enum slot is parsed by its leading token (yes / usually / rarely; often /
 *     sometimes / once; none / mild / heavy) and anything unparseable is 'unknown';
 *   - no sentence from the profile leaves this file. The raw text is never copied into
 *     the output, only the label it reduced to;
 *   - Nick's ground truth (`profile_json.nick_override` and `manager_notes`) is one
 *     `nick` block per roster and beats any chat-derived read of the same trait;
 *   - a manager the chat barely hears from ("quiet": fewer than QUIET_MESSAGES messages
 *     read, or no profile at all) gets status 'unknown' and no personal traits. His
 *     `nick` block still applies: Nick's word does not depend on chat volume.
 *
 * `normaliseProfile` and the parsers are pure. `readLeagueProfiles` is the one loader:
 * it opens the chat DB read-only and returns Map roster_id -> typed profile. When the
 * FIX-00 reader lands at this path with the validator switched over, this file is it.
 */
import { openChatDb } from '../manager-signals.js';
import { identityMap } from '../manager-identity.js';

export const UNKNOWN = 'unknown';
/** Below this many messages read, a profile is too thin to be a personal read. */
export const QUIET_MESSAGES = 25;

const lower = v => String(v ?? '').trim().toLowerCase();
const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Leading-token parsers: slot -> [[regex on the start of the text, label]...]. */
const LEADING = Object.freeze({
  no_holds: [[/^(yes|holds|firm|final)\b/, 'yes'], [/^(mostly|usually|often)\b/, 'usually'],
    [/^(rarely|no|never|seldom)\b/, 'rarely']],
  how_often: [[/^(often|always|frequently|usually|constantly)\b/, 'often'],
    [/^(sometimes|occasionally|twice|a few)\b/, 'sometimes'], [/^(once|rarely|one time)\b/, 'once']],
  inflation: [[/^(none|no|low|minimal)\b/, 'none'], [/^(mild|moderate|some|slight)\b/, 'mild'],
    [/^(heavy|high|strong|lots|a lot|severe)\b/, 'heavy']],
  urgency: [[/^(high|urgent|very)\b/, 'high'], [/^(medium|moderate|some)\b/, 'medium'], [/^(low|none|no)\b/, 'low']],
  // behaviour_vs_words: does what he says match what he does?
  word_match: [[/^(yes|matches|consistent|follows|mostly yes|reliable|credible)\b/, 'credible'],
    [/^(mixed|partly|sometimes|somewhat)\b/, 'mixed'],
    [/^(no|cheap|talks|rarely|contradicts|all talk|says more|bluff)\b/, 'cheap_talk']],
});

/** Reduce a free-text slot to its label, or 'unknown'. Never returns the text. */
export function leadingToken(slot, text) {
  const rules = LEADING[slot];
  if (!rules) throw new Error(`profile-reader: no parser for slot '${slot}'`);
  if (typeof text === 'boolean') {
    if (slot === 'no_holds') return text ? 'yes' : 'rarely';
    if (slot === 'word_match') return text ? 'credible' : 'cheap_talk';
    return UNKNOWN;
  }
  const t = lower(text).replace(/^["'(]+/, '');
  for (const [re, label] of rules) if (re.test(t)) return label;
  return UNKNOWN;
}

/** Technique names -> a posture label, by keyword. The names themselves are not kept. */
function postureOf(techniques) {
  const names = arr(techniques).map(t => lower(t?.name ?? t)).join(' ');
  if (!names) return UNKNOWN;
  if (/ghost|ignore|silent|no reply|slow/.test(names)) return 'ghoster';
  if (/counter|haggl|anchor|lowball|nickel/.test(names)) return 'haggler';
  if (/quick|fast|decisive/.test(names)) return 'quick';
  return UNKNOWN;
}

/** Free-text approach advice -> one style label. */
function styleOf(text) {
  const t = lower(text);
  if (!t) return UNKNOWN;
  if (/number|value|chart|data|projection/.test(t)) return 'numbers';
  if (/need|hole|depth|injur/.test(t)) return 'need';
  if (/casual|banter|joke|friendly|light/.test(t)) return 'casual';
  if (/direct|straight|just ask|blunt/.test(t)) return 'direct';
  return UNKNOWN;
}

const boolOf = v => (typeof v === 'boolean' ? v : /^(yes|true)$/.test(lower(v)) ? true : /^(no|false)$/.test(lower(v)) ? false : null);
const FAN_OF = /^[A-Za-z .]{2,24}$/;

/**
 * Nick's ground truth for one roster: the profile's `nick_override` object (known keys
 * active, difficulty, contactable, buyer, trades, fan_of, note) plus his `manager_notes`
 * rows. Returns typed fields only; note text is counted, never copied.
 */
export function nickBlock(override, notes = []) {
  const ov = override && typeof override === 'object' ? override : {};
  const trades = lower(ov.trades);
  const buyer = boolOf(ov.buyer) ?? (/^(probably none|none|no)\b/.test(trades) ? false : null);
  const difficulty = lower(ov.difficulty);
  const out = {
    contactable: boolOf(ov.contactable),
    active: boolOf(ov.active),
    buyer,
    hard_to_deal_with: difficulty ? /hard|tough|difficult/.test(difficulty) : null,
    fan_of: typeof ov.fan_of === 'string' && FAN_OF.test(ov.fan_of.trim()) ? ov.fan_of.trim() : null,
    notes_n: arr(notes).length + (typeof ov.note === 'string' && ov.note.trim() ? 1 : 0),
  };
  out.set = Object.entries(out).some(([k, v]) => (k === 'notes_n' ? v > 0 : v != null));
  return out;
}

/** A player a manager said he wants: a name (matched later against rosters) and a date. */
function wantsOf(raw, asOf) {
  const vt = raw?.values_talk ?? {};
  const w = vt.wants ?? {};
  const list = Array.isArray(w) ? w : [...arr(w.players), ...arr(w.positions)];
  return list.map(x => {
    const name = typeof x === 'string' ? x : x?.player ?? x?.name ?? null;
    const at = (x && typeof x === 'object' ? x.at ?? x.since ?? x.last ?? x.as_of : null) ?? asOf ?? null;
    return name ? { name: String(name).slice(0, 60), at } : null;
  }).filter(Boolean);
}

/**
 * One raw profile row -> the typed profile. `raw` may be null (no profile built).
 *   { status: 'ok' | 'unknown', reason?, as_of, messages_read,
 *     traits: { no_holds, inflation, urgency, posture, style, word_match, buyer, hard_to_deal_with },
 *     sources: { <trait>: 'profile' | 'nick_override' | 'unknown' },
 *     wants: [{ name, at }], nick: nickBlock }
 * `wants[].name` is a candidate player name. The caller keeps only names that match a
 * rostered player, so a phrase that is not a player never reaches a page.
 */
export function normaliseProfile(raw, { messagesRead = null, notes = [], quietBelow = QUIET_MESSAGES } = {}) {
  const nick = nickBlock(raw?.nick_override, notes);
  const n = Number.isFinite(messagesRead) ? messagesRead : Number.isFinite(raw?.messages_read) ? raw.messages_read : null;
  const asOf = raw?.as_of ?? null;
  const quiet = raw == null || n == null || n < quietBelow;
  const derived = quiet ? {} : {
    no_holds: leadingToken('no_holds', raw?.says_no?.does_his_no_hold),
    inflation: leadingToken('inflation', raw?.calibration?.inflation),
    urgency: leadingToken('urgency', raw?.deal_feelings?.urgency),
    posture: postureOf(raw?.techniques),
    style: styleOf(raw?.how_to_approach),
    word_match: leadingToken('word_match', raw?.behaviour_vs_words?.verdict ?? raw?.behaviour_vs_words?.summary ?? raw?.behaviour_vs_words),
    buyer: boolOf(raw?.buyer),
    hard_to_deal_with: boolOf(raw?.hard_to_deal_with),
  };
  const traits = {}, sources = {};
  for (const k of ['no_holds', 'inflation', 'urgency', 'posture', 'style', 'word_match', 'buyer', 'hard_to_deal_with']) {
    const fromNick = (k === 'buyer' || k === 'hard_to_deal_with') ? nick[k] : null;
    if (fromNick != null) { traits[k] = fromNick; sources[k] = 'nick_override'; continue; }
    const v = derived[k];
    const known = v != null && v !== UNKNOWN;
    traits[k] = known ? v : UNKNOWN;
    sources[k] = known ? 'profile' : UNKNOWN;
  }
  const out = {
    status: quiet ? UNKNOWN : 'ok',
    as_of: asOf,
    messages_read: n,
    traits, sources,
    wants: quiet ? [] : wantsOf(raw, asOf),
    nick,
  };
  if (quiet) {
    out.reason = raw == null ? 'no chat profile built for this manager'
      : `quiet in chat (${n ?? 0} messages read, under ${quietBelow}): no personal read`;
  }
  return out;
}

const missingTable = e => /no such table/i.test(String(e?.message ?? ''));

/**
 * Every roster's typed profile for one league, from the chat DB. Returns
 *   { available, reason?, byRoster: Map roster_id -> typed profile }
 * available=false means the profiles could not be read at all (no chat DB on this
 * machine, no trusted identities, or no profiles table). That is a different fact from
 * a manager with no profile, which is a typed-unknown entry.
 */
export function readLeagueProfiles(leagueId) {
  const ids = identityMap(leagueId);
  if (!ids.size) return { available: false, reason: 'no confirmed chat identities for this league', byRoster: new Map() };
  const chat = openChatDb();
  if (!chat) return { available: false, reason: 'the chat DB is not on this machine', byRoster: new Map() };
  let stored = [], notes = [];
  try {
    try {
      stored = chat.prepare('SELECT name, profile_json, messages_read FROM negotiation_profiles').all();
    } catch (e) {
      if (!missingTable(e)) throw e;
      return { available: false, reason: 'no negotiation_profiles table (the profile build has not run)', byRoster: new Map() };
    }
    try {
      notes = chat.prepare('SELECT name, noted_at FROM manager_notes').all();
    } catch (e) { if (!missingTable(e)) throw e; }
  } finally { chat.close(); }

  const rawByName = new Map();
  for (const r of stored) {
    let parsed;
    // A row that does not parse is reported as its own reason on that manager, not skipped.
    try { parsed = JSON.parse(r.profile_json); } catch (e) { parsed = { __unparseable: e.message }; }
    rawByName.set(r.name, { raw: parsed, messages_read: r.messages_read });
  }
  const notesByName = new Map();
  for (const n of notes) (notesByName.get(n.name) ?? notesByName.set(n.name, []).get(n.name)).push(n);

  const byRoster = new Map();
  for (const [rosterId, ident] of ids) {
    const hit = rawByName.get(ident.chat_name) ?? null;
    if (hit?.raw?.__unparseable) {
      byRoster.set(String(rosterId), { ...normaliseProfile(null, { notes: notesByName.get(ident.chat_name) }),
        reason: 'his stored profile is not valid JSON, so it is not read' });
      continue;
    }
    byRoster.set(String(rosterId), normaliseProfile(hit?.raw ?? null, {
      messagesRead: hit?.messages_read ?? null, notes: notesByName.get(ident.chat_name) ?? [],
    }));
  }
  return { available: true, byRoster };
}
