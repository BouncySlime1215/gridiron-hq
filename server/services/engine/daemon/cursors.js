/**
 * Cursors and the incremental adapters (ENGINE-ARCHITECTURE.md §2.6, §3.1, §4.3 steps 1, 6).
 *
 * `engine_cursors` (producer, version, source) -> watermark is the daemon's bookkeeping:
 *   - per adapter stream (producer `engine-adapters`): how far into its source table the
 *     last successful pass read;
 *   - per (heavy producer, league) (`league:<id>`): the input cut of its last successful
 *     run, as JSON {event, state}; the dirty bit is "an input moved past it" (tick.js);
 *   - per hook (`engine-hooks`): the local day / scoring period it last fired for.
 * A cursor advances only on success, so a failed pass or run keeps its work pending.
 *
 * Incremental adapters. Each tick reads only the source rows past the stream's watermark,
 * maps them with the EA-00 adapters (backfill.js ADAPTERS, unchanged) and appends through
 * appendEvents, whose compare-latest dedupe makes a re-read row free. Watermarks:
 *   transactions     last_seen_at (the collector re-stamps it on every sighting, and a
 *                    status change is an in-place update of the same row)
 *   lineups          changed_at
 *   news             id (append-only inserts)
 *   game_lines       fetched_at        schedule (nfl.game)  fetched_at
 *   injuries         season*100+week (no row stamp: modified_at is empty all 2025-26);
 *                    the latest week is re-read each tick
 *   trade_outcomes   id, and resolved_at (a resolution updates the row in place)
 *   manager_signals  computed_at
 *   people_pulse     id (append-only inserts)
 *   coverage         sync_log.last_run_at, excluding the daemon's own heartbeat row
 *                    (its own run would otherwise be news to itself every tick)
 * Stamps compare inclusively (>=): a row written later with the same stamp is still seen.
 * Updates that move no watermark column (an opening line filled in, a news row edited) are
 * picked up by the daily full sweep (`sweep: true`), which reads every row once a day.
 *
 * Coverage: every adapter pass is an engine_runs row (producer `engine-adapters`, scope
 * `source:<stream>`) with events appended, re-reads skipped, or its error; sync_log itself
 * becomes `source.coverage` events. Provenance: a stream's first pass (no cursor yet) is a
 * backfill ('reconstructed'); every later pass is 'captured'.
 */
import { appendEvents } from '../events.js';
import { ADAPTERS } from '../backfill.js';
import { SCHEDULE_ADAPTER } from '../adapters/schedule.js';
import { recordRun } from '../fields.js';
import { assertWriteRole } from '../role.js';

export const ADAPTER_PRODUCER = 'engine-adapters';
export const ADAPTER_VERSION = '1';
export const HEARTBEAT_JOB = 'engine_daemon';
const CHUNK = 2000;

export function getCursor(producer, version, source, database) {
  const r = database.prepare('SELECT watermark FROM engine_cursors WHERE producer = ? AND version = ? AND source = ?')
    .get(producer, String(version), source);
  return r ? r.watermark : undefined;
}

export function setCursor(producer, version, source, watermark, database, now = new Date()) {
  assertWriteRole('setCursor');
  database.prepare(`INSERT INTO engine_cursors (producer, version, source, watermark, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (producer, version, source) DO UPDATE SET watermark = excluded.watermark, updated_at = excluded.updated_at`)
    .run(producer, String(version), source, watermark == null ? null : String(watermark), new Date(now).toISOString());
}

/** A stamp column: rows with col >= watermark and <= the max seen now. */
const stamp = (col, extra = '') => ({
  max: (t, db) => db.prepare(`SELECT MAX(${col}) AS m FROM ${t} WHERE ${col} IS NOT NULL ${extra}`).get().m ?? null,
  where: (wm, m) => (wm == null
    ? { sql: `${col} <= ? ${extra}`, params: [m] }
    : { sql: `${col} >= ? AND ${col} <= ? ${extra}`, params: [wm, m] }),
});
/** An integer column: rows with col > watermark and <= the max now. */
const serial = (col, extra = '') => ({
  max: (t, db) => { const m = db.prepare(`SELECT MAX(${col}) AS m FROM ${t} ${extra ? `WHERE 1 ${extra}` : ''}`).get().m; return m == null ? null : Number(m); },
  where: (wm, m) => (wm == null
    ? { sql: `${col} <= ? ${extra}`, params: [m] }
    : { sql: `${col} > ? AND ${col} <= ? ${extra}`, params: [Number(wm), m] }),
});
/** An integer key re-read inclusively (the latest week of injuries is re-read each tick). */
const inclusive = expr => ({
  max: (t, db) => { const m = db.prepare(`SELECT MAX(${expr}) AS m FROM ${t}`).get().m; return m == null ? null : Number(m); },
  where: (wm, m) => (wm == null
    ? { sql: `${expr} <= ?`, params: [m] }
    : { sql: `${expr} >= ? AND ${expr} <= ?`, params: [Number(wm), m] }),
});
/** Several watermark columns OR-ed; the watermark is JSON {col: value}. */
const either = parts => ({
  max: (t, db) => {
    const out = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, p.max(t, db)]));
    return Object.values(out).every(v => v == null) ? null : JSON.stringify(out);
  },
  where: (wmText, mText) => {
    const wm = wmText ? JSON.parse(wmText) : {};
    const m = JSON.parse(mText);
    const clauses = []; const params = [];
    for (const [k, p] of Object.entries(parts)) {
      if (m[k] == null) continue;
      const w = p.where(wm[k] ?? null, m[k]);
      clauses.push(`(${w.sql})`); params.push(...w.params);
    }
    return { sql: clauses.join(' OR ') || '0', params };
  },
});

export const CURSOR_SPECS = Object.freeze({
  transactions: stamp('last_seen_at'),
  lineups: stamp('changed_at'),
  news: serial('id'),
  game_lines: stamp('fetched_at'),
  schedule: stamp('fetched_at'),
  injuries: inclusive('(season * 100 + week)'),
  trade_outcomes: either({ id: serial('id'), resolved_at: stamp('resolved_at') }),
  manager_signals: stamp('computed_at'),
  people_pulse: serial('id'),
  coverage: { ...stamp('last_run_at', `AND job <> '${HEARTBEAT_JOB}'`), full: `job <> '${HEARTBEAT_JOB}'` },
});

/** Every stream the daemon ingests, in order: the backfill adapters (EA-00's eight + PULSE-01's people_pulse), then the schedule. */
export const DAEMON_ADAPTERS = Object.freeze([...ADAPTERS, SCHEDULE_ADAPTER]);

const tableExists = (database, t) =>
  !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
const present = v => v != null && v !== '';

/** One incremental pass of one stream. Throws on any error (the caller records it). */
export function runAdapterStream(adapter, { database, sweep = false }) {
  const spec = CURSOR_SPECS[adapter.stream];
  if (!spec) throw new Error(`no cursor spec for stream ${adapter.stream}`);
  const t = adapter.table;
  if (!tableExists(database, t)) return { table_state: 'table_absent', source_rows: null, inserted: null, skipped: null };
  const wm = getCursor(ADAPTER_PRODUCER, ADAPTER_VERSION, adapter.stream, database);
  const provenance = wm === undefined ? 'reconstructed' : 'captured';
  const max = spec.max(t, database);
  if (max == null) {
    // An empty table: mark the stream as started, so rows that arrive later count as captured.
    if (wm === undefined) setCursor(ADAPTER_PRODUCER, ADAPTER_VERSION, adapter.stream, '', database);
    return { table_state: 'present', source_rows: 0, inserted: 0, skipped: 0, watermark: wm ?? null, provenance };
  }
  // First pass and the daily sweep read every row (rows with a NULL stamp included).
  const cond = sweep || wm == null || wm === '' ? { sql: spec.full ?? '1', params: [] } : spec.where(wm, max);
  const base = typeof adapter.sql === 'function' ? adapter.sql(t, database) : adapter.sql;
  const ctx = adapter.context ? adapter.context(database) : {};
  const source = adapter.source ?? adapter.table;
  let sourceRows = 0; let inserted = 0; let skipped = 0;
  const added = [];
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    const r = appendEvents(batch, { database });
    inserted += r.inserted; skipped += r.skipped; added.push(...r.events); batch = [];
  };
  for (const r of database.prepare(`${base} WHERE ${cond.sql}`).all(...cond.params)) {
    sourceRows += 1;
    for (const ev of adapter.map(r, ctx)) {
      if (!present(ev.as_of) && ev.as_of_quality !== 'first_seen') continue;
      batch.push({ provenance, ...ev, source });
      if (batch.length >= CHUNK) flush();
    }
  }
  flush();
  setCursor(ADAPTER_PRODUCER, ADAPTER_VERSION, adapter.stream, max, database);
  return { table_state: 'present', source_rows: sourceRows, inserted, skipped, watermark: max, provenance, events: added };
}

/**
 * Run every adapter once. Each stream is isolated: an error is recorded against that
 * stream (engine_runs error row), its watermark stays, and the others proceed.
 * `shouldStop()` is checked between streams (SIGTERM finishes the current source, then stops).
 */
export function runAdapters({ database, tickId = null, sweep = false, adapters = DAEMON_ADAPTERS,
  shouldStop = () => false } = {}) {
  const streams = [];
  const events = [];
  let stopped = false;
  for (const adapter of adapters) {
    if (shouldStop()) { stopped = true; break; }
    const startedAt = new Date().toISOString();
    let out; let error = null;
    try {
      out = runAdapterStream(adapter, { database, sweep });
    } catch (e) {
      error = e;
      out = { table_state: 'error', source_rows: null, inserted: null, skipped: null };
    }
    recordRun({ producer: ADAPTER_PRODUCER, version: ADAPTER_VERSION, scopeKey: `source:${adapter.stream}`, tickId,
      startedAt, rowsWritten: out.inserted, rowsUnchanged: out.skipped,
      error: error ? String(error.message ?? error).slice(0, 500) : null, dirtyReason: sweep ? 'sweep' : 'tick' }, database);
    if (out.events) events.push(...out.events);
    const { events: _drop, ...summary } = out;
    streams.push({ stream: adapter.stream, ...summary, error: error ? String(error.message ?? error) : null });
  }
  return { streams, events, stopped };
}
