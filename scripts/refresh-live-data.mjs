#!/usr/bin/env node
/**
 * Off-server refresh of the fantasy live-data feeds.
 *
 * The in-server scheduler's "live" tier runs its jobs synchronously on the web
 * server's event loop and has pegged the app at 100% CPU with HTTP
 * unresponsive (2026-09-17). The app now runs with SCHEDULER_DISABLED=1 and
 * this script does the fantasy-relevant refreshes from a separate process, so a
 * slow ESPN response can never take the UI down.
 *
 * It calls the scheduler's own `runIfStale`, so each job keeps its declared
 * cadence (`maxAgeMinutes`), its timeout, and its `sync_log` row — the Data
 * Health page reads that table, nothing new to wire.
 *
 * After those jobs, one step after another (never in parallel):
 *   1. league_tx         ESPN transactions (collect-league-transactions.mjs)
 *   2. roster_snapshots  every team's lineup per scoring period (collect-roster-snapshots.mjs)
 *   3. league_chat       chat extract + classify + rollup; its status line becomes
 *                        sync_log 'league_chat' (classifier failures included)
 *   4. manager_signals   who-is-who + per-manager signals for all leagues
 *                        (build-manager-signals.mjs), after the chat rollup has
 *                        finished, and only when one of its inputs changed
 *
 * ALLOWLIST ONLY. Betting collectors (line snapshots, Polymarket, book feeds,
 * prop capture, t60 runner…) are deliberately absent: Nick turned them off.
 *
 * Importing this file runs nothing (tests import the steps); only running it does.
 *
 * Usage:
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/refresh-live-data.mjs --once
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/refresh-live-data.mjs --loop 900
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Before any server module is imported: the scheduler must never start in this process.
process.env.SCHEDULER_DISABLED = '1';

export const FANTASY_LIVE_JOBS = [
  'nfl_lines',          // ESPN game lines + finals — scores are what advance the current week
  'nfl_injuries',       // nflverse official reports (nightly upstream)
  'league_rosters',     // the 5 ESPN leagues — rosters, matchups, settings
  'player_rosters',     // ESPN player ↔ NFL team map
  'nfl_offseason_depth_injury',   // depth charts, daily
  'espn_rosters',       // NFL team rosters, daily
  'rss_news',           // ESPN RSS
  'espn_news',          // ESPN team pages
  'nfl_news_signals',   // typed extraction (Haiku; hourly by its own maxAge)
];

/**
 * The manager signals build is skipped while none of its inputs changed, but never
 * for longer than this: a backstop for inputs the key below does not see (a code
 * change needs a loop restart anyway, and a restart always rebuilds).
 */
export const MANAGER_SIGNALS_MAX_AGE_MINUTES = 360;

const { JOBS, runIfStale, recordSync } = await import('../server/services/scheduler.js');
const { rows } = await import('../server/db/index.js');
const { openChatDb, chatDataKey } = await import('../server/services/manager-signals.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = () => new Date().toISOString().slice(11, 19);
const outputLines = r => `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(Boolean);
const spawnFailure = r => (r.error || r.status == null
  ? String(r.error?.message ?? `killed by ${r.signal ?? 'an unknown signal'}`) : null);

// ESPN transactions with proposal/accept/decline timestamps. ESPN only answers
// with the last ~3 days, so this must run every tick or the proposals are lost.
export function transactionsCapture({ spawn = spawnSync, log = console.log } = {}) {
  const t0 = Date.now();
  const r = spawn(process.execPath, ['--env-file-if-exists=.env', 'scripts/collect-league-transactions.mjs'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const last = outputLines(r).filter(l => !/espn_s2|SWID/.test(l)).at(-1) ?? spawnFailure(r) ?? `exit ${r.status}`;
  log(`${stamp()} ${'league_tx'.padEnd(18)} ${r.status === 0 ? 'ok' : 'ERROR'} ${last.slice(0, 160)} (${Date.now() - t0} ms)`);
}

// Every team's roster and lineup slots for the current scoring period, plus a one-time
// final read of each completed period. Reads the payload league_rosters just synced.
// The collector writes its own sync_log row; the loop records only a failure to start.
export function rosterSnapshots({ spawn = spawnSync, log = console.log, record = recordSync } = {}) {
  const t0 = Date.now();
  const r = spawn(process.execPath, ['--env-file-if-exists=.env', 'scripts/collect-roster-snapshots.mjs'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const failed = spawnFailure(r);
  if (failed) {
    record('roster_snapshots', 'error', { error: failed.slice(0, 300), spawn_failed: true });
    log(`${stamp()} ${'roster_snapshots'.padEnd(18)} ERROR ${failed.slice(0, 160)} (${Date.now() - t0} ms)`);
    return;
  }
  const lines = outputLines(r).filter(l => !/espn_s2|SWID/.test(l));
  const summary = lines.filter(l => /^roster_snapshots:/.test(l)).at(-1) ?? lines.at(-1) ?? `exit ${r.status}`;
  const problems = lines.filter(l => / ERROR |MISMATCH/.test(l));
  const text = r.status === 0 ? summary : [...problems, summary].join(' | ');
  log(`${stamp()} ${'roster_snapshots'.padEnd(18)} ${r.status === 0 ? 'ok' : 'ERROR'} ${text.slice(0, 300)} (${Date.now() - t0} ms)`);
}

// League-chat backfill (Nick, 2026-09-17: "have it backfill chats when the laptop
// is on — and then rediagnose the new ones and add it to our database of player
// profiles"). Incremental, idempotent; classifies only new rows; rebuilds the
// per-manager profile tables. Reads ONLY the league group + member DMs.
//
// The extractor ends with one `league_chat_status {json}` line. It becomes the
// sync_log 'league_chat' row: 'error' when the run failed (non-zero exit, or no
// status line), 'partial' while any message is unlabeled because the classifier
// failed on it (those are never re-sent automatically: the failures seen so far are
// deterministic, so a retry only spends money), 'ok' otherwise.
export function parseChatStatus(lines) {
  const line = lines.filter(l => l.startsWith('league_chat_status ')).at(-1);
  if (!line) return null;
  try { return JSON.parse(line.slice('league_chat_status '.length)); } catch { return null; }
}

export function chatBackfill({ spawn = spawnSync, log = console.log, record = recordSync } = {}) {
  const t0 = Date.now();
  const r = spawn('python3', ['scripts/chat/extract_league_chat.py', '--classify', '--rollup'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 20 * 60 * 1000 });
  const lines = outputLines(r);
  const detail = parseChatStatus(lines);
  const failed = spawnFailure(r);
  const failures = (detail?.failed_this_run ?? 0) + (detail?.failed_outstanding ?? 0);
  const status = failed || r.status !== 0 || !detail ? 'error' : failures > 0 ? 'partial' : 'ok';
  const text = lines.filter(l => /^(extract|classify|rollup):/.test(l)).join(' | ')
    || lines.filter(l => !l.startsWith('league_chat_status ')).at(-1) || failed || `exit ${r.status}`;
  record('league_chat', status, detail ? { ...detail, exit: r.status }
    : { exit: r.status, error: (failed ?? lines.slice(-3).join(' | ')).slice(0, 300) || 'no status line' });
  const note = detail && failures > 0
    ? ` | ${detail.failed_this_run ? `${detail.failed_this_run} failed classification this run; ` : ''}`
      + `${detail.failed_outstanding} failed classification outstanding (not retried automatically)`
    : '';
  log(`${stamp()} ${'league_chat'.padEnd(18)} ${status === 'ok' ? 'ok' : status.toUpperCase()} `
    + `${text.slice(0, 200)}${note} (${Date.now() - t0} ms)`);
}

const sha = value => crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/**
 * What build-manager-signals.mjs reads, reduced to a string that changes when any of
 * it does: the ESPN league syncs, every transaction's status (not its last_seen_at,
 * which the collector re-stamps every tick), identities (Nick's confirmations),
 * archetypes, and the chat data key the builder itself uses. A table that does not
 * exist yet reads as 'absent'.
 */
export function managerSignalsInputsKey() {
  const parts = [];
  const part = (label, read) => {
    try { parts.push(`${label}:${read()}`); } catch (e) {
      if (!/no such table/i.test(String(e?.message))) throw e;
      parts.push(`${label}:absent`);
    }
  };
  part('leagues', () => rows(`SELECT id, fetched_at FROM leagues WHERE platform = 'espn' ORDER BY id`)
    .map(r => `${r.id}@${r.fetched_at}`).join(','));
  part('tx', () => sha(rows(`SELECT league_id, season, tx_id, type, status, is_pending, processed_at
                            FROM league_transactions_raw ORDER BY league_id, season, tx_id`)));
  part('identity', () => sha(rows(`SELECT league_id, roster_id, chat_name, confidence, updated_at
                                  FROM league_member_identity ORDER BY league_id, roster_id`)));
  part('archetypes', () => {
    const r = rows('SELECT COUNT(*) AS n, MAX(computed_at) AS c FROM manager_archetypes')[0];
    return `${r.n}/${r.c}`;
  });
  const chat = openChatDb();
  try { parts.push(`chat:${chat ? chatDataKey(chat) : 'absent'}`); } finally { chat?.close(); }
  return parts.join('|');
}

/**
 * The manager-data-pipeline hand-off, staleness-aware: runs the build when an input
 * changed since this process's last good build, when that build is older than
 * MANAGER_SIGNALS_MAX_AGE_MINUTES, when the last build failed, or when the inputs
 * cannot be read; otherwise logs "fresh". The script is itself idempotent and writes
 * its own sync_log row; a build that cannot even start is recorded here.
 */
export function createManagerSignalsStep({ spawn = spawnSync, log = console.log, record = recordSync,
  inputsKey = managerSignalsInputsKey, clock = Date.now, maxAgeMinutes = MANAGER_SIGNALS_MAX_AGE_MINUTES } = {}) {
  let lastOk = null;
  const readKey = () => { try { return inputsKey(); } catch { return null; } };
  return function managerSignals() {
    const key = readKey();
    if (lastOk && key != null && key === lastOk.key && clock() - lastOk.at < maxAgeMinutes * 60_000) {
      log(`${stamp()} ${'manager_signals'.padEnd(18)} fresh (inputs unchanged since `
        + `${new Date(lastOk.at).toISOString().slice(11, 19)})`);
      return { skipped: true };
    }
    const t0 = clock();
    const r = spawn(process.execPath, ['--env-file-if-exists=.env', 'scripts/build-manager-signals.mjs'],
      { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 2 * 60 * 1000 });
    const failed = spawnFailure(r);
    if (failed) {
      lastOk = null;
      record('manager_signals', 'error', { error: failed.slice(0, 300), spawn_failed: true });
      log(`${stamp()} ${'manager_signals'.padEnd(18)} ERROR ${failed.slice(0, 160)} (${clock() - t0} ms)`);
      return { ok: false };
    }
    // The key after the build: its own identity writes must not trigger the next run.
    lastOk = r.status === 0 ? { key: readKey(), at: clock() } : null;
    const lines = outputLines(r);
    const last = lines.at(-1) ?? `exit ${r.status}`;
    const text = r.status === 0 ? last : [...lines.filter(l => /: ERROR /.test(l)), last].join(' | ');
    log(`${stamp()} ${'manager_signals'.padEnd(18)} ${r.status === 0 ? 'ok' : 'ERROR'} ${text.slice(0, 300)} (${clock() - t0} ms)`);
    return { ok: r.status === 0 };
  };
}

export async function tick({ jobs = FANTASY_LIVE_JOBS, spawn = spawnSync, log = console.log, record = recordSync,
  runJob = runIfStale, force = false, managerSignals = null, inputsKey } = {}) {
  const started = Date.now();
  for (const name of jobs) {
    if (!JOBS[name]) { log(`${stamp()} ${name.padEnd(18)} UNKNOWN JOB`); continue; }
    const t0 = Date.now();
    try {
      const r = await runJob(name, { force });
      const ms = Date.now() - t0;
      if (r?.skipped) log(`${stamp()} ${name.padEnd(18)} fresh (${r.age_minutes}/${r.max_age_minutes} min)`);
      else if (r?.error) log(`${stamp()} ${name.padEnd(18)} ERROR ${String(r.error).slice(0, 160)} (${ms} ms)`);
      else log(`${stamp()} ${name.padEnd(18)} ok ${JSON.stringify(r?.detail ?? r ?? {}).slice(0, 120)} (${ms} ms)`);
    } catch (e) {
      log(`${stamp()} ${name.padEnd(18)} THREW ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  const step = (label, fn) => {
    try { fn(); } catch (e) { log(`${stamp()} ${label.padEnd(18)} THREW ${String(e?.message ?? e).slice(0, 160)}`); }
  };
  const signals = managerSignals
    ?? createManagerSignalsStep({ spawn, log, record, ...(inputsKey ? { inputsKey } : {}) });
  step('league_tx', () => transactionsCapture({ spawn, log }));
  step('roster_snapshots', () => rosterSnapshots({ spawn, log, record }));
  step('league_chat', () => chatBackfill({ spawn, log, record }));
  step('manager_signals', () => signals());
  log(`${stamp()} tick done in ${Math.round((Date.now() - started) / 1000)} s`);
}

async function main(args = process.argv.slice(2)) {
  const loopIdx = args.indexOf('--loop');
  const loopSeconds = loopIdx > -1 ? Number(args[loopIdx + 1]) || 900 : 0;
  const force = args.includes('--force');
  // One step for the life of the process, so "unchanged since the last good build" holds across ticks.
  const managerSignals = createManagerSignalsStep();

  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  if (!loopSeconds) {
    await tick({ force, managerSignals });
    return;
  }
  console.log(`${stamp()} refresh-live-data loop every ${loopSeconds} s — jobs: ${FANTASY_LIVE_JOBS.join(', ')}`
    + ', then league_tx, roster_snapshots, league_chat, manager_signals');
  while (!stopping) {
    await tick({ force, managerSignals });
    const until = Date.now() + loopSeconds * 1000;
    while (!stopping && Date.now() < until) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`${stamp()} stopped`);
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  await main();
  process.exit(0);
}
