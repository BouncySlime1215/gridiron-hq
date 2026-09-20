#!/usr/bin/env node
/**
 * A field a page renders, deleted from the response, and nothing goes red.
 *
 * Producer coverage says nothing about this. A test that calls the pure function and
 * asserts on its return value stays green when the field is dropped from the object the
 * route actually serves, one layer up — so a disclosure the UI depends on can be deleted
 * in one line, in silence. The UI thread measured exactly that on PR #43: deleting
 * `availability_basis` from the /news response literal left 6 of 6 tests green, and
 * deleting `slots_not_modelled` from what `lineupCall` returns left 34 of 34 green.
 *
 * What this does, per branch:
 *
 *   1. Every `key:` a branch ADDS to a server-side object literal, against its merge
 *      base with main.
 *   2. Kept only if the client reads that key by name. A field no page renders is not
 *      what this check is about, and reporting it would bury the ones that matter.
 *   3. The key's line is deleted; the test files that mention the changed module are
 *      run; the line is restored.
 *   4. Reported: the fields that stayed GREEN. Those are the ones nothing pins.
 *
 * A field reported here is not a bug by itself. It is a field whose presence on the
 * wire no test would notice going missing, which is a different and smaller claim —
 * and the one worth acting on before a merge that touches the same lines.
 *
 * Usage: node scripts/served-field-check.mjs <worktree> <base-ref>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [root, baseRef] = process.argv.slice(2);
if (!root || !baseRef) {
  console.error('usage: served-field-check.mjs <worktree> <base-ref>');
  process.exit(2);
}

const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });

/** Keys the client reads by name, from anywhere under client/src. */
function clientKeys() {
  const dir = path.join(root, 'client/src');
  const out = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
      }
    }
  };
  try { walk(dir); } catch { /* no client tree */ }
  return out;
}

/** `  some_field: expr,` added by this branch, in a server file, one per line. */
function addedFields(base) {
  const files = git('diff', '--name-only', `${base}...HEAD`, '--', 'server/')
    .split('\n').filter(Boolean);
  const found = [];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const added = new Set();
    let line = 0;
    for (const l of git('diff', '-U0', `${base}...HEAD`, '--', file).split('\n')) {
      const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { line = +hunk[1]; continue; }
      if (l.startsWith('+') && !l.startsWith('+++')) { added.add(line); line++; }
    }
    const src = fs.readFileSync(abs, 'utf8').split('\n');
    for (const n of added) {
      const text = src[n - 1] ?? '';
      const m = text.match(/^\s*([a-z_][\w]*)\s*:\s*\S/);
      // A bare `{` or a spread carries no key; a line ending in `{` opens a nested
      // object whose deletion would be a syntax error, not a measurement.
      if (!m || /[{[]\s*$/.test(text)) continue;
      // Not everything shaped like a served field is one. #61 added `error:` and
      // `reason:` inside a JSON.stringify() for a sync_log detail column, and both
      // words appear in the client for unrelated reasons, so both were reported as
      // unpinned served fields. They are not served at all.
      if (insideStringify(src, n)) continue;
      found.push({ file, line: n, key: m[1], text });
    }
  }
  return found;
}

/**
 * Is this line's enclosing object literal an argument to JSON.stringify()?
 *
 * A column's JSON detail blob is shaped exactly like a response literal and is not one.
 * Walks back with brace depth to the opening `{` this line sits in, then looks at what
 * precedes it.
 */
function insideStringify(lines, lineNo) {
  let depth = 0;
  for (let i = lineNo - 1; i >= 0 && lineNo - i < 60; i--) {
    const text = lines[i] ?? '';
    for (let k = text.length - 1; k >= 0; k--) {
      if (text[k] === '}') depth++;
      else if (text[k] === '{') {
        if (depth > 0) { depth--; continue; }
        return /JSON\.stringify\s*\(\s*$/.test(text.slice(0, k));
      }
    }
  }
  return false;
}

/** Test files that name the changed module, so a run is seconds rather than minutes. */
function testsFor(files) {
  const dir = path.join(root, 'test');
  const bases = files.map(f => path.basename(f, '.js'));
  const out = [];
  for (const e of fs.readdirSync(dir)) {
    if (!e.endsWith('.test.js')) continue;
    const src = fs.readFileSync(path.join(dir, e), 'utf8');
    if (bases.some(b => src.includes(`${b}.js`))) out.push(`test/${e}`);
  }
  return out;
}

function runTests(tests) {
  if (!tests.length) return { ran: 0, green: true };
  try {
    execFileSync('node', ['--experimental-test-module-mocks', '--test', '--test-concurrency=1', ...tests], {
      cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600000,
      env: { ...process.env, GRIDIRON_DB_PATH: `/tmp/sfc-${Date.now()}-${Math.random()}.sqlite`,
        SCHEDULER_DISABLED: '1', NODE_OPTIONS: '--import ./test/offline-guard.mjs' },
    });
    return { ran: tests.length, green: true };
  } catch {
    return { ran: tests.length, green: false };
  }
}

const base = git('merge-base', baseRef, 'HEAD').trim();
const rendered = clientKeys();
const fields = addedFields(base).filter(f => rendered.has(f.key));
const changed = git('diff', '--name-only', `${base}...HEAD`, '--', 'server/').split('\n').filter(Boolean);
const tests = testsFor(changed);

console.log(`base ${base.slice(0, 8)} — ${fields.length} added field(s) the client reads, ${tests.length} test file(s)`);
if (!tests.length) console.log('  NO TEST NAMES THESE MODULES — every field below is unpinned by construction');

const baseline = runTests(tests);
if (!baseline.green) {
  console.log('  the chosen tests are RED before any deletion; result would mean nothing');
  process.exit(3);
}

for (const f of fields) {
  const abs = path.join(root, f.file);
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  lines.splice(f.line - 1, 1);
  fs.writeFileSync(abs, lines.join('\n'));
  const r = runTests(tests);
  fs.writeFileSync(abs, src);
  console.log(`  ${r.green ? 'GREEN' : 'red  '}  ${f.key}  ${f.file}:${f.line}`);
}
