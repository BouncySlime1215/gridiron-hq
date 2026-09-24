#!/usr/bin/env node
/**
 * EA-02: the engine daemon (ENGINE-ARCHITECTURE.md §4.3, §9.1-9.2). The one writer of the
 * engine tables, as its own OS process: it never runs inside the web server.
 *
 * Each tick: incremental adapters (source tables -> engine_events, from cursors), onEvent
 * learners, producers in DAG order (cheap ones whole, heavy ones per dirty league), one
 * snapshot per league whose DAG finished and moved, due nightly/weekly hooks as children,
 * and a heartbeat row `engine_daemon` in sync_log. It reads the tables the refresh loop
 * fills and never calls ESPN or any other fetcher.
 *
 * Between ticks it waits for the earliest of: the interval, a sync_log advance by any
 * collector (polled every 60 s: wake-on-sync), or open engine_requests (polled every 250 ms,
 * answered between ticks). SIGTERM/SIGINT finish the current source or producer, release
 * engine.lock and exit 0.
 *
 * Single instance: engine.lock (next to the database, or GRIDIRON_ENGINE_LOCK); a second
 * copy exits 3 with "already running pid N"; a lock left by a dead pid is taken over.
 * The database must already carry migration 075: this process never migrates (exit 2).
 *
 * Usage:
 *   node scripts/engine-daemon.mjs --once              one tick, then exit
 *   node scripts/engine-daemon.mjs --loop 600          tick every 600 s (300-900 accepted)
 *   node scripts/engine-daemon.mjs --dag               print the producer DAG and exit
 * Importing this file runs nothing.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_INTERVAL_S = 300;
export const MAX_INTERVAL_S = 900;
export const SYNC_POLL_MS = 60000;
export const REQUEST_POLL_MS = 250;

export function parseArgs(args) {
  const out = { once: args.includes('--once'), dag: args.includes('--dag'), sweep: args.includes('--sweep'), loop: null };
  const i = args.indexOf('--loop');
  if (i > -1) {
    const n = Number(args[i + 1]);
    if (!Number.isInteger(n) || n < MIN_INTERVAL_S || n > MAX_INTERVAL_S) {
      throw new Error(`--loop takes whole seconds from ${MIN_INTERVAL_S} to ${MAX_INTERVAL_S}, got ${args[i + 1]}`);
    }
    out.loop = n;
  }
  if (!out.once && !out.dag && out.loop == null) throw new Error('say --once, --loop <seconds> or --dag');
  return out;
}

/** The newest sync_log run by any collector other than this daemon. */
function lastSync(db) {
  try {
    return db.prepare(`SELECT MAX(last_run_at) AS m FROM sync_log WHERE job <> 'engine_daemon'`).get()?.m ?? null;
  } catch { return null; }
}

export async function main(argv = process.argv.slice(2)) {
  // Before any server import: this process is the engine, and the scheduler never starts here.
  process.env.GRIDIRON_PROCESS_ROLE = 'engine';
  process.env.SCHEDULER_DISABLED = '1';
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 64; }

  const { db, dbPath } = await import('../server/db/index.js');
  const { daemonProducers } = await import('../server/services/engine/producers/index.js');
  const { buildDag, describeDag } = await import('../server/services/engine/daemon/dag.js');
  const producers = daemonProducers();
  let dag;
  try { dag = buildDag(producers).order; } catch (error) {
    console.error(`engine daemon refuses to start: ${error.message}`);
    return 4;
  }
  if (opts.dag) { console.log(JSON.stringify(describeDag(producers), null, 2)); return 0; }

  const has = t => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  if (!['engine_events', 'engine_state', 'engine_runs', 'engine_snapshots', 'engine_cursors'].every(has)) {
    console.error(`engine tables (schema v2) missing on ${dbPath}: apply migration 075_engine_spine first`);
    return 2;
  }
  const { acquireEngineLock, LockHeldError } = await import('../server/services/engine/daemon/lock.js');
  let lock;
  try { lock = acquireEngineLock(dbPath); } catch (error) {
    if (error instanceof LockHeldError) { console.error(`engine daemon: ${error.message}`); return 3; }
    throw error;
  }
  const stamp = () => new Date().toISOString();
  if (lock.tookOver) console.log(`${stamp()} took over ${lock.file} from dead pid ${lock.previous?.pid}`);

  const { runTick } = await import('../server/services/engine/daemon/tick.js');
  const { createHookRunner } = await import('../server/services/engine/daemon/hooks.js');
  const { serveRequests } = await import('../server/services/engine/daemon/requests.js');
  const { recordSync } = await import('../server/services/scheduler.js');
  const hooks = createHookRunner({ database: db, log: m => console.log(`${stamp()} ${m}`) });

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let lastSweepDay = null;
  const tickOnce = async reason => {
    const day = stamp().slice(0, 10);
    const sweep = opts.sweep || lastSweepDay !== day;
    const t = await runTick({ database: db, dag, lock, hooks, sweep, shouldStop: () => stopping, heartbeat: recordSync });
    lastSweepDay = day;
    console.log(`${stamp()} tick ${t.tick_id} (${reason}${sweep ? ', sweep' : ''}): ${t.events} events, ${t.runs.length} runs, `
      + `${t.snapshots.length} snapshots, ${t.failed.length} failed, ${t.ms} ms${t.stopped ? ', stopped' : ''}`);
    for (const f of t.failed) console.log(`${stamp()}   failed ${f.what}: ${f.error}`);
    return t;
  };

  let code = 0;
  try {
    if (opts.once) {
      const t = await tickOnce('once');
      await hooks.idle();
      code = t.failed.length ? 1 : 0;
    } else {
      console.log(`${stamp()} engine daemon pid ${process.pid}, tick every ${opts.loop} s, lock ${lock.file}`);
      let seenSync = lastSync(db);
      let reason = 'start';
      while (!stopping) {
        await tickOnce(reason);
        if (!lock.held()) { console.error(`${stamp()} engine.lock is no longer ours: exiting`); code = 3; break; }
        const until = Date.now() + opts.loop * 1000;
        let nextSyncPoll = Date.now() + SYNC_POLL_MS;
        reason = 'interval';
        while (!stopping && Date.now() < until) {
          await serveRequests(db, { budgetMs: 1500 });
          hooks.checkLeases(new Date());
          if (Date.now() >= nextSyncPoll) {
            nextSyncPoll = Date.now() + SYNC_POLL_MS;
            const s = lastSync(db);
            if (s && s !== seenSync) { seenSync = s; reason = 'sync'; break; }
          }
          await new Promise(r => setTimeout(r, REQUEST_POLL_MS));
        }
      }
      console.log(`${stamp()} stopping`);
    }
  } finally {
    lock.release();
  }
  return code;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  const code = await main();
  process.exit(code);
}
