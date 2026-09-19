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
import { rows, run, db } from '../db/index.js';
import { fingerprint } from './compute-cache.js';

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
  line_move_study: {
    deps: ['nfl_odds_archive', { table: 'game_lines', stamp: 'gameday' }, 'nfl_verified_events'],
    module: './line-move-study.js', fn: 'lineMoveStudy', args: [{}],
    label: 'Beat the close: does anything predict the open-to-close move (Phase 1 study)'
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

/**
 * Reclaim WAL space right after a report worker's connection has closed --
 * the one moment we know for certain nothing on the growth tier is still
 * holding a multi-second read open on this file. `journal_mode=WAL`'s own
 * automatic checkpoint never truncates the -wal file's on-disk size even
 * when it fully succeeds (only TRUNCATE/RESTART mode does), so without this
 * the file is a high-water mark of whatever the busiest overlap ever
 * reached and only grows -- see db/index.js's journal_size_limit comment.
 *
 * A short, dedicated busy_timeout: this runs on the main thread between
 * requests, and the shared connection's normal 15s timeout would be a real
 * stall if another report's worker (serveReport's on-demand refresh can run
 * concurrently with the scheduled sweep) is still mid-query. Best-effort --
 * a busy/blocked attempt here just waits for the next report's own exit.
 */
function reclaimWal() {
  // A worker's 'exit' can arrive after whoever started it has closed the
  // database — a test's after() hook does exactly that, and now reaches this
  // code at all because the worker is no longer unref'd. There is nothing to
  // checkpoint on a closed handle, and the `db.prepare()` below would throw
  // "database is not open" from inside an event handler, where it surfaces as
  // an uncaught exception no caller can catch rather than as a test failure.
  //
  // A precondition, not a swallowed error. The catch below covers "another
  // connection is busy right now", which is a fact about contention and is
  // worth retrying; "this handle is gone" is a different fact, and widening
  // that catch to cover it would hide a genuine use-after-close everywhere
  // else in this module. Checked explicitly so the two stay distinguishable.
  if (!db.isOpen) return;
  const restoreTo = db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 15000;
  try {
    db.exec('PRAGMA busy_timeout = 250');
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } catch { /* another connection is busy right now; the next report's exit will try again */ }
  finally { db.exec(`PRAGMA busy_timeout = ${restoreTo}`); }
}

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
    // Whether THIS worker's result has been recorded. `inflight.has(name)` is
    // not that question: it is keyed by report name, so once a newer run for
    // the same report registers, a finished worker's late 'exit' reads it as
    // "still in flight" and overwrites the newer run's state with this one's.
    // A latch that belongs to this worker cannot be confused with another run.
    let settled = false;
    const finish = (payload, error) => {
      // 'exit' always follows 'message'/'error', so only the first result
      // counts. A worker that dies WITHOUT posting anything is still recorded,
      // because then 'exit' is the first call and the latch is open.
      if (settled) return;
      settled = true;
      // The database can be gone by the time a worker reports. `refreshReport()`
      // is explicitly "safe to fire and forget", so a refresh started by a
      // request can outlive the process that started it — which tests do
      // routinely now that the worker is correctly ref'd and actually survives
      // to deliver its result. Storing is impossible then. Settle saying so,
      // rather than throwing "database is not open" out of an event handler
      // where no caller can catch it and the runtime reports it as an
      // uncaughtException against whatever test happened to be running.
      //
      // Not a silent drop: the promise resolves with a named error, so an
      // awaiting caller is told the report was computed and not stored.
      if (!db.isOpen) {
        inflight.delete(name);
        resolve({ report: name, duration_ms: Date.now() - started,
          error: error ?? 'database closed before the report could be stored' });
        return;
      }
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
    worker.once('exit', code => {
      // No `inflight.has(name)` guard — see the latch above. This is a no-op
      // when the worker already reported, and the only record when it did not.
      finish(null, `worker exited with code ${code}`);
      reclaimWal();
    });
    // No `worker.unref()` here, deliberately.
    //
    // This promise can only settle from the three handlers above, so the worker
    // is the only thing keeping the event loop alive while a report computes.
    // Unref'ing it told Node the loop need not stay up for it, so any caller
    // that awaited `refreshReport()` in a process with nothing else ref'd got a
    // silent exit with the promise still pending — Node reports that as
    // "Promise resolution is still pending but the event loop has already
    // resolved". That breaks this function's own contract one line up
    // ("Resolves when stored") and makes `refreshStaleReports()` unsafe to
    // await anywhere but inside the running server.
    //
    // It hid because `server/index.js`'s `app.listen()` handle is ref'd and
    // holds the loop open, so in production the message always arrived. The
    // trap is a standalone runner: adding `nfl_reports` to
    // `scripts/refresh-live-data.mjs`'s job list would exit mid-report and
    // store nothing, silently.
    //
    // unref() bought nothing anyway — the listener already keeps the process
    // alive and there is no graceful-shutdown handler for it to avoid
    // delaying. (Contrast `nfl-ai-replay.js`, which unrefs a genuinely
    // detached `fork()` it never awaits. That one is correct.)
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
