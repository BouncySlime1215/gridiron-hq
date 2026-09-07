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
 */
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LAUNCHER_PORT) || 5199;
const APP_PORT = Number(process.env.API_PORT) || 5177;
// launchd runs this with a minimal PATH (no Homebrew), so anything it spawns
// needs an absolute path too — 'node' alone resolved fine in a terminal test
// and then silently failed as a service.
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const KEY_FILE = path.join(ROOT, 'server', 'data', 'launcher-key.txt');
const LOG_DIR = path.join(ROOT, 'server', 'data', 'launcher-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function keyOnDisk() {
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  const key = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}
const KEY = keyOnDisk();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function portOpen(port) {
  try { execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function processRunning(pattern) {
  try { return execSync(`pgrep -f ${JSON.stringify(pattern)}`).toString().trim().length > 0; }
  catch { return false; }
}

function currentTunnelUrl() {
  // The main app remembers its own tunnel's address once registered
  // (POST /api/auth/tunnel-url from scripts/tunnel.mjs); ask it rather than
  // keeping a second copy of the truth here.
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${APP_PORT}/api/auth/tunnel-url`, { timeout: 1500 }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body).tunnel_url ?? null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function startApp() {
  if (portOpen(APP_PORT)) return 'already running';
  const out = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');
  const child = spawn(NODE_BIN, ['--env-file-if-exists=.env', 'server/index.js'],
    { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  return 'starting';
}

function startTunnel() {
  // Must be specific to THIS tunnel (the app's, port APP_PORT) — a bare
  // 'cloudflared tunnel' substring also matches the launcher's own permanent
  // tunnel (a different port, started once by launchd and always up), so
  // that generic check always found *something* and silently skipped ever
  // starting the app's tunnel unless someone ran `npm run tunnel` by hand.
  // Found 2026-09-07 chasing why /api/auth/tunnel-url stayed null despite
  // /start reporting success.
  if (processRunning(`cloudflared tunnel --url http://localhost:${APP_PORT}`)) return 'already running';
  const out = fs.openSync(path.join(LOG_DIR, 'tunnel.log'), 'a');
  const child = spawn(NODE_BIN, ['scripts/tunnel.mjs'],
    { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  return 'starting';
}

function page(body) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gridiron HQ launcher</title>
<body style="font:16px -apple-system,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1e293b">
<h1 style="font-size:20px">Gridiron HQ</h1>${body}</body>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://x`);
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
    const appStatus = startApp();
    const tunnelStatus = startTunnel();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(page(`
      <p>Server: <b>${appStatus}</b> · Tunnel: <b>${tunnelStatus}</b></p>
      <p id="s">Checking for the address…</p>
      <script>
        async function poll() {
          const r = await fetch('/status?key=${encodeURIComponent(KEY)}').then(r=>r.json());
          document.getElementById('s').innerHTML = r.tunnel_url
            ? 'Ready: <a href="'+r.tunnel_url+'">'+r.tunnel_url+'</a>'
            : (r.server_up ? 'Server up, waiting for the tunnel address…' : 'Starting the server…');
          if (!r.tunnel_url) setTimeout(poll, 3000);
        }
        poll();
      </script>`));
  }

  if (url.pathname === '/status') {
    const tunnelUrl = await currentTunnelUrl();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ server_up: portOpen(APP_PORT), tunnel_up: processRunning('cloudflared tunnel'), tunnel_url: tunnelUrl }));
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page(`<p><a href="/start?key=${encodeURIComponent(key)}">Start Gridiron HQ</a></p>`));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Launcher listening on http://127.0.0.1:${PORT}`);
  console.log(`Key: ${KEY}`);
});
