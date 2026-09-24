#!/usr/bin/env node
/**
 * Start and supervise the app's long-running processes as separate OS processes
 * (ENGINE-ARCHITECTURE.md §9.1): the web server, the engine daemon and, when asked, the
 * refresh loop. A child that exits is restarted after a backoff (1 s, doubling to 60 s;
 * back to 1 s once a child has stayed up for a minute), so a crashed or killed daemon
 * comes back and takes over its own stale engine.lock. SIGTERM/SIGINT are passed to every
 * child; this process exits 0 once they have all exited.
 *
 *   web      node server/index.js                            (role web, set in its code)
 *   engine   node scripts/engine-daemon.mjs --loop 600       (role engine)
 *   refresh  node scripts/refresh-live-data.mjs --loop 900   (only with --refresh: on the
 *            Mac the refresh loop runs from ~/gridiron-local/refresh.sh, which blanks the
 *            paid keys; this one would run with whatever keys .env holds)
 *
 * Nothing starts this by default: the launcher uses it only when GRIDIRON_START_ALL=1, and
 * Docker/Fly still run server/index.js (changing a deploy is Nick's call).
 *
 * Usage: node scripts/start-all.mjs [--refresh] [--no-web]
 * Importing this file runs nothing (tests import createSupervisor).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILES = ['--env-file-if-exists=.env', '--env-file-if-exists=.env.local'];

export function defaultChildren({ refresh = false, web = true } = {}) {
  return [
    web && { name: 'web', args: [...ENV_FILES, 'server/index.js'] },
    { name: 'engine', args: [...ENV_FILES, 'scripts/engine-daemon.mjs', '--loop', '600'] },
    refresh && { name: 'refresh', args: [...ENV_FILES, 'scripts/refresh-live-data.mjs', '--loop', '900'] },
  ].filter(Boolean);
}

export const backoffMs = attempt => Math.min(60000, 1000 * 2 ** Math.max(0, attempt));

/**
 * Supervise `children` ([{name, args, env?}]): start each, restart each on exit until
 * stop(). Every dependency is injectable. status() lists {name, pid, restarts, last_exit}.
 */
export function createSupervisor({ children, spawn = nodeSpawn, nodeBin = process.execPath, cwd = ROOT, env = process.env,
  stdio = 'inherit', backoff = backoffMs, stableMs = 60000, log = () => {} }) {
  const procs = new Map(children.map(c => [c.name, { spec: c, child: null, restarts: 0, attempt: 0, last_exit: null, timer: null }]));
  let stopping = false;

  function launch(name) {
    const p = procs.get(name);
    if (stopping) return;
    const startedAt = Date.now();
    const child = spawn(nodeBin, p.spec.args, { cwd, env: { ...env, SCHEDULER_DISABLED: '1', ...(p.spec.env ?? {}) }, stdio });
    p.child = child;
    child.on('error', error => log(`${name}: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (p.child !== child) return;
      p.child = null;
      p.last_exit = { code, signal, at: new Date().toISOString() };
      if (stopping) return;
      if (Date.now() - startedAt >= stableMs) p.attempt = 0;
      const wait = backoff(p.attempt);
      p.attempt += 1;
      p.restarts += 1;
      log(`${name} exited (${signal ?? code}); restarting in ${wait} ms`);
      p.timer = setTimeout(() => { p.timer = null; launch(name); }, wait);
    });
    log(`${name} started pid ${child.pid}`);
  }

  return {
    start() { for (const name of procs.keys()) launch(name); return this; },
    status: () => [...procs.values()].map(p => ({ name: p.spec.name, pid: p.child?.pid ?? null, restarts: p.restarts,
      last_exit: p.last_exit })),
    child: name => procs.get(name)?.child ?? null,
    /** Stop restarting, pass `signal` to every child, resolve when all have exited. */
    stop(signal = 'SIGTERM') {
      stopping = true;
      const waits = [];
      for (const p of procs.values()) {
        if (p.timer) { clearTimeout(p.timer); p.timer = null; }
        const c = p.child;
        if (!c) continue;
        waits.push(new Promise(resolve => { c.once('exit', resolve); }));
        try { c.kill(signal); } catch { /* already gone */ }
      }
      return Promise.all(waits);
    },
  };
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const stamp = () => new Date().toISOString();
  const sup = createSupervisor({ children: defaultChildren({ refresh: args.includes('--refresh'), web: !args.includes('--no-web') }),
    log: m => console.log(`${stamp()} start-all: ${m}`) }).start();
  const shutdown = async signal => {
    console.log(`${stamp()} start-all: ${signal}, stopping children`);
    await sup.stop('SIGTERM');
    process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}
