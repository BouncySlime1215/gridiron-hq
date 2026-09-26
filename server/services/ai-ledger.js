/**
 * SPEND-SERVER: where every AI call is written, tagged with where it came from.
 *
 *   source   GRIDIRON_AI_SOURCE: 'app' (the server; the default), 'offline' (refresh.sh and
 *            the jobs), 'test' (test harnesses, judges, builders on DB copies). Any other
 *            value is refused before the call is made.
 *   call_id  one id per call (migration 117), the key the shared ledger is ingested by.
 *
 * THE SHARED LEDGER. A process on a COPY of the database (a judge, a builder's probe) writes
 * its calls into the copy, which the live app never reads, so that spend was invisible. With
 * GRIDIRON_AI_LEDGER set to a file, a source=test process also appends each real call to it
 * as one JSON line (append-only; the process never opens the live database). The app ingests
 * that file into its own ai_usage by call_id (INSERT OR IGNORE), so a line counts once however
 * often it is read. Stand-in clients (tests) never append: their calls cost nothing.
 *
 * Default shared file: ~/gridiron-local/ai-usage-offline.jsonl (the app reads it; a writer
 * must name it explicitly in GRIDIRON_AI_LEDGER).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rows, run } from '../db/index.js';

export const SOURCE_ENV = 'GRIDIRON_AI_SOURCE';
export const LEDGER_ENV = 'GRIDIRON_AI_LEDGER';
export const SOURCES = Object.freeze(['app', 'offline', 'test']);
export const DEFAULT_SHARED_LEDGER = path.join(os.homedir(), 'gridiron-local', 'ai-usage-offline.jsonl');
/** A shared file larger than this is not read whole (it is a ledger of a few thousand calls, not a log). */
const MAX_LEDGER_BYTES = 20 * 1024 * 1024;

/** This process's source tag. An unknown value throws: a mistagged call is worse than no call. */
export function aiSource(env = process.env) {
  const v = env[SOURCE_ENV];
  if (v == null || v === '') return 'app';
  if (!SOURCES.includes(v)) throw Object.assign(new Error(`${SOURCE_ENV} must be one of ${SOURCES.join(', ')}, not ${JSON.stringify(v)}`), { status: 500 });
  return v;
}

let columns = null;
/** The ai_usage columns; cached only once the SPEND-SERVER columns exist (re-read until migration 117 has run). */
const cols = () => {
  if (columns) return columns;
  const found = new Set(rows('PRAGMA table_info(ai_usage)').map(c => c.name));
  if (found.has('source') && found.has('call_id')) columns = found;
  return found;
};
/** Tests: forget the cached column list (a fresh database). */
export const resetLedgerColumns = () => { columns = null; };

/**
 * Write one call. `real` is false for a stand-in client (nothing was spent, nothing is
 * shared). Returns { cost, id, call_id, source }.
 */
export function writeUsage({ feature, model, usage = {}, cost = 0, error = null, real = true, env = process.env, now = new Date() }) {
  const source = aiSource(env);
  const callId = crypto.randomUUID();
  const c = cols();
  const extra = [['source', source], ['call_id', callId], ['error', error]].filter(([k]) => c.has(k));
  const fields = ['date', 'feature', 'model', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cost_usd', 'calls',
    ...extra.map(([k]) => k)];
  const values = [now.toISOString().slice(0, 10), feature, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0, cost ?? 0, 1, ...extra.map(([, v]) => v)];
  const r = run(`INSERT INTO ai_usage (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, ...values);
  if (real && source !== 'app' && env[LEDGER_ENV]) appendShared(env[LEDGER_ENV], { v: 1, call_id: callId, source, created_at: now.toISOString(),
    feature, model, input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cost_usd: cost ?? 0, error });
  return { cost, id: Number(r?.lastInsertRowid ?? 0) || null, call_id: callId, source };
}

/** One JSON line, appended (O_APPEND: whole lines, no read-modify-write). A failure is said, not swallowed. */
function appendShared(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { flag: 'a' });
  } catch (e) {
    console.error(`[ai] could not append call ${line.call_id} to the shared ledger ${file}: ${e.message}. Its cost is only in this database.`);
  }
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Ingest the shared ledger into this database (the app's). Idempotent by call_id. A line that
 * does not parse, or is not a test/offline call, is skipped and counted, never guessed at.
 * -> { status, read, inserted, skipped, file }
 */
export function ingestShared({ file = process.env[LEDGER_ENV] || DEFAULT_SHARED_LEDGER, env = process.env } = {}) {
  if (aiSource(env) !== 'app') return { status: 'not_app', read: 0, inserted: 0, skipped: 0, file };
  if (!cols().has('call_id') || !cols().has('source')) return { status: 'no_columns', read: 0, inserted: 0, skipped: 0, file };
  let stat;
  try { stat = fs.statSync(file); } catch (e) {
    if (e.code === 'ENOENT') return { status: 'no_file', read: 0, inserted: 0, skipped: 0, file };
    throw e;
  }
  if (stat.size > MAX_LEDGER_BYTES) {
    console.error(`[ai] the shared ledger ${file} is ${stat.size} bytes (over ${MAX_LEDGER_BYTES}); not ingested`);
    return { status: 'too_large', read: 0, inserted: 0, skipped: 0, file };
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let inserted = 0;
  let skipped = 0;
  for (const text of lines) {
    let l;
    try { l = JSON.parse(text); } catch { skipped++; continue; }
    const cost = num(l.cost_usd);
    if (typeof l.call_id !== 'string' || !l.call_id || !['test', 'offline'].includes(l.source) || typeof l.feature !== 'string'
      || typeof l.created_at !== 'string' || Number.isNaN(Date.parse(l.created_at)) || cost == null) { skipped++; continue; }
    const at = new Date(l.created_at).toISOString();
    const r = run(`INSERT OR IGNORE INTO ai_usage (date, feature, model, input_tokens, output_tokens, cache_read_input_tokens,
                     cache_creation_input_tokens, cost_usd, calls, source, call_id, created_at${cols().has('error') ? ', error' : ''})
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?${cols().has('error') ? ', ?' : ''})`,
    at.slice(0, 10), l.feature, l.model ?? null, num(l.input_tokens) ?? 0, num(l.output_tokens) ?? 0, num(l.cache_read_input_tokens) ?? 0,
    num(l.cache_creation_input_tokens) ?? 0, cost, l.source, l.call_id, at.replace('T', ' ').slice(0, 19),
    ...(cols().has('error') ? [typeof l.error === 'string' ? l.error : null] : []));
    if (Number(r?.changes) > 0) inserted++;
  }
  if (skipped) console.warn(`[ai] ${skipped} line(s) of the shared ledger ${file} were not calls and were skipped`);
  return { status: 'ok', read: lines.length, inserted, skipped, file };
}
