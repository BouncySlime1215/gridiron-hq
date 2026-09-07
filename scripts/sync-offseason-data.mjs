/**
 * Ingest every free offseason data source and rebuild the player-season feature
 * table. Safe to rerun: every write is INSERT OR REPLACE inside a transaction,
 * and nothing outside the `off_*` tables is touched.
 *
 *   node scripts/sync-offseason-data.mjs                 # 2021-2026
 *   node scripts/sync-offseason-data.mjs 2025 2026       # just these seasons
 *   node scripts/sync-offseason-data.mjs --features-only # recompute, no fetching
 */
import { db } from '../server/db/index.js';
import {
  syncOffseasonData, computeFeatures, offseasonDataStatus, FEATURE_SEASONS
} from '../server/services/offseason-data.js';

const args = process.argv.slice(2);
const featuresOnly = args.includes('--features-only');
const requested = args.map(Number).filter(Number.isInteger);
const seasons = requested.length ? requested : FEATURE_SEASONS;

const t0 = Date.now();
console.log(`offseason sync: seasons ${seasons.join(', ')}${featuresOnly ? ' (features only)' : ''}\n`);

let result;
if (featuresOnly) {
  result = { datasets: [], failures: [], features: [] };
  for (const s of seasons) {
    try {
      const out = computeFeatures(s);
      result.features.push(out);
      console.log(`  ok   features_${s} ${JSON.stringify(out)}`);
    } catch (e) {
      result.failures.push({ dataset: `features_${s}`, error: e.message });
      console.log(`  FAIL features_${s}: ${e.message}`);
    }
  }
} else {
  result = await syncOffseasonData({ seasons, log: m => console.log(m) });
}

console.log('\n--- row counts ---');
const status = offseasonDataStatus();
for (const [table, n] of Object.entries(status)) {
  if (table === 'features_by_season') continue;
  console.log(`  ${table.padEnd(28)} ${String(n).padStart(9)}`);
}
console.log('\n--- features per season ---');
for (const r of status.features_by_season) console.log(`  ${r.season}  ${String(r.players).padStart(6)} players`);

if (result.skipped?.length) {
  console.log('\n--- skipped ---');
  for (const s of result.skipped) console.log(`  ${s.dataset} ${s.season}: ${s.reason}`);
}
if (result.failures.length) {
  console.log('\n--- failures ---');
  for (const f of result.failures) console.log(`  ${f.dataset}: ${f.error}`);
} else {
  console.log('\nno failures.');
}
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);
db.close();
process.exit(result.failures.length ? 1 : 0);
