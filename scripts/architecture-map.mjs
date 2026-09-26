#!/usr/bin/env node
/**
 * ARCHITECTURE (plan item 40): writes docs/ARCHITECTURE.md, the one page that says which module
 * produces each served number, where each plans.json section and source id comes from, and which
 * GRIDIRON_* flags exist.
 *
 * Generated so it cannot drift. Three inputs, each checked:
 *   - the plans contract (plans-schema.js SECTIONS / OPTIONAL_SECTIONS / SOURCE_IDS), read live;
 *   - docs/architecture/registry.json, the hand-kept half: one producer per section, per source id
 *     and per core number. Every entry must name a file that exists and a symbol defined in it, and
 *     the registry must cover the schema's lists exactly (no missing, no stale);
 *   - a scan of server/ and scripts/ for GRIDIRON_* names (names only; values are never read).
 * The page carries no timestamp or sha, so the same tree always writes the same bytes.
 *
 *   node scripts/architecture-map.mjs           # write docs/ARCHITECTURE.md
 *   node scripts/architecture-map.mjs --check   # exit 1 if the registry is invalid or the page is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SECTIONS, OPTIONAL_SECTIONS, SOURCE_IDS } from '../server/services/campaign/plans-schema.js';
import { PREVIEW_ENV } from '../server/services/preview-mode.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_PATH = path.join(ROOT, 'docs', 'architecture', 'registry.json');
export const OUT_PATH = path.join(ROOT, 'docs', 'ARCHITECTURE.md');

const SCAN_DIRS = ['server', 'scripts'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs']);
const FLAG_RE = /\bGRIDIRON_[A-Z0-9_]*[A-Z0-9]\b/g;
const MAX_READERS = 3;

export function readRegistry(file = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip // and block comments so a commented-out definition does not count. Good enough for our own sources. */
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** null when `file#symbol` resolves under `root`, else the reason it does not. */
export function resolveRef(ref, root = ROOT) {
  const m = /^([^#\s]+)#([A-Za-z_$][\w$]*)$/.exec(String(ref ?? ''));
  if (!m) return `"${ref}" is not a file#symbol reference`;
  const [, rel, sym] = m;
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return `${rel} does not exist (from ${ref})`;
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const s = escapeRe(sym);
  const defined = new RegExp(`(?:^|[\\s;])(?:export\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${s}\\b`, 'm').test(src)
    || new RegExp(`export\\s*\\{[^}]*\\b${s}\\b[^}]*\\}`).test(src);
  return defined ? null : `${sym} is not defined in ${rel}`;
}

/** Every problem with the registry, as plain strings. Empty means valid. */
export function validateRegistry(reg, { root = ROOT, sections = Object.keys(SECTIONS), sources = [...SOURCE_IDS] } = {}) {
  const errs = [];
  const refs = (where, e, key) => [e?.[key], ...(e?.also ?? [])].forEach(r => {
    const why = resolveRef(r, root);
    if (why) errs.push(`${where}: ${why}`);
  });
  for (const p of reg.producers ?? []) {
    refs(`producer ${p.ref}`, p, 'ref');
    if (!String(p.owns ?? '').trim()) errs.push(`producer ${p.ref}: says nothing about what it owns`);
  }
  const cover = (kind, have, want, key) => {
    for (const k of want) if (!have[k]) errs.push(`${kind} ${k} has no producer in docs/architecture/registry.json`);
    for (const k of Object.keys(have)) {
      if (!want.includes(k)) { errs.push(`${kind} ${k} is in the registry but not in plans-schema.js`); continue; }
      refs(`${kind} ${k}`, have[k], key);
      if (!String(have[k].what ?? '').trim()) errs.push(`${kind} ${k}: says nothing about what it is`);
    }
  };
  cover('section', reg.sections ?? {}, sections, 'computed_by');
  cover('source', reg.sources ?? {}, sources, 'producer');
  return errs;
}

/** 'secret' | 'setting' | 'switch', by name. Only names are ever listed; this decides the table. */
export function flagKind(name) {
  if (/(TOKEN|SECRET|API_KEY|PASSWORD)$/.test(name)) return 'secret';
  if (/(PATH|_DIR|_FILE|HOST|_URL|_PORT|EMAIL|PYTHON|_TZ|SECONDS|HOURS|INTERVAL_HOURS|_USD_DAY|LEAGUES?|_BEAM|_CANDIDATES|_RESCORES|_ROLE|_SOURCE|_CLIENT_ID|_SCHEMA|_TURNS|_LOCK)$/.test(name)) return 'setting';
  return 'switch';
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'test' && d.name !== '__tests__') yield* walk(p); continue; }
    if (SCAN_EXT.has(path.extname(d.name)) && !/\.test\.[cm]?js$/.test(d.name)) yield p;
  }
}

/** [{ name, kind, files (repo-relative, sorted), preview }] sorted by name. preview: a file naming it also reads preview mode. */
export function scanFlags(root = ROOT) {
  const by = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      const names = new Set(src.match(FLAG_RE) ?? []);
      if (!names.size) continue;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const preview = /previewUnconfirmed|preview-mode\.js/.test(src);
      for (const n of names) {
        const e = by.get(n) ?? { name: n, kind: flagKind(n), files: [], preview: false };
        e.files.push(rel);
        e.preview ||= preview;
        by.set(n, e);
      }
    }
  }
  return [...by.values()].map(e => ({ ...e, files: e.files.sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Typed numbers (num / prob fields) inside one schema node. */
function typedNumbers(node) {
  if (!node || typeof node !== 'object') return 0;
  let n = node.t === 'field' && ['num', 'prob'].includes(node.inner?.t) ? 1 : 0;
  for (const k of ['inner', 'item', 'value']) if (node[k] && typeof node[k] === 'object' && node[k].t) n += typedNumbers(node[k]);
  if (node.t === 'obj') for (const sub of [...Object.values(node.req), ...Object.values(node.opt)]) n += typedNumbers(sub);
  return n;
}

const code = s => `\`${s}\``;
const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const refCell = (e, key) => [e[key], ...(e.also ?? [])].map(code).join(', ');
const readers = files => files.slice(0, MAX_READERS).map(code).join(', ') + (files.length > MAX_READERS ? ` +${files.length - MAX_READERS} more` : '');

export function renderArchitecture({ registry = readRegistry(), root = ROOT } = {}) {
  const flags = scanFlags(root);
  const L = [];
  L.push('# ARCHITECTURE', '');
  L.push('<!-- Generated by scripts/architecture-map.mjs from plans-schema.js, docs/architecture/registry.json and a scan of server/ and scripts/. Do not edit by hand: edit the registry or the code, then run `npm run map:architecture`. test/architecture-map.test.js fails CI when this page is stale. -->', '');
  L.push('How a number reaches Nick: the refresh loop runs the producer offline, the producer writes one plans file,',
    'and the server only reads that file. One number has one producer; a screen shows the served value, never a',
    'local recomputation. Routes and tables (what feeds what) are mapped separately in `docs/wiring/WIRING-MAP.md`.', '');
  L.push('```', 'refresh loop -> scripts/campaign/produce-plans.mjs -> planner.js (search, confirm dice, Nick\'s rules)',
    '             -> view.js (typed fields) -> plans.json -> war-room-view.js -> War Room / Today / Coach', '```', '');
  L.push('Every served number is a typed field: `{ status: ok | unknown | failed, value, source, se, ... }`. A missing',
    'number is `unknown` with a reason, never 0. `source` names the producer below.', '');

  L.push('## Producers (one producer per number)', '');
  L.push('| producer | owns |', '|---|---|');
  for (const p of registry.producers) L.push(`| ${code(p.ref)} | ${cell(p.owns)} |`);
  L.push('');

  L.push('## plans.json sections', '');
  L.push(`Every section of a league entry in the War Room file (${Object.keys(SECTIONS).length}), in schema order. "typed numbers" counts the number and probability fields inside it.`, '');
  L.push('| section | optional | typed numbers | computed by | what |', '|---|---|---|---|---|');
  for (const [k, node] of Object.entries(SECTIONS)) {
    const e = registry.sections[k];
    L.push(`| ${code(k)} | ${OPTIONAL_SECTIONS.includes(k) ? 'yes' : 'no'} | ${typedNumbers(node)} | ${refCell(e, 'computed_by')} | ${cell(e.what)} |`);
  }
  L.push('');

  L.push('## Where each served number comes from (source ids)', '');
  L.push(`The \`source\` on every typed field is one of these ${SOURCE_IDS.length} ids.`, '');
  L.push('| source | producer | what |', '|---|---|---|');
  for (const k of SOURCE_IDS) {
    const e = registry.sources[k];
    L.push(`| ${code(k)} | ${refCell(e, 'producer')} | ${cell(e.what)} |`);
  }
  L.push('');

  const table = (kind, title, blurb) => {
    const rows = flags.filter(f => f.kind === kind);
    L.push(`## ${title} (${rows.length})`, '', blurb, '');
    L.push('| flag | named in | preview-aware file |', '|---|---|---|');
    for (const f of rows) L.push(`| ${code(f.name)} | ${readers(f.files)} | ${f.preview ? 'yes' : ''} |`);
    L.push('');
  };
  table('switch', 'Flags: switches',
    `A unit switches on only through its own flag, never through \`${PREVIEW_ENV}\`. An unproven unit stays off or in shadow until its pre-registered bar passes. "preview-aware file" means a file naming the flag also reads preview mode; read that file before assuming preview leaves it off.`);
  table('setting', 'Settings', 'Paths, hosts, budgets and limits. Not switches.');
  table('secret', 'Secrets', 'Names only. Values live in the environment, never in the repo, a log or a message.');
  return L.join('\n');
}

async function main(argv) {
  const registry = readRegistry();
  const errs = validateRegistry(registry);
  if (errs.length) {
    for (const e of errs) console.error(`architecture: ${e}`);
    return 1;
  }
  const md = renderArchitecture({ registry });
  if (argv.includes('--check')) {
    const have = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
    if (have !== md) { console.error('architecture: docs/ARCHITECTURE.md is stale; run `npm run map:architecture`'); return 1; }
    console.log('architecture: docs/ARCHITECTURE.md is current');
    return 0;
  }
  fs.writeFileSync(OUT_PATH, md);
  console.log(`architecture: wrote ${path.relative(ROOT, OUT_PATH)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
