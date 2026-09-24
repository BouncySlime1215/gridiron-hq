/**
 * Typed status for served engine rows, and the engine's own status for the strip
 * (ENGINE-ARCHITECTURE.md §2.12, §3.5; EA-03 row; UI-ENG-6).
 *
 * `rowStatus` is the one place a row's status word is decided, for /state and /view alike:
 *   ok        a healthy row, fresh within the field's max_age_sec
 *   zero      a measured absence (value null, absence zero): a real 0
 *   unknown   no row, the field is not registered, or the row says unknown
 *   stale     the producer has not run within max_age_sec before the reference time
 *   fallback  the field's fallback row is served (monitor fallback, or HEALTH-01b)
 *   thin      healthy, but built on missing/fallback inputs
 *   degraded  the row's own health is degraded
 *   last_good the newest row failed its checks and there is no fallback: the last good row
 * A failed row is never served (HEALTH-01b).
 *
 * `engineStatus` reads only: the daemon heartbeat (sync_log `engine_daemon`), the
 * engine.lock holder, adapter watermarks, per-producer version and fallbacks, the latest
 * snapshot per league and Jev spend. The web process never writes any of it.
 */
import fs from 'node:fs';
import { defaultLockPath, pidAlive } from '../process-lock.js';

export const ROW_STATUSES = Object.freeze(['ok', 'zero', 'unknown', 'stale', 'fallback', 'thin', 'degraded', 'last_good']);

/** Whole minutes from `from` to `to` (ISO strings), or null. */
export function minutesBetween(from, to) {
  if (!from || !to) return null;
  return Math.floor((Date.parse(to) - Date.parse(from)) / 60000);
}

/** [status, reason] for a served (non-failed) row, given its field spec and fresh_at, at time `ref`. */
export function rowStatus(row, spec, fresh, ref) {
  const absence = row.health?.absence;
  if (row.value == null && absence) {
    return absence.status === 'zero' ? ['zero', absence.reason] : ['unknown', `${absence.status}: ${absence.reason}`];
  }
  if (row.health?.status === 'degraded') return ['degraded', 'the row was built on degraded inputs'];
  if (row.health?.inputs_health === 'thin') return ['thin', 'some inputs were missing or served from a fallback'];
  if (spec.maxAgeSec != null && (!fresh || Date.parse(ref) - Date.parse(fresh) > spec.maxAgeSec * 1000)) {
    return ['stale', `no run of ${spec.producer} within ${spec.maxAgeSec}s before ${ref}`];
  }
  return ['ok', null];
}

/* --------------------------------------------------------------- engine status */
const HEARTBEAT_JOB = 'engine_daemon';
/** The daemon loops every 300-900 s (scripts/engine-daemon.mjs); the strip turns red past 3x the longest. */
export function tickIntervalSec(env = process.env) {
  const n = Number(env.ENGINE_TICK_INTERVAL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

function ageSec(iso, now) {
  return iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null;
}

function daemonStatus(database, now, env) {
  const beat = database.prepare(`SELECT last_run_at, last_status, last_detail FROM sync_log WHERE job = ?`).get(HEARTBEAT_JOB);
  if (!beat) return { status: 'unknown', reason: 'no heartbeat: the engine daemon has never run here', last_beat_at: null, age_sec: null };
  const age = ageSec(beat.last_run_at, now);
  const limit = 3 * tickIntervalSec(env);
  if (age > limit) {
    return { status: 'stale', reason: `last heartbeat ${Math.floor(age / 60)} min ago (limit ${Math.floor(limit / 60)} min)`,
      last_beat_at: beat.last_run_at, age_sec: age };
  }
  if (beat.last_status === 'error') {
    return { status: 'degraded', reason: 'the last tick recorded failures', last_beat_at: beat.last_run_at, age_sec: age,
      detail: beat.last_detail };
  }
  return { status: 'ok', reason: null, last_beat_at: beat.last_run_at, age_sec: age };
}

function lockStatus(dbPath, env) {
  const file = env.GRIDIRON_ENGINE_LOCK || (dbPath ? defaultLockPath(dbPath, 'engine.lock') : null);
  if (!file) return { status: 'unknown', reason: 'no lock path' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'unknown', reason: 'no engine.lock: no daemon holds the lock' };
    throw error;
  }
  let holder;
  try {
    holder = JSON.parse(text);
  } catch {
    return { status: 'degraded', reason: 'engine.lock is not readable JSON' };
  }
  const alive = Number.isInteger(holder.pid) && pidAlive(holder.pid);
  return { status: alive ? 'ok' : 'stale', reason: alive ? null : `pid ${holder.pid} is not running on this host`,
    holder: { pid: holder.pid, host: holder.host, started_at: holder.started_at } };
}

function jevStatus(database) {
  const spec = database.prepare(`SELECT field FROM engine_fields WHERE field = 'engine.jev'`).get();
  if (!spec) return { status: 'unknown', reason: 'Jev not live: nothing writes engine.jev yet' };
  const r = database.prepare(`SELECT value, as_of FROM engine_state WHERE entity_type = 'engine' AND entity_id = 'jev'
      AND field = 'engine.jev' AND lane = 'live' AND json_extract(health, '$.status') <> 'failed'
      ORDER BY id DESC LIMIT 1`).get();
  const v = r?.value == null ? null : JSON.parse(r.value);
  const spend = v?.spend_today_usd;
  if (typeof spend !== 'number') return { status: 'unknown', reason: 'Jev not live: no spend recorded yet' };
  return { status: spend === 0 ? 'zero' : 'ok', spend_usd: spend, balance_usd: v.balance_usd ?? null, as_of: r.as_of };
}

/** Everything the status strip and its per-producer sheet show. */
export function engineStatus(database, { now = Date.now(), dbPath = null, env = process.env } = {}) {
  const t = typeof now === 'number' ? now : Date.parse(now);
  const fallbacks = database.prepare(`SELECT f.field, f.league_id, f.fallback_field, f.since, f.reason, f.n, x.producer
      FROM engine_fallback f LEFT JOIN engine_fields x ON x.field = f.field ORDER BY f.field, f.league_id`).all();
  const runs = database.prepare(`SELECT producer, MAX(CASE WHEN error IS NULL THEN finished_at END) AS last_ok,
      MAX(CASE WHEN error IS NOT NULL THEN finished_at END) AS last_error_at FROM engine_runs GROUP BY producer`).all();
  const runOf = Object.fromEntries(runs.map(r => [r.producer, r]));
  const producers = database.prepare(`SELECT producer, version, status FROM engine_producers
      WHERE status = 'active' ORDER BY producer`).all().map(p => ({
    producer: p.producer, version: p.version, status: p.status,
    last_run_at: runOf[p.producer]?.last_ok ?? null, last_error_at: runOf[p.producer]?.last_error_at ?? null,
    fallbacks: fallbacks.filter(f => f.producer === p.producer)
      .map(f => ({ field: f.field, fallback_field: f.fallback_field, league_id: f.league_id, since: f.since, reason: f.reason, n: f.n })),
  }));
  const snapshots = database.prepare(`SELECT league_id, MAX(id) AS id, MAX(created_at) AS created_at FROM engine_snapshots
      GROUP BY league_id ORDER BY league_id`).all()
    .map(s => ({ league_id: s.league_id, id: Number(s.id), created_at: s.created_at, age_sec: ageSec(s.created_at, t) }));
  const sources = database.prepare(`SELECT producer, version, source, watermark, updated_at FROM engine_cursors
      ORDER BY source`).all();
  return {
    now: new Date(t).toISOString(),
    daemon: daemonStatus(database, t, env),
    lock: lockStatus(dbPath, env),
    sources,
    producers,
    snapshots,
    jev: jevStatus(database),
  };
}
