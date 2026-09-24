#!/usr/bin/env node
/**
 * STEP-LOG: log sent War Room steps to `campaign_steps` and settle them
 * (server/services/campaign/step-log.js). Run after the transaction collector
 * (scripts/collect-league-transactions.mjs settles trade_outcomes from ESPN),
 * or by hand. Idempotent: a logged step is never written twice and a realized
 * step is never rewritten.
 *
 *   node scripts/campaign/settle-steps.mjs [--leagues 4,5] [--non-executed snapshot|zero] [--dry-run]
 *
 * --dry-run runs everything inside a transaction and rolls it back.
 * Prints one JSON line per league (counts and reasons only, no names).
 */
import { pathToFileURL } from 'node:url';

export function args(argv) {
  const out = { leagues: null, nonExecuted: 'snapshot', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--leagues') out.leagues = argv[++i].split(',').map(Number).filter(Number.isInteger);
    else if (a === '--non-executed') out.nonExecuted = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`settle-steps: unknown argument ${a}`);
  }
  return out;
}

export async function main(argv = process.argv) {
  const opts = args(argv);
  const { db, rows } = await import('../../server/db/index.js');
  const { loadPlans } = await import('../../server/services/war-room-view.js');
  const { stepLogLeague } = await import('../../server/services/campaign/step-log.js');
  const plans = await loadPlans();
  if (plans.status !== 'ok') console.log(JSON.stringify({ plans: plans.status, reason: plans.reason }));
  const leagues = rows('SELECT id FROM leagues ORDER BY id').map(r => r.id)
    .filter(id => !opts.leagues || opts.leagues.includes(id));
  const out = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of leagues) out.push(stepLogLeague(id, plans.status === 'ok' ? plans : null, { nonExecuted: opts.nonExecuted }));
    db.exec(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
  for (const r of out) console.log(JSON.stringify(r));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
