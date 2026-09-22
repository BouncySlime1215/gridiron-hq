#!/usr/bin/env node
/*
 * THE HONEST INVENTORY.
 *
 * "Take full inventory of everything built so far — every model, every pipeline,
 *  every job, route, page and table — what is actually wired and working, what is
 *  half-done, what is dead or stale, what is silently broken. Be brutally honest;
 *  if something is decoration or does not pull real data, say so." (Nick, 2026-09-22)
 *
 * This file GENERATES docs/inventory/inventory.json from docs/wiring/wiring-map.json
 * and a hand-maintained evidence overlay. It is never the other way round: no row is
 * typed into inventory.json by hand. Two inputs, one output, plus a --check that
 * refuses to let the output drift from its own rules.
 *
 *   node scripts/inventory.mjs            # regenerate inventory.json + INVENTORY.md
 *   node scripts/inventory.mjs --check    # fail if any row lacks evidence or a legal status
 *
 * WHY A ROW CAN SAY "unclassified". The wiring map proves reachability by static
 * analysis: it can say a module reaches a live surface, or reaches none. It cannot
 * prove a table has current rows, because the rows that matter live in the Fly
 * database and this container cannot read them. The local server/data.sqlite is a
 * migrated empty shell (214 of 218 tables empty as of this writing), so a LOCAL row
 * count of zero means "unverifiable here", not "empty in production". Every status
 * that turns on "current rows" and cannot be proven is emitted as `unclassified` with
 * that exact reason. The generator never guesses a status it cannot defend, and never
 * omits a unit it cannot classify.
 *
 * THE FIVE STATUSES, enforced by classify() and by --check:
 *   wired          reachable from a live surface AND reads a table with current rows
 *                  (LOCAL rows > 0), or is a live surface that needs no table.
 *   half_done      code exists, but it reaches no live surface (or reaches one with
 *                  no data behind it that we can confirm) while still being imported
 *                  by non-test code — it is on its way somewhere and not there yet.
 *   dead           unreachable AND imported by nothing but tests.
 *   silently_broken  reachable, returns success, reads or writes nothing real. This
 *                  cannot be seen statically — it is supplied by the evidence overlay
 *                  from a thread that ran the code. The "data healthy" banner is the
 *                  type specimen.
 *   decoration     renders a number no current row backs. Also overlay-supplied.
 *   model          a thing that fits, projects, prices or scores. Emitted with a
 *                  BLANK status for the model-evidence audit thread to grade; nobody
 *                  grades their own rows.
 *   unclassified   the generator could not defend any of the above; carries a reason.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAP = path.join(ROOT, 'docs/wiring/wiring-map.json');
const OVERLAY = path.join(ROOT, 'docs/inventory/evidence-overlay.json');
const OUT_JSON = path.join(ROOT, 'docs/inventory/inventory.json');
const OUT_MD = path.join(ROOT, 'docs/inventory/INVENTORY.md');

const STATUSES = ['wired', 'half_done', 'dead', 'silently_broken', 'decoration'];
const KINDS = ['model', 'pipeline', 'job', 'route', 'page', 'table', 'script'];

const short = (sha) => (sha || '').slice(0, 7);
const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } };

/* ------------------------------------------------------------------ inputs */

function loadMap() {
  if (!existsSync(MAP)) throw new Error(`no wiring map at ${MAP} — run: npm run map:wiring`);
  return JSON.parse(readFileSync(MAP, 'utf8'));
}

function loadOverlay() {
  if (!existsSync(OVERLAY)) return { rows: [] };
  const o = JSON.parse(readFileSync(OVERLAY, 'utf8'));
  return { rows: Array.isArray(o.rows) ? o.rows : [] };
}

/*
 * LOCAL row counts. The word LOCAL is load-bearing: this reads the dev database in
 * this container, which is a migrated shell, not production. A count of 0 is
 * "unverifiable here", never "empty in the app". Returns a Map table -> count, and a
 * flag saying whether the DB was readable at all.
 */
function localRowCounts() {
  const counts = new Map();
  const dbPath = process.env.GRIDIRON_DB_PATH || path.join(ROOT, 'server/data.sqlite');
  if (!existsSync(dbPath)) return { counts, readable: false, dbPath, tables: 0, nonEmpty: 0 };
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch { return { counts, readable: false, dbPath, tables: 0, nonEmpty: 0 }; }
  let nonEmpty = 0;
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of names) {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
      counts.set(t, n);
      if (n > 0) nonEmpty++;
    } catch { /* a view or a virtual table without a backing count is not a row source */ }
  }
  db.close();
  return { counts, readable: true, dbPath, tables: names.length, nonEmpty };
}

/* ------------------------------------------------------------- derivation */

const slug = (s) => s.replace(/^.*\//, '').replace(/\.[a-z]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

// A module "fits, projects, prices or scores" — Nick's definition of a model. These
// go to the audit thread with a blank status. The list is deliberately generous: a
// false positive costs the audit thread one glance; a false negative ships a model
// nobody graded. Names, not behaviour, so the audit thread has the last word.
const MODEL_RE = /(model|project|forecast|price|pricing|scor|rank|calibrat|shrinkage|posture|acceptance|opportunity|contingency|outlook|archetype|counterparty|tactics|season-sim|sim\b|elo|rating|luck|regress|ensemble|shadow|edge|devig|market-correction|specialist|sharp)/i;

function reachesLiveSurface(wiring) {
  if (!wiring) return false;
  const live = (arr) => Array.isArray(arr) && arr.length > 0;
  // A script hop is not a live surface: a script is run by hand, not served. Routes,
  // jobs and pages are the live surfaces.
  return live(wiring.route_families) || live(wiring.jobs) || live(wiring.pages);
}

function tablesReadBy(modPath, tables) {
  const out = [];
  for (const t of tables) {
    if ((t.read_by || []).some((e) => e.startsWith(modPath + ':'))) out.push(t.table);
  }
  return out;
}

/*
 * The classifier. Returns { status, evidence, note } or { status: 'unclassified',
 * reason }. It only ever returns a status it can defend from the map plus LOCAL
 * counts; everything else is unclassified-with-reason. Model rows never reach here —
 * they are emitted blank for the audit thread.
 */
function classify({ modPath, wiring, findingsFor, tables, local }) {
  const reaches = reachesLiveSurface(wiring);
  const has = (rule) => findingsFor.some((f) => f.rule === rule);

  // DEAD: unreachable and imported by nothing but tests.
  if (!reaches && (has('module-imported-by-nothing') || has('module-only-tested'))) {
    const why = has('module-imported-by-nothing') ? 'imported by nothing' : 'imported only by tests';
    return { status: 'dead', evidence: `wiring-map: ${modPath} reaches no live surface and is ${why}` };
  }

  // Reaches no live surface but is imported by non-test code: on its way, not there.
  if (!reaches) {
    if (has('module-reaches-no-surface')) {
      return { status: 'half_done',
        evidence: `wiring-map: ${modPath} is imported by product code but reaches no route, job or page` };
    }
    // No wiring and no finding either way: cannot defend a status.
    return { status: 'unclassified',
      reason: `${modPath} shows no live-surface wiring and no reachability finding; static analysis cannot place it` };
  }

  // Reaches a live surface. Now the data question.
  const read = tablesReadBy(modPath, tables);
  if (read.length === 0) {
    // A reachable module that reads no table is wired if it needs no data (a formatter,
    // a validator, a pure transform). We can defend "wired, no table dependency".
    return { status: 'wired', evidence: `wiring-map: ${modPath} reaches a live surface and depends on no table` };
  }
  if (!local.readable) {
    return { status: 'unclassified',
      reason: `${modPath} reaches a live surface and reads ${read.join(', ')}, but no local DB is readable to confirm current rows` };
  }
  const backed = read.filter((t) => (local.counts.get(t) || 0) > 0);
  if (backed.length > 0) {
    const cells = backed.map((t) => `${t}=${local.counts.get(t)}`).join(', ');
    return { status: 'wired', evidence: `wiring-map + LOCAL rows: ${modPath} reaches a live surface and reads ${cells} (LOCAL)` };
  }
  // Reachable, reads tables, all LOCAL-empty. Cannot prove wired (no current rows) and
  // cannot prove broken (production may have rows). This is the honest gap.
  return { status: 'unclassified',
    reason: `${modPath} reaches a live surface and reads ${read.join(', ')}, all LOCAL 0 rows; `
      + `current rows unverifiable in this container (freshness registry pending)` };
}

function buildRows(map, local) {
  const modByPath = new Map(map.modules.map((m) => [m.path, m]));
  // A finding attaches to a path two ways, and both matter. Most rules put the path in
  // evidence[0]; the module-level deadness rules (module-imported-by-nothing,
  // module-only-tested, module-reaches-no-surface) put the module in `subject` and use
  // evidence for the caller or nothing at all. Keying on evidence[0] alone missed every
  // dead module — dead read as 0, which was a bug in this generator, not a clean tree.
  const byPath = new Map();
  const attach = (p, f) => { if (!p) return; if (!byPath.has(p)) byPath.set(p, []); byPath.get(p).push(f); };
  for (const f of map.findings) {
    attach((f.evidence?.[0] || '').split(':')[0], f);
    if (f.subject && f.subject !== (f.evidence?.[0] || '').split(':')[0]) attach(f.subject, f);
  }
  const findingsFor = (p) => byPath.get(p) || [];
  const rows = [];
  const commit = short(git(['rev-parse', 'HEAD']));

  const push = (r) => rows.push({ verified_at_commit: commit, ...r });

  // 1. server/services/*.js — models and pipelines.
  for (const name of readdirSync(path.join(ROOT, 'server/services')).filter((f) => f.endsWith('.js'))) {
    const p = `server/services/${name}`;
    const mod = modByPath.get(p);
    const isModel = MODEL_RE.test(name);
    if (isModel) {
      push({ id: `model:${slug(name)}`, kind: 'model', name, path: p, status: '',
        evidence: `handed to the model-evidence audit thread — status and evidence set by the audit, not here`,
        owner_thread: 'model-evidence-audit', note: 'blank status: awaiting audit grading' });
      continue;
    }
    const c = classify({ modPath: p, wiring: mod?.wiring, findingsFor: findingsFor(p), tables: map.tables, local });
    push({ id: `pipeline:${slug(name)}`, kind: 'pipeline', name, path: p, owner_thread: null, ...c });
  }

  // 2. server/routes/*.js — one row per route file.
  for (const name of readdirSync(path.join(ROOT, 'server/routes')).filter((f) => f.endsWith('.js'))) {
    const p = `server/routes/${name}`;
    const mod = modByPath.get(p);
    const routeCount = map.surfaces.filter((s) => s.kind === 'route' && s.file === p).length;
    const noCaller = findingsFor(p).filter((f) => f.rule === 'route-no-caller').length;
    let c;
    if (routeCount === 0) {
      c = { status: 'unclassified', reason: `${p} registers no route this map can see` };
    } else if (noCaller >= routeCount) {
      c = { status: 'half_done',
        evidence: `wiring-map: all ${routeCount} routes in ${p} have route-no-caller (registered, nothing calls them)` };
    } else {
      c = { status: 'wired',
        evidence: `wiring-map: ${p} registers ${routeCount} routes, ${routeCount - noCaller} with callers` };
    }
    push({ id: `route:${slug(name)}`, kind: 'route', name, path: p, owner_thread: null, ...c,
      note: `${routeCount} routes; ${noCaller} with no caller` });
  }

  // 3. jobs — the scheduler's job surfaces.
  for (const s of map.surfaces.filter((x) => x.kind === 'job')) {
    const p = s.file;
    const c = { status: 'unclassified',
      reason: `job ${s.name} at ${p}:${s.line} runs on tier ${s.tier}; whether it writes real rows needs a run, not static analysis` };
    push({ id: `job:${slug(s.name)}`, kind: 'job', name: s.name, path: `${p}:${s.line}`,
      owner_thread: 'scheduler', ...c, note: `tier ${s.tier}` });
  }

  // 4. client pages.
  const pagesDir = path.join(ROOT, 'client/src/pages');
  if (existsSync(pagesDir)) {
    for (const name of readdirSync(pagesDir).filter((f) => /\.(tsx|jsx)$/.test(f))) {
      const p = `client/src/pages/${name}`;
      const mod = modByPath.get(p);
      const routed = !findingsFor(p).some((f) => f.rule === 'page-never-routed');
      const c = routed
        ? { status: 'unclassified',
            reason: `page ${name} is routed in the client, but what it renders is verified by the UI thread, not by this static map` }
        : { status: 'half_done', evidence: `wiring-map: ${p} is never routed (page-never-routed)` };
      push({ id: `page:${slug(name)}`, kind: 'page', name, path: p, owner_thread: 'ui', ...c });
    }
  }

  // 5. tables — every table the map knows, with its LOCAL count.
  for (const t of map.tables) {
    const reaches = reachesLiveSurface(t.wiring);
    const localN = local.readable ? (local.counts.get(t.table) ?? null) : null;
    let c;
    if (!reaches) {
      c = { status: 'half_done',
        evidence: `wiring-map: table ${t.table} (created via ${t.created_via}) is read by no live surface` };
    } else if (localN === null) {
      c = { status: 'unclassified', reason: `table ${t.table} is read by a live surface; no local DB row count available` };
    } else if (localN > 0) {
      c = { status: 'wired', evidence: `wiring-map + LOCAL: table ${t.table} feeds a live surface, LOCAL rows ${localN}` };
    } else {
      c = { status: 'unclassified',
        reason: `table ${t.table} feeds a live surface but is LOCAL 0 rows; current rows unverifiable here (freshness registry pending)` };
    }
    push({ id: `table:${slug(t.table)}`, kind: 'table', name: t.table, path: t.created_at_site || t.created_in || '(unknown)',
      owner_thread: null, ...c, note: `created_via ${t.created_via}${localN !== null ? `; LOCAL ${localN} rows` : ''}` });
  }

  // 6. scripts — run by hand, so "wired" never applies; a script is dead if nothing
  //    but tests import it, else it exists as tooling (half_done is the closest of the
  //    five: code that exists and is not wired to a live consumer, by design).
  for (const mod of map.modules.filter((m) => m.tree === 'script')) {
    const p = mod.path;
    const ff = findingsFor(p);
    const entry = map.surfaces.some((s) => s.kind === 'script' && s.file === p);
    let c;
    if (ff.some((f) => f.rule === 'module-imported-by-nothing') && !entry) {
      // A script imported by nothing AND not itself an entry point (nothing runs it,
      // nothing imports it) is dead. An entry-point script is run by hand — that is
      // tooling, not deadness.
      c = { status: 'dead', evidence: `wiring-map: ${p} is imported by nothing and is not a runnable entry point` };
    } else {
      c = { status: 'half_done', evidence: `${p} is a script: run by hand, wired to no live surface by design` };
    }
    push({ id: `script:${slug(p)}`, kind: 'script', name: p.split('/').pop(), path: p, owner_thread: null, ...c });
  }

  return rows;
}

/* -------------------------------------------------------------- overlay */

// Overlay rows are runtime findings a thread measured that no static pass can produce
// (a throw, a 403, a banner that lies). Each carries its own evidence and owner_thread.
// An overlay row REPLACES a generated row with the same id (the thread saw the truth
// the static pass could only guess at) and is otherwise appended. The overlay never
// edits inventory.json; it is a separate, reviewable input.
function applyOverlay(rows, overlay) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const o of overlay.rows) {
    if (!o.id) continue;
    const merged = { ...(byId.get(o.id) || {}), ...o, from_overlay: true };
    byId.set(o.id, merged);
  }
  return [...byId.values()];
}

/* --------------------------------------------------------------- render */

function tally(rows) {
  const t = {};
  for (const r of rows) {
    const k = r.status === '' ? '(model, ungraded)' : (r.status || 'unclassified');
    t[k] = (t[k] || 0) + 1;
  }
  return t;
}

function renderMd(rows, meta) {
  const L = [];
  L.push('# The honest inventory');
  L.push('');
  L.push('Generated by `scripts/inventory.mjs` from `docs/wiring/wiring-map.json` and');
  L.push('`docs/inventory/evidence-overlay.json`. Never hand-edited. Regenerate with');
  L.push('`node scripts/inventory.mjs`; validate with `node scripts/inventory.mjs --check`.');
  L.push('');
  L.push(`Commit \`${meta.commit}\`. Map generated ${meta.mapAt}. ${rows.length} rows.`);
  L.push('');
  L.push('## The one thing to read first');
  L.push('');
  L.push(meta.local.readable
    ? `Row counts are LOCAL: read from \`${path.relative(ROOT, meta.local.dbPath)}\`, which is a migrated `
      + `dev database, not production. ${meta.local.nonEmpty} of ${meta.local.tables} tables hold any rows. `
      + `A LOCAL count of 0 means "cannot be confirmed here", not "empty in the app" — the rows that matter `
      + `live in the Fly database this container cannot read. Every status that turns on "current rows" and `
      + `cannot be proven is \`unclassified\` with that reason, never guessed.`
    : `No local database was readable, so no row count backs any data claim. Every data-dependent row is `
      + `\`unclassified\` with that reason.`);
  L.push('');
  L.push('## Counts by status');
  L.push('');
  L.push('| status | rows | meaning |');
  L.push('|---|---|---|');
  const meanings = {
    wired: 'reachable from a live surface and reads a table with current rows (LOCAL)',
    half_done: 'code exists, reaches no live surface (or none with confirmable data)',
    dead: 'unreachable and imported by nothing but tests',
    silently_broken: 'reachable, returns success, reads or writes nothing real',
    decoration: 'renders a number no current row backs',
    '(model, ungraded)': 'a model, blank status, handed to the model-evidence audit thread',
    unclassified: 'could not be defended statically; each row carries a reason',
  };
  const t = tally(rows);
  for (const k of ['wired', 'half_done', 'silently_broken', 'decoration', 'dead', '(model, ungraded)', 'unclassified']) {
    if (t[k]) L.push(`| ${k} | ${t[k]} | ${meanings[k]} |`);
  }
  L.push('');
  L.push('## By kind');
  L.push('');
  L.push('| kind | rows |');
  L.push('|---|---|');
  const byKind = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  for (const k of KINDS) if (byKind[k]) L.push(`| ${k} | ${byKind[k]} |`);
  L.push('');
  // The rows that are not clean: what a reader actually wants.
  for (const status of ['silently_broken', 'decoration', 'dead']) {
    const group = rows.filter((r) => r.status === status);
    if (!group.length) continue;
    L.push(`## ${status} — ${group.length}`);
    L.push('');
    for (const r of group.slice(0, 60)) {
      L.push(`- **${r.name}** (${r.kind}${r.owner_thread ? `, ${r.owner_thread}` : ''}) — ${r.evidence || r.reason}`);
    }
    L.push('');
  }
  L.push('The full row set, with evidence per row, is in `inventory.json`.');
  return L.join('\n') + '\n';
}

/* ----------------------------------------------------------------- check */

function check(rows) {
  const problems = [];
  const ids = new Set();
  for (const r of rows) {
    if (!r.id) problems.push(`a row has no id: ${JSON.stringify(r).slice(0, 80)}`);
    else if (ids.has(r.id)) problems.push(`duplicate id: ${r.id}`);
    else ids.add(r.id);
    if (!KINDS.includes(r.kind)) problems.push(`${r.id}: illegal kind ${JSON.stringify(r.kind)}`);
    const legal = r.status === '' ? r.kind === 'model'
      : r.status === 'unclassified' ? true
      : STATUSES.includes(r.status);
    if (!legal) problems.push(`${r.id}: illegal status ${JSON.stringify(r.status)}`);
    if (r.status === 'unclassified' && !r.reason) problems.push(`${r.id}: unclassified with no reason`);
    else if (r.status && r.status !== 'unclassified' && !r.evidence) problems.push(`${r.id}: status ${r.status} with no evidence`);
    // A blank model status is allowed to carry evidence that says it awaits grading.
  }
  return problems;
}

/* ------------------------------------------------------------------ main */

const map = loadMap();
const overlay = loadOverlay();
const local = localRowCounts();
let rows = buildRows(map, local);
rows = applyOverlay(rows, overlay);
rows.sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id));

const problems = check(rows);

if (process.argv.includes('--check')) {
  if (problems.length) {
    console.error(`inventory --check FAILED, ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 40)) console.error('  ' + p);
    process.exit(1);
  }
  console.log(`inventory --check OK: ${rows.length} rows, every one with a legal status and evidence or a reason`);
  process.exit(0);
}

if (problems.length) {
  console.error(`refusing to write: ${problems.length} problem(s) — run --check to list them`);
  process.exit(1);
}

const meta = { commit: short(git(['rev-parse', 'HEAD'])), mapAt: map.generated_at, local };
const doc = { generated_by: 'scripts/inventory.mjs', generated_at: new Date().toISOString(),
  from_map: map.generated_at, commit: meta.commit,
  local_db: { readable: local.readable, path: path.relative(ROOT, local.dbPath), tables: local.tables, non_empty: local.nonEmpty },
  counts: tally(rows), rows };
writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n');
writeFileSync(OUT_MD, renderMd(rows, meta));
console.log(`wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}: ${rows.length} rows`);
console.log('counts:', JSON.stringify(tally(rows)));
