#!/usr/bin/env node
/**
 * The Coach canary (HEALTH-01e): twelve golden questions with known answers,
 * asked of Coach against a fixture league, once a day, off the web server.
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
 *
 * COST GUARD. The run's allowance is the smaller of CANARY_MAX_USD and what is
 * left of today's Coach budget. The child sets that allowance as its fixture
 * database's Coach budget, so the app's own reserveBudget refuses the call that
 * would pass it; no second accounting. The questions start at a daily-rotating
 * offset, so an allowance that covers only some of them still covers all
 * twelve across days.
 *
 * Usage:
 *   node scripts/coach-canary.mjs              # live: real model, fixture DB, verdict to the real DB
 *   node scripts/coach-canary.mjs --dry-run    # CI: stand-in model, no network, no spend, touches no real DB
 *   node scripts/coach-canary.mjs --dry-run --inject-wrong G03   # prove the alert fires
 *   --max-usd 0.10    live allowance ceiling (default CANARY_MAX_USD)
 *
 * Exit code: 0 on ok/partial/skipped, 1 on drift or error.
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

/** Live parent: the real DB. Guards the cost, runs the child, records verdict and spend. */
async function live(args) {
  const { getApiKey, recordUsage } = await import('../server/services/claude.js');
  const { budgetStatus } = await import('../server/services/llm-budget.js');
  const { recordSync } = await import('../server/services/scheduler.js');

  const key = getApiKey();
  if (!key) {
    recordSync(CANARY_JOB, 'skipped', { reason: 'no Anthropic API key configured' });
    return { mode: 'live', status: 'skipped', reason: 'no Anthropic API key configured' };
  }
  const maxUsd = Number(argValue(args, '--max-usd') ?? CANARY_MAX_USD);
  const coach = budgetStatus('coach');
  const allowance = Math.min(maxUsd, coach.remaining_usd ?? maxUsd);
  if (!(allowance > 0)) {
    const reason = `no allowance: Coach has $${(coach.remaining_usd ?? 0).toFixed(2)} left today`;
    recordSync(CANARY_JOB, 'skipped', { reason });
    return { mode: 'live', status: 'skipped', reason };
  }

  // The key goes to the child through its environment only; it is never an
  // argument (visible in ps) and never logged.
  const r = spawnSync(process.execPath, [SELF, '--child', '--allowance', String(allowance)], {
    cwd: REPO, encoding: 'utf8', timeout: 15 * 60_000,
    env: { ...process.env, GRIDIRON_ANTHROPIC_API_KEY: key, GRIDIRON_DB_PATH: '' }
  });
  const line = String(r.stdout ?? '').trim().split('\n').at(-1) ?? '';
  let out;
  try { out = JSON.parse(line); } catch {
    const detail = { error: `canary child produced no verdict (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`,
      stderr: String(r.stderr ?? '').slice(-300) };
    recordSync(CANARY_JOB, 'error', detail);
    return { mode: 'live', status: 'error', ...detail };
  }
  let spent = 0;
  for (const u of out.usage ?? []) spent += recordUsage(CANARY_FEATURE, u.model, u) ?? 0;
  const { usage, grades, ...verdict } = out;
  const detail = { ...verdict, allowance_usd: allowance, spent_usd: Number(spent.toFixed(4)) };
  recordSync(CANARY_JOB, verdict.status, detail);
  return { ...detail, grades };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--child')) return child(args);
  if (args.includes('--dry-run')) return dryRun(args);
  return live(args);
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const out = await main(args);
  if (args.includes('--child')) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else {
    for (const g of out.grades ?? []) console.log(`${g.pass ? 'PASS' : g.kind.toUpperCase().padEnd(5)} ${g.id} ${g.reason}`);
    const { grades, ...summary } = out;
    console.log(JSON.stringify(summary));
  }
  process.exit(out.status === 'error' ? 1 : 0);
}
