#!/usr/bin/env node
/**
 * One command to get the league chat from this Mac into the live app.
 *
 * `npm run chat:sync`
 *
 * The chat corpus is the one thing this project runs on that cannot be fetched
 * from anywhere: it comes out of `~/Library/Messages/chat.db`, which has no API
 * and needs a Mac with Full Disk Access. Everything the Trade Brain knows about
 * how each manager talks is derived from it. So the extraction stays here, on
 * the laptop, and only its output travels.
 *
 * What used to be two steps with a browser in the middle — click Pull in the
 * local app, then paste a curl — is this script:
 *
 *   1. check the host is up and the token works, BEFORE spending ten minutes
 *      extracting (a dead token found afterwards wastes the whole run)
 *   2. run scripts/chat/extract_league_chat.py incrementally, with the
 *      classifier and the rollups, streaming its output
 *   3. open the resulting corpus and refuse to upload one that is missing or
 *      empty — installing that reads downstream exactly like having no chat
 *      data at all, which is the failure mode worth the most care
 *   4. POST it to /api/league-chat/upload and print one line saying what landed
 *
 * Every way this can fail gets its own sentence saying what to do about it:
 * Full Disk Access not granted, python3 missing, the one-off participant setup
 * never run, an empty extraction, a machine that is not a Mac, an expired
 * token, a sleeping host, a rejected upload.
 *
 * Usage:
 *   npm run chat:sync                        incremental, upload to the live app
 *   npm run chat:sync -- --full              rebuild the corpus from scratch first
 *   npm run chat:sync -- --no-upload         extract and validate only
 *   npm run chat:sync -- --host=http://localhost:5177
 *
 * Host:  --host, else GRIDIRON_CHAT_HOST / GRIDIRON_HOST, else the live app.
 * Token: /upload sits behind the same bearer auth as the rest of /api, so a
 *        token is required. GRIDIRON_FLY_TOKEN (or GRIDIRON_CHAT_TOKEN), read
 *        from the environment or from .env — never passed on the command line,
 *        where it would land in shell history.
 */
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTOR = path.join(ROOT, 'scripts/chat/extract_league_chat.py');
const DEFAULT_HOST = 'https://gridiron-hq.fly.dev';

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

const n = x => Number(x).toLocaleString('en-US');
const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;

/** Every exit that is not success comes through here, so none of them is a bare stack trace. */
function die(headline, ...lines) {
  console.error(`\n${c.r(headline)}`);
  for (const line of lines) console.error(line ? `  ${line}` : '');
  console.error('');
  process.exit(1);
}

const step = msg => console.log(c.b(`\n${msg}`));

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
  ${c.b('npm run chat:sync')}   pull the league chat off this Mac and send it to the app

    --full            rebuild the corpus from scratch instead of adding new messages
    --no-upload       extract and validate, but keep it on this machine
    --host=URL        where to send it (default ${DEFAULT_HOST})

  Set GRIDIRON_FLY_TOKEN in your environment or .env; the upload needs it.
`);
  process.exit(0);
}

const full = argv.includes('--full');
const noUpload = argv.includes('--no-upload') || argv.includes('--dry-run');
const hostArg = argv.find(a => a.startsWith('--host='))?.slice('--host='.length);

const unknown = argv.filter(a => !['--full', '--no-upload', '--dry-run'].includes(a) && !a.startsWith('--host='));
if (unknown.length) {
  die(`Don't know the option ${unknown[0]}.`, 'Run `npm run chat:sync -- --help` to see what this takes.');
}

function normalizeHost(raw) {
  let h = (raw || '').trim().replace(/\/+$/, '');
  if (!h) return DEFAULT_HOST;
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  try { new URL(h); } catch { die(`"${raw}" is not a usable address.`, 'Expected something like https://gridiron-hq.fly.dev.'); }
  return h;
}

/* -------------------------------------------------------------- the token */

/**
 * The environment first; `.env` only as a fallback, because that is already
 * where this repo keeps its secrets and it saves exporting a variable in every
 * new terminal. Nothing is ever written back to either.
 */
function readEnvFiles() {
  const found = {};
  for (const file of ['.env', '.env.local']) {
    const p = path.join(ROOT, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      found[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return found;
}

const TOKEN_KEYS = ['GRIDIRON_CHAT_TOKEN', 'GRIDIRON_FLY_TOKEN', 'GRIDIRON_TOKEN'];

function findToken() {
  for (const k of TOKEN_KEYS) if (process.env[k]) return { token: process.env[k], from: `$${k}` };
  const fromFile = readEnvFiles();
  for (const k of TOKEN_KEYS) if (fromFile[k]) return { token: fromFile[k], from: `${k} in .env` };
  return { token: null, from: null };
}

const TOKEN_HELP = [
  'Mint one on this Mac (it lasts 90 days):',
  '',
  c.dim('    fly ssh console -a gridiron-hq -C "node -e \\"fetch(\'http://127.0.0.1:5177/api/auth/local-session\',{method:\'POST\'}).then(r=>r.json()).then(o=>console.log(o.token))\\""'),
  '',
  'Then put it in this project\'s .env as one line, and run this again:',
  '',
  c.dim('    GRIDIRON_FLY_TOKEN=<the token it printed>'),
];

/* --------------------------------------------------------- can we extract */

/**
 * Three different "no" answers, and they need different fixes.
 *
 * The confusing one is Full Disk Access. Without it macOS does not merely deny
 * the read — depending on the version it hides the file, so "not found" and
 * "permission denied" are the same underlying problem and must not be reported
 * as "Messages isn't set up here".
 */
function checkCanExtract() {
  if (process.platform !== 'darwin') {
    die('This has to run on your Mac.',
      `This machine is ${process.platform}, and Apple Messages only exists on macOS.`,
      'There is no API behind Messages, so the extraction is the one step that',
      'cannot move to the cloud. Everything after it already runs there.');
  }
  if (!existsSync(EXTRACTOR)) {
    die('The extractor script is missing from this checkout.',
      `Expected it at ${EXTRACTOR}`,
      'Run this from the project directory, on the branch that has the league chat code.');
  }

  const src = process.env.LEAGUE_CHAT_SRC || path.join(os.homedir(), 'Library/Messages/chat.db');

  if (!existsSync(src)) {
    // Being denied the folder and the folder not being there are different
    // problems with the same symptom, because without Full Disk Access macOS
    // hides the file rather than refusing the read. Only EPERM/EACCES means
    // permission; ENOENT really is "Messages was never set up here".
    try {
      readdirSync(path.dirname(src));
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        return fullDiskAccessFailure(src, 'macOS is hiding it from this terminal');
      }
    }
    die('Messages has no database on this Mac.',
      `Looked for ${src}`,
      'Open the Messages app and sign in with your Apple ID, let it sync, then try again.');
  }

  try {
    const probe = new DatabaseSync(src, { readOnly: true });
    probe.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    probe.close();
  } catch (e) {
    return fullDiskAccessFailure(src, e.message);
  }
  return src;
}

function fullDiskAccessFailure(src, why) {
  die('This terminal cannot read your Messages database.',
    'That is macOS Full Disk Access, not a broken file. Grant it once:',
    '',
    '  1. System Settings > Privacy & Security > Full Disk Access',
    '  2. Turn it on for Terminal (or iTerm, or whichever app you are typing in)',
    '  3. Quit that app completely and reopen it — the permission only takes',
    '     effect in a newly launched process',
    '',
    'Then run `npm run chat:sync` again.',
    '',
    c.dim(`(${src}: ${why})`));
}

/* ----------------------------------------------------------- the corpus */

const CORPUS = process.env.LEAGUE_CHAT_OUT || path.join(ROOT, 'data/derived/league_chat.sqlite');

/** What is actually in the file the extractor just wrote. */
function inspectCorpus(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    die('The extractor produced a file that is not a readable database.',
      `${file}`, `${e.message}`, 'Nothing was uploaded. Try `npm run chat:sync -- --full` to rebuild it.');
  }
  const names = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name));
  const count = t => {
    if (!names.has(t)) return null;
    try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; }
  };
  const info = {
    messages: count('messages'),
    classified: count('jev_chat_signals'),
    managers: count('manager_chat_profile'),
    newest: null,
  };
  try { info.newest = db.prepare('SELECT MAX(ts_utc) AS m FROM messages').get()?.m ?? null; } catch { /* older shape */ }
  db.close();
  return info;
}

/* --------------------------------------------------------------- the run */

/**
 * Run the extractor and stream it, keeping the machine-readable summary line it
 * prints last. Having that line is also how we tell the two failure kinds
 * apart: it is printed before the classifier's own non-zero exit, so a run that
 * produced it collected its messages even if labelling them went wrong.
 */
function runExtractor() {
  const python = process.env.GRIDIRON_RESEARCH_PYTHON || 'python3';
  const args = [EXTRACTOR, ...(full ? ['--full'] : []), '--classify', '--rollup'];

  return new Promise(resolve => {
    const child = spawn(python, args, { cwd: ROOT, env: process.env });
    let tail = [], status = null, buf = '', errTail = [];

    const onLine = line => {
      if (line.startsWith('league_chat_status ')) {
        try { status = JSON.parse(line.slice('league_chat_status '.length)); } catch { /* keep going */ }
        return;
      }
      console.log(c.dim(`  ${line}`));
      tail.push(line);
      if (tail.length > 20) tail.shift();
    };

    child.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l.trimEnd());
    });
    child.stderr.on('data', d => {
      for (const l of String(d).split('\n')) {
        if (!l.trim()) continue;
        console.error(c.dim(`  ${l.trimEnd()}`));
        errTail.push(l.trim());
        if (errTail.length > 10) errTail.shift();
      }
    });
    child.on('error', e => {
      if (e.code === 'ENOENT') {
        die(`Could not run ${python}.`,
          'The extractor is a Python script and python3 is not on your PATH.',
          'Install it with `brew install python3` (or point GRIDIRON_RESEARCH_PYTHON',
          'at the python you want used), then run this again.');
      }
      die(`Could not run ${python}.`, e.message);
    });
    child.on('close', code => {
      if (buf.trim()) onLine(buf.trimEnd());
      resolve({ code, status, tail, errTail });
    });
  });
}

/* --------------------------------------------------------------- the host */

const HOST = normalizeHost(hostArg || process.env.GRIDIRON_CHAT_HOST || process.env.GRIDIRON_HOST);
const hostLabel = new URL(HOST).host;

/**
 * Wake the host and check the token before extracting.
 *
 * The Fly machine auto-stops, so the first request after a quiet spell can be
 * slow or fail outright while it boots; that is worth a couple of retries and
 * is not the same as the host being wrong.
 */
async function preflight(token) {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(`${HOST}/api/league-chat/status`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      if (i < attempts) {
        console.log(c.dim(`  ${hostLabel} did not answer (${e.message}); waking it up, attempt ${i + 1} of ${attempts}...`));
        await new Promise(r => setTimeout(r, 4000 * i));
        continue;
      }
      die(`Cannot reach ${hostLabel}.`,
        `${e.message}`,
        '',
        'If the app is genuinely up, check your network and the address. Point this',
        'somewhere else with --host=http://localhost:5177 to sync to a local app instead.');
    }

    if (res.status === 401) {
      die(token ? `${hostLabel} rejected the token.` : `${hostLabel} needs a token and none was set.`,
        token ? `The one from ${tokenSource} is expired, revoked, or for a different app.` : 'The upload route sits behind the same login as the rest of the API.',
        '', ...TOKEN_HELP);
    }
    if (res.status === 404) {
      die(`${hostLabel} has no league chat endpoint.`,
        'That address is reachable but running a build without the league chat feature.',
        'Check the host, or deploy the branch that has it.');
    }
    if (!res.ok) {
      die(`${hostLabel} answered ${res.status} before the upload even started.`,
        (await res.text().catch(() => '')).slice(0, 300) || '(no detail)',
        'Nothing was extracted or uploaded.');
    }
    return res.json().catch(() => null);
  }
}

/* ------------------------------------------------------------- the upload */

async function upload(token, body) {
  let res;
  try {
    res = await fetch(`${HOST}/api/league-chat/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch (e) {
    die(`The upload to ${hostLabel} did not finish.`,
      `${e.message}`,
      '',
      'Nothing on the app was replaced — it only swaps the corpus in once the whole',
      'file has arrived and opened. Your local copy is fine; just run this again.');
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* fall through to the raw body */ }

  if (res.ok) return json ?? {};

  const detail = json?.detail || json?.error || text.slice(0, 300) || '(no detail)';
  if (res.status === 401) {
    die(`${hostLabel} rejected the token during the upload.`,
      'It was accepted a minute ago, so it most likely just expired.', '', ...TOKEN_HELP);
  }
  if (res.status === 400) {
    die(`${hostLabel} refused the file.`, detail, '',
      'It checks the corpus before replacing anything, so the app still has whatever',
      'it had before. Rebuild with `npm run chat:sync -- --full` and try again.');
  }
  if (res.status === 413) {
    die('The corpus is too big for the upload route.',
      `${mb(body.length)} exceeded the server limit.`,
      'Tell Claude — the limit is a one-line change on the app side.');
  }
  die(`${hostLabel} answered ${res.status}.`, detail,
    'Nothing was replaced on the app.');
}

/* ----------------------------------------------------------------- main */

const { token, from: tokenSource } = findToken();

console.log(c.b('\nLeague chat sync') + c.dim(`  ->  ${hostLabel}${full ? '  (full rebuild)' : ''}`));

checkCanExtract();

if (!noUpload) {
  step('Checking the app is up and the token works');
  if (!token) {
    die(`${hostLabel} needs a token and none is set.`,
      'The upload route sits behind the same login as the rest of the API, so this',
      'needs one. It is read from the environment, never from the command line.',
      '', ...TOKEN_HELP);
  }
  const before = await preflight(token);
  const had = before?.corpus?.messages;
  console.log(c.g(`  ${hostLabel} is up, token accepted`)
    + c.dim(had ? `, currently holding ${n(had)} messages` : ', currently holding no chat data'));
}

step(full ? 'Rebuilding the corpus from Messages (this one takes a while)' : 'Reading new messages from Messages');
const run = await runExtractor();

if (!run.status) {
  // No summary line means it died before finishing the extract, so nothing is uploadable.
  const said = [...run.errTail, ...run.tail].join(' ');
  if (/scope not found/i.test(said)) {
    die('The extractor does not know who is in the league yet.',
      'Its `participants` table is empty, so it cannot tell which chats to read.',
      'That is the one-off setup, and it has not been run on this Mac.',
      '', 'Tell Claude in the project and it will walk you through it — it is a short',
      'insert naming the group chat members, and it only happens once.');
  }
  if (/unable to open database file|authorization denied|operation not permitted/i.test(said)) {
    fullDiskAccessFailure(process.env.LEAGUE_CHAT_SRC || '~/Library/Messages/chat.db', 'the extractor was denied');
  }
  die(`The extraction failed (exit ${run.code}).`,
    ...(run.errTail.length ? run.errTail : run.tail).slice(-6),
    '', 'Nothing was uploaded. Your app still has whatever corpus it had before.');
}

if (!existsSync(CORPUS)) {
  die('The extractor finished but wrote no corpus.',
    `Expected ${CORPUS}`,
    'Nothing was uploaded. Run `npm run chat:sync -- --full` to rebuild from scratch.');
}

const info = inspectCorpus(CORPUS);
if (!info.messages) {
  die('The extraction came back empty.',
    info.messages === null
      ? 'The corpus has no `messages` table at all.'
      : 'The corpus has a `messages` table with nothing in it.',
    '',
    'Uploading that would read on the app exactly like having no chat data, so it',
    'was not sent. Usually this means the group chat name in the extractor no longer',
    'matches the one in Messages, or Messages has not finished syncing on this Mac.');
}

const size = statSync(CORPUS).size;
console.log(c.g(`  ${n(info.messages)} messages in the corpus`)
  + c.dim(`  (${mb(size)}${run.status.extract_new ? `, ${n(run.status.extract_new)} new this run` : ', nothing new this run'}`
    + `${info.newest ? `, newest ${info.newest} UTC` : ''})`));

const warnings = [];
if (run.status.failed_outstanding) {
  warnings.push(`${n(run.status.failed_outstanding)} message(s) could not be classified`
    + `${run.status.failed_given_up ? `, ${n(run.status.failed_given_up)} given up on` : ''}`
    + '. The messages themselves came through fine; what is missing is the tone and'
    + ' sentiment read on those rows. Usually an API key or a rate limit.');
}
if (info.classified === null || info.classified === 0) {
  warnings.push('Nothing in this corpus is classified yet, so the Trade Brain gets the'
    + ' messages but none of the manager profiles built from them.');
}

if (noUpload) {
  console.log(c.y(`\n--no-upload: kept at ${CORPUS}, nothing sent.\n`));
  for (const w of warnings) console.log(c.y(`Heads up: ${w}\n`));
  process.exit(0);
}

step(`Uploading ${mb(size)} to ${hostLabel}`);
const result = await upload(token, readFileSync(CORPUS));

const landed = result.messages ?? info.messages;
console.log('');
console.log(c.g(`✓ ${n(landed)} messages are live on ${hostLabel}`)
  + c.dim(`  (${n(run.status.extract_new || 0)} new this run, ${mb(size)} uploaded, token from ${tokenSource})`));
for (const w of warnings) console.log(c.y(`\nHeads up: ${w}`));
console.log('');
