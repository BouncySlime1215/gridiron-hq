/**
 * Which bare catches sit over a SQL read, and of which table.
 *
 * Read-only. It reports candidates and decides nothing: a bare catch over a
 * read of a table that no migration creates is the SHAPE of the bug this
 * repository has now shipped three times, not proof of a fourth.
 *
 *   node scripts/swallow-scan.mjs [root=server]
 *
 * Three things it has to get right, each of which it got wrong first:
 *
 *  - A COMMENT IS NOT A QUERY. The naive version matched `FROM` in English
 *    prose — this repo's comments are long and say "read from the store" — and
 *    reported `the`, `this`, `node` and `python` as tables.
 *  - THE TRY IT MATCHES MUST BE THE TRY THAT MATCHES. A line scan for the
 *    nearest preceding `try` is stolen by a closed inner `try {} catch {}`, in
 *    one direction losing the read and in the other charging an inner catch's
 *    read to the outer one. So the block is found by matching braces, and a
 *    read belongs to the INNERMOST try that contains it.
 *  - NO FIXED LOOKBACK. The real maximum span between `try` and `catch` in
 *    server/ is 122 lines. A cap makes the scan incomplete, not cheap, and an
 *    enumeration that reports fewer sites than exist is worse than none.
 *
 * Known blind spot, deliberately left open and stated rather than papered over:
 * a query built by concatenation or interpolation (`'SELECT … FROM ' + table`,
 * `FROM ${table}`) has no literal table name to find, so this scan cannot see
 * it. counterparty-pricing.js:922 was exactly that shape. Every site this
 * reports is real; the set it reports is a floor, not a total.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REGEX_OK_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else',
  'void', 'delete', 'instanceof', 'new', 'yield', 'await']);

/**
 * `src` with every comment, string body and regex literal blanked to spaces,
 * newlines kept so line numbers survive, plus the span of each string body.
 *
 * The blanking is what makes brace matching trustworthy: `/^[a-z_]{1,64}$/`
 * and a template literal holding `${a ? `(${b})` : ''}` both carry braces that
 * are not code, and counting them would put every try block after them in the
 * wrong place.
 */
export function mask(src) {
  const out = new Array(src.length);
  const strings = [];
  const blank = (from, to) => {
    for (let k = from; k < to && k < src.length; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };
  // A stack, because `${…}` inside a template literal is code, and that code
  // may open another template literal. This repo does that on several lines.
  const stack = [{ kind: 'code', depth: 0 }];
  let i = 0, prevChar = '', word = '', prevWord = '';
  const regexAllowed = () => prevChar === '' || '(,=:[!&|?+-*%~^;{}'.includes(prevChar)
    || REGEX_OK_AFTER.has(prevWord);

  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i], d = src[i + 1];

    if (top.kind === 'template') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') {
        strings.push({ start: top.start, end: i, value: src.slice(top.start, i) });
        stack.pop(); blank(i, i + 1); i++; continue;
      }
      if (c === '$' && d === '{') {
        blank(i, i + 2); i += 2; stack.push({ kind: 'code', depth: 0 });
        prevChar = '{'; prevWord = ''; continue;
      }
      blank(i, i + 1); i++; continue;
    }

    if (c === '/' && d === '/') { const s = i; while (i < src.length && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && d === '*') {
      const s = i; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length); blank(s, i); continue;
    }
    if (c === '/' && regexAllowed()) {
      const s = i; i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < src.length && /[dgimsuvy]/.test(src[i])) i++;
      blank(s, i); prevChar = '/'; prevWord = ''; continue;
    }
    if (c === '"' || c === "'") {
      const s = i; i++;
      const body = i;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      strings.push({ start: body, end: i, value: src.slice(body, i) });
      i++; blank(s, i); prevChar = c; prevWord = ''; continue;
    }
    if (c === '`') { blank(i, i + 1); i++; stack.push({ kind: 'template', start: i }); continue; }

    if (c === '{') top.depth++;
    else if (c === '}') {
      // The `}` that closes a `${…}` returns us to the template it opened in.
      if (top.depth === 0 && stack.length > 1) { stack.pop(); blank(i, i + 1); i++; continue; }
      top.depth--;
    }
    out[i] = c;
    if (!/\s/.test(c)) prevChar = c;
    if (/[A-Za-z0-9_$]/.test(c)) word += c;
    else { if (word) prevWord = word; word = ''; }
    i++;
  }
  return { masked: out.map(ch => ch ?? ' ').join(''), strings };
}

/** Every `try { … }` in masked source, as the span between its own braces. */
export function tryBlocks(masked) {
  const blocks = [];
  for (const m of masked.matchAll(/\btry\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, j = open;
    for (; j < masked.length; j++) {
      if (masked[j] === '{') depth++;
      else if (masked[j] === '}' && --depth === 0) break;
    }
    if (depth === 0 && j < masked.length) blocks.push({ open, close: j });
  }
  return blocks;
}

/** Table names any SQL in `text` reads or writes, lowercased, deduplicated. */
export function tablesIn(text) {
  const names = [...text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+[`"']?([a-z_][a-z_0-9]*)/gi)]
    .map(m => m[1].toLowerCase());
  return [...new Set(names)].filter(t => !['select', 'where', 'sqlite_master'].includes(t));
}

/**
 * Every bare `catch {}` in `src` that sits over a SQL read, with the tables it
 * would swallow a fault from, and the 1-based line of the `catch`.
 *
 * A read is charged to the innermost `try` that contains it and to that one
 * only, so the count is a count of sites somebody can go and fix.
 */
export function scanSource(src) {
  const { masked, strings } = mask(src);
  const blocks = tryBlocks(masked);
  const hits = [];
  for (const b of blocks) {
    const after = /^\s*catch\s*\{/.exec(masked.slice(b.close + 1));
    if (!after) continue;                       // `catch (e)`, `finally`, or neither
    const inner = strings.filter(s => s.start > b.open && s.end <= b.close
      // innermost: no other try block sits between this one and the string
      && !blocks.some(o => o.open > b.open && o.close <= b.close
        && s.start > o.open && s.end <= o.close));
    const tables = tablesIn(inner.map(s => s.value).join('\n'));
    if (!tables.length) continue;
    const catchAt = b.close + 1 + after[0].indexOf('catch');
    hits.push({ line: masked.slice(0, catchAt).split('\n').length, tables });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Every table name a CREATE TABLE under `dirs` brings into being. */
export function migratedTables(dirs) {
  const names = new Set();
  for (const dir of dirs) {
    for (const f of jsFiles(dir)) {
      const { masked, strings } = mask(readFileSync(f, 'utf8'));
      void masked;
      for (const s of strings) {
        for (const m of s.value.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-z_][a-z_0-9]*)/gi)) {
          names.add(m[1].toLowerCase());
        }
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
  console.log(`bare catches over a literal SQL read: ${hits.length}`);
  console.log(`  of those, reading a table with NO migration: ${risky.length}\n`);
  for (const h of risky) console.log(`${h.file}:${h.line}  ${h.unmigrated.join(', ')}`);
}

if (process.argv[1] && process.argv[1].endsWith('swallow-scan.mjs')) main(process.argv[2] ?? 'server');
