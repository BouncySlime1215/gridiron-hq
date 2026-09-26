// AUTO-PARK (plan item 52): a shadow unit with no progress toward its bar for 3 weeks is flagged
// "park?" in BENCHMARKS.md with a one-line reason. Report only: it writes the park cell and nothing
// else, dry run by default, and --write needs GRIDIRON_AUTO_PARK=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseShadowUnits, lastProgress, assess, applyPark, readProgressLog, PARK_DAYS } from '../scripts/auto-park.mjs';
import { parseBenchmarks } from '../scripts/check-benchmarks.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'auto-park.mjs');

const md = rows => [
  '# BENCHMARKS', '', '<!-- benchmarks:begin -->',
  '| id | model | metric | better | tolerance | baseline | measured | command |',
  '|---|---|---|---|---|---|---|---|',
  '| a.b | m | x | higher | 0 | 1 | today | `cmd` |',
  '<!-- benchmarks:end -->', '', '## Shadow units', '',
  '<!-- shadow-units:begin -->',
  '| unit | flag | status | bar | registered | last progress | progress note | park |',
  '|---|---|---|---|---|---|---|---|',
  ...rows,
  '<!-- shadow-units:end -->', '', 'tail text', '',
].join('\n');

const row = (unit, { status = 'shadow', registered = '2026-09-01', last = 'none', note = 'no grade yet', park = '' } = {}) =>
  `| ${unit} | GRIDIRON_${unit} | ${status} | bar for ${unit} | ${registered} | ${last} | ${note} | ${park} |`;

test('PARK_DAYS is three weeks', () => assert.equal(PARK_DAYS, 21));

test('B1: 21 days without progress is flagged "park?" with a one-line reason; 20 days is not', () => {
  const doc = md([row('OLD', { last: '2026-09-05', note: 'n=12 graded' }), row('FRESH', { last: '2026-09-06' })]);
  const res = assess(parseShadowUnits(doc), { asOf: '2026-09-26' });
  const old = res.find(r => r.unit === 'OLD'), fresh = res.find(r => r.unit === 'FRESH');
  assert.equal(old.park, true);
  assert.match(old.reason, /^park\? no progress toward its bar for 21 days \(last 2026-09-05: n=12 graded\)$/);
  assert.ok(!old.reason.includes('\n') && !old.reason.includes('|'));
  assert.equal(fresh.park, false);
  assert.equal(fresh.reason, '');
});

test('B1b: a unit with no progress at all counts from its registered date', () => {
  const res = assess(parseShadowUnits(md([row('NEVER', { registered: '2026-08-30' })])), { asOf: '2026-09-26' });
  assert.equal(res[0].park, true);
  assert.match(res[0].reason, /^park\? no progress toward its bar for 27 days \(none since registered 2026-08-30\)$/);
});

test('B2: live and parked rows are never flagged', () => {
  const doc = md([row('LIVE', { status: 'live', registered: '2026-01-01' }), row('GONE', { status: 'parked', registered: '2026-01-01' })]);
  for (const r of assess(parseShadowUnits(doc), { asOf: '2026-09-26' })) { assert.equal(r.park, false); assert.equal(r.reason, ''); }
});

test('B3: a newer progress-log entry resets the clock; an older one does not', () => {
  const units = parseShadowUnits(md([row('U', { last: '2026-09-01', note: 'n=3' })]));
  const log = readProgressLog([
    JSON.stringify({ unit: 'U', at: '2026-09-20', note: 'n=9 graded' }),
    JSON.stringify({ unit: 'U', at: '2026-08-01', note: 'older' }),
    JSON.stringify({ unit: 'OTHER', at: '2026-09-25', note: 'not this unit' }),
  ].join('\n'));
  assert.deepEqual(lastProgress(units[0], log), { at: '2026-09-20', note: 'n=9 graded', source: 'log' });
  const [r] = assess(units, { asOf: '2026-09-26', log });
  assert.equal(r.park, false);
  const [late] = assess(units, { asOf: '2026-10-11', log });
  assert.equal(late.park, true);
  assert.match(late.reason, /for 21 days \(last 2026-09-20: n=9 graded\)/);
});

test('B4: a bad date or unknown status fails loudly, never skipped as fresh', () => {
  assert.throws(() => assess(parseShadowUnits(md([row('BAD', { registered: 'soon' })])), { asOf: '2026-09-26' }), /BAD.*registered/);
  assert.throws(() => assess(parseShadowUnits(md([row('BAD', { last: '2026-13-40' })])), { asOf: '2026-09-26' }), /BAD.*last progress/);
  assert.throws(() => parseShadowUnits(md([row('ODD', { status: 'maybe' })])), /ODD.*status/);
  assert.throws(() => readProgressLog('{"unit":"U","at":"yesterday"}'), /progress log line 1/);
  assert.throws(() => readProgressLog('not json'), /progress log line 1/);
  assert.throws(() => parseShadowUnits('# no markers'), /shadow-units markers/);
});

test('B5: applyPark changes only park cells; every other byte is equal and it is idempotent', () => {
  const doc = md([row('OLD', { last: '2026-09-01', note: 'n=1' }), row('FRESH', { last: '2026-09-25' }), row('WAS', { last: '2026-09-25', park: 'park? stale text' })]);
  const out = applyPark(doc, assess(parseShadowUnits(doc), { asOf: '2026-09-26' }));
  const a = doc.split('\n'), b = out.split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l === b[i] ? null : i)).filter(i => i !== null);
  assert.equal(changed.length, 2, 'OLD gets flagged, WAS gets cleared');
  for (const i of changed) {
    const strip = s => s.split('|').slice(0, -2).join('|');
    assert.equal(strip(a[i]), strip(b[i]), 'only the park cell differs');
  }
  assert.match(b[changed[0]], /\| park\? no progress toward its bar for 25 days \(last 2026-09-01: n=1\) \|$/);
  assert.match(b[changed[1]], /\| WAS .* \|  \|$/);
  assert.equal(applyPark(out, assess(parseShadowUnits(out), { asOf: '2026-09-26' })), out);
  // The benchmark rows the merge gate reads are untouched.
  assert.deepEqual(parseBenchmarks(out), parseBenchmarks(doc));
});

function tmpDoc(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-park-'));
  const file = path.join(dir, 'BENCHMARKS.md');
  fs.writeFileSync(file, content);
  return file;
}
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', env: { ...process.env, GRIDIRON_AUTO_PARK: '', ...env } });

test('B5b: the CLI is a dry run by default; --write needs GRIDIRON_AUTO_PARK=1', () => {
  const doc = md([row('OLD', { last: '2026-09-01', note: 'n=1' })]);
  const file = tmpDoc(doc);
  const dry = run(['--file', file, '--as-of', '2026-09-26']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /PARK\? OLD/);
  assert.match(dry.stdout, /dry run/);
  assert.equal(fs.readFileSync(file, 'utf8'), doc);

  const refused = run(['--file', file, '--as-of', '2026-09-26', '--write']);
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /GRIDIRON_AUTO_PARK/);
  assert.equal(fs.readFileSync(file, 'utf8'), doc);

  const wrote = run(['--file', file, '--as-of', '2026-09-26', '--write'], { GRIDIRON_AUTO_PARK: '1' });
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.match(fs.readFileSync(file, 'utf8'), /\| park\? no progress toward its bar for 25 days/);

  const bad = run(['--file', tmpDoc(md([row('BAD', { registered: 'soon' })])), '--as-of', '2026-09-26']);
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /BAD INPUT/);
});

test('B6: the committed BENCHMARKS.md table parses, every flag exists in code, and no row is stale today', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'BENCHMARKS.md'), 'utf8');
  const units = parseShadowUnits(doc);
  assert.ok(units.length >= 10, `expected >= 10 shadow units, got ${units.length}`);
  const code = ['server', 'scripts'].flatMap(d => fs.readdirSync(path.join(ROOT, d), { recursive: true })
    .filter(f => /\.(m?js)$/.test(f)).map(f => fs.readFileSync(path.join(ROOT, d, f), 'utf8'))).join('\n');
  const seen = new Set();
  for (const u of units) {
    assert.ok(!seen.has(u.unit), `duplicate unit ${u.unit}`); seen.add(u.unit);
    assert.match(u.flag, /^GRIDIRON_[A-Z0-9_]+$/);
    assert.ok(new RegExp(`\\b${u.flag}\\b`).test(code), `${u.unit}: flag ${u.flag} not found in server/ or scripts/`);
  }
  // The committed park cells match what the tool computes from the committed dates on the day they were written.
  const res = assess(units, { asOf: '2026-09-26' });
  assert.equal(applyPark(doc, res), doc, 'committed park cells are what auto-park writes on 2026-09-26');
});
