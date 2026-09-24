/**
 * Nightly and weekly hooks (ENGINE-ARCHITECTURE.md §3.2, §9.2; ENGINE-SPECS ENGINE-00b-a (3)-(5)).
 *
 * Hooks start empty; later units register into them (PROJ-04 autopsy, TELLS-01 refit,
 * HYPO-01, META-01f's Tuesday grade). Each hook is a child process: the daemon never
 * blocks a tick on a refit.
 *
 *   nightly  once per local day, on the first tick after 03:00 (America/New_York unless
 *            told otherwise), and skipped when a nightly run finished within the last 20 h
 *   weekly   once per scoring period, after every game of the NFL week is final: the
 *            calendar producer's `nfl.week` row for that week says status 'final'
 *
 * A child runs as role `engine-child` and writes nothing: it prints one JSON object on its
 * last stdout line, and the daemon hands it to the hook's `onResult` (the daemon is the one
 * writer). Every child holds a lease row in engine_runs (runs.js); a child still running
 * past its lease is killed (SIGKILL), its result row says so, and the tick goes on.
 * Hooks fire only in a tick that still holds engine.lock.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { getCursor, setCursor } from './cursors.js';
import { startRun, finishRun, currentCut } from './runs.js';

export const HOOK_PRODUCER = 'engine-hooks';
const HOOK_VERSION = '1';
const SCHEDULES = ['nightly', 'weekly'];
const hooks = { nightly: new Map(), weekly: new Map() };

/**
 * Register a hook. `command` is [script, ...args] run with this node binary; `onResult(json,
 * {database, now, period})` runs in the daemon with the child's JSON. `leaseMs` bounds the child.
 */
export function registerHook(schedule, { name, command, leaseMs = 30 * 60 * 1000, onResult = () => {} }) {
  if (!SCHEDULES.includes(schedule)) throw new Error(`hook schedule must be one of ${SCHEDULES.join('/')}`);
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new Error(`hook name "${name}" is invalid`);
  if (!Array.isArray(command) || !command.length) throw new Error(`hook ${name}: command is [script, ...args]`);
  if (hooks[schedule].has(name)) throw new Error(`hook ${schedule}/${name} is already registered`);
  hooks[schedule].set(name, { name, schedule, command, leaseMs, onResult });
  return () => hooks[schedule].delete(name);
}

export function listHooks(schedule) {
  return [...hooks[schedule].values()];
}

function localParts(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The local day the nightly hooks are due for, or null. */
export function nightlyDue(database, { now = new Date(), timeZone = 'America/New_York' } = {}) {
  const { day, hour } = localParts(now, timeZone);
  if (hour < 3) return null;
  if (getCursor(HOOK_PRODUCER, HOOK_VERSION, 'nightly', database) === day) return null;
  const since = new Date(new Date(now).getTime() - 20 * 3600 * 1000).toISOString();
  const recent = database.prepare(`SELECT 1 FROM engine_runs WHERE producer = ? AND scope_key LIKE 'nightly:%'
      AND finished_at IS NOT NULL AND finished_at > ? LIMIT 1`).get(HOOK_PRODUCER, since);
  return recent ? null : day;
}

/**
 * The scoring period the weekly hooks are due for ('season:week'), or null: the latest NFL
 * week whose `nfl.week` row (calendar producer, live lane) says every game is final.
 */
export function weeklyDue(database, { now = new Date() } = {}) {
  const r = database.prepare(`SELECT entity_id FROM engine_state WHERE id IN (
        SELECT MAX(id) FROM engine_state WHERE field = 'nfl.week' AND entity_type = 'week' AND lane = 'live'
          AND as_of <= ? GROUP BY entity_id)
      AND json_extract(value, '$.status') = 'final'
      ORDER BY CAST(substr(entity_id, 1, 4) AS INTEGER) DESC, CAST(substr(entity_id, 6) AS INTEGER) DESC LIMIT 1`)
    .get(new Date(now).toISOString());
  if (!r) return null;
  return getCursor(HOOK_PRODUCER, HOOK_VERSION, 'weekly', database) === r.entity_id ? null : r.entity_id;
}

/**
 * The daemon's children. `spawn` and `nodeBin` are injectable for tests.
 */
export function createHookRunner({ database, spawn = nodeSpawn, nodeBin = process.execPath, env = process.env,
  cwd = process.cwd(), log = () => {} } = {}) {
  const running = new Map(); // key -> {child, lease, hook, period, tickId, stdout, killed}

  function launch(hook, period, tickId, now) {
    const key = `${hook.schedule}:${hook.name}`;
    if (running.has(key)) return { hook: key, started: false, reason: 'still running' };
    const lease = startRun({ producer: HOOK_PRODUCER, version: HOOK_VERSION, scopeKey: `${hook.schedule}:${hook.name}`,
      tickId, cut: currentCut(database), leaseMs: hook.leaseMs, dirtyReason: `${hook.schedule} ${period}`, now }, database);
    const entry = { lease, hook, period, tickId, stdout: '', stderr: '', killed: null, done: null };
    let child;
    try {
      child = spawn(nodeBin, hook.command, { cwd, env: { ...env, GRIDIRON_PROCESS_ROLE: 'engine-child' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finishRun(lease, { producer: HOOK_PRODUCER, version: HOOK_VERSION, scopeKey: key, tickId,
        error: `spawn failed: ${error.message}` }, database);
      return { hook: key, started: false, reason: error.message };
    }
    entry.child = child;
    child.stdout?.on('data', d => { entry.stdout += d; });
    child.stderr?.on('data', d => { entry.stderr = (entry.stderr + d).slice(-2000); });
    entry.done = new Promise(resolve => {
      child.on('error', error => { entry.spawnError = error; });
      child.on('close', (code, signal) => { settle(key, entry, code, signal); resolve(); });
    });
    running.set(key, entry);
    return { hook: key, started: true, pid: child.pid };
  }

  function settle(key, entry, code, signal) {
    running.delete(key);
    let error = null; let rows = null;
    if (entry.killed) error = entry.killed;
    else if (entry.spawnError) error = `spawn error: ${entry.spawnError.message}`;
    else if (code !== 0) error = `exit ${code}${signal ? ` (${signal})` : ''}: ${entry.stderr.trim().slice(-300)}`;
    else {
      try {
        const last = entry.stdout.trim().split('\n').at(-1) || 'null';
        const r = entry.hook.onResult(JSON.parse(last), { database, now: new Date(), period: entry.period });
        rows = Number.isInteger(r?.rowsWritten) ? r.rowsWritten : null;
      } catch (e) { error = `result: ${e.message}`; }
    }
    finishRun(entry.lease, { producer: HOOK_PRODUCER, version: HOOK_VERSION, scopeKey: key, tickId: entry.tickId,
      rowsWritten: rows, error }, database);
    log(`hook ${key} ${error ? `failed: ${error}` : 'done'}`);
  }

  /** Kill every child past its lease. Returns the keys killed. */
  function checkLeases(now = new Date()) {
    const killed = [];
    for (const [key, entry] of running) {
      if (new Date(now).toISOString() > entry.lease.leaseUntil && !entry.killed) {
        entry.killed = `lease expired at ${entry.lease.leaseUntil}: killed`;
        try { entry.child.kill('SIGKILL'); } catch { /* already gone: close still fires */ }
        killed.push(key);
      }
    }
    return killed;
  }

  /** Start the hooks that are due. Returns [{schedule, period, hooks:[...]}]. */
  function runDue({ now = new Date(), tickId = null, timeZone } = {}) {
    const out = [];
    const day = nightlyDue(database, { now, timeZone });
    if (day) {
      out.push({ schedule: 'nightly', period: day, hooks: listHooks('nightly').map(h => launch(h, day, tickId, now)) });
      setCursor(HOOK_PRODUCER, HOOK_VERSION, 'nightly', day, database, now);
    }
    const week = weeklyDue(database, { now });
    if (week) {
      out.push({ schedule: 'weekly', period: week, hooks: listHooks('weekly').map(h => launch(h, week, tickId, now)) });
      setCursor(HOOK_PRODUCER, HOOK_VERSION, 'weekly', week, database, now);
    }
    return out;
  }

  /** Resolve when every running child has closed. */
  const idle = () => Promise.all([...running.values()].map(e => e.done));
  return { runDue, checkLeases, idle, running: () => [...running.keys()] };
}
