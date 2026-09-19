#!/usr/bin/env node
/**
 * Launcher for an installed copy: make sure the interface is built, start the
 * server, then open a browser once it is actually answering.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientBuildStatus, writeBuildMarker } from './client-build-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.API_PORT || 5177;
// Loopback is addressed as 127.0.0.1, never "localhost", for every request this
// repo makes to its own server. server/index.js binds 127.0.0.1 explicitly, and
// on macOS "localhost" resolves to the IPv6 ::1 first, where nothing is
// listening — so a localhost probe gets ECONNREFUSED against a server that is
// up and healthy. That cost a real evening: start.mjs printed "Gridiron HQ
// listening", its own readiness poll never succeeded, and after 30s it reported
// "did not come online" and SIGTERMed the working server.
const URL = `http://127.0.0.1:${PORT}`;
const IS_WIN = process.platform === 'win32';

/**
 * Is the server answering?
 *
 * Probes /api/health, the same route fly.toml's HTTP check uses, so the
 * launcher waits on the production liveness path rather than a different one
 * that happens to be public. The old probe used /api/teams, which sits behind
 * `legacyAuthenticated` (server/index.js) and so answers 401 to an
 * unauthenticated caller — forever. `response.ok` was therefore always false,
 * the poll below never succeeded, and after 60 attempts the launcher reported
 * "did not come online" and SIGTERMed a server that had been up and healthy
 * the whole time.
 *
 * Readiness here means "the HTTP server is listening and routing", so ANY reply
 * counts, including an error status. Only a thrown request (nothing listening
 * yet, or the timeout) means not-ready.
 */
const isReady = async () => {
  try {
    // A 503 from /api/health means the process is listening but cannot serve —
    // boot runs migrations and seed reconciliation against the volume before
    // the database answers. Treating any reply as ready would open the browser
    // on an app that is still coming up.
    const probe = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    return probe.ok && (await probe.json())?.ok === true;
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

// A fresh clone has no build; a `git pull` that touched client/ leaves a stale one.
// Either way, rather than serve a broken or out-of-date interface, rebuild first.
// The check is shared with the phone launcher (scripts/client-build-check.mjs).
const build = clientBuildStatus(ROOT);
if (build.needed) {
  console.log(build.builtMtime ? 'Interface changed since the last build — rebuilding…'
    : 'Building the interface (first run only)…');
  const r = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build'],
    { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
  if (r.status !== 0) { console.error('Build failed.'); process.exit(1); }
  writeBuildMarker(ROOT, build.sourceMtime);
}

const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'],
  { cwd: ROOT, stdio: 'inherit' });
server.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));

/**
 * A `git pull` can bring code that expects historical data (nflverse usage,
 * the ADP backfill, the fantasy coordinator fit) this install has never
 * synced — none of that ships in the repo, only the code that reads it does.
 * GET /api/model/setup-status (deliberately unauthenticated, like GET
 * /api/model/status) reports that gap; this fires the same one-button
 * POST /api/model/sync the in-browser DataSetupBanner uses, but automatically,
 * so the common case (nothing missing) is a silent no-op and the fresh-gap
 * case just fixes itself in the background instead of waiting on someone to
 * notice the banner. Not awaited before returning — the browser has already
 * opened by the time this runs, and this can take a few minutes.
 */
async function autoSyncIfNeeded() {
  let status;
  try { status = await (await fetch(`${URL}/api/model/setup-status`)).json(); }
  catch { return; }
  if (!status?.needs_setup) return;

  console.log('\n  Historical model data needs a one-time update — updating in the background (this can take a few minutes)…');
  try {
    const session = await (await fetch(`${URL}/api/auth/local-session`, { method: 'POST' })).json();
    const res = await fetch(`${URL}/api/model/sync`, {
      method: 'POST',
      headers: session.token ? { Authorization: `Bearer ${session.token}` } : {}
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    console.log('  ✓ Historical model data updated.');
  } catch (e) {
    console.error(`  Historical model data update failed: ${e.message}`);
    console.error('  It can still be run from the banner in the app itself.');
  }
}

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
  autoSyncIfNeeded();
};
await openWhenReady();
