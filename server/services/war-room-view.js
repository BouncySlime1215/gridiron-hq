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
 * (The PEOPLE-BOARD rail's `people` tiles were retired with the War Room shell; Trades -> People
 * reads the manager-profile routes instead.)
 */
// FP-GUARD: FantasyPros fields never leave the server (fantasypros-guard.js).
import { holdStepRegret } from './campaign/serve-regret.js';
import { stripFantasyPros } from './fantasypros-guard.js';
import fs from 'node:fs/promises';
import { previewFields, previewText } from './preview-mode.js';
import { warRoomFlag, warRoomPlansPath, WARROOM_PREVIEW_REASON } from './warroom-flag.js';
import { SECTIONS, SOURCE_IDS, STATUSES, validateLeague } from './campaign/plans-schema.js';
import { planAge, plansExpireFlag } from './campaign/plan-age.js';
import { currentLastGood } from './campaign/last-good.js';

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
export function buildWarRoomView(leagueId, plans, flag, { now = Date.now(), env = process.env, lastGood = null } = {}) {
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
  // LAST-GOOD (campaign/last-good.js): a failed refresh keeps the plan on screen, says so, and blocks sending.
  if (lastGood) view.last_good = structuredClone(lastGood);
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
  // STEP-REGRET at the serve step (campaign/serve-regret.js): a move with a step that loses to doing nothing is held back.
  const plans = await loadPlans();
  const held = plans?.status === 'ok' && Array.isArray(plans.entries)
    ? { ...plans, entries: plans.entries.map(e => (e && !e.error ? holdStepRegret(e).entry : e)) } : plans;
  // LAST-GOOD: null unless GRIDIRON_LAST_GOOD=1 and a refresh step failed (then sync_log is read once per view).
  const lastGood = await currentLastGood({ plansAsOf: plans?.status === 'ok' ? plans.as_of : null });
  const view = buildWarRoomView(leagueId, held, flag, { lastGood });
  // Only when the plan has no usable number_health, and never over a planner that failed.
  if (view.number_health && view.number_health.status === 'unknown') {
    const live = await liveNumberHealth(leagueId);
    if (live.status === 'ok') view.number_health = finalize({ x: live }, flag).x;
  }
  // FP-GUARD: the blue-chip board's FantasyPros ranks and its `fp` sync block stay on the server.
  return stripFantasyPros(view, { also: ['fp'] });
}
