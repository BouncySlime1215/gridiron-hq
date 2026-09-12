#!/usr/bin/env node
/**
 * Measure how many independent signals the NFL ensemble actually carries, and
 * write the result where the next stage and a human reviewer can both read it.
 *
 * Measurement only — it fits nothing into production, changes no weight and
 * writes no forecast. It reads game history, replays the ensemble's own
 * walk-forward component predictions, and reports the correlation structure.
 *
 *   GRIDIRON_DB_PATH=/tmp/some-fresh.sqlite \
 *   SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
 *   node scripts/ensemble-rank-report.mjs --before-season 2025 --label baseline
 *
 * Flags:
 *   --before-season N   Cutoff season (component forecasts and weights use only
 *                       games final before it). Omit for a live cutoff.
 *   --before-week N     Cutoff week within that season. Default 1.
 *   --label NAME        Label for the stored report. Default 'default'.
 *   --champion-only     Exclude challenger-only components from the matrix.
 *   --out PATH          Also write the JSON here. Default server/data/nfl-ensemble-rank.json.
 *   --fixture           Seed the deterministic synthetic league first. ONLY
 *                       valid against an empty scratch database; the resulting
 *                       numbers describe the fixture generator, not football,
 *                       and the report is stamped as synthetic.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

if (!process.env.GRIDIRON_DB_PATH) {
  console.error('Refusing to run without GRIDIRON_DB_PATH. This is a diagnostic; point it at a ' +
    'scratch copy or an explicit path, never implicitly at the live database.');
  process.exit(1);
}

const { run } = await import(path.join(root, 'server/db/index.js'));
await (await import(path.join(root, 'server/db/migrate.js'))).runMigrations();

let fixture = null;
if (flag('fixture')) {
  const { seedEnsembleFixture } = await import(path.join(root, 'test/helpers/seed-ensemble-fixture.js'));
  fixture = seedEnsembleFixture({ run }, {
    latentFactors: Number(value('fixture-factors', '3')),
    noise: Number(value('fixture-noise', '0.35'))
  });
  console.error('seeded synthetic fixture:', JSON.stringify(fixture));
}

const { componentRankReport, saveRankReport } =
  await import(path.join(root, 'server/services/nfl-ensemble-rank.js'));

const beforeSeason = value('before-season') ? Number(value('before-season')) : null;
const beforeWeek = value('before-week') ? Number(value('before-week')) : null;
const label = value('label', fixture ? 'synthetic-fixture' : 'default');

const started = Date.now();
const report = componentRankReport({
  beforeSeason, beforeWeek, includeChallengers: !flag('champion-only')
});
if (report.error) { console.error(report.error); process.exit(1); }

// A synthetic run must never be mistakable for a measurement of the real
// ensemble, in the file or in the database.
if (fixture) {
  report.data_source = { kind: 'synthetic_fixture', ...fixture };
  report.headline.synthetic = true;
} else {
  report.data_source = { kind: 'database', db_path: process.env.GRIDIRON_DB_PATH };
}
report.elapsed_ms = Date.now() - started;

const stored = saveRankReport(report, { label });
const out = value('out', path.join(root, 'server/data',
  fixture ? 'nfl-ensemble-rank-fixture.json' : 'nfl-ensemble-rank.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));

const h = report.headline;
console.log(`\n${report.version}  (${label}, ${report.elapsed_ms} ms)`);
console.log(`catalog components: ${report.catalog_size}   games: ${report.games_available}`);
for (const [name, space] of Object.entries(report.spaces)) {
  if (!space.available) { console.log(`\n${name}: NOT MEASURED — ${space.reason}`); continue; }
  const s = space.spectrum;
  console.log(`\n${name}: ${space.components_measured} components over ${space.rows_complete} complete games`);
  console.log(`  participation ratio  ${s.participation_ratio}`);
  console.log(`  entropy rank         ${s.entropy_rank}`);
  console.log(`  PCs for 90/95/99%    ${s.components_for_90pct} / ${s.components_for_95pct} / ${s.components_for_99pct}`);
  console.log(`  top eigenvalue share ${(s.top_eigenvalue_share * 100).toFixed(1)}%`);
  console.log(`  mean |r| off-diag    ${space.correlation.mean_abs_offdiagonal}`);
  console.log('  least redundant:');
  for (const r of [...space.redundancy].sort((a, b) => b.unique_variance - a.unique_variance).slice(0, 6)) {
    console.log(`    ${r.id.padEnd(20)} unique ${(r.unique_variance * 100).toFixed(1)}%  closest ${r.closest_component} (r=${r.closest_correlation})`);
  }
}
console.log('\nmarket shrinkage of the blend:');
for (const [mode, m] of Object.entries(report.market_shrinkage)) {
  if (!m.available) { console.log(`  ${mode}: unavailable (n=${m.n})`); continue; }
  console.log(`  ${mode}: blend = ${m.intercept} + ${m.slope_on_market}*market   R2=${m.r2}   mean |departure| ${m.mean_abs_departure_from_market}`);
}
console.log(`\nheadline effective rank (market residual space): participation ${h.participation_ratio}, entropy ${h.entropy_rank}`);
console.log(`stored: ${JSON.stringify(stored)}\nwritten: ${out}`);
