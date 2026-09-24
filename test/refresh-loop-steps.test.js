/**
 * The off-server refresh loop (scripts/refresh-live-data.mjs): the steps it runs
 * after the scheduler's fantasy jobs.
 *
 * Guarantees (docs/tdd/infra-essentials.tdd.md, gates G1, G2h, G5c):
 *  - order: transactions -> roster snapshots -> league chat -> manager signals,
 *    one after another (manager signals never overlaps the chat rollup).
 *  - manager signals: the exact spawn from the manager-data-pipeline hand-off;
 *    skipped while its inputs are unchanged and the last good build is < 6 h old;
 *    run again when an input changes, after a failure, or when never run; a spawn
 *    that cannot start is written to sync_log by the loop itself.
 *  - league chat: the extractor's status line becomes a sync_log 'league_chat'
 *    row — error on a failed run, partial while classifier failures are
 *    outstanding, ok otherwise — and the log line says so.
 * No child process is really started: spawnSync is a fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-refresh-loop-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const LOOP = await import('../scripts/refresh-live-data.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function fakeSpawn(results = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const script = args.find(a => /\.(mjs|py)$/.test(a)) ?? '';
    const r = typeof results[path.basename(script)] === 'function'
      ? results[path.basename(script)](calls.length) : results[path.basename(script)];
    return { status: 0, stdout: '', stderr: '', ...(r ?? {}) };
  };
  return { spawn, calls };
}

function recorder() {
  const records = [];
  return { records, record: (job, status, detail) => records.push({ job, status, detail }) };
}

const quiet = () => {};

// ---------------------------------------------------------------- order
test('G1a/G2h: one tick runs transactions, roster snapshots, league chat, manager signals, then the brain report — in that order', async () => {
  const { spawn, calls } = fakeSpawn({ 'extract_league_chat.py': { stdout: 'league_chat_status {"failed_this_run":0,"failed_outstanding":0}\n' } });
  const lines = [];
  await LOOP.tick({ jobs: [], spawn, log: l => lines.push(l), record: quiet, inputsKey: () => 'k' });
  const scripts = calls.map(c => path.basename(c.args.find(a => /\.(mjs|py)$/.test(a))));
  assert.deepEqual(scripts, ['collect-league-transactions.mjs', 'collect-roster-snapshots.mjs',
    'extract_league_chat.py', 'build-manager-signals.mjs', 'run-graders.mjs']);
  assert.ok(lines.at(-1).includes('tick done'));
});

test('G2h: the roster snapshot step runs the collector with node, from the repo root, and logs its result', () => {
  const { spawn, calls } = fakeSpawn({ 'collect-roster-snapshots.mjs': { status: 1, stdout: 'league 2: final period 1 ERROR ESPN 503\nroster_snapshots: partial, 0 writes, 1 fetches in 40 ms\n' } });
  const lines = [];
  LOOP.rosterSnapshots({ spawn, log: l => lines.push(l), record: quiet });
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ['--env-file-if-exists=.env', 'scripts/collect-roster-snapshots.mjs']);
  assert.equal(calls[0].opts.cwd, REPO);
  assert.match(lines[0], /roster_snapshots\s+ERROR/);
  assert.match(lines[0], /ESPN 503/, 'the failing league is on the log line, not only the summary');
});

test('league_tx: a collector run where leagues failed is not logged as ok (the collector exits 0 either way)', () => {
  // Seen in a tick on the production copy with the network blocked: "ok transactions: seen 0, new 0, failed 5".
  for (const [stdout, label] of [
    ['league 1: ERROR fetch blocked\ntransactions: seen 0, new 0, failed 5\n', 'ERROR'],
    ['league 1 A: 40 in window, 0 new, 900 stored\ntransactions: seen 236, new 1, failed 0\n', 'ok'],
  ]) {
    const { spawn } = fakeSpawn({ 'collect-league-transactions.mjs': { status: 0, stdout } });
    const lines = [];
    LOOP.transactionsCapture({ spawn, log: l => lines.push(l) });
    assert.match(lines[0], new RegExp(`league_tx\\s+${label} transactions:`), lines[0]);
  }
});

// ---------------------------------------------------------------- manager signals
test('G1a: manager signals is the hand-off\'s exact spawn', () => {
  const { spawn, calls } = fakeSpawn({ 'build-manager-signals.mjs': { stdout: 'manager_signals: ok in 380 ms\n' } });
  const lines = [];
  const step = LOOP.createManagerSignalsStep({ spawn, log: l => lines.push(l), record: quiet, inputsKey: () => 'k1' });
  step();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ['--env-file-if-exists=.env', 'scripts/build-manager-signals.mjs']);
  assert.equal(calls[0].opts.cwd, REPO);
  assert.equal(calls[0].opts.env, process.env);
  assert.equal(calls[0].opts.encoding, 'utf8');
  assert.equal(calls[0].opts.timeout, 2 * 60 * 1000);
  assert.match(lines[0], /manager_signals\s+ok manager_signals: ok in 380 ms/);
});

test('G1b: skipped while inputs are unchanged; run when an input changes', () => {
  const { spawn, calls } = fakeSpawn({ 'build-manager-signals.mjs': { stdout: 'manager_signals: ok in 1 ms\n' } });
  let key = 'k1';
  const lines = [];
  const step = LOOP.createManagerSignalsStep({ spawn, log: l => lines.push(l), record: quiet, inputsKey: () => key });
  step(); step();
  assert.equal(calls.length, 1, 'second call with the same inputs is skipped');
  assert.match(lines[1], /manager_signals\s+fresh \(inputs unchanged/);
  key = 'k2';
  step();
  assert.equal(calls.length, 2, 'a changed input rebuilds');
});

test('G1b: a failed build is retried on the next tick even when nothing changed; failing leagues are on the log line', () => {
  const { spawn, calls } = fakeSpawn({ 'build-manager-signals.mjs': n => (n === 1
    ? { status: 1, stdout: 'league 1 A: 8 managers\nleague 4 B: ERROR no such table: manager_chat_profile\nmanager_signals: error in 90 ms\n' }
    : { status: 0, stdout: 'manager_signals: ok in 80 ms\n' }) });
  const lines = [];
  const step = LOOP.createManagerSignalsStep({ spawn, log: l => lines.push(l), record: quiet, inputsKey: () => 'same' });
  step();
  assert.match(lines[0], /manager_signals\s+ERROR/);
  assert.match(lines[0], /league 4 B: ERROR no such table: manager_chat_profile/);
  step();
  assert.equal(calls.length, 2, 'retried: the last run did not succeed');
  step();
  assert.equal(calls.length, 2, 'now fresh');
});

test('G1b: rebuilt at least every 6 hours even when the inputs key is unchanged', () => {
  const { spawn, calls } = fakeSpawn({ 'build-manager-signals.mjs': { stdout: 'manager_signals: ok\n' } });
  let now = Date.parse('2026-09-18T12:00:00Z');
  const step = LOOP.createManagerSignalsStep({ spawn, log: quiet, record: quiet, inputsKey: () => 'same', clock: () => now });
  step();
  now += 359 * 60_000; step();
  assert.equal(calls.length, 1);
  now += 2 * 60_000; step();
  assert.equal(calls.length, 2);
});

test('G1b: an inputs key that cannot be read never causes a skip', () => {
  const { spawn, calls } = fakeSpawn({ 'build-manager-signals.mjs': { stdout: 'manager_signals: ok\n' } });
  const step = LOOP.createManagerSignalsStep({ spawn, log: quiet, record: quiet, inputsKey: () => { throw new Error('locked'); } });
  step(); step();
  assert.equal(calls.length, 2);
});

test('G1c: a build that cannot start is recorded in sync_log by the loop', () => {
  const { spawn } = fakeSpawn({ 'build-manager-signals.mjs': { status: null, error: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) } });
  const { records, record } = recorder();
  const lines = [];
  LOOP.createManagerSignalsStep({ spawn, log: l => lines.push(l), record, inputsKey: () => 'k' })();
  assert.equal(records.length, 1);
  assert.equal(records[0].job, 'manager_signals');
  assert.equal(records[0].status, 'error');
  assert.match(JSON.stringify(records[0].detail), /ENOENT/);
  assert.match(lines[0], /manager_signals\s+ERROR spawn node ENOENT/);
});

// ---------------------------------------------------------------- inputs key (real DB)
test('G1b: the inputs key moves with a league sync, a transaction decision and an identity edit, and not otherwise', () => {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, fetched_at)
       VALUES (1, 'espn', '111', 2026, 'L', '{}', '2026-09-18 10:00:00')`);
  run(`CREATE TABLE IF NOT EXISTS league_transactions_raw (league_id INTEGER, season INTEGER, tx_id TEXT, type TEXT,
       status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT, team_id INTEGER, member_id TEXT,
       related_tx_id TEXT, scoring_period INTEGER, bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
       first_seen_at TEXT, last_seen_at TEXT, PRIMARY KEY (league_id, season, tx_id))`);
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, is_pending, first_seen_at, last_seen_at)
       VALUES (1, 2026, 'a', 'TRADE_PROPOSAL', 'PENDING', 1, 't0', 't0')`);
  const k0 = LOOP.managerSignalsInputsKey();
  assert.equal(LOOP.managerSignalsInputsKey(), k0, 'stable');
  // The collector re-stamps last_seen_at on every tick: that alone is not a change.
  run(`UPDATE league_transactions_raw SET last_seen_at = 't1'`);
  assert.equal(LOOP.managerSignalsInputsKey(), k0);
  run(`UPDATE league_transactions_raw SET status = 'EXECUTED', is_pending = 0`);
  const k1 = LOOP.managerSignalsInputsKey();
  assert.notEqual(k1, k0, 'a decision on an existing proposal is a change');
  run(`UPDATE leagues SET fetched_at = '2026-09-18 11:00:00' WHERE id = 1`);
  const k2 = LOOP.managerSignalsInputsKey();
  assert.notEqual(k2, k1, 'a league sync is a change');
  run(`INSERT INTO league_member_identity (league_id, roster_id, confidence, updated_at) VALUES (1, '3', 'confirmed', '2026-09-18 11:05:00')`);
  assert.notEqual(LOOP.managerSignalsInputsKey(), k2, 'an identity confirmation is a change');
});

test('G1b: the inputs key follows the chat data the builder reads', () => {
  const chatFile = path.join(temp, 'chat.sqlite');
  const chat = new DatabaseSync(chatFile);
  chat.exec(`CREATE TABLE messages (msg_id INTEGER, name TEXT); CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT);
             INSERT INTO messages VALUES (1, 'A');`);
  process.env.GRIDIRON_CHAT_DB_PATH = chatFile;
  try {
    const k0 = LOOP.managerSignalsInputsKey();
    chat.exec(`INSERT INTO jev_chat_signals VALUES (1, 'q')`);
    assert.notEqual(LOOP.managerSignalsInputsKey(), k0, 'a new classifier label is a change');
  } finally {
    chat.close();
    process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
  }
});

// ---------------------------------------------------------------- league chat
const STATUS = obj => `league_chat_status ${JSON.stringify(obj)}\n`;

test('G5c: outstanding classifier failures make league_chat partial, loudly', () => {
  const detail = { extract_new: 0, classify: { ran: false }, failed_this_run: 0, failed_outstanding: 18,
    failed_errors: { 'Question "tone" did not select a highest-probability option.': 15 } };
  const { spawn } = fakeSpawn({ 'extract_league_chat.py': { stdout: `extract: 0 new message(s), max msg_id 5\nrollup: 10 manager profiles, 119 (manager, player) sentiment rows\n${STATUS(detail)}` } });
  const { records, record } = recorder();
  const lines = [];
  LOOP.chatBackfill({ spawn, log: l => lines.push(l), record });
  assert.equal(records.length, 1);
  assert.deepEqual({ job: records[0].job, status: records[0].status }, { job: 'league_chat', status: 'partial' });
  assert.equal(records[0].detail.failed_outstanding, 18);
  assert.match(lines[0], /league_chat\s+PARTIAL/);
  assert.match(lines[0], /18 failed classification/);
});

test('G5c: a new failure this run is partial and named on the log line', () => {
  const { spawn } = fakeSpawn({ 'extract_league_chat.py': { stdout: STATUS({ extract_new: 3, failed_this_run: 2, failed_outstanding: 20, failed_errors: { boom: 2 } }) } });
  const { records, record } = recorder();
  const lines = [];
  LOOP.chatBackfill({ spawn, log: l => lines.push(l), record });
  assert.equal(records[0].status, 'partial');
  assert.match(lines[0], /2 failed classification this run/);
});

test('G5c: a clean run is ok', () => {
  const { spawn } = fakeSpawn({ 'extract_league_chat.py': { stdout: STATUS({ extract_new: 1, failed_this_run: 0, failed_outstanding: 0 }) } });
  const { records, record } = recorder();
  LOOP.chatBackfill({ spawn, log: quiet, record });
  assert.equal(records[0].status, 'ok');
});

test('G5c: a non-zero exit, or no status line at all, is an error with the output tail', () => {
  for (const r of [
    { status: 1, stdout: `classify: FAILED (exit 1) gateway 503\n${STATUS({ failed_this_run: 0, failed_outstanding: 0 })}` },
    { status: 1, stdout: '', stderr: 'scope not found: group chat or participants missing' },
    { status: 0, stdout: 'something unexpected\n' },
    { status: null, error: new Error('spawn python3 ENOENT') },
  ]) {
    const { spawn } = fakeSpawn({ 'extract_league_chat.py': r });
    const { records, record } = recorder();
    LOOP.chatBackfill({ spawn, log: quiet, record });
    assert.equal(records[0].status, 'error', JSON.stringify(r));
  }
});

test('G5c: the chat step still runs the extractor with the same arguments', () => {
  const { spawn, calls } = fakeSpawn({ 'extract_league_chat.py': { stdout: STATUS({ failed_outstanding: 0 }) } });
  LOOP.chatBackfill({ spawn, log: quiet, record: quiet });
  assert.equal(calls[0].cmd, 'python3');
  assert.deepEqual(calls[0].args, ['scripts/chat/extract_league_chat.py', '--classify', '--rollup']);
  assert.equal(calls[0].opts.cwd, REPO);
});

test('G4: the weekly learning cycle (pregame capture, settlement, retrain) is on the loop, and every job name exists', async () => {
  // With SCHEDULER_DISABLED=1 on the server since 2026-09-17, nothing ran it: its last run
  // was a manual one at 2026-09-17 18:59, so week 3's pregame snapshot would never be
  // captured (it cannot be rewritten once the slate starts).
  assert.ok(LOOP.FANTASY_LIVE_JOBS.includes('nfl_weekly_learning'));
  const { JOBS } = await import('../server/services/scheduler.js');
  for (const name of LOOP.FANTASY_LIVE_JOBS) assert.ok(JOBS[name], `${name} is a scheduler job`);
  const ran = [];
  await LOOP.tick({ jobs: LOOP.FANTASY_LIVE_JOBS, runJob: async name => { ran.push(name); return { skipped: true }; },
    spawn: fakeSpawn({ 'extract_league_chat.py': { stdout: STATUS({ failed_outstanding: 0 }) } }).spawn,
    log: quiet, record: quiet, inputsKey: () => 'k' });
  assert.ok(ran.includes('nfl_weekly_learning'));
  assert.ok(ran.indexOf('nfl_weekly_learning') > ran.indexOf('nfl_lines'), 'after the scores that advance the week');
});

test('G1/G2/G5: importing the loop runs nothing (no tick, no scheduler job)', () => {
  assert.equal(rows(`SELECT COUNT(*) AS n FROM sync_log WHERE job IN ('league_rosters', 'manager_signals', 'league_chat')`)[0].n, 0);
});

test('G6: player_week_usage/xFP ingestion is on the loop, or a week-1-stuck-forever bug is invisible', async () => {
  // Found in the 2026-09-18 structural relook: player_week_usage's max week was stuck
  // at 1 while the server ran SCHEDULER_DISABLED=1, because the jobs that ingest a
  // finalized week (nfl_model_growth) and the weekly xFP benchmark (ffopportunity)
  // were scheduler-only and never on THIS loop. Both jobs already exist fully
  // configured in scheduler.js's JOBS map (refreshNflModelGrowth, refreshFfOpportunity)
  // — this was purely a missing two-line allowlist entry, not a missing feature.
  // Left unfixed, the play-chance role layer's "missed last game" signal
  // (contingency.js, counts team games from player_week_usage) silently reads every
  // player as never having missed a game from week 3 on.
  assert.ok(LOOP.FANTASY_LIVE_JOBS.includes('nfl_model_growth'), 'finalized-week ingest must be on the live loop');
  assert.ok(LOOP.FANTASY_LIVE_JOBS.includes('ffopportunity'), 'weekly xFP benchmark must be on the live loop');
  const { JOBS } = await import('../server/services/scheduler.js');
  for (const name of LOOP.FANTASY_LIVE_JOBS) assert.ok(JOBS[name], `${name} is a scheduler job`);
  const ran = [];
  await LOOP.tick({ jobs: LOOP.FANTASY_LIVE_JOBS, runJob: async name => { ran.push(name); return { skipped: true }; },
    spawn: fakeSpawn({ 'extract_league_chat.py': { stdout: STATUS({ failed_outstanding: 0 }) } }).spawn,
    log: quiet, record: quiet, inputsKey: () => 'k' });
  assert.ok(ran.includes('nfl_model_growth'));
  assert.ok(ran.includes('ffopportunity'));
});

test('G7: the start/sit gate job is on the loop, after the jobs that settle the week it grades', async () => {
  // With SCHEDULER_DISABLED=1 this loop is the only runner of scheduler jobs, so a job
  // missing from the allowlist never runs: GET /api/gates/start-sit would answer
  // not_run forever (C-01 wiring review). The gate reads player_week_usage (ingested by
  // nfl_model_growth) and the pregame snapshots nfl_weekly_learning settles.
  assert.ok(LOOP.FANTASY_LIVE_JOBS.includes('start_sit_gate'), 'the gate job must be on the live loop');
  const { JOBS } = await import('../server/services/scheduler.js');
  assert.equal(JOBS.start_sit_gate.offThread, true, 'it runs in a worker, not on the loop process thread');
  const ran = [];
  await LOOP.tick({ jobs: LOOP.FANTASY_LIVE_JOBS, runJob: async name => { ran.push(name); return { skipped: true }; },
    spawn: fakeSpawn({ 'extract_league_chat.py': { stdout: STATUS({ failed_outstanding: 0 }) } }).spawn,
    log: quiet, record: quiet, inputsKey: () => 'k' });
  assert.ok(ran.indexOf('start_sit_gate') > ran.indexOf('nfl_model_growth'), 'after the finalized-week ingest');
  assert.ok(ran.indexOf('start_sit_gate') > ran.indexOf('nfl_weekly_learning'), 'after the snapshot settlement');
});

test('DATA-FC: the FantasyCalc market job is on the loop, daily, before the served-number snapshot', async () => {
  // With SCHEDULER_DISABLED=1 this loop is the only runner of scheduler jobs; off it, the
  // trade-card price aged 5 days and dynasty_value_history held no rows.
  assert.ok(LOOP.FANTASY_LIVE_JOBS.includes('fantasycalc_dynasty'), 'the FantasyCalc job must be on the live loop');
  const { JOBS } = await import('../server/services/scheduler.js');
  assert.ok(JOBS.fantasycalc_dynasty.maxAgeMinutes >= 24 * 60, 'no more than one fetch a day');
  const ran = [];
  await LOOP.tick({ jobs: LOOP.FANTASY_LIVE_JOBS, runJob: async name => { ran.push(name); return { skipped: true }; },
    spawn: fakeSpawn({ 'extract_league_chat.py': { stdout: STATUS({ failed_outstanding: 0 }) } }).spawn,
    log: quiet, record: quiet, inputsKey: () => 'k' });
  assert.ok(ran.indexOf('fantasycalc_dynasty') > ran.indexOf('player_rosters'), 'after the espn_id join key is filled');
  assert.ok(ran.indexOf('fantasycalc_dynasty') < ran.indexOf('served_numbers_weekly'), 'before the trade cards are snapshotted');
  // The redraft half: 'fc_value' (League Hub roster strength, rankings, edge board) had no runner at all.
  assert.ok(LOOP.FANTASY_LIVE_JOBS.includes('fantasycalc_values'), 'the redraft FantasyCalc job must be on the live loop');
  assert.ok(JOBS.fantasycalc_values.maxAgeMinutes >= 24 * 60, 'redraft: no more than one fetch a day');
  assert.ok(ran.indexOf('fantasycalc_values') > ran.indexOf('player_rosters'), 'redraft: after the join keys are filled');
});

// ---------------------------------------------------------------- warroom plans (CAMPAIGN-01)
test('CAMPAIGN-01: the War Room producer is launched after manager signals only when the War Room flag is on (GRIDIRON_WARROOM_ENABLED=1)', async () => {
  const chat = { 'extract_league_chat.py': { stdout: 'league_chat_status {"failed_this_run":0,"failed_outstanding":0}\n' } };
  const before = { flag: process.env.GRIDIRON_WARROOM_ENABLED, plans: process.env.GRIDIRON_WARROOM_PLANS };
  process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'warroom', 'plans.json');
  const launched = [];
  const warRoomLaunch = (cmd, args, opts) => { launched.push({ cmd, args, opts }); return 4242; };
  try {
    delete process.env.GRIDIRON_WARROOM_ENABLED;
    await LOOP.tick({ jobs: [], spawn: fakeSpawn(chat).spawn, log: quiet, record: quiet, inputsKey: () => 'k', warRoomLaunch });
    assert.equal(launched.length, 0, 'flag off: never launched');
    process.env.GRIDIRON_WARROOM_ENABLED = '1';
    const lines = [];
    await LOOP.tick({ jobs: [], spawn: fakeSpawn(chat).spawn, log: l => lines.push(l), record: quiet, inputsKey: () => 'k2', warRoomLaunch });
    assert.equal(launched.length, 1);
    assert.equal(launched[0].cmd, process.execPath);
    assert.deepEqual(launched[0].args, ['--env-file-if-exists=.env', 'scripts/campaign/produce-plans.mjs']);
    assert.equal(launched[0].opts.cwd, REPO);
    const order = lines.map(l => l.trim().split(/\s+/)[1]);
    assert.ok(order.indexOf('warroom_plans') > order.indexOf('manager_signals'), 'after the data it plans on');
    assert.ok(order.indexOf('warroom_plans') > order.indexOf('brain_report'), 'after the report card it gates on (FIX-05)');
  } finally {
    for (const [k, v] of [['GRIDIRON_WARROOM_ENABLED', before.flag], ['GRIDIRON_WARROOM_PLANS', before.plans]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('CAMPAIGN-01: a running producer is not launched twice, and the last finished run is recorded (ok / partial / error)', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'wr-'));
  const files = { plans: path.join(dir, 'plans.json'), lock: path.join(dir, 'plans.json.lock'), log: path.join(dir, 'producer.log') };
  const env = { ...process.env };
  const on = () => ({ enabled: true, preview: false });   // the loop asks warroom-flag.js; pinned on here
  const cases = [
    ['warroom_plans ok leagues 5 failed 0 changed 0 (80 s) -> x', 'ok'],
    ['warroom_plans PARTIAL leagues 5 failed 1 changed 0 (80 s) -> x', 'partial'],
    ['Error: boom\nwarroom_plans failed', 'error'],
  ];
  for (const [line, want] of cases) {
    fs.writeFileSync(files.log, `noise\n${line}\n`);
    const { records, record } = recorder();
    let launches = 0;
    LOOP.warRoomPlans({ launch: () => { launches++; return 1; }, log: quiet, record, env, files, flag: on });
    assert.equal(records[0].job, 'warroom_plans');
    assert.equal(records[0].status, want);
    assert.equal(launches, 1);
  }
  fs.writeFileSync(files.lock, String(process.pid));     // a live holder: this test process
  let launches = 0;
  const lines = [];
  LOOP.warRoomPlans({ launch: () => { launches++; return 1; }, log: l => lines.push(l), record: quiet, env, files, flag: on });
  assert.equal(launches, 0);
  assert.match(lines[0], /still running/);
  fs.writeFileSync(files.lock, '999999999');              // a dead holder: stale lock
  LOOP.warRoomPlans({ launch: () => { launches++; return 1; }, log: quiet, record: quiet, env, files, flag: on });
  assert.equal(launches, 1);
  // A run that crashed after starting leaves no summary: an error, not the previous run's ok.
  fs.writeFileSync(files.log, 'warroom_plans ok leagues 5 failed 0 changed 0 (80 s) -> x\nwarroom_plans started t pid 1\nTypeError: x\n');
  fs.rmSync(files.lock);
  const r2 = recorder();
  LOOP.warRoomPlans({ launch: () => 1, log: quiet, record: r2.record, env, files, flag: on });
  assert.equal(r2.records[0].status, 'error');
  assert.match(r2.records[0].detail.line, /without a summary/);
});
