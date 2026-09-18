/**
 * The phone launcher (scripts/launcher.mjs, run by launchd) and the shared
 * client-build check (scripts/client-build-check.mjs, also used by start.mjs).
 *
 * The logged failure (~/Library/Logs/gridiron-launcher/launcher.log): a start
 * spawned bare `node` under launchd's minimal PATH, the child emitted an `error`
 * event nobody listened for, and the whole launcher crashed with
 * `spawn node ENOENT`. Found in the same audit: the app it starts inherited
 * launchd's environment (no SCHEDULER_DISABLED, so the in-server scheduler that
 * pegged the app on 2026-09-17 would run), and client/dist was never rebuilt.
 *
 * Guarantees (docs/tdd/infra-essentials.tdd.md, gate G3):
 *  - the node binary is always an absolute, executable path;
 *  - the app's environment has SCHEDULER_DISABLED=1 and a PATH that finds node;
 *  - a stale interface is rebuilt before the server starts, a fresh one is not;
 *  - a failed spawn is reported, never thrown; one start at a time;
 *  - importing the launcher opens no port and reads no key.
 * No server is started: spawn is a fake, and the one real spawn runs `node -e`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-launcher-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

// A port nothing uses, so an accidental listen() on import would be caught.
const PROBE_PORT = 20000 + (process.pid % 20000);
process.env.LAUNCHER_PORT = String(PROBE_PORT);

const L = await import('../scripts/launcher.mjs');
const B = await import('../scripts/client-build-check.mjs');

const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// ---------------------------------------------------------------- node binary
test('G3a: the node binary is absolute and executable even with launchd\'s minimal PATH', () => {
  const bin = L.resolveNodeBin({ env: { PATH: MINIMAL_PATH } });
  assert.ok(path.isAbsolute(bin), bin);
  fs.accessSync(bin, fs.constants.X_OK);
});

test('G3a: a bare or missing NODE_BIN never comes back as a bare name', () => {
  for (const NODE_BIN of ['node', '/nonexistent/bin/node', '']) {
    const bin = L.resolveNodeBin({ env: { PATH: MINIMAL_PATH, NODE_BIN } });
    assert.ok(path.isAbsolute(bin), `${JSON.stringify(NODE_BIN)} -> ${bin}`);
    fs.accessSync(bin, fs.constants.X_OK);
  }
});

test('G3a: an absolute, executable NODE_BIN is honoured', () => {
  assert.equal(L.resolveNodeBin({ env: { NODE_BIN: process.execPath, PATH: MINIMAL_PATH } }), process.execPath);
});

test('G3a: with no usable candidate at all the error says what was tried', () => {
  assert.throws(() => L.resolveNodeBin({ env: { PATH: '/nonexistent' }, execPath: '/nonexistent/node', knownLocations: [] }),
    /no usable node binary.*\/nonexistent\/node/s);
});

// ---------------------------------------------------------------- child env
test('G3b: the app runs with SCHEDULER_DISABLED=1 and a PATH that starts with node\'s own directory', () => {
  const env = L.appChildEnv('/opt/example/bin/node', { PATH: MINIMAL_PATH, HOME: '/Users/x', SCHEDULER_DISABLED: '0' });
  assert.equal(env.SCHEDULER_DISABLED, '1', 'the in-server scheduler stays off (off-server refresh loop does the work)');
  assert.equal(env.PATH.split(':')[0], '/opt/example/bin');
  assert.ok(env.PATH.split(':').includes('/usr/bin'), 'the original PATH is kept');
  assert.equal(env.HOME, '/Users/x');
});

test('G3d: the resolved node really starts under launchd\'s PATH (no ENOENT)', () => {
  const bin = L.resolveNodeBin({ env: { PATH: MINIMAL_PATH } });
  const r = spawnSync(bin, ['-e', 'process.exit(require("node:path").isAbsolute(process.execPath) ? 0 : 3)'],
    { env: L.appChildEnv(bin, { PATH: MINIMAL_PATH }), encoding: 'utf8' });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stderr);
});

// ---------------------------------------------------------------- starter
class FakeChild extends EventEmitter {
  constructor() { super(); this.exitCode = null; this.pid = 4242; }
  unref() {}
  exit(code) { this.exitCode = code; this.emit('exit', code, null); }
}

function harness({ port = false, build = { needed: false, hasDist: true, sourceMtime: 5 } } = {}) {
  const spawns = [];
  const markers = [];
  const logs = [];
  const starter = L.createAppStarter({
    root: '/repo', appPort: 55555, nodeBin: '/opt/example/bin/node', env: { PATH: MINIMAL_PATH },
    spawn: (cmd, args, opts) => { const child = new FakeChild(); spawns.push({ cmd, args, opts, child }); return child; },
    portOpen: () => (typeof port === 'function' ? port() : port),
    buildStatus: () => build,
    writeMarker: (root, mtime) => markers.push([root, mtime]),
    openLog: () => 'ignore',
    log: l => logs.push(l),
  });
  return { starter, spawns, markers, logs };
}

test('G3c: a running app is left alone', () => {
  const { starter, spawns } = harness({ port: true });
  assert.equal(starter.startApp(), 'already running');
  assert.equal(spawns.length, 0);
});

test('G3c: a fresh interface starts the server straight away, with the resolved node and the safe env', () => {
  const { starter, spawns } = harness();
  assert.equal(starter.startApp(), 'starting');
  assert.equal(spawns.length, 1);
  const s = spawns[0];
  assert.equal(s.cmd, '/opt/example/bin/node');
  assert.deepEqual(s.args, ['--env-file-if-exists=.env', 'server/index.js']);
  assert.equal(s.opts.cwd, '/repo');
  assert.equal(s.opts.detached, true);
  assert.equal(s.opts.env.SCHEDULER_DISABLED, '1');
  assert.equal(s.opts.env.PATH.split(':')[0], '/opt/example/bin');
});

test('G3c: a stale interface is rebuilt first; the server starts only after the build succeeds', () => {
  const { starter, spawns, markers } = harness({ build: { needed: true, reason: 'stale', hasDist: true, sourceMtime: 1234 } });
  assert.equal(starter.startApp(), 'building the interface');
  assert.equal(spawns.length, 1);
  assert.equal(path.basename(spawns[0].cmd), 'npm');
  assert.deepEqual(spawns[0].args, ['run', 'build']);
  assert.equal(spawns[0].opts.env.PATH.split(':')[0], '/opt/example/bin', 'npm finds node next to it');
  assert.equal(starter.status().phase, 'building');
  spawns[0].child.exit(0);
  assert.deepEqual(markers, [['/repo', 1234]], 'the build marker records the sources it was built from');
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[1].args, ['--env-file-if-exists=.env', 'server/index.js']);
  assert.equal(starter.status().phase, 'starting');
});

test('G3c: a failed build still starts the server on the previous build and says so', () => {
  const { starter, spawns, markers } = harness({ build: { needed: true, reason: 'stale', hasDist: true, sourceMtime: 9 } });
  starter.startApp();
  spawns[0].child.exit(1);
  assert.deepEqual(markers, [], 'no marker: the next start tries the build again');
  assert.equal(spawns.length, 2, 'server started on the previous build');
  assert.match(starter.status().build_error, /exit 1/);
});

test('G3c: a failed first build (no previous build at all) does not start a server with no interface', () => {
  const { starter, spawns } = harness({ build: { needed: true, reason: 'missing', hasDist: false, sourceMtime: 9 } });
  starter.startApp();
  spawns[0].child.exit(2);
  assert.equal(spawns.length, 1);
  assert.equal(starter.status().phase, 'failed');
  assert.match(starter.status().error, /build/);
});

test('G3c: a spawn error (ENOENT) is reported by status, never thrown', () => {
  const { starter, spawns } = harness();
  starter.startApp();
  assert.doesNotThrow(() => spawns[0].child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })));
  assert.equal(starter.status().phase, 'failed');
  assert.match(starter.status().error, /ENOENT/);
  // ... and the next start tries again.
  starter.startApp();
  assert.equal(spawns.length, 2);
});

test('G3c: a second start while one is in flight spawns nothing', () => {
  const { starter, spawns } = harness({ build: { needed: true, reason: 'stale', hasDist: true, sourceMtime: 1 } });
  starter.startApp();
  assert.equal(starter.startApp(), 'building the interface');
  assert.equal(spawns.length, 1);
  spawns[0].child.exit(0);
  assert.equal(starter.startApp(), 'starting');
  assert.equal(spawns.length, 2);
});

test('G3c: a server that exits before listening can be started again', () => {
  const { starter, spawns } = harness();
  starter.startApp();
  spawns[0].child.exit(1);
  assert.equal(starter.status().phase, 'failed');
  assert.match(starter.status().error, /exited with code 1/);
  starter.startApp();
  assert.equal(spawns.length, 2);
});

// ---------------------------------------------------------------- import has no side effects
test('G3e: importing the launcher opens no port', async () => {
  const refused = await new Promise(resolve => {
    const socket = net.connect(PROBE_PORT, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
  assert.equal(refused, true);
  assert.equal(typeof L.main, 'function');
});

// ---------------------------------------------------------------- shared build check
function clientFixture() {
  const root = fs.mkdtempSync(path.join(temp, 'root-'));
  fs.mkdirSync(path.join(root, 'client', 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'src', 'pages', 'A.tsx'), 'a');
  fs.writeFileSync(path.join(root, 'client', 'index.html'), '<html>');
  fs.writeFileSync(path.join(root, 'client', 'vite.config.ts'), 'x');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const old = new Date('2026-09-01T00:00:00Z');
  for (const f of ['client/src/pages/A.tsx', 'client/index.html', 'client/vite.config.ts', 'package.json']) {
    fs.utimesSync(path.join(root, f), old, old);
  }
  return root;
}

test('G3c: the shared check says missing, fresh and stale correctly', () => {
  const root = clientFixture();
  let s = B.clientBuildStatus(root);
  assert.equal(s.needed, true);
  assert.equal(s.reason, 'missing');
  assert.equal(s.hasDist, false);
  fs.mkdirSync(path.join(root, 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'dist', 'index.html'), '<html>');
  B.writeBuildMarker(root, s.sourceMtime);
  s = B.clientBuildStatus(root);
  assert.equal(s.needed, false, JSON.stringify(s));
  assert.equal(s.reason, 'fresh');
  // A file edited deep inside src (its folder's mtime need not move).
  const later = new Date('2026-09-18T12:00:00Z');
  fs.utimesSync(path.join(root, 'client', 'src', 'pages', 'A.tsx'), later, later);
  s = B.clientBuildStatus(root);
  assert.equal(s.needed, true);
  assert.equal(s.reason, 'stale');
  assert.equal(s.hasDist, true);
});

test('G3c: a dist with no marker (built outside start.mjs / the launcher) counts as stale', () => {
  const root = clientFixture();
  fs.mkdirSync(path.join(root, 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'dist', 'index.html'), '<html>');
  const s = B.clientBuildStatus(root);
  assert.equal(s.needed, true);
  assert.equal(s.reason, 'stale');
});

test('G3e: start.mjs uses the shared check and still parses', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'start.mjs'), 'utf8');
  assert.match(src, /from '\.\/client-build-check\.mjs'/);
  assert.doesNotMatch(src, /function newestMtimeMs/, 'one copy of the check, not two');
  const r = spawnSync(process.execPath, ['--check', path.join(REPO, 'scripts', 'start.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const l = spawnSync(process.execPath, ['--check', path.join(REPO, 'scripts', 'launcher.mjs')], { encoding: 'utf8' });
  assert.equal(l.status, 0, l.stderr);
});
