#!/usr/bin/env node
/**
 * Launcher for an installed copy: make sure the interface is built, start the
 * server, then open a browser once it is actually answering.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.API_PORT || 5177;
const URL = `http://localhost:${PORT}`;
const IS_WIN = process.platform === 'win32';

const isReady = async () => {
  try {
    const response = await fetch(`${URL}/api/teams`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
};

const openBrowser = () => {
  const cmd = IS_WIN ? ['cmd', ['/c', 'start', '', URL]]
    : process.platform === 'darwin' ? ['open', [URL]]
    : ['xdg-open', [URL]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); }
  catch { console.log(`Open ${URL} in your browser.`); }
};

// A second double-click should reopen the already-running app, not collide
// with its port and leave the user staring at an EADDRINUSE stack trace.
if (await isReady()) {
  openBrowser();
  console.log(`\n  Gridiron HQ is already running at ${URL}\n`);
  process.exit(0);
}

/**
 * Newest mtime across everything that feeds the build, so a stale dist/ (built
 * before a `git pull` landed client changes) gets caught the same way a missing
 * one does. Comparing directory mtimes isn't enough — editing a file inside a
 * folder doesn't bump the folder's own mtime — so this walks every file.
 */
function newestMtimeMs(entry) {
  let newest = 0;
  const stack = [entry];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (path.basename(p) === 'node_modules') continue;
      for (const child of fs.readdirSync(p)) stack.push(path.join(p, child));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

const DIST = path.join(ROOT, 'client', 'dist');
const BUILD_MARKER = path.join(DIST, '.source-mtime');
const sourceMtime = Math.max(
  newestMtimeMs(path.join(ROOT, 'client', 'src')),
  newestMtimeMs(path.join(ROOT, 'client', 'index.html')),
  newestMtimeMs(path.join(ROOT, 'client', 'vite.config.ts')),
  newestMtimeMs(path.join(ROOT, 'package.json'))
);
const builtMtime = fs.existsSync(BUILD_MARKER) ? Number(fs.readFileSync(BUILD_MARKER, 'utf8')) || 0 : 0;

// A fresh clone has no build; a `git pull` that touched client/ leaves a stale one.
// Either way, rather than serve a broken or out-of-date interface, rebuild first.
if (!fs.existsSync(path.join(DIST, 'index.html')) || sourceMtime > builtMtime) {
  console.log(builtMtime ? 'Interface changed since the last build — rebuilding…'
    : 'Building the interface (first run only)…');
  const r = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build'],
    { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
  if (r.status !== 0) { console.error('Build failed.'); process.exit(1); }
  fs.writeFileSync(BUILD_MARKER, String(sourceMtime));
}

const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'],
  { cwd: ROOT, stdio: 'inherit' });
server.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));

/** Poll until the server answers, so the browser never lands on a connection error. */
const openWhenReady = async () => {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (await isReady()) {
      ready = true;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) {
    console.error(`\n  Gridiron HQ did not come online at ${URL}.\n`);
    server.kill('SIGTERM');
    process.exitCode = 1;
    return;
  }
  openBrowser();
  console.log(`\n  Gridiron HQ is running at ${URL}\n  Press Ctrl+C to stop.\n`);
};
await openWhenReady();
