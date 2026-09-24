/**
 * COACH-LINK (3): answer memory. Every Coach answer that passed the grounding
 * check is kept with what it stood on, and the `recall` tool finds, cites and
 * dates prior answers.
 *
 * WHAT IS KEPT (rememberAnswer, called from ask.js after verify.js passes):
 * the claims and their cites; each number served, with the cell that grounded
 * it; each source cell (tool, tables, column, value); the entities the answer
 * touched (connect's entity_key, any player named in a cited cell); and one
 * STAMP per source, taken at answer time. An answer that stands only on other
 * recalled answers is not kept again: memory of memory would launder age.
 *
 * STALE. A remembered answer is stale when a source it stood on has changed
 * since (its stamp no longer matches) or it is older than MAX_AGE_DAYS. The
 * stamp is cheap and conservative: row count, highest rowid and the newest
 * time column for a table; generated_at for the plans file. Any change reads as
 * stale, including one that did not touch the cited cell. Over-calling stale
 * costs a re-ask; under-calling it serves an old number as current, which is
 * the failure this app cares most about.
 *
 * WHAT RECALL SERVES. One row per remembered claim. A fresh row carries
 * `claim_text` and its served numbers (`served_<i>_value`), which verify.js
 * lets Coach restate with a cite. A stale row carries `stale_claim_text` and
 * no numbers, so a stale number can be mentioned as history only by re-reading
 * it from the source, never from memory.
 */
import fs from 'node:fs';
import { db, rows, row, run } from '../../db/index.js';
import { openChatDb } from '../manager-signals.js';
import { plansPath } from './brain-tools.js';
import { buildEntityMap, resolveEntity, tableIn } from './entity-map.js';
import { leagueArg, LinkToolInputError } from './connect.js';

/** Past this a remembered answer is stale whatever its stamps say. */
export const MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
const PLANS_SOURCE = 'warroom_plans_file';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Time columns a stamp takes the newest of, so an in-place update (ON CONFLICT DO UPDATE keeps the rowid) still moves it. */
const TIME_COLS = ['as_of', 'computed_at', 'updated_at', 'fetched_at', 'created_at', 'resolved_at', 'first_seen_time'];
const NAME_COL = /(?:^|_)(?:name|player)$/;

/* ---------------------------------------------------------------- stamps */

function tableStamp(database, table) {
  const def = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const cols = database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(c => c.name);
  const rowid = /WITHOUT\s+ROWID/i.test(def?.sql ?? '') ? 'NULL' : 'MAX(rowid)';
  const times = TIME_COLS.filter(c => cols.includes(c)).map(c => `COALESCE(MAX(${c}), '')`);
  const r = database.prepare(`SELECT COUNT(*) AS n, ${rowid} AS m${times.length ? `, ${times.join(' || \'|\' || ')} AS t` : ''}
                              FROM ${JSON.stringify(table)}`).get();
  return `n:${r.n}|max:${r.m ?? ''}|t:${r.t ?? ''}`;
}

function plansStamp() {
  let text;
  try { text = fs.readFileSync(plansPath(), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return 'absent';
    throw e;
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return `unreadable:${e.message.length}:${text.length}`; }
  return `generated_at:${doc?.generated_at ?? ''}`;
}

/**
 * The current stamp of one source: the plans file, a table in the app DB, or
 * a table in the private chat DB. 'absent' when none has it.
 */
export function stampFor(sourceName, { chat = undefined } = {}) {
  if (sourceName === PLANS_SOURCE) return plansStamp();
  if (!IDENT.test(sourceName)) return 'absent';
  if (tableIn(db, sourceName)) return tableStamp(db, sourceName);
  const own = chat === undefined;
  const c = own ? openChatDb() : chat;
  try {
    return c && tableIn(c, sourceName) ? `chat:${tableStamp(c, sourceName)}` : 'absent';
  } finally { if (own) c?.close(); }
}

/* ---------------------------------------------------------------- remember */

/** The row cells behind one cite, derived values unrolled to their inputs. */
function sourcesOf(ledger, cite) {
  const out = [];
  for (const cell of ledger.trace(cite)) {
    if (cell.kind === 'derived') {
      const d = ledger.derived.find(x => x.id === cell.id);
      out.push({ cite: cell.id, tool: 'compute', tables: [], column: null, value: cell.value, formula: d?.formula ?? null });
      continue;
    }
    const q = ledger.queries.find(x => x.id === cell.query);
    out.push({ cite: cell.id, tool: q?.tool ?? 'sql_select', tables: q?.tables ?? [], column: cell.id.split('.').pop(), value: cell.value, query: cell.query });
  }
  return out;
}

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Keep one grounded answer. Returns the memory id, or null with no write when
 * the answer did not verify, has no claims, or stands only on recalled answers.
 */
export function rememberAnswer({ leagueId = null, question, answer, ledger, verification, auditId = null, now = Date.now() }) {
  if (!verification?.ok || !answer?.claims?.length || !ledger) return null;
  const sources = [];
  const served = [];
  answer.claims.forEach((claim, claimIndex) => {
    for (const cite of claim.cites ?? []) {
      const found = sourcesOf(ledger, cite);
      sources.push(...found.map(s => ({ ...s, claim_index: claimIndex })));
      const top = found[0];
      if (top && typeof top.value === 'number' && Number.isFinite(top.value)) {
        served.push({ claim_index: claimIndex, cite, value: top.value, tool: top.tool, column: top.column });
      }
    }
  });
  const grounded = sources.filter(s => s.tool !== 'compute');
  if (!grounded.length || grounded.every(s => s.tool === 'recall')) return null;

  const entities = new Set();
  for (const s of grounded) {
    const q = ledger.queries.find(x => x.id === s.query);
    const r = q?.rows?.[Number(/#(\d+)\./.exec(s.cite)?.[1])];
    if (q?.rows?.[0]?.entity_key) entities.add(q.rows[0].entity_key);
    for (const [col, value] of Object.entries(r ?? {})) {
      if (typeof value === 'string' && NAME_COL.test(col)) entities.add(`name:${norm(value.replace(/\s*\([^)]*\)\s*$/, ''))}`);
    }
  }
  const names = new Set();
  for (const s of grounded) {
    if (s.tool === 'recall') continue;
    if (s.tables.includes(PLANS_SOURCE) || s.tool === 'plan_read' || s.tool === 'brain_read') names.add(PLANS_SOURCE);
    for (const t of s.tables) names.add(t);
  }
  const chat = openChatDb();
  let stamps;
  try { stamps = Object.fromEntries([...names].sort().map(n => [n, stampFor(n, { chat })])); } finally { chat?.close(); }

  const search = norm([question, ...answer.claims.map(c => c.text), ...[...entities].map(e => e.replace(/^\w+:/, ''))].join(' '));
  const info = run(`INSERT INTO coach_answer_memory
      (league_id, audit_id, asked_at, question, claims_json, served_json, sources_json, stamps_json, entities_json, search_text, as_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  leagueId, auditId, new Date(now).toISOString(), String(question),
  JSON.stringify(answer.claims), JSON.stringify(served),
  JSON.stringify(grounded.map(({ query, ...s }) => s)), JSON.stringify(stamps),
  JSON.stringify([...entities]), search, answer.as_of ?? null);
  return Number(info.lastInsertRowid);
}

/* ---------------------------------------------------------------- staleness */

/** { stale, reason } for one memory row, now. */
export function staleness(mem, { now = Date.now(), chat = undefined } = {}) {
  const age = now - Date.parse(mem.asked_at);
  if (!Number.isFinite(age)) return { stale: true, reason: 'the answer has no readable time' };
  if (age > MAX_AGE_DAYS * DAY_MS) return { stale: true, reason: `older than ${MAX_AGE_DAYS} days` };
  const stamps = JSON.parse(mem.stamps_json);
  const changed = Object.entries(stamps).filter(([n, s]) => stampFor(n, { chat }) !== s).map(([n]) => n);
  if (changed.length) return { stale: true, reason: `${changed.join(', ')} changed since this answer` };
  return { stale: false, reason: null };
}

/* ---------------------------------------------------------------- recall */

const STOP = new Set(['the', 'and', 'for', 'what', 'who', 'how', 'why', 'with', 'this', 'that', 'did', 'does', 'was', 'are', 'you',
  'coach', 'say', 'said', 'about', 'from', 'have', 'has', 'his', 'her', 'its', 'our', 'my', 'me', 'is', 'do', 'of', 'to', 'in', 'on', 'a', 'i']);
const tokens = s => norm(s).split(' ').filter(w => w.length >= 2 && !STOP.has(w));

/**
 * recall: prior grounded answers that match a question or an entity, newest
 * best first, one row per claim, stale ones marked and stripped of numbers.
 */
export function recall(input, { now = Date.now() } = {}) {
  const leagueId = leagueArg(input);
  const query = String(input?.query ?? '').trim();
  const entityQuery = String(input?.entity ?? '').trim();
  if (!query && !entityQuery) throw new LinkToolInputError('recall needs a query (what was asked) or an entity (who it was about).');
  const limit = input?.limit == null ? 5 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new LinkToolInputError('limit must be from 1 to 10.');
  if (!tableIn(db, 'coach_answer_memory')) return [{ status: 'unknown', reason: 'no coach_answer_memory table on this build (migration 098)' }];

  let entityKeys = [];
  if (entityQuery) {
    const map = buildEntityMap(leagueId);
    const found = map.status === 'ok' ? resolveEntity(map, entityQuery) : { status: 'unknown', reason: map.reason };
    if (found.status !== 'ok') return [{ status: 'unknown', reason: found.reason }];
    const label = found.entity.label ? String(found.entity.label).trim().split(/\s+/) : [];
    // The plans file writes "M. Oduya"; players rows write the full name. Both are the same key here.
    entityKeys = [found.entity.key, ...(label.length ? [`name:${norm(label.join(' '))}`] : []),
      ...(label.length > 1 ? [`name:${norm(`${label[0][0]} ${label.slice(1).join(' ')}`)}`] : [])];
  }
  const want = tokens(query);
  const scored = rows(`SELECT * FROM coach_answer_memory WHERE league_id = ? ORDER BY id DESC LIMIT 500`, leagueId)
    .map(m => {
      const have = new Set(m.search_text.split(' '));
      const ents = JSON.parse(m.entities_json);
      const entityHit = entityKeys.some(k => ents.includes(k));
      const overlap = want.filter(w => have.has(w)).length;
      return { m, score: (entityHit ? 10 : 0) + overlap, entityHit, overlap };
    })
    .filter(s => (entityKeys.length ? s.entityHit : true) && (want.length ? s.overlap > 0 : true))
    .sort((a, b) => b.score - a.score || b.m.id - a.m.id)
    .slice(0, limit);
  if (!scored.length) return [{ status: 'unknown', reason: `no prior grounded answer matches${query ? ` "${query}"` : ''}${entityQuery ? ` about ${entityQuery}` : ''}` }];

  const chat = openChatDb();
  try {
    const out = [];
    for (const { m } of scored) {
      const { stale, reason } = staleness(m, { now, chat });
      const claims = JSON.parse(m.claims_json);
      const served = JSON.parse(m.served_json);
      const sources = JSON.parse(m.sources_json);
      claims.forEach((c, i) => {
        const r = { row_kind: 'memory', status: 'ok', memory_id: m.id, audit_id: m.audit_id, claim_index: i,
          asked_at: m.asked_at, age_days: Math.floor((now - Date.parse(m.asked_at)) / DAY_MS),
          question: m.question, stale, stale_reason: reason,
          sources: [...new Set(sources.filter(s => s.claim_index === i).map(s => `${s.tool}.${s.column ?? s.cite}`))].join('; ') || null,
          as_of: m.as_of };
        if (stale) r.stale_claim_text = c.text;
        else {
          r.claim_text = c.text;
          served.filter(s => s.claim_index === i).forEach((s, k) => { r[`served_${k}_value`] = s.value; r[`served_${k}_source`] = `${s.tool}.${s.column}`; });
        }
        out.push(r);
      });
    }
    return out;
  } finally { chat?.close(); }
}

/** One remembered answer by id (the Dev Hub, a test). */
export const memoryRow = id => row('SELECT * FROM coach_answer_memory WHERE id = ?', id);

export const RECALL_TOOL = Object.freeze({
  name: 'recall', kind: 'service', source: 'server/services/coach/recall.js#recall', tables: ['coach_answer_memory'],
  description: 'Find what Coach said before: prior answers that passed the grounding check, matched by the question ' +
    'asked or by an entity (player or team), newest best first, one row per claim. A fresh row carries claim_text and ' +
    'the numbers it served (served_N_value), which you may restate citing that cell, saying when it was said (age_days). ' +
    'A row with stale true has stale_claim_text and no numbers: a source it stood on has changed or it is older than ' +
    `${MAX_AGE_DAYS} days. Say it is out of date and why (stale_reason), and re-read the source for the current number.`,
  input_schema: { type: 'object', required: ['league_id'], properties: {
    league_id: { type: 'integer', description: "the user's league id" },
    query: { type: 'string', description: 'what was asked, in a few words' },
    entity: { type: 'string', description: 'a player or team, as connect takes it' },
    limit: { type: 'integer', description: 'answers to return, 1-10, default 5' } } },
  run(input) { return { value: recall(input), tables: this.tables }; }
});
