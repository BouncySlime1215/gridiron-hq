#!/usr/bin/env node
/**
 * The wiring map: what feeds what, derived from the code rather than written down.
 *
 * Two failure modes keep showing up in this repository, and they are different
 * problems with different fixes:
 *
 *   ORPHAN OUTPUT   — something is produced and reaches no surface. A module
 *                     nothing imports, an export nobody calls, a field attached
 *                     to every projection that no reader ever looks at, a table
 *                     written and never read. Wasted work; nobody is hurt.
 *
 *   MISSING FEED    — a surface depends on something nothing produces. A table
 *                     read on the request path that no scheduled job fills, a
 *                     client call with no route behind it. This is the one that
 *                     hurts users, because the surface still renders: it renders
 *                     a default, a constant, or an empty list, and looks fine.
 *
 * Everything here is walked out of the source: ESM imports, SQL in string
 * literals, express route registrations, the scheduler's JOBS table, and the
 * client's api() calls. A hand-written map is accurate for about a week; this
 * one can be re-run, and eventually run in CI.
 *
 * A few edges genuinely cannot be derived — a script a human runs by hand, a
 * table filled by an operator. Those live in docs/wiring/annotations.json and
 * are marked ASSERTED wherever they appear in the output, so a reader can
 * always tell what the walker proved from what a person claimed.
 *
 * Usage:
 *   node scripts/wiring-map.mjs                      # write docs/wiring/*
 *   node scripts/wiring-map.mjs --findings           # findings to stdout only
 *   node scripts/wiring-map.mjs --check              # exit 1 on new findings
 *   node scripts/wiring-map.mjs --out /tmp/map       # somewhere else
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

/** Where code lives, and what kind of thing each tree is. */
const TREES = [
  { dir: 'server', kind: 'server' },
  { dir: 'client/src', kind: 'client' },
  { dir: 'scripts', kind: 'script' },
  { dir: 'chrome-extension', kind: 'extension' },
  // Tests are scanned so we can tell "imported by nothing" from "imported only
  // by its own test" — a distinction that matters a great deal and is invisible
  // if you skip the tree.
  { dir: 'test', kind: 'test' },
];

// ---------------------------------------------------------------------------
// Scanning: split a source file into code (comments and string bodies blanked)
// and the string literals themselves. SQL lives in the strings; imports, routes
// and identifiers live in the code. Blanking preserves offsets, so every line
// number reported below is the real one.
// ---------------------------------------------------------------------------

function scan(src) {
  const code = [...src];      // comments AND string bodies blanked
  const text = [...src];      // comments blanked, strings intact
  const strings = [];
  let i = 0;
  const n = src.length;
  // Tracks whether a '/' starts a regex or is division. Wrong guesses only cost
  // us a mis-blanked regex body, never a crash.
  let prevSignificant = '';
  const blank = (from, to, alsoText = false) => {
    for (let k = from; k < to; k++) {
      if (code[k] !== '\n') code[k] = ' ';
      if (alsoText && text[k] !== '\n') text[k] = ' ';
    }
  };
  const lineAt = (off) => { let l = 1; for (let k = 0; k < off; k++) if (src[k] === '\n') l++; return l; };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      const end = src.indexOf('\n', i); const to = end === -1 ? n : end;
      blank(i, to, true); i = to; continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2); const to = end === -1 ? n : end + 2;
      blank(i, to, true); i = to; continue;
    }
    if (c === '"' || c === "'") {
      const start = i; i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i = Math.min(i + 1, n);
      strings.push({ text: src.slice(start + 1, i - 1), line: lineAt(start), at: start });
      blank(start, i); continue;
    }
    if (c === '`') {
      // Template literals nest: the ${} parts are code, the rest is string. We
      // keep the whole body as one string for SQL purposes (interpolated table
      // names are rare and show up as ${...} we simply do not match) and blank
      // it in the code view.
      const start = i; i++; let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (depth === 0 && src[i] === '`') break;
        if (src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (depth > 0 && src[i] === '{') depth++;
        if (depth > 0 && src[i] === '}') depth--;
        i++;
      }
      i = Math.min(i + 1, n);
      strings.push({ text: src.slice(start + 1, i - 1), line: lineAt(start), at: start });
      blank(start, i); continue;
    }
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]|^$|return|typeof|case|in|of|do|else/.test(prevSignificant)) {
      // Regex literal. Skip its body so a quote inside it cannot open a string.
      const start = i; i++; let cls = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) break;
        else if (src[i] === '\n') { i = start; break; }  // not a regex after all
        i++;
      }
      if (i > start) { i = Math.min(i + 1, n); blank(start, i); continue; }
      i = start + 1; prevSignificant = '/'; continue;
    }
    if (!/\s/.test(c)) {
      prevSignificant = /[A-Za-z_$]/.test(c)
        ? (src.slice(Math.max(0, i - 12), i + 1).match(/[A-Za-z_$][\w$]*$/) ?? [c])[0]
        : c;
    }
    i++;
  }
  return { code: code.join(''), text: text.join(''), strings };
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SRC_EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL. Every table edge is checked against the table universe (every
// CREATE TABLE in the repository), which is what keeps CTE names, aliases and
// subquery noise out of the map.
// ---------------------------------------------------------------------------

const RE_CREATE = /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][\w]*)/gi;
const RE_INSERT = /\bINSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+["'`[]?([A-Za-z_][\w]*)/gi;
const RE_REPLACE = /\bREPLACE\s+INTO\s+["'`[]?([A-Za-z_][\w]*)/gi;
const RE_UPDATE = /\bUPDATE\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?["'`[]?([A-Za-z_][\w]*)/gi;
const RE_DELETE = /\bDELETE\s+FROM\s+["'`[]?([A-Za-z_][\w]*)/gi;
const RE_ALTER = /\bALTER\s+TABLE\s+["'`[]?([A-Za-z_][\w]*)/gi;
const RE_DROP = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`[]?([A-Za-z_][\w]*)/gi;
const RE_FROM = /\bFROM\s+["'`[]?([A-Za-z_][\w]*)/gi;
const RE_JOIN = /\bJOIN\s+["'`[]?([A-Za-z_][\w]*)/gi;

function collect(re, text, sink, line) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) sink.push({ table: m[1], line });
}

/** Does this string look like SQL at all? Cheap gate, keeps prose out. */
function looksSql(t) {
  return /\b(SELECT|INSERT|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|REPLACE\s+INTO)\b/i.test(t);
}

function sqlEdges(strings, attribute = () => ({ handle: 'app', where: null })) {
  const creates = [], writes = [], reads = [];
  for (const { text, line, at } of strings) {
    if (!looksSql(text)) continue;
    const { handle, where } = attribute(at);
    const tag = (arr, from) => { for (let i = from; i < arr.length; i++) { arr[i].handle = handle; arr[i].opened_on = where; arr[i].at = at; } };
    const c0 = creates.length, w0 = writes.length, r0 = reads.length;
    collect(RE_CREATE, text, creates, line);
    collect(RE_ALTER, text, creates, line);
    collect(RE_INSERT, text, writes, line);
    collect(RE_REPLACE, text, writes, line);
    collect(RE_UPDATE, text, writes, line);
    collect(RE_DELETE, text, writes, line);
    collect(RE_DROP, text, writes, line);
    // Reads: FROM/JOIN, minus the DELETE FROM occurrences already counted as
    // writes. An INSERT ... SELECT ... FROM x is correctly both.
    const readable = text.replace(/\bDELETE\s+FROM\b/gi, 'DELETE      ');
    collect(RE_FROM, readable, reads, line);
    collect(RE_JOIN, readable, reads, line);
    tag(creates, c0); tag(writes, w0); tag(reads, r0);
  }
  return { creates, writes, reads };
}


// ---------------------------------------------------------------------------
// Which database a query runs against.
//
// This repository talks to TWO SQLite files. The app's own, through the `db`,
// `rows`, `row` and `run` helpers exported by server/db/index.js — and a second
// one, the league chat corpus, opened read-only with its own DatabaseSync
// handle from chatDbPath()/messagesDbPath(). Without this distinction the map
// pools both into one namespace and reports the corpus tables as "read by the
// app and written by nothing", which is a false alarm: they are filled by
// replacing the whole file through POST /api/league-chat/upload. A map that
// cries wolf gets switched off, and its true findings go with it.
// ---------------------------------------------------------------------------

const APP_HELPERS = new Set(['rows', 'row', 'run', 'db']);

/** Handle names in this file that are NOT the app's database. */
function foreignHandles(file) {
  const names = new Map();   // identifier -> the path expression it was opened on
  // server/db/index.js is where the app's own handle is opened. Its DatabaseSync
  // IS the app database, not a second one.
  if (file.path === 'server/db/index.js') return names;
  for (const m of file.text.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:new\s+DatabaseSync|openChatDb)\s*\(\s*([^,)]*)/g)) {
    names.set(m[1], (m[2] || '').trim() || 'another file');
  }
  for (const m of file.text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*new\s+DatabaseSync\s*\(\s*([^,)]*)/g)) {
    if (!names.has(m[1])) names.set(m[1], (m[2] || '').trim() || 'another file');
  }
  return names;
}

/**
 * The handle a SQL literal was handed to: 'app', or the name of a local
 * DatabaseSync. Read by looking back from the string to the call that takes it.
 */
function handleFor(file, offset, foreign) {
  const before = file.text.slice(Math.max(0, offset - 120), offset);
  const viaMethod = before.match(/([A-Za-z_$][\w$]*)\s*\.\s*(?:prepare|exec|run|all|get)\s*\(\s*$/);
  if (viaMethod) {
    const name = viaMethod[1];
    if (foreign.has(name)) return { handle: name, where: foreign.get(name) };
    return { handle: 'app', where: null };
  }
  const viaHelper = before.match(/([A-Za-z_$][\w$]*)\s*\(\s*$/);
  if (viaHelper && APP_HELPERS.has(viaHelper[1])) return { handle: 'app', where: null };
  if (viaHelper && foreign.has(viaHelper[1])) return { handle: viaHelper[1], where: foreign.get(viaHelper[1]) };
  // A DDL block or a query we could not attribute. The app's own database is
  // the right default: every other handle in this repository is opened
  // read-only, so an unattributed WRITE is the app's by construction.
  return { handle: 'app', where: null };
}

// ---------------------------------------------------------------------------
// Modules: imports, exports, and the identifiers a file declares.
// ---------------------------------------------------------------------------

function moduleEdges(code) {
  const imports = [];       // { spec, names[], dynamic }
  const exports = [];       // { name, line }
  let m;

  const add = (spec, namesRaw, dynamic, idx) => {
    const parts = (namesRaw ?? '').replace(/[{}]/g, ' ').split(',').map(x => x.trim()).filter(Boolean);
    const ok = (x) => x && x !== '*' && /^[A-Za-z_$][\w$]*$/.test(x);
    const names = parts.map(x => x.split(/\s+as\s+/)[0].trim()).filter(ok);
    // `import { syncAll as syncNflverse }` — the local alias is the only name
    // the calls are written under. Reading only the exported name made an
    // aliased import look like an export nothing ever calls.
    const aliases = parts.map(x => {
      const [imported, local] = x.split(/\s+as\s+/).map(y => y.trim());
      return { imported, local: local ?? imported };
    }).filter(x => ok(x.imported) && ok(x.local));
    imports.push({ spec, names, aliases, dynamic, line: lineOf(code, idx) });
  };

  const RE_STATIC = /\bimport\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = RE_STATIC.exec(code))) add(m[2], m[1], false, m.index);
  const RE_BARE = /\bimport\s*['"]([^'"]+)['"]/g;
  while ((m = RE_BARE.exec(code))) add(m[1], '', false, m.index);
  const RE_REEXPORT = /\bexport\s+(\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = RE_REEXPORT.exec(code))) add(m[2], m[1] === '*' ? '' : m[1], false, m.index);
  // Dynamic import, including the `const { x } = await import('./y.js')` and
  // `import('./y.js').then(m => m.fn())` forms this server leans on heavily.
  const RE_DYN = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = RE_DYN.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 220), m.index);
    const destructured = before.match(/(?:const|let|var)\s*(\{[^}]*\})\s*=\s*(?:await\s*)?$/);
    const after = code.slice(m.index, m.index + 400);
    const thenNames = [...after.matchAll(/\bm\.([A-Za-z_$][\w$]*)/g)].map(x => x[1]);
    add(m[1], (destructured?.[1] ?? '') + ',' + thenNames.join(','), true, m.index);
  }

  // A worker thread is a real dependency that the word `import` never appears
  // in. Without this, the three modules that only ever run on a worker
  // (report-worker, job-worker, loop-watchdog-worker — the whole point of PRs
  // #17, #29 and #32) look like dead code.
  const RE_WORKER = /new\s+Worker\(\s*(?:new\s+URL\(\s*)?['"]([^'"]+)['"]/g;
  while ((m = RE_WORKER.exec(code))) add(m[1], '', true, m.index);

  const RE_EXPORT_DECL = /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = RE_EXPORT_DECL.exec(code))) exports.push({ name: m[1], line: lineOf(code, m.index) });
  const RE_EXPORT_LIST = /\bexport\s*\{([^}]*)\}(?!\s*from)/g;
  while ((m = RE_EXPORT_LIST.exec(code))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exports.push({ name, line: lineOf(code, m.index) });
    }
  }
  const RE_EXPORT_DEFAULT = /\bexport\s+default\b/g;
  while ((m = RE_EXPORT_DEFAULT.exec(code))) exports.push({ name: 'default', line: lineOf(code, m.index) });

  return { imports, exports };
}

function lineOf(text, idx) {
  let l = 1;
  for (let k = 0; k < idx && k < text.length; k++) if (text[k] === '\n') l++;
  return l;
}

/** Resolve a relative specifier to a repo-relative file path, or null. */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(ROOT, fromFile)), spec);
  const tries = [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
    path.join(base, 'index.js'), path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const t of tries) {
    try { if (fs.statSync(t).isFile()) return path.relative(ROOT, t); } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Surfaces: HTTP routes, scheduler jobs, and the client calls that reach them.
// ---------------------------------------------------------------------------

/** `app.use('/api/trades', ...mw, tradesRouter)` -> { 'server/routes/trades.js': '/api/trades' } */
function routeMounts(indexCode) {
  const varToFile = new Map();
  let m;
  const RE_DYN_DEFAULT = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = RE_DYN_DEFAULT.exec(indexCode))) {
    for (const part of m[1].split(',')) {
      const alias = part.includes(':') ? part.split(':')[1].trim() : part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) varToFile.set(alias, m[2]);
    }
  }
  const RE_STATIC_DEFAULT = /\bimport\s+([A-Za-z_$][\w$]*)\s*,?\s*(?:\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = RE_STATIC_DEFAULT.exec(indexCode))) varToFile.set(m[1], m[2]);

  const mounts = [];
  const RE_USE = /\bapp\.use\(\s*['"](\/[^'"]*)['"]\s*,([^)]*)\)/g;
  while ((m = RE_USE.exec(indexCode))) {
    const last = m[2].trim().split(',').pop().trim().replace(/^\.\.\./, '');
    const spec = varToFile.get(last);
    if (spec) mounts.push({ prefix: m[1], file: resolveSpec('server/index.js', spec) ?? spec });
  }
  return mounts;
}

/** Every `r.get('/x')` in a route file, with the line it sits on. */
function routeHandlers(code) {
  const out = [];
  const RE = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all)\(\s*['"](\/[^'"]*)['"]/g;
  let m;
  while ((m = RE.exec(code))) out.push({ method: m[2].toUpperCase(), path: m[3], line: lineOf(code, m.index) });
  return out;
}

/**
 * The scheduler's JOBS table. Two shapes in use:
 *   name: { run: someImportedFunction, tier: 'live', ... }
 *   name: { run: () => import('./x.js').then(m => m.fn()), ... }
 */
function schedulerJobs(code, file) {
  const start = code.indexOf('export const JOBS');
  if (start === -1) return [];
  const open = code.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = code.slice(open, end + 1);
  const jobs = [];
  const RE_JOB = /(^|[\n{,])\s*([a-z][\w]*)\s*:\s*\{/g;
  let m;
  while ((m = RE_JOB.exec(body))) {
    const from = m.index + m[0].length;
    const chunk = body.slice(from, from + 900);
    const tier = chunk.match(/tier:\s*['"](\w+)['"]/)?.[1] ?? 'heavy';
    const label = chunk.match(/label:\s*['"]([^'"]*)['"]/)?.[1] ?? '';
    const dyn = chunk.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/)?.[1] ?? null;
    const fn = chunk.match(/\brun:\s*([A-Za-z_$][\w$]*)\b/)?.[1]
      ?? chunk.match(/\bm\.([A-Za-z_$][\w$]*)/)?.[1] ?? null;
    jobs.push({
      name: m[2], tier, label, runFn: fn,
      runModule: dyn ? resolveSpec(file, dyn) : null,
      line: lineOf(code, open + m.index),
    });
  }
  return jobs;
}

/** Client-side calls: api('/leagues/1/sync') and bare fetch('/api/...'). */
function clientCalls(raw) {
  const out = [];
  const norm = s => s.replace(/\$\{[^}]*\}/g, ':p').replace(/\?.*$/, '');
  let m;
  const RE_API = /\bapi(?:<[^>]*>)?\(\s*[`'"]([^`'"]+)[`'"]/g;
  while ((m = RE_API.exec(raw))) out.push({ path: '/api' + norm(m[1]), line: lineOf(raw, m.index) });
  const RE_FETCH = /\bfetch\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g;
  while ((m = RE_FETCH.exec(raw))) out.push({ path: norm(m[1]), line: lineOf(raw, m.index) });
  return out;
}

// ---------------------------------------------------------------------------
// Field-level wiring. A payload key that is attached and never read is the
// quietest orphan there is: it costs a database round trip on every request and
// no surface shows it. A read is `.key`, `['key']`, a destructure, or the key
// as a string; an assignment (`.key =`) is not a read.
// ---------------------------------------------------------------------------

const KEY_MIN_LEN = 6;
const KEY_STOP = new Set(['length', 'toFixed', 'forEach', 'filter', 'length', 'message', 'toString', 'target', 'status', 'result', 'string', 'number', 'object', 'method', 'params', 'random', 'concat', 'reduce']);

function payloadKeys(code) {
  // Only the ATTACHMENT form: `engine.external_benchmarks = ...`, a field bolted
  // onto an object that is built once and handed onward. Keys written inline in
  // a returned object literal are deliberately not flagged — an API response is
  // allowed to carry a field this repository never reads back, because the
  // reader is a person looking at JSON. A field attached to a shared computed
  // object is different: it costs work on every request and reaches nobody.
  const out = new Map();
  let m;
  const RE_ATTACH = /\b([A-Za-z_$][\w$]*)\.([a-z][\w]{4,})\s*=\s*[^=]/g;
  while ((m = RE_ATTACH.exec(code))) {
    if (KEY_STOP.has(m[2])) continue;
    // Skip the obvious non-payload receivers: res.*, process.*, module.*, this.*
    if (/^(res|req|process|module|globalThis|window|document|exports|console)$/.test(m[1])) continue;
    if (!out.has(m[2])) out.set(m[2], lineOf(code, m.index));
  }
  return out;
}

function keyReads(code, strings) {
  const reads = new Set();
  let m;
  const RE_ACCESS = /\.([A-Za-z_$][\w$]*)\s*(?!=[^=])/g;
  while ((m = RE_ACCESS.exec(code))) {
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/^\s*=[^=]/.test(after)) continue;   // an assignment, not a read
    reads.add(m[1]);
  }
  const RE_BRACKET = /\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g;
  while ((m = RE_BRACKET.exec(code))) reads.add(m[1]);
  // Destructuring: `const { a, b: c } = x`
  const RE_DESTRUCT = /(?:const|let|var|\()\s*\{([^{}]*)\}\s*(?:=|\))/g;
  while ((m = RE_DESTRUCT.exec(code))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) reads.add(name);
    }
  }
  // A key named in a string is a read too: JSON.parse paths, SQL column lists,
  // and the client reading a field by name.
  for (const { text } of strings) {
    for (const w of text.match(/[A-Za-z_$][\w$]{3,}/g) ?? []) reads.add(w);
  }
  return reads;
}

/** `const playerOpportunity = ...` declared and never named again, anywhere. */
function declarations(code) {
  const out = new Map();
  const RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]{4,})\s*=/g;
  let m;
  while ((m = RE.exec(code))) if (!out.has(m[1])) out.set(m[1], lineOf(code, m.index));
  return out;
}

function identifierCounts(code) {
  const counts = new Map();
  for (const w of code.match(/[A-Za-z_$][\w$]*/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
}


// ---------------------------------------------------------------------------
// Gated edges. A call sitting behind a parameter that defaults to false, which
// only a script or a test ever turns on, is real as code and false as
// behaviour. Drawing it is how a map states confidently that the projection
// engine prices availability when the running app never takes that branch.
// ---------------------------------------------------------------------------

/** `{ start, end }` of the body of `function NAME(...) { ... }`, or null. */
function bodyRange(code, name) {
  const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(code);
  if (!m) return null;
  const open = code.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return { start: open, end: i }; }
  }
  return null;
}

/**
 * Regions of each file that only run when an off-by-default flag is on.
 *
 * Found by: a call guarded by a bare identifier (`if (flag) doIt()`,
 * `flag && doIt()`), where that identifier has a `= false` or `= null` default
 * somewhere, and every place in the repository that passes it true lives under
 * scripts/ or test/. The guarded function's whole body is then gated, provided
 * every call to it in that file is guarded the same way.
 */
function gatedRegions(files) {
  const enabledIn = new Map();   // flag -> [files that set it true]
  const defaulted = new Set();   // flags with a false/null default
  for (const f of files.values()) {
    for (const m of f.code.matchAll(/\b([a-z][\w]*)\s*=\s*(?:false|null)\s*[,}]/g)) defaulted.add(m[1]);
    for (const m of f.code.matchAll(/\b([a-z][\w]*)\s*:\s*true\b/g)) {
      if (!enabledIn.has(m[1])) enabledIn.set(m[1], []);
      enabledIn.get(m[1]).push(f.path);
    }
  }

  const out = new Map();   // file -> [{ flag, callee, start, end }]
  for (const f of files.values()) {
    if (f.tree === 'test') continue;
    const guards = [
      ...f.code.matchAll(/\bif\s*\(\s*([a-z][\w]*)\s*\)\s*([A-Za-z_$][\w$]*)\s*\(/g),
      ...f.code.matchAll(/\b([a-z][\w]*)\s*&&\s*([A-Za-z_$][\w$]*)\s*\(/g),
    ];
    for (const g of guards) {
      const [, flag, callee] = g;
      if (!defaulted.has(flag)) continue;
      const enablers = enabledIn.get(flag) ?? [];
      // Enabled anywhere the app actually runs? Then it is a live edge.
      if (enablers.some(p => !/^(scripts|test)\//.test(p))) continue;
      const range = bodyRange(f.code, callee);
      if (!range) continue;
      // Every call to the callee in this file must be guarded, or the body runs
      // on some other path too.
      const calls = [...f.code.matchAll(new RegExp(`\\b${callee}\\s*\\(`, 'g'))]
        .filter(c => c.index !== range.start && !f.code.slice(Math.max(0, c.index - 20), c.index).includes('function'));
      const guarded = calls.every(c => {
        const before = f.code.slice(Math.max(0, c.index - 40), c.index);
        return new RegExp(`(?:if\\s*\\(\\s*${flag}\\s*\\)\\s*|${flag}\\s*&&\\s*)$`).test(before);
      });
      if (!guarded || !calls.length) continue;
      if (!out.has(f.path)) out.set(f.path, []);
      out.get(f.path).push({
        flag, callee, start: range.start, end: range.end,
        line: lineOf(f.code, range.start),
        enabled_by: enablers.length ? enablers : ['nothing in the repository'],
      });
    }
  }
  return out;
}

/** Is `line` inside a region of `file` that only a script can switch on? */
function gateFor(gated, file, line, code) {
  for (const r of gated.get(file) ?? []) {
    if (line >= lineOf(code, r.start) && line <= lineOf(code, r.end)) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Staleness. Two modules can read the same table and behave in opposite ways:
// one names it in a cache fingerprint and recomputes when it changes, the other
// memoises on a bare key and serves the pre-change answer for the life of the
// process. On a data-flow map they look identical, and the second is the
// dangerous one — it is how a verification step returns "no change" and is
// believed.
// ---------------------------------------------------------------------------

const FRESHNESS = /fingerprint|stamp|fitted_at|updated_at|computed_at|version|digest|mtime|etag/i;

function blindCaches(file) {
  const caches = [...file.code.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new Map\(\)/gm)].map(m => m[1]);
  if (!caches.length) return [];
  const keys = [];
  for (const name of caches) {
    for (const m of file.text.matchAll(new RegExp(`\\b${name}\\.set\\(([^,]{0,120}),`, 'g'))) keys.push(m[1]);
  }
  for (const m of file.text.matchAll(/\bmemo\(([^,]{0,120}),/g)) keys.push(m[1]);
  if (!keys.length) return [];
  if (keys.some(k => FRESHNESS.test(k))) return [];
  // Only the unambiguous case is reported. A CONSTANT key means "compute once
  // per process and never again" — there is no input in the key at all, so no
  // write to anything can ever dislodge it. A key built from request arguments
  // is a judgement call (it may be cleared, it may be short-lived), and a map
  // that reports judgement calls as defects gets switched off.
  const constant = keys.filter(k => /^\s*['"][^'"$`]+['"]\s*$/.test(k));
  if (!constant.length) return [];
  return [{ caches, keys: [...new Set(constant.map(k => k.trim()))].slice(0, 8), constant: constant.length }];
}

// ---------------------------------------------------------------------------
// Function-level reach. The module graph cannot tell two functions in the same
// file apart, and that is exactly where the most expensive kind of wiring bug
// hides: `availability()` and `weeklyAvailability()` live in one module, so a
// module map says they read the same thing. They do not. One reads the fitted
// tables and one reads four-year-old usage history, and the endpoint that
// serves them picks between them on a query parameter.
//
// So: split each file into functions, attribute each SQL statement to the
// function whose body contains it, and close over the call graph to a fixpoint
// so a function inherits what the functions it calls read.
// ---------------------------------------------------------------------------

/** Every named function in a file, with the character range of its body. */
function functionUnits(f) {
  const out = new Map();
  const matchFrom = (i, open, close) => {
    let depth = 0;
    for (let j = i; j < f.code.length; j++) {
      if (f.code[j] === open) depth++;
      else if (f.code[j] === close) { depth--; if (depth === 0) return j; }
    }
    return -1;
  };
  const claim = (name, bodyOpen, declAt, exported) => {
    if (!name || out.has(name) || bodyOpen === -1 || f.code[bodyOpen] !== '{') return;
    const end = matchFrom(bodyOpen, '{', '}');
    if (end === -1) return;
    out.set(name, { name, start: bodyOpen, end, line: lineOf(f.code, declAt), exported });
  };
  // function NAME(...) { — the body brace is the first `{` AFTER the matching
  // `)`, never the first `{` after the `(`. A destructured parameter list
  // (`function availability({ through = SEASON - 1 } = {})`) opens a brace
  // inside the parameters, and taking that one gives every such function a
  // body four characters long — which silently emptied their table sets.
  for (const m of f.code.matchAll(/(export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const closeParen = matchFrom(m.index + m[0].length - 1, '(', ')');
    if (closeParen === -1) continue;
    claim(m[2], f.code.indexOf('{', closeParen), m.index, Boolean(m[1]));
  }
  // const NAME = (...) => { — the regex already ends on the body brace.
  for (const m of f.code.matchAll(/(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)) {
    claim(m[2], m.index + m[0].length - 1, m.index, Boolean(m[1]));
  }
  // const NAME = async function (...) {
  for (const m of f.code.matchAll(/(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*[A-Za-z_$\w]*\s*\(/g)) {
    const closeParen = matchFrom(m.index + m[0].length - 1, '(', ')');
    if (closeParen === -1) continue;
    claim(m[2], f.code.indexOf('{', closeParen), m.index, Boolean(m[1]));
  }
  return out;
}

/** Which function body an offset falls inside — the innermost one wins. */
function unitAt(units, offset) {
  let best = null;
  for (const u of units.values()) {
    if (offset < u.start || offset > u.end) continue;
    if (!best || (u.end - u.start) < (best.end - best.start)) best = u;
  }
  return best;
}

const CALL_STOP = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await',
  'function', 'new', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Map', 'Set',
  'Date', 'Promise', 'Error', 'parseInt', 'parseFloat', 'require', 'import']);

/**
 * `file#fn` -> { own tables, calls, reach } for every named function in the
 * repository, closed over the call graph.
 *
 * Calls resolve against the same file first, then against the file's imports.
 * A call we cannot resolve is dropped rather than guessed at: an inherited
 * table set that is too large makes two different functions look identical,
 * which is the failure this whole section exists to avoid.
 */
function functionReach(files) {
  const units = new Map();      // file -> Map name -> unit
  const nodes = new Map();      // `file#name` -> node
  for (const f of files.values()) {
    const us = functionUnits(f);
    units.set(f.path, us);
    for (const u of us.values()) {
      nodes.set(`${f.path}#${u.name}`, {
        id: `${f.path}#${u.name}`, file: f.path, name: u.name, line: u.line,
        exported: u.exported, reads: new Set(), writes: new Set(), calls: new Set(),
      });
    }
  }
  // SQL, attributed to the innermost function containing the statement.
  for (const f of files.values()) {
    const us = units.get(f.path);
    for (const kind of ['reads', 'writes']) {
      for (const e of f.sql[kind]) {
        if (e.handle && e.handle !== 'app') continue;
        const u = unitAt(us, e.at ?? -1);
        if (!u) continue;
        nodes.get(`${f.path}#${u.name}`)[kind].add(e.table);
      }
    }
  }
  // Calls.
  for (const f of files.values()) {
    const us = units.get(f.path);
    const importOf = new Map();
    for (const imp of f.imports) if (imp.resolved) for (const n of imp.names) importOf.set(n, imp.resolved);
    for (const m of f.code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (CALL_STOP.has(m[1])) continue;
      const caller = unitAt(us, m.index);
      if (!caller || caller.name === m[1]) continue;
      const target = us.has(m[1]) ? `${f.path}#${m[1]}`
        : importOf.has(m[1]) ? `${importOf.get(m[1])}#${m[1]}` : null;
      if (target && nodes.has(target)) nodes.get(`${f.path}#${caller.name}`).calls.add(target);
    }
  }
  // Fixpoint. Bounded because a cycle would otherwise never settle.
  for (const n of nodes.values()) { n.reach = new Set(n.reads); n.reachWrites = new Set(n.writes); }
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const n of nodes.values()) {
      for (const c of n.calls) {
        const t = nodes.get(c);
        if (!t) continue;
        for (const x of t.reach) if (!n.reach.has(x)) { n.reach.add(x); changed = true; }
        for (const x of t.reachWrites) if (!n.reachWrites.has(x)) { n.reachWrites.add(x); changed = true; }
      }
    }
    if (!changed) break;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Columns. A column declared and read and never written is a field that reads
// as null on every row forever, and the surface above it usually has a `??`
// next to it so nothing ever errors.
// ---------------------------------------------------------------------------

const RE_TABLE_BODY = /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_]\w*)["'`\]]?\s*\(/gi;
const RE_ADD_COLUMN = /\bALTER\s+TABLE\s+["'`[]?([A-Za-z_]\w*)["'`\]]?\s+ADD\s+(?:COLUMN\s+)?["'`[]?([A-Za-z_]\w*)/gi;
/** Columns whose name says nothing about which table they belong to. */
const GENERIC_COLUMN = /^(id|name|season|week|team|player_id|created_at|updated_at|value|source|kind|type|status|label|note|notes|data|payload|config|n|scope|position|team_id|league_id|game_id|abbr|slug|version|rank|tier|gap|date|day|year|month)$/i;

/** table -> Set of declared column names, from CREATE TABLE and ALTER ... ADD. */
function tableColumns(files) {
  const cols = new Map();
  const put = (t, c) => { if (!cols.has(t)) cols.set(t, new Set()); cols.get(t).add(c); };
  for (const f of files.values()) {
    for (const { text } of f.strings) {
      if (!looksSql(text)) continue;
      let m;
      RE_TABLE_BODY.lastIndex = 0;
      while ((m = RE_TABLE_BODY.exec(text))) {
        const open = m.index + m[0].length - 1;
        let depth = 0, end = -1;
        for (let i = open; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end === -1) continue;
        for (const line of text.slice(open + 1, end).split(/,(?![^(]*\))/)) {
          const c = /^\s*["'`[]?([A-Za-z_]\w*)/.exec(line);
          if (c && !/^\s*(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) put(m[1], c[1]);
        }
      }
      RE_ADD_COLUMN.lastIndex = 0;
      while ((m = RE_ADD_COLUMN.exec(text))) put(m[1], m[2]);
    }
  }
  return cols;
}

/** Which tables a single SQL statement names, and how. */
function statementTables(text) {
  const reads = new Set(), writes = new Set();
  let m;
  for (const re of [RE_FROM, RE_JOIN]) { re.lastIndex = 0; while ((m = re.exec(text))) reads.add(m[1]); }
  for (const re of [RE_INSERT, RE_REPLACE, RE_UPDATE]) { re.lastIndex = 0; while ((m = re.exec(text))) writes.add(m[1]); }
  return { reads, writes };
}

// ---------------------------------------------------------------------------
// Scope. Nick has ruled out betting FEATURES, not knowing what connects to
// what, so the betting half is mapped and then tagged, rather than skipped. A
// map with holes in it is worse than no map, because people trust it.
// ---------------------------------------------------------------------------

const BETTING_FILE = /(betting|\bwong\b|odds|parlay|staking|teaser|polymarket|book-feeds|line-shop|line-move|opening-lines|beat-the-close|execution-|prop-|props|clv|pick-|picks|market-movement|nfl-market|edge\.js|mlb)/i;
const BETTING_TABLE = /^(nfl_odds|nfl_line|nfl_prop|nfl_quote|nfl_ticket|nfl_teaser|nfl_execution|nfl_clv|nfl_pick|nfl_forward|nfl_parlay|nfl_stak|nfl_book|nfl_sgo|nfl_evidence|nfl_trial|nfl_policy|nfl_risk|wong_|parlay_|staking_|bet_|bets_|book_|polymarket_|prediction_market|mlb_|picks_|execution_|market_)/i;
const FANTASY_FILE = /(fantasy|lineup|waiver|trade|draft|roster|league|manager|projection|player-week|contingency|season-sim|start-sit|dynasty)/i;

const scopeOfFile = (f) => (FANTASY_FILE.test(f) && !/nfl-betting|props-tickets|wong/i.test(f)) ? 'fantasy'
  : BETTING_FILE.test(f) ? 'betting' : 'shared';
const scopeOfTable = (t) => BETTING_TABLE.test(t) ? 'betting'
  : /^(league|team|player|draft|roster|manager|trade|waiver|lineup|chat|espn|nfl_availability|nfl_injur|nfl_snap|nfl_usage|nfl_depth|nfl_transaction|shrinkage|projection)/i.test(t) ? 'fantasy'
  : 'shared';

// ---------------------------------------------------------------------------
// Build the model.
// ---------------------------------------------------------------------------

function build() {
  const files = new Map();       // repo-relative path -> analysis
  for (const { dir, kind } of TREES) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, abs);
      const raw = fs.readFileSync(abs, 'utf8');
      const { code, text, strings } = scan(raw);
      const { imports, exports } = moduleEdges(text);
      const file = { path: rel, tree: kind, raw, code, text, strings };
      const foreign = foreignHandles(file);
      files.set(rel, {
        path: rel, tree: kind, raw, code, text, strings, imports, exports,
        foreign_handles: [...foreign.keys()],
        sql: sqlEdges(strings, at => handleFor(file, at, foreign)),
        routes: rel.startsWith('server/routes/') ? routeHandlers(text) : [],
        calls: kind === 'client' || kind === 'extension' ? clientCalls(text) : [],
        scope: scopeOfFile(rel),
      });
    }
  }

  // Import graph, both directions.
  const importsOf = new Map(), importedBy = new Map();
  for (const f of files.values()) {
    const targets = new Set();
    for (const imp of f.imports) {
      const resolved = resolveSpec(f.path, imp.spec);
      if (resolved && files.has(resolved)) { targets.add(resolved); imp.resolved = resolved; }
    }
    importsOf.set(f.path, targets);
    for (const t of targets) {
      if (!importedBy.has(t)) importedBy.set(t, new Set());
      importedBy.get(t).add(f.path);
    }
  }

  // Surfaces. Each is a named entry point with a kind; modules inherit the
  // surfaces that can reach them.
  const surfaces = [];
  const indexFile = files.get('server/index.js');
  const mounts = indexFile ? routeMounts(indexFile.text) : [];
  const mountByFile = new Map(mounts.map(m => [m.file, m.prefix]));
  for (const [file, prefix] of mountByFile) {
    const rf = files.get(file);
    if (!rf) continue;
    for (const h of rf.routes) {
      surfaces.push({ kind: 'route', name: `${h.method} ${prefix}${h.path}`.replace(/\/$/, ''), file, line: h.line });
    }
  }
  const schedFile = files.get('server/services/scheduler.js');
  const jobs = schedFile ? schedulerJobs(schedFile.text, 'server/services/scheduler.js') : [];
  for (const j of jobs) {
    // A job's module is either the one it dynamically imports, or the module
    // the scheduler imported its run function from.
    let file = j.runModule;
    if (!file && j.runFn && schedFile) {
      const imp = schedFile.imports.find(i => i.names.includes(j.runFn));
      file = imp?.resolved ?? null;
    }
    // A job whose module we could not resolve gets NO reach attributed to it.
    // Pointing it at scheduler.js instead would make every job look like it
    // reaches every module the scheduler imports, which is how a map starts
    // lying.
    surfaces.push({ kind: 'job', name: j.name, file, tier: j.tier, label: j.label, line: j.line, unresolved: !file });
  }
  for (const f of files.values()) {
    if (f.tree === 'script' && !path.basename(f.path).startsWith('_')) {
      surfaces.push({ kind: 'script', name: `npm/node ${f.path}`, file: f.path, line: 1 });
    }
    if (f.tree === 'client' && /\/(main|App)\.tsx?$/.test(f.path)) {
      surfaces.push({ kind: 'client', name: f.path, file: f.path, line: 1 });
    }
    if (f.tree === 'extension') surfaces.push({ kind: 'extension', name: f.path, file: f.path, line: 1 });
  }
  // Migrations are loaded by filename scan (server/db/migrate.js reads the
  // directory), so "nothing imports it" is a lie about them. Same for the seed
  // fragments and the schema fragments, which db/index.js applies by name.
  for (const f of files.values()) {
    if (/^server\/migrations\/\d+_.+\.js$/.test(f.path)) {
      surfaces.push({ kind: 'migration', name: path.basename(f.path), file: f.path, line: 1 });
    }
  }
  surfaces.push({ kind: 'boot', name: 'server/index.js', file: 'server/index.js', line: 1 });

  // Reachability, breadth-first so every module carries the HOP DISTANCE to the
  // nearest surface that reaches it. Distance matters: in a monolith this size
  // the import closure of any route eventually touches most of the server, so
  // "reachable" on its own is close to meaningless. A module two hops from a
  // route is wired into it; a module nine hops away shares a library with it.
  //
  // server/index.js is deliberately excluded as a source. It imports every
  // router, so walking forward from it marks the entire server 'reachable from
  // boot', which is true and tells you nothing.
  const reach = new Map();       // module -> Set of surface kinds
  const reachNames = new Map();  // module -> Map of surface name -> hop distance
  for (const s of surfaces) {
    if (!s.file || s.unresolved) continue;
    // server/index.js imports every router, so walking its whole closure marks
    // the entire server 'reachable from boot' — true, and useless. Two hops is
    // the honest read: what the app wires up itself at startup, and what those
    // things reach directly (a watchdog and the worker it spawns).
    const cap = s.kind === 'boot' ? 2 : MAX_HOPS;
    const seen = new Map();
    let frontier = [s.file];
    let depth = 0;
    while (frontier.length && depth <= cap) {
      const next = [];
      for (const cur of frontier) {
        if (!cur || seen.has(cur) || !files.has(cur)) continue;
        seen.set(cur, depth);
        if (!reach.has(cur)) { reach.set(cur, new Set()); reachNames.set(cur, new Map()); }
        reach.get(cur).add(s.kind);
        const key = `${s.kind}:${s.name}`;
        const prior = reachNames.get(cur).get(key);
        if (prior == null || depth < prior) reachNames.get(cur).set(key, depth);
        for (const t of importsOf.get(cur) ?? []) next.push(t);
      }
      frontier = next;
      depth++;
    }
  }
  for (const f of files.values()) {
    if (f.tree === 'test') {
      if (!reach.has(f.path)) { reach.set(f.path, new Set()); reachNames.set(f.path, new Map()); }
      reach.get(f.path).add('test');
      for (const t of importsOf.get(f.path) ?? []) {
        if (!reach.has(t)) { reach.set(t, new Set()); reachNames.set(t, new Map()); }
        reach.get(t).add('test');
      }
    }
  }

  // Which regions of which files only run behind an off-by-default flag.
  const gated = gatedRegions(files);

  // Tables.
  const tableUniverse = new Set();
  for (const f of files.values()) for (const c of f.sql.creates) tableUniverse.add(c.table);
  const tables = new Map();
  const tableEntry = (t) => {
    if (!tables.has(t)) tables.set(t, { table: t, scope: scopeOfTable(t), creates: [], writes: [], reads: [] });
    return tables.get(t);
  };
  for (const f of files.values()) {
    for (const kind of ['creates', 'writes', 'reads']) {
      for (const e of f.sql[kind]) {
        if (!tableUniverse.has(e.table)) continue;
        const gate = gateFor(gated, f.path, e.line, f.code);
        tableEntry(e.table)[kind].push({ file: f.path, line: e.line, tree: f.tree,
          gated_by: gate ? gate.flag : null, handle: e.handle ?? 'app', opened_on: e.opened_on ?? null });
      }
    }
  }
  const fnReach = functionReach(files);
  const columns = tableColumns(files);
  return { files, importsOf, importedBy, surfaces, mounts, mountByFile, jobs, tables, reach,
    reachNames, gated, fnReach, columns };
}

// ---------------------------------------------------------------------------
// Findings. Two families, named separately on purpose.
//   MISSING FEED — a surface depends on something nothing produces.
//   ORPHAN       — something produced that reaches no surface.
// ---------------------------------------------------------------------------

const SERVED = new Set(['route', 'job', 'client', 'extension', 'boot']);
/** Past this many import hops a module is sharing a library, not wired in. */
const MAX_HOPS = 12;
/** What counts as "wired into" for the purpose of naming a surface in a finding. */
const CLOSE_HOPS = 3;
const served = (kinds) => [...(kinds ?? [])].some(k => SERVED.has(k));


/** Surface names that reach `file` within `hops`, nearest first. */
function surfacesOf(reachNames, file, hops = MAX_HOPS) {
  const m = reachNames.get(file);
  if (!m) return [];
  return [...m.entries()].filter(([, d]) => d <= hops)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name, d]) => `${name} (${d} hop${d === 1 ? '' : 's'})`);
}

/**
 * The `/api/<family>` prefixes, jobs and scripts a set of modules is wired
 * into, each with the fewest import hops to it. Hops are the honest part: in a
 * monolith this size almost everything is eventually reachable from almost
 * everything, so a family at 1-2 hops is a real dependency and one at 9 is two
 * modules sharing a library.
 */
function surfaceFamilies(reachNames, filesList, hops = MAX_HOPS) {
  const best = (map, key, d) => { if (map.get(key) == null || d < map.get(key)) map.set(key, d); };
  const routes = new Map(), jobs = new Map(), scripts = new Map(), pages = new Map();
  for (const f of filesList) {
    for (const [name, d] of reachNames.get(f) ?? []) {
      if (d > hops) continue;
      if (name.startsWith('route:')) best(routes, '/api/' + (name.split(' ')[1] ?? '').split('/')[2], d);
      else if (name.startsWith('job:')) best(jobs, name.slice(4), d);
      else if (name.startsWith('script:')) best(scripts, name.replace(/^script:npm\/node /, ''), d);
      else if (!name.startsWith('test:')) best(pages, name, d);
    }
  }
  const fmt = (m) => [...m.entries()].filter(([k]) => k && k !== '/api/undefined')
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([k, d]) => ({ name: k, hops: d }));
  return { route_families: fmt(routes), jobs: fmt(jobs), scripts: fmt(scripts), pages: fmt(pages) };
}

/** Only what is genuinely wired in: surfaces within CLOSE_HOPS import hops. */
function close(wiring) {
  const pick = (a) => a.filter(x => x.hops <= CLOSE_HOPS);
  return { route_families: pick(wiring.route_families), jobs: pick(wiring.jobs),
    scripts: pick(wiring.scripts), pages: pick(wiring.pages) };
}

function annotations(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { asserted_producers: {}, expected_orphans: [], notes: {} }; }
}

function findings(model, ann) {
  const { files, importedBy, tables, reach, reachNames, surfaces, mountByFile } = model;
  void mountByFile;
  const out = [];
  const add = (f) => out.push(f);
  const ignored = new Set(ann.expected_orphans ?? []);
  const assertedProducers = ann.asserted_producers ?? {};

  // ---- tables ----------------------------------------------------------
  for (const t of tables.values()) {
    const allReaders = t.reads.filter(r => r.tree !== 'test');
    const allWriters = t.writes.filter(w => w.tree !== 'test');
    // A table only counts as the app's if the APP's handle touches it. The
    // league chat corpus is a second SQLite file opened read-only on its own
    // handle; its tables have no writer here and are not supposed to.
    const foreignOnly = allReaders.concat(allWriters).length > 0
      && allReaders.concat(allWriters).every(e => e.handle && e.handle !== 'app');
    if (foreignOnly) {
      const via = [...new Set(allReaders.concat(allWriters).map(e => e.opened_on).filter(Boolean))];
      t.database = via[0] ?? 'a second database handle';
      if (!ignored.has(`table:${t.table}`)) {
        add({ kind: 'context', rule: 'table-in-another-database', scope: t.scope, subject: t.table,
          detail: `not in the app's database — every query against it runs on a separate handle `
            + `opened on ${via.join(', ') || 'another file'}. Whatever fills it does so by replacing `
            + `that file, which this map cannot see and must not report as a missing writer`,
          evidence: allReaders.slice(0, 4).map(r => `${r.file}:${r.line}`) });
      }
      continue;
    }
    const readers = allReaders.filter(r => !r.handle || r.handle === 'app');
    const writers = allWriters.filter(w => !w.handle || w.handle === 'app');
    const readerFiles = [...new Set(readers.map(r => r.file))];
    const writerFiles = [...new Set(writers.map(w => w.file))];
    const readerKinds = new Set(readerFiles.flatMap(f => [...(reach.get(f) ?? [])]));
    const writerKinds = new Set(writerFiles.flatMap(f => [...(reach.get(f) ?? [])]));
    const asserted = assertedProducers[t.table] ?? null;

    if (readerFiles.length && !writerFiles.length && !ignored.has(`table:${t.table}`)) {
      add({ kind: 'missing-feed', rule: 'table-never-written', scope: t.scope, subject: t.table,
        detail: `read in ${readerFiles.length} file(s), written by nothing in the repository`,
        evidence: readers.slice(0, 6).map(r => `${r.file}:${r.line}`),
        consumers: readerFiles, wiring: close(surfaceFamilies(reachNames, readerFiles, CLOSE_HOPS)),
        asserted });
    } else if (readerFiles.length && writerFiles.length && served(readerKinds)
               && !writerKinds.has('job') && !writerKinds.has('route') && !ignored.has(`table:${t.table}`)) {
      add({ kind: 'missing-feed', rule: 'table-hand-fed', scope: t.scope, subject: t.table,
        detail: `read on a served surface, but every writer is a script someone has to remember to run`,
        evidence: writers.slice(0, 4).map(w => `writer ${w.file}:${w.line}`)
          .concat(readers.slice(0, 4).map(r => `reader ${r.file}:${r.line}`)),
        consumers: readerFiles, wiring: close(surfaceFamilies(reachNames, readerFiles, CLOSE_HOPS)),
        asserted });
    } else if (readerFiles.length && writerFiles.length && served(readerKinds)
               && !writerKinds.has('job') && writerKinds.has('route') && !ignored.has(`table:${t.table}`)) {
      // NOT a missing feed on its own. Most of these are correct: the table
      // holds what a person did — a saved ticket, a draft pick, a session. It
      // is listed so that the ones which hold DERIVED data, and therefore
      // should be on a timer, are visible at all.
      add({ kind: 'context', rule: 'table-never-scheduled', scope: t.scope, subject: t.table,
        detail: `read on a served surface; nothing on a timer fills it — only a route someone has to call`,
        evidence: writers.slice(0, 4).map(w => `writer ${w.file}:${w.line}`),
        consumers: readerFiles, wiring: close(surfaceFamilies(reachNames, readerFiles, CLOSE_HOPS)),
        asserted });
    }
    if (writerFiles.length && !readerFiles.length && !ignored.has(`table:${t.table}`)) {
      add({ kind: 'orphan', rule: 'table-never-read', scope: t.scope, subject: t.table,
        detail: `written by ${writerFiles.length} file(s), read by nothing`,
        evidence: writers.slice(0, 6).map(w => `${w.file}:${w.line}`) });
    }
  }

  // ---- modules ---------------------------------------------------------
  for (const f of files.values()) {
    if (f.tree === 'test' || ignored.has(`module:${f.path}`)) continue;
    const kinds = reach.get(f.path) ?? new Set();
    const importers = [...(importedBy.get(f.path) ?? [])];
    const nonTestImporters = importers.filter(i => files.get(i)?.tree !== 'test');
    const isSurface = surfaces.some(s => s.file === f.path);
    if (isSurface) continue;
    // A migration's exports are called by name by the migration runner.
    if (/^server\/(migrations|db\/schema|db\/seed)\//.test(f.path)) continue;
    if (!importers.length) {
      add({ kind: 'orphan', rule: 'module-imported-by-nothing', scope: f.scope, subject: f.path,
        detail: 'no file in the repository imports it', evidence: [] });
    } else if (!nonTestImporters.length) {
      add({ kind: 'orphan', rule: 'module-only-tested', scope: f.scope, subject: f.path,
        detail: `imported only by its test (${importers.slice(0, 3).join(', ')}) — built, verified, never wired in`,
        evidence: importers.slice(0, 3) });
    } else if (!served(kinds)) {
      add({ kind: 'orphan', rule: 'module-reaches-no-surface', scope: f.scope, subject: f.path,
        detail: `imported by ${nonTestImporters.length} file(s), none of which any route, job or page can reach`,
        evidence: nonTestImporters.slice(0, 4) });
    }
  }

  // ---- exports ---------------------------------------------------------
  const importedNames = new Map();   // target file -> Set of names imported from it
  for (const f of files.values()) {
    for (const imp of f.imports) {
      if (!imp.resolved) continue;
      if (!importedNames.has(imp.resolved)) importedNames.set(imp.resolved, new Set());
      for (const n of imp.names) importedNames.get(imp.resolved).add(n);
      if (f.tree !== 'test') {
        if (!importedNames.has(imp.resolved + '#prod')) importedNames.set(imp.resolved + '#prod', new Set());
        for (const n of imp.names) importedNames.get(imp.resolved + '#prod').add(n);
      }
    }
  }
  for (const f of files.values()) {
    if (f.tree === 'test' || f.tree === 'client') continue;
    if (/^server\/(migrations|db\/schema|db\/seed)\//.test(f.path)) continue;
    const used = importedNames.get(f.path) ?? new Set();
    const usedProd = importedNames.get(f.path + '#prod') ?? new Set();
    for (const e of f.exports) {
      if (e.name === 'default' || ignored.has(`export:${f.path}#${e.name}`)) continue;
      if (!used.has(e.name)) {
        add({ kind: 'orphan', rule: 'export-imported-by-nothing', scope: f.scope,
          subject: `${f.path}#${e.name}`, detail: 'exported and never imported',
          evidence: [`${f.path}:${e.line}`] });
      } else if (!usedProd.has(e.name)) {
        add({ kind: 'orphan', rule: 'export-only-tested', scope: f.scope,
          subject: `${f.path}#${e.name}`, detail: 'exported, imported only by a test',
          evidence: [`${f.path}:${e.line}`] });
      }
    }
  }

  // ---- fields and declarations ----------------------------------------
  const allReads = new Set();
  const globalCounts = new Map();
  for (const f of files.values()) {
    for (const r of keyReads(f.code, f.strings)) allReads.add(r);
    for (const [w, c] of identifierCounts(f.code)) globalCounts.set(w, (globalCounts.get(w) ?? 0) + c);
  }
  for (const f of files.values()) {
    if (f.tree === 'test' || !f.path.startsWith('server/')) continue;
    for (const [key, line] of payloadKeys(f.code)) {
      if (key.length < KEY_MIN_LEN || allReads.has(key) || ignored.has(`field:${key}`)) continue;
      add({ kind: 'orphan', rule: 'field-attached-never-read', scope: f.scope,
        subject: `${key} (${f.path})`,
        detail: 'attached to a payload and read by nothing — not by the server, not by the client, not by a test',
        evidence: [`${f.path}:${line}`], wiring: close(surfaceFamilies(reachNames, [f.path], CLOSE_HOPS)) });
    }
    for (const [name, line] of declarations(f.code)) {
      if (globalCounts.get(name) !== 1 || ignored.has(`local:${name}`)) continue;
      add({ kind: 'orphan', rule: 'value-computed-never-used', scope: f.scope,
        subject: `${name} (${f.path})`,
        detail: 'assigned once and never referenced again anywhere in the repository',
        evidence: [`${f.path}:${line}`] });
    }
  }

  // ---- gated edges -----------------------------------------------------
  for (const [file, regions] of model.gated) {
    for (const r of regions) {
      if (ignored.has(`gate:${file}#${r.flag}`)) continue;
      const f = files.get(file);
      const inside = [];
      for (const kind of ['reads', 'writes']) {
        for (const e of f.sql[kind]) {
          if (e.line >= lineOf(f.code, r.start) && e.line <= lineOf(f.code, r.end)) inside.push(e.table);
        }
      }
      add({ kind: 'context', rule: 'edge-behind-an-off-flag', scope: f.scope,
        subject: `${r.callee}() in ${file}`,
        detail: `runs only when \`${r.flag}\` is true, and the only thing that sets it true is `
          + `${r.enabled_by.join(', ')} — so this is code the running app never reaches, `
          + `however real the import edge looks`,
        evidence: [`${file}:${r.line}`],
        gated_tables: [...new Set(inside)] });
    }
  }

  // ---- caches that cannot see their own inputs -------------------------
  for (const f of files.values()) {
    if (f.tree === 'test' || !f.path.startsWith('server/')) continue;
    const readsTables = [...tables.values()]
      .filter(t => t.reads.some(r => r.file === f.path)).map(t => t.table);
    if (!readsTables.length) continue;
    for (const c of blindCaches(f)) {
      if (ignored.has(`cache:${f.path}`)) continue;
      add({ kind: 'staleness', rule: 'cache-blind-to-its-inputs', scope: f.scope, subject: f.path,
        detail: `memoises ${c.constant} value(s) under a CONSTANT key, in a module that reads `
          + `${readsTables.length} table(s). There is no input in the key, so the first answer of `
          + `the process is served until the process ends, whatever is written underneath it`,
        evidence: c.keys, reads: readsTables.slice(0, 8) });
    }
  }

  // ---- routes and client calls ----------------------------------------
  const routePaths = surfaces.filter(s => s.kind === 'route');
  const matches = (routePath, callPath) => {
    const a = routePath.split('/').filter(Boolean), b = callPath.split('/').filter(Boolean);
    if (a.length !== b.length) return false;
    return a.every((seg, i) => seg.startsWith(':') || b[i].startsWith(':') || seg === b[i]);
  };
  const allCalls = [];
  for (const f of files.values()) for (const c of f.calls) allCalls.push({ ...c, file: f.path });
  for (const c of allCalls) {
    // A path we could not read cleanly out of a template literal is an
    // unknown, not a finding. Saying "no route answers this" about a string we
    // failed to parse is exactly the kind of confident wrong a map must not do.
    if (c.path.includes('$') || c.path.includes('`')) continue;
    if (routePaths.some(r => matches(r.name.split(' ')[1], c.path))) continue;
    add({ kind: 'missing-feed', rule: 'client-call-without-route', scope: scopeOfFile(c.file),
      subject: c.path, detail: 'the client calls this path and no route in the repository answers it',
      evidence: [`${c.file}:${c.line}`] });
  }
  // A palette or sidebar destination with no route behind it is a dead link a
  // user actually clicks. The client's own navigation.ts says this happened
  // before: eight entries outlived their routes.
  const nav = files.get('client/src/navigation.ts');
  const app = files.get('client/src/App.tsx');
  if (nav && app) {
    const declared = new Set([...app.text.matchAll(/<Route\s+path="([^"]*)"/g)].map(x => x[1]));
    for (const m2 of nav.text.matchAll(/\[\s*'[^']*'\s*,\s*'(\/[^']*)'/g)) {
      const dest = m2[1];
      const hit = [...declared].some(d => matches(d, dest) || d === '*');
      if (hit || ignored.has(`destination:${dest}`)) continue;
      add({ kind: 'missing-feed', rule: 'destination-without-route', scope: 'fantasy', subject: dest,
        detail: 'listed as a place the user can go, and the router has no such route',
        evidence: [`client/src/navigation.ts:${lineOf(nav.text, m2.index)}`] });
    }
  }

  for (const r of routePaths) {
    const p = r.name.split(' ')[1];
    if (allCalls.some(c => matches(p, c.path))) continue;
    if (ignored.has(`route:${r.name}`)) continue;
    add({ kind: 'orphan', rule: 'route-no-caller', scope: scopeOfFile(r.file), subject: r.name,
      detail: 'no page or extension calls it', evidence: [`${r.file}:${r.line}`] });
  }

  // ---- what SHOULD be wired ------------------------------------------------
  // Everything above answers "what is wired to what". These four answer the
  // question a person actually asks when they open a map: where is something
  // obviously missing? They find gaps that no test fails on, because in every
  // one of these shapes the code runs, returns a number, and is wrong.
  shouldBeWired(model, ann, add);

  return out;
}

/** Functions whose name says they produce something. */
const PRODUCER = /^(sync|build|fit|refresh|collect|import|backfill|ingest|seed|load|pull|fetch|compute|rebuild)[A-Z]/;

function shouldBeWired(model, ann, add) {
  const { files, fnReach, columns, tables, reach, reachNames } = model;
  const ignored = new Set(ann.expected_orphans ?? []);

  // 1. TWO NAMES FOR ONE THING, READING DIFFERENT DATA.
  //    Two exported functions in one module where one name contains the other,
  //    and the longer one reads tables the shorter one never touches. The
  //    shorter name is the obvious one to reach for and it silently answers
  //    from a different source. This is how `/api/model/availability` came to
  //    serve a durability prior computed from usage history while
  //    `/api/model/availability?week=2` serves the fitted tables.
  const byFile = new Map();
  for (const n of fnReach.values()) {
    if (!n.exported) continue;
    if (!byFile.has(n.file)) byFile.set(n.file, []);
    byFile.get(n.file).push(n);
  }
  for (const [file, list] of byFile) {
    const f = files.get(file);
    if (!f || f.tree === 'test' || f.tree === 'script') continue;
    if (!served(reach.get(file))) continue;
    for (const a of list) {
      for (const b of list) {
        if (a === b || a.name.length >= b.name.length) continue;
        const short = a.name.toLowerCase(), long = b.name.toLowerCase();
        if (!long.includes(short) || short.length < 6) continue;
        // `gameVariance()` and `backfillGameVariance()` are a reader and its
        // producer. Of course the producer touches more tables; that is what it
        // is for. The rule is about two ways to ask the SAME question.
        if (PRODUCER.test(b.name)) continue;
        const extra = [...b.reach].filter(t => !a.reach.has(t));
        if (!extra.length || !a.reach.size) continue;
        if (ignored.has(`pair:${file}#${a.name}|${b.name}`)) continue;
        add({ kind: 'should-wire', rule: 'two-names-different-sources', scope: scopeOfFile(file),
          subject: `${a.name}() vs ${b.name}()`,
          detail: `both are exported from this module and the names read as the same thing, but `
            + `${b.name}() reads ${extra.slice(0, 6).join(', ')} and ${a.name}() does not. `
            + `Whoever reaches for the shorter name gets an answer from a different source, with no error`,
          evidence: [`${file}:${a.line}`, `${file}:${b.line}`] });
      }
    }
  }

  // 2. A COLUMN READ ON A LIVE SURFACE THAT NOTHING WRITES.
  //    Null on every row forever. It never throws, because the reader almost
  //    always has a `?? fallback` sitting next to it, which is why these
  //    survive for years.
  const declared = new Map();     // column -> Set of tables declaring it
  for (const [t, cols] of columns) for (const c of cols) {
    if (!declared.has(c)) declared.set(c, new Set());
    declared.get(c).add(t);
  }
  const colRead = new Map();      // `t.c` -> [{file,line}]
  const colWritten = new Set();   // `t.c`
  const opaqueWrite = new Set();  // tables written through a column list we cannot read
  for (const f of files.values()) {
    for (const { text, line } of f.strings) {
      if (!looksSql(text)) continue;
      const { reads, writes } = statementTables(text);
      // `INSERT INTO t (${COLUMNS.join(', ')}) VALUES ...` names no column this
      // scan can see, and `INSERT INTO t SELECT *` names them all. Either way
      // every column of that table is potentially written, so the table is
      // excluded rather than reported on evidence we do not have.
      if (writes.size && (text.includes('${') || /\*/.test(text))) for (const t of writes) opaqueWrite.add(t);
      const named = new Set([...reads, ...writes]);
      const words = new Set(text.match(/[A-Za-z_]\w*/g) ?? []);
      for (const w of words) {
        const owners = [...(declared.get(w) ?? [])].filter(t => named.has(t));
        if (owners.length !== 1) continue;          // ambiguous: say nothing
        const key = `${owners[0]}.${w}`;
        if (writes.has(owners[0])) colWritten.add(key);
        else if (reads.has(owners[0]) && f.tree !== 'test') {
          if (!colRead.has(key)) colRead.set(key, []);
          colRead.get(key).push({ file: f.path, line });
        }
      }
    }
  }
  for (const [key, where] of colRead) {
    if (colWritten.has(key)) continue;
    const [table, col] = key.split('.');
    if (GENERIC_COLUMN.test(col)) continue;
    // A table in the league chat corpus has no writer here and is not supposed
    // to; its columns arrive by whole-file replacement. Reporting them would be
    // the same false alarm the handle attribution exists to prevent.
    if (tables.get(table)?.database || opaqueWrite.has(table)) continue;
    if (ignored.has(`column:${key}`)) continue;
    const live = where.filter(w => served(reach.get(w.file)));
    if (!live.length) continue;
    add({ kind: 'should-wire', rule: 'column-read-never-written', scope: scopeOfTable(table), subject: key,
      detail: `declared on ${table} and read on a live surface, and no INSERT or UPDATE in the `
        + `repository ever sets it — so it is null on every row and the reader's fallback is what runs`,
      evidence: live.slice(0, 4).map(w => `${w.file}:${w.line}`) });
  }

  // 3. A REQUEST PARAMETER WITH A DEFAULT THAT NO CALLER EVER PASSES.
  //    The default is not a default, it is the only value. `from_week` on the
  //    season simulation defaults to 1, so every playoff number in the app is
  //    simulated from week one and the real standings are discarded.
  const passed = new Set();
  for (const f of files.values()) {
    // A test passing the parameter is not the app passing it. The whole point
    // of the rule is that the shipped code never supplies it, and a route
    // exercised only by its own test is the clearest case of that, not an
    // exemption from it.
    if (f.tree === 'test') continue;
    for (const { text } of f.strings) for (const m of text.matchAll(/[?&]([a-z_][\w]*)=/gi)) passed.add(m[1]);
    for (const m of f.code.matchAll(/\bset\(\s*['"]([a-z_][\w]*)['"]/gi)) passed.add(m[1]);
  }
  for (const f of files.values()) {
    if (!f.path.startsWith('server/routes/')) continue;
    const seen = new Set();
    // Both shapes: `req.query.x ?? 1` and `Number(req.query.x) || 1`. The
    // second is the common one and reading only the first missed `from_week`,
    // which is the case that started this rule.
    const shapes = [
      /req\.query\.([A-Za-z_]\w*)\s*(?:\?\?|\|\|)\s*([^\s;,)}`]+)/g,
      /(?:Number|String|parseInt|parseFloat)\(\s*req\.query\.([A-Za-z_]\w*)\s*(?:,\s*\d+\s*)?\)\s*(?:\?\?|\|\|)\s*([^\s;,)}`]+)/g,
    ];
    for (const m of shapes.flatMap(re => [...f.code.matchAll(re)])) {
      const name = m[1];
      // `?? null` means "absent", and absent is a real answer. `?? 1` means
      // "pretend you were given 1", which is a different number than the one
      // the caller would have got, and nothing anywhere says so.
      if (!/^(\d+(\.\d+)?|'[^']+'|"[^"]+")$/.test(m[2])) continue;
      if (passed.has(name) || seen.has(name) || ignored.has(`param:${name}`)) continue;
      seen.add(name);
      add({ kind: 'should-wire', rule: 'parameter-never-passed', scope: scopeOfFile(f.path), subject: name,
        detail: `read here with a default, and no page, script or extension in the repository ever `
          + `puts it in a query string — so the default is not a fallback, it is the only value this `
          + `endpoint has ever been given`,
        evidence: [`${f.path}:${lineOf(f.code, m.index)}`] });
    }
  }

  // 4. A HARDCODED NUMBER STANDING IN FOR A VALUE THE APP FITS.
  //    `availability?.active_probability ?? 0.92` — `active_probability` is a
  //    column the app fits and stores, and the fallback is a number somebody
  //    typed. It is not a guard against a null, it is a second model with one
  //    parameter, and it prices every row the fit does not cover. Nothing about
  //    the output says which of the two produced a given number.
  const modelled = new Map();     // column -> the tables that declare it
  for (const [t, cols] of columns) {
    if (tables.get(t)?.database) continue;
    for (const c of cols) {
      if (GENERIC_COLUMN.test(c) || c.length < 6) continue;
      if (!modelled.has(c)) modelled.set(c, new Set());
      modelled.get(c).add(t);
    }
  }
  for (const f of files.values()) {
    if (f.tree === 'test' || f.tree === 'script') continue;
    if (!served(reach.get(f.path))) continue;
    const seen = new Set();
    for (const m of f.code.matchAll(/\.([a-z][\w]*)\s*(?:\?\?|\|\|)\s*(\d*\.\d+|[2-9]\d*)\b/g)) {
      const [, field, literal] = m;
      // 0 and 1 are identities, not models: `?? 0` is an empty count and
      // `?? 1` is a multiplier that changes nothing. A number between them, or
      // above them, is a value somebody chose.
      if (!modelled.has(field) || seen.has(field)) continue;
      // `pos_rank ?? 99` is a sentinel meaning "unranked", not a second model.
      // Sorting an absent rank to the back is the correct thing to do with it.
      if (/(_rank|_order|_seed|_slot)$/.test(field) && /^9+$/.test(literal)) continue;
      const owners = [...modelled.get(field)];
      // Only when something actually fills that column. A column nothing
      // writes is the previous rule's finding, not this one's.
      if (!owners.some(t => (tables.get(t)?.writes ?? []).some(w => w.tree !== 'test'))) continue;
      if (ignored.has(`constant:${f.path}#${field}`)) continue;
      seen.add(field);
      add({ kind: 'should-wire', rule: 'constant-standing-in-for-a-model', scope: scopeOfFile(f.path),
        subject: `${field} ?? ${literal}`,
        detail: `${literal} is used wherever ${field} is absent, and ${field} is a column the app fits `
          + `and stores in ${owners.slice(0, 3).join(', ')}. Every row the fit does not cover is priced `
          + `on the typed number instead, and nothing in the output says which one produced it`,
        evidence: [`${f.path}:${lineOf(f.code, m.index)}`] });
    }
  }

  // 5. A PRODUCER NOBODY RUNS.
  //    A function whose name says it fills something, which writes a table a
  //    live surface reads, and which nothing calls. The table is not empty by
  //    accident; there is simply no path that fills it.
  // Tables half the repository writes are bookkeeping, not this function's
  // output. "Fills sync_log" is true of almost every producer and says nothing.
  const BOOKKEEPING = /^(sync_log|job_runs|schema_migrations|.*_log|.*_progress|.*_checkpoints)$/;
  const sharedSink = new Set([...tables.values()]
    .filter(t => BOOKKEEPING.test(t.table)
      || new Set(t.writes.filter(w => w.tree !== 'test').map(w => w.file)).size > 6)
    .map(t => t.table));
  for (const n of fnReach.values()) {
    if (!PRODUCER.test(n.name) || !n.exported) continue;
    const f = files.get(n.file);
    if (!f || f.tree === 'test') continue;
    const writes = [...n.reachWrites].filter(t => !sharedSink.has(t));
    if (!writes.length) continue;
    // Count calls ANYWHERE outside the declaration, not just inside another
    // named function. Most route handlers are anonymous arrows, so a call from
    // one belongs to no unit at all — and reading only the unit graph reported
    // functions as uncalled that a route calls on every request.
    let calls = 0;
    for (const o of files.values()) {
      if (o.tree === 'test') continue;
      // Every local name this file could be calling it by: the export's own
      // name, and any alias it was imported under.
      const localNames = new Set([n.name]);
      for (const imp of o.imports) {
        if (imp.resolved !== n.file) continue;
        for (const a of imp.aliases ?? []) if (a.imported === n.name) localNames.add(a.local);
      }
      for (const local of localNames) {
        const hits = (o.code.match(new RegExp(`\\b${local}\\s*\\(`, 'g')) ?? []).length;
        calls += Math.max(0, o.path === n.file && local === n.name ? hits - 1 : hits);
      }
    }
    if (calls > 0 || ignored.has(`producer:${n.file}#${n.name}`)) continue;
    const servedTables = writes.filter(t => (tables.get(t)?.reads ?? [])
      .some(r => r.tree !== 'test' && served(reach.get(r.file))));
    if (!servedTables.length) continue;
    add({ kind: 'should-wire', rule: 'producer-with-no-caller', scope: scopeOfFile(n.file),
      subject: `${n.name}()`,
      detail: `fills ${servedTables.slice(0, 4).join(', ')}, which a live surface reads, and nothing `
        + `in the repository calls it — no route, no job, no script`,
      evidence: [`${n.file}:${n.line}`,
        ...surfacesOf(reachNames, (tables.get(servedTables[0])?.reads ?? [])
          .find(r => served(reach.get(r.file)))?.file ?? n.file, CLOSE_HOPS).slice(0, 2)] });
  }
}

// ---------------------------------------------------------------------------
// Blast radius: if this table or module changes, what moves? This is the
// question to ask BEFORE wiring something new in, and before running a script
// that fills a table.
// ---------------------------------------------------------------------------

function blastRadius(model, subject) {
  const { files, tables, reachNames, importedBy } = model;
  const seedFiles = new Set();
  if (tables.has(subject)) for (const r of tables.get(subject).reads) seedFiles.add(r.file);
  else if (files.has(subject)) seedFiles.add(subject);
  else {
    const guess = [...files.keys()].filter(f => f.includes(subject));
    if (!guess.length) return null;
    for (const g of guess) seedFiles.add(g);
  }
  // Walk backwards through importers, keeping the hop distance, so a caller can
  // tell a direct consumer from a distant one.
  const reached = new Map();
  let frontier = [...seedFiles];
  let depth = 0;
  while (frontier.length && depth <= MAX_HOPS) {
    const next = [];
    for (const cur of frontier) {
      if (reached.has(cur)) continue;
      reached.set(cur, depth);
      for (const q of importedBy.get(cur) ?? []) if (files.get(q)?.tree !== 'test') next.push(q);
    }
    frontier = next; depth++;
  }
  const wiring = surfaceFamilies(reachNames, [...seedFiles]);
  const surfaces = new Map();
  for (const f of seedFiles) for (const [name, d] of reachNames.get(f) ?? []) {
    if (name.startsWith('test:')) continue;
    if (surfaces.get(name) == null || d < surfaces.get(name)) surfaces.set(name, d);
  }
  return { subject, direct: [...seedFiles].sort(),
    modules: [...reached.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])), wiring,
    surfaces: [...surfaces.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])) };
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------


/**
 * What this map cannot see. Printed with every run, and written into every
 * artifact, because the person who runs it in six months will not have read the
 * pull request that introduced it — and both of these have already produced a
 * wrong answer in this repository, in opposite directions.
 */
const LIMITS = [
  'ROWS, NOT WRITERS. It can tell you whether code writes a table. It cannot tell you '
  + 'whether the rows are any good. league_member_identity has a writer reachable from a '
  + 'route, so this map calls it fed — and it is not, because a row only counts once its '
  + 'confidence is "confirmed", which only a person can set. A clean bill of health here '
  + 'is not evidence a surface has data.',
  'WHOLE-FILE REPLACEMENT IS INVISIBLE. A table filled by replacing an entire database '
  + 'file has no writer this map can find. Rows marked table-in-another-database are '
  + 'exactly that case and are NOT missing feeds. This map reported four of them as broken '
  + 'once; they were fine.',
  'REACHABILITY IS NOT A CALL GRAPH. Hop distance says a route imports something that '
  + 'imports the module. It does not prove the route calls it. Edges behind an '
  + 'off-by-default flag are listed separately (edge-behind-an-off-flag) because they are '
  + 'real as code and false as behaviour.',
  'DYNAMIC NAMES ARE INVISIBLE. A table or module reached only through an interpolated '
  + 'identifier does not appear at all.',
  'ROUTES MATCH BY SHAPE. /a/:id and /a/:other are the same path here.',
  'COLUMNS WRITTEN THROUGH A BUILT COLUMN LIST ARE INVISIBLE. An INSERT whose columns come '
  + 'from a JavaScript array, or an INSERT ... SELECT *, names no column this scan can read, '
  + 'so every column of that table is left alone rather than reported on evidence that does '
  + 'not exist. It found five such tables and said nothing about any of their columns.',
  'A PARAMETER BUILT AT RUNTIME LOOKS UNPASSED. The rule reads query strings out of source '
  + 'text. A caller that assembles one from variables would be missed, and the parameter '
  + 'would be reported as never passed when it is.',
  'AN EDGE CAN CHANGE WITHOUT A DEPLOY. scripts/fit-availability.mjs writes two tables and '
  + 'three live consumers price differently from that moment on, with no code change at all. '
  + 'The script, the tables and the consumers are all on this graph, but nothing here says that '
  + 'running it alters a process already serving requests. Same family as ROWS, NOT WRITERS: the '
  + 'shape of the wiring is not the state of it.',
  'THIS IS A SOURCE TREE, NOT THE RUNNING APP. Every count and every edge here describes the '
  + 'checkout it was run in, named at the top of the file. On 2026-09-19 the deployed binary '
  + 'was ahead of main on contingency.js, serving three fields main does not have. Never read '
  + 'this map as a statement about what production is doing.',
];

const SEVERITY = {
  'table-never-written': 1, 'client-call-without-route': 1, 'table-hand-fed': 2,
  'cache-blind-to-its-inputs': 2.5, 'table-in-another-database': 2.8, 'table-never-scheduled': 3,
  'edge-behind-an-off-flag': 3.5,
  'column-read-never-written': 1.2, 'producer-with-no-caller': 1.4,
  'two-names-different-sources': 1.6, 'constant-standing-in-for-a-model': 1.7, 'parameter-never-passed': 1.8,
  'module-only-tested': 4, 'module-imported-by-nothing': 5,
  'module-reaches-no-surface': 5, 'field-attached-never-read': 6, 'value-computed-never-used': 7,
  'table-never-read': 8, 'export-only-tested': 9, 'export-imported-by-nothing': 10, 'route-no-caller': 11,
};


/** The missing-feed family as a table, generated — never transcribed. */
function missingFeedTable(model, found) {
  const { tables, reachNames } = model;
  const rows = found.filter(f => f.kind === 'missing-feed' && tables.has(f.subject));
  const L = ['# Missing feeds', '',
    'Generated by `node scripts/wiring-map.mjs`. Do not edit — re-run it.',
    '', 'A surface depends on something nothing produces. The page still renders:',
    'it renders a constant, a default or an empty list, and it looks fine.', ''];
  if (!rows.length) { L.push('None.'); return L.join('\n'); }
  L.push('| table | scope | written by | read by | reached from |', '| --- | --- | --- | --- | --- |');
  for (const f of rows.slice().sort((a, b) => a.subject.localeCompare(b.subject))) {
    const t = tables.get(f.subject);
    const w = t ? [...new Set(t.writes.filter(x => x.tree !== 'test').map(x => `${x.file}:${x.line}`))] : [];
    const rd = t ? [...new Set(t.reads.filter(x => x.tree !== 'test').map(x => x.file))] : [];
    const fam = close(surfaceFamilies(reachNames, rd)).route_families.slice(0, 5).map(x => x.name);
    L.push(`| \`${f.subject}\` | ${f.scope} | ${w.length ? w.map(x => `\`${x}\``).join('<br>') : '**nothing**'} `
      + `| ${rd.length ? rd.map(x => `\`${path.basename(x)}\``).slice(0, 4).join('<br>') : '**nothing**'} `
      + `| ${fam.join(' ') || '—'} |`);
  }
  L.push('', '## What this table cannot tell you', '');
  for (const l of LIMITS) L.push(`- ${l}`);
  return L.join('\n');
}

function toJson(model, found, ann) {
  const { files, tables, surfaces, jobs, mounts, reachNames } = model;
  return {
    generated_by: 'scripts/wiring-map.mjs',
    cannot_see: LIMITS,
    generated_at: new Date().toISOString(),
    derived: true,
    branch: process.env.WIRING_MAP_BRANCH ?? null,
    counts: {
      files: files.size, tables: tables.size, surfaces: surfaces.length,
      routes: surfaces.filter(s => s.kind === 'route').length, jobs: jobs.length,
      findings: found.length,
    },
    surfaces: surfaces.map(s => ({ kind: s.kind, name: s.name, file: s.file, tier: s.tier ?? null, line: s.line })),
    mounts,
    tables: [...tables.values()].map(t => ({
      table: t.table, scope: t.scope,
      created_in: [...new Set(t.creates.map(c => `${c.file}:${c.line}`))],
      written_by: [...new Set(t.writes.filter(w => w.tree !== 'test').map(w => `${w.file}:${w.line}`))],
      read_by: [...new Set(t.reads.filter(r => r.tree !== 'test').map(r => `${r.file}:${r.line}`))],
      wiring: close(surfaceFamilies(reachNames, [...new Set(t.reads.filter(r => r.tree !== 'test').map(r => r.file))])),
    })),
    // Module rows carry the import edges and the surface FAMILIES, not the 534
    // individual routes each module is close to — that produced an eight-megabyte
    // file whose extra bytes were the same twenty prefixes repeated. Ask for the
    // individual routes with --blast, which computes them on demand.
    modules: [...files.values()].filter(f => f.tree !== 'test').map(f => ({
      path: f.path, tree: f.tree, scope: f.scope,
      imports: f.imports.filter(i => i.resolved).map(i => i.resolved),
      exports: f.exports.map(e => e.name),
      wiring: close(surfaceFamilies(reachNames, [f.path], CLOSE_HOPS)),
    })),
    findings: found,
    asserted: ann,
  };
}

function toMarkdown(model, found, ann) {
  const { files, tables, surfaces, jobs, reachNames } = model;
  const L = [];
  const p = (s = '') => L.push(s);
  p('# The wiring map');
  p();
  p('Generated by `node scripts/wiring-map.mjs`. Do not edit by hand — re-run it.');
  p(`Walked ${files.size} files, ${tables.size} tables, ${surfaces.length} surfaces `
    + `(${surfaces.filter(s => s.kind === 'route').length} routes, ${jobs.length} scheduler jobs).`);
  p();
  p('Everything below is derived from the source. Edges a walker cannot see are');
  p('in `annotations.json` and marked **ASSERTED** where they appear.');
  p();
  p('## What this map cannot see');
  p();
  p('First, because both of these have already produced a wrong answer here.');
  p();
  for (const l of LIMITS) p(`- **${l.split('.')[0]}.**${l.slice(l.indexOf('.') + 1)}`);
  p();
  p('## How to read it');
  p();
  p('- **MISSING FEED** — a surface depends on something nothing produces. This is the one that hurts users: the page still renders, using a default or a constant, and looks fine.');
  p('- **ORPHAN** — something produced that reaches no surface. Wasted work, not a user-facing bug.');
  p();
  p('Betting rows are mapped and tagged `betting`. They are out of scope for work, in scope for knowing.');
  p();

  p('## Findings');
  p();
  const mf = found.filter(f => f.kind === 'missing-feed');
  const orph = found.filter(f => f.kind === 'orphan');
  p(`**${mf.length} missing feed** — a surface depends on something nothing produces.`);
  p(`**${orph.length} orphan** — something produced that reaches no surface.`);
  p(`${found.length - mf.length - orph.length} context rows, listed because they are worth knowing and are usually fine.`);
  p();
  if (mf.length) {
    p('The missing-feed list in full, because it is short and it is the one that matters:');
    p();
    for (const f of mf) {
      p(`- **${f.subject}** \`[${f.scope}]\` — ${f.detail}`);
      if (f.evidence?.length) p(`  - ${f.evidence.slice(0, 4).join(', ')}`);
      if (f.wiring) {
        const c = close(f.wiring);
        if (c.route_families.length) p(`  - reached from ${c.route_families.map(x => x.name).join(' ')}`);
      }
    }
    p();
  }
  const sw = found.filter(f => f.kind === 'should-wire');
  if (sw.length) {
    p(`**${sw.length} should be wired** — nothing is broken enough to fail a test, and the code `
      + 'is answering from the wrong place, with a default, or from a column that is null on '
      + 'every row. This family is the one to read when the question is "what did we forget to '
      + 'connect", rather than "what is connected".');
    p();
    for (const f of sw.filter(f => f.scope !== 'betting')) {
      p(`- **${f.subject}** \`[${f.rule}]\` — ${f.detail}`);
      if (f.evidence?.length) p(`  - ${f.evidence.slice(0, 4).join(', ')}`);
    }
    const bet = sw.filter(f => f.scope === 'betting');
    if (bet.length) p(`- ...and ${bet.length} more in betting code, tagged and out of scope for work.`);
    p();
  }
  const byRule = new Map();
  for (const f of found) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  const rules = [...byRule.keys()].sort((a, b) => (SEVERITY[a] ?? 99) - (SEVERITY[b] ?? 99));
  p('| rule | family | fantasy | betting | shared |');
  p('| --- | --- | --: | --: | --: |');
  for (const r of rules) {
    const g = byRule.get(r);
    p(`| \`${r}\` | ${g[0].kind} | ${g.filter(x => x.scope === 'fantasy').length} `
      + `| ${g.filter(x => x.scope === 'betting').length} | ${g.filter(x => x.scope === 'shared').length} |`);
  }
  p();
  const BULK = new Set(['export-imported-by-nothing', 'export-only-tested', 'route-no-caller', 'table-never-scheduled']);
  for (const r of rules) {
    const g = byRule.get(r).slice().sort((a, b) => a.subject.localeCompare(b.subject));
    p(`### \`${r}\` — ${g[0].kind.toUpperCase().replace('-', ' ')} (${g.length})`);
    p();
    if (BULK.has(r)) {
      // Too many to read one by one, and each is individually a judgement call.
      // Grouped by where they live, so the concentrations are visible; the full
      // list is in wiring-map.json.
      const byFile = new Map();
      for (const f of g) {
        const key = (f.evidence?.[0] ?? f.subject).split(':')[0].split('#')[0];
        byFile.set(key, (byFile.get(key) ?? 0) + 1);
      }
      const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      p(`Grouped by file, heaviest first. Full list in \`wiring-map.json\`.`);
      p();
      p('| file | count |');
      p('| --- | --: |');
      for (const [file, count] of top) p(`| \`${file}\` | ${count} |`);
      if (byFile.size > 20) p(`| _… ${byFile.size - 20} more files_ | ${g.length - top.reduce((a, b) => a + b[1], 0)} |`);
      p();
      continue;
    }
    for (const f of g.slice(0, 60)) {
      p(`- **${f.subject}** \`[${f.scope}]\` — ${f.detail}`);
      if (f.evidence?.length) p(`  - ${f.evidence.slice(0, 5).join(', ')}`);
      if (f.wiring) {
        const c = close(f.wiring), w = [];
        const names = a => a.map(x => `${x.name}@${x.hops}`).join(' ');
        if (c.route_families.length) w.push(`routes ${names(c.route_families.slice(0, 8))}`);
        if (c.jobs.length) w.push(`jobs ${names(c.jobs.slice(0, 5))}`);
        if (c.scripts.length) w.push(`scripts ${names(c.scripts.slice(0, 3))}`);
        if (w.length) p(`  - wired into (≤${CLOSE_HOPS} hops): ${w.join('; ')}`);
      }
      if (f.consumers?.length) p(`  - read in: ${f.consumers.slice(0, 6).join(', ')}`);
      if (f.asserted) p(`  - **ASSERTED**: ${f.asserted}`);
    }
    if (g.length > 60) p(`- _… ${g.length - 60} more in wiring-map.json_`);
    p();
  }

  p('## Asserted edges');
  p();
  p('The few things a walker cannot see, written down by hand in `annotations.json`.');
  p('Everything else in this file is derived.');
  p();
  for (const [table, why] of Object.entries(ann.asserted_producers ?? {})) {
    p(`- **${table}** — ASSERTED producer: ${why}`);
  }
  p();
  for (const [subject, note] of Object.entries(ann.notes ?? {})) {
    if (subject === 'scope') continue;
    p(`- **${subject}** — ASSERTED note: ${note}`);
  }
  p();

  p('## Tables: who fills them, who reads them, what moves');
  p();
  p('`reaches` is the blast radius: change the table and every surface listed moves,');
  p('with no code change and no pull request behind it.');
  p();
  p('| table | scope | written by | read by | reaches |');
  p('| --- | --- | --- | --- | --- |');
  for (const t of [...tables.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    const w = [...new Set(t.writes.filter(x => x.tree !== 'test').map(x => x.file))];
    const rd = [...new Set(t.reads.filter(x => x.tree !== 'test').map(x => x.file))];
    const w2 = surfaceFamilies(reachNames, rd);
    p(`| \`${t.table}\` | ${t.scope} | ${w.length ? w.map(x => `\`${path.basename(x)}\``).slice(0, 4).join(', ') : '**nothing**'} `
      + `| ${rd.length ? rd.map(x => `\`${path.basename(x)}\``).slice(0, 4).join(', ') : '**nothing**'} `
      + `| ${close(w2).route_families.slice(0, 4).map(x => x.name).join(' ') || '—'}`
      + `${close(w2).jobs.length ? ` +${close(w2).jobs.length} job(s)` : ''} |`);
  }
  p();

  p('## Scheduler jobs');
  p();
  p('| job | tier | module |');
  p('| --- | --- | --- |');
  for (const j of surfaces.filter(s => s.kind === 'job')) p(`| \`${j.name}\` | ${j.tier} | \`${j.file}\` |`);
  p();
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Exported so the test suite can exercise the scanner and the rules without
// running the CLI, and so another script can ask the map a question.
// ---------------------------------------------------------------------------

export { scan, sqlEdges, moduleEdges, routeHandlers, routeMounts, schedulerJobs,
  clientCalls, payloadKeys, keyReads, declarations, build, findings, blastRadius,
  toJson, toMarkdown, missingFeedTable, annotations, surfaceFamilies, close, CLOSE_HOPS, MAX_HOPS,
  foreignHandles, handleFor, gatedRegions, blindCaches, bodyRange, LIMITS,
  functionUnits, functionReach, tableColumns, statementTables, shouldBeWired };

// ---------------------------------------------------------------------------
// CLI. Skipped on import, so the module above is testable.
// ---------------------------------------------------------------------------

const INVOKED_DIRECTLY = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (INVOKED_DIRECTLY) {

  const args = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = args[i + 1];
    return next && !next.startsWith('--') ? next : true;
  };

  const outDir = path.resolve(ROOT, String(flag('out', 'docs/wiring')));
  const ann = annotations(path.join(outDir, 'annotations.json'));
  const model = build();
  const found = findings(model, ann).sort((a, b) =>
    (SEVERITY[a.rule] ?? 99) - (SEVERITY[b.rule] ?? 99) || a.subject.localeCompare(b.subject));

  const blast = flag('blast');
  if (typeof blast === 'string') {
    const r = blastRadius(model, blast);
    if (!r) { console.error(`nothing in the map matches "${blast}"`); process.exit(2); }
    console.log(`# blast radius: ${r.subject}\n`);
    console.log(`read/defined directly in ${r.direct.length} file(s):`);
    for (const f of r.direct) console.log(`  ${f}`);
    const hops = Number(flag('hops', CLOSE_HOPS));
    const shown = r.surfaces.filter(([, d]) => d <= hops);
    const nearModules = r.modules.filter(([m, d]) => d > 0 && d <= hops);
    console.log(`\nconsumed by ${nearModules.length} module(s) within ${hops} hop(s) (${r.modules.length - r.direct.length} in total):`);
    for (const [m, d] of nearModules) console.log(`  ${d} hop${d === 1 ? '' : 's'}  ${m}`);
    console.log(`\n${shown.length} surface(s) within ${hops} import hop(s)`);
    console.log(`(${r.surfaces.length} in total — raise with --hops N)\n`);
    for (const [name, d] of shown) console.log(`  ${d} hop${d === 1 ? '' : 's'}  ${name}`);
    console.log('\nroute families:');
    for (const x of r.wiring.route_families) console.log(`  ${x.hops} hop(s)  ${x.name}`);
    process.exit(0);
  }

  if (flag('findings')) {
    for (const f of found) {
      console.log(`${f.kind.toUpperCase()} ${f.rule} [${f.scope}] ${f.subject}`);
      console.log(`    ${f.detail}`);
      if (f.evidence?.length) console.log(`    ${f.evidence.slice(0, 4).join(', ')}`);
      if (f.wiring) {
        const c = close(f.wiring);
        const w = [c.route_families.map(x => x.name).join(' '), c.jobs.map(x => x.name).join(' ')]
          .filter(Boolean).join(' | ');
        if (w) console.log(`    wired into: ${w}`);
      }
    }
    console.log('\nWHAT THIS MAP CANNOT SEE — read before acting on anything above:');
    for (const l of LIMITS) console.log(`  * ${l.replace(/(.{96}) /g, '$1\n    ')}`);
    console.log(`\n${found.length} findings `
      + `(${found.filter(f => f.kind === 'missing-feed').length} missing feed, `
      + `${found.filter(f => f.kind === 'orphan').length} orphan)`);
    if (!flag('check')) process.exit(0);
  }

  if (!flag('findings')) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'wiring-map.json'), JSON.stringify(toJson(model, found, ann)));
    fs.writeFileSync(path.join(outDir, 'WIRING-MAP.md'), toMarkdown(model, found, ann) + '\n');
  // The missing-feed table on its own, generated. It used to be typed by hand
  // into the findings write-up and two of its rows were wrong within the hour
  // — a writer attributed to the wrong script, and a row that had stopped
  // firing. Transcribing a generator's output by hand is the thing this
  // generator exists to stop.
  fs.writeFileSync(path.join(outDir, 'MISSING-FEEDS.md'), missingFeedTable(model, found) + '\n');
    console.log(`wrote ${path.relative(ROOT, outDir)}/wiring-map.json and WIRING-MAP.md`);
    console.log(`${model.files.size} files, ${model.tables.size} tables, ${model.surfaces.length} surfaces, ${found.length} findings`);
  }

  if (flag('check')) {
    // CI gate: fail on the family that hurts users. Orphans are reported and do
    // not break the build, because removing them is a judgement call.
    // Two of the should-wire rules are structural rather than a judgement — a
    // column nothing writes and a producer nothing calls are facts, not
    // opinions — so they gate too. The other two describe a shape that is
    // often deliberate, and a gate that fails on opinions gets switched off.
    const GATING = new Set(['column-read-never-written', 'producer-with-no-caller']);
    // A WHOLE NEW MODULE that reaches no surface gates as well, which is the
    // only orphan rule that does. The rest of the orphan family is judgement:
    // deleting a dead export is a call somebody has to make, and 992 of them
    // cannot each be a build failure. A new FILE is different. Something was
    // designed, written, tested, documented and connected to nothing, and the
    // suite went green because every test it has imports it directly. That is
    // the exact failure this project keeps hitting, and prose has not stopped
    // it: three defects were written down tonight and acted on by nobody.
    //
    // The escape hatch is deliberate rather than silent. Landing a module
    // unwired on purpose — the first half of a two-PR sequence, a research
    // module — means adding `module:<path>` to expected_orphans with a reason.
    // That is one line in a review, which is the point: somebody says out loud
    // that it is not wired yet, instead of nothing happening.
    const NEW_ORPHAN = new Set(['module-reaches-no-surface', 'module-only-tested']);
    const accepted = ann.accepted_missing_feeds ?? [];
    const orphanOk = new Set((ann.accepted_orphan_modules ?? []).concat(ann.expected_orphans ?? []));
    const blocking = found.filter(f =>
      (f.kind === 'missing-feed' || (f.kind === 'should-wire' && GATING.has(f.rule))
        || (NEW_ORPHAN.has(f.rule) && !orphanOk.has(f.subject) && !orphanOk.has(`module:${f.subject}`)))
      && !accepted.includes(f.subject) && !accepted.includes(`${f.rule} ${f.subject}`));
    if (blocking.length) {
      console.error(`\n${blocking.length} blocking finding(s) — something a surface needs that nothing `
        + 'produces, or something built and wired to nothing:');
      for (const f of blocking) console.error(`  ${f.rule} ${f.subject} — ${f.detail}`);
    console.error('\nBefore treating any of these as broken, read what this map cannot see:');
    for (const l of LIMITS) console.error(`  * ${l.split('.')[0]}.`);
      process.exit(1);
    }
    console.log('no missing-feed findings');
  }
}
