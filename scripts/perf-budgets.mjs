#!/usr/bin/env node
/**
 * PERF BUDGETS (plan item 57): first-load bytes per area route on the built client, against
 * perf-budgets.json. A route whose gzip bytes grow more than BUDGET_PCT over its baseline is OVER.
 *
 *   npm run build && node scripts/perf-budgets.mjs [--update] [--json]
 *   (test hooks: --dist <dir> --areas <areas.json> --baseline <file>)
 *
 * The seven areas are read from client/src/navigation.ts (NAV_GROUPS) and their lazy page from
 * client/src/App.tsx, so a new or renamed area cannot slip past unbudgeted. First load of an area =
 * the entry chunk's static-import closure + the page chunk's static-import closure + their CSS,
 * each file once. Dynamic imports (other pages, lazy panels) are not first load.
 *
 * GRIDIRON_PERF_BUDGETS=enforce: exit 1 on any OVER / unbudgeted / missing row. Unset: report
 * only, exit 0. Exit 2 on bad input (no build, no manifest) in either mode.
 * --update rewrites the baseline from this build; commit it with the change that moved it.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUDGET_PCT = 10;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [{ area, path, src }] for every NAV_GROUPS destination, src relative to client/. */
export function areasFromSource(appTsx, navTs) {
  const groups = /NAV_GROUPS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(navTs)?.[1] ?? /NAV_GROUPS[^=]*=\s*\[([\s\S]*)\];/.exec(navTs)?.[1];
  if (!groups) throw new Error('navigation.ts: NAV_GROUPS not found');
  const lazies = new Map([...appTsx.matchAll(/const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*'\.\/(pages\/[\w/]+)'\s*\)\s*\)/g)]
    .map(m => [m[1], `src/${m[2]}.tsx`]));
  const routes = new Map([...appTsx.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)\s*\/>\}/g)].map(m => [m[1], m[2]]));
  const out = [];
  for (const m of groups.matchAll(/\{\s*to:\s*'([^']+)'(?:,\s*label:\s*'([^']*)')?/g)) {
    const comp = routes.get(m[1]);
    const src = comp && lazies.get(comp);
    if (!src) throw new Error(`area ${m[1]} has no lazy page route in App.tsx`);
    out.push({ area: m[2] ?? comp, path: m[1], src });
  }
  if (!out.length) throw new Error('navigation.ts: NAV_GROUPS lists no areas');
  return out;
}

/** The set of built files an area loads first: entry closure + page closure, JS and CSS. */
export function routeAssets(manifest, pageSrc) {
  const entry = Object.keys(manifest).find(k => manifest[k].isEntry);
  if (!entry) throw new Error('manifest has no entry');
  if (!manifest[pageSrc]) throw new Error(`manifest has no chunk for ${pageSrc}`);
  const files = new Set();
  const seen = new Set();
  const walk = key => {
    if (seen.has(key)) return;
    seen.add(key);
    const c = manifest[key];
    if (!c) throw new Error(`manifest names ${key} but has no chunk for it`);
    files.add(c.file);
    for (const css of c.css ?? []) files.add(css);
    for (const imp of c.imports ?? []) walk(imp);
  };
  walk(entry);
  walk(pageSrc);
  return files;
}

/** { [path]: { area, raw, gzip, files } } from the manifest and the built files under dist. */
export function measureAreas(manifest, areas, dist) {
  const out = {};
  for (const a of areas) {
    let raw = 0, gzip = 0;
    const files = routeAssets(manifest, a.src);
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dist, f));
      raw += buf.length;
      gzip += zlib.gzipSync(buf, { level: 9 }).length;
    }
    out[a.path] = { area: a.area, raw, gzip, files: files.size };
  }
  return out;
}

/** Per path: pass | improved | over | unbudgeted (no baseline) | missing (baseline, no area). */
export function compareBudgets(baseline, current, pct = BUDGET_PCT) {
  const rows = [];
  for (const [p, cur] of Object.entries(current)) {
    const base = baseline[p];
    if (!base) { rows.push({ path: p, baseline: null, gzip: cur.gzip, pct: null, status: 'unbudgeted' }); continue; }
    const change = Math.round((cur.gzip - base.gzip) / base.gzip * 1000) / 10;
    const status = cur.gzip > base.gzip * (1 + pct / 100) ? 'over' : cur.gzip < base.gzip ? 'improved' : 'pass';
    rows.push({ path: p, baseline: base.gzip, gzip: cur.gzip, pct: change, status });
  }
  for (const p of Object.keys(baseline)) if (!current[p]) rows.push({ path: p, baseline: baseline[p].gzip, gzip: null, pct: null, status: 'missing' });
  return rows;
}

function main() {
  const o = { dist: path.join(ROOT, 'client', 'dist'), baseline: path.join(ROOT, 'perf-budgets.json') };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--dist') o.dist = process.argv[++i];
    else if (a === '--areas') o.areas = process.argv[++i];
    else if (a === '--baseline') o.baseline = process.argv[++i];
    else if (a === '--update') o.update = true;
    else if (a === '--json') o.json = true;
    else { console.log(`unknown argument ${a}`); process.exit(2); }
  }
  const enforce = process.env.GRIDIRON_PERF_BUDGETS === 'enforce';
  let current;
  try {
    const manifestFile = path.join(o.dist, '.vite', 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error(`${path.relative(ROOT, manifestFile) || manifestFile} not found: run npm run build first`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const areas = o.areas ? JSON.parse(fs.readFileSync(o.areas, 'utf8'))
      : areasFromSource(fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8'), fs.readFileSync(path.join(ROOT, 'client/src/navigation.ts'), 'utf8'));
    current = measureAreas(manifest, areas, o.dist);
  } catch (e) { console.log(`BAD INPUT: ${e.message}`); process.exit(2); }

  if (o.update) {
    fs.writeFileSync(o.baseline, `${JSON.stringify({ budget_pct: BUDGET_PCT, metric: 'first-load gzip bytes (level 9) per area route', areas: current }, null, 2)}\n`);
    console.log(`baseline written: ${Object.keys(current).length} areas`);
    process.exit(0);
  }
  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(o.baseline, 'utf8')).areas ?? {}; }
  catch (e) { console.log(`BAD INPUT: baseline ${o.baseline}: ${e.message}`); process.exit(2); }

  const rows = compareBudgets(baseline, current);
  if (o.json) console.log(JSON.stringify(rows));
  const label = { pass: 'PASS', improved: 'IMPROVED', over: 'OVER', unbudgeted: 'UNBUDGETED', missing: 'MISSING' };
  for (const r of rows) {
    const kb = n => n === null ? 'none' : `${(n / 1024).toFixed(1)} kB`;
    const change = r.pct === null ? '' : ` (${r.pct >= 0 ? '+' : ''}${r.pct}%)`;
    console.log(`${label[r.status]} ${r.path} ${current[r.path]?.area ?? ''}: ${kb(r.gzip)} gzip vs ${kb(r.baseline)}${change}, budget +${BUDGET_PCT}%`);
  }
  const bad = rows.filter(r => ['over', 'unbudgeted', 'missing'].includes(r.status));
  console.log(`TOTAL ${rows.length} areas: ${rows.length - bad.length} within budget, ${bad.length} failing${enforce ? '' : ' (report only: GRIDIRON_PERF_BUDGETS is not "enforce")'}`);
  if (bad.length) console.log('If the growth is intended, run: npm run build && node scripts/perf-budgets.mjs --update, and commit perf-budgets.json with the change.');
  process.exit(enforce && bad.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
