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
 * No producer module is imported here.
 */
import fs from 'node:fs/promises';
import { previewFields, previewText } from './preview-mode.js';
import { warRoomFlag, warRoomPlansPath, WARROOM_PREVIEW_REASON } from './warroom-flag.js';
import { SECTIONS, SOURCE_IDS, STATUSES, validateLeague } from './campaign/plans-schema.js';

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
  finder_best_expected: 'plan.path', flip_map: 'sim.title', brain_report: 'eval.check', number_health: 'audit.numbers',
  chess: 'plan.path'
};
const sourceOf = k => SECTION_SOURCE[k] ?? 'campaign.plan';
const HEAD_KEYS = ['league', 'me', 'names', 'error', 'sanity_composed_equals_direct'];
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
 * `plans` is loadPlans()'s return; `flag` is warRoomFlag()'s.
 */
export function buildWarRoomView(leagueId, plans, flag) {
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
  return finalize(view, flag);
}

/** The route's whole job: flag, then one cached file read, then the entry. */
export async function warRoomView(leagueId) {
  const flag = warRoomFlag();
  if (!flag.enabled) return { enabled: false };
  return buildWarRoomView(leagueId, await loadPlans(), flag);
}
