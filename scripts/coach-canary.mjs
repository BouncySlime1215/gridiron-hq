#!/usr/bin/env node
/**
 * The Coach canary (HEALTH-01e): twelve golden questions with known answers,
 * asked of Coach against a fixture league, once a day, off the web server.
 *
 * WHO RUNS IT. The engine daemon's morning hook (nightly schedule: the first
 * tick after 03:00 America/New_York; scripts/engine-daemon.mjs
 * registerCoachCanaryHook) runs `--hook`. The hook child writes nothing: it
 * prints one JSON result, and the daemon records it (recordCanaryResult). The
 * refresh loop does not run the canary.
 *
 * The questions and the fixture live in scripts/lib/coach-canary-golden.mjs.
 * Coach runs against a throwaway fixture database, never the real one, so a
 * golden answer cannot move because the season did. Only the verdict and the
 * spend come back to the real database:
 *
 *   - sync_log 'coach_canary' — 'ok' (every question answered as known),
 *     'error' (drift or a thrown error: THE ALERT, with each failing question
 *     and why in last_detail), 'partial' (the cost guard stopped the run before
 *     every question ran; not drift), or 'skipped' (no key, or no allowance).
 *   - ai_usage rows under 'coach:canary', so the canary's spend draws on, and
 *     is visible in, the in-app Coach budget.
 *   - on 'error' only, THE ALERT reaches the user: one engine status row
 *     (engine_runs, producer 'coach-canary', scope 'health', error = the
 *     summary) for the status line, and one push through PUSH-01's sender
 *     (#293: server/services/campaign/push-alerts.js defaultSender) once that
 *     lands. Both carry question ids and failure kinds only, never Coach's
 *     answer text.
 *
 * AT MOST ONCE A DAY. `--hook` skips (status 'fresh', no spend) while the last
 * sync_log 'coach_canary' row, any status, is younger than 20 h — on top of the
 * hook runner's own once-per-local-day cursor.
 *
 * COST GUARD. The run's allowance is the smaller of CANARY_MAX_USD and what is
 * left of today's Coach budget. The child sets that allowance as its fixture
 * database's Coach budget, so the app's own reserveBudget refuses the call that
 * would pass it; no second accounting. The questions start at a daily-rotating
 * offset, so an allowance that covers only some of them still covers all
 * twelve across days.
 *
 * Usage:
 *   node scripts/coach-canary.mjs --hook       # the daemon's morning hook: guarded, prints JSON, writes nothing
 *   node scripts/coach-canary.mjs              # live by hand: real model, fixture DB, verdict to the real DB
 *   node scripts/coach-canary.mjs --dry-run    # CI: stand-in model, no network, no spend, touches no real DB
 *   node scripts/coach-canary.mjs --dry-run --inject-wrong G03   # prove the alert fires
 *   --max-usd 0.10    live allowance ceiling (default CANARY_MAX_USD)
 *
 * Exit code: 0 on ok/partial/skipped, 1 on drift or error. `--hook` exits 0
 * whenever it printed a result, so the daemon receives the verdict.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GOLDEN, seedFixture, gradeAnswer, canaryVerdict, dryRunClient } from './lib/coach-canary-golden.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');

/**
 * The live allowance ceiling. The spec says ~$0.10 a day, but one Coach round
 * reserves up to ~$0.108 before it runs (8,000 output tokens at $10/M plus the
 * request), so at $0.10 reserveBudget refuses the first call and the canary
 * never asks anything. $0.15 lets one to three questions run a day, all twelve
 * across the rotation. Flagged for Nick in the PR; --max-usd overrides.
 */
export const CANARY_MAX_USD = 0.15;
export const CANARY_JOB = 'coach_canary';
export const CANARY_FEATURE = 'coach:canary';
/** The engine status row's producer: what the status line reads for the canary. */
export const CANARY_STATUS_PRODUCER = 'coach-canary';
/** At most once a day; 20 h so a morning hook that fires a little later each day still runs daily. */
export const CANARY_MAX_AGE_MINUTES = 20 * 60;

/** Rotate the start so a partial allowance covers every question across days. */
export function rotation(golden = GOLDEN, date = new Date()) {
  const day = Math.floor(date.getTime() / 86_400_000);
  const offset = day % golden.length;
  return [...golden.slice(offset), ...golden.slice(0, offset)];
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : null;
}

/**
 * Open a fresh fixture database in this process and return the modules bound
 * to it. Must run before anything else imports server/db, since the path is
 * read once, at first import.
 */
async function openFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-canary-'));
  process.env.GRIDIRON_DB_PATH = path.join(dir, 'fixture.sqlite');
  process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
  process.env.SCHEDULER_DISABLED = '1';
  const db = await import('../server/db/index.js');
  await (await import('../server/db/migrate.js')).runMigrations();
  seedFixture(db.run);
  return { dir, db };
}

/**
 * Ask every golden question in order and grade it. After the first budget
 * refusal the rest are marked budget-skipped without a call.
 */
export async function runGolden({ golden, askCoach, setClient = null, injectWrong = null, sent = [] }) {
  const grades = [];
  let budgetHit = null;
  for (const g of golden) {
    if (budgetHit) { grades.push(gradeAnswer(g, { error: budgetHit })); continue; }
    if (setClient) setClient(dryRunClient(g, { injectWrong: injectWrong === g.id, sent }));
    try {
      const result = await askCoach({ question: g.question, leagueId: null });
      grades.push(gradeAnswer(g, { result }));
    } catch (e) {
      if (e?.code === 'LLM_BUDGET_EXHAUSTED') budgetHit = e;
      grades.push(gradeAnswer(g, { error: e }));
    }
  }
  return grades;
}

/** Upper-bound live cost of the requests a dry run sent, at the Coach model's prices. */
async function estimateLiveUsd(sent, model) {
  const { estimateCallCostUsd } = await import('../server/services/llm-budget.js');
  return sent.reduce((sum, request) =>
    sum + estimateCallCostUsd({ model, maxTokens: request.max_tokens, request, cacheTtl: '5m' }), 0);
}

async function dryRun(args) {
  const { dir } = await openFixtureDb();
  try {
    const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
    const { askCoach, COACH_MODEL } = await import('../server/services/coach/ask.js');
    process.env.GRIDIRON_ANTHROPIC_API_KEY ||= 'dry-run-stand-in';
    const sent = [];
    const grades = await runGolden({ golden: GOLDEN, askCoach, setClient: setAnthropicClientForTesting,
      injectWrong: argValue(args, '--inject-wrong'), sent });
    setAnthropicClientForTesting(null);
    const verdict = canaryVerdict(grades);
    const estimate = await estimateLiveUsd(sent, COACH_MODEL);
    return { mode: 'dry-run', ...verdict, grades, calls: sent.length,
      live_estimate_upper_usd: Number(estimate.toFixed(4)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Live child: fixture DB, real model, allowance as the fixture's Coach budget. */
async function child(args) {
  const allowance = Number(argValue(args, '--allowance'));
  const { dir, db } = await openFixtureDb();
  try {
    const { setDailyBudget } = await import('../server/services/llm-budget.js');
    const { askCoach, COACH_MODEL } = await import('../server/services/coach/ask.js');
    setDailyBudget('coach', allowance);
    const grades = await runGolden({ golden: rotation(), askCoach });
    const usage = db.rows(`SELECT model, input_tokens, output_tokens, cache_read_input_tokens,
                                  cache_creation_input_tokens FROM ai_usage`);
    return { mode: 'live', model: COACH_MODEL, ...canaryVerdict(grades), grades, usage };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const canaryLastRun = async () => {
  const { rows } = await import('../server/db/index.js');
  return rows(`SELECT last_run_at FROM sync_log WHERE job = ?`, CANARY_JOB)[0]?.last_run_at ?? null;
};

/** Minutes since `lastRunAt` (Infinity when never), and whether that is inside the once-a-day window. */
export function canaryAge(lastRunAt, now = Date.now()) {
  const age = lastRunAt ? (now - Date.parse(lastRunAt)) / 60_000 : Infinity;
  return { age_minutes: age, fresh: age < CANARY_MAX_AGE_MINUTES };
}

/**
 * Live run against the real DB: key check, cost guard, the child. READS the real
 * database and WRITES NOTHING; the caller records the result. With `guard`, a
 * run younger than CANARY_MAX_AGE_MINUTES returns status 'fresh' before any spend.
 */
export async function runLive(args, { guard = false, lastRunAt = canaryLastRun, now = Date.now } = {}) {
  if (guard) {
    const { age_minutes, fresh } = canaryAge(await lastRunAt(), now());
    if (fresh) return { mode: 'live', status: 'fresh', age_minutes: Math.round(age_minutes) };
  }
  const { getApiKey } = await import('../server/services/claude.js');
  const { budgetStatus } = await import('../server/services/llm-budget.js');
  const key = getApiKey();
  if (!key) return { mode: 'live', status: 'skipped', reason: 'no Anthropic API key configured' };
  const maxUsd = Number(argValue(args, '--max-usd') ?? CANARY_MAX_USD);
  const coach = budgetStatus('coach');
  const allowance = Math.min(maxUsd, coach.remaining_usd ?? maxUsd);
  if (!(allowance > 0)) {
    return { mode: 'live', status: 'skipped', reason: `no allowance: Coach has $${(coach.remaining_usd ?? 0).toFixed(2)} left today` };
  }

  // The key goes to the child through its environment only; it is never an
  // argument (visible in ps) and never logged.
  const r = spawnSync(process.execPath, [SELF, '--child', '--allowance', String(allowance)], {
    cwd: REPO, encoding: 'utf8', timeout: 15 * 60_000,
    env: { ...process.env, GRIDIRON_ANTHROPIC_API_KEY: key, GRIDIRON_DB_PATH: '' }
  });
  const line = String(r.stdout ?? '').trim().split('\n').at(-1) ?? '';
  try {
    return { ...JSON.parse(line), allowance_usd: allowance };
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return { mode: 'live', status: 'error', allowance_usd: allowance,
      error: `canary child produced no verdict (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`,
      stderr: String(r.stderr ?? '').slice(-300) };
  }
}

/**
 * The alert text: question ids and failure kinds only. A failure's `reason`
 * quotes Coach's answer ("claims said: ..."), so it stays in sync_log and never
 * reaches the status line or a push.
 */
export function canaryAlertText(verdict) {
  const failures = verdict.failures ?? [];
  if (!failures.length) return 'Coach canary could not run: the canary child produced no verdict. See Data Health, coach_canary.';
  return `Coach canary: ${failures.length} of ${verdict.total} golden questions failed `
    + `(${failures.map(f => `${f.id} ${f.kind}`).join(', ')}). See Data Health, coach_canary.`;
}

/**
 * Record a live or hook result in the real DB and route the alert. Synchronous
 * apart from the push, which is returned as a promise so the daemon's hook
 * runner (which does not await onResult) is never held by a network call.
 *
 *   record       recordSync: the sync_log 'coach_canary' row (the full detail)
 *   recordUsage  claude.js recordUsage: spend under 'coach:canary'
 *   writeStatus  ({ ok, summary }) => void: the one engine status row per recorded run
 *   push         { send, why }: PUSH-01's sender, or null with why it is missing
 *   onPushError  (message) => void: a failed push is recorded, never dropped
 */
export function recordCanaryResult(out, { record, recordUsage, writeStatus = null, push = null, onPushError = null } = {}) {
  if (out.status === 'fresh') return { recorded: false, status: 'fresh', rowsWritten: 0, push: null };
  if (out.status === 'skipped') {
    record(CANARY_JOB, 'skipped', { reason: out.reason });
    return { recorded: true, status: 'skipped', rowsWritten: 1, push: null };
  }
  let spent = 0;
  for (const u of out.usage ?? []) spent += recordUsage(CANARY_FEATURE, u.model, u) ?? 0;
  const { usage, grades, mode, ...verdict } = out;
  const failed = verdict.status === 'error';
  const summary = failed ? canaryAlertText(verdict) : `Coach canary ${verdict.status}: ${verdict.passed ?? 0} of ${verdict.total ?? 0} answered as known`;
  let pushed = null;
  let pushNote = null;
  if (failed) {
    if (push?.send) {
      pushed = Promise.resolve()
        .then(() => push.send({ league: null, text: summary }))
        .then(r => `sent via ${r?.channel ?? 'unknown'}`, e => {
          const message = `push failed: ${String(e?.message ?? e).slice(0, 200)}`;
          if (onPushError) onPushError(message); else throw e;
          return message;
        });
      pushNote = 'push sent to PUSH-01\'s sender';
    } else {
      pushNote = `no push: ${push?.why ?? 'no sender given'}`;
    }
  }
  const detail = { ...verdict, spent_usd: Number(spent.toFixed(4)), ...(failed ? { alert: { summary, push: pushNote } } : {}) };
  record(CANARY_JOB, verdict.status, detail);
  let rowsWritten = 1;
  if (writeStatus) { writeStatus({ ok: !failed, summary }); rowsWritten++; }
  return { recorded: true, status: verdict.status, summary, rowsWritten, push: pushed, push_note: pushNote };
}

/**
 * PUSH-01's sender (#293). Until that PR merges its module does not exist, and
 * the canary says so on its status row rather than pretending to have pushed.
 * Any other import failure throws.
 */
export async function pushSender(env = process.env) {
  let mod;
  try {
    mod = await import('../server/services/campaign/push-alerts.js');
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /push-alerts\.js/.test(String(e.message))) {
      return { send: null, why: 'PUSH-01 sender (#293) is not merged yet' };
    }
    throw e;
  }
  const send = mod.defaultSender(env);
  return send ? { send, why: null } : { send: null, why: `no push channel configured (${mod.NTFY_ENV} or macOS)` };
}

/** Live by hand: run, then record in the real DB (no engine status row: that is the daemon's). */
async function live(args) {
  const { recordUsage } = await import('../server/services/claude.js');
  const { recordSync } = await import('../server/services/scheduler.js');
  const out = await runLive(args);
  const push = out.status === 'error' ? await pushSender() : null;
  const rec = recordCanaryResult(out, { record: recordSync, recordUsage, push,
    onPushError: m => recordSync('coach_canary_push', 'error', { error: m }) });
  if (rec.push) await rec.push;
  const { usage, grades, ...summary } = out;
  return { ...summary, grades, alert: rec.summary && out.status === 'error' ? { summary: rec.summary, push: rec.push_note } : undefined };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--child')) return child(args);
  if (args.includes('--dry-run')) return dryRun(args);
  if (args.includes('--hook')) return runLive(args, { guard: true });
  return live(args);
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const out = await main(args);
  if (args.includes('--child') || args.includes('--hook')) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (args.includes('--hook')) process.exit(0);
  } else {
    for (const g of out.grades ?? []) console.log(`${g.pass ? 'PASS' : g.kind.toUpperCase().padEnd(5)} ${g.id} ${g.reason}`);
    const { grades, ...summary } = out;
    console.log(JSON.stringify(summary));
  }
  process.exit(out.status === 'error' ? 1 : 0);
}
