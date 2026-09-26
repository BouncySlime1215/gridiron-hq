#!/usr/bin/env node
/**
 * PERF LONG TASKS (plan item 57, second half): the longest main-thread task on each switch into
 * one of the seven areas, in headless Chrome, against the built client served by the real server
 * on a fresh temp database. Budget: no long task over LONGTASK_BUDGET_MS on a view switch
 * (CLAUDE.md 2b, "no long task > 50 ms on a view switch").
 *
 *   npm run build && node scripts/perf-longtasks.mjs [--runs 3] [--db <copy of a real db>] [--json]
 *
 * The default database is empty, so the areas render their empty states: a floor, not the real
 * cost. --db copies the given file into a temp dir and serves the copy (the original is only read,
 * never served or written); pass a snapshot, not the live file mid-write. That is the Mac measurement.
 *
 * Talks to Chrome over the DevTools protocol with Node's built-in WebSocket: no new dependency.
 * Chrome: $CHROME_PATH, else the Playwright Chromium under /opt/pw-browsers, else a system Chrome.
 *
 * GRIDIRON_PERF_LONGTASKS=enforce: exit 1 when any area is over budget, and when the probe could
 * not run. Unset (the default, SHADOW): report only, exit 0, printing NOT RUN / PROBE FAILED with
 * the cause so a broken probe is visible rather than silent.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { areasFromSource } from './perf-budgets.mjs';

export const LONGTASK_BUDGET_MS = 50;
const CANARY_MS = 120;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Longest task per area over runs, and pass/over against the budget. */
export function verdicts(runs, budget = LONGTASK_BUDGET_MS) {
  const byPath = new Map();
  for (const run of runs) for (const s of run) {
    const cur = byPath.get(s.path) ?? { path: s.path, area: s.area, max_ms: 0, count: 0, runs: 0 };
    cur.max_ms = Math.max(cur.max_ms, ...s.tasks.map(t => t.duration), 0);
    cur.count += s.tasks.length;
    cur.runs += 1;
    byPath.set(s.path, cur);
  }
  return [...byPath.values()].map(v => ({ ...v, max_ms: Math.round(v.max_ms), status: v.max_ms > budget ? 'over' : 'pass' }));
}

/** First Chrome that exists on this machine, or null. */
export function findChrome(env = process.env) {
  const c = [];
  if (env.CHROME_PATH) c.push(env.CHROME_PATH);
  const pw = env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
      c.push(path.join(pw, d, 'chrome-linux', 'chrome'), path.join(pw, d, 'chrome-linux64', 'chrome'));
    }
  }
  c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return c.find(p => fs.existsSync(p)) ?? null;
}

/** Minimal CDP client over one browser WebSocket, flat sessions. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot open ${url}`)); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message}`)); else res(m.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { res, rej });
    ws.send(JSON.stringify(msg));
  });
  return { send, close: () => ws.close() };
}

const OBSERVER = `window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) { window.__lt_error = String(e); }`;

async function bootServer(dist, db) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-longtasks-'));
  if (db) fs.copyFileSync(db, path.join(temp, 'perf.sqlite'));
  const port = Number(process.env.GRIDIRON_PERF_PORT) || (21000 + process.pid % 20000);
  let output = '';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, API_PORT: String(port), GRIDIRON_DB_PATH: path.join(temp, 'perf.sqlite'), SCHEDULER_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  for (let i = 0; i < 160; i++) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output.slice(-400)}`);
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
      .then(r => r.ok, () => false);
    if (ok) return { port, child, temp, dist };
    await sleep(125);
  }
  child.kill('SIGKILL');
  throw new Error(`server never healthy on ${port}: ${output.slice(-400)}`);
}

async function launchChrome(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank'];
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`chrome did not start: ${err.slice(-300)}`)), 15000);
    child.stderr.on('data', c => {
      err += c;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    child.on('exit', code => { clearTimeout(t); rej(new Error(`chrome exited ${code}: ${err.slice(-300)}`)); });
  });
  return { url, child, dir };
}

/** One pass: load the app, then click into each area and collect the long tasks of that switch. */
async function probeOnce(cdp, port, areas) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  await s('Page.enable');
  await s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
  await s('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  const evalv = async expr => (await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  for (let i = 0; i < 80 && await evalv('document.readyState') !== 'complete'; i++) await sleep(100);
  await sleep(2500);
  const obsErr = await evalv('window.__lt_error || null');
  if (obsErr) throw new Error(`longtask observer unavailable: ${obsErr}`);
  // Canary: a deliberate 120 ms task must show up, or a run of zeros would mean a blind probe.
  const seen = await evalv(`new Promise(r => { const n = window.__lt.length; setTimeout(() => { const t = performance.now(); while (performance.now() - t < ${CANARY_MS}); }, 0); setTimeout(() => r(window.__lt.slice(n).some(x => x.duration >= ${CANARY_MS - 5})), 600); })`);
  if (!seen) throw new Error(`canary ${CANARY_MS} ms task was not observed: the longtask observer is blind here`);
  const shell = await evalv('document.querySelectorAll("a[href]").length');
  const out = [];
  for (const a of areas) {
    const t0 = await evalv('performance.now()');
    const clicked = await evalv(`(() => { const el = [...document.querySelectorAll('a[href]')].find(x => x.getAttribute('href') === ${JSON.stringify(a.path)}); if (!el) return false; el.click(); return true; })()`);
    if (!clicked) throw new Error(`no link to ${a.path} on screen: the app did not reach its shell`);
    // Settle: at least 1.5 s, then until 1 s passes with no new long task, capped at 8 s.
    const start = Date.now();
    let last = await evalv('window.__lt.length');
    let quietSince = Date.now();
    while (Date.now() - start < 8000) {
      await sleep(250);
      const n = await evalv('window.__lt.length');
      if (n !== last) { last = n; quietSince = Date.now(); }
      if (Date.now() - start >= 1500 && Date.now() - quietSince >= 1000) break;
    }
    const tasks = await evalv(`window.__lt.filter(t => t.start >= ${t0})`);
    const where = await evalv('location.pathname');
    if (where !== a.path) throw new Error(`clicked ${a.path} but landed on ${where}`);
    const text = await evalv('(document.querySelector("main")?.innerText || "").trim().length');
    out.push({ path: a.path, area: a.area, tasks, main_text_chars: text, links: shell });
  }
  await cdp.send('Target.closeTarget', { targetId });
  return out;
}

async function main() {
  const o = { runs: 3 };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--runs') o.runs = Math.max(1, Number(process.argv[++i]) || 1);
    else if (a === '--json') o.json = true;
    else if (a === '--db') o.db = process.argv[++i];
    else { console.log(`unknown argument ${a}`); process.exit(2); }
  }
  if (o.db && !fs.existsSync(o.db)) { console.log(`BAD INPUT: --db ${o.db} not found`); process.exit(2); }
  const enforce = process.env.GRIDIRON_PERF_LONGTASKS === 'enforce';
  const suffix = enforce ? '' : ' (report only: GRIDIRON_PERF_LONGTASKS is not "enforce")';
  const dist = path.join(ROOT, 'client', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) { console.log(`NOT RUN: no built client at client/dist; run npm run build${suffix}`); process.exit(enforce ? 1 : 0); }
  const bin = findChrome();
  if (!bin) { console.log(`NOT RUN: no Chrome found (set CHROME_PATH)${suffix}`); process.exit(enforce ? 1 : 0); }
  const areas = areasFromSource(fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8'), fs.readFileSync(path.join(ROOT, 'client/src/navigation.ts'), 'utf8'));

  let server, chrome, cdp, runs = [];
  try {
    server = await bootServer(dist, o.db);
    chrome = await launchChrome(bin);
    cdp = await connect(chrome.url);
    for (let r = 0; r < o.runs; r++) runs.push(await probeOnce(cdp, server.port, areas));
  } catch (e) {
    console.log(`PROBE FAILED: ${e.message}${suffix}`);
    process.exitCode = enforce ? 1 : 0;
    runs = null;
  } finally {
    cdp?.close();
    if (chrome) { chrome.child.kill('SIGKILL'); fs.rmSync(chrome.dir, { recursive: true, force: true }); }
    if (server) { server.child.kill('SIGTERM'); await sleep(300); if (server.child.exitCode == null) server.child.kill('SIGKILL'); fs.rmSync(server.temp, { recursive: true, force: true }); }
  }
  if (!runs) return;
  const v = verdicts(runs);
  if (o.json) console.log(JSON.stringify({ chrome: path.basename(bin), runs: o.runs, areas: v, raw: runs }));
  for (const x of v) console.log(`${x.status === 'over' ? 'OVER' : 'PASS'} ${x.path} ${x.area}: longest task ${x.max_ms} ms over ${x.runs} switches (${x.count} long tasks), budget ${LONGTASK_BUDGET_MS} ms`);
  const over = v.filter(x => x.status === 'over').length;
  console.log(`TOTAL ${v.length} areas: ${v.length - over} within budget, ${over} over; database ${o.db ? 'copy of --db' : 'empty (empty states only)'}${suffix}`);
  process.exitCode = enforce && over ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
