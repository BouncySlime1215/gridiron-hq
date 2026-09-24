// UI-RED 6 screenshots for FIX-257-1: the engine status strip and its per-producer sheet.
// Headless Chromium over CDP (no Playwright package in this repo). The app runs locally on a
// scratch database with preview mode on (so the strip flag is on); /api/engine/status is
// answered per state by request interception, except the "real" shot, which is the server's
// own answer. Usage: node capture.mjs <outDir> <profileDir> [baseUrl] [chromePath]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [,, outDir, profile, base = 'http://127.0.0.1:5391', chromePath = '/opt/pw-browsers/chromium'] = process.argv;
const PORT = 9334;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = { enabled: true, preview: true,
  preview_reason: 'Engine status strip is default-off, unconfirmed forward (preview mode is on).' };
const mins = m => m * 60;
const P = (producer, version, health, reason, age, fallbacks = []) =>
  ({ producer, version, status: 'active', health, reason, age_sec: age, fallbacks });

const STATES = {
  normal: { status: 200, body: {
    daemon: { status: 'ok', reason: null, age_sec: mins(4) }, lock: { status: 'ok' }, sources: [], snapshots: [],
    producers: [P('calendar', '1', 'ok', null, mins(4)), P('gamescript', '2', 'ok', null, mins(9)),
      P('league', '1', 'ok', null, mins(4))],
    jev: { status: 'zero', spend_usd: 0 }, strip } },
  empty: { status: 200, body: {
    daemon: { status: 'unknown', reason: 'no heartbeat: the engine daemon has never run here', age_sec: null },
    lock: { status: 'unknown' }, sources: [], snapshots: [], producers: [],
    jev: { status: 'unknown', reason: 'Jev not live: nothing writes engine.jev yet' }, strip } },
  thin: { status: 200, body: {
    daemon: { status: 'stale', reason: 'last heartbeat 50 min ago (limit 45 min)', age_sec: mins(50) },
    lock: { status: 'stale' }, sources: [], snapshots: [],
    producers: [
      P('calendar', '1', 'error', 'last run failed: schedule feed answered 500', mins(52)),
      P('gamescript', '2', 'fallback', '1 field on its fallback: game.script', mins(50),
        [{ field: 'game.script', fallback_field: 'game.script_base', league_id: 0, reason: 'ours trails the baseline over 4 weeks' }]),
      P('league', '1', 'unknown', 'has never run here', null)],
    jev: { status: 'unknown', reason: 'Jev not live: nothing writes engine.jev yet' }, strip } },
  error: { status: 500, body: { error: 'engine status read failed (fixture)' } },
};

const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-sandbox', '--no-proxy-server', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws; let id = 0; const pending = new Map(); let current = null;
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
try {
  let target;
  for (let t = 0; t < 40 && !target; t++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x => x.type === 'page'); } catch (e) { if (t === 39) throw e; }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId } = m.params;
      if (!current) { send('Fetch.continueRequest', { requestId }); return; }
      const s = STATES[current];
      send('Fetch.fulfillRequest', { requestId, responseCode: s.status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(s.body)).toString('base64') });
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/engine/status*', requestStage: 'Request' }] });
  const report = {};
  const shots = [['normal', 1280, false, false], ['empty', 1280, false, false], ['thin', 1280, false, false],
    ['error', 1280, false, false], ['mobile', 375, true, false], ['dark', 1280, false, true], ['real', 1280, false, false]];
  for (const [name, width, mobile, dark] of shots) {
    current = name === 'mobile' || name === 'dark' ? 'normal' : name === 'real' ? null : name;
    await send('Emulation.setDeviceMetricsOverride', { width, height: mobile ? 812 : 800, deviceScaleFactor: 1, mobile });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await send('Page.navigate', { url: `${base}/news` });
    await sleep(3500);
    // Close the ESPN connect modal if it is up (a scratch database has no league), so the strip shows.
    await evaluate(`document.querySelector('button[aria-label="Close and continue without connecting"]')?.click()`);
    await sleep(500);
    const info = await evaluate(`JSON.stringify({ strip: document.querySelector('button[aria-haspopup="dialog"][aria-label^="Engine status"]')?.getAttribute('aria-label') ?? null,
      alert: document.querySelector('[data-engine-daemon="error"]')?.textContent ?? null,
      scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth })`);
    report[name] = JSON.parse(info);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${outDir}/ea-04-strip-${name}.png`, Buffer.from(shot.data, 'base64'));
    const opened = await evaluate(`(() => { const b = document.querySelector('button[aria-haspopup="dialog"][aria-label^="Engine status"]'); if (!b) return false; b.click(); return true; })()`);
    if (opened) {
      await sleep(600);
      report[name].sheetRows = await evaluate(`[...document.querySelectorAll('[role=dialog] [data-producer]')].map(li => li.dataset.producer + '=' + li.dataset.producerHealth).join(',')`);
      const open = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${outDir}/ea-04-sheet-${name}.png`, Buffer.from(open.data, 'base64'));
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  ws?.close(); chrome.kill();
}
