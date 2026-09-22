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
// A table can carry one status the five do not cover. A "phantom" table is named in SQL
// and read by product code, but no migration and no schema file creates it — its only
// CREATE TABLE statements live in a hand-run script or a test fixture, so it is absent
// in any database where neither ran, production included. That is not silently_broken:
// silently_broken is a reachable code path that returns success while reading nothing,
// and a table is neither a code path nor a returner. It is not dead (it is read from all
// over) and not half_done (the reader is finished; the CREATE is what is missing). It is
// its own shape, and forcing it into one of the five would mislabel it, so it gets its
// own name — used only for kind=table, enforced below.
const TABLE_ONLY_STATUSES = ['referenced_but_never_created'];
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
  //
  // A job has TWO locations and they are not interchangeable. `line` is where
  // the job is REGISTERED, which is always in scheduler.js; `file` is the
  // module that IMPLEMENTS it, which the map resolves for 8 of 62 and leaves
  // null for the rest, deliberately, rather than attribute an unresolved job
  // to scheduler.js and make it appear to reach everything the scheduler
  // imports.
  //
  // Pairing the two produced citations like
  // `server/betting/nfl/strategy/t60-runner.js:1293` for a file 533 lines
  // long, and the literal string "null:1280" for the unresolved majority. The
  // registration site is the one location that is always real, so it is the
  // path; the module is named separately, in words, when it is known.
  const SCHED = 'server/services/scheduler.js';
  for (const s of map.surfaces.filter((x) => x.kind === 'job')) {
    const at = `${SCHED}:${s.line}`;
    const impl = s.file ? `implemented by ${s.file}` : 'implementing module unresolved by the map';
    const c = { status: 'unclassified',
      reason: `job ${s.name} is registered at ${at} on tier ${s.tier} (${impl}); whether it writes real rows needs a run, not static analysis` };
    push({ id: `job:${slug(s.name)}`, kind: 'job', name: s.name, path: at,
      owner_thread: 'scheduler', ...c,
      note: `tier ${s.tier}; ${impl}` });
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
  //
  // `created_by` is the creation bucket (migration | import | first_write | script |
  // test_only | definition), and it is populated for every table. A table created only
  // outside migrations — by a hand-run script or a test fixture — and read by product
  // code is a phantom: it is absent in any database where that script or fixture never
  // ran, production included, and its unguarded readers return results as if it were
  // there. That takes precedence over reachability: a table nothing creates in prod is
  // never "wired", however live the surface that reads it.
  // A foreign-DB table lives in a database other than the app's (the chat DB, the
  // sleeper-history DB, a jev crawl DB). The map's table-in-another-database rule is the
  // authority for which those are. Two things follow. Its LOCAL app-DB row count is
  // meaningless — it is not in the app DB — so a count read here says nothing about it.
  // And "no migration creates it" is expected, not a defect: those databases are not
  // migration-managed; their own sync or crawl creates their schema. So a foreign table
  // is neither wired-by-app-rows nor a phantom; it is classified on its own terms.
  const foreign = new Set(map.findings.filter((f) => f.rule === 'table-in-another-database').map((f) => f.subject));
  const PHANTOM_BUCKETS = new Set(['script', 'test_only']);
  for (const t of map.tables) {
    const prodReaders = (t.read_by || []).filter((e) => !e.startsWith('test/'));
    const reaches = reachesLiveSurface(t.wiring);
    const localN = local.readable ? (local.counts.get(t.table) ?? null) : null;
    let c;
    if (foreign.has(t.table)) {
      const outside = PHANTOM_BUCKETS.has(t.created_by)
        ? `; in tracked code its only CREATE TABLE is ${t.created_by === 'test_only' ? 'a test fixture' : 'a hand-run script'} `
          + `(${t.created_at_site}), so how its schema is created in production is not in this repo`
        : '';
      c = { status: 'unclassified',
        reason: `${t.table} lives in a separate database (table-in-another-database), not the app DB, so `
          + `app-DB reachability and LOCAL app-DB row counts do not apply and its presence is not verifiable here`
          + outside };
    } else if (PHANTOM_BUCKETS.has(t.created_by) && prodReaders.length > 0) {
      const where = t.created_by === 'test_only' ? 'a test fixture' : 'a hand-run script';
      c = { status: 'referenced_but_never_created',
        evidence: `wiring-map: no migration creates app-DB table ${t.table}; its only CREATE TABLE is ${where} `
          + `(${t.created_at_site}), so it is absent in any app database where that never ran, production included. Read by `
          + `${prodReaders.length} product site${prodReaders.length === 1 ? '' : 's'} `
          + `(e.g. ${prodReaders.slice(0, 3).join(', ')}), which read it as if it existed.` };
    } else if (!reaches) {
      c = { status: 'half_done',
        evidence: `wiring-map: table ${t.table} (created by ${t.created_by}) is read by no live surface` };
    } else if (localN === null) {
      c = { status: 'unclassified', reason: `table ${t.table} is read by a live surface; no local DB row count available` };
    } else if (localN > 0) {
      c = { status: 'wired', evidence: `wiring-map + LOCAL: table ${t.table} feeds a live surface, LOCAL rows ${localN}` };
    } else {
      c = { status: 'unclassified',
        reason: `table ${t.table} feeds a live surface but is LOCAL 0 rows; current rows unverifiable here (freshness registry pending)` };
    }
    push({ id: `table:${slug(t.table)}`, kind: 'table', name: t.table, path: t.created_at_site || t.created_in || '(unknown)',
      owner_thread: null, ...c, note: `created by ${t.created_by}${localN !== null ? `; LOCAL ${localN} rows` : ''}` });
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
    referenced_but_never_created: 'a table read by product code that no migration or schema file creates (table-only)',
    unclassified: 'could not be defended statically; each row carries a reason',
  };
  const t = tally(rows);
  for (const k of ['wired', 'half_done', 'silently_broken', 'decoration', 'referenced_but_never_created', 'dead', '(model, ungraded)', 'unclassified']) {
    if (t[k]) L.push(`| ${k} | ${t[k]} | ${meanings[k]} |`);
  }
  L.push('');
  L.push('### How this count was arrived at, including the two wrong answers');
  L.push('');
  L.push('The phantom-table figure moved twice before it settled, and both moves are recorded');
  L.push('here rather than presenting the final number as if it were the first.');
  L.push('');
  L.push('**1 →** the first pass hand-marked a single table, on the reading that the creation');
  L.push('bucket could not be derived. That was wrong for a specific reason: it read');
  L.push('`created_via`, which is only a resolved-from pointer for definition-indirected');
  L.push('creates and is null by design almost everywhere. The bucket is `created_by`, and it');
  L.push('is populated for every table.');
  L.push('');
  L.push('**→ 24** once the sweep ran on the right field. But that conflated two different');
  L.push('things.');
  L.push('');
  L.push('**→ 7** after separating tables that live in ANOTHER database. For the chat corpus,');
  L.push('the sleeper-history DB and the jev crawl DBs, "no migration creates it" is expected');
  L.push('rather than a defect: those databases are not migration-managed and their own sync');
  L.push('builds their schema. Seventeen tables moved out on that basis, and the same fix');
  L.push('corrected a measurement bug — app-DB row counts were being read for tables that are');
  L.push('not in the app DB, which says nothing about them.');
  L.push('');
  L.push('Each move was toward what the map actually proves. The number to act on is 7.');
  L.push('');
  L.push('`referenced_but_never_created` is a table-only status, not one of the five component');
  L.push('statuses. A phantom table — named in SQL, read across the app, created only by a');
  L.push('hand-run script or a test fixture and by no migration — is absent in any database');
  L.push('where that script never ran, production included. It is not `silently_broken` (that is');
  L.push('a code path returning success while reading nothing; a table is not a code path), not');
  L.push('`dead` (it is read from everywhere), and not `half_done` (the reader is finished; the');
  L.push('CREATE is what is missing). Forcing it into one of the five would mislabel it, so it');
  L.push('carries its own name.');
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
  for (const status of ['silently_broken', 'decoration', 'referenced_but_never_created', 'dead']) {
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
      : STATUSES.includes(r.status)
      || (r.kind === 'table' && TABLE_ONLY_STATUSES.includes(r.status));
    if (!legal) problems.push(`${r.id}: illegal status ${JSON.stringify(r.status)} for kind ${r.kind}`);
    if (r.status === 'unclassified' && !r.reason) problems.push(`${r.id}: unclassified with no reason`);
    else if (r.status && r.status !== 'unclassified' && !r.evidence) problems.push(`${r.id}: status ${r.status} with no evidence`);
    // A blank model status is allowed to carry evidence that says it awaits grading.
  }
  return problems;
}

export { buildRows, classify, check, tally };

/* ------------------------------------------------------------------ main */

// Importing this file to test buildRows must not read the map, open the local
// database, or write docs/. Everything below runs only when the script is the
// process entry point.
const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* imported for its exports; main does not run */ } else {

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

}
