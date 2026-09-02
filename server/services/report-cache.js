/**
 * Heavy reports, computed off the request thread.
 *
 * Node serves every request on one thread. A report that replays five
 * seasons (the abstention audit, ~66 s) or refits a thousand games (the
 * football-first coefficients, ~90 s) does not just make its own endpoint
 * slow — while it runs, every other endpoint waits behind it, which is how a
 * 0.17-second profitability read timed out at 120 s during the diagnostic.
 * compute-cache.js already keeps a fingerprinted in-memory answer, but a
 * miss still computes inline, and the hourly line sync now bumps the
 * fingerprint every hour.
 *
 * This module keeps the answer in SQLite and computes it in a worker thread
 * (its own SQLite connection; WAL allows the concurrent reader). A route
 * returns whatever is stored immediately — with `computed_at`, `duration_ms`
 * and a `stale` flag when the data fingerprint has moved — and never blocks.
 * The scheduler refreshes stale reports on the growth tick; a route can also
 * ask for a refresh, which is queued, never awaited.
 *
 * PROFITABILITY_PLAN.md speed contract: dashboard summaries p95 < 250 ms;
 * "no model rebuild, data sync, or full-table hash on a read request."
 */
import { Worker } from 'node:worker_threads';
import { db, rows, run } from '../db/index.js';
import { fingerprint } from './compute-cache.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_cached_reports (
  report TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  payload_json TEXT,
  error TEXT
)`);

/**
 * Every background report: what it depends on (for the fingerprint) and how
 * the worker computes it. The worker resolves `module`/`fn` itself so this
 * file never imports the heavy services on the request thread.
 */
export const REPORTS = Object.freeze({
  abstention_audit: {
    deps: [{ table: 'game_lines', stamp: 'gameday' }, 'nfl_pick_decisions', 'nfl_team_week_features'],
    module: './nfl-abstention-audit.js', fn: 'abstentionAudit', args: [],
    label: 'Abstention audit (five-season replay of declined games)'
  },
  nfl_diagnostic: {
    deps: [{ table: 'game_lines', stamp: 'gameday' }, 'nfl_pick_decisions', 'shadow_decisions', 'nfl_prop_clv',
      'nfl_expert_forward_predictions', 'nfl_news_signals'],
    module: './nfl-diagnostic.js', fn: 'nflDiagnostic', args: [],
    label: 'NFL evidence-first health report'
  },
  walk_forward: {
    deps: [{ table: 'game_lines', stamp: 'gameday' }, 'nfl_team_week_features', 'nfl_injuries'],
    module: './weekly-walkforward.js', fn: 'walkForward', args: [{ minLean: 1.0 }],
    label: 'Football-first weekly walk-forward'
  },
  confidence_calibration: {
    deps: [{ table: 'game_lines', stamp: 'gameday' }, 'nfl_team_week_features'],
    module: './pick-confidence.js', fn: 'confidenceCalibration', args: [{}],
    label: 'Pick-confidence out-of-sample calibration'
  },
  football_first_fit: {
    deps: [{ table: 'game_lines', stamp: 'gameday' }, 'nfl_team_week_features', 'nfl_injuries'],
    module: './football-first.js', fn: 'residualModel', args: [Number(process.env.NFL_SEASON) || new Date().getUTCFullYear(), 'margin'],
    label: 'Football-first coefficient fit for the current season (~90 s)'
  },
  // Cheap, deterministic, serializable: proves the worker path itself works.
  policy_contract: {
    deps: [],
    module: './nfl-policy.js', fn: 'normalizeNflPolicy', args: [{}],
    label: 'Frozen production policy (worker self-test)'
  }
});

/** The only meaningful change for these reports is a new result or a new decision, not an hourly line refresh. */
function currentFingerprint(name) {
  const spec = REPORTS[name];
  const scored = rows(`SELECT COUNT(*) n FROM game_lines WHERE team_score IS NOT NULL`)[0]?.n ?? 0;
  return fingerprint(spec.deps, `scored:${scored}`);
}

const inflight = new Map();

/** Stored answer, never computed here. */
export function serveReport(name, { refreshIfStale = true } = {}) {
  const spec = REPORTS[name];
  if (!spec) return { error: `unknown report ${name}` };
  const row = rows('SELECT * FROM nfl_cached_reports WHERE report=?', name)[0] ?? null;
  const print = currentFingerprint(name);
  const stale = !row || row.fingerprint !== print;
  if (stale && refreshIfStale) refreshReport(name).catch(() => {});
  if (!row) {
    return { pending: true, report: name, label: spec.label, computing: inflight.has(name),
      note: 'Computed in the background; this endpoint never blocks the app. Reload shortly.' };
  }
  let payload = null;
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
  return { ...(payload ?? {}), _report: { report: name, computed_at: row.computed_at, duration_ms: row.duration_ms,
    stale, refreshing: inflight.has(name), error: row.error ?? null } };
}

/** Compute one report in a worker thread and store it. Resolves when stored; safe to fire and forget. */
export function refreshReport(name, { force = false } = {}) {
  const spec = REPORTS[name];
  if (!spec) return Promise.reject(new Error(`unknown report ${name}`));
  if (inflight.has(name)) return inflight.get(name);
  const print = currentFingerprint(name);
  const existing = rows('SELECT fingerprint FROM nfl_cached_reports WHERE report=?', name)[0];
  if (!force && existing?.fingerprint === print) return Promise.resolve({ report: name, fresh: true });
  const started = Date.now();
  const job = new Promise(resolve => {
    const worker = new Worker(new URL('./report-worker.js', import.meta.url), {
      workerData: { module: spec.module, fn: spec.fn, args: spec.args },
      env: process.env
    });
    const finish = (payload, error) => {
      run(`INSERT INTO nfl_cached_reports (report, fingerprint, computed_at, duration_ms, payload_json, error)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(report) DO UPDATE SET fingerprint=excluded.fingerprint, computed_at=excluded.computed_at,
             duration_ms=excluded.duration_ms, payload_json=excluded.payload_json, error=excluded.error`,
      name, print, new Date().toISOString(), Date.now() - started, payload == null ? null : JSON.stringify(payload), error);
      inflight.delete(name);
      resolve({ report: name, duration_ms: Date.now() - started, error });
    };
    worker.once('message', msg => finish(msg.error ? null : msg.value, msg.error ?? null));
    worker.once('error', err => finish(null, err.message));
    worker.once('exit', code => { if (inflight.has(name)) finish(null, `worker exited with code ${code}`); });
    worker.unref();
  });
  inflight.set(name, job);
  return job;
}

/** Refresh every stale report, sequentially so the workers do not compete for the CPU. */
export async function refreshStaleReports() {
  const out = [];
  for (const name of Object.keys(REPORTS)) {
    const existing = rows('SELECT fingerprint, computed_at FROM nfl_cached_reports WHERE report=?', name)[0];
    if (existing?.fingerprint === currentFingerprint(name)) { out.push({ report: name, fresh: true }); continue; }
    out.push(await refreshReport(name));
  }
  return { reports: out };
}

export function reportCacheStatus() {
  const stored = rows('SELECT report, fingerprint, computed_at, duration_ms, error, LENGTH(payload_json) bytes FROM nfl_cached_reports');
  return { reports: Object.keys(REPORTS).map(name => {
    const s = stored.find(r => r.report === name);
    return { report: name, label: REPORTS[name].label, computed_at: s?.computed_at ?? null, duration_ms: s?.duration_ms ?? null,
      bytes: s?.bytes ?? 0, error: s?.error ?? null, stale: !s || s.fingerprint !== currentFingerprint(name),
      computing: inflight.has(name) };
  }), rule: 'Reports are computed in worker threads on the growth tick and served from SQLite; a request never triggers a synchronous replay.' };
}
