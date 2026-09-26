/**
 * PERF BUDGETS (plan item 57): a PR that grows any of the seven area routes' first-load bytes by
 * more than 10% over perf-budgets.json fails CI. These tests hold the check itself to its
 * pre-registered bar (B1-B6 in the PR body) on fixture manifests, so no build is needed here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  areasFromSource, routeAssets, measureAreas, compareBudgets, BUDGET_PCT
} from '../scripts/perf-budgets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A tiny build: entry pulls shared + css; pageA pulls shared (again) and its own css; pageB is alone.
const MANIFEST = {
  'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'], css: ['assets/index.css'],
    dynamicImports: ['src/pages/A.tsx', 'src/pages/B.tsx'] },
  '_shared.js': { file: 'assets/shared.js' },
  'src/pages/A.tsx': { file: 'assets/A.js', isDynamicEntry: true, imports: ['index.html', '_shared.js', '_deep.js'], css: ['assets/A.css'] },
  '_deep.js': { file: 'assets/deep.js', imports: ['_shared.js'] },
  'src/pages/B.tsx': { file: 'assets/B.js', isDynamicEntry: true, imports: ['index.html'], dynamicImports: ['src/pages/A.tsx'] },
};

test('B1: the seven areas come from navigation.ts and App.tsx, each with its lazy page file', () => {
  const areas = areasFromSource(read('client/src/App.tsx'), read('client/src/navigation.ts'));
  assert.deepEqual(areas.map(a => a.path), ['/', '/trades', '/my-team', '/league', '/players', '/draft', '/settings']);
  for (const a of areas) {
    assert.match(a.src, /^src\/pages\/\w+\.tsx$/, `${a.path} has no lazy page`);
    assert.ok(fs.existsSync(path.join(ROOT, 'client', a.src)), `${a.src} missing`);
  }
});

test('B1: an area whose route has no lazy page is an error, never silently skipped', () => {
  assert.throws(() => areasFromSource(
    "const A = lazy(() => import('./pages/A'));\n<Route path=\"/a\" element={<A />} />",
    "export const NAV_GROUPS = [{ items: [ { to: '/a' }, { to: '/zzz' } ] }];"), /\/zzz/);
});

test('B2: first-load assets are the entry closure plus the page closure, each file once, dynamic imports excluded', () => {
  const files = routeAssets(MANIFEST, 'src/pages/A.tsx');
  assert.deepEqual([...files].sort(), ['assets/A.css', 'assets/A.js', 'assets/deep.js', 'assets/index.css', 'assets/index.js', 'assets/shared.js']);
  const b = routeAssets(MANIFEST, 'src/pages/B.tsx');
  assert.ok(!b.has('assets/A.js'), 'a dynamic import is not first-load');
  assert.throws(() => routeAssets(MANIFEST, 'src/pages/Nope.tsx'), /Nope/);
});

test('B2: measured bytes sum each file once, raw and gzip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-budgets-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  for (const f of ['index.js', 'shared.js', 'deep.js', 'A.js', 'B.js', 'index.css', 'A.css']) fs.writeFileSync(path.join(dir, 'assets', f), 'x'.repeat(100));
  const m = measureAreas(MANIFEST, [{ area: 'A', path: '/a', src: 'src/pages/A.tsx' }], dir);
  assert.equal(m['/a'].raw, 600);
  assert.ok(m['/a'].gzip > 0 && m['/a'].gzip < 600);
  assert.equal(m['/a'].files, 6);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B3: exactly +10% passes, anything over fails; shrinking reports improved', () => {
  assert.equal(BUDGET_PCT, 10);
  const base = { '/a': { gzip: 1000 }, '/b': { gzip: 1000 }, '/c': { gzip: 1000 } };
  const r = compareBudgets(base, { '/a': { gzip: 1100 }, '/b': { gzip: 1101 }, '/c': { gzip: 900 } });
  assert.deepEqual(r.map(x => [x.path, x.status]), [['/a', 'pass'], ['/b', 'over'], ['/c', 'improved']]);
  assert.equal(r.find(x => x.path === '/b').pct, 10.1);
});

test('B4: an area with no baseline, or a baseline area that vanished, fails loudly', () => {
  const r = compareBudgets({ '/a': { gzip: 1000 }, '/gone': { gzip: 5 } }, { '/a': { gzip: 1000 }, '/new': { gzip: 7 } });
  const s = Object.fromEntries(r.map(x => [x.path, x.status]));
  assert.deepEqual(s, { '/a': 'pass', '/new': 'unbudgeted', '/gone': 'missing' });
});

test('B5: the committed baseline budgets exactly the seven areas', () => {
  const doc = JSON.parse(read('perf-budgets.json'));
  const areas = areasFromSource(read('client/src/App.tsx'), read('client/src/navigation.ts'));
  assert.deepEqual(Object.keys(doc.areas).sort(), areas.map(a => a.path).sort());
  for (const [p, v] of Object.entries(doc.areas)) assert.ok(Number.isInteger(v.gzip) && v.gzip > 0, `${p} gzip`);
  assert.equal(doc.budget_pct, BUDGET_PCT);
});

test('B6: the CLI exits 1 on a breach under GRIDIRON_PERF_BUDGETS=enforce, 0 in report mode, 2 without a manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-budgets-cli-'));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.vite'));
  fs.writeFileSync(path.join(dir, '.vite', 'manifest.json'), JSON.stringify(MANIFEST));
  for (const f of ['index.js', 'shared.js', 'deep.js', 'A.js', 'B.js', 'index.css', 'A.css']) fs.writeFileSync(path.join(dir, 'assets', f), 'x'.repeat(100));
  const areas = [{ area: 'A', path: '/a', src: 'src/pages/A.tsx' }];
  fs.writeFileSync(path.join(dir, 'areas.json'), JSON.stringify(areas));
  const baseline = path.join(dir, 'budgets.json');
  const script = path.join(ROOT, 'scripts/perf-budgets.mjs');
  const run = (env, extra = []) => spawnSync(process.execPath, [script, '--dist', dir, '--areas', path.join(dir, 'areas.json'), '--baseline', baseline, ...extra],
    { encoding: 'utf8', env: { ...process.env, GRIDIRON_PERF_BUDGETS: env } });

  let r = run('enforce', ['--update']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.status, 0);
  r = run('enforce');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PASS \/a/);

  // Grow A.js with incompressible bytes: well past +10% gzip.
  fs.writeFileSync(path.join(dir, 'assets', 'A.js'), Array.from({ length: 4000 }, (_, i) => (i * 7919 % 10007).toString(36)).join(''));
  r = run('enforce');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /OVER \/a/);
  r = run('');
  assert.equal(r.status, 0, 'report mode never fails the build');
  assert.match(r.stdout, /report only/);

  fs.rmSync(path.join(dir, '.vite'), { recursive: true });
  r = run('enforce');
  assert.equal(r.status, 2, r.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the build writes the manifest the check reads', () => {
  assert.match(read('client/vite.config.ts'), /manifest:\s*true/);
});

test('long tasks: the longest task per area over runs, judged against 50 ms', async () => {
  const { verdicts, LONGTASK_BUDGET_MS } = await import('../scripts/perf-longtasks.mjs');
  assert.equal(LONGTASK_BUDGET_MS, 50);
  const run = tasks => [{ path: '/a', area: 'A', tasks }, { path: '/b', area: 'B', tasks: [] }];
  const v = verdicts([run([{ start: 1, duration: 51 }]), run([{ start: 2, duration: 20 }, { start: 3, duration: 50 }])]);
  assert.deepEqual(v.map(x => [x.path, x.max_ms, x.count, x.runs, x.status]), [['/a', 51, 3, 2, 'over'], ['/b', 0, 0, 2, 'pass']]);
  assert.equal(verdicts([run([{ start: 1, duration: 50 }])])[0].status, 'pass', 'exactly 50 ms is within budget');
});

test('long tasks: CHROME_PATH wins; the probe fails loudly on a blind observer or a missed click', async () => {
  const { findChrome } = await import('../scripts/perf-longtasks.mjs');
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-')), 'chrome');
  fs.writeFileSync(fake, '');
  assert.equal(findChrome({ CHROME_PATH: fake }), fake);
  const src = fs.readFileSync(path.join(ROOT, 'scripts/perf-longtasks.mjs'), 'utf8');
  assert.match(src, /canary/i, 'a blind observer must fail the probe, not report zeros');
  assert.match(src, /landed on/, 'a click that does not reach the area must fail the probe');
});
