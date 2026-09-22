/**
 * Which bare catches sit over a SQL read, and of which table.
 *
 * Read-only. It reports candidates and decides nothing: a bare catch over a
 * read of a table that no migration creates is the shape of the bug this
 * repository has now shipped three times, not proof of one.
 *
 * STRIPS COMMENTS FIRST. The naive version matched `FROM` in English prose —
 * this repo's comments are long and say things like "read from the store" — and
 * reported `the`, `this`, `node` and `python` as tables. A scan that cannot
 * tell a comment from a query cannot enumerate anything.
 *
 *   node scripts/swallow-scan.mjs [root=server]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Remove // and block comments without touching string contents. */
export function stripComments(src) {
  let out = '', i = 0, state = 'code', quote = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += ' '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += ' '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (state === 'str') {
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
      if (c === quote) { state = 'code'; }
      out += c; i++; continue;
    }
  }
  return out;
}

/** Table names any SQL in `text` reads or writes, lowercased, deduplicated. */
export function tablesIn(text) {
  const names = [...text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+[`"']?([a-z_][a-z_0-9]*)/gi)]
    .map(m => m[1].toLowerCase());
  return [...new Set(names)].filter(t => !['select', 'where', 'sqlite_master'].includes(t));
}

/**
 * Every bare `catch {}` in `src` that sits over a SQL read, with the tables it
 * would swallow a fault from.
 */
export function scanSource(src) {
  const lines = stripComments(src).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/catch\s*\{/.test(lines[i])) continue;
    // From the NEAREST preceding `try`, not a fixed window: a 12-line lookback
    // swept in the SQL of an earlier try block and attributed it to this catch.
    let start = -1;
    for (let j = i; j >= Math.max(0, i - 25); j--) if (/\btry\s*\{/.test(lines[j])) { start = j; break; }
    if (start < 0) continue;
    const block = lines.slice(start, i + 1).join('\n');
    // `import x from 'node:fs'` is not a SQL read, and matching it reported
    // `node` and `python` as tables. Only count FROM/JOIN/INTO/UPDATE that sit
    // inside a quoted string — every query in this repo is one.
    const sql = [...block.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)]
      .map(m => m[1] ?? m[2] ?? m[3]).join('\n');
    const tables = tablesIn(sql);
    if (tables.length) hits.push({ line: i + 1, tables });
  }
  return hits;
}

/** Every table name a CREATE TABLE under `dirs` brings into being. */
export function migratedTables(dirs) {
  const names = new Set();
  for (const dir of dirs) {
    for (const f of jsFiles(dir)) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-z_][a-z_0-9]*)/gi)) {
        names.add(m[1].toLowerCase());
      }
    }
  }
  return names;
}

function jsFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

function main(root) {
  const migrated = migratedTables(['server/migrations', 'server/db/schema']);
  const hits = [];
  for (const f of jsFiles(root)) {
    for (const h of scanSource(readFileSync(f, 'utf8'))) {
      hits.push({ file: f, ...h, unmigrated: h.tables.filter(t => !migrated.has(t)) });
    }
  }
  const risky = hits.filter(h => h.unmigrated.length);
  console.log(`tables a migration or schema file creates: ${migrated.size}`);
  console.log(`bare catches over a real SQL read: ${hits.length}`);
  console.log(`  of those, reading a table with NO migration: ${risky.length}\n`);
  for (const h of risky) console.log(`${h.file}:${h.line}  ${h.unmigrated.join(', ')}`);
}

if (process.argv[1] && process.argv[1].endsWith('swallow-scan.mjs')) main(process.argv[2] ?? 'server');
