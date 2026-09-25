#!/usr/bin/env node
/**
 * BENCHMARKS gate (ONE-PLAN.md night 10): compare today's numbers with the rows in BENCHMARKS.md and
 * refuse a regression. Read-only on every number: plans-file rows come from the served plans.json
 * (the one producer), the r50 rows from the harness's own printed line, anything else from --current.
 *
 *   node scripts/check-benchmarks.mjs --plans <plans.json> [--league 4] [--current more.json] [--log <file|->] [--ratchet]
 *
 * Exit 0: no row regressed. Exit 1: a row regressed. Exit 2: bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { denylistFromPlans, scanPlansText } from './check-names-leak.mjs';

const BEGIN = '<!-- benchmarks:begin -->';
const END = '<!-- benchmarks:end -->';
const EPS = 1e-9;

/** Split one markdown table row on unescaped pipes. */
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

function parseTolerance(s) {
  const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(s);
  if (!m) throw new Error(`bad tolerance "${s}"`);
  return m[2] ? { tolerance: 0, tolerance_pct: Number(m[1]) } : { tolerance: Number(m[1]), tolerance_pct: 0 };
}

/** Rows between the benchmark markers: { id, model, metric, better, tolerance, tolerance_pct, baseline|null, measured, command, line }. */
export function parseBenchmarks(md) {
  const lines = md.split('\n');
  const a = lines.indexOf(BEGIN), b = lines.indexOf(END);
  if (a < 0 || b < a) throw new Error('BENCHMARKS.md: benchmark markers not found');
  const rows = [];
  let header = null;
  for (let i = a + 1; i < b; i++) {
    const ln = lines[i];
    if (!ln.trim().startsWith('|')) continue;
    const c = cells(ln);
    if (!header) { header = c; continue; }
    if (c.every(x => /^-+$/.test(x))) continue;
    const r = Object.fromEntries(header.map((h, j) => [h, c[j] ?? '']));
    const baseline = r.baseline === 'unmeasured' ? null : Number(r.baseline);
    if (baseline !== null && !Number.isFinite(baseline)) throw new Error(`BENCHMARKS.md row ${r.id}: baseline "${r.baseline}"`);
    rows.push({ id: r.id, model: r.model, metric: r.metric, better: r.better, ...parseTolerance(r.tolerance),
      baseline, measured: r.measured, command: r.command.replace(/^`|`$/g, ''), line: i });
  }
  return rows;
}

/** The served league-4 numbers the plans file carries. An 'unknown' section is left out, never read as 0. */
export function measureFromPlans(doc, league = 4) {
  const e = (Array.isArray(doc?.leagues) ? doc.leagues : []).find(x => String(x?.league) === String(league));
  if (!e) throw new Error(`league ${league} is not in the plans file`);
  const out = {};
  const run = e._run ?? {};
  if (Number.isFinite(run.candidates_scored)) out['plans.candidates_scored'] = run.candidates_scored;
  if (Number.isFinite(run.runtime_ms)) out['plans.runtime_ms'] = run.runtime_ms;
  if (e.number_health?.status === 'ok' && Number.isFinite(e.number_health.value?.broken)) out['plans.number_health_broken'] = e.number_health.value.broken;
  const deny = denylistFromPlans({ leagues: [e] });
  if (deny.length) out['names.plans_text_hits'] = scanPlansText({ leagues: [e] }, deny).length;
  return out;
}

/** The r50 harness line (test/rb-title.test.js). */
export function measureFromLog(text) {
  const out = {};
  const m = /r50 harness: level SE ratio median ([\d.]+).*paired delta SE ratio ([\d.]+)/.exec(text);
  if (m) { out['sim.se_ratio_median'] = Number(m[1]); out['sim.se_ratio_paired'] = Number(m[2]); }
  return out;
}

/** Per row: pass | improved | regressed | unmeasured (no baseline) | not_run (no value given). */
export function compare(rows, current) {
  return rows.map(r => {
    const value = Object.hasOwn(current, r.id) ? Number(current[r.id]) : null;
    const base = { id: r.id, baseline: r.baseline, value };
    if (value === null || !Number.isFinite(value)) return { ...base, value: null, status: r.baseline === null ? 'unmeasured' : 'not_run' };
    if (r.baseline === null) return { ...base, status: 'unmeasured' };
    const slack = (r.tolerance ?? 0) + Math.abs(r.baseline) * (r.tolerance_pct ?? 0) / 100;
    let worse, better;
    if (r.better === 'higher') { worse = r.baseline - value; better = value - r.baseline; }
    else if (r.better === 'lower') { worse = value - r.baseline; better = r.baseline - value; }
    else {
      const t = Number(r.better.split(':')[1]);
      worse = Math.abs(value - t) - Math.abs(r.baseline - t); better = -worse;
    }
    const status = worse > slack + EPS ? 'regressed' : better > EPS ? 'improved' : 'pass';
    return { ...base, status };
  });
}

/** BENCHMARKS.md with the baseline cell of each improved row replaced; every other byte unchanged. */
export function ratchet(md, results) {
  const rows = parseBenchmarks(md);
  const lines = md.split('\n');
  const headerLine = lines.slice(lines.indexOf(BEGIN) + 1).find(l => l.trim().startsWith('|'));
  const col = cells(headerLine).indexOf('baseline');
  for (const res of results.filter(x => x.status === 'improved')) {
    const row = rows.find(r => r.id === res.id);
    const parts = lines[row.line].split(/(?<!\\)\|/);
    parts[col + 1] = ` ${res.value} `; // parts[0] is the text before the leading pipe
    lines[row.line] = parts.join('|');
  }
  return lines.join('\n');
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const file = path.join(root, 'BENCHMARKS.md');
  const o = { league: 4 };
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plans') o.plans = argv[++i];
    else if (a === '--league') o.league = Number(argv[++i]);
    else if (a === '--current') o.current = argv[++i];
    else if (a === '--log') o.log = argv[++i];
    else if (a === '--ratchet') o.ratchet = true;
    else { console.log(`unknown argument ${a}`); process.exit(2); }
  }
  const md = fs.readFileSync(file, 'utf8');
  const rows = parseBenchmarks(md);
  const current = {};
  try {
    if (o.plans) Object.assign(current, measureFromPlans(JSON.parse(fs.readFileSync(o.plans, 'utf8')), o.league));
    if (o.log) Object.assign(current, measureFromLog(fs.readFileSync(o.log === '-' ? 0 : o.log, 'utf8')));
    if (o.current) Object.assign(current, JSON.parse(fs.readFileSync(o.current, 'utf8')));
  } catch (e) { console.log(`BAD INPUT: ${e.message}`); process.exit(2); }
  const unknownIds = Object.keys(current).filter(k => !rows.some(r => r.id === k));
  for (const k of unknownIds) console.log(`UNKNOWN ROW ${k}: not in BENCHMARKS.md, ignored`);

  const res = compare(rows, current);
  const label = { pass: 'PASS', improved: 'IMPROVED', regressed: 'REGRESSED', unmeasured: 'UNMEASURED', not_run: 'NOT RUN' };
  for (const r of res) {
    const row = rows.find(x => x.id === r.id);
    const v = r.value === null ? 'no value' : String(r.value);
    console.log(`${label[r.status]} ${r.id}: ${v} vs baseline ${r.baseline ?? 'unmeasured'} (${row.better})`);
  }
  const n = s => res.filter(r => r.status === s).length;
  console.log(`TOTAL ${res.length} rows: ${n('pass') + n('improved')} hold (${n('improved')} improved), ${n('regressed')} regressed, ${n('not_run')} not run, ${n('unmeasured')} unmeasured`);
  if (o.ratchet && n('improved')) {
    fs.writeFileSync(file, ratchet(md, res));
    console.log(`ratchet: ${n('improved')} baselines moved in BENCHMARKS.md`);
  }
  process.exit(n('regressed') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
