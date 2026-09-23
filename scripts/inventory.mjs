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
 *   wired-betting-only  the same, except every surface that reaches it is one of the
 *                  three betting routes. Betting is out of scope, so this is real
 *                  reach into something the product is not meant to be using, and it
 *                  is counted apart from the fantasy `wired` total. See CONTRACT.md.
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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAP = path.join(ROOT, 'docs/wiring/wiring-map.json');
const OVERLAY = path.join(ROOT, 'docs/inventory/evidence-overlay.json');
const AUDIT = path.join(ROOT, 'docs/inventory/model-audit-rows-654ff93.json');
// `--out <dir>` writes the pair somewhere else, the way scripts/wiring-map.mjs
// already allows. Without it the only way to exercise this generator was to let
// it overwrite the committed artifacts, which dirties the tree mid-suite — and
// an unstaged write is invisible to a `git write-tree` guard, because that
// hashes the index. So "run the generator" and "keep the tree clean" were
// mutually exclusive, and the generator went untested.
const OUT_DIR = (() => {
  const i = process.argv.indexOf('--out');
  const next = i === -1 ? null : process.argv[i + 1];
  return next && !next.startsWith('--')
    ? path.resolve(ROOT, next)
    : path.join(ROOT, 'docs/inventory');
})();
const OUT_JSON = path.join(OUT_DIR, 'inventory.json');
const OUT_MD = path.join(OUT_DIR, 'INVENTORY.md');

const STATUSES = ['wired', 'wired-betting-only', 'half_done', 'dead', 'silently_broken', 'decoration'];

/*
 * `wired-betting-only`, per docs/inventory/CONTRACT.md. Reachable, and reachable
 * ONLY through a betting surface. Betting is out of scope for this product, so
 * such a row is genuinely served and served somewhere the product is not meant
 * to be using, and counting it inside the fantasy `wired` total overstates how
 * much of the product is connected.
 *
 * The test is ALL paths, never the first one found. The wiring map already
 * records the complete set of surfaces that reach a module -- `route_families`,
 * `jobs` and `pages` are enumerated sets, not a first hit -- so this reads that
 * set rather than walking the graph again.
 */
/*
 * THE BETTING SURFACES, AS AN EXPLICIT LIST, with the reason each one is on it.
 *
 * This replaced a three-prefix match (Auditor R17/R18). A mount prefix is
 * EVIDENCE for adding a surface to this list; it is not the test. The prefix
 * rule got `/api/betting/wong` right by accident -- wong.js happens to sit under
 * the hub's prefix -- and got execution-slate.js wrong on the merits, because it
 * is mounted at `/api/execution-slate`, which no betting prefix matches, so a
 * module served only by it graded `wired`. Nothing about a URL says what product
 * a route belongs to.
 *
 * The labels are three, not two. `routes/mlb.js` is neither: a module whose only
 * request reach is `/api/mlb` is not betting-only BY DEFINITION, and it is not
 * part of the fantasy product this inventory counts either.
 */
const SURFACE_LABELS = new Map([
  // The three the contract named from the start: the NFL market feed, the NFL
  // betting engine and the betting hub the front end calls.
  ['server/routes/nfl-market.js', 'betting'],
  ['server/routes/nfl-betting.js', 'betting'],
  ['server/routes/betting-hub.js', 'betting'],
  // Mounted at /api/betting/wong, under the hub. Wong teaser scanning.
  ['server/routes/wong.js', 'betting'],
  // Mounted at /api/execution-slate, outside every betting prefix. Bet execution
  // slates; the case that showed a prefix cannot be the test.
  ['server/routes/execution-slate.js', 'betting'],
  // Its own label. Not betting, and not the fantasy product either.
  ['server/routes/mlb.js', 'mlb'],
]);

/**
 * The label of each route FAMILY, derived from the files actually mounted under
 * it -- never from the family's name.
 *
 * A family takes a label only when EVERY file mounted under it carries that same
 * label. `/api/betting` holds both betting-hub.js and wong.js, so it is betting;
 * if an unlisted route were ever mounted under it, the family would go unlabelled
 * and every module it reaches would grade fantasy-`wired` again, which is the
 * safe direction for a rule that removes rows from the product's total.
 */
function familyLabels(mounts = []) {
  const byFamily = new Map();
  for (const m of mounts) {
    const family = '/api/' + String(m.prefix ?? '').split('/')[2];
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family).add(SURFACE_LABELS.get(m.file) ?? null);
  }
  const out = new Map();
  for (const [family, labels] of byFamily) {
    const only = labels.size === 1 ? [...labels][0] : null;
    if (only) out.set(family, only);
  }
  return out;
}

const APP_ROOT_SURFACE = 'boot:server/index.js';

/*
 * The betting route files themselves. For a MODULE the grade asks what reaches
 * it; for the ROUTE FILE that question is circular -- nfl-market.js is reached
 * through nfl-market.js -- so the route row takes the grade by being on the
 * list. Only a route that would otherwise be `wired` moves: the grade is
 * a refinement of reach, and a betting route no page calls is still `half_done`.
 */
const BETTING_ROUTE_FILES = new Set(
  [...SURFACE_LABELS].filter(([, label]) => label === 'betting').map(([file]) => file));

/*
 * A SCRIPT IN package.json IS AN ENTRY POINT, and the first version of this
 * rule missed it. `reachesLiveSurface()` ignores the map's `scripts` bucket,
 * correctly, because a script is not a live SURFACE. But this question is not
 * "what surface serves this row", it is "is every way in a betting route", and
 * `npm run build:role-scenario-lab` is a way in. Ignoring scripts graded 12 rows
 * betting-only that are reachable without touching a betting route at all —
 * including `role-scenario-engine.js`, which CONTRACT.md offers as its own
 * worked example for the grade and which `npm run build:role-scenario-lab`
 * reaches. Found by Opportunity diffing the sets rather than the totals.
 *
 * A HAND-RUN script still does not disqualify. The same contract: "Record it as
 * `reached from: hand-run script`, never as `wired`." Nothing in the repository
 * causes it to run, so it is not a way the product reaches anything. The test is
 * package.json membership, not the existence of a script.
 */
function bettingOnly(wiring, packageScripts = new Set(), labels = new Map()) {
  const names = (a) => (a ?? []).map((x) => x.name);
  const families = names(wiring?.route_families);
  // The grade says what SERVES the row. A module no route reaches is not served
  // through a betting route; it is not served through a route at all.
  if (families.length === 0) return false;
  // `mlb` and unlabelled both fail this, for different reasons that land in the
  // same place: neither is a betting surface.
  if (families.some((f) => labels.get(f) !== 'betting')) return false;
  const otherEntry = [
    ...names(wiring?.jobs),
    ...names(wiring?.pages),
    ...names(wiring?.scripts).filter((n) => packageScripts.has(n)),
  ].filter((n) => n !== APP_ROOT_SURFACE);
  return otherEntry.length === 0;
}

/** Every script path `package.json` names, which is what makes one an entry point. */
function packageJsonScripts() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return new Set(Object.values(pkg.scripts ?? {})
      .flatMap((v) => v.match(/(?:server\/)?scripts\/[\w.-]+\.(?:mjs|js)/g) ?? []));
  } catch { return new Set(); }
}
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
function classify({ modPath, wiring, findingsFor, tables, local, packageScripts, labels }) {
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
  // Reachable only through a betting surface is its own grade, whatever the data
  // question says: it is out-of-scope reach, and it leaves the fantasy total.
  const betting = bettingOnly(wiring, packageScripts, labels);
  const served = betting
    ? `every surface that reaches it is a betting route (${(wiring.route_families ?? []).map((f) => f.name).join(', ')})`
    : null;
  const WIRED = betting ? 'wired-betting-only' : 'wired';

  const read = tablesReadBy(modPath, tables);
  if (read.length === 0) {
    // A reachable module that reads no table is wired if it needs no data (a formatter,
    // a validator, a pure transform). We can defend "wired, no table dependency".
    return { status: WIRED,
      evidence: betting
        ? `wiring-map: ${modPath} depends on no table, and ${served}`
        : `wiring-map: ${modPath} reaches a live surface and depends on no table` };
  }
  if (!local.readable) {
    return { status: 'unclassified',
      reason: `${modPath} reaches a live surface and reads ${read.join(', ')}, but no local DB is readable to confirm current rows` };
  }
  const backed = read.filter((t) => (local.counts.get(t) || 0) > 0);
  if (backed.length > 0) {
    const cells = backed.map((t) => `${t}=${local.counts.get(t)}`).join(', ');
    return { status: WIRED,
      evidence: betting
        ? `wiring-map + LOCAL rows: ${modPath} reads ${cells} (LOCAL), and ${served}`
        : `wiring-map + LOCAL rows: ${modPath} reaches a live surface and reads ${cells} (LOCAL)` };
  }
  // Reachable, reads tables, all LOCAL-empty. Cannot prove wired (no current rows) and
  // cannot prove broken (production may have rows). This is the honest gap.
  return { status: 'unclassified',
    reason: `${modPath} reaches a live surface and reads ${read.join(', ')}, all LOCAL 0 rows; `
      + `current rows unverifiable in this container (freshness registry pending)` };
}

function buildRows(map, local) {
  const pkgScripts = packageJsonScripts();
  // The label of every mounted route family, read off this map's own mounts.
  const labels = familyLabels(map.mounts ?? []);
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
    const c = classify({ modPath: p, wiring: mod?.wiring, findingsFor: findingsFor(p),
      tables: map.tables, local, packageScripts: pkgScripts, labels });
    push({ id: `pipeline:${slug(name)}`, kind: 'pipeline', name, path: p, owner_thread: null, ...c });
  }

  // 2. server/routes/*.js — one row per route file.
  for (const name of readdirSync(path.join(ROOT, 'server/routes')).filter((f) => f.endsWith('.js'))) {
    const p = `server/routes/${name}`;
    const mod = modByPath.get(p);
    const routeCount = map.surfaces.filter((s) => s.kind === 'route' && s.file === p).length;
    const noCaller = findingsFor(p).filter((f) => f.rule === 'route-no-caller').length;
    // A route no page calls but a script dials over HTTP is reported by
    // route-called-from-outside-the-app INSTEAD of route-no-caller, never as
    // well as it. Counting only the no-caller rule therefore left those routes
    // in the remainder, and the remainder was being read as "has a caller" —
    // absence of a finding taken for evidence of a consumer. A route a script
    // syncs and a route a page renders are not the same kind of alive.
    const scriptOnly = findingsFor(p).filter((f) => f.rule === 'route-called-from-outside-the-app').length;
    const pageCalled = routeCount - noCaller - scriptOnly;
    let c;
    if (routeCount === 0) {
      c = { status: 'unclassified', reason: `${p} registers no route this map can see` };
    } else if (noCaller >= routeCount) {
      c = { status: 'half_done',
        evidence: `wiring-map: all ${routeCount} routes in ${p} have route-no-caller (registered, nothing calls them)` };
    } else if (pageCalled <= 0) {
      c = { status: 'half_done',
        evidence: `wiring-map: ${p} registers ${routeCount} routes and no page calls any of them; `
          + `${noCaller} have route-no-caller and ${scriptOnly} `
          + `${scriptOnly === 1 ? 'is' : 'are'} route-called-from-outside-the-app `
          + `(a script in this repository dials ${scriptOnly === 1 ? 'it' : 'them'} over HTTP)` };
    } else {
      const betting = BETTING_ROUTE_FILES.has(p);
      c = { status: betting ? 'wired-betting-only' : 'wired',
        evidence: `wiring-map: ${p} registers ${routeCount} routes, ${pageCalled} called by a page`
          + (scriptOnly ? ` and ${scriptOnly} dialled only by a script` : '')
          + (betting ? ' — a betting surface, out of scope, counted apart from the fantasy wired total' : '') };
    }
    push({ id: `route:${slug(name)}`, kind: 'route', name, path: p, owner_thread: null, ...c,
      note: `${routeCount} routes; ${pageCalled > 0 ? pageCalled : 0} page-called, ${scriptOnly} script-only, ${noCaller} with no caller` });
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
      // Absent from this container's migrated shell, and WHY matters. A
      // migration-created table missing here means the shell is behind the
      // migration list; it says nothing about production, where the migration
      // has run. A table created at module import has no migration at all — it
      // comes into existence as a side effect of importing the module that owns
      // it, so it is absent in any database where that import has not happened,
      // and that is a fact about the code rather than about this container.
      // Not a phantom either way: the creator is production code, not a test
      // fixture or a hand-run script, which is what PHANTOM_BUCKETS covers above.
      const why = t.created_by === 'migration'
        ? `created by a migration (${t.created_at_site || 'site unrecorded'}) that this container's `
          + `dev shell has not applied, so the count is unreadable HERE and that is `
          + `not evidence that it is absent in production`
        : `no migration creates it: it is created at ${t.created_by} by `
          + `${t.created_at_site || 'an unrecorded site'}, so it exists only in a database where `
          + `that code has run, and its absence here is a property of the code rather than of this container`;
      c = { status: 'unclassified',
        reason: `table ${t.table} is read by a live surface but is not in the LOCAL database; ${why}` };
    } else if (localN > 0) {
      c = { status: 'wired', evidence: `wiring-map + LOCAL: table ${t.table} feeds a live surface, LOCAL rows ${localN}` };
    } else {
      c = { status: 'unclassified',
        reason: `table ${t.table} feeds a live surface but is LOCAL 0 rows; current rows unverifiable here (freshness registry pending)` };
    }
    push({ id: `table:${slug(t.table)}`, kind: 'table', name: t.table, path: t.created_at_site || t.created_in || '(unknown)',
      owner_thread: null, ...c, note: `created by ${t.created_by}${localN !== null ? `; LOCAL ${localN} rows` : ''}` });
  }



  // 5b. tables that exist in no database — rows the table loop above CANNOT
  // produce, because map.tables is built from CREATE statements and these names
  // have none. Until the map grew table-read-but-never-created they had no row
  // at all: not wired, not dead, not unclassified, absent. That was the worst
  // case of this file's own category and the one it could not see.
  for (const f of map.findings.filter((x) => x.rule === 'table-read-but-never-created')) {
    const sites = (f.evidence || []).join(', ');
    const satellite = f.kind === 'context';
    push({ id: `table:${slug(f.subject)}`, kind: 'table', name: f.subject,
      path: (f.evidence || [])[0] || '(unknown)', owner_thread: null,
      ...(satellite
        ? { status: 'unclassified',
            reason: `${f.subject} is read at ${sites} and created nowhere in this tree, but every `
              + `reader opens a satellite database of its own, so its schema is not this repository's `
              + `to create — the same reasoning table-in-another-database applies to the chat corpus. `
              + `Whether the satellite file reaches production is a deployment question, and `
              + `data-file-not-in-the-image is the finding that answers it` }
        : { status: 'referenced_but_never_created',
            evidence: `wiring-map: ${f.subject} is read at ${sites} and has no CREATE TABLE anywhere `
              + `in this tree — no migration, no schema file, no script, no test fixture — and no `
              + `CREATE VIEW either. The read cannot succeed in any database, so the path holding it `
              + `is inert.` }),
      note: satellite ? 'satellite-database table, not an app-DB phantom' : 'created nowhere in this tree' });
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
/*
 * GRADED ROWS FROM ANOTHER THREAD.
 *
 * The model-evidence audit thread graded 16 service files and 12 route files,
 * each with its own evidence array, at 654ff93. Their file is vendored here
 * verbatim, sha256 f08e3fd3288e2b046cc5011d25eccade22ba159c70a411c284c4d1055a1b6fd4,
 * so the merge is reproducible and their bytes are not the mount's only copy.
 *
 * Merging is not overwriting. This generator is a party to the disagreement,
 * so it does not get to decide it. Where the two readings agree, theirs wins,
 * because their row carries per-consumer evidence and this one carries a
 * summary. Where they disagree the row goes to `unclassified` naming BOTH
 * readings and the definition each rests on, because a contested verdict is
 * not a verdict and `unclassified` is exactly what the contract reserves for
 * a row nobody can defend yet.
 *
 * The live disagreement is what counts as a live surface: this map counts a
 * mounted route, theirs counts a consumer reachable from client/src/App.tsx's
 * import closure. Adopting one definition project-wide is a bigger call than
 * this merge and is deliberately not made here.
 */
function loadAudit() {
  if (!existsSync(AUDIT)) return [];
  const o = JSON.parse(readFileSync(AUDIT, 'utf8'));
  return Array.isArray(o.rows) ? o.rows : [];
}

const CLAIMS_LIVE = /reaches a live surface/;

function applyAudit(rows, audit) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const out = { agreed: 0, contested: 0, unmatched: [] };
  for (const a of audit) {
    const mine = byId.get(`${a.kind}:${a.id}`) ?? byPath.get(a.path);
    if (!mine) { out.unmatched.push(a.id); continue; }
    const theirs = `${a.status}: ${(a.evidence || []).slice(-1)[0] || ''}`;
    const contested = mine.status !== a.status
      && mine.status !== ''
      && !(mine.status === 'unclassified' && !CLAIMS_LIVE.test(mine.reason || ''));
    if (contested) {
      out.contested++;
      byId.set(mine.id, { ...mine, status: 'unclassified', evidence: undefined,
        reason: `CONTESTED, not yet adjudicated. This map: ${mine.status} — `
          + `${(mine.evidence || mine.reason || '').replace(/\s+/g, ' ')}. `
          + `Model-evidence audit at 654ff93: ${theirs}. `
          + `The two rest on different definitions of a live surface: a mounted route here, `
          + `a consumer reachable from client/src/App.tsx's import closure there. Neither reading `
          + `is withdrawn and neither is adopted.`,
        owner_thread: mine.owner_thread ?? 'model-evidence-audit',
        note: `${mine.note ? mine.note + '; ' : ''}contested with the model-evidence audit` });
    } else {
      out.agreed++;
      byId.set(mine.id, { ...mine, status: a.status,
        evidence: (a.evidence || []).join(' | ') || mine.evidence,
        reason: undefined,
        owner_thread: 'model-evidence-audit',
        note: `${a.scope ? a.scope + '; ' : ''}graded by the model-evidence audit at ${short(a.commit || '654ff93')}` });
    }
  }
  return { rows: [...byId.values()], stats: out };
}

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

/**
 * What each unresolved row is waiting for, and who can supply it.
 *
 * 597 rows is not a score and not a backlog. The rows are six questions, and
 * only one of them is answered by more analysis of this tree. The largest
 * block by far waits on a single fact this container cannot obtain — a row
 * count from the production database — because `server/data.sqlite` here is a
 * migrated dev shell and a LOCAL count of 0 means "cannot be confirmed here",
 * never "empty in the app".
 *
 * ORDER MATTERS, in one place, measured rather than assumed. 11 of the 13
 * CONTESTED rows also carry the LOCAL-0 wording, because a contested reason
 * quotes this map's own reading verbatim — so testing the row count first
 * moves all 11 and the disagreement with the other thread disappears into the
 * largest bucket. The job and satellite buckets do NOT overlap the LOCAL-0
 * wording on the current tree (0 rows each), so their position is defensive
 * rather than load-bearing, and this comment says which is which because a
 * blanket "order matters" teaches nobody where to be careful.
 *
 * The catch-all is returned even at zero. A bucket that disappears when empty
 * is a bucket nobody checks, and a new reason string would then leave the
 * breakdown quietly short.
 */
const BLOCKERS = [
  ['adjudication between two threads',
    (r, t) => /^CONTESTED/.test(t)],
  ['the model-evidence audit thread',
    (r, t) => r.kind === 'model' || /handed to the model-evidence audit/.test(t)],
  ['a deployment question: whether the image ships the file',
    (r, t) => /separate database|satellite|created nowhere in this tree/.test(t)],
  ['a file that exists only on the owner\'s Mac',
    (r, t) => /off-server Python script/.test(t)],
  ['a run: static analysis cannot say whether a job writes rows',
    (r) => r.kind === 'job'],
  ['the UI thread',
    (r) => r.kind === 'page'],
  ['a production row count',
    (r, t) => /LOCAL 0 rows|not in the LOCAL database/.test(t)],
];
const UNSORTED = 'unsorted: no bucket claims these yet';

function blockers(rows) {
  const counts = new Map(BLOCKERS.map(([who]) => [who, { who, count: 0, kinds: new Set() }]));
  counts.set(UNSORTED, { who: UNSORTED, count: 0, kinds: new Set() });

  for (const r of rows) {
    const resolved = r.status && r.status !== 'unclassified';
    if (resolved) continue;
    const text = String(r.reason ?? r.evidence ?? '');
    const hit = BLOCKERS.find(([, test]) => test(r, text));
    const bucket = counts.get(hit ? hit[0] : UNSORTED);
    bucket.count += 1;
    bucket.kinds.add(r.kind);
  }

  const out = [...counts.values()].map((b) => ({ ...b, kinds: [...b.kinds].sort() }));
  const tail = out.find((b) => b.who === UNSORTED);
  return [...out.filter((b) => b !== tail && b.count > 0).sort((a, b) => b.count - a.count), tail];
}

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
    'wired-betting-only': 'reachable, and reachable only through nfl-market, nfl-betting or betting-hub — out of scope, counted apart from the fantasy wired total',
    half_done: 'code exists, reaches no live surface (or none with confirmable data)',
    dead: 'unreachable and imported by nothing but tests',
    silently_broken: 'reachable, returns success, reads or writes nothing real',
    decoration: 'renders a number no current row backs',
    '(model, ungraded)': 'a model, blank status, handed to the model-evidence audit thread',
    referenced_but_never_created: 'a table read by product code that no migration or schema file creates (table-only)',
    unclassified: 'could not be defended statically; each row carries a reason',
  };
  const t = tally(rows);
  for (const k of ['wired', 'wired-betting-only', 'half_done', 'silently_broken', 'decoration', 'referenced_but_never_created', 'dead', '(model, ungraded)', 'unclassified']) {
    if (t[k]) L.push(`| ${k} | ${t[k]} | ${meanings[k]} |`);
  }
  L.push('');
  L.push('## What this inventory cannot answer, and who can');
  L.push('');
  const bl = blockers(rows);
  const unresolved = bl.reduce((n, b) => n + b.count, 0);
  L.push(`${unresolved} of ${rows.length} rows are unresolved. That is not one pile and not a`);
  L.push('score. It is a set of questions, and only one of them is answered by more analysis');
  L.push('of this tree. Each row below is counted exactly once, and the buckets sum to the');
  L.push('total — including the catch-all, which is printed even at zero so a reason string');
  L.push('nobody has bucketed shows up as a number instead of quietly going missing.');
  L.push('');
  L.push('| rows | waiting on | which kinds |');
  L.push('|---|---|---|');
  for (const b of bl) L.push(`| ${b.count} | ${b.who} | ${b.kinds.join(', ') || '—'} |`);
  L.push('');
  const live = bl.find((b) => b.who === 'a production row count')?.count ?? 0;
  if (live) {
    L.push(`**${live} of them turn on one fact.** Not a judgement, not a design question: a row`);
    L.push('count from the production database. This container reads a migrated dev shell, so a');
    L.push('LOCAL count of 0 means "cannot be confirmed here". Nothing in this repository moves');
    L.push('those rows, and effort spent trying to classify them from source is wasted.');
    L.push('');
  }
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

export { buildRows, classify, check, tally, applyAudit, blockers };
export { SURFACE_LABELS, familyLabels, bettingOnly };

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
const audit = applyAudit(rows, loadAudit());
rows = applyOverlay(audit.rows, overlay);
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
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n');
writeFileSync(OUT_MD, renderMd(rows, meta));
console.log(`wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}: ${rows.length} rows`);
console.log('counts:', JSON.stringify(tally(rows)));
console.log(`model-audit rows merged: ${audit.stats.agreed} agreed, ${audit.stats.contested} contested` + (audit.stats.unmatched.length ? `, ${audit.stats.unmatched.length} unmatched: ${audit.stats.unmatched.join(', ')}` : ', 0 unmatched'));

}
