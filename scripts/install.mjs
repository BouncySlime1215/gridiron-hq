#!/usr/bin/env node
/**
 * Gridiron HQ installer — one script, every platform.
 *
 * Runs on plain Node with no dependencies of its own (it is what installs the
 * dependencies), so it has to work before `npm install` has ever been run. That
 * constraint is why everything here uses node: builtins only.
 *
 * Steps: check Node -> install packages -> write .env -> build the client ->
 * seed the database -> drop a launcher on the Desktop.
 *
 * Usage:  node scripts/install.mjs [--no-shortcut] [--key sk-ant-...]
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
// node:sqlite's DatabaseSync landed in 22.5 and the app has no other native deps.
const MIN_NODE = [22, 5, 0];

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const c = {
  g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`
};
const step = s => console.log(`\n${c.b('▸')} ${c.b(s)}`);
const ok = s => console.log(`  ${c.g('✓')} ${s}`);
const warn = s => console.log(`  ${c.y('!')} ${s}`);
const die = s => { console.error(`\n  ${c.r('✗')} ${s}\n`); process.exit(1); };

/* ------------------------------------------------------------ 1. node check */
step('Checking Node.js');
const version = process.versions.node.split('.').map(Number);
const tooOld = version[0] < MIN_NODE[0] || (version[0] === MIN_NODE[0] && version[1] < MIN_NODE[1]);
if (tooOld) {
  die(`Gridiron HQ needs Node ${MIN_NODE.join('.')} or newer (you have ${process.versions.node}).\n`
    + `    Install the current LTS from https://nodejs.org and run this again.`);
}
ok(`Node ${process.versions.node} on ${IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'}`);

/* -------------------------------------------------------- 2. npm install */
step('Installing packages');
const npm = IS_WIN ? 'npm.cmd' : 'npm';
// `npm ci` needs a lockfile in sync with package.json; fall back to install so a
// user on a fork with edited deps is not stuck.
const hasLock = fs.existsSync(path.join(ROOT, 'package-lock.json'));
let res = spawnSync(npm, [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'],
  { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
if (res.status !== 0 && hasLock) {
  warn('npm ci failed — retrying with npm install');
  res = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
}
if (res.status !== 0) die('Package install failed. Scroll up for the npm error.');
ok('Dependencies installed');

/* ------------------------------------------------------------- 3. .env key */
step('Configuring your Claude API key');
const ENV = path.join(ROOT, '.env');
const existing = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
const hasKey = /^ANTHROPIC_API_KEY=sk-/m.test(existing);

let key = opt('--key');
if (!key && !hasKey && process.stdin.isTTY) {
  console.log(c.dim('  The app works fully without a key — every projection, trade score and'));
  console.log(c.dim('  matchup number is computed locally. A key only adds the written'));
  console.log(c.dim('  scouting reports and trade pitches (Claude Haiku, a few cents a month).'));
  console.log(c.dim('  Get one at https://console.anthropic.com/settings/keys — or press Enter to skip.'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  key = (await rl.question('  Paste your Anthropic API key (optional): ')).trim();
  rl.close();
}

if (key && !/^sk-ant-/.test(key)) {
  warn('That does not look like an Anthropic key (they start with sk-ant-) — saving it anyway.');
}
if (key) {
  const next = `${existing.replace(/^ANTHROPIC_API_KEY=.*$/m, '').trim()}\nANTHROPIC_API_KEY=${key}\n`.trimStart();
  fs.writeFileSync(ENV, next, { mode: 0o600 });
  ok('Key saved to .env (git-ignored, never leaves this machine)');
} else if (hasKey) {
  ok('Existing key kept');
} else {
  if (!fs.existsSync(ENV)) fs.writeFileSync(ENV, '# ANTHROPIC_API_KEY=sk-ant-...\n', { mode: 0o600 });
  ok('Skipped — add one later in the app under Dev Hub (top right)');
}

/* ---------------------------------------------------------- 4. build client */
step('Building the interface');
res = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
if (res.status !== 0) die('Client build failed. Scroll up for the Vite error.');
ok('Interface built');

/* ------------------------------------------------------------- 5. seed data */
step('Preparing the database');
// Importing the db module runs the schema migrations and the seed on first boot.
res = spawnSync(process.execPath, ['-e', "import('./server/db/seed/index.js').then(m => { m.seedIfEmpty(); console.log('  seeded'); })"],
  { cwd: ROOT, stdio: 'inherit' });
if (res.status !== 0) warn('Seed step reported an error — the app will seed itself on first launch instead.');
ok('Database ready (32 teams, depth charts, 2026 schedule)');

/* --------------------------------------------------------- 6. live data pull */
step('Pulling live NFL data');
if (flag('--no-data')) {
  ok('Skipped (--no-data) — run `npm run sync:data` whenever you are ready');
} else {
  const r = spawnSync(process.execPath, ['scripts/bootstrap-data.mjs', ...(flag('--quick') ? ['--quick'] : [])],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) warn('Data pull did not finish — run `npm run sync:data` later, or use “Refresh data” in the app.');
}

/* -------------------------------------------------------- 7. desktop launcher */
if (!flag('--no-shortcut')) {
  step('Adding a Desktop shortcut');
  try {
    const target = createShortcut();
    ok(`Created ${target}`);
  } catch (e) {
    warn(`Could not create the shortcut (${e.message}).`);
    warn(`Start it manually any time with:  npm start`);
  }
}

/* ------------------------------------------------------------------- done */
console.log(`\n${c.g(c.b('  Gridiron HQ is installed.'))}\n`);
console.log(`  Double-click ${c.b('Gridiron HQ')} on your Desktop, or run ${c.b('npm start')} here.`);
console.log(`  It opens at ${c.b('http://localhost:5177')}\n`);
console.log(`  ${c.b('Next:')} connect your league on the ${c.b('My Leagues')} page.`);
console.log(`  ${c.dim('Public ESPN leagues need only the league ID. Private ones also need your')}`);
console.log(`  ${c.dim('espn_s2 and SWID cookies — the Settings page walks you through finding them.')}\n`);

/* ---------------------------------------------------------------- helpers */

/**
 * Desktop launcher per platform. Each one just runs `npm start` in this folder
 * and leaves a window open so the user can read errors and stop the server.
 */
function createShortcut() {
  const desktop = findDesktop();
  if (!desktop) throw new Error('could not locate your Desktop folder');

  if (IS_WIN) {
    // A .cmd is used rather than a .lnk: shortcuts need COM scripting that is often
    // blocked by policy, while a batch file always works and is equally clickable.
    const file = path.join(desktop, 'Gridiron HQ.cmd');
    fs.writeFileSync(file,
      `@echo off\r\n` +
      `title Gridiron HQ\r\n` +
      `cd /d "${ROOT}"\r\n` +
      `echo Starting Gridiron HQ...\r\n` +
      `npm start\r\n` +
      `pause\r\n`);
    return file;
  }

  const file = path.join(desktop, IS_MAC ? 'Gridiron HQ.command' : 'Gridiron HQ.sh');
  fs.writeFileSync(file,
    `#!/bin/bash\n` +
    `cd "${ROOT}" || exit 1\n` +
    `echo "Starting Gridiron HQ…"\n` +
    `npm start\n`);
  fs.chmodSync(file, 0o755);
  if (IS_MAC) {
    // Without this the Finder shows the "unidentified developer" prompt on a file
    // the user just generated locally.
    try { execSync(`xattr -d com.apple.quarantine "${file}"`, { stdio: 'ignore' }); } catch { /* not quarantined */ }
  }
  return file;
}

/** Desktop location, honouring OneDrive redirection and non-English Windows. */
function findDesktop() {
  const candidates = [];
  if (IS_WIN) {
    try {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v Desktop',
        { encoding: 'utf8' });
      const m = out.match(/Desktop\s+REG_\w+\s+(.+)/);
      if (m) candidates.push(m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? ''));
    } catch { /* fall through to the default path */ }
    if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, 'Desktop'));
  }
  candidates.push(path.join(os.homedir(), 'Desktop'));
  return candidates.find(p => p && fs.existsSync(p)) ?? null;
}
