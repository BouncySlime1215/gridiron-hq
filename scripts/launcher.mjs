#!/usr/bin/env node
/**
 * Always-on control plane, separate from the main app.
 *
 * The main server and its cloudflared tunnel only run while someone starts
 * them — fine at a computer, useless from a phone with the Mac asleep at the
 * desk. This is the one thing that has to be a *service* (launchd, RunAtLoad
 * + KeepAlive) rather than a thing you start: a tiny always-listening process
 * whose only job is turning the real app on when asked, and its own tunnel
 * is the address a phone hits to ask.
 *
 * No framework, no deps beyond node itself — the entire point is to be too
 * simple to fail. Auth is a single long key (server/data/launcher-key.txt,
 * generated on first run) checked with a constant-time compare; this is not
 * the fantasy data, it can only start a process that is already gated by its
 * own real auth (the pairing flow), so a long random key is enough.
 *
 * Starting the app (2026-09-18, after `spawn node ENOENT` crashed this service):
 *   - the node binary is resolved to an absolute, executable path (launchd's PATH
 *     has no Homebrew, so a bare `node` is not found there);
 *   - a child that fails to spawn is reported on /status, never allowed to crash
 *     this process through an unhandled `error` event;
 *   - the app runs with SCHEDULER_DISABLED=1 (the in-server scheduler pegged the
 *     app on 2026-09-17; the off-server refresh loop does that work) and a PATH
 *     that starts with node's own directory;
 *   - a stale or missing client/dist is rebuilt first, with the same check
 *     scripts/start.mjs uses (scripts/client-build-check.mjs);
 *   - one start at a time.
 * Importing this file does nothing (tests import it); running it starts the service.
 */
import http from 'node:http';
import { spawn as nodeSpawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clientBuildStatus, writeBuildMarker } from './client-build-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so tests never read the real key or write the real logs.
const KEY_FILE = process.env.LAUNCHER_KEY_FILE || path.join(ROOT, 'server', 'data', 'launcher-key.txt');
const LOG_DIR = process.env.LAUNCHER_LOG_DIR || path.join(ROOT, 'server', 'data', 'launcher-logs');
const KNOWN_NODE_LOCATIONS = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];

const isExecutableFile = p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
};

function onPath(name, pathValue) {
  for (const dir of String(pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The node binary to spawn, as an absolute path that exists and is executable:
 * NODE_BIN (absolute, or a bare name found on PATH), then the usual install locations,
 * then this process's own binary, then PATH. The install locations come before
 * process.execPath because under launchd that is the resolved, version-specific
 * Cellar path (…/Cellar/node/25.9.0_1/bin/node), which `brew upgrade` + cleanup
 * deletes while this service keeps running; /opt/homebrew/bin/node survives it.
 * Throws, naming every candidate tried, rather than ever handing spawn() a bare name.
 */
export function resolveNodeBin({ env = process.env, execPath = process.execPath,
  knownLocations = KNOWN_NODE_LOCATIONS } = {}) {
  const tried = [];
  const usable = p => {
    if (!p) return null;
    tried.push(p);
    return path.isAbsolute(p) && isExecutableFile(p) ? p : null;
  };
  const override = String(env.NODE_BIN ?? '').trim();
  const found = (override && usable(path.isAbsolute(override) ? override : onPath(override, env.PATH) ?? override))
    || knownLocations.map(usable).find(Boolean)
    || usable(execPath)
    || usable(onPath('node', env.PATH));
  if (!found) throw new Error(`no usable node binary; tried ${tried.join(', ') || 'nothing'}`);
  return found;
}

/** The environment every child of the launcher gets. */
export function appChildEnv(nodeBin, env = process.env) {
  const dirs = [path.dirname(nodeBin), ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean)];
  return { ...env, PATH: [...new Set(dirs)].join(path.delimiter), SCHEDULER_DISABLED: '1' };
}

function portOpen(port) {
  try { execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function processRunning(pattern) {
  try { return execSync(`pgrep -f ${JSON.stringify(pattern)}`).toString().trim().length > 0; }
  catch { return false; }
}

/**
 * Starts the app (rebuilding the interface first when it is stale) and remembers
 * how that went, for /status. Every dependency is injectable so this is testable
 * without starting anything. `nodeBin` is a path or a function returning one; a
 * function is called at every start, so a node upgrade while this service runs is
 * picked up instead of spawning a path that no longer exists.
 */
export function createAppStarter({ root = ROOT, appPort, nodeBin, env = process.env, spawn = nodeSpawn,
  portOpen: isPortOpen = portOpen, buildStatus = clientBuildStatus, writeMarker = writeBuildMarker,
  openLog = name => fs.openSync(path.join(LOG_DIR, name), 'a'), log = console.log } = {}) {
  const state = { phase: 'idle', error: null, build_error: null, started_at: null, node: null };
  let current = null;
  // Set at each start from the node binary resolved for it.
  let bin = null, childEnv = null, npm = 'npm';

  const fail = message => {
    state.phase = 'failed';
    state.error = message;
    log(`${new Date().toISOString()} start failed: ${message}`);
  };

  function startServer() {
    let child;
    try {
      const out = openLog('server.log');
      child = spawn(bin, ['--env-file-if-exists=.env', 'server/index.js'],
        { cwd: root, detached: true, stdio: ['ignore', out, out], env: childEnv });
    } catch (e) { fail(`server could not start: ${e.message}`); return; }
    current = child;
    Object.assign(state, { phase: 'starting', error: null, started_at: new Date().toISOString() });
    child.on('error', e => {
      if (current !== child) return;
      current = null;
      fail(`server could not start: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      if (current !== child) return;
      current = null;
      if (state.phase === 'starting') fail(`server exited with code ${code ?? signal}`);
    });
    child.unref?.();
  }

  function afterBuild(ok, build) {
    if (ok) {
      try { writeMarker(root, build.sourceMtime); } catch (e) { log(`build marker not written: ${e.message}`); }
    } else if (!build.hasDist) {
      fail(`the interface build failed and there is no previous build to serve (${state.build_error})`);
      return;
    } else {
      log(`${new Date().toISOString()} ${state.build_error}; serving the previous build`);
    }
    startServer();
  }

  function startApp() {
    if (isPortOpen(appPort)) { state.phase = 'running'; return 'already running'; }
    if (state.phase === 'building') return 'building the interface';
    if (state.phase === 'starting' && current && current.exitCode == null) return 'starting';
    try {
      bin = typeof nodeBin === 'function' ? nodeBin() : nodeBin;
      if (!bin) throw new Error('no node binary configured');
    } catch (e) {
      fail(e.message);
      return `failed: ${state.error}`;
    }
    state.node = bin;
    childEnv = appChildEnv(bin, env);
    const besideNode = path.join(path.dirname(bin), 'npm');
    npm = isExecutableFile(besideNode) ? besideNode : 'npm';
    let build;
    try { build = buildStatus(root); } catch (e) {
      log(`build check failed (${e.message}); starting on whatever build exists`);
      build = { needed: false };
    }
    if (!build.needed) {
      startServer();
      return state.phase === 'failed' ? `failed: ${state.error}` : 'starting';
    }
    Object.assign(state, { phase: 'building', error: null, build_error: null });
    let child;
    try {
      const out = openLog('build.log');
      child = spawn(npm, ['run', 'build'], { cwd: root, stdio: ['ignore', out, out], env: childEnv });
    } catch (e) {
      state.build_error = `the interface build could not start: ${e.message}`;
      afterBuild(false, build);
      return state.phase === 'failed' ? `failed: ${state.error}` : 'starting';
    }
    current = child;
    child.on('error', e => {
      if (current !== child) return;
      current = null;
      state.build_error = `the interface build could not start: ${e.message}`;
      afterBuild(false, build);
    });
    child.on('exit', code => {
      if (current !== child) return;
      current = null;
      if (code === 0) afterBuild(true, build);
      else { state.build_error = `the interface build failed (exit ${code})`; afterBuild(false, build); }
    });
    return 'building the interface';
  }

  return { startApp, status: () => ({ ...state }) };
}

function startTunnel(appPort) {
  // Must be specific to THIS tunnel (the app's, port APP_PORT) — a bare
  // 'cloudflared tunnel' substring also matches the launcher's own permanent
  // tunnel (a different port, started once by launchd and always up), so
  // that generic check always found *something* and silently skipped ever
  // starting the app's tunnel unless someone ran `npm run tunnel` by hand.
  // Found 2026-09-07 chasing why /api/auth/tunnel-url stayed null despite
  // /start reporting success.
  // The URL here must match what tunnel.mjs actually passes to cloudflared.
  if (processRunning(`cloudflared tunnel --url http://127.0.0.1:${appPort}`)) return 'already running';
  try {
    const nodeBin = resolveNodeBin();
    const out = fs.openSync(path.join(LOG_DIR, 'tunnel.log'), 'a');
    const child = nodeSpawn(nodeBin, ['scripts/tunnel.mjs'],
      { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: appChildEnv(nodeBin) });
    child.on('error', e => console.log(`${new Date().toISOString()} tunnel could not start: ${e.message}`));
    child.unref();
    return 'starting';
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

function keyOnDisk() {
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  const key = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function currentTunnelUrl(appPort) {
  // The main app remembers its own tunnel's address once registered
  // (POST /api/auth/tunnel-url from scripts/tunnel.mjs); ask it rather than
  // keeping a second copy of the truth here.
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${appPort}/api/auth/tunnel-url`, { timeout: 1500 }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body).tunnel_url ?? null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function page(body) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gridiron HQ launcher</title>
<body style="font:16px -apple-system,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1e293b">
<h1 style="font-size:20px">Gridiron HQ</h1>${body}</body>`;
}

export function main({ port = Number(process.env.LAUNCHER_PORT) || 5199,
  appPort = Number(process.env.API_PORT) || 5177 } = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const KEY = keyOnDisk();
  // Resolved again at every start (see createAppStarter); this one is only for the boot log.
  let bootNode;
  try { bootNode = resolveNodeBin(); } catch (e) { bootNode = `none (${e.message})`; }
  const starter = createAppStarter({ appPort, nodeBin: () => resolveNodeBin() });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = url.searchParams.get('key');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (!key || !safeEqual(key, KEY)) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      return res.end(page('<p>Wrong or missing key.</p>'));
    }

    if (url.pathname === '/start') {
      const appStatus = starter.startApp();
      const tunnelStatus = startTunnel(appPort);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page(`
      <p>Server: <b>${appStatus}</b> · Tunnel: <b>${tunnelStatus}</b></p>
      <p id="s">Checking for the address…</p>
      <script>
        async function poll() {
          const r = await fetch('/status?key=${encodeURIComponent(KEY)}').then(r=>r.json());
          const phase = r.start && r.start.phase;
          document.getElementById('s').textContent = '';
          if (r.tunnel_url) {
            const a = document.createElement('a'); a.href = r.tunnel_url; a.textContent = r.tunnel_url;
            document.getElementById('s').append('Ready: ', a);
            return;
          }
          document.getElementById('s').textContent = phase === 'failed' ? 'Start failed: ' + r.start.error
            : phase === 'building' ? 'Rebuilding the interface…'
            : r.server_up ? 'Server up, waiting for the tunnel address…' : 'Starting the server…';
          if (phase !== 'failed') setTimeout(poll, 3000);
        }
        poll();
      </script>`));
    }

    if (url.pathname === '/status') {
      const tunnelUrl = await currentTunnelUrl(appPort);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        server_up: portOpen(appPort), tunnel_up: processRunning('cloudflared tunnel'), tunnel_url: tunnelUrl,
        start: starter.status()
      }));
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(`<p><a href="/start?key=${encodeURIComponent(key)}">Start Gridiron HQ</a></p>`));
  });

  server.on('error', e => {
    console.error(`launcher cannot listen on 127.0.0.1:${port}: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Launcher listening on http://127.0.0.1:${server.address().port}`);
    // The key itself stays in its 0600 file; this log is world-readable.
    console.log(`Key: in ${path.relative(ROOT, KEY_FILE)}; node: ${bootNode}`);
  });
  return server;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) main();
