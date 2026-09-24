#!/usr/bin/env node
/**
 * REASON-01: write the War Room reasoning panels for every league, offline,
 * after the campaign producer has written its plans. Never run on a web
 * request.
 *
 *   node scripts/reasoning/run.mjs --plans <plans.json> [--out <panels.json>] [--dry-run] [--model <id>]
 *
 * Makes real, billed Anthropic calls (one per league whose top card or deck
 * changed) unless --dry-run is passed; those need GRIDIRON_ALLOW_PAID_RUN set.
 * Each call is held against that league's daily trade-proposals pot and
 * printed with its cost. The previous --out file is read first so unchanged
 * cards reuse their panel and cost nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPaidRunOptIn } from '../paid-run-optin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const DRY = process.argv.includes('--dry-run');
const plansPath = arg('--plans', path.join(ROOT, 'server/data/campaign/plans.json'));
const outPath = arg('--out', path.join(ROOT, 'server/data/reasoning/panels.json'));
const model = arg('--model');

if (!fs.existsSync(plansPath)) {
  process.stderr.write(`No plans file at ${plansPath}. Run the campaign producer first, or pass --plans.\n`);
  process.exit(1);
}
// Before the database opens: a refusal must cost and touch nothing.
if (!DRY) assertPaidRunOptIn();

const { produceReasoning } = await import('../../server/services/reasoning/produce.js');

const plans = JSON.parse(fs.readFileSync(plansPath, 'utf8'));
let previous = null;
if (fs.existsSync(outPath)) {
  try {
    previous = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (e) {
    // A corrupt previous file costs one re-spend, never a crash; say so.
    process.stderr.write(`Previous panels at ${outPath} could not be read (${e.message}); every card is rewritten.\n`);
  }
}

const result = await produceReasoning({
  plans, previous, dryRun: DRY, ...(model ? { model } : {}),
  log: c => console.log(JSON.stringify({ reasoning_call: c }))
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const tmp = `${outPath}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
fs.renameSync(tmp, outPath);

const panels = result.leagues.flatMap(l => l.panels);
const failed = panels.flatMap(p => Object.values(p.sections)).filter(s => s.status === 'failed').length;
console.log(JSON.stringify({
  leagues: result.leagues.length, panels: panels.length,
  reused: panels.filter(p => p.cost?.reused).length,
  check_first: panels.filter(p => p.check_first).length,
  failed_sections: failed,
  calls: result.calls.length, total_cost_usd: +result.total_cost_usd.toFixed(4), out: outPath
}));
