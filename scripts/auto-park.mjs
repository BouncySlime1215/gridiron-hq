#!/usr/bin/env node
/**
 * AUTO-PARK (plan item 52): any shadow unit with no progress toward its bar for 3 weeks is flagged
 * "park?" in BENCHMARKS.md, with a one-line reason. Report only: it proposes, Nick decides.
 *
 *   node scripts/auto-park.mjs [--as-of YYYY-MM-DD] [--progress <log.jsonl>] [--file BENCHMARKS.md] [--write]
 *
 * Progress is the newer of the row's "last progress" cell and the newest dated entry for that unit in
 * the optional progress log (one JSON object per line: {"unit", "at": "YYYY-MM-DD", "note"}); a unit
 * with neither counts from its "registered" date. Only rows at status "shadow" are checked.
 *
 * Dry run by default (prints, writes nothing). --write rewrites only the "park" cells, and only with
 * GRIDIRON_AUTO_PARK=1. Exit 0: done (flags are a report, not a failure). Exit 2: bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PARK_DAYS = 21;
const BEGIN = '<!-- shadow-units:begin -->';
const END = '<!-- shadow-units:end -->';
const STATUSES = new Set(['shadow', 'live', 'parked']);
const COLS = ['unit', 'flag', 'status', 'bar', 'registered', 'last progress', 'progress note', 'park'];
const DAY_MS = 86_400_000;

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());

/** Epoch ms of a real calendar date YYYY-MM-DD, else null (2026-13-40 is not a date). */
function day(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

/** Rows between the shadow-units markers: { unit, flag, status, bar, registered, last, note, park, line }. */
export function parseShadowUnits(md) {
  const lines = md.split('\n');
  const a = lines.indexOf(BEGIN), b = lines.indexOf(END);
  if (a < 0 || b < a) throw new Error('BENCHMARKS.md: shadow-units markers not found');
  const rows = [];
  let header = null;
  for (let i = a + 1; i < b; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const c = cells(lines[i]);
    if (!header) {
      header = c;
      if (COLS.some((k, j) => header[j] !== k)) throw new Error(`shadow-units header must be: ${COLS.join(' | ')}`);
      continue;
    }
    if (c.every(x => /^-+$/.test(x))) continue;
    const r = Object.fromEntries(header.map((h, j) => [h, c[j] ?? '']));
    if (!STATUSES.has(r.status)) throw new Error(`shadow unit ${r.unit}: status "${r.status}" is not shadow, live or parked`);
    rows.push({ unit: r.unit, flag: r.flag, status: r.status, bar: r.bar, registered: r.registered,
      last: r['last progress'], note: r['progress note'], park: r.park, line: i });
  }
  return rows;
}

/** Progress log (JSONL) -> [{ unit, at, note }]. A bad line throws with its number. */
export function readProgressLog(text) {
  const out = [];
  text.split('\n').forEach((ln, i) => {
    if (!ln.trim()) return;
    let e;
    try { e = JSON.parse(ln); } catch { throw new Error(`progress log line ${i + 1}: not JSON`); }
    if (typeof e?.unit !== 'string' || day(e.at) === null) throw new Error(`progress log line ${i + 1}: needs "unit" and "at" as YYYY-MM-DD`);
    out.push({ unit: e.unit, at: e.at, note: String(e.note ?? '') });
  });
  return out;
}

/** The newest dated progress for a unit: { at, note, source: 'table' | 'log' } or null when there is none. */
export function lastProgress(u, log = []) {
  let best = null;
  if (u.last !== 'none') {
    if (day(u.last) === null) throw new Error(`shadow unit ${u.unit}: last progress "${u.last}" is not YYYY-MM-DD or none`);
    best = { at: u.last, note: u.note, source: 'table' };
  }
  for (const e of log) {
    if (e.unit === u.unit && (!best || day(e.at) > day(best.at))) best = { at: e.at, note: e.note, source: 'log' };
  }
  return best;
}

/** Per unit: { unit, days, park, reason }. reason is one line ('' when not flagged). */
export function assess(units, { asOf, log = [] } = {}) {
  const now = day(asOf);
  if (now === null) throw new Error(`--as-of "${asOf}" is not YYYY-MM-DD`);
  return units.map(u => {
    if (day(u.registered) === null) throw new Error(`shadow unit ${u.unit}: registered "${u.registered}" is not YYYY-MM-DD`);
    const last = lastProgress(u, log);
    const since = last ? last.at : u.registered;
    const days = Math.floor((now - day(since)) / DAY_MS);
    const park = u.status === 'shadow' && days >= PARK_DAYS;
    const what = last ? `last ${last.at}${last.note ? `: ${last.note}` : ''}` : `none since registered ${u.registered}`;
    const reason = park ? `park? no progress toward its bar for ${days} days (${what})`.replace(/[|\n]/g, '/') : '';
    return { unit: u.unit, status: u.status, days, since, park, reason };
  });
}

/** BENCHMARKS.md with each unit's park cell set to its reason; every other byte unchanged. */
export function applyPark(md, results) {
  const units = parseShadowUnits(md);
  const lines = md.split('\n');
  const col = COLS.indexOf('park') + 1; // parts[0] is the text before the leading pipe
  for (const res of results) {
    const u = units.find(x => x.unit === res.unit);
    if (!u || u.park === res.reason) continue;
    const parts = lines[u.line].split(/(?<!\\)\|/);
    parts[col] = ` ${res.reason} `;
    lines[u.line] = parts.join('|');
  }
  return lines.join('\n');
}

function main() {
  const o = { file: path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'BENCHMARKS.md'),
    asOf: new Date().toISOString().slice(0, 10) };
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--as-of') o.asOf = argv[++i];
    else if (a === '--progress') o.progress = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--write') o.write = true;
    else { console.log(`unknown argument ${a}`); process.exit(2); }
  }
  let md, res;
  try {
    md = fs.readFileSync(o.file, 'utf8');
    const log = o.progress ? readProgressLog(fs.readFileSync(o.progress, 'utf8')) : [];
    res = assess(parseShadowUnits(md), { asOf: o.asOf, log });
  } catch (e) { console.log(`BAD INPUT: ${e.message}`); process.exit(2); }

  for (const r of res) {
    if (r.park) console.log(`PARK? ${r.unit}: ${r.reason}`);
    else console.log(`${r.status === 'shadow' ? 'OK' : r.status.toUpperCase()} ${r.unit}: ${r.days} days since ${r.since}`);
  }
  const flagged = res.filter(r => r.park).length;
  const shadow = res.filter(r => r.status === 'shadow').length;
  console.log(`TOTAL ${res.length} units: ${shadow} shadow, ${flagged} flagged park? (${PARK_DAYS} days, as of ${o.asOf})`);
  if (!o.write) { console.log('dry run: BENCHMARKS.md not changed (--write to update the park cells)'); process.exit(0); }
  if (process.env.GRIDIRON_AUTO_PARK !== '1') {
    console.log('refused: --write needs GRIDIRON_AUTO_PARK=1 (off by default)');
    process.exit(2);
  }
  const out = applyPark(md, res);
  if (out !== md) fs.writeFileSync(o.file, out);
  console.log(out === md ? 'write: park cells already current' : 'write: park cells updated in BENCHMARKS.md');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
