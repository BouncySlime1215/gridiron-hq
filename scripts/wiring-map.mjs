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
      strings.push({ text: src.slice(start + 1, i - 1), line: lineAt(start) });
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
      strings.push({ text: src.slice(start + 1, i - 1), line: lineAt(start) });
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
  return /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|REPLACE\s+INTO)\b/i.test(t);
}

function sqlEdges(strings) {
  const creates = [], writes = [], reads = [];
  for (const { text, line } of strings) {
    if (!looksSql(text)) continue;
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
  }
  return { creates, writes, reads };
}

// ---------------------------------------------------------------------------
// Modules: imports, exports, and the identifiers a file declares.
// ---------------------------------------------------------------------------

function moduleEdges(code) {
  const imports = [];       // { spec, names[], dynamic }
  const exports = [];       // { name, line }
  let m;

  const add = (spec, namesRaw, dynamic, idx) => {
    const names = (namesRaw ?? '')
      .replace(/[{}]/g, ' ')
      .split(',')
      .map(s => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(s => s && s !== '*' && /^[A-Za-z_$][\w$]*$/.test(s));
    imports.push({ spec, names, dynamic, line: lineOf(code, idx) });
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
      files.set(rel, {
        path: rel, tree: kind, raw, code, text, strings, imports, exports,
        sql: sqlEdges(strings),
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
    if (!s.file || s.kind === 'boot' || s.unresolved) continue;
    const seen = new Map();
    let frontier = [s.file];
    let depth = 0;
    while (frontier.length && depth <= MAX_HOPS) {
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
        tableEntry(e.table)[kind].push({ file: f.path, line: e.line, tree: f.tree });
      }
    }
  }
  return { files, importsOf, importedBy, surfaces, mounts, mountByFile, jobs, tables, reach, reachNames };
}

// ---------------------------------------------------------------------------
// Findings. Two families, named separately on purpose.
//   MISSING FEED — a surface depends on something nothing produces.
//   ORPHAN       — something produced that reaches no surface.
// ---------------------------------------------------------------------------

const SERVED = new Set(['route', 'job', 'client', 'extension']);
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
  const out = [];
  const add = (f) => out.push(f);
  const ignored = new Set(ann.expected_orphans ?? []);
  const assertedProducers = ann.asserted_producers ?? {};

  // ---- tables ----------------------------------------------------------
  for (const t of tables.values()) {
    const readers = t.reads.filter(r => r.tree !== 'test');
    const writers = t.writes.filter(w => w.tree !== 'test');
    const readerFiles = [...new Set(readers.map(r => r.file))];
    const writerFiles = [...new Set(writers.map(w => w.file))];
    const readerKinds = new Set(readerFiles.flatMap(f => [...(reach.get(f) ?? [])]));
    const writerKinds = new Set(writerFiles.flatMap(f => [...(reach.get(f) ?? [])]));
    const asserted = assertedProducers[t.table] ?? null;

    if (readerFiles.length && !writerFiles.length && !ignored.has(`table:${t.table}`)) {
      add({ kind: 'missing-feed', rule: 'table-never-written', scope: t.scope, subject: t.table,
        detail: `read in ${readerFiles.length} file(s), written by nothing in the repository`,
        evidence: readers.slice(0, 6).map(r => `${r.file}:${r.line}`),
        consumers: readerFiles, wiring: surfaceFamilies(reachNames, readerFiles),
        asserted });
    } else if (readerFiles.length && writerFiles.length && served(readerKinds)
               && !writerKinds.has('job') && !writerKinds.has('route') && !ignored.has(`table:${t.table}`)) {
      add({ kind: 'missing-feed', rule: 'table-hand-fed', scope: t.scope, subject: t.table,
        detail: `read on a served surface, but every writer is a script someone has to remember to run`,
        evidence: writers.slice(0, 4).map(w => `writer ${w.file}:${w.line}`)
          .concat(readers.slice(0, 4).map(r => `reader ${r.file}:${r.line}`)),
        consumers: readerFiles, wiring: surfaceFamilies(reachNames, readerFiles),
        asserted });
    } else if (readerFiles.length && writerFiles.length && served(readerKinds)
               && !writerKinds.has('job') && writerKinds.has('route') && !ignored.has(`table:${t.table}`)) {
      add({ kind: 'missing-feed', rule: 'table-never-scheduled', scope: t.scope, subject: t.table,
        detail: `read on a served surface; nothing on a timer fills it — only a route someone has to call`,
        evidence: writers.slice(0, 4).map(w => `writer ${w.file}:${w.line}`),
        consumers: readerFiles, wiring: surfaceFamilies(reachNames, readerFiles),
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
        evidence: [`${f.path}:${line}`], wiring: surfaceFamilies(reachNames, [f.path], CLOSE_HOPS) });
    }
    for (const [name, line] of declarations(f.code)) {
      if (globalCounts.get(name) !== 1 || ignored.has(`local:${name}`)) continue;
      add({ kind: 'orphan', rule: 'value-computed-never-used', scope: f.scope,
        subject: `${name} (${f.path})`,
        detail: 'assigned once and never referenced again anywhere in the repository',
        evidence: [`${f.path}:${line}`] });
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
    if (routePaths.some(r => matches(r.name.split(' ')[1], c.path))) continue;
    add({ kind: 'missing-feed', rule: 'client-call-without-route', scope: scopeOfFile(c.file),
      subject: c.path, detail: 'the client calls this path and no route in the repository answers it',
      evidence: [`${c.file}:${c.line}`] });
  }
  for (const r of routePaths) {
    const p = r.name.split(' ')[1];
    if (allCalls.some(c => matches(p, c.path))) continue;
    if (ignored.has(`route:${r.name}`)) continue;
    add({ kind: 'orphan', rule: 'route-no-caller', scope: scopeOfFile(r.file), subject: r.name,
      detail: 'no page or extension calls it', evidence: [`${r.file}:${r.line}`] });
  }

  return out;
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

const SEVERITY = {
  'table-never-written': 1, 'client-call-without-route': 1, 'table-hand-fed': 2,
  'table-never-scheduled': 3, 'module-only-tested': 4, 'module-imported-by-nothing': 5,
  'module-reaches-no-surface': 5, 'field-attached-never-read': 6, 'value-computed-never-used': 7,
  'table-never-read': 8, 'export-only-tested': 9, 'export-imported-by-nothing': 10, 'route-no-caller': 11,
};

function toJson(model, found, ann) {
  const { files, tables, surfaces, jobs, mounts, reachNames } = model;
  return {
    generated_by: 'scripts/wiring-map.mjs',
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
      wiring: surfaceFamilies(reachNames, [...new Set(t.reads.filter(r => r.tree !== 'test').map(r => r.file))]),
    })),
    modules: [...files.values()].filter(f => f.tree !== 'test').map(f => ({
      path: f.path, tree: f.tree, scope: f.scope,
      imports: f.imports.filter(i => i.resolved).map(i => i.resolved),
      exports: f.exports.map(e => e.name),
      reaches: surfacesOf(reachNames, f.path, CLOSE_HOPS),
    })),
    findings: found,
    asserted: ann,
  };
}

function toMarkdown(model, found) {
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
  p('## How to read it');
  p();
  p('- **MISSING FEED** — a surface depends on something nothing produces. This is the one that hurts users: the page still renders, using a default or a constant, and looks fine.');
  p('- **ORPHAN** — something produced that reaches no surface. Wasted work, not a user-facing bug.');
  p();
  p('Betting rows are mapped and tagged `betting`. They are out of scope for work, in scope for knowing.');
  p();

  p('## Findings');
  p();
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
  for (const r of rules) {
    const g = byRule.get(r).slice().sort((a, b) => a.subject.localeCompare(b.subject));
    p(`### \`${r}\` — ${g[0].kind.toUpperCase().replace('-', ' ')} (${g.length})`);
    p();
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
// CLI.
// ---------------------------------------------------------------------------

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
  console.log(`\n${found.length} findings `
    + `(${found.filter(f => f.kind === 'missing-feed').length} missing feed, `
    + `${found.filter(f => f.kind === 'orphan').length} orphan)`);
  if (!flag('check')) process.exit(0);
}

if (!flag('findings')) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'wiring-map.json'), JSON.stringify(toJson(model, found, ann), null, 2));
  fs.writeFileSync(path.join(outDir, 'WIRING-MAP.md'), toMarkdown(model, found) + '\n');
  console.log(`wrote ${path.relative(ROOT, outDir)}/wiring-map.json and WIRING-MAP.md`);
  console.log(`${model.files.size} files, ${model.tables.size} tables, ${model.surfaces.length} surfaces, ${found.length} findings`);
}

if (flag('check')) {
  // CI gate: fail on the family that hurts users. Orphans are reported and do
  // not break the build, because removing them is a judgement call.
  const blocking = found.filter(f => f.kind === 'missing-feed' && !(ann.accepted_missing_feeds ?? []).includes(f.subject));
  if (blocking.length) {
    console.error(`\n${blocking.length} MISSING FEED finding(s) — a surface depends on something nothing produces:`);
    for (const f of blocking) console.error(`  ${f.rule} ${f.subject} — ${f.detail}`);
    process.exit(1);
  }
  console.log('no missing-feed findings');
}
