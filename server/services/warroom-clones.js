/**
 * UI-ENG-4: the War Room clone view, one row per league-mate (ENGINE-SPECS.md UI-ENG-4;
 * PEOPLE-WIRING.md; WAR-ROOM-UI.md v2, one panel in the one-dashboard grid).
 *
 * Per manager it serves, as typed fields (the war-room-view.js shape, `value` only when
 * 'ok'):
 *   profile      his traits as LABELS, from THE one profile reader (people/profile-reader.js,
 *                FIX-00 #260; RULINGS 1): peopleProfile's typed entries, reduced here to
 *                labels by cloneProfile; Nick's block winning, 'unknown' for quiet managers
 *   p_accept     a band {low, mid, high} for a deal that passes our edge test, from the same
 *                acceptanceBand the trade finder uses; "population, not him" with no record
 *   reasons      the top reasons, as labels with their signed effect when there is one
 *   wants        "wants player X": players he said he wants, matched to a rostered player,
 *                at full strength for WANTS_FULL_DAYS and fading to nothing by WANTS_GONE_DAYS
 *   credibility  whether his shop talk holds: his own declaration record first
 *                (bluff-detector.js), the profile's behaviour-vs-words label second,
 *                unknown for a quiet manager
 * plus `nick` (Nick's own labels, always shown) and `standing` (active / normal /
 * deprioritised / excluded, from Nick's word).
 *
 * LABELS ONLY: no chat text reaches this output. Managers are "Team <roster id>"; no
 * chat or ESPN name is copied. Players are named (they are NFL players, not people in
 * the league).
 *
 * `buildCloneRows` and `cloneProfile` are pure. `warRoomClones` is the one loader. It runs on the request
 * (the same reads GET /brain/managers makes today). Nothing here is fitted: every band
 * says `fitted: false` and carries the amber guess tag.
 */
import { rows } from '../db/index.js';
import { acceptanceBand } from './trade-acceptance.js';
import { counterpartyLayer } from './counterparty-pricing.js';
import { signalRowsFor } from './manager-signals.js';
import { identityMap } from './manager-identity.js';
import { declarationCredibility } from './bluff-detector.js';
import { normalizePlayerName } from './player-identity.js';
import { currentNflWeek } from './weekly-learning.js';
import { peopleProfile, leadingToken, tradesNone, UNKNOWN } from './people/profile-reader.js';
import { previewFields } from './preview-mode.js';
import { warRoomFlag, WARROOM_PREVIEW_REASON } from './warroom-flag.js';
import { finalize } from './war-room-view.js';

export const PRODUCER = 'warroom-clones';
export const PRODUCER_VERSION = 'ui-eng-4 v1';

/** PEOPLE-LAB (PEOPLE-WIRING.md): wants_player is strong for 7 days and decays over 7 -> 21. */
export const WANTS_FULL_DAYS = 7;
export const WANTS_GONE_DAYS = 21;
/** Decided offers below which his own record is thin. */
export const THIN_N = 5;
/** bluff-detector's own bars for "his word holds" / "probe it" (untouchableStance). */
const CRED_HOLDS = 0.7;
const CRED_MIXED = 0.45;
const MAX_REASONS = 3;
const DAY = 86400000;

export const CLONE_SOURCES = Object.freeze({
  'clone.accept': { label: 'Trade model: chance he says yes', calibrated: false },
  'people.profile': { label: 'Chat profile, labels only', calibrated: false },
  'people.nick': { label: "Nick's word", calibrated: false },
  'people.word': { label: 'His word vs his moves', calibrated: false },
});

const TRAIT_LABEL = Object.freeze({
  no_holds: { yes: 'his no is final', usually: 'his no usually holds', rarely: 'his no is an opening price' },
  inflation: { none: 'prices his players fairly', mild: 'prices his players a bit high', heavy: 'prices his players high' },
  urgency: { high: 'wants a deal soon', medium: 'open to a deal', low: 'in no hurry' },
  posture: { ghoster: 'often goes quiet', haggler: 'counters and haggles', quick: 'answers quickly' },
  style: { numbers: 'pitch with numbers', need: 'pitch to his needs', casual: 'keep it casual', direct: 'be direct' },
  word_match: { credible: 'does what he says', mixed: 'words and moves partly match', cheap_talk: 'talks more than he trades' },
  buyer: { true: 'a buyer', false: 'not a buyer' },
  hard_to_deal_with: { true: 'hard to deal with', false: null },
});

/* ----------------------------------------- the one reader's entry -> clone labels */

const lower = v => String(v ?? '').trim().toLowerCase();
const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Free-text slots the reader keeps as text, mapped to labels by their leading word. */
const URGENCY_WORDS = { high: 'high', urgent: 'high', very: 'high', medium: 'medium', moderate: 'medium',
  some: 'medium', low: 'low', none: 'low', no: 'low' };
const WORD_MATCH_WORDS = { yes: 'credible', matches: 'credible', consistent: 'credible', follows: 'credible',
  reliable: 'credible', credible: 'credible', mixed: 'mixed', partly: 'mixed', sometimes: 'mixed', somewhat: 'mixed',
  no: 'cheap_talk', cheap: 'cheap_talk', talks: 'cheap_talk', rarely: 'cheap_talk', contradicts: 'cheap_talk',
  all: 'cheap_talk', says: 'cheap_talk', bluff: 'cheap_talk' };
function wordLabel(words, value) {
  if (typeof value === 'boolean' && words === WORD_MATCH_WORDS) return value ? 'credible' : 'cheap_talk';
  const t = leadingToken(value, words);
  return t != null && words[t] ? words[t] : UNKNOWN;
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

/** A player a manager said he wants: a name (matched later against rosters) and a date. */
function wantsOf(profile, asOf) {
  const w = profile?.values_talk?.wants ?? {};
  const list = Array.isArray(w) ? w : [...arr(w.players), ...arr(w.positions)];
  return list.map(x => {
    const name = typeof x === 'string' ? x : x?.player ?? x?.name ?? null;
    const at = (x && typeof x === 'object' ? x.at ?? x.since ?? x.last ?? x.as_of : null) ?? asOf ?? null;
    return name ? { name: String(name).slice(0, 60), at } : null;
  }).filter(Boolean);
}

const FAN_OF = /^[A-Za-z .]{2,24}$/;

/**
 * The reader's Nick block (profile-reader.js#nickBlock) as the typed fields this panel
 * shows. Note text is counted, never copied; a sentence is not a team label.
 */
export function cloneNick(block) {
  if (!block || block.empty) return null;
  const fan = typeof block.fan_of === 'string' && FAN_OF.test(block.fan_of.trim()) ? block.fan_of.trim() : null;
  const out = {
    contactable: block.contactable ?? null,
    active: block.active ?? null,
    buyer: block.buyer ?? (tradesNone(block.trades) ? false : null),
    hard_to_deal_with: block.difficulty ? block.hard === true : null,
    fan_of: fan,
    notes_n: (block.notes?.length ?? 0) + (block.note ? 1 : 0),
  };
  out.set = Object.entries(out).some(([k, v]) => (k === 'notes_n' ? v > 0 : v != null));
  return out;
}

const TRAIT_KEYS = ['no_holds', 'inflation', 'urgency', 'posture', 'style', 'word_match', 'buyer', 'hard_to_deal_with'];

/**
 * One people.profile entry (profile-reader.js#peopleProfileEntry) -> the panel's typed
 * profile. Pure. Reads only the reader's normalised profile (enum slots already parsed);
 * no sentence leaves this function, only the label it reduced to.
 *   { status, reason?, as_of, messages_read, traits, sources, wants: [{ name, at }], nick }
 */
export function cloneProfile(entry) {
  const nick = cloneNick(entry?.nick);
  const p = entry?.status === 'ok' ? entry.profile : null;
  const bvw = p?.behaviour_vs_words;
  const derived = p ? {
    no_holds: p.says_no?.does_his_no_hold ?? UNKNOWN,
    inflation: p.calibration?.inflation ?? UNKNOWN,
    urgency: wordLabel(URGENCY_WORDS, p.deal_feelings?.urgency),
    posture: postureOf(p.techniques),
    style: styleOf(p.how_to_approach),
    word_match: wordLabel(WORD_MATCH_WORDS, bvw?.verdict ?? bvw?.summary ?? bvw),
  } : {};
  const traits = {}, sources = {};
  for (const k of TRAIT_KEYS) {
    // buyer / hard_to_deal_with are Nick's word only: schema v2 has no chat-derived slot for them.
    const fromNick = (k === 'buyer' || k === 'hard_to_deal_with') ? nick?.[k] ?? null : null;
    if (fromNick != null) { traits[k] = fromNick; sources[k] = 'nick_override'; continue; }
    const v = derived[k];
    const known = v != null && v !== UNKNOWN;
    traits[k] = known ? v : UNKNOWN;
    sources[k] = known ? 'profile' : UNKNOWN;
  }
  const out = {
    status: p ? 'ok' : UNKNOWN,
    as_of: entry?.as_of ?? null,
    messages_read: entry?.messages_read ?? null,
    traits, sources,
    wants: p ? wantsOf(p, entry.as_of) : [],
    nick,
  };
  if (!p) out.reason = entry?.reason ?? 'no chat profile built for this manager';
  return out;
}

/** people.profile (the reader's league read) -> { available, reason?, byRoster: Map roster -> cloneProfile }. */
export function cloneProfiles(read) {
  if (!read?.available) return { available: false, reason: read?.reason ?? 'profiles not loaded', byRoster: new Map() };
  return { available: true, byRoster: new Map([...read.byRoster].map(([r, e]) => [String(r), cloneProfile(e)])) };
}

/* ------------------------------------------------------------------ fields */

function field(status, value, source, reason, extra = {}) {
  const f = { status, source, producer: PRODUCER, producer_version: PRODUCER_VERSION, ...extra };
  if (status === 'ok' && value !== undefined) f.value = value;
  if (reason) f.reason = reason;
  return f;
}
const ok = (value, source, extra) => field('ok', value, source, null, extra);
const unknown = (reason, source) => field('unknown', undefined, source, reason);
const failed = (reason, source) => field('failed', undefined, source, reason);

/* ------------------------------------------------------------------ pieces */

/** Nick's word as short labels, and the standing it implies. */
export function nickLabels(nick) {
  const labels = [];
  if (!nick) return { labels, standing: 'normal' };
  if (nick.contactable === false) labels.push('Nick: not reachable');
  if (nick.active === true) labels.push('Nick: active trader');
  if (nick.active === false) labels.push('Nick: not active');
  if (nick.buyer === false) labels.push('Nick: not doing trades');
  if (nick.hard_to_deal_with === true) labels.push('Nick: hard to deal with');
  if (nick.fan_of) labels.push(`Nick: ${nick.fan_of} fan`);
  if (nick.notes_n > 0) labels.push(`Nick has ${nick.notes_n} note${nick.notes_n === 1 ? '' : 's'} on him`);
  const standing = nick.contactable === false ? 'excluded'
    : nick.buyer === false || nick.active === false ? 'deprioritised'
      : nick.active === true ? 'active' : 'normal';
  return { labels, standing };
}

/** The traits a page shows: [{ key, label, source }], unknown and silent traits left out. */
export function traitLabels(profile) {
  const out = [];
  for (const [key, v] of Object.entries(profile?.traits ?? {})) {
    if (v === UNKNOWN || v == null) continue;
    const label = TRAIT_LABEL[key]?.[String(v)];
    if (label) out.push({ key, label, source: profile.sources?.[key] === 'nick_override' ? 'people.nick' : 'people.profile' });
  }
  return out;
}

/**
 * wants: candidate names -> rostered players, decayed by age. Players he already owns
 * are dropped (he cannot want his own). Returns a Field.
 */
export function wantsField(profile, { team, players, me, now }) {
  if (!profile || profile.status !== 'ok') {
    return unknown(profile?.reason ? `No read: ${profile.reason}.` : 'No read of what he wants.', 'people.profile');
  }
  if (!players) return unknown('Rosters are not synced, so a wanted name cannot be matched to a player.', 'people.profile');
  const best = new Map();
  for (const w of profile.wants ?? []) {
    const p = players.get(normalizePlayerName(w.name));
    if (!p || p.owner === team) continue;
    const t = Date.parse(w.at ?? '');
    if (!Number.isFinite(t)) continue;
    const age = Math.max(0, (now - t) / DAY);
    if (age >= WANTS_GONE_DAYS) continue;
    const strength = age <= WANTS_FULL_DAYS ? 1 : +(1 - (age - WANTS_FULL_DAYS) / (WANTS_GONE_DAYS - WANTS_FULL_DAYS)).toFixed(2);
    const row = { player: { id: p.id, name: p.name, pos: p.pos }, age_days: Math.floor(age), strength,
      state: age <= WANTS_FULL_DAYS ? 'fresh' : 'fading', you_have: me != null && p.owner === me };
    const prev = best.get(p.id);
    if (!prev || prev.strength < row.strength) best.set(p.id, row);
  }
  // Producer order: strongest first, then the ones Nick can sell him.
  const list = [...best.values()].sort((a, b) => b.strength - a.strength || Number(b.you_have) - Number(a.you_have));
  return ok(list, 'people.profile');
}

/** credibility: his declaration record first, the profile's label second, unknown when quiet. */
export function credibilityField(profile, record) {
  if (!profile || profile.status !== 'ok') {
    return unknown(profile?.reason ? `No read: ${profile.reason}.` : 'Not enough shop talk to judge.', 'people.word');
  }
  if (record && record.declarations >= 3) {
    const c = record.credibility;
    const label = c >= CRED_HOLDS ? 'credible' : c >= CRED_MIXED ? 'mixed' : 'cheap_talk';
    return ok({ label, from: 'record', n: record.declarations, held: record.held, reversed: record.hard_reversals,
      hedged: record.hedged, confidence: record.confidence }, 'people.word', { guess: true });
  }
  const pl = profile.traits?.word_match;
  if (pl && pl !== UNKNOWN) {
    return ok({ label: pl, from: 'profile', n: record?.declarations ?? 0, confidence: 'profile label' }, 'people.word', { guess: true });
  }
  return unknown('Not enough shop talk to judge: fewer than 3 declarations and no profile label.', 'people.word');
}

/**
 * P(accept) band for an edge-passing deal with him, and the reasons behind it.
 * Returns { p_accept, factors } where factors are [{label, effect, source}].
 */
export function acceptField({ cp, cpState, profile, nick }) {
  if (nick?.contactable === false) {
    return { p_accept: unknown('Nick says he is not reachable, so no offer goes to him.', 'clone.accept'), factors: [] };
  }
  if (cpState?.status === 'failed') return { p_accept: failed(cpState.reason, 'clone.accept'), factors: [] };
  const noHold = profile?.status === 'ok' && profile.traits?.no_holds !== UNKNOWN ? profile.traits.no_holds : null;
  const band = acceptanceBand({
    counterparty: cp ? { ...cp, counterparty_data: true } : null,
    edge: { passes: true },
    profile: noHold ? { says_no: { does_his_no_hold: noHold } } : null,
  });
  if (!band.band) return { p_accept: unknown(band.why, 'clone.accept'), factors: [] };
  const n = band.anchor?.n ?? 0;
  const basis = band.anchor?.usable ? 'his_record' : 'population';
  const note = basis === 'population' ? 'population, not him' : n < THIN_N ? `thin (n=${n})` : `his record (n=${n})`;
  const p = ok({ low: band.band.low, mid: band.band.mid, high: band.band.high, n, basis, fitted: false },
    'clone.accept', { guess: true, note });
  // The band's own templated sentence, first clause only ("his profile says his no rarely holds").
  const factors = (band.factors ?? []).map(f => ({ label: String(f.why ?? f.label).split(/, | — /)[0], effect: f.effect, source: 'clone.accept' }));
  return { p_accept: p, factors };
}

/** Top reasons: the band's largest factors, then Nick's word, then a fresh want. */
export function reasonsField({ factors, nick, wants, standing }) {
  const out = [...factors].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  if (standing === 'excluded') out.unshift({ label: 'Nick: not reachable, left out of every plan', effect: null, source: 'people.nick' });
  if (nick?.hard_to_deal_with === true) out.push({ label: 'Nick: hard to deal with (not priced into this band)', effect: null, source: 'people.nick' });
  if (nick?.buyer === false) out.push({ label: 'Nick: not doing trades', effect: null, source: 'people.nick' });
  const fresh = wants?.status === 'ok' ? (wants.value ?? []).find(w => w.state === 'fresh') : null;
  if (fresh) out.push({ label: `In the market for ${fresh.player.name}`, effect: null, source: 'people.profile' });
  if (!out.length) return unknown('No reason moves him off the starting point yet.', 'clone.accept');
  return ok(out.slice(0, MAX_REASONS), 'clone.accept');
}

const STANDING_ORDER = { active: 0, normal: 1, deprioritised: 2, excluded: 3 };

/**
 * Pure: every league-mate's clone row.
 *   teams       roster ids in the league (strings)
 *   me          Nick's roster id, left out
 *   profiles    { available, reason?, byRoster: Map }
 *   counterparties  Map roster -> counterparty block, or null; cpState { status, reason } when not 'ok'
 *   records     Map roster -> declaration record (bluff-detector shape), or null
 *   players     Map normalized name -> { id, name, pos, owner } or null
 */
export function buildCloneRows({ teams, me = null, profiles, counterparties = null, cpState = { status: 'ok' },
  records = null, players = null, now = Date.now() }) {
  const out = [];
  for (const team of teams.map(String)) {
    if (me != null && team === String(me)) continue;
    const profile = profiles?.available ? profiles.byRoster.get(team) ?? null : null;
    const { labels: nick, standing } = nickLabels(profile?.nick);
    const profileF = !profiles?.available
      ? unknown(`No profile read: ${profiles?.reason ?? 'profiles not loaded'}.`, 'people.profile')
      : !profile ? unknown('No read: no chat profile for this manager.', 'people.profile')
        : profile.status !== 'ok' ? unknown(`No read: ${profile.reason}.`, 'people.profile')
          : ok({ traits: traitLabels(profile), as_of: profile.as_of, messages_read: profile.messages_read }, 'people.profile', { guess: true });
    const wants = wantsField(profile, { team, players, me: me == null ? null : String(me), now });
    const { p_accept, factors } = acceptField({ cp: counterparties?.get(team) ?? null, cpState, profile, nick: profile?.nick });
    out.push({
      team, label: `Team ${team}`, standing, nick,
      profile: profileF,
      p_accept,
      reasons: reasonsField({ factors, nick: profile?.nick, wants, standing }),
      wants,
      credibility: credibilityField(profile, records?.get(team) ?? null),
    });
  }
  // Producer order: Nick's active pool first, unreachable last, then roster id.
  return out.sort((a, b) => STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing] || Number(a.team) - Number(b.team));
}

/* ------------------------------------------------------------------ loader */

function leaguePlayers(payload) {
  const map = new Map();
  for (const t of payload?.teams ?? []) {
    for (const e of t.roster?.entries ?? []) {
      const p = e.playerPoolEntry?.player;
      if (!p?.fullName) continue;
      map.set(normalizePlayerName(p.fullName), { id: String(p.id), name: p.fullName, pos: POS[p.defaultPositionId] ?? null, owner: String(t.id) });
    }
  }
  return map;
}
const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

/**
 * The clones response for one league. The route checks membership and the flag first.
 * Async because the one reader's loader (profile-reader.js#peopleProfile) is.
 */
export async function warRoomClones(leagueId, { now = Date.now() } = {}) {
  const { preview } = warRoomFlag();
  const lg = rows('SELECT payload, my_team_id FROM leagues WHERE id = ?', leagueId)[0];
  const payload = lg?.payload ? JSON.parse(lg.payload) : null;
  const teams = (payload?.teams ?? []).map(t => String(t.id));
  const base = { enabled: true, league_id: leagueId, sources: CLONE_SOURCES, ...(preview ? previewFields(WARROOM_PREVIEW_REASON) : {}) };
  if (!teams.length) {
    return finalize({ ...base, clones: unknown('This league has not synced its rosters yet.', 'people.profile') }, { preview });
  }
  const profiles = cloneProfiles(await peopleProfile(leagueId));

  let counterparties = null, cpState = { status: 'ok' };
  if (signalRowsFor(leagueId).length) {
    try {
      const { season, week } = currentNflWeek();
      counterparties = counterpartyLayer(leagueId, { season, week, rosterContext: new Map() });
    } catch (e) {
      // Handled, not swallowed: every band says the layer failed and why.
      cpState = { status: 'failed', reason: `The counterparty layer failed: ${String(e?.message ?? e)}` };
    }
  }

  let records = null;
  const ids = identityMap(leagueId);
  if (ids.size) {
    const cred = declarationCredibility();
    if (cred.available) {
      records = new Map();
      for (const [rosterId, ident] of ids) {
        const rec = cred.byManager.get(ident.chat_name);
        if (rec) records.set(String(rosterId), rec);
      }
    }
  }

  const list = buildCloneRows({ teams, me: lg.my_team_id, profiles, counterparties, cpState, records,
    players: leaguePlayers(payload), now });
  const view = { ...base, as_of: new Date(now).toISOString(), clones: ok(list, 'people.profile') };
  // finalize() adds the preview prefix to the banner and to every reason.
  if (preview) view.banner = 'clone reads are hand-set heuristics, not fitted to his replies';
  return finalize(view, { preview });
}
