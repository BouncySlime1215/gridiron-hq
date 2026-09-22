import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Text-level checks on the deploy workflow and the Docker build context. No
// YAML parser is a direct dependency here, so these read the files as text;
// the real proof that the image builds and boots is the docker run recorded in
// docs/tdd/deploy-workflow.tdd.md, not this file.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(root, '.github/workflows/deploy.yml');
const read = (p) => fs.readFileSync(p, 'utf8');

const indentOf = (line) => line.match(/^ */)[0].length;
const isTopLevelKey = (line) => /^["']?[A-Za-z_][\w-]*["']?:/.test(line);

function blockUnder(lines, key) {
  const start = lines.findIndex((l) => new RegExp(`^["']?${key}["']?:`).test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isTopLevelKey(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

const childKeys = (block, indent) => block
  .filter((l) => indentOf(l) === indent && /^\s*[\w-]+:/.test(l))
  .map((l) => l.trim().split(':')[0]);

function steps(lines) {
  const starts = [];
  lines.forEach((l, i) => { if (/^\s*- (name|uses|run):/.test(l)) starts.push(i); });
  return starts.map((s, n) => lines.slice(s, n + 1 < starts.length ? starts[n + 1] : lines.length));
}

function runScript(step) {
  const i = step.findIndex((l) => /^\s*(- )?run:/.test(l));
  if (i === -1) return '';
  const inline = step[i].replace(/^\s*(- )?run:\s*/, '');
  if (inline && !/^[|>][-+]?$/.test(inline)) return inline;
  const keyIndent = indentOf(step[i].replace('- ', '  '));
  const body = [];
  for (let j = i + 1; j < step.length; j++) {
    if (step[j].trim() && indentOf(step[j]) <= keyIndent) break;
    body.push(step[j]);
  }
  return body.join('\n');
}

function loadWorkflow() {
  assert.ok(fs.existsSync(workflowPath), '.github/workflows/deploy.yml exists');
  const text = read(workflowPath);
  return { text, lines: text.split('\n') };
}

test('deploy runs only when someone presses the button, never on push or on a timer', () => {
  const { lines } = loadWorkflow();
  const on = blockUnder(lines, 'on');
  assert.ok(on, 'workflow has an on: block');
  assert.deepEqual(childKeys(on, 2), ['workflow_dispatch']);
});

test('one job, with a timeout', () => {
  const { lines } = loadWorkflow();
  const jobs = blockUnder(lines, 'jobs');
  assert.equal(childKeys(jobs, 2).length, 1, 'exactly one job');
  const t = jobs.map((l) => l.match(/^\s+timeout-minutes:\s*(\d+)\s*$/)).find(Boolean);
  assert.ok(t, 'timeout-minutes is set on the job');
  assert.ok(Number(t[1]) > 0 && Number(t[1]) <= 60, `timeout-minutes ${t[1]} is between 1 and 60`);
});

test('the first step names the commit being deployed', () => {
  const { lines } = loadWorkflow();
  const first = steps(blockUnder(lines, 'jobs'))[0].join('\n');
  assert.match(first, /github\.sha/);
});

test('brake re-asserted before the deploy, confirmation read after, and never released here', () => {
  const { text, lines } = loadWorkflow();
  const all = steps(blockUnder(lines, 'jobs')).map((s) => s.join('\n'));
  const at = (re) => all.findIndex((s) => re.test(s));
  const brake = at(/secrets set SCHEDULER_DISABLED=1\b/);
  const deploy = at(/flyctl deploy\b/);
  const confirm = at(/Scheduler disabled/);
  assert.ok(brake !== -1, 'a step sets SCHEDULER_DISABLED=1');
  assert.ok(deploy !== -1, 'a step runs flyctl deploy');
  assert.ok(confirm !== -1, 'a step looks for the "Scheduler disabled" line');
  assert.ok(brake < deploy, 'brake is set before the deploy');
  assert.ok(deploy < confirm, 'confirmation is read after the deploy');
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /secrets\s+unset/, 'releasing the brake is not this workflow\'s job');
});

test('the deploy is remote-only, against the right app, through flyctl-actions', () => {
  const { text, lines } = loadWorkflow();
  const deploy = steps(blockUnder(lines, 'jobs')).map((s) => s.join('\n')).find((s) => /flyctl deploy\b/.test(s));
  assert.match(deploy, /--remote-only/);
  // Not \b: a hyphen is a word boundary, so \b would accept gridiron-hq-staging.
  assert.match(deploy, /(-a|--app)\s+gridiron-hq(\s|$)/);
  assert.match(text, /uses:\s*superfly\/flyctl-actions\/setup-flyctl@/);
});

test('the Fly token only ever reaches a step through env, never a script', () => {
  const { lines } = loadWorkflow();
  for (const l of lines.filter((x) => x.includes('secrets.'))) {
    assert.match(l, /^\s+FLY_API_TOKEN:\s*\$\{\{\s*secrets\.FLY_API_TOKEN\s*\}\}\s*$/, `secret reference outside an env mapping: ${l.trim()}`);
  }
  for (const [n, s] of steps(blockUnder(lines, 'jobs')).entries()) {
    const script = runScript(s);
    assert.doesNotMatch(script, /\$\{\{/, `step ${n + 1} interpolates an expression straight into its script; pass it through env`);
    assert.doesNotMatch(script, /FLY_API_TOKEN/, `step ${n + 1} names the token in its script`);
    assert.doesNotMatch(script, /set -[a-z]*x/, `step ${n + 1} turns on shell tracing`);
  }
});

// Docker .dockerignore patterns are anchored at the context root, unlike
// .gitignore: `node_modules` does not match `server/node_modules`.
function dockerIgnored(patterns, p) {
  let ignored = false;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const pat = (neg ? raw.slice(1) : raw).replace(/^\/+|\/+$/g, '');
    const re = new RegExp('^' + pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '(?:.*/)?') + '(?:/.*)?$');
    if (re.test(p)) ignored = !neg;
  }
  return ignored;
}

function dockerignorePatterns() {
  return read(path.join(root, '.dockerignore')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

test('the build context leaves out what the image never runs', () => {
  const pats = dockerignorePatterns();
  for (const p of ['data', 'data/nflverse.sqlite', 'analysis', 'test', 'test/deploy-workflow.test.js', 'research',
    'server/local.sqlite', 'server/data.sqlite.pre-migration-1.bak', 'server/node_modules/x', 'docs']) {
    assert.ok(dockerIgnored(pats, p), `${p} is excluded from the build context`);
  }
});

test('the build context keeps everything the Dockerfile copies or builds from', () => {
  const pats = dockerignorePatterns();
  const sources = read(path.join(root, 'Dockerfile')).split('\n')
    .filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1))
    .filter((s) => s !== '.')
    .map((s) => s.replace(/\*$/, ''));
  assert.ok(sources.includes('server') && sources.includes('scripts'), `Dockerfile COPY sources read: ${sources}`);
  // server/data/ is runtime data the server reads; only the top-level data/ goes.
  for (const p of [...sources, 'client/src/main.tsx', 'client/vite.config.ts', 'client/index.html', 'server/index.js',
    'server/data/nfl-ensemble-rank.json', 'server/data/research/market-correction-lookup.json']) {
    assert.ok(!dockerIgnored(pats, p), `${p} stays in the build context`);
  }
});
