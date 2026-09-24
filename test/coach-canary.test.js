/**
 * HEALTH-01e: the Coach canary.
 *
 * RED targets from ENGINE-SPECS.md: 12/12 pass on the fixture; the alert fires
 * on an injected wrong answer. Plus the parts that make it safe to run daily:
 * the cost guard stays under the in-app Coach cap, a spent cap is `partial`
 * rather than a false drift alarm, and the refresh loop runs it at most once a
 * day, off the web server.
 *
 * The dry run replaces only the model: the fixture, Coach's guarded SQL tool,
 * the ledger and the verifier are the real ones. No network, no spend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-canary-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { run, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const G = await import('../scripts/lib/coach-canary-golden.mjs');
const CANARY = await import('../scripts/coach-canary.mjs');
const LOOP = await import('../scripts/refresh-live-data.mjs');
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach } = await import('../server/services/coach/ask.js');
G.seedFixture(run);

test.after(() => { setAnthropicClientForTesting(null); fs.rmSync(temp, { recursive: true, force: true }); });

const withKey = async fn => {
  process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
  try { return await fn(); } finally { delete process.env.GRIDIRON_ANTHROPIC_API_KEY; }
};
const dryRun = opts => withKey(() => CANARY.runGolden({ golden: G.GOLDEN, askCoach,
  setClient: setAnthropicClientForTesting, ...opts }));

test('there are twelve golden questions, unique ids, one of them a refusal', () => {
  assert.equal(G.GOLDEN.length, 12);
  assert.equal(new Set(G.GOLDEN.map(g => g.id)).size, 12);
  assert.equal(G.GOLDEN.filter(g => g.expect.kind === 'refusal').length, 1);
});

test('12/12 pass on the fixture league', async () => {
  const grades = await dryRun();
  const verdict = G.canaryVerdict(grades);
  assert.equal(verdict.passed, 12, JSON.stringify(verdict.failures));
  assert.equal(verdict.status, 'ok');
});

test('the alert fires on an injected wrong number', async () => {
  const verdict = G.canaryVerdict(await dryRun({ injectWrong: 'G08' }));
  assert.equal(verdict.status, 'error');
  assert.deepEqual(verdict.failures.map(f => f.id), ['G08']);
  assert.equal(verdict.failures[0].kind, 'drift');
});

test('the alert fires on an injected wrong name, which the digit check alone would pass', async () => {
  const verdict = G.canaryVerdict(await dryRun({ injectWrong: 'G05' }));
  assert.equal(verdict.status, 'error');
  assert.match(verdict.failures[0].reason, /expected "Fixture Receiver A"/);
});

test('a fixture value that moves is drift: the golden answer is pinned, not re-read', async () => {
  run(`UPDATE player_week_usage SET passing_yards = 250 WHERE player_id = 9001 AND season = 2026 AND week = 2`);
  try {
    const verdict = G.canaryVerdict(await dryRun());
    assert.deepEqual(verdict.failures.map(f => f.id), ['G10']);
  } finally {
    run(`UPDATE player_week_usage SET passing_yards = 251 WHERE player_id = 9001 AND season = 2026 AND week = 2`);
  }
});

test('a budget refusal is partial, not drift, and stops further calls', async () => {
  const budgetError = Object.assign(new Error('budget used'), { code: 'LLM_BUDGET_EXHAUSTED' });
  let calls = 0;
  const grades = await CANARY.runGolden({ golden: G.GOLDEN, askCoach: async () => { calls++; throw budgetError; } });
  assert.equal(calls, 1, 'after the cap refuses once, no more calls are attempted');
  const verdict = G.canaryVerdict(grades);
  assert.equal(verdict.status, 'partial');
  assert.equal(verdict.budget_skipped, 12);
});

test('the refusal question answered with a number is drift, even when it also refuses', () => {
  const g12 = G.GOLDEN.find(g => g.expect.kind === 'refusal');
  const result = { answer: { claims: [{ text: 'Each manager bid 12 dollars.', cites: [] }], refusals: ['partly unknown'] },
    verification: { ok: true } };
  assert.equal(G.gradeAnswer(g12, { result }).kind, 'drift');
  const refused = { answer: { claims: [], refusals: ['Coach does not read FAAB bids.'] }, verification: { ok: true } };
  assert.equal(G.gradeAnswer(g12, { result: refused }).kind, 'pass');
});

test('a non-budget error is an alert', () => {
  const verdict = G.canaryVerdict([G.gradeAnswer(G.GOLDEN[0], { error: new Error('Request timed out.') })]);
  assert.equal(verdict.status, 'error');
  assert.equal(verdict.failures[0].kind, 'error');
});

test('the rotation covers every question and moves one step a day', () => {
  const day0 = CANARY.rotation(G.GOLDEN, new Date(Date.UTC(2026, 8, 24)));
  const day1 = CANARY.rotation(G.GOLDEN, new Date(Date.UTC(2026, 8, 25)));
  assert.equal(new Set(day0.map(g => g.id)).size, 12);
  assert.equal(day1[0].id, day0[1].id);
});

test('live mode with no key records a skipped row and spends nothing', async () => {
  const out = await CANARY.main([]);
  assert.equal(out.status, 'skipped');
  const log = row(`SELECT last_status, last_detail FROM sync_log WHERE job = 'coach_canary'`);
  assert.equal(log.last_status, 'skipped');
  assert.match(log.last_detail, /no Anthropic API key/);
});

test('cost guard: with today\'s Coach budget spent, live mode never starts a run', async () => {
  run(`INSERT INTO ai_usage (date, feature, model, input_tokens, output_tokens, cost_usd, calls)
       VALUES (date('now'), 'coach:answer', 'claude-sonnet-5', 0, 0, 1.00, 1)`);
  const out = await withKey(() => CANARY.main([]));
  assert.equal(out.status, 'skipped');
  assert.match(out.reason, /no allowance/);
  assert.ok(CANARY.CANARY_MAX_USD <= 1.00, 'the canary ceiling sits under the default Coach cap');
});

test('CLI --dry-run exits 0 on 12/12 and 1 with the alert on an injected wrong answer', () => {
  const env = { ...process.env, GRIDIRON_DB_PATH: '' };
  const cli = args => spawnSync(process.execPath, ['scripts/coach-canary.mjs', '--dry-run', ...args],
    { cwd: REPO, env, encoding: 'utf8', timeout: 120_000 });
  const clean = cli([]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout.trim().split('\n').at(-1)).passed, 12);
  const drift = cli(['--inject-wrong', 'G03']);
  assert.equal(drift.status, 1);
  assert.equal(JSON.parse(drift.stdout.trim().split('\n').at(-1)).failures[0].id, 'G03');
});

// ---------------------------------------------------------------- the daily refresh-loop step

const fakeSpawn = result => {
  const calls = [];
  return { calls, spawn: (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: '{}', stderr: '', ...result }; } };
};
const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();

test('loop step: runs the canary with node from the repo when it has never run', () => {
  const { spawn, calls } = fakeSpawn();
  LOOP.createCoachCanaryStep({ spawn, log: () => {}, lastRunAt: () => null })();
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ['--env-file-if-exists=.env', 'scripts/coach-canary.mjs']);
});

test('loop step: at most once a day — a run 3 h ago is skipped, 25 h ago runs', () => {
  const recent = fakeSpawn();
  assert.deepEqual(LOOP.createCoachCanaryStep({ spawn: recent.spawn, log: () => {}, lastRunAt: () => hoursAgo(3) })(), { skipped: true });
  assert.equal(recent.calls.length, 0);
  const old = fakeSpawn();
  LOOP.createCoachCanaryStep({ spawn: old.spawn, log: () => {}, lastRunAt: () => hoursAgo(25) })();
  assert.equal(old.calls.length, 1);
});

test('loop step: a canary that cannot start is recorded as an error row, and drift is logged as DRIFT', () => {
  const records = [];
  const dead = fakeSpawn({ status: null, error: new Error('spawn ENOENT') });
  LOOP.createCoachCanaryStep({ spawn: dead.spawn, log: () => {}, lastRunAt: () => null,
    record: (...a) => records.push(a) })();
  assert.equal(records[0][0], 'coach_canary');
  assert.equal(records[0][1], 'error');

  const lines = [];
  const drift = fakeSpawn({ status: 1, stdout: '{"status":"error"}' });
  LOOP.createCoachCanaryStep({ spawn: drift.spawn, log: l => lines.push(l), lastRunAt: () => null })();
  assert.match(lines[0], /coach_canary\s+DRIFT/);
});
