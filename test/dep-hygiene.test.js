// DEP-HYGIENE (batch D item 39): "npm audit / outdated report; upgrade only with tests green."
// Everything here runs on inline npm JSON and an injected command runner: no registry, no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyAudit, classifyOutdated, upgradePlan, bumpKind, applyEnabled, applyUpgrades,
  renderReport, GATES
} from '../scripts/dep-hygiene.mjs';

// npm 10 `npm audit --json` shape, trimmed. qs/nanoid are transitive; express is direct.
const audit = () => ({
  auditReportVersion: 2,
  vulnerabilities: {
    express: { name: 'express', severity: 'moderate', isDirect: true, via: ['qs'], range: '4.22.2', nodes: ['node_modules/express'], fixAvailable: true },
    qs: { name: 'qs', severity: 'moderate', isDirect: false, via: [
      { source: 1, title: 'qs DoS', url: 'https://github.com/advisories/GHSA-a', severity: 'moderate', range: '<6.16.0' }
    ], range: '2.2.5 - 6.15.3', nodes: ['node_modules/qs'], fixAvailable: true },
    nanoid: { name: 'nanoid', severity: 'high', isDirect: false, via: [
      { source: 2, title: 'nanoid loop', url: 'https://github.com/advisories/GHSA-b', severity: 'high', range: '<3.3.18' }
    ], range: '<3.3.18', nodes: ['node_modules/nanoid'], fixAvailable: true },
    vite: { name: 'vite', severity: 'low', isDirect: true, via: [
      { source: 3, title: 'vite thing', url: 'https://github.com/advisories/GHSA-c', severity: 'low', range: '<7.0.0' }
    ], range: '<7.0.0', nodes: ['node_modules/vite'], fixAvailable: { name: 'vite', version: '7.1.0', isSemVerMajor: true } },
    leftpad: { name: 'leftpad', severity: 'critical', isDirect: false, via: [
      { source: 4, title: 'no fix', url: 'https://github.com/advisories/GHSA-d', severity: 'critical', range: '*' }
    ], range: '*', nodes: ['node_modules/leftpad'], fixAvailable: false }
  },
  metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 1, critical: 1, total: 5 } }
});

const lock = () => ({
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/express': {},
    'node_modules/qs': {},
    'node_modules/nanoid': { dev: true },
    'node_modules/vite': { dev: true },
    'node_modules/leftpad': { devOptional: true }
  }
});

const pkg = () => ({
  dependencies: { express: '^4.21.0', ai: '^7.0.105', '@anthropic-ai/sdk': '^0.39.0' },
  devDependencies: { 'fast-check': '4.9.0', vite: '^6.0.0', postcss: '^8.4.49' }
});

const outdated = () => ({
  express: { current: '4.22.2', wanted: '4.22.3', latest: '5.2.1' },
  ai: { current: '7.0.105', wanted: '7.0.116', latest: '7.0.116' },
  '@anthropic-ai/sdk': { current: '0.39.0', wanted: '0.39.0', latest: '0.128.0' },
  'fast-check': { current: '4.9.0', wanted: '4.9.0', latest: '4.10.2' },
  vite: { current: '6.4.3', wanted: '6.4.3', latest: '8.3.1' },
  postcss: { current: '8.5.24', wanted: '8.5.28', latest: '8.5.28' }
});

test('B1: every advisory is classified by severity, prod/dev, direct/transitive and fix kind', () => {
  const a = classifyAudit(audit(), lock());
  assert.equal(a.available, true);
  const by = Object.fromEntries(a.rows.map(r => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), ['express', 'leftpad', 'nanoid', 'qs', 'vite']);
  assert.deepEqual([by.express.scope, by.express.direct, by.express.fix], ['prod', true, 'in-range']);
  assert.deepEqual([by.qs.scope, by.qs.direct, by.qs.fix], ['prod', false, 'in-range']);
  assert.deepEqual([by.nanoid.scope, by.nanoid.severity, by.nanoid.fix], ['dev', 'high', 'in-range']);
  assert.deepEqual([by.vite.fix, by.vite.fix_to], ['major', 'vite@7.1.0']);
  assert.deepEqual([by.leftpad.fix, by.leftpad.scope], ['none', 'dev']);
  // Advisory ids and links come from the `via` objects; a string `via` is a pointer, not an advisory.
  assert.deepEqual(by.express.advisories, []);
  assert.deepEqual(by.express.via, ['qs']);
  assert.equal(by.qs.advisories[0].url, 'https://github.com/advisories/GHSA-a');
  assert.deepEqual(a.counts, { critical: 1, high: 1, moderate: 2, low: 1, info: 0, total: 5 });
  assert.deepEqual(a.prod_counts, { critical: 0, high: 0, moderate: 2, low: 0, info: 0, total: 2 });
  // Most severe first.
  assert.deepEqual(a.rows.map(r => r.name), ['leftpad', 'nanoid', 'express', 'qs', 'vite']);
});

test('B6: an audit that could not run is "unavailable" with its cause, never zero advisories', () => {
  for (const [raw, cause] of [
    [null, /no output/],
    ['not json', /not JSON/],
    [{ error: { code: 'ENOTFOUND', summary: 'request to registry failed' } }, /ENOTFOUND/],
    [{ message: 'weird' }, /no vulnerabilities map/]
  ]) {
    const a = classifyAudit(raw, lock());
    assert.equal(a.available, false);
    assert.match(a.reason, cause);
    assert.equal(a.counts, null);
    assert.match(renderReport({ audit: a, outdated: classifyOutdated(outdated(), pkg(), lock()) }), /Audit unavailable/);
  }
});

test('B2: outdated rows carry bump kind, in-range update and exact pins', () => {
  assert.equal(bumpKind('4.22.2', '4.22.3'), 'patch');
  assert.equal(bumpKind('7.0.105', '7.1.0'), 'minor');
  assert.equal(bumpKind('4.22.2', '5.2.1'), 'major');
  assert.equal(bumpKind('0.39.0', '0.128.0'), 'major'); // 0.x minor is breaking under ^
  assert.equal(bumpKind('1.2.3', '1.2.3'), 'none');
  assert.equal(bumpKind('1.2.3-beta.1', '1.2.3'), 'patch');
  const o = classifyOutdated(outdated(), pkg(), lock());
  const by = Object.fromEntries(o.rows.map(r => [r.name, r]));
  assert.deepEqual([by.express.in_range, by.express.latest_bump, by.express.scope], [true, 'major', 'prod']);
  assert.deepEqual([by.ai.in_range, by.ai.latest_bump], [true, 'patch']);
  assert.deepEqual([by['fast-check'].pinned, by['fast-check'].in_range], [true, false]);
  assert.deepEqual([by.vite.in_range, by.vite.latest_bump, by.vite.scope], [false, 'major', 'dev']);
  assert.equal(by['@anthropic-ai/sdk'].in_range, false);
});

test('B5: the plan applies only in-range updates; majors and exact pins are listed, never applied', () => {
  const plan = upgradePlan(classifyOutdated(outdated(), pkg(), lock()), classifyAudit(audit(), lock()));
  assert.deepEqual(plan.update, ['ai', 'express', 'postcss']);
  assert.equal(plan.audit_fix, true); // qs / nanoid are transitive and fixable in range
  const skip = Object.fromEntries(plan.skip.map(s => [s.name, s.reason]));
  assert.equal(skip['fast-check'], 'pinned');
  assert.equal(skip.vite, 'major');
  assert.equal(skip['@anthropic-ai/sdk'], 'major');
  assert.equal(skip.leftpad, 'no fix');
  // A plan without a fixable advisory skips `npm audit fix` entirely.
  const clean = upgradePlan(classifyOutdated(outdated(), pkg(), lock()), classifyAudit({ vulnerabilities: {} }, lock()));
  assert.equal(clean.audit_fix, false);
});

test('B3: the flag gates --apply; anything but "on" is a dry run', () => {
  assert.equal(applyEnabled({}), false);
  assert.equal(applyEnabled({ GRIDIRON_DEP_HYGIENE: '1' }), false);
  assert.equal(applyEnabled({ GRIDIRON_DEP_HYGIENE: 'off' }), false);
  assert.equal(applyEnabled({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(applyEnabled({ GRIDIRON_DEP_HYGIENE: 'on' }), true);
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-hygiene-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","dependencies":{"express":"^4.21.0"}}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"v":"before"}\n');
  return dir;
}

// A fake npm: `update` and `audit fix` rewrite the lock; gates pass unless listed in `fail`.
function fakeRunner(dir, { fail = [] } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    if (args[0] === 'update' || (args[0] === 'audit' && args[1] === 'fix')) {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), `{"lockfileVersion":3,"v":"after ${calls.length}"}\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (fail.some(f => line.includes(f))) return { status: 1, stdout: '', stderr: `boom in ${line}` };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const PLAN = { update: ['express'], audit_fix: true, skip: [] };

test('B4: a failing gate restores package.json and package-lock.json byte-equal and says which gate', () => {
  const dir = sandbox();
  const before = ['package.json', 'package-lock.json'].map(f => fs.readFileSync(path.join(dir, f)));
  const { run, calls } = fakeRunner(dir, { fail: ['run lint'] });
  const r = applyUpgrades({ cwd: dir, plan: PLAN, run });
  assert.equal(r.ok, false);
  assert.equal(r.failed_gate, 'lint');
  assert.match(r.detail, /boom in npm run lint/);
  assert.equal(r.restored, true);
  const after = ['package.json', 'package-lock.json'].map(f => fs.readFileSync(path.join(dir, f)));
  assert.deepEqual(after, before);
  // Upgrade, audit fix without --force, gates up to the failing one, then a clean reinstall.
  assert.deepEqual(calls, ['npm update express', 'npm audit fix', 'npm run typecheck', 'npm run lint', 'npm ci']);
  assert.ok(!calls.some(c => c.includes('--force')));
});

test('B4: green gates keep the upgrade; every gate runs in order', () => {
  const dir = sandbox();
  const { run, calls } = fakeRunner(dir);
  const r = applyUpgrades({ cwd: dir, plan: PLAN, run });
  assert.equal(r.ok, true);
  assert.equal(r.restored, false);
  assert.match(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), /after/);
  assert.deepEqual(calls.slice(2), GATES.map(g => ['npm', ...g.args].join(' ')));
  assert.deepEqual(GATES.map(g => g.name), ['typecheck', 'lint', 'check:wiring', 'test', 'build']);
});

test('B4: a failing npm update restores too, and an empty plan runs nothing', () => {
  const dir = sandbox();
  const before = fs.readFileSync(path.join(dir, 'package-lock.json'));
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'update') {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), 'half written');
      return { status: 1, stdout: '', stderr: 'ETARGET' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = applyUpgrades({ cwd: dir, plan: PLAN, run });
  assert.equal(r.ok, false);
  assert.equal(r.failed_gate, 'npm update');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'package-lock.json')), before);
  assert.deepEqual(calls, ['npm update express', 'npm ci']);

  const idle = applyUpgrades({ cwd: dir, plan: { update: [], audit_fix: false, skip: [] }, run: () => { throw new Error('ran'); } });
  assert.deepEqual([idle.ok, idle.nothing_to_do], [true, true]);
});

test('report names counts, the plan and the skips, and never a local path', () => {
  const a = classifyAudit(audit(), lock());
  const o = classifyOutdated(outdated(), pkg(), lock());
  const md = renderReport({ audit: a, outdated: o, plan: upgradePlan(o, a) });
  assert.match(md, /5 advisories: 1 critical, 1 high, 2 moderate, 1 low/);
  assert.match(md, /Runtime \(prod\): 2 moderate/);
  assert.match(md, /\| nanoid \| high \| dev \| transitive \| in range \|/);
  assert.match(md, /npm update ai express postcss/);
  assert.match(md, /fast-check.*pinned/);
  assert.doesNotMatch(md, /node_modules|\/home\/|\/Users\//);
});
