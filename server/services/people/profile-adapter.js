/**
 * CAMPAIGN-PEOPLE: thin profile adapter (pure), standing in for PEOPLE-01.
 *
 * PEOPLE-WIRING.md names `server/services/people/profile-reader.js` (PEOPLE-01)
 * as the one producer of a typed per-manager profile. That unit has not landed
 * (no `claude/cloud-people-01*` branch on 2026-09-24), so the campaign reads
 * profiles through this adapter, which exposes the interface PEOPLE-01 is
 * expected to keep:
 *
 *   readProfile(raw, { nameToId, asOf })        -> typed profile (below)
 *   readLeagueProfiles(rawByTeam, { nameToId }) -> Map team -> typed profile
 *
 * When PEOPLE-01 lands, `counterpart.js` switches its one import and this file
 * goes. Nothing else parses profile_json.
 *
 * Rules (PEOPLE-WIRING "Rules"):
 *   - labels only: free text is reduced to enums / short labels; no chat quotes
 *     leave this function.
 *   - typed absence: a field nobody knows is 'unknown' / null, never neutral.
 *   - versioned: as_of + version travel with the profile so a replan can tell a
 *     changed profile from an unchanged one.
 *   - Nick's ground truth wins: `nick_override` replaces the profile's value for
 *     every key it sets, and `sources[key]` says which one was used.
 */

export const UNKNOWN = 'unknown';
const LEVELS = ['high', 'medium', 'low'];
const POSTURES = ['ghoster', 'haggler', 'quick'];
const STYLES = ['numbers', 'need', 'casual', 'direct'];

const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
const enumOf = (v, allowed) => (allowed.includes(String(v ?? '').toLowerCase()) ? String(v).toLowerCase() : UNKNOWN);
const boolOf = v => (typeof v === 'boolean' ? v : v === 'yes' ? true : v === 'no' ? false : null);

/** Free-text approach -> one style label (keyword read; an override sets it directly). */
export function approachStyle(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return UNKNOWN;
  if (/number|value|chart|data|projection/.test(t)) return 'numbers';
  if (/need|hole|depth|injur/.test(t)) return 'need';
  if (/casual|banter|joke|friendly|light/.test(t)) return 'casual';
  if (/direct|straight|just ask|blunt/.test(t)) return 'direct';
  return UNKNOWN;
}

/** Free-text "what shuts him down" -> labels. */
export function shutdownLabel(text) {
  const t = String(text ?? '').toLowerCase();
  if (/lowball|insult|rip ?off|fleece/.test(t)) return 'lowball';
  if (/public|group|chat|embarrass|called out|brag/.test(t)) return 'public_pressure';
  if (/pressure|rush|deadline|ultimatum/.test(t)) return 'pressure';
  if (/spam|repeat|nag|again and again|follow.?up/.test(t)) return 'nagging';
  return 'other';
}

function postureFrom(raw) {
  const names = arr(raw?.techniques).map(t => String(t?.name ?? t).toLowerCase()).join(' ');
  if (/ghost|ignore|silent|no reply/.test(names)) return 'ghoster';
  if (/counter|haggl|anchor|nickel/.test(names)) return 'haggler';
  return UNKNOWN;
}

/**
 * One raw profile -> typed profile. raw: the stored negotiation profile JSON plus the
 * PEOPLE fields (values_talk, deal_feelings, changes_since_0918, contactable, buyer,
 * hard_to_deal_with, posture, urgency_windows, attached, just_won_trade) and
 * `nick_override` (any of the typed keys, already in typed form). null -> unknown profile.
 */
export function readProfile(raw, { nameToId = null, asOf = null } = {}) {
  const ov = raw?.nick_override && typeof raw.nick_override === 'object' ? raw.nick_override : {};
  const idOf = x => {
    if (x == null) return null;
    if (typeof x === 'number') return String(x);
    const hit = nameToId ? nameToId(String(x)) : null;
    return hit != null ? String(hit) : String(x);
  };
  const ids = v => [...new Set(arr(v).map(idOf).filter(x => x != null))];
  const vt = raw?.values_talk ?? {};
  const df = raw?.deal_feelings ?? {};
  const wants = vt.wants ?? {};
  const POS = /^(QB|RB|WR|TE|K|D\/ST|DST)$/i;
  const wantList = arr(Array.isArray(wants) ? wants : [...arr(wants.players), ...arr(wants.positions)]);
  const bait = arr(raw?.best_bait_players ?? []);

  const fromProfile = {
    urgency: enumOf(df.urgency, LEVELS),
    face: enumOf(df.face, LEVELS),
    frustrated_with: ids(df.frustrated_with),
    talks_up: ids(vt.talks_up),
    talks_down: ids(vt.talks_down),
    untouchable: ids([...arr(vt.untouchable), ...arr(raw?.roster_read?.really_untouchable)]),
    wants_players: ids(wantList.filter(w => !POS.test(String(w)))),
    wants_positions: [...new Set(wantList.filter(w => POS.test(String(w))).map(w => String(w).toUpperCase()))],
    bait_players: ids(bait),
    approach_style: approachStyle(raw?.how_to_approach),
    techniques: arr(raw?.techniques).map(t => String(t?.name ?? t).slice(0, 40)).filter(Boolean),
    no_holds: enumOf(raw?.says_no?.does_his_no_hold, ['yes', 'usually', 'rarely']),
    shuts_down: [...new Set(arr(raw?.what_shuts_him_down).map(shutdownLabel))],
    posture: raw?.posture != null ? enumOf(raw.posture, POSTURES) : postureFrom(raw),
    contactable: boolOf(raw?.contactable),
    buyer: boolOf(raw?.buyer),
    hard_to_deal_with: boolOf(raw?.hard_to_deal_with),
    attached: boolOf(df.attached ?? raw?.attached),
    just_won_trade: boolOf(df.just_won_trade ?? raw?.just_won_trade),
    urgency_windows: arr(df.urgency_windows ?? raw?.urgency_windows)
      .filter(w => w && Number.isFinite(Date.parse(w.from)) && Number.isFinite(Date.parse(w.to)))
      .map(w => ({ from: w.from, to: w.to, why: String(w.why ?? 'urgency window').slice(0, 60) })),
    changes_since: arr(raw?.changes_since_0918 ?? raw?.changes_since).map(c => String(c?.field ?? c).slice(0, 40)),
  };

  const out = {}, sources = {};
  const typed = {
    urgency: v => enumOf(v, LEVELS), face: v => enumOf(v, LEVELS), posture: v => enumOf(v, POSTURES),
    approach_style: v => enumOf(v, STYLES), no_holds: v => enumOf(v, ['yes', 'usually', 'rarely']),
    contactable: boolOf, buyer: boolOf, hard_to_deal_with: boolOf, attached: boolOf, just_won_trade: boolOf,
  };
  const isKnown = v => !(v == null || v === UNKNOWN || (Array.isArray(v) && !v.length));
  for (const [k, v] of Object.entries(fromProfile)) {
    if (k in ov) {
      const o = typed[k] ? typed[k](ov[k]) : Array.isArray(v) ? (k.endsWith('positions') || k === 'techniques' || k === 'shuts_down'
        ? arr(ov[k]).map(String) : ids(ov[k])) : ov[k];
      out[k] = o; sources[k] = 'nick_override';
    } else {
      out[k] = v; sources[k] = isKnown(v) ? 'profile' : UNKNOWN;
    }
  }
  const known = Object.values(sources).some(s => s !== UNKNOWN);
  return {
    status: raw == null || !known ? UNKNOWN : 'ok',
    as_of: raw?.as_of ?? asOf ?? null,
    version: raw?.version ?? raw?.as_of ?? null,
    source: raw?.source ?? null,
    messages_read: Number.isFinite(raw?.messages_read) ? raw.messages_read : null,
    ...out, sources, override_fields: Object.keys(sources).filter(k => sources[k] === 'nick_override'),
  };
}

/** rawByTeam: Map team -> raw profile (or null). Returns Map team -> typed profile. */
export function readLeagueProfiles(rawByTeam, opts = {}) {
  const out = new Map();
  for (const [team, raw] of rawByTeam ?? []) out.set(String(team), readProfile(raw, opts));
  return out;
}
