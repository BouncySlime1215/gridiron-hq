/**
 * WR-1 + FIX-04: the War Room's one read (WAR-ROOM-UI.md sections 2 and 3).
 *
 * The War Room serves no new number. It reads the plans file the campaign producer
 * writes ahead of time (warroom-plans/1, server/services/campaign/plans-schema.js) and
 * serves this league's entry as the contract writes it, plus the view's own
 * { enabled, preview, preview_reason, snapshot, sources, banner }. Coach (#230) and the
 * UI read one shape. Nothing here simulates, prices, re-ranks or renames: the deck is
 * `alternatives.value`, head first, and a number the producer did not write is
 * `unknown`, never 0.
 *
 * Each section is validated against the contract on its own. A section that breaks
 * it is served `failed` with the first problem as its reason, and the other sections
 * still pass through; keys the contract does not declare (the study's `acq`, `flip`,
 * `baseline`) are dropped. finalize() strips `value` from any failed or unknown field
 * wherever it sits, so a bug upstream still cannot leak a digit.
 *
 * Request-thread cost: one async stat of the plans file per request; the file is read
 * and parsed only when its mtime or size changes; validation walks one league entry.
 * No producer module is imported at load. The one exception is WR-POLISH's fallback: a
 * plan with no number_health reads the number audit (a SELECT) through lazy imports.
 *
 * PEOPLE-BOARD (behind warroom-flag.js#peopleBoardFlag): `people`, one tile per league-mate,
 * a join by roster id of reads only, each from its ONE producer (FIELD-REGISTRY.md):
 *   P(responds), fatigue   the plan's `partners` (campaign planner over people.counterpart;
 *                          offers this week = FIX-07 sentThisWeek) and destination.tolerances
 *   Nick's word            people.counterpart override (the one reader's nick block from
 *                          Nick's notes) off the engine hub, people.profile nick as fallback
 *   approach               people.profile labels off the hub (hub-read.js)
 *   mood, in market        people_pulse (pulse.js#recentPulse)
 *   his word               people_credibility (credibility.js#readCredibility)
 * All SELECTs through lazy imports; nothing is computed that a producer did not write, and
 * a slot whose producer has no row is typed unknown with the reason, never 0.
 */
// FP-GUARD: FantasyPros fields never leave the server (fantasypros-guard.js).
import { stripFantasyPros } from './fantasypros-guard.js';
import fs from 'node:fs/promises';
import { previewFields, previewText } from './preview-mode.js';
import { warRoomFlag, peopleBoardFlag, warRoomPlansPath, WARROOM_PREVIEW_REASON } from './warroom-flag.js';
import { SECTIONS, SOURCE_IDS, STATUSES, validateLeague } from './campaign/plans-schema.js';
import { planAge, plansExpireFlag } from './campaign/plan-age.js';

/** Labels for every contract SourceId (WAR-ROOM-UI.md 2.3). Only the market value is calibrated today. */
const SOURCE_LABELS = {
  'sim.title': ['Season sim, 1,200 runs', false],
  'clone.accept': ['Trade model: chance he says yes', false],
  'clone.price': ['His price (from his moves)', false],
  'market.fc': ['FantasyCalc market value', true],
  'plan.path': ['Planner, paths searched', false],
  'coach.text': ['Written by Coach, facts checked', false],
  'eval.check': ['Brain check E1-E7', false],
  'audit.numbers': ['Number check', false],
  'campaign.plan': ['Campaign planner', false],
  'plan.template': ['Plan template', false],
  'chat.labels': ['League chat read', false],
  'asset.ros': ['Rest-of-season value', false]
};
export const SOURCES = Object.freeze(Object.fromEntries(SOURCE_IDS.map(id => {
  const [label, calibrated] = SOURCE_LABELS[id] ?? [id, false];
  return [id, Object.freeze({ label, calibrated })];
})));

/**
 * Every section the view serves: the contract's, plus number_health, which the UI has
 * a slot for and FIX-03 adds to the contract. Until then it is unknown with that reason.
 */
export const VIEW_SECTIONS = Object.freeze([...new Set([...Object.keys(SECTIONS), 'number_health'])]);

/** Where a section's hidden state says it came from. */
const SECTION_SOURCE = {
  finder_best_expected: 'plan.path', flip_map: 'sim.title', brain_report: 'eval.check', number_health: 'audit.numbers'
};
const sourceOf = k => SECTION_SOURCE[k] ?? 'campaign.plan';
const HEAD_KEYS = ['league', 'me', 'names', 'error', 'sanity_composed_equals_direct', 'planned_at'];
const HIDDEN = new Set(['failed', 'unknown']);

const BANNER = 'These plans come from the campaign producer, run ahead of time. Every chance and every odds change is a guess until the brain check passes.';

const hidden = (status, reason, source) => ({ status, source, reason });

/**
 * The last word on "failed and unknown carry no value": walks the whole view, drops
 * `value` from every hidden field, and in preview prefixes every sentence the server
 * or producer wrote as a reason, plus the banner.
 */
export function finalize(view, { preview = false } = {}) {
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const isField = STATUSES.includes(node.status) && typeof node.source === 'string';
    if (isField && HIDDEN.has(node.status)) delete node.value;
    for (const [k, v] of Object.entries(node)) {
      if (preview && (k === 'banner' || (isField && k === 'reason')) && typeof v === 'string') node[k] = previewText(v);
      else walk(v);
    }
  };
  walk(view);
  return view;
}

/* ------------------------------------------------------------- plans file */

let cache = null;

/** Test hook: forget the parsed file. */
export function __resetPlansCache() { cache = null; }

/**
 * Read the plans JSON. Returns { status: 'ok', entries, as_of, id, head } or a hidden
 * state with a reason. The path itself never goes into a reason (it names a home directory).
 */
export async function loadPlans(file = warRoomPlansPath()) {
  let st;
  try { st = await fs.stat(file); } catch (e) {
    if (e.code === 'ENOENT') return { status: 'unknown', reason: 'No plan has been run yet: the plans file does not exist.' };
    return { status: 'failed', reason: `The plans file could not be opened (${e.code ?? 'error'}).` };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.result;
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    const result = { status: 'failed', reason: `The plans file is not valid JSON (${e.name}), so every plan is hidden.` };
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, result };
    return result;
  }
  const entries = Array.isArray(doc?.leagues) ? doc.leagues : Array.isArray(doc) ? doc : null;
  const result = !entries
    ? { status: 'failed', reason: 'The plans file has no list of leagues in it.' }
    : {
      status: 'ok', entries,
      as_of: typeof doc?.generated_at === 'string' ? doc.generated_at : new Date(st.mtimeMs).toISOString(),
      id: `plans@${Math.round(st.mtimeMs)}`,
      head: Object.fromEntries(['schema', 'producer', 'producer_version']
        .filter(k => typeof doc?.[k] === 'string').map(k => [k, doc[k]]))
    };
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, result };
  return result;
}

/* -------------------------------------------------------------- the entry */

/** Every section hidden for one reason. */
function allHidden(status, reason) {
  return Object.fromEntries(VIEW_SECTIONS.map(k => [k, hidden(status, reason, sourceOf(k))]));
}

/** Contract problems grouped by the entry key they sit under ('next_move', 'names', ...). */
function problemsByKey(entry) {
  const by = new Map();
  for (const e of validateLeague(entry, '$').errors) {
    const key = e.path.split(/[.[]/)[1];
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(e);
  }
  return by;
}

const firstProblem = errs => `${errs[0].path.slice(2)} ${errs[0].message}`;

/** The entry's sections, each passed through, failed on a contract break, or unknown when not written. */
function sections(entry) {
  const problems = problemsByKey(entry);
  const out = {};
  for (const k of VIEW_SECTIONS) {
    const src = sourceOf(k);
    if (!(k in SECTIONS)) {
      out[k] = hidden('unknown', `Not in the plans contract yet (${k}), so the producer cannot write it.`, src);
    } else if (!(k in entry)) {
      out[k] = hidden('unknown', `The producer did not write ${k} for this league.`, src);
    } else if (problems.has(k)) {
      const errs = problems.get(k);
      out[k] = hidden('failed', `This section does not match the plans contract (${errs.length} problem${errs.length > 1 ? 's' : ''}; first: ${firstProblem(errs)}), so it is hidden.`, src);
    } else {
      out[k] = structuredClone(entry[k]);
    }
  }
  return { out, problems };
}

/**
 * Pure: the view for one league from an already-loaded plans result.
 * `plans` is loadPlans()'s return; `flag` is warRoomFlag()'s. PLANS-EXPIRE: `now` and `env`
 * decide whether the entry is out of date (campaign/plan-age.js); an out-of-date entry has every
 * section hidden with the reason and carries `plan_out_of_date` for the UI.
 */
export function buildWarRoomView(leagueId, plans, flag, { now = Date.now(), env = process.env } = {}) {
  if (!flag?.enabled) return { enabled: false };
  const base = {
    enabled: true, league_id: Number(leagueId),
    ...(flag.preview ? previewFields(WARROOM_PREVIEW_REASON) : {}),
    banner: BANNER,
    sources: SOURCES
  };
  const empty = { league: Number(leagueId), me: null, names: {} };
  if (plans.status !== 'ok') {
    return finalize({ ...base, snapshot: null, ...empty, ...allHidden(plans.status === 'failed' ? 'failed' : 'unknown', plans.reason) }, flag);
  }
  const snapshot = { id: plans.id, as_of: plans.as_of, ...(plans.head ?? {}) };
  const entry = plans.entries.find(e => String(e?.league) === String(leagueId));
  if (!entry) {
    return finalize({ ...base, snapshot, ...empty, ...allHidden('unknown', 'No plan has been run for this league yet.') }, flag);
  }

  const { out, problems } = sections(entry);
  const headBroken = ['league', 'me', 'names'].find(k => problems.has(k));
  const head = headBroken ? empty : Object.fromEntries(HEAD_KEYS.filter(k => k in entry).map(k => [k, structuredClone(entry[k])]));
  const view = { ...base, snapshot, ...head, ...out };

  if (headBroken) {
    const r = `This league's plan does not match the plans contract (${firstProblem(problems.get(headBroken))}), so it is hidden.`;
    return finalize({ ...view, ...allHidden('failed', r) }, flag);
  }
  if (typeof entry.error === 'string') {
    const r = `The planner run failed for this league (${entry.error}), so its plans are hidden.`;
    return finalize({ ...view, ...allHidden('failed', r) }, flag);
  }
  if (entry.sanity_composed_equals_direct === false) {
    const r = 'The planner failed its own check (its composed rescore did not match the served trade impact), so its numbers are hidden. Trust Trade Lab meanwhile.';
    return finalize({ ...view, ...allHidden('failed', r) }, flag);
  }
  if (plansExpireFlag(env) === 'on') {
    const age = planAge(entry, { entries: plans.entries, now });
    if (age.status === 'out_of_date') {
      const plan_out_of_date = { planned_at: age.planned_at, age_hours: age.age_hours, max_hours: age.max_hours, reason: age.reason };
      return finalize({ ...view, ...allHidden('unknown', age.reason), plan_out_of_date }, flag);
    }
  }
  guardAttention(view);
  hideUntouchableTargets(view, entry);
  return finalize(view, flag);
}

/* ------------------------------------------------------- WR-POLISH guards */

/**
 * Is a served attention row in range? The rail reads "rank R of N"; anything but whole
 * numbers with 1 <= R <= N is a producer bug. Null when fine, else the reason.
 */
export function attentionProblem(value) {
  const rank = value?.rank, of = value?.of;
  if (!Number.isInteger(rank) || !Number.isInteger(of)) return 'its rank or league count is not a whole number';
  if (rank < 1 || of < 1 || rank > of) return `rank ${rank} of ${of} is out of range`;
  return null;
}

/** Audit defect 1: an out-of-range rank ("rank 6 of 5") is a producer bug, served failed, never drawn. */
function guardAttention(view) {
  const a = view.attention;
  if (a?.status !== 'ok') return;
  const problem = attentionProblem(a.value);
  if (problem) view.attention = hidden('failed', `The attention rank is hidden: ${problem}.`, a.source ?? 'campaign.plan');
}

/** A target mark that means "on his untouchable list": true, a Field that is ok and true, or { label }. */
function untouchableMark(t) {
  const m = t?.untouchable ?? t?.on_untouchable_list;
  if (m === true) return typeof t.untouchable_label === 'string' ? t.untouchable_label : '';
  if (m && typeof m === 'object') {
    if ('status' in m) return m.status === 'ok' && m.value ? (typeof m.value === 'object' && typeof m.value.label === 'string' ? m.value.label : '') : null;
    return typeof m.label === 'string' ? m.label : '';
  }
  return null;
}

/** The entry's per-roster untouchable list, if the plan writes one: { owner: [player ids] }. */
function rosterUntouchables(entry) {
  // The producer writes Nick's untouchables per manager on partners[].untouchable (RULINGS 17, the reader's nick block).
  const fromPartners = entry?.partners?.status === 'ok' && Array.isArray(entry.partners.value)
    ? Object.fromEntries(entry.partners.value.filter(p => p?.untouchable?.length).map(p => [String(p.team), p.untouchable])) : null;
  const raw = entry?.untouchables_by_roster ?? entry?.roster_untouchables ?? (fromPartners && Object.keys(fromPartners).length ? fromPartners : null);
  const map = raw && typeof raw === 'object' && 'status' in raw ? (raw.status === 'ok' ? raw.value : null) : raw;
  if (!map || typeof map !== 'object') return null;
  return new Map(Object.entries(map).map(([owner, ids]) => [String(owner), new Set((Array.isArray(ids) ? ids : []).map(String))]));
}

/**
 * Audit defect 8: targets never show a player the plan marks as on his owner's
 * untouchable list. The rows are dropped here (so Coach and the panel agree) and the
 * field says how many were hidden and why: `hidden_untouchable: [{ player, owner, label }]`.
 */
function hideUntouchableTargets(view, entry) {
  const f = view.targets;
  if (f?.status !== 'ok' || !Array.isArray(f.value)) return;
  const lists = rosterUntouchables(entry);
  const hiddenRows = [];
  f.value = f.value.filter(t => {
    let label = untouchableMark(t);
    if (label == null && lists?.get(String(t?.owner))?.has(String(t?.player))) label = '';
    if (label == null) return true;
    hiddenRows.push({ player: String(t.player), owner: String(t.owner ?? ''), label: label || 'on his untouchable list' });
    return false;
  });
  if (hiddenRows.length) f.hidden_untouchable = hiddenRows;
}

/**
 * Audit defect 7 (FIX-05): when the plan did not carry number_health (an older run, or
 * the producer could not read it), read the number audit itself. readNumberAudit is a
 * plain SELECT on number_audit; its shaping is brain-gate.js#readNumberHealth, the same
 * one the producer uses, so the two can never disagree. Both are imported lazily, so the
 * pure view and its tests never open the app DB.
 */
export async function liveNumberHealth(leagueId) {
  try {
    const [{ readNumberAudit }, { readNumberHealth }] = await Promise.all([
      import('./number-audit.js'), import('./campaign/brain-gate.js')]);
    const h = readNumberHealth(undefined, leagueId, { read: (id) => readNumberAudit(id) });
    return h.status === 'ok'
      ? { status: 'ok', source: 'audit.numbers', ...(h.as_of ? { as_of: h.as_of } : {}), value: h.value }
      : { status: h.status, source: 'audit.numbers', reason: h.reason };
  } catch (e) {
    return { status: 'failed', source: 'audit.numbers', reason: `The number audit could not be read (${String(e?.message ?? e).slice(0, 200)}).` };
  }
}

/** The route's whole job: flag, then one cached file read, then the entry. */
export async function warRoomView(leagueId) {
  const flag = warRoomFlag();
  if (!flag.enabled) return { enabled: false };
  const view = buildWarRoomView(leagueId, await loadPlans(), flag);
  // Only when the plan has no usable number_health, and never over a planner that failed.
  if (view.number_health && view.number_health.status === 'unknown') {
    const live = await liveNumberHealth(leagueId);
    if (live.status === 'ok') view.number_health = finalize({ x: live }, flag).x;
  }
  const people = peopleBoardFlag();
  view.people_board = people;
  if (people.enabled) {
    view.people = finalize({ x: buildPeopleBoard(view, await cachedPeopleInputs(leagueId)) }, people).x;
    view.sources = { ...view.sources, ...PEOPLE_SOURCES };
  }
  // FP-GUARD: the blue-chip board's FantasyPros ranks and its `fp` sync block stay on the server.
  return stripFantasyPros(view, { also: ['fp'] });
}

/* ----------------------------------------------------------- PEOPLE-BOARD */

/** Source tags the board adds (labels for the tag; none of these is calibrated). */
export const PEOPLE_SOURCES = Object.freeze({
  'people.profile': Object.freeze({ label: 'Chat profile (labels only)', calibrated: false }),
  'people.counterpart': Object.freeze({ label: "Counterpart model + Nick's notes", calibrated: false }),
  'people.pulse': Object.freeze({ label: 'Chat pulse (labelled statements)', calibrated: false }),
  'people.credibility': Object.freeze({ label: 'Follow-through record', calibrated: false }),
});

export const LAST_CONTACT_REASON =
  'Nothing produces last contact yet (offers and replies are not logged per manager with a date), so it is not known.';
/** Pulse windows: mood reads the last week of talk, in-market the last three (wants fade by day 21). */
export const MOOD_DAYS = 7;
export const MARKET_DAYS = 21;
const MOOD_OF = { FRUSTRATED: 'frustrated', URGENCY: 'needs a move', ACCEPT_TALK: 'ready to deal', REFUSAL: 'turning deals down',
  HYPE: 'talking his players up', TRADE_REACTION: 'reacting to trades' };
const MARKET_TYPES = new Set(['WANT_PLAYER', 'WANT_POS', 'SHOP']);

const ok = (value, source, extra = {}) => ({ status: 'ok', source, ...extra, value });
const unknownF = (reason, source) => ({ status: 'unknown', source, reason });
const failedF = (reason, source) => ({ status: 'failed', source, reason });
const errText = e => String(e?.message ?? e).slice(0, 160);

/**
 * Every read the board joins, each caught on its own: one input failing types its slots
 * failed with the reason and leaves the others. Reads only (SELECTs), lazy imports.
 */
export async function peopleInputs(leagueId, { now = new Date() } = {}) {
  const out = { now: new Date(now).toISOString() };
  return readPeopleInputs(leagueId, now, out);
}

/**
 * The route's copy of peopleInputs, kept PEOPLE_TTL_MS per league: the producers behind it
 * move on the refresh cadence (minutes), so a burst of view requests does its SELECTs once.
 */
export const PEOPLE_TTL_MS = 30_000;
const peopleCache = new Map();
/** Test hook: forget the cached reads. */
export function __resetPeopleCache() { peopleCache.clear(); }
export async function cachedPeopleInputs(leagueId, { nowMs = Date.now() } = {}) {
  const hit = peopleCache.get(Number(leagueId));
  if (hit && nowMs - hit.at < PEOPLE_TTL_MS) return hit.inputs;
  const inputs = await peopleInputs(leagueId, { now: new Date(nowMs) });
  peopleCache.set(Number(leagueId), { at: nowMs, inputs });
  return inputs;
}

async function readPeopleInputs(leagueId, now, out) {
  const hub = await import('./people/hub-read.js').catch(e => ({ error: e }));
  for (const [k, fn] of [['profile', 'hubPeopleProfile'], ['counterpart', 'hubPeopleCounterpart']]) {
    try {
      if (hub.error) throw hub.error;
      out[k] = await hub[fn](leagueId, { asOf: now });
    } catch (e) { out[k] = { available: false, failed: true, reason: `the hub read failed (${errText(e)})` }; }
  }
  let database = null;
  try { database = (await import('../db/index.js')).db; } catch (e) { out.dbError = errText(e); }
  try {
    const { recentPulse } = await import('./people/pulse.js');
    out.pulse = recentPulse(Number(leagueId), { database, now, hours: MARKET_DAYS * 24, limit: 400 });
  } catch (e) { out.pulse = { status: 'failed', reason: errText(e), items: [] }; }
  try {
    const { readCredibility } = await import('./people/credibility.js');
    out.credibility = readCredibility(database, Number(leagueId));
  } catch (e) {
    out.credibility = /no such table/.test(String(e?.message))
      ? { absent: 'the follow-through table is missing (migration 099 not applied)' }
      : { failed: errText(e) };
  }
  return out;
}

/**
 * Nick's read of one manager: the counterpart override (hub), else the profile's nick block.
 * Standing "never" also follows the plan partner's own `blocked` (partners.js: blocked or
 * unreachable per Nick => P(responds) 0), so roster 4 stays "never a partner" when the hub
 * people rows are absent or stale (they publish only under GRIDIRON_HUB_PEOPLE or preview;
 * the board has its own switch). `blocked` is the only such flag the plans contract carries.
 */
function nickRead(team, inputs, partner) {
  const cp = inputs.counterpart?.byRoster?.get?.(team)?.value?.override;
  const pn = inputs.profile?.byRoster?.get?.(team)?.value?.nick;
  const hubNever = !!(cp?.exclude || pn?.unreachable);
  const planNever = partner?.blocked === true;
  const never = hubNever || planNever;
  const last = !never && !!(cp?.deprioritize || pn?.deprioritised);
  const hard = !!(cp?.toughen || pn?.hard);
  const said = [];
  if (hubNever) said.push("Nick: can't reach him, never a partner");
  else if (planNever) said.push(`The plan marks him never trading (${partner.basis || 'blocked'}): never a partner`);
  if (last) said.push('Nick: not a buyer, goes last');
  if (hard) said.push('Nick: hard negotiator, hold your price');
  const from = cp?.status === 'ok' ? 'people.counterpart' : pn ? 'people.profile' : planNever ? 'campaign.plan' : null;
  return { never, last, hard, said, from };
}

function approachOf(team, inputs, nick) {
  const pr = inputs.profile;
  if (!pr?.available) return (pr?.failed ? failedF : unknownF)(`No profile read: ${pr?.reason ?? 'the hub has no people.profile rows'}.`, 'people.profile');
  const e = pr.byRoster.get(team);
  const v = e?.value;
  if (!v) return unknownF(`No profile read: ${e?.absence?.reason ?? 'the hub has no row for him'}.`, 'people.profile');
  if (v.status !== 'ok' || !v.labels) return unknownF(`No profile read: ${v.reason ?? 'his profile is not usable'}.`, 'people.profile');
  const l = v.labels;
  const bits = [];
  if (l.does_his_no_hold === 'yes' || l.does_his_no_hold === 'usually') bits.push('his no holds: make one fair offer');
  else if (l.does_his_no_hold === 'rarely') bits.push('his no rarely holds: counter once');
  if (l.inflation === 'heavy') bits.push('discount his hype');
  else if (l.inflation === 'mild') bits.push('some hype in his talk');
  if (l.praise_reading === 'marketing' || l.hypes_before_selling === true) bits.push('praise means he is selling');
  if (nick.hard) bits.push('hold your price');
  if (!bits.length) return unknownF('His profile has no approach label (no-holds, inflation or praise read).', 'people.profile');
  return ok(bits.join(' · '), 'people.profile', { guess: true });
}

function pulseFor(team, inputs) {
  const p = inputs.pulse;
  if (!p || p.status === 'failed') return { err: failedF(`The chat pulse could not be read (${p?.reason ?? 'no result'}).`, 'people.pulse') };
  if (p.status === 'table_absent') return { err: unknownF('The chat pulse has not run here (migration 098 not applied).', 'people.pulse') };
  const nowMs = Date.parse(inputs.now);
  return { items: p.items.filter(i => String(i.roster_id) === team).map(i => ({ ...i, age_days: (nowMs - Date.parse(i.as_of)) / 864e5 })) };
}

function moodOf(team, inputs, partner) {
  const p = pulseFor(team, inputs);
  const tone = partner?.chat_labels?.find(l => l.startsWith('tone:'))?.slice(5);
  if (!p.err) {
    const hit = p.items.find(i => i.age_days <= MOOD_DAYS && MOOD_OF[i.type]);
    if (hit) return ok(`${MOOD_OF[hit.type]} (${hit.ago})`, 'people.pulse', { guess: true });
  }
  if (tone) return ok(tone, 'chat.labels', { guess: true });
  return p.err ?? unknownF(`No mood read: no labelled mood statement from him in ${MOOD_DAYS} days and no chat tone label.`, 'people.pulse');
}

function marketOf(team, inputs) {
  const p = pulseFor(team, inputs);
  if (p.err) return p.err;
  const said = p.items.filter(i => MARKET_TYPES.has(i.type) && i.age_days <= MARKET_DAYS);
  const wants = inputs.counterpart?.byRoster?.get?.(team)?.value?.wants ?? [];
  if (!said.length && !wants.length) {
    return unknownF(`Not in the market as far as the chat shows: no want or shop statement from him in ${MARKET_DAYS} days.`, 'people.pulse');
  }
  return ok({ said: said.slice(0, 3).map(i => ({ text: i.phrase, ago: i.ago, credible: !!i.credible, fading: i.age_days > MOOD_DAYS })),
    said_n: said.length, wants_n: wants.length }, 'people.pulse', { guess: true });
}

function wordOf(team, inputs) {
  const c = inputs.credibility;
  if (c?.failed) return failedF(`The follow-through record could not be read (${c.failed}).`, 'people.credibility');
  if (c?.absent) return unknownF(`No follow-through record: ${c.absent}.`, 'people.credibility');
  if (!c) return unknownF('No follow-through record: the credibility run has not stored one for this league.', 'people.credibility');
  const rows = c.rosters?.[team] ?? {};
  const want = rows.WANT_PLAYER?.[7];
  const shop = rows.SHOP?.[7];
  const graded = [want, shop].filter(r => r && r.status !== 'unknown');
  if (!graded.length) return unknownF('No follow-through record: he has made no graded want or shop statement.', 'people.credibility');
  return ok({
    wants: want && want.status !== 'unknown' ? { status: want.status, n: want.n_statements, weight: want.weight } : null,
    shop: shop && shop.status !== 'unknown' ? { status: shop.status, n: shop.n_statements, weight: shop.weight } : null,
    as_of: c.as_of,
  }, 'people.credibility');
}

/**
 * TEAM-NAMES (INT6): a tile's name from the entry's `teams` section, the same rule as
 * campaign/playbook.js#teamLabel and the client's types.ts#teamLabel ('Manager (Team name)',
 * else whichever is known, else 'Team N'). Inline because this route imports no producer module.
 */
function tileLabel(teams, team) {
  const t = teams?.status === 'ok' && teams.value && typeof teams.value === 'object' ? teams.value[team] : null;
  const manager = typeof t?.manager === 'string' ? t.manager.trim() : '';
  const name = typeof t?.name === 'string' ? t.name.trim() : '';
  if (manager && name) return `${manager} (${name})`;
  return manager || name || `Team ${team}`;
}

/** How many of the plan's moves have a step with him (the deck focus a tap applies). */
function movesWith(team, view) {
  const alts = view.alternatives?.status === 'ok' && Array.isArray(view.alternatives.value) ? view.alternatives.value : [];
  return alts.filter(m => (m?.steps ?? []).some(s => String(s?.partner) === team)).length;
}

/**
 * Pure: the board from the view (its plan) and peopleInputs(). Order: the plan's partner
 * order (its ranking), then managers only the hub knows; Nick's "goes last" next; Nick's
 * "never a partner" at the very end.
 */
export function buildPeopleBoard(view, inputs) {
  const me = view.me == null ? null : String(view.me);
  const pf = view.partners;
  const partners = pf?.status === 'ok' && Array.isArray(pf.value) ? pf.value : [];
  const pBy = new Map(partners.map(p => [String(p.team), p]));
  const hubTeams = r => (r?.available ? [...r.byRoster.keys()].map(String) : []);
  const order = [...new Set([...partners.map(p => String(p.team)), ...hubTeams(inputs.counterpart), ...hubTeams(inputs.profile)])]
    .filter(t => t !== me);
  const planWhy = pf?.status === 'ok' ? 'The planner did not score him as a partner this run.'
    : (pf?.reason ?? 'The plan has no partners section.');
  const tf = view.destination?.status === 'ok' ? view.destination.value?.tolerances : null;
  const tol = tf && typeof tf === 'object' && 'status' in tf ? (tf.status === 'ok' ? tf.value : null) : tf;
  const limit = Number.isInteger(tol?.max_offers_per_manager_week) ? tol.max_offers_per_manager_week : null;

  const tiles = order.map(team => {
    const p = pBy.get(team);
    const nick = nickRead(team, inputs, p);
    const hole = p ? null : (pf?.status === 'failed' ? failedF : unknownF)(planWhy, 'campaign.plan');
    return {
      // TEAM-NAMES (INT6): the tile names the manager from the entry's teams map; none -> 'Team N'.
      team, label: tileLabel(view.teams, team),
      standing: nick.never ? 'never' : nick.last ? 'last' : 'live',
      nick: { never: nick.never, last: nick.last, hard: nick.hard, said: nick.said, source: nick.from },
      checked_out: p?.checked_out === true,
      blocked: p?.blocked === true,
      p_responds: p && typeof p.p_responds === 'number'
        ? ok({ p: p.p_responds, basis: p.basis ?? '' }, 'campaign.plan', { guess: true, unit: 'probability' }) : hole
          ?? unknownF('The plan scored him without a chance he responds.', 'campaign.plan'),
      fatigue: p && Number.isInteger(p.offers_logged) ? ok({ used: p.offers_logged, limit }, 'campaign.plan')
        : hole ?? unknownF('The plan carries no offers count for him this week.', 'campaign.plan'),
      mood: moodOf(team, inputs, p),
      in_market: marketOf(team, inputs),
      word: wordOf(team, inputs),
      approach: approachOf(team, inputs, nick),
      last_contact: unknownF(LAST_CONTACT_REASON, 'campaign.plan'),
      moves_n: movesWith(team, view),
    };
  });
  const rank = { live: 0, last: 1, never: 2 };
  const sorted = tiles.map((t, i) => [t, i]).sort((a, b) => rank[a[0].standing] - rank[b[0].standing] || a[1] - b[1]).map(x => x[0]);
  if (!sorted.length) {
    return unknownF(`No managers to show: ${planWhy} ${inputs.counterpart?.reason ?? ''}`.trim(), 'campaign.plan');
  }
  return ok(sorted, 'campaign.plan', { as_of: inputs.now });
}
