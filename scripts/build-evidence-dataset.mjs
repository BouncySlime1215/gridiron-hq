#!/usr/bin/env node
/**
 * Build and freeze one evidence dataset from the quote tape (Package A).
 *
 * Read-only against the live database: it only inserts rows into an
 * append-only frozen output directory under server/data/evidence-datasets,
 * never into data.sqlite. Safe to run against the live league database.
 */
import { buildEvidenceDataset, freezeEvidenceDataset } from '../server/services/nfl-evidence-dataset.js';

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
