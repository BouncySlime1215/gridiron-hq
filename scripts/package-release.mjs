#!/usr/bin/env node
/**
 * Build the distributable zip.
 *
 *   node scripts/package-release.mjs
 *   -> dist/GridironHQ.zip
 *
 * The layout is chosen for someone who has never opened a terminal. They unzip,
 * see exactly two folders named after operating systems, open theirs, and
 * double-click the one file inside called "Install Gridiron HQ". Nothing else
 * in the archive is meant to be clicked, so nothing else sits at the top level.
 *
 *   GridironHQ/
 *     START HERE.txt
 *     mac/       Install Gridiron HQ.command · Start Gridiron HQ.command · If macOS blocks this.txt
 *     windows/   Install Gridiron HQ.cmd     · Start Gridiron HQ.cmd     · If Windows blocks this.txt
 *     ...the actual project, which they never need to look at
 *
 * Two details matter more than they look:
 *
 * 1. `zip -X` and explicit 0755 modes. A zip records the executable bit; if it
 *    is lost, every macOS launcher opens in TextEdit instead of running, which
 *    looks exactly like a corrupt download to the person receiving it.
 *
 * 2. node_modules, .env, the database and .git are excluded. Beyond size, .env
 *    holds API keys and the database holds league data — shipping either would
 *    be handing them to whoever gets the file.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const STAGE = path.join(OUT, 'GridironHQ');
const MAC_ONLY = process.argv.includes('--mac');
const ZIP = path.join(OUT, MAC_ONLY ? 'GridironHQ-Mac.zip' : 'GridironHQ.zip');

/** Anything that is private, huge, or rebuilt on install. */
const EXCLUDE = new Set([
  'node_modules', '.git', 'dist', '.env', '.DS_Store',
  'data', 'coverage', '.vite', 'client/dist'
]);
/** Files whose executable bit must survive the round trip. */
const EXECUTABLE = /\.(command|sh)$/;

const START_HERE = `GRIDIRON HQ
===========

1. Open the folder for your computer:

      mac/        if you are on a Mac
      windows/    if you are on Windows

2. Double-click "Install Gridiron HQ" inside it.

3. Wait. It takes a few minutes the first time — it is downloading
   what it needs and pulling in current NFL data.

That is everything. You do not need to install Node, Python, or
anything else first; the installer handles that itself and asks for
no passwords.

When it finishes you get a "Gridiron HQ" shortcut on your Desktop.
Double-click that any time to start the app — it opens in your
browser at http://localhost:5177.

If your Mac or Windows shows a security warning, that is expected
for any downloaded script that has not been signed with a paid
developer certificate. The read-me inside your platform's folder
tells you exactly how to get past it, and it only happens once.
`;

const MAC_START_HERE = `GRIDIRON HQ FOR MAC
====================

1. Open the mac folder.
2. Double-click "Install Gridiron HQ.command".
3. Leave the installer window open. It downloads its own private Node.js,
   installs every package, builds the app, starts localhost, and opens your
   browser automatically. No Homebrew, Xcode, or administrator password needed.

Afterward, use the "Gridiron HQ" shortcut created on your Desktop. Keep its
window open while using the app; closing it stops the local server.

If macOS blocks the first launch, read "If macOS blocks this - read me.txt" in
the mac folder. The installer does not disable or bypass macOS security.
`;

const MAC_HELP = `IF MACOS BLOCKS "INSTALL GRIDIRON HQ"
=====================================

What you will see:
  "Apple could not verify 'Install Gridiron HQ.command' is free of
   malware" — or — "cannot be opened because it is from an
   unidentified developer".

Why:
  macOS refuses to run downloaded scripts unless they are signed with
  an Apple Developer certificate, which costs $99/year. This project
  is not signed. The warning is about the missing signature, not about
  anything found in the file.

How to get past it — macOS 15 (Sequoia) or newer:
  1. Double-click "Install Gridiron HQ.command". Let it be blocked.
  2. Open System Settings.
  3. Go to Privacy & Security.
  4. Scroll to the bottom. You will see a line naming the file that
     was just blocked, with an "Open Anyway" button.
  5. Click Open Anyway, then confirm.
  6. Double-click "Install Gridiron HQ.command" again. It runs.

How to get past it — macOS 14 or older:
  1. Right-click (or Control-click) "Install Gridiron HQ.command".
  2. Choose Open from the menu.
  3. Click Open in the dialog.

The installer does not disable Gatekeeper, clear quarantine attributes, or
change system security settings.

If you would rather read the script before running it, open it in
TextEdit — it is plain text and about sixty lines.
`;

const WIN_HELP = `IF WINDOWS BLOCKS "INSTALL GRIDIRON HQ"
=======================================

What you will see:
  A blue "Windows protected your PC" box from Microsoft Defender
  SmartScreen, saying the publisher is unknown.

Why:
  SmartScreen warns about any downloaded program that is not signed
  with a commercial code-signing certificate (a few hundred dollars a
  year) or does not yet have a download reputation. This project has
  neither. The warning is about the missing signature, not about
  anything found in the file.

How to get past it:
  1. Click "More info" in the blue box.
  2. Click "Run anyway".

If you do not see "More info", the file is still marked as blocked:
  1. Right-click "Install Gridiron HQ.cmd" and choose Properties.
  2. At the bottom of the General tab, tick "Unblock".
  3. Click OK, then double-click the file again.

After you approve the installer once, it clears the download mark only
from this extracted Gridiron HQ folder and uses a one-process PowerShell
override so future launches open normally. It does not change system policy.

Your antivirus may also flag the installer simply for downloading
Node.js. If it quarantines the file, allow it — or install Node
yourself from https://nodejs.org and run the installer again, which
skips the download entirely.
`;

console.log('\n  Packaging Gridiron HQ\n');

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(STAGE, { recursive: true });

// Prefer git's own idea of what belongs in the project — it already respects
// .gitignore, so private files cannot be swept in by a stale exclude list here.
let files;
try {
  files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
} catch {
  console.log('  ! Not a git checkout — falling back to a directory walk.');
  files = walk(ROOT).map(f => path.relative(ROOT, f));
}

let copied = 0;
for (const rel of files) {
  const top = rel.split('/')[0];
  if (EXCLUDE.has(top) || EXCLUDE.has(rel)) continue;
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
  const dest = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  if (EXECUTABLE.test(rel)) fs.chmodSync(dest, 0o755);
  copied++;
}
console.log(`  ✓ Staged ${copied} files`);

if (MAC_ONLY) {
  fs.rmSync(path.join(STAGE, 'windows'), { recursive: true, force: true });
  fs.rmSync(path.join(STAGE, 'install.ps1'), { force: true });
}

// Created explicitly rather than assumed: on a fresh checkout where the
// launchers are not yet tracked by git, the copy loop above leaves these
// directories missing and the writes below fail on a technicality.
fs.mkdirSync(path.join(STAGE, 'mac'), { recursive: true });
if (!MAC_ONLY) fs.mkdirSync(path.join(STAGE, 'windows'), { recursive: true });

fs.writeFileSync(path.join(STAGE, 'START HERE.txt'), MAC_ONLY ? MAC_START_HERE : START_HERE);
// Plain ASCII in the filename on purpose. An em-dash here survives macOS fine
// but arrives mojibake'd through some Windows unzip tools, and a help file with
// a corrupted name is the last thing a stuck user should meet.
fs.writeFileSync(path.join(STAGE, 'mac', 'If macOS blocks this - read me.txt'), MAC_HELP);
if (!MAC_ONLY) fs.writeFileSync(path.join(STAGE, 'windows', 'If Windows blocks this - read me.txt'), WIN_HELP);
for (const f of fs.readdirSync(path.join(STAGE, 'mac'))) {
  if (EXECUTABLE.test(f)) fs.chmodSync(path.join(STAGE, 'mac', f), 0o755);
}
console.log('  ✓ Wrote the platform read-me files');

// -X drops the Finder metadata that otherwise litters the archive with
// __MACOSX/ entries and makes it look broken on Windows.
execSync(`zip -r -X -q "${ZIP}" GridironHQ`, { cwd: OUT });
const mb = (fs.statSync(ZIP).size / 1e6).toFixed(1);
fs.rmSync(STAGE, { recursive: true, force: true });

console.log(`  ✓ Built ${path.relative(ROOT, ZIP)} (${mb} MB)\n`);
console.log('  Attach it to a GitHub release:');
console.log(`    gh release create v1.0.0 "${ZIP}" --title "Gridiron HQ" --notes "Unzip, open your platform's folder, double-click Install."\n`);

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, acc) : acc.push(p);
  }
  return acc;
}
