#!/usr/bin/env node
/**
 * Install an uploaded league-chat corpus into the place the engine reads.
 *
 * `data/derived/league_chat.sqlite` is the one file in this project that cannot
 * be re-fetched anywhere else. It is extracted from `~/Library/Messages/chat.db`
 * by `scripts/chat/extract_league_chat.py`, which needs Full Disk Access and a
 * Mac; there is no API behind it. Everything the Trade Brain knows about how
 * each manager talks — sentiment, the negotiation profiles, the bluff read,
 * response timing — comes out of it.
 *
 * It is also private message content, which is why `.gitignore` says "never
 * commit" and why this exists: the file moves by upload into a box, not through
 * the repository. This script is the receiving end. It refuses a file that is
 * not actually the corpus rather than installing something that will read as
 * "no chat data" later, and it never overwrites an existing corpus without
 * keeping the previous one.
 *
 * Usage:
 *   node scripts/import-league-chat.mjs <uploaded-file>     install it
 *   node scripts/import-league-chat.mjs --verify            check what is installed
 *
 * See docs/CLOUD-MIGRATION.md.
 */
import { existsSync, statSync, copyFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = process.env.LEAGUE_CHAT_OUT || path.join(ROOT, 'data/derived/league_chat.sqlite');

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

const die = msg => { console.error(c.r(`\n${msg}\n`)); process.exit(1); };

/**
 * The tables `manager-signals.js` actually opens. `messages` and
 * `jev_chat_signals` are load-bearing — the rollups are derived from them and
 * can be rebuilt with `--rollup`, but nothing can rebuild the messages. The
 * rollup tables are reported rather than required, so a corpus extracted
 * without `--classify` still installs and says what is not in it yet.
 */
const REQUIRED = ['messages'];
const DERIVED = ['jev_chat_signals', 'manager_chat_profile', 'manager_player_sentiment', 'negotiation_profiles'];

function inspect(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    die(`Not a readable SQLite database: ${file}\n  ${e.message}`);
  }
  const names = new Set(db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name));
  const count = t => {
    if (!names.has(t)) return null;
    try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; }
  };
  const out = { tables: names, counts: {} };
  for (const t of [...REQUIRED, ...DERIVED]) out.counts[t] = count(t);
  try {
    const r = db.prepare('SELECT MIN(sent_at) AS a, MAX(sent_at) AS b FROM messages').get();
    out.span = r?.a && r?.b ? `${r.a} .. ${r.b}` : null;
  } catch { out.span = null; }
  db.close();
  return out;
}

function report(file, info) {
  const size = statSync(file).size;
  console.log(c.b(`\n${file}`) + c.dim(`  (${(size / 1e6).toFixed(1)} MB)`));
  if (info.span) console.log(c.dim(`  messages span ${info.span}`));
  console.log('');
  for (const t of REQUIRED) {
    const n = info.counts[t];
    console.log(n == null ? c.r(`  MISSING  ${t}`) : c.g(`  ${String(n).padStart(8)}  ${t}`));
  }
  for (const t of DERIVED) {
    const n = info.counts[t];
    console.log(n == null ? c.y(`   absent  ${t}`) + c.dim('  (rebuild with --rollup on the Mac)')
      : c.g(`  ${String(n).padStart(8)}  ${t}`));
  }
  console.log('');
}

/* ------------------------------------------------------------------ verify */

if (process.argv.includes('--verify')) {
  if (!existsSync(DEST)) {
    console.log(c.y(`\nNo corpus installed at ${DEST}`));
    console.log(c.dim('The engine treats this as normal (another machine) and prices every ladder'));
    console.log(c.dim('on our own numbers only — the counterparty half of the Trade Brain is off.\n'));
    process.exit(1);
  }
  const info = inspect(DEST);
  report(DEST, info);
  const ok = REQUIRED.every(t => info.counts[t] > 0);
  console.log(ok ? c.g('Installed and readable.\n') : c.r('Installed but empty — the engine will read it as no chat data.\n'));
  process.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------------ install */

const src = process.argv[2];
if (!src) die('Usage: node scripts/import-league-chat.mjs <uploaded-file>   (or --verify)');
if (!existsSync(src)) die(`No such file: ${src}`);

const info = inspect(src);
report(src, info);

for (const t of REQUIRED) {
  if (info.counts[t] == null) {
    die(`This file has no \`${t}\` table, so it is not the league-chat corpus.\n`
      + `  Expected the output of: python3 scripts/chat/extract_league_chat.py --full --classify --rollup\n`
      + `  Nothing was installed.`);
  }
  if (info.counts[t] === 0) {
    die(`\`${t}\` is empty, so installing this would read exactly like having no corpus at all.\n`
      + `  Re-run the extractor on the Mac and check it found the "Transfer league 2026" thread.\n`
      + `  Nothing was installed.`);
  }
}

mkdirSync(path.dirname(DEST), { recursive: true });

// Never destroy a corpus that is already here: if the upload turns out to be a
// partial extract, the previous one is still one rename away.
if (existsSync(DEST)) {
  const backup = `${DEST}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(DEST, backup);
  console.log(c.dim(`  previous corpus kept at ${path.basename(backup)}`));
}

copyFileSync(src, DEST);

// The extractor writes in rollback-journal mode and a copy can land beside a
// stale sidecar; prove the installed file opens and still counts the same.
const after = inspect(DEST);
for (const t of REQUIRED) {
  if (after.counts[t] !== info.counts[t]) {
    die(`Installed copy does not match the source (${t}: ${info.counts[t]} -> ${after.counts[t]}).\n`
      + `  Copy the file again, including any -wal/-shm sidecars next to it.`);
  }
}

console.log(c.g(c.b(`\nInstalled -> ${DEST}`)));
if (DERIVED.some(t => after.counts[t] == null)) {
  console.log(c.y('\nSome rollup tables are absent. The messages are here, which is the part that'));
  console.log(c.y('cannot be recovered, but the profiles built from them are not.'));
  console.log(c.dim('On the Mac: python3 scripts/chat/extract_league_chat.py --classify --rollup, then re-upload.'));
}
console.log(c.dim('\nCheck the rest of the environment: node scripts/check-environment.mjs\n'));
