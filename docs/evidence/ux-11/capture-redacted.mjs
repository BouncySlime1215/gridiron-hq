// Headless Chrome over CDP: capture /my-team at desktop and 375px with every
// league/team/manager name blurred out. Nav labels are static strings.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [,, outDir, profile] = process.argv;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  let target;
  for (let t = 0; t < 40 && !target; t++) { await sleep(250); try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(x => x.type === 'page'); } catch (e) { if (t === 39) throw e; } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await send('Page.enable'); await send('Runtime.enable');
  // Hide the connect modal for a clean nav shot and blur all data regions.
  const redact = `(() => {
    const s = document.createElement('style');
    s.textContent = 'main, header select, header [class*=League], [role=dialog] { filter: blur(9px) !important; } main *, header select { user-select:none }';
    document.head.appendChild(s);
    const nav = document.querySelector('nav[aria-label="Primary navigation"]');
    return JSON.stringify({ href: location.href, navLinks: nav ? [...nav.querySelectorAll('a')].map(a => a.textContent.trim() + '=' + a.getAttribute('href')) : null });
  })()`;
  for (const [name, w, h, mobile] of [['desktop', 1400, 900, false], ['375', 375, 812, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: 'http://localhost:5178/league?view=team' });
    await sleep(4000);
    if (mobile) { await send('Runtime.evaluate', { expression: `document.querySelector('button[aria-label="Open menu"]')?.click()` }); await sleep(600); }
    const r = await send('Runtime.evaluate', { expression: redact, returnByValue: true });
    console.log(name, r.result.result.value);
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${outDir}/ux-11-my-team-${name}.png`, Buffer.from(shot.result.data, 'base64'));
  }
} finally { ws?.close(); chrome.kill(); }
