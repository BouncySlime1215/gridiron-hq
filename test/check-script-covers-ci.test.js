/**
 * WHAT CI GATES ON AND WHAT THE PRE-PUSH GUARD RUNS HAVE TO BE THE SAME SET.
 *
 * PR #108 went red on a gate that had passed locally twice, on the same commit,
 * under a guard whose whole job is to say the tree is clean. `npm run check`
 * was `typecheck && lint && test && build && start:smoke`; `check:wiring` was a
 * CI step and nothing else. So the guard could close clean while the thing CI
 * would refuse the branch for had never been run.
 *
 * The instance is one missing script. The CLASS is that ci.yml and the `check`
 * aggregate are two hand-maintained lists of the same thing, and nothing
 * compares them — every future step added to one and not the other reopens this
 * exactly. So this reads the workflow and asks the question of every script it
 * invokes, rather than asserting the one name that was missing today.
 *
 * Note what this does NOT say: CI never runs `npm run check` itself. It runs
 * each script as its own step, which is what gives a reader the failing step by
 * name. `check` is the local stand-in for that list, so the workflow's steps are
 * the source of truth here and `check` is what has to keep up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** The scripts a `run:` line invokes. `npm ci` is an install, not a script. */
export function scriptsInvoked(yaml) {
  const out = new Set();
  for (const line of yaml.split('\n')) {
    const m = /^\s*-?\s*run:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    for (const cmd of m[1].split('&&')) {
      const run = /^\s*npm\s+run\s+([\w:-]+)/.exec(cmd);
      if (run) { out.add(run[1]); continue; }
      if (/^\s*npm\s+test\b/.test(cmd)) out.add('test');
    }
  }
  return out;
}

/** Every script `name` reaches, following `npm run` inside script bodies. */
export function expand(scripts, name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  const body = scripts[name];
  if (!body) return seen;
  for (const m of body.matchAll(/npm\s+run\s+([\w:-]+)/g)) expand(scripts, m[1], seen);
  if (/\bnpm\s+test\b/.test(body)) expand(scripts, 'test', seen);
  return seen;
}

test('the workflow invokes scripts, and they all exist', () => {
  const invoked = scriptsInvoked(workflow);
  assert.ok(invoked.size >= 5, `expected the workflow to invoke several scripts, found ${invoked.size}`);
  const missing = [...invoked].filter(s => !pkg.scripts[s]);
  assert.deepEqual(missing, [], 'ci.yml names a script package.json does not define');
});

test('npm run check runs everything CI gates on', () => {
  const invoked = scriptsInvoked(workflow);
  const covered = expand(pkg.scripts, 'check');
  const uncovered = [...invoked].filter(s => !covered.has(s)).sort();
  assert.deepEqual(uncovered, [],
    `CI gates on ${uncovered.join(', ')} and \`npm run check\` does not run ${uncovered.length === 1 ? 'it' : 'them'}, `
    + 'so a clean guard run says nothing about it');
});

test('expand follows npm run through a script body, not just the top level', () => {
  const scripts = { a: 'npm run b', b: 'npm run c', c: 'echo done' };
  assert.deepEqual([...expand(scripts, 'a')].sort(), ['a', 'b', 'c']);
});

test('expand terminates on a cycle rather than recursing forever', () => {
  const scripts = { a: 'npm run b', b: 'npm run a' };
  assert.deepEqual([...expand(scripts, 'a')].sort(), ['a', 'b']);
});

test('npm test in a workflow step counts as the test script', () => {
  assert.ok(scriptsInvoked('      - run: npm test\n').has('test'));
});

test('npm ci is an install and is not read as a script', () => {
  assert.deepEqual([...scriptsInvoked('      - run: npm ci\n')], []);
});

test('a chained run line contributes every script on it', () => {
  const got = scriptsInvoked('      - run: npm run lint && npm run check:wiring\n');
  assert.deepEqual([...got].sort(), ['check:wiring', 'lint']);
});
