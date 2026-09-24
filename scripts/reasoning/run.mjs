#!/usr/bin/env node
/**
 * REASON-01 / FIX-08: re-run the War Room reasoning panels by hand over the
 * current plans file, offline. Never run on a web request.
 *
 *   node scripts/reasoning/run.mjs [--plans <plans.json>] [--dry-run] [--model <id>] [--open <id,id>]
 *
 * --open takes card ids (flip:<player>:<from>:<to>, target:<player>:<owner>,
 * optionally prefixed <league>|) and rebuilds those panels even when their
 * inputs are unchanged (FIX-234-1: flips and targets are written on open or
 * when their inputs change).
 *
 * The campaign producer (scripts/campaign/produce-plans.mjs) already writes
 * reasoning into every move on each run. This is the manual re-run: it goes
 * through the same function (scripts/reasoning/reason-plans.mjs), takes the
 * producer's lock, and rewrites the plans file atomically with each move's
 * `reasoning` filled. The reuse cache (panels.json) sits next to the plans
 * file; an unchanged move costs nothing.
 *
 * Makes real, billed Anthropic calls (one per league whose deck changed) unless
 * --dry-run is passed. A real run needs both gates: the reasoning flag
 * (server/services/reasoning-flag.js, or preview mode) and GRIDIRON_ALLOW_PAID_RUN.
 * With either off it refuses and touches nothing, rather than overwrite written
 * panels with 'unknown'.
 * --dry-run builds every prompt, prints the summary, and writes nothing.
 */
import fs from 'node:fs';
import { assertPaidRunOptIn } from '../paid-run-optin.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const DRY = process.argv.includes('--dry-run');
const { warRoomPlansPath } = await import('../../server/services/warroom-flag.js');
const plansPath = arg('--plans', warRoomPlansPath());
const model = arg('--model');
const open = (arg('--open') ?? '').split(',').map(s => s.trim()).filter(Boolean);

if (!fs.existsSync(plansPath)) {
  process.stderr.write(`No plans file at ${plansPath}. Run the campaign producer first, or pass --plans.\n`);
  process.exit(1);
}
// Before the database opens: a refusal must cost and touch nothing.
if (!DRY) {
  assertPaidRunOptIn();
  const { reasoningFlag, REASONING_ENV } = await import('../../server/services/reasoning-flag.js');
  if (!reasoningFlag().enabled) {
    process.stderr.write(`refusing to run: reasoning is off. Set ${REASONING_ENV}=1 (or use preview mode).\n`);
    process.exit(1);
  }
}

const { takeLock } = await import('../campaign/produce-plans.mjs');
const { reasonPlans } = await import('./reason-plans.mjs');

const release = DRY ? () => {} : takeLock(plansPath);
if (!release) {
  process.stderr.write('The campaign producer holds the plans lock; it writes reasoning itself. Try again after it finishes.\n');
  process.exit(1);
}
try {
  const plans = JSON.parse(fs.readFileSync(plansPath, 'utf8'));
  const run = await reasonPlans({ plans, plansFile: plansPath, dryRun: DRY, ...(model ? { model } : {}),
    ...(open.length ? { open } : {}),
    log: l => console.log(JSON.stringify(l)) });
  if (!DRY) {
    const tmp = `${plansPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(plans));
    fs.renameSync(tmp, plansPath);
    run.commit();
  }
  console.log(JSON.stringify({ ...run.summary, dry_run: DRY, plans: plansPath }));
  if (run.result.status === 'failed') process.exitCode = 1;
} finally { release(); }
