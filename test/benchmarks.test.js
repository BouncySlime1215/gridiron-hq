// BENCHMARKS (night 10): one row per model in BENCHMARKS.md with its command and number;
// the merge gate refuses a regression. The gate only reads served values (plans.json and
// the numbers a row's own command prints); it never computes a second copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseBenchmarks, measureFromPlans, compare, ratchet } from '../scripts/check-benchmarks.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MD = fs.readFileSync(path.join(ROOT, 'BENCHMARKS.md'), 'utf8');

test('BENCHMARKS.md parses: every row has an id, a direction, a command, and a number or "unmeasured"', () => {
  const rows = parseBenchmarks(MD);
  assert.ok(rows.length >= 8, `expected >= 8 rows, got ${rows.length}`);
  const ids = new Set();
  for (const r of rows) {
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`); ids.add(r.id);
    assert.ok(['higher', 'lower'].includes(r.better) || /^target:/.test(r.better), `${r.id} direction ${r.better}`);
    assert.ok(r.command.length > 0, `${r.id} has no command`);
    assert.ok(r.baseline === null || Number.isFinite(r.baseline), `${r.id} baseline`);
    assert.ok(Number.isFinite(r.tolerance) && r.tolerance >= 0, `${r.id} tolerance`);
  }
  // The rows the plan names (ONE-PLAN.md section 5, night 10).
  for (const id of ['plans.candidates_scored', 'plans.runtime_ms', 'plans.number_health_broken', 'sim.se_ratio_median',
    'clears_bench.survivors', 'price_band.coverage_80', 'love.hit_rate']) assert.ok(ids.has(id), `missing row ${id}`);
});

const row = (o) => ({ id: 'x', better: 'higher', tolerance: 0, baseline: 10, command: 'c', ...o });

test('compare: higher/lower/target directions, tolerance, unmeasured and missing', () => {
  const rows = [
    row({ id: 'h', better: 'higher', baseline: 53, tolerance: 0 }),
    row({ id: 'l', better: 'lower', baseline: 97918, tolerance: 0, tolerance_pct: 25 }),
    row({ id: 't', better: 'target:0.8', baseline: 0.76, tolerance: 0.01 }),
    row({ id: 'u', baseline: null }),
    row({ id: 'm', baseline: 3 })
  ];
  const res = Object.fromEntries(compare(rows, { h: 52, l: 120000, t: 0.84, u: 7 }).map(r => [r.id, r.status]));
  assert.deepEqual(res, { h: 'regressed', l: 'pass', t: 'pass', u: 'unmeasured', m: 'not_run' });
  const res2 = Object.fromEntries(compare(rows, { h: 60, l: 130000, t: 0.86 }).map(r => [r.id, r.status]));
  assert.equal(res2.h, 'improved');
  assert.equal(res2.l, 'regressed'); // 130000 > 97918 * 1.25
  assert.equal(res2.t, 'regressed'); // |0.86-0.8| = 0.06 > |0.76-0.8| + 0.01
});

test('measureFromPlans reads the served numbers for one league and marks absent ones missing', () => {
  const doc = { leagues: [
    { league: 2, _run: { candidates_scored: 1, runtime_ms: 1 } },
    { league: 4, _run: { candidates_scored: 53, runtime_ms: 97918 },
      number_health: { status: 'ok', value: { broken: 2, warn: 0, ok: 5, checks: [] } } }
  ] };
  assert.deepEqual(measureFromPlans(doc, 4), { 'plans.candidates_scored': 53, 'plans.runtime_ms': 97918, 'plans.number_health_broken': 2 });
  const noHealth = { leagues: [{ league: 4, _run: { candidates_scored: 0, runtime_ms: 5 }, number_health: { status: 'unknown', reason: 'x' } }] };
  assert.equal('plans.number_health_broken' in measureFromPlans(noHealth, 4), false, 'an unknown section is not a 0');
  assert.throws(() => measureFromPlans(doc, 9), /league 9/);
});

test('ratchet moves only improved baselines and leaves the rest of the file byte-identical', () => {
  const rows = parseBenchmarks(MD);
  const cur = { 'plans.candidates_scored': 10_000 };
  const out = ratchet(MD, compare(rows, cur));
  const after = parseBenchmarks(out);
  assert.equal(after.find(r => r.id === 'plans.candidates_scored').baseline, 10_000);
  for (const r of rows.filter(x => x.id !== 'plans.candidates_scored')) {
    assert.deepEqual(after.find(x => x.id === r.id), r);
  }
  assert.equal(out.split('\n').length, MD.split('\n').length);
});

test('CLI exits 1 on a regression and 0 when every measured row holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ 'plans.candidates_scored': 0 }));
  let code = 0; let out = '';
  try { execFileSync(process.execPath, ['scripts/check-benchmarks.mjs', '--current', bad], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { code = e.status; out = e.stdout; }
  assert.equal(code, 1);
  assert.match(out, /REGRESSED plans\.candidates_scored/);
  const good = path.join(dir, 'good.json');
  // The committed baseline, read from BENCHMARKS.md (it moves on a reset), so this checks the CLI, not a number.
  const base = parseBenchmarks(MD).find(r => r.id === 'plans.candidates_scored').baseline;
  fs.writeFileSync(good, JSON.stringify({ 'plans.candidates_scored': base }));
  out = execFileSync(process.execPath, ['scripts/check-benchmarks.mjs', '--current', good], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /PASS plans\.candidates_scored/);
  assert.match(out, /NOT RUN/);
});
