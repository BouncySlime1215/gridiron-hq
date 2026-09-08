#!/usr/bin/env node
/**
 * Build and freeze one evidence dataset from the quote tape (Package A).
 *
 * Read-only on the DATA in data.sqlite: it only inserts rows into an
 * append-only frozen output directory under server/data/evidence-datasets,
 * never writes a row into data.sqlite. It does apply any pending schema
 * migrations first (runMigrations(), same as every other entry point —
 * idempotent, backed up automatically when there's real history to protect,
 * see backupBeforeMigration() in server/db/index.js), because this script's
 * own query pattern depends on the schema actually being current: without
 * migration 021's index on nfl_quote_tape.batch_id, one query per batch
 * across 624 batches over 750K+ rows was a full-table scan every time,
 * discovered when a real run took 15+ minutes instead of the few seconds the
 * row count justifies.
 */
import { runMigrations } from '../server/db/migrate.js';
import { buildEvidenceDataset, freezeEvidenceDataset } from '../server/services/nfl-evidence-dataset.js';

await runMigrations();

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const dataset = buildEvidenceDataset({
  decisionAt: args['decision-at'] ?? new Date().toISOString(),
  markets: args.markets ? String(args.markets).split(',') : ['spreads', 'totals', 'h2h'],
  limitBatches: args['limit-batches'] ? Number(args['limit-batches']) : null
});

console.log(`Scanned ${dataset.scanned} quotes -> accepted ${dataset.accepted}, dropped ${dataset.dropped}, `
  + `${dataset.events} events, ${dataset.duplicate_event_count} duplicate-event conflicts.`);
if (dataset.quarantine.length) {
  console.log('Quarantine reasons:');
  for (const q of dataset.quarantine) console.log(`  ${q.reason}: ${q.count} — ${q.explanation}`);
}

const result = freezeEvidenceDataset(dataset);
console.log(result.existing
  ? `Dataset ${result.dataset_hash} already frozen at ${result.dir}`
  : `Froze dataset ${result.dataset_hash} (${result.rows} rows) at ${result.dir}`);
