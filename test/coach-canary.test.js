/**
 * HEALTH-01e: the Coach canary.
 *
 * RED targets from ENGINE-SPECS.md: 12/12 pass on the fixture; the alert fires
 * on an injected wrong answer. Plus the parts that make it safe to run daily:
 * the cost guard stays under the in-app Coach cap, a spent cap is `partial`
 * rather than a false drift alarm, and the engine daemon's morning hook runs it
 * at most once a day, off the web server, and routes an 'error' to the user
 * (one engine status row + one push through PUSH-01's sender, no chat text).
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
const DAEMON = await import('../scripts/engine-daemon.mjs');
const HOOKS = await import('../server/services/engine/daemon/hooks.js');
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

// ---------------------------------------------------------------- the daemon's morning hook

const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();
const asRole = async (role, fn) => {
  const before = process.env.GRIDIRON_PROCESS_ROLE;
  process.env.GRIDIRON_PROCESS_ROLE = role;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.GRIDIRON_PROCESS_ROLE; else process.env.GRIDIRON_PROCESS_ROLE = before;
  }
};
const statusRows = () => HOOK_DB().prepare(`SELECT error FROM engine_runs WHERE producer = ? AND scope_key = 'health' ORDER BY id`)
  .all(CANARY.CANARY_STATUS_PRODUCER);
const { db: HOOK_DB_HANDLE } = await import('../server/db/index.js');
const HOOK_DB = () => HOOK_DB_HANDLE;

test('hook: at most once a day — a run 3 h ago is fresh and asks nothing; 25 h ago proceeds', async () => {
  assert.equal(CANARY.canaryAge(hoursAgo(3)).fresh, true);
  assert.equal(CANARY.canaryAge(hoursAgo(25)).fresh, false);
  assert.equal(CANARY.canaryAge(null).fresh, false, 'never run: due');
  const fresh = await withKey(() => CANARY.runLive([], { guard: true, lastRunAt: async () => hoursAgo(3) }));
  assert.equal(fresh.status, 'fresh', 'guarded before the key, the budget or the child');
  const due = await CANARY.runLive([], { guard: true, lastRunAt: async () => hoursAgo(25) });
  assert.equal(due.status, 'skipped', 'past the guard: here it stops at the missing key, spending nothing');
});

test('hook: the child writes nothing — runLive returns the verdict and the real DB is untouched', async () => {
  const before = row(`SELECT runs, last_run_at FROM sync_log WHERE job = 'coach_canary'`);
  const out = await CANARY.runLive([], { guard: true, lastRunAt: async () => null });
  assert.equal(out.status, 'skipped');
  assert.deepEqual(row(`SELECT runs, last_run_at FROM sync_log WHERE job = 'coach_canary'`), before);
});

test('daemon hook: the canary is registered on the morning (nightly) schedule, as coach-canary.mjs --hook', async () => {
  const seen = [];
  await DAEMON.registerCoachCanaryHook({ registerHook: (schedule, spec) => { seen.push({ schedule, spec }); return () => {}; },
    database: HOOK_DB(), push: { send: null, why: 'test' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].schedule, 'nightly');
  assert.equal(seen[0].spec.name, 'coach-canary');
  assert.equal(path.relative(REPO, seen[0].spec.command[0]), path.join('scripts', 'coach-canary.mjs'));
  assert.deepEqual(seen[0].spec.command.slice(1), ['--hook']);
  assert.ok(seen[0].spec.leaseMs > 15 * 60_000, 'the lease outlives the canary child\'s own 15 min timeout');
});

test('daemon hook: an injected wrong answer -> one status row and one push call, with no chat text', async () => {
  // The verdict the hook child would print, from the real dry run with G03 made wrong.
  const drift = spawnSync(process.execPath, ['scripts/coach-canary.mjs', '--dry-run', '--inject-wrong', 'G03'],
    { cwd: REPO, env: { ...process.env, GRIDIRON_DB_PATH: '' }, encoding: 'utf8', timeout: 120_000 });
  const verdict = JSON.parse(drift.stdout.trim().split('\n').at(-1));
  assert.equal(verdict.status, 'error');
  // The failure reason is Coach's own words: its refusal, quoting the wrong number it could not trace.
  const chatText = verdict.failures[0].reason;
  const chatNumbers = chatText.match(/\d+\.\d+/g) ?? [];
  assert.ok(chatNumbers.length, `control: the failure reason quotes a number from Coach's answer (${chatText})`);

  const pushes = [];
  const send = async msg => { pushes.push(msg); return { channel: 'test' }; };
  const unregister = await DAEMON.registerCoachCanaryHook({ registerHook: HOOKS.registerHook, database: HOOK_DB(),
    push: { send, why: null } });
  // The real hook runner: its child prints the verdict line, as coach-canary.mjs --hook does.
  const { spawn: nodeSpawn } = await import('node:child_process');
  const spawned = [];
  const fakeSpawn = (bin, command, opts) => {
    spawned.push(command);
    return nodeSpawn(bin, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(verdict))} + '\\n')`], opts);
  };
  const others = HOOKS.listHooks('nightly').filter(h => h.name !== 'coach-canary');
  assert.deepEqual(others, [], 'control: only the canary is registered in this process');
  const runsBefore = statusRows().length;
  try {
    await asRole('test', async () => {
      const runner = HOOKS.createHookRunner({ database: HOOK_DB(), spawn: fakeSpawn });
      const due = runner.runDue({ now: new Date('2026-09-24T14:00:00Z') }); // 10 AM ET
      assert.equal(due.find(d => d.schedule === 'nightly')?.hooks[0]?.started, true, 'the morning hook fires');
      await runner.idle();
    });
  } finally { unregister(); }
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].slice(1), ['--hook']);

  const rows = statusRows().slice(runsBefore);
  assert.equal(rows.length, 1, 'one status row');
  assert.match(rows[0].error, /G03 drift/);
  await new Promise(r => setImmediate(r));
  assert.equal(pushes.length, 1, 'one push call');
  assert.match(pushes[0].text, /G03 drift/);
  for (const text of [rows[0].error, pushes[0].text]) {
    assert.ok(!text.includes(chatText), 'Coach\'s answer text never reaches the status line or the push');
    for (const n of chatNumbers) assert.ok(!text.includes(n), `the answer's number ${n} is not repeated`);
    assert.doesNotMatch(text, /claims said|expected |could not trace/);
  }
  const log = row(`SELECT last_status, last_detail FROM sync_log WHERE job = 'coach_canary'`);
  assert.equal(log.last_status, 'error', 'the full detail stays in sync_log');
  assert.match(log.last_detail, /push sent to PUSH-01/);
});

test('alert routing: no sender yet is said on the row, not pretended; ok writes a clean status row and no push', () => {
  const records = [];
  const status = [];
  const record = (...a) => records.push(a);
  const bad = { status: 'error', passed: 11, total: 12, failures: [{ id: 'G07', kind: 'error', reason: 'Request timed out.' }] };
  const r = CANARY.recordCanaryResult(bad, { record, recordUsage: () => 0, writeStatus: s => status.push(s),
    push: { send: null, why: 'PUSH-01 sender (#293) is not merged yet' } });
  assert.equal(r.push, null);
  assert.match(records[0][2].alert.push, /#293/);
  assert.deepEqual(status, [{ ok: false, summary: CANARY.canaryAlertText(bad) }]);
  const ok = CANARY.recordCanaryResult({ status: 'ok', passed: 12, total: 12, failures: [] },
    { record, recordUsage: () => 0, writeStatus: s => status.push(s), push: { send: () => assert.fail('no push on ok') } });
  assert.equal(ok.push, null);
  assert.equal(status[1].ok, true);
  assert.deepEqual(CANARY.recordCanaryResult({ status: 'fresh' }, { record: () => assert.fail('fresh writes nothing') }).rowsWritten, 0);
});

test('PUSH-01 sender: resolved from push-alerts.js when present, and named as missing when not', async () => {
  const p = await CANARY.pushSender({});
  const exists = fs.existsSync(path.join(REPO, 'server/services/campaign/push-alerts.js'));
  if (exists) assert.ok(p.send || /no push channel/.test(p.why));
  else assert.deepEqual(p, { send: null, why: 'PUSH-01 sender (#293) is not merged yet' });
});
