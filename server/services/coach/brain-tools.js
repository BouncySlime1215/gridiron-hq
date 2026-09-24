/**
 * COACH-TOOLS: Coach's typed read tools over the brain for one league
 * (COACH-ANCHOR.md, "Tools Coach gets").
 *
 *   plan_read    the War Room plans file (GRIDIRON_WARROOM_PLANS), one section
 *                at a time, checked against plans-schema.js before a cell of it
 *                is shown. Producer: the campaign producer (FIX-03).
 *   people_read  the counterpart profile per manager (people/profile-reader.js,
 *                COUNTERPART-01): labels and counts only, nick_override first.
 *   pulse_read   recent labelled statements (pulse_statements, PULSE-01).
 *   brain_read   the brain's report card E1-E7 (brain_report, EVAL-01), or the
 *                plan's copy of it when the table is not there.
 *   health_read  the number audit (number_audit, BROKEN-01).
 *
 * Three rules.
 *
 * READ, NEVER COMPUTE. Each tool reads what a producer wrote. Nothing here
 * prices a trade, simulates a season or grades a check; the only arithmetic is
 * counting rows by status for a summary line, done in SQL.
 *
 * TYPED ABSENCE. A producer that has not run, a table that is not on this
 * build, a plans file that breaks the contract: each comes back as ONE row
 * { status: 'unknown' | 'failed', reason } and no numbers, so Coach refuses
 * instead of reading a missing number as 0.
 *
 * CITABLE ROWS. The ledger cites `r1#0.column` and a column must match
 * [A-Za-z_][A-Za-z0-9_]*, so a nested result is flattened here with `_`, not
 * `.` (tools.js#toRows's dotted columns cannot be cited). A player id in a
 * plan gets a `<column>_name` sibling from the league's `names`, so a claim
 * about a player cites the cell that names him.
 *
 * Behind GRIDIRON_COACH_BRAIN_TOOLS (default off; the preview switch
 * turns it on through preview-mode.js; GRIDIRON_COACH_BRAIN_TOOLS=0 vetoes
 * preview). With the flag off Coach is offered exactly the tools it had.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewUnconfirmed } from '../preview-mode.js';
import { validateLeague, SCHEMA_VERSION, SECTIONS } from '../campaign/plans-schema.js';
import { db } from '../../db/index.js';
import { openChatDb } from '../manager-signals.js';
import { identityMap } from '../manager-identity.js';

export const BRAIN_TOOLS_ENV = 'GRIDIRON_COACH_BRAIN_TOOLS';

/** On with its own flag or preview mode; its own flag set to '0' vetoes preview. */
export function brainToolsOn() {
  const own = process.env[BRAIN_TOOLS_ENV];
  if (own === '1') return true;
  if (own === '0') return false;
  return previewUnconfirmed();
}

/** Bad arguments. tools.js turns this into a CoachToolError the model sees. */
export class BrainToolInputError extends Error {
  constructor(message) { super(message); this.name = 'BrainToolInputError'; }
}

/**
 * What plan_read can be asked for: every contract section, plus one view.
 * next_move is the offer and why; next_move_playbook is the same steps' message,
 * opening, walk-away and reply table. They are split because together they
 * outgrow one tool result (ask.js cuts a result at 20,000 characters, and a cut
 * result is unreadable JSON). alternatives is the deck's headline per move.
 */
export const PLAN_SECTIONS = Object.freeze([...Object.keys(SECTIONS), 'next_move_playbook']);

const PLAYBOOK_KEYS = ['message', 'opening', 'walk_away', 'send_when', 'reply_table'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** The contract section a view reads, and how it narrows the section's value. */
const PLAN_VIEWS = Object.freeze({
  next_move: { section: 'next_move',
    narrow: m => ({ ...m, steps: (m.steps ?? []).map(st => omit(st, PLAYBOOK_KEYS)) }) },
  next_move_playbook: { section: 'next_move',
    narrow: m => ({ move_id: m.move_id, steps: (m.steps ?? []).map(st => pick(st, ['partner', 'give', 'get', ...PLAYBOOK_KEYS])) }) },
  alternatives: { section: 'alternatives',
    narrow: deck => (Array.isArray(deck) ? deck : []).map(m => ({ ...omit(m, ['reasoning']),
      steps: (m.steps ?? []).map(st => pick(st, ['partner', 'give', 'get', 'p_yes', 'title_odds_delta'])) })) }
});

/** Ceilings that keep one section from swallowing the context window. */
const MAX_COLUMNS = 300;
const MAX_TEXT = 500;

/** Keys whose string values (or list items) are player ids in plans-schema.js. */
const PID_KEYS = new Set(['give', 'get', 'player', 'target', 'max_give', 'untouchables', 'player_id', 'give_a', 'get_b']);
/** Paths into the plan that are the producer's own bookkeeping, not answers. */
const SKIP_KEYS = new Set(['cites']);
/** Typed-field metadata left out below the section level to keep a result small (the section's own is kept). */
const INNER_FIELD_SKIP = new Set(['source']);
const isTypedField = o => o && typeof o === 'object' && typeof o.status === 'string' && 'source' in o;

/* ---------------------------------------------------------------- sources */

// The profile reader is COUNTERPART-01's; on a build without it people_read is
// typed unknown rather than failing to load.
let profileReader = null;
try {
  profileReader = await import('../people/profile-reader.js');
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes('profile-reader')) throw e;
}

function defaultProfiles(leagueId) {
  if (!profileReader) return null;
  const myTeam = db.prepare('SELECT my_team_id FROM leagues WHERE id = ?').get(leagueId)?.my_team_id ?? null;
  const chat = openChatDb();
  try {
    return profileReader.readProfiles({ chat, ids: identityMap(leagueId), asOf: Date.now(), myTeam });
  } finally { chat?.close(); }
}

const sources = { profiles: defaultProfiles };

/**
 * Swap a source (tests; a later unit that wires the counterpart model).
 * `profiles: (leagueId) => readProfiles-shaped result | null`; null restores
 * "no profile reader on this build".
 */
export function setBrainSources({ profiles } = {}) {
  if (profiles !== undefined) sources.profiles = profiles ?? (() => null);
}

/* ---------------------------------------------------------------- helpers */

const unknownRow = (reason, extra = {}) => [{ status: 'unknown', reason, ...extra }];
const failedRow = (reason, extra = {}) => [{ status: 'failed', reason, ...extra }];

function leagueArg(input) {
  const n = Number(input?.league_id);
  if (!Number.isInteger(n) || n < 1) {
    throw new BrainToolInputError(`league_id must be a whole number, got ${JSON.stringify(input?.league_id)}.`);
  }
  return n;
}

function tableIn(database, name) {
  return !!database?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/* ---------------------------------------------------------------- plan_read */

export function plansPath() {
  return path.resolve(process.env.GRIDIRON_WARROOM_PLANS
    || path.join(os.homedir(), 'gridiron-local', 'warroom', 'plans.json'));
}

/**
 * Flatten one plan value into citable scalar columns joined by `_`. A player
 * id under a PID_KEYS key gets `<column>_name` from `names`.
 */
function flattenInto(out, node, prefix, names, isPid, state) {
  if (state.count >= MAX_COLUMNS) { state.dropped += 1; return; }
  const put = (key, value) => {
    if (state.count >= MAX_COLUMNS) { state.dropped += 1; return; }
    out[key] = value;
    state.count += 1;
  };
  if (node === null || typeof node !== 'object') {
    const value = typeof node === 'string' && node.length > MAX_TEXT ? `${node.slice(0, MAX_TEXT)}...` : node;
    put(prefix, value);
    if (isPid && typeof node === 'string' && Object.hasOwn(names, node)) put(`${prefix}_name`, names[node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => flattenInto(out, item, `${prefix}_${i}`, names, isPid, state));
    return;
  }
  const typed = isTypedField(node);
  for (const [key, child] of Object.entries(node)) {
    if (SKIP_KEYS.has(key) || (typed && INNER_FIELD_SKIP.has(key))) continue;
    const safe = key.replace(/[^A-Za-z0-9_]/g, '_');
    flattenInto(out, child, prefix ? `${prefix}_${safe}` : safe, names, PID_KEYS.has(key), state);
  }
}

/** Read and check the plans file. Returns { entry, doc } or { rows } (typed absence). */
function loadLeaguePlan(leagueId) {
  const file = plansPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return { rows: unknownRow('no War Room plans file yet (GRIDIRON_WARROOM_PLANS): the campaign producer has not run on this machine') };
    }
    throw e;
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    return { rows: failedRow(`the plans file is not valid JSON (${e.message})`) };
  }
  if (doc?.schema !== SCHEMA_VERSION) {
    const found = doc?.schema == null ? 'has no schema field (written by a pre-contract producer)' : `is ${JSON.stringify(doc.schema)}`;
    return { rows: failedRow(`the plans file ${found}, not the ${SCHEMA_VERSION} contract`) };
  }
  const entry = Array.isArray(doc.leagues) ? doc.leagues.find(l => l?.league === leagueId) : null;
  if (!entry) return { rows: unknownRow(`the plans file has no entry for league ${leagueId}`) };
  const head = { league_id: leagueId, plans_generated_at: doc.generated_at ?? null, plans_producer: doc.producer ?? null };
  const check = validateLeague(entry);
  if (!check.ok) {
    const first = check.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ');
    return { rows: failedRow(`league ${leagueId}'s plan breaks the ${SCHEMA_VERSION} contract at ` +
      `${check.errors.length} path(s): ${first}`, head) };
  }
  if (entry.error) return { rows: failedRow(`the producer failed for league ${leagueId}: ${entry.error}`, head) };
  return { entry, doc, head };
}

/**
 * plan_read: one section of league `league_id`'s plan as one flat row.
 * @returns {object[]} one row: { status:'ok', league_id, section, plans_generated_at, <section>_status, ... }
 *   or one typed unknown/failed row.
 */
export function planRead(input) {
  const leagueId = leagueArg(input);
  const section = String(input?.section ?? 'next_move');
  if (!PLAN_SECTIONS.includes(section)) {
    throw new BrainToolInputError(`section must be one of ${PLAN_SECTIONS.join(', ')}; got ${JSON.stringify(section)}.`);
  }
  const loaded = loadLeaguePlan(leagueId);
  if (loaded.rows) return loaded.rows.map(r => ({ ...r, section }));
  const { entry, head } = loaded;
  const view = PLAN_VIEWS[section];
  const field = entry[view?.section ?? section];
  const row = { status: 'ok', ...head, section, me: entry.me ?? null };
  const state = { count: 0, dropped: 0 };
  for (const meta of ['status', 'reason', 'source', 'se', 'clears_2se', 'as_of', 'n']) {
    if (field && meta in field) row[`${section}_${meta}`] = field[meta];
  }
  if (field?.status === 'ok') {
    const value = view ? view.narrow(field.value) : field.value;
    flattenInto(row, value, section, entry.names ?? {}, false, state);
  }
  if (state.dropped) row.columns_dropped = state.dropped;
  return [row];
}

/* ---------------------------------------------------------------- people_read */

const mentionNames = list => (Array.isArray(list) ? list.map(m => m?.player).filter(Boolean).join('; ') : '');

function overrideLabel(o) {
  if (!o || o.status === 'unknown') return 'unknown';
  if (o.exclude) return 'exclude';
  if (o.deprioritize) return 'deprioritize';
  if (o.toughen) return 'toughen';
  return 'none';
}

/** A short label is a label; anything longer is prose and stays in the profile. */
const label = v => (typeof v === 'string' && v.length <= 24 ? v : null);

/**
 * people_read: one row per counterpart. Labels and counts only: what he wants,
 * is shopping, calls untouchable (player names), how open to trading the chat
 * reads, and Nick's override, which beats everything (an excluded manager is
 * never in market). A quiet or unprofiled manager is `unknown`, in_market null.
 */
export function peopleRead(input) {
  const leagueId = leagueArg(input);
  const read = sources.profiles(leagueId);
  if (!read) return unknownRow('the counterpart profile reader (people/profile-reader.js, COUNTERPART-01) is not on this build');
  if (read.status !== 'ok') return unknownRow(read.reason ?? 'no counterpart profiles for this league');
  const asOf = iso(read.as_of);
  const wanted = input?.roster_id == null ? null : String(input.roster_id);
  const out = [];
  for (const [rosterId, p] of read.byRoster) {
    if (wanted && String(rosterId) !== wanted) continue;
    const override = overrideLabel(p.override);
    const vt = p.negotiation?.values_talk;
    const talk = vt?.status === 'ok' ? vt : null;
    const known = p.status === 'ok';
    const shopping = talk ? mentionNames(talk.shopping) : null;
    let inMarket = null;
    let basis = 'profile unknown';
    if (override === 'exclude') { inMarket = false; basis = "Nick's override: exclude"; }
    else if (known && talk) { inMarket = !!shopping; basis = shopping ? 'he has named players he would move' : 'no shop talk on record'; }
    out.push({
      roster_id: String(rosterId), status: known ? 'ok' : 'unknown', reason: known ? null : (p.reason ?? null),
      in_market: inMarket, in_market_basis: basis, nick_override: override,
      wants: talk ? mentionNames(talk.wants) : null, shopping, untouchable: talk ? mentionNames(talk.untouchable) : null,
      messages_read: p.negotiation?.status === 'ok' ? (p.negotiation.messages_read ?? null) : null,
      profile_confidence: p.negotiation?.status === 'ok' ? label(p.negotiation.confidence) : null,
      p_open_to_trade: p.chat?.status === 'ok' ? (p.chat.p_open_to_trade ?? null) : null,
      as_of: asOf
    });
  }
  if (!out.length) return unknownRow(wanted ? `no profile row for roster ${wanted}` : 'no counterparts with a profile');
  return out;
}

/* ---------------------------------------------------------------- pulse_read */

/** Label-shaped columns a statements table may carry; message text is never read. */
const PULSE_COLUMNS = ['roster_id', 'manager', 'player', 'player_id', 'label', 'kind', 'credible', 'credibility', 'at', 'created_at'];

/** pulse_read: labelled statements from the last `days` days (labels, never quotes). */
export function pulseRead(input) {
  const leagueId = leagueArg(input);
  const days = input?.days == null ? 14 : Number(input.days);
  if (!Number.isFinite(days) || days <= 0 || days > 120) throw new BrainToolInputError('days must be from 1 to 120.');
  let chat = null;
  try {
    let database = tableIn(db, 'pulse_statements') ? db : null;
    if (!database) {
      chat = openChatDb();
      if (chat && tableIn(chat, 'pulse_statements')) database = chat;
    }
    if (!database) return unknownRow('no pulse_statements table yet: PULSE-01 has not written labelled statements');
    const cols = database.prepare('PRAGMA table_info(pulse_statements)').all().map(c => c.name);
    const keep = PULSE_COLUMNS.filter(c => cols.includes(c));
    const stamp = ['at', 'created_at'].find(c => cols.includes(c));
    if (!stamp || !keep.length) return unknownRow('pulse_statements has no time or label column this tool reads');
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const where = [`${stamp} >= ?`];
    const params = [since];
    if (cols.includes('league_id')) { where.push('league_id = ?'); params.push(leagueId); }
    const found = database.prepare(`SELECT ${keep.join(', ')} FROM pulse_statements WHERE ${where.join(' AND ')}
                                    ORDER BY ${stamp} DESC LIMIT 40`).all(...params);
    if (!found.length) return unknownRow(`no labelled statements in the last ${days} days`);
    return found.map(r => ({ status: 'ok', ...r }));
  } finally { chat?.close(); }
}

/* ---------------------------------------------------------------- brain_read */

/** Same rule as the producer's brain rule: any failing check fails the brain, then any short of data. */
function overallOf(statuses) {
  if (statuses.includes('failing')) return 'failing';
  if (statuses.some(s => s !== 'passing')) return 'not_enough_data';
  return 'passing';
}

/**
 * brain_read: the newest brain_report run (one row per check, summary first),
 * or the plan's brain_report section when the table is not on this build.
 */
export function brainRead(input) {
  const leagueId = leagueArg(input);
  if (tableIn(db, 'brain_report')) {
    const latest = db.prepare('SELECT run_id, computed_at FROM brain_report ORDER BY computed_at DESC, id DESC LIMIT 1').get();
    if (latest) {
      const checks = db.prepare(`SELECT check_id, name, status, metric_name, metric, ci_low, ci_high, n, needs_text,
                                        pass_bar, source AS grade_source, computed_at
                                 FROM brain_report WHERE run_id = ? ORDER BY check_id`).all(latest.run_id);
      const summary = { row_kind: 'summary', status: 'ok', origin: 'brain_report table', league_id: leagueId,
        run_id: latest.run_id, as_of: latest.computed_at, overall: overallOf(checks.map(c => c.status)),
        checks_n: checks.length };
      return [summary, ...checks.map(c => ({ row_kind: 'check', ...c }))];
    }
  }
  const loaded = loadLeaguePlan(leagueId);
  if (loaded.rows) {
    return unknownRow(`no brain_report run on this build, and the plan could not stand in: ${loaded.rows[0].reason}`);
  }
  const field = loaded.entry.brain_report;
  if (field?.status !== 'ok') return unknownRow(field?.reason ?? 'the plan carries no brain report');
  const { overall, checks = [], blocks = [], fell_back_to: fellBack = null } = field.value;
  const summary = { row_kind: 'summary', status: 'ok', origin: 'plans file', league_id: leagueId,
    as_of: loaded.head.plans_generated_at, overall, fell_back_to: fellBack, checks_n: checks.length,
    blocks: blocks.join(' | ') || null };
  return [summary, ...checks.map(c => ({ row_kind: 'check', check_id: c.id, name: c.name, status: c.status,
    pass_bar: c.bar, result: c.result ?? null, n: c.n ?? null, computed_at: c.as_of ?? null }))];
}

/* ---------------------------------------------------------------- health_read */

/** health_read: the number audit for one league, summary counts first, broken then warn then ok. */
export function healthRead(input) {
  const leagueId = leagueArg(input);
  if (!tableIn(db, 'number_audit')) return unknownRow('no number_audit table on this build: BROKEN-01 has not run');
  const counts = db.prepare(`SELECT SUM(status = 'ok') AS ok_n, SUM(status = 'warn') AS warn_n,
                                    SUM(status = 'broken') AS broken_n, MAX(as_of) AS as_of
                             FROM number_audit WHERE league_id = ?`).get(leagueId);
  const checks = db.prepare(`SELECT check_id, status, title, detail, cause, trust, as_of, first_seen_at
                             FROM number_audit WHERE league_id = ?
                             ORDER BY CASE status WHEN 'broken' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, check_id`)
    .all(leagueId);
  if (!checks.length) return unknownRow(`the number audit has not run for league ${leagueId}`);
  return [{ row_kind: 'summary', status: 'ok', league_id: leagueId, ok_n: counts.ok_n ?? 0,
    warn_n: counts.warn_n ?? 0, broken_n: counts.broken_n ?? 0, as_of: counts.as_of },
  ...checks.map(c => ({ row_kind: 'check', ...c }))];
}

/* ---------------------------------------------------------------- descriptors */

const leagueProp = { league_id: { type: 'integer', description: "the user's league id" } };

const tool = ({ name, fn, tables, description, input_schema }) => ({
  name, kind: 'service', source: `server/services/coach/brain-tools.js#${fn.name}`, tables, description,
  input_schema, run(input) { return { value: fn(input), tables }; }
});

/** The five brain read tools, in tools.js's descriptor shape. */
export const BRAIN_TOOLS = Object.freeze([
  tool({
    name: 'plan_read', fn: planRead, tables: ['warroom_plans_file'],
    description: "Read one section of the league's War Room plan, as the campaign producer wrote it. " +
      `Sections: ${PLAN_SECTIONS.join(', ')}. next_move holds the steps (partner, give, get, p_yes, ` +
      'title_odds_delta, title_after) and reasoning (why); next_move_playbook holds the same steps\' message, ' +
      'opening, walk_away, send_when and reply_table (what to do if he accepts, declines, counters or goes ' +
      'quiet); destination holds title_now vs ' +
      'title_planned_now; feasibility holds the points goal and p_hit; flip_map and targets list flips and ' +
      'targets; alternatives is the deck, best first, which gives the partner order. Numbers sit in cells ending ' +
      '_value; each player id has a _name cell. A status of unknown or failed means the plan does not have it: say so.',
    input_schema: { type: 'object', required: ['league_id', 'section'], properties: { ...leagueProp,
      section: { type: 'string', enum: [...PLAN_SECTIONS] } } }
  }),
  tool({
    name: 'people_read', fn: peopleRead, tables: ['negotiation_profiles', 'manager_chat_profile', 'manager_notes'],
    description: 'How each other manager reads, from the counterpart profile: who is in market (and why), what he ' +
      "wants, is shopping or calls untouchable, how open to trading the chat reads, and Nick's override (exclude " +
      'beats everything). Labels and counts only, never messages. An unknown manager is unknown, not unwilling.',
    input_schema: { type: 'object', required: ['league_id'], properties: { ...leagueProp,
      roster_id: { type: 'string', description: 'one team; omit for all' } } }
  }),
  tool({
    name: 'pulse_read', fn: pulseRead, tables: ['pulse_statements'],
    description: 'Recent labelled statements by managers (what kind of thing was said about which player, and ' +
      'whether it is credible), never the words. Unknown until the pulse producer has run.',
    input_schema: { type: 'object', required: ['league_id'], properties: { ...leagueProp,
      days: { type: 'integer', description: 'look-back in days, default 14' } } }
  }),
  tool({
    name: 'brain_read', fn: brainRead, tables: ['brain_report'],
    description: "Is the brain working: the report card E1-E7, newest run, with a summary row (overall) first. " +
      'not_enough_data rows say what they still need. When a check is not passing, say the brain is not proven ' +
      'there yet.',
    input_schema: { type: 'object', required: ['league_id'], properties: { ...leagueProp } }
  }),
  tool({
    name: 'health_read', fn: healthRead, tables: ['number_audit'],
    description: 'Number health: the audit of which numbers on screen are ok, warn or broken for this league, ' +
      'summary counts first, broken checks next, each with its cause and how far to trust it.',
    input_schema: { type: 'object', required: ['league_id'], properties: { ...leagueProp } }
  })
]);
