#!/usr/bin/env node
/**
 * NAMES-LEAK (ONE-PLAN.md night 10): league-mate team and manager names never leave Nick's machine.
 *
 * plans.json carries those names on purpose (TEAM-NAMES-2, view.js teamLabel: Nick reads the manager
 * he knows), and the repository is public. So the denylist is built at run time from the plans file's
 * own `teams` map and is never written anywhere. Every report names a file and line, or a JSON path,
 * plus the roster id and whether the hit is a team or manager name: never the name itself.
 *
 *   node scripts/check-names-leak.mjs --plans <plans.json> --tracked            # every git-tracked text file
 *   node scripts/check-names-leak.mjs --plans <plans.json> --range origin/main...HEAD   # files a push would add
 *   node scripts/check-names-leak.mjs --plans <plans.json> --files a.md b.txt    # a handoff set, a screenshot's page text
 *   node scripts/check-names-leak.mjs --plans <plans.json> --report-plans       # names in plans.json text fields, by field
 *   [--extra <file>]  one more name per line (a local, untracked list: chat names the teams map lacks)
 *
 * Exit 0: no hit. Exit 1: a hit in a file (or in plans text with --strict-plans). Exit 2: no denylist
 * (plans file missing or with no teams map): the check cannot run and says so instead of passing.
 * Default plans path: ~/gridiron-local/warroom/plans.json (produce-plans.mjs's default).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** 'Team 3', 'Team roster-7', 'Manager B': the public placeholder labels fixtures use, never a denylist term. */
export const genericLabel = s => typeof s === 'string' && /^(Team|Manager) [A-Za-z0-9_.:-]+$/.test(s.trim());

const MIN_LEN = 3; // a two-letter manager handle would match half the English language

/** [{ term, roster, kind: 'team' | 'manager', league }] from every league entry's teams map. */
export function denylistFromPlans(doc) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(doc?.leagues) ? doc.leagues : []) {
    const map = e?.teams?.status === 'ok' ? e.teams.value : null;
    if (!map || typeof map !== 'object') continue;
    for (const [roster, t] of Object.entries(map)) {
      for (const [field, kind] of [['name', 'team'], ['manager', 'manager']]) {
        const term = typeof t?.[field] === 'string' ? t[field].trim() : '';
        if (term.length < MIN_LEN || genericLabel(term)) continue;
        const key = `${term.toLowerCase()}|${roster}|${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ term, roster: String(roster), kind, league: e.league });
      }
    }
  }
  return out;
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matcher = term => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(term)}(?![\\p{L}\\p{N}_])`, 'giu');

/** Every occurrence of a denylisted term in one string: [{ roster, kind, league }] (no term). */
export function scanText(text, deny) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  for (const d of deny) {
    const n = text.match(matcher(d.term))?.length ?? 0;
    for (let i = 0; i < n; i++) hits.push({ roster: d.roster, kind: d.kind, league: d.league });
  }
  return hits;
}

/** Every string in plans.json except the teams map itself: [{ path, roster, kind, league }]. */
export function scanPlansText(doc, deny) {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === 'string') { for (const h of scanText(v, deny)) hits.push({ path: p, ...h }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'teams' && /^\$\.leagues\[\d+\]$/.test(p)) continue; // the source of the denylist
        walk(x, `${p}.${k}`);
      }
    }
  };
  walk(doc, '$');
  return hits;
}

/** Hits per top-level league section: { flip_map: 3, next_move: 3 }. */
export function fieldCounts(hits) {
  const out = {};
  for (const h of hits) {
    const k = /^\$\.leagues\[\d+\]\.([^.[]+)/.exec(h.path)?.[1] ?? h.path;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|sqlite|db|zip|gz|woff2?|ttf|otf|mp4|mov|wasm)$/i;

/** [{ file, line, roster, kind, league }] over text files; binaries and unreadable files are listed as skipped. */
export function scanFiles(files, deny, { skipped = [] } = {}) {
  const hits = [];
  for (const file of files) {
    if (BINARY.test(file)) { skipped.push({ file, why: 'binary' }); continue; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { skipped.push({ file, why: e.code ?? 'unreadable' }); continue; }
    if (text.includes('\u0000')) { skipped.push({ file, why: 'binary' }); continue; }
    text.split('\n').forEach((ln, i) => { for (const h of scanText(ln, deny)) hits.push({ file, line: i + 1, ...h }); });
  }
  return hits;
}

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
}

function rangeFiles(root, range) {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', '-z', range], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

function parseArgs(argv) {
  const o = { plans: path.join(os.homedir(), 'gridiron-local', 'warroom', 'plans.json'), files: [], extra: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plans') o.plans = argv[++i];
    else if (a === '--extra') o.extra = argv[++i];
    else if (a === '--tracked') o.tracked = true;
    else if (a === '--range') o.range = argv[++i];
    else if (a === '--report-plans') o.reportPlans = true;
    else if (a === '--strict-plans') o.strictPlans = true;
    else if (a === '--files') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.files.push(argv[++i]); }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const o = parseArgs(process.argv);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(o.plans, 'utf8')); } catch (e) {
    console.log(`NO DENYLIST: plans file not readable (${e.code ?? e.message}); the check did not run.`);
    process.exit(2);
  }
  const deny = denylistFromPlans(doc);
  if (o.extra) {
    for (const [i, ln] of fs.readFileSync(o.extra, 'utf8').split('\n').entries()) {
      const term = ln.trim();
      if (term.length >= MIN_LEN && !term.startsWith('#')) deny.push({ term, roster: `extra:${i + 1}`, kind: 'extra', league: null });
    }
  }
  if (!deny.length) { console.log('NO DENYLIST: the plans file has no team or manager names; the check did not run.'); process.exit(2); }
  console.log(`denylist: ${deny.length} terms from ${new Set(deny.map(d => `${d.league}:${d.roster}`)).size} rosters (terms not printed)`);

  let fail = 0;
  if (o.reportPlans) {
    const hits = scanPlansText(doc, deny);
    const byField = Object.entries(fieldCounts(hits)).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    console.log(`${hits.length && o.strictPlans ? 'FAIL' : 'REPORT'} plans text: ${hits.length} name hits (${byField})`);
    for (const h of hits.slice(0, 20)) console.log(`  ${h.path}: league ${h.league} roster ${h.roster} ${h.kind} name`);
    if (hits.length && o.strictPlans) fail++;
  }
  const files = [...o.files];
  if (o.tracked) files.push(...trackedFiles(root).map(f => path.join(root, f)));
  if (o.range) files.push(...rangeFiles(root, o.range).map(f => path.join(root, f)));
  if (files.length) {
    const skipped = [];
    const hits = scanFiles(files, deny, { skipped });
    if (hits.length) {
      fail++;
      console.log(`FAIL files: ${hits.length} name hits in ${new Set(hits.map(h => h.file)).size} of ${files.length} files`);
      for (const h of hits.slice(0, 40)) console.log(`  ${path.relative(root, h.file) || h.file}:${h.line}: league ${h.league} roster ${h.roster} ${h.kind} name`);
    } else console.log(`PASS files: 0 name hits in ${files.length - skipped.length} text files (${skipped.length} binary or unreadable skipped)`);
  }
  if (!o.reportPlans && !files.length) { console.log('nothing to scan: pass --tracked, --range, --files or --report-plans'); process.exit(2); }
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
