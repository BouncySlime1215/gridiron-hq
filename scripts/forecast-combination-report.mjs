#!/usr/bin/env node
/**
 * Walk-forward bake-off between the incumbent market-residual blend and real
 * forecast-combination methods.
 *
 * Measurement only. It fits nothing into production, writes no weight, and
 * changes no forecast — it replays the ensemble's own cutoff-safe component
 * predictions and asks which way of combining them would have been better on
 * seasons it never trained on.
 *
 *   GRIDIRON_DB_PATH=/tmp/some-fresh.sqlite \
 *   SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
 *   node scripts/forecast-combination-report.mjs --test-seasons 2023,2024,2025
 *
 * Flags:
 *   --test-seasons A,B,C  Held-out seasons, each fit on every season before it.
 *                         MUST be at or after the ensemble's calibration
 *                         boundary (2022) or the component forecasts themselves
 *                         are not cutoff-safe for that season.
 *   --max-components N    Cap on the reduced basis size. Default 6.
 *   --max-explained R     Cut the basis at the first step already explained by
 *                         more than R by prior picks. Default 0.90.
 *   --out PATH            Where to write the JSON report.
 *   --fixture             Seed the deterministic synthetic league first. ONLY
 *                         valid against an empty scratch database; the numbers
 *                         then describe the fixture generator, not football,
 *                         and the report is stamped synthetic.
 *   --fixture-market-noise S
 *                         How far the fixture's market sits from the true edge.
 *                         The 1.6 default is a near-oracle market, in which no
 *                         combination can win and "nothing beat the market" says
 *                         nothing about the combiner. A large value is the
 *                         control run: signal exists, so a correct combiner MUST
 *                         be seen to find it. Everything but the market quote is
 *                         bit-identical between the two.
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
  console.error('Refusing to run without GRIDIRON_DB_PATH. Point it at a scratch copy or an ' +
    'explicit path, never implicitly at the live database.');
  process.exit(1);
}

const { run } = await import(path.join(root, 'server/db/index.js'));
await (await import(path.join(root, 'server/db/migrate.js'))).runMigrations();

let fixture = null;
if (flag('fixture')) {
  const { seedEnsembleFixture } = await import(path.join(root, 'test/helpers/seed-ensemble-fixture.js'));
  fixture = seedEnsembleFixture({ run }, {
    latentFactors: Number(value('fixture-factors', '3')),
    noise: Number(value('fixture-noise', '0.35')),
    marketNoise: Number(value('fixture-market-noise', '1.6'))
  });
  console.error('seeded synthetic fixture:', JSON.stringify(fixture));
}

const ensemble = await import(path.join(root, 'server/services/nfl-ensemble.js'));
const combo = await import(path.join(root, 'server/services/forecast-combination.js'));

const testSeasons = (value('test-seasons', '2023,2024,2025') ?? '')
  .split(',').map(s => Number(s.trim())).filter(Number.isFinite);

const started = Date.now();

// One cutoff-safe replay pass. Every component forecast in it was produced from
// games strictly earlier than the game it forecasts, so the only thing the
// walk-forward below has to protect is the combination weights.
const inputs = ensemble.ensembleReplayInputs({});
const records = [...ensemble.componentPredictionStream({ ...inputs })];
if (!records.length) {
  console.error('no component predictions — the database has no usable game history');
  process.exit(1);
}
const catalog = ensemble.componentIds();
const componentIdList = catalog.map(c => c.id);

const baseReduction = {
  maxComponents: Number(value('max-components', '6')),
  maxExplained: Number(value('max-explained', '0.90'))
};

// Two reductions, run side by side. Stage 1 warned that effective rank is
// measured on component outputs and not on their skill; the difference between
// these two arms is what that warning costs in RMSE.
const arms = [
  { key: 'independence_only', label: 'greedy independent basis (stage 1 as written)',
    reduction: { ...baseReduction, skillScreen: 'none' } },
  { key: 'skill_then_independence', label: 'skill screen first, then independent basis',
    reduction: { ...baseReduction, skillScreen: 'top_n', skillTopN: Number(value('skill-top-n', '12')) } }
];

const runs = [];
for (const arm of arms) {
  const result = combo.walkForwardCombination({ records, componentIdList, testSeasons, reduction: arm.reduction });
  if (result.error) { console.error(`${arm.key}: ${result.error}`); process.exit(1); }
  runs.push({ ...arm, result, significance: combo.significanceTable(result) });
}

const report = {
  version: combo.FORECAST_COMBINATION_VERSION,
  generated_at: new Date().toISOString(),
  elapsed_ms: Date.now() - started,
  data_source: fixture
    ? { kind: 'synthetic_fixture', ...fixture }
    : { kind: 'database', db_path: process.env.GRIDIRON_DB_PATH },
  synthetic: Boolean(fixture),
  test_seasons: testSeasons,
  catalog_size: catalog.length,
  replay_rows: records.length,
  replay_seasons: [...new Set(records.map(r => r.season))].sort(),
  arms: runs.map(r => ({
    key: r.key, label: r.label, reduction: r.reduction,
    common_sample: r.result.common_sample,
    pooled: r.result.pooled, seasons: r.result.seasons, significance: r.significance
  }))
};

const out = value('out', path.join(root, 'server/data',
  fixture ? 'forecast-combination-fixture.json' : 'forecast-combination.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));

/* ------------------------------------------------------------------ console */

console.log(`\n${report.version}  (${report.elapsed_ms} ms)`);
if (report.synthetic) {
  console.log('*** SYNTHETIC FIXTURE — these numbers describe the generator, not football ***');
}
console.log(`replay rows ${report.replay_rows} over seasons ${report.replay_seasons[0]}-${report.replay_seasons.at(-1)}`);
console.log(`held-out test seasons: ${testSeasons.join(', ')}\n`);

const pad = (s, n) => String(s).padEnd(n);

for (const run of runs) {
  const { result, significance } = run;
  console.log('\n' + '='.repeat(86));
  console.log(`ARM: ${run.key} — ${run.label}`);
  console.log('='.repeat(86));

  console.log(`scored on the ${result.common_sample.games} games every method produced a forecast for`);
  console.log(pad('method', 44) + pad('RMSE', 10) + pad('cover-Brier', 13) + pad('n', 7) + 'bias');
  console.log('-'.repeat(82));
  for (const r of significance.ranking) {
    const p = result.pooled[r.method];
    console.log(pad(r.method, 44) + pad(r.rmse ?? '-', 10) + pad(r.cover_brier ?? '-', 13) +
      pad(r.n ?? '-', 7) + (p?.bias ?? '-'));
  }

  console.log(`\nbest by RMSE: ${significance.best_by_rmse}`);
  console.log('\nDiebold-Mariano vs the incumbent (negative DM* = candidate more accurate,');
  console.log('clustered by week, HLN-corrected; p is one-sided "candidate is better"):');
  console.log(pad('candidate', 44) + pad('DM*', 10) + pad('p', 10) + pad('periods', 9) + 'naive t');
  console.log('-'.repeat(86));
  for (const row of significance.vs_baseline) {
    const verdict = row.significantly_better ? '   BETTER'
      : row.significantly_worse ? '   WORSE' : '';
    const note = row.dm_statistic == null ? `   (${row.reason ?? 'not testable'})` : '';
    console.log(pad(row.method, 44) + pad(row.dm_statistic ?? '-', 10) +
      pad(row.dm_p_one_sided_better ?? '-', 10) + pad(row.dm_periods ?? '-', 9) +
      (row.naive_paired_t ?? '-') + verdict + note);
  }

  const bde = significance.best_distinguishable_from_equal_weight;
  console.log('\nis the best method distinguishable from plain equal weighting?');
  console.log(bde == null ? '  the best method IS equal weighting'
    : bde.error ? `  not testable: ${bde.error}`
      : `  DM* ${bde.dm_statistic}, p ${bde.p} -> ${bde.distinguishable ? 'yes'
        : 'NO — equal weighting cannot be distinguished from it, so prefer the simple one'}`);

  for (const s of result.seasons) {
    if (s.skipped) { console.log(`\n  ${s.season}: skipped — ${s.skipped}`); continue; }
    console.log(`\n  ${s.season}: ${s.cutoffs} ${s.refit}ly refits, ` +
      `training ${s.train_rows.first} -> ${s.train_rows.last} rows, tested on ${s.test_rows}`);
    console.log(`    basis usage: ${s.basis_usage.slice(0, 8)
      .map(b => `${b.id}(${Math.round(b.share * 100)}%)`).join(' ')}`);
    const inc = s.methods.incumbent_market_residual?.fit_summary;
    if (inc) {
      console.log(`    incumbent gate at the last cutoff: ${inc.collapses_to_market
        ? 'NOTHING passed — the blend is exactly the market' : inc.gated_components.join(', ')}`);
    }
    for (const [name, m] of Object.entries(s.methods)) {
      console.log(`      ${pad(name, 42)} rmse ${pad(m.rmse ?? '-', 9)} brier ${m.cover_brier ?? '-'}`);
    }
  }
}

console.log('\n' + '='.repeat(86));
console.log('ARM COMPARISON (pooled RMSE)');
console.log('='.repeat(86));
const allMethods = runs[0].result.methods;
console.log(pad('method', 44) + runs.map(r => pad(r.key, 26)).join(''));
for (const m of allMethods) {
  console.log(pad(m, 44) + runs.map(r => pad(r.result.pooled[m]?.rmse ?? '-', 26)).join(''));
}

console.log(`\nwritten: ${out}`);
