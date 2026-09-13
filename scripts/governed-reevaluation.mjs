#!/usr/bin/env node
/**
 * Re-grade stages 2 and 3 against the incumbent under ONE governed procedure,
 * rather than letting each stage mark its own homework.
 *
 * Stage 2 chose Diebold-Mariano on pooled squared error, clustered by week.
 * Stage 3 chose CRPS plus a Holm correction across five metrics. Both are
 * defensible, both were chosen by the stage that was being graded, and neither
 * was declared before its own numbers were visible. That is the thing
 * `governedComparison` exists to remove, so it is applied here to both stages'
 * OWN held-out predictions, under rules fixed before either was opened.
 *
 * Two honest constraints are wired into how it is run, and they matter more
 * than any number it prints:
 *
 * 1. LOOKS = 2. Each stage has already tested these exact sequences once. A
 *    second look at a fixed-sample p-value is the CLV failure mode, so the
 *    comparison is told it is a second look and must clear gate 5.
 *
 * 2. SIGMA IS DECLARED FROM A DISJOINT PREFIX. Gate 5 is only satisfiable with
 *    a sigma that is not a function of the sequence under test. The first
 *    held-out season is spent estimating sigma and is then DISCARDED; the
 *    verdict is computed on the seasons after it. That costs a third of the
 *    sample and is the only construction here that is actually valid.
 *
 *    Two cheaper constructions were tried first and are reported as
 *    sensitivities rather than quietly dropped, because both are wrong in
 *    instructive ways:
 *
 *      PLUG-IN sigma (estimated from the sequence under test) is what
 *      `alwaysValidPValue` explicitly refuses to call anytime-valid. Valid at
 *      one endpoint; this is a second look, so it is not available.
 *
 *      SIBLING-FIXTURE sigma (each fixture borrowing its twin's) satisfies the
 *      letter of "declared in advance" and fails the spirit. The two fixtures
 *      differ only in market noise, but that is enough: on the near-oracle run
 *      the borrowed sigma came out up to 132x TOO LARGE, which is merely
 *      conservative, while on the weak-market run it came out too SMALL, which
 *      is not — it manufactured six promotions that the plug-in sigma calls
 *      inconclusive. A mis-specified sigma breaks the martingale guarantee as
 *      surely as a plug-in one, and in a direction nobody can predict in
 *      advance. Both are kept in the output so the size of the effect is on
 *      the record.
 *
 *   GRIDIRON_DB_PATH=/tmp/fresh.sqlite SCHEDULER_DISABLED=1 \
 *     NODE_OPTIONS='--import ./test/offline-guard.mjs' \
 *     node scripts/governed-reevaluation.mjs
 *
 * Reads no live data, calls no network, writes only its own report.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

if (!process.env.GRIDIRON_DB_PATH) {
  console.error('Refusing to run without GRIDIRON_DB_PATH pointed at a fresh scratch path.');
  process.exit(1);
}

const { governedComparison, alignLosses } = await import(path.join(root, 'server/modeling/governed-comparison.js'));

const EVIDENCE = path.join(root, 'docs/evidence/2026-09-12');
const ALPHA = 0.05;
const LOOKS = 2;                 // each stage already tested these sequences once
const MIN_CLUSTERS = 20;
/* The first held-out season is spent estimating sigma and is then discarded.
 * Both stages held out 2022, 2023 and 2024, so this costs a third of the sample
 * and buys the only sigma here that the mSPRT's derivation actually permits. */
const CALIBRATION_SEASON = 2022;

/* Minimum effects, declared here rather than derived from any result below.
 * A margin forecaster that moves RMSE by less than a tenth of a point, or CRPS
 * by less than 0.05, is not worth a deployment whatever its p-value. Expressed
 * on the LOSS scale the comparison actually uses (squared error, not RMSE). */
const MIN_EFFECT = {
  squared: 2.0,        // ~0.075 of a point of RMSE around an RMSE of 13
  absolute: 0.10,
  crps: 0.05,
  log_score: 0.02,
  cover_brier: 0.002
};

const sd = xs => {
  const v = xs.filter(Number.isFinite);
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
};

/**
 * sigma of the paired difference sequence, PER CHALLENGER and per metric.
 *
 * Per challenger matters more than it looks. A first version of this took the
 * maximum across every challenger in the sibling run, which handed
 * `market_only` — whose difference sequence has sd 0.58 — a declared sigma of
 * 136.9 borrowed from `equal_weight_all`. The mSPRT is conservative in sigma,
 * so that did not produce false promotions; it produced an adjusted p of 1.00
 * on every comparison in the run and would have reported "nothing is
 * distinguishable" as though it were a finding about the models rather than
 * about a 237x mis-specified nuisance parameter.
 */
function siblingSigma(alignedByChallenger) {
  const out = {};
  for (const [challenger, aligned] of Object.entries(alignedByChallenger)) {
    out[challenger] = {};
    for (const metric of Object.keys(aligned.a)) {
      const diffs = aligned.a[metric].map((x, i) => aligned.b[metric][i] - x);
      const s = sd(diffs);
      if (s != null) out[challenger][metric] = s;
    }
  }
  return out;
}

/**
 * A challenger's declared sigma: the same challenger's difference sd in the
 * sibling fixture. Falls back to nothing (rather than to somebody else's
 * sigma) when the sibling did not run that challenger — a missing sigma makes
 * gate 5 fire, which is the correct outcome, not a reason to substitute.
 */
const declaredFor = (sigmaByChallenger, challenger) => sigmaByChallenger?.[challenger] ?? {};

/* A sigma of exactly zero is a FINDING, not a missing value: it means the two
 * models produced identical losses on every calibration observation. Reporting
 * it as null would hide that behind "no sigma available". */
const show = x => (Number.isFinite(x) ? +x.toFixed(4) : null);

/** The plug-in sigma, for the sensitivity pass only. Never anytime-valid. */
function pluginSigma(aligned) {
  const out = {};
  for (const metric of Object.keys(aligned.a)) {
    const s = sd(aligned.a[metric].map((x, i) => aligned.b[metric][i] - x));
    if (s != null) out[metric] = s;
  }
  return out;
}

/**
 * Split an aligned pair chronologically: an early CALIBRATION block that is
 * spent estimating sigma and then thrown away, and a later TEST block that the
 * verdict is computed on.
 *
 * Both blocks come from the same data-generating process, and the test block
 * contains none of the observations sigma was estimated from, which is exactly
 * what the mSPRT's derivation requires and what neither the plug-in nor the
 * sibling construction provides.
 */
function splitForSigma(aligned, isCalibration) {
  const metrics = Object.keys(aligned.a);
  const blank = () => ({ a: Object.fromEntries(metrics.map(m => [m, []])),
    b: Object.fromEntries(metrics.map(m => [m, []])), groups: [], keys: [] });
  const calib = blank(), test = blank();
  aligned.keys.forEach((key, i) => {
    const target = isCalibration(key) ? calib : test;
    for (const m of metrics) { target.a[m].push(aligned.a[m][i]); target.b[m].push(aligned.b[m][i]); }
    target.groups.push(aligned.groups[i]);
    target.keys.push(key);
  });
  calib.matched = calib.keys.length; test.matched = test.keys.length;
  return { calib, test };
}

/** Seasons are the first field of the alignment key. */
const seasonOf = key => Number(String(key).split('|')[0]);

/* ============================================================= stage 3 */

const STAGE3_COLUMNS = ['season', 'week', 'home', 'away', 'actual', 'market', 'forecast',
  'crps', 'log_score', 'joint_log_score', 'cover_probability', 'cover_outcome', 'correlation'];

function stage3Records(report, model) {
  const rows = report.per_game?.rows?.[model];
  if (!rows) return null;
  const idx = Object.fromEntries(report.per_game.columns.map((c, i) => [c, i]));
  return rows.map(r => {
    const rec = {};
    for (const c of STAGE3_COLUMNS) rec[c] = r[idx[c]];
    return rec;
  });
}

const STAGE3_LOSSES = {
  squared: r => (r.forecast - r.actual) ** 2,
  absolute: r => Math.abs(r.forecast - r.actual),
  crps: r => r.crps,
  log_score: r => r.log_score,
  cover_brier: r => (r.cover_probability != null && r.cover_outcome != null
    ? (r.cover_probability - r.cover_outcome) ** 2 : null)
};

function alignStage3(report, incumbentKey, challengerKey) {
  const a = stage3Records(report, incumbentKey);
  const b = stage3Records(report, challengerKey);
  if (!a || !b) return null;
  return alignLosses(a, b, {
    key: r => `${r.season}|${r.week}|${r.home}|${r.away}`,
    order: r => Number(r.season) * 100 + Number(r.week),
    cluster: r => `${r.season}|${r.week}`,
    losses: STAGE3_LOSSES
  });
}

function runStage3() {
  const fixtures = {
    football: JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'joint-score-report-football.json'), 'utf8')),
    gaussian: JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'joint-score-report-gaussian.json'), 'utf8'))
  };
  const incumbent = 'incumbent';
  const challengers = ['joint_gas', 'joint_gas_independent', 'joint_gas_market_anchored'];

  const aligned = {};
  for (const [name, report] of Object.entries(fixtures)) {
    aligned[name] = {};
    for (const c of challengers) {
      const al = alignStage3(report, incumbent, c);
      if (al) aligned[name][c] = al;
    }
  }
  const sigma = { football: siblingSigma(aligned.gaussian), gaussian: siblingSigma(aligned.football) };

  const results = [];
  for (const [fixture, byChallenger] of Object.entries(aligned)) {
    for (const [challenger, al] of Object.entries(byChallenger)) {
      const { calib, test } = splitForSigma(al, key => seasonOf(key) === CALIBRATION_SEASON);
      const holdoutSigma = pluginSigma(calib);          // from data the verdict never sees
      const plugin = pluginSigma(test);
      const sibling = declaredFor(sigma[fixture], challenger);
      for (const primaryMetric of ['crps', 'squared']) {
        const onTest = lbl => ({ groups: test.groups, primaryMetric, alpha: ALPHA,
          minEffect: MIN_EFFECT, minClusters: MIN_CLUSTERS,
          incumbent: { label: `stage3:${fixture}:incumbent`, losses: test.a },
          challenger: { label: `stage3:${fixture}:${challenger}${lbl}`, losses: test.b } });
        const governed = governedComparison({ ...onTest(''), looks: LOOKS, sigma: holdoutSigma });
        const withPlugin = governedComparison({ ...onTest(''), looks: 1, sigma: {} });
        const withSibling = governedComparison({ ...onTest(''), looks: LOOKS, sigma: sibling });
        // The arm that isolates the RULES from the sample reduction: the full
        // sample and the plug-in sigma, i.e. exactly what the stage itself was
        // working with, judged by the governed rules. Any difference between
        // this and the stage's own conclusion is the rules; any difference
        // between this and `governed` is the third of the sample spent on sigma.
        const fullSample = governedComparison({
          groups: al.groups, primaryMetric, alpha: ALPHA, looks: 1, sigma: {},
          minEffect: MIN_EFFECT, minClusters: MIN_CLUSTERS,
          incumbent: { label: 'full', losses: al.a }, challenger: { label: 'full', losses: al.b } });
        results.push({
          stage: 3, fixture, challenger, primary_metric: primaryMetric,
          calibration_season: CALIBRATION_SEASON,
          calibration_games: calib.matched, matched: test.matched, dropped: al.dropped,
          declared_sigma: show(holdoutSigma[primaryMetric]),
          plugin_sigma: show(plugin[primaryMetric]),
          sibling_sigma: show(sibling[primaryMetric]),
          sensitivity_plugin_sigma: { verdict: withPlugin.verdict,
            p_adjusted: withPlugin.metrics?.[primaryMetric]?.p_adjusted ?? null, anytime_valid: false },
          sensitivity_sibling_sigma: { verdict: withSibling.verdict,
            p_adjusted: withSibling.metrics?.[primaryMetric]?.p_adjusted ?? null },
          rules_only_full_sample: { verdict: fullSample.verdict, games: al.matched,
            clusters: fullSample.independent_clusters,
            improvement: fullSample.metrics?.[primaryMetric]?.improvement ?? null,
            p_adjusted: fullSample.metrics?.[primaryMetric]?.p_adjusted ?? null,
            blockers: fullSample.blockers },
          ...governed
        });
      }
    }
  }
  return { results, sigma };
}

/* ============================================================= stage 2 */

const STAGE2_LOSSES = {
  squared: p => (p.forecast - p.actual) ** 2,
  absolute: p => Math.abs(p.forecast - p.actual),
  cover_brier: p => (p.cover_probability != null && p.cover_outcome != null
    ? (p.cover_probability - p.cover_outcome) ** 2 : null)
};

/**
 * One fixture, one process.
 *
 * Stage 2's predictions have to be regenerated (its report stores pooled
 * scores, not per-game rows), and the fixture is seeded into a database that
 * `server/db/index.js` resolves ONCE per process from GRIDIRON_DB_PATH. Two
 * fixtures in one process therefore cannot both be read: a query-string
 * cache-bust re-instantiates the module it is applied to but not the db
 * singleton its dependencies import, so the second fixture would be seeded into
 * one database and replayed out of another. Silently. The child process is the
 * fix that cannot be got subtly wrong.
 */
async function emitStage2Fixture(marketNoise, outPath) {
  const { run, rows } = await import(path.join(root, 'server/db/index.js'));
  await (await import(path.join(root, 'server/db/migrate.js'))).runMigrations();
  const { seedEnsembleFixture } = await import(path.join(root, 'test/helpers/seed-ensemble-fixture.js'));
  const fixture = seedEnsembleFixture({ run, rows }, { latentFactors: 3, noise: 0.35, marketNoise });

  const ensemble = await import(path.join(root, 'server/services/nfl-ensemble.js'));
  const combo = await import(path.join(root, 'server/services/forecast-combination.js'));

  const inputs = ensemble.ensembleReplayInputs({});
  const records = [...ensemble.componentPredictionStream({ ...inputs })];
  if (!records.length) throw new Error('no component predictions — the fixture did not seed');
  const componentIdList = ensemble.componentIds().map(c => c.id);
  const result = combo.walkForwardCombination({
    records, componentIdList, testSeasons: [2022, 2023, 2024],
    reduction: { maxComponents: 6, maxExplained: 0.90, skillScreen: 'none' }
  });
  if (result.error) throw new Error(`walkForwardCombination: ${result.error}`);

  const predictions = Object.fromEntries([...result.predictions].map(([method, preds]) => [method,
    preds.map(p => ({ season: p.season, week: p.week, home: p.home, away: p.away,
      forecast: p.forecast, actual: p.actual,
      cover_probability: p.cover_probability ?? null, cover_outcome: p.cover_outcome ?? null }))]));
  fs.writeFileSync(outPath, JSON.stringify({ fixture, methods: result.methods, pooled: result.pooled, predictions }));
}

/* Child-process mode: emit one fixture's per-game predictions and exit. */
const emitNoise = value('stage2-fixture', null);
if (emitNoise != null) {
  await emitStage2Fixture(Number(emitNoise), value('emit'));
  process.exit(0);
}

async function runStage2() {
  const { spawnSync } = await import('node:child_process');
  const scratch = path.dirname(process.env.GRIDIRON_DB_PATH);
  const runs = {};
  for (const [name, marketNoise] of [['oracle_market', 1.6], ['weak_market', 7]]) {
    const dbPath = path.join(scratch, `governed-stage2-${name}-${process.pid}.sqlite`);
    const outPath = path.join(scratch, `governed-stage2-${name}-${process.pid}.json`);
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + suffix); } catch { /* fresh */ } }
    const child = spawnSync(process.execPath, [url.fileURLToPath(import.meta.url),
      '--stage2-fixture', String(marketNoise), '--emit', outPath], {
      env: { ...process.env, GRIDIRON_DB_PATH: dbPath, SCHEDULER_DISABLED: '1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024
    });
    if (child.status !== 0) {
      console.error(child.stderr?.slice(-4000) ?? '');
      throw new Error(`stage 2 fixture ${name} failed with status ${child.status}`);
    }
    runs[name] = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }

  const incumbent = 'incumbent_market_residual';
  const aligned = {};
  for (const [name, r] of Object.entries(runs)) {
    aligned[name] = {};
    const inc = r.predictions[incumbent] ?? [];
    for (const method of r.methods) {
      if (method === incumbent) continue;
      const cand = r.predictions[method] ?? [];
      const al = alignLosses(inc, cand, {
        key: p => `${p.season}|${p.week}|${p.home}|${p.away}`,
        order: p => Number(p.season) * 100 + Number(p.week),
        cluster: p => `${p.season}|${p.week}`,
        losses: STAGE2_LOSSES
      });
      if (al.matched) aligned[name][method] = al;
    }
  }
  const sigma = { oracle_market: siblingSigma(aligned.weak_market), weak_market: siblingSigma(aligned.oracle_market) };

  const results = [];
  for (const [fixture, byMethod] of Object.entries(aligned)) {
    for (const [method, al] of Object.entries(byMethod)) {
      const { calib, test } = splitForSigma(al, key => seasonOf(key) === CALIBRATION_SEASON);
      const holdoutSigma = pluginSigma(calib);
      const plugin = pluginSigma(test);
      const sibling = declaredFor(sigma[fixture], method);
      const common = { groups: test.groups, primaryMetric: 'squared', alpha: ALPHA,
        minEffect: MIN_EFFECT, minClusters: MIN_CLUSTERS,
        incumbent: { label: `stage2:${fixture}:${incumbent}`, losses: test.a },
        challenger: { label: `stage2:${fixture}:${method}`, losses: test.b } };
      const governed = governedComparison({ ...common, looks: LOOKS, sigma: holdoutSigma });
      const withPlugin = governedComparison({ ...common, looks: 1, sigma: {} });
      const withSibling = governedComparison({ ...common, looks: LOOKS, sigma: sibling });
      const fullSample = governedComparison({
        groups: al.groups, primaryMetric: 'squared', alpha: ALPHA, looks: 1, sigma: {},
        minEffect: MIN_EFFECT, minClusters: MIN_CLUSTERS,
        incumbent: { label: 'full', losses: al.a }, challenger: { label: 'full', losses: al.b } });
      results.push({
        stage: 2, fixture, challenger: method, primary_metric: 'squared',
        calibration_season: CALIBRATION_SEASON,
        calibration_games: calib.matched, matched: test.matched, dropped: al.dropped,
        declared_sigma: show(holdoutSigma.squared),
        plugin_sigma: show(plugin.squared),
        sibling_sigma: show(sibling.squared),
        sensitivity_plugin_sigma: { verdict: withPlugin.verdict,
          p_adjusted: withPlugin.metrics?.squared?.p_adjusted ?? null, anytime_valid: false },
        sensitivity_sibling_sigma: { verdict: withSibling.verdict,
          p_adjusted: withSibling.metrics?.squared?.p_adjusted ?? null },
        rules_only_full_sample: { verdict: fullSample.verdict, games: al.matched,
          clusters: fullSample.independent_clusters,
          improvement: fullSample.metrics?.squared?.improvement ?? null,
          p_adjusted: fullSample.metrics?.squared?.p_adjusted ?? null,
          blockers: fullSample.blockers },
        ...governed
      });
    }
  }
  return { results, sigma, fixtures: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.fixture])),
    pooled: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.pooled])) };
}

/* ============================================================= report */

const started = Date.now();
const stage3 = runStage3();
const stage2 = await runStage2();

const report = {
  generated_at: new Date().toISOString(),
  elapsed_ms: Date.now() - started,
  synthetic: true,
  governance: { alpha: ALPHA, looks: LOOKS, min_clusters: MIN_CLUSTERS, min_effect: MIN_EFFECT,
    calibration_season: CALIBRATION_SEASON,
    sigma_policy: 'sigma is estimated on the first held-out season, which is then DISCARDED; the verdict ' +
      'is computed on the later seasons only. Plug-in and sibling-fixture sigmas are reported as ' +
      'sensitivities and are NOT the basis of any verdict.' },
  stage2: stage2.results, stage3: stage3.results,
  stage2_sigma: stage2.sigma, stage3_sigma: stage3.sigma,
  stage2_fixtures: stage2.fixtures, stage2_pooled: stage2.pooled
};

const out = value('out', path.join(EVIDENCE, 'governed-reevaluation.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
const line = n => console.log('='.repeat(n));

console.log(`\nGOVERNED RE-EVALUATION  (${report.elapsed_ms} ms)`);
console.log('*** every input is a SYNTHETIC fixture — these verdicts are about code and procedure, not football ***');
console.log(`alpha ${ALPHA}, looks ${LOOKS}, min clusters ${MIN_CLUSTERS}`);
console.log(`sigma: estimated on season ${CALIBRATION_SEASON}, which is then DISCARDED; verdicts use the later seasons only\n`);

for (const [label, rows] of [['STAGE 2 — forecast combination', stage2.results],
  ['STAGE 3 — joint scoring', stage3.results]]) {
  line(146); console.log(label); line(146);
  console.log(pad('fixture', 15) + pad('challenger', 34) + pad('primary', 10) +
    pad('improve', 11) + pad('adj p', 10) + pad('plug-in', 14) + pad('rules/full-n', 14) +
    pad('clusters', 9) + pad('VERDICT', 14) + 'first blocker');
  console.log('-'.repeat(146));
  for (const r of rows) {
    const p = r.metrics?.[r.primary_metric];
    console.log(pad(r.fixture, 15) + pad(String(r.challenger).slice(0, 32), 34) + pad(r.primary_metric, 10) +
      pad(p?.improvement ?? '-', 11) + pad(p?.p_adjusted ?? '-', 10) +
      pad(r.sensitivity_plugin_sigma?.verdict ?? '-', 14) +
      pad(r.rules_only_full_sample?.verdict ?? '-', 14) +
      pad(r.independent_clusters ?? '-', 9) + pad(r.verdict, 14) +
      (r.blockers?.[0]?.split(':')[0] ?? ''));
  }
  console.log();
}

console.log('sigma mis-specification on the primary metric (declared cross-fixture / plug-in).');
console.log('The mSPRT is CONSERVATIVE in sigma: a ratio above 1 widens the null and makes a verdict');
console.log('harder to reach, so any "inconclusive" beside a large ratio may be the sigma, not the model.');
const ratios = [...stage2.results, ...stage3.results]
  .filter(r => r.declared_sigma != null && r.plugin_sigma)
  .map(r => ({ ...r, ratio: r.declared_sigma / r.plugin_sigma }))
  .sort((x, y) => y.ratio - x.ratio);
for (const r of ratios.slice(0, 8)) {
  console.log(`  stage ${r.stage} ${pad(r.fixture, 14)} ${pad(String(r.challenger).slice(0, 34), 36)} ` +
    `x${r.ratio.toFixed(2)}   (declared ${r.declared_sigma}, plug-in ${r.plugin_sigma})`);
}
/* ---------------------------------------------------------------- overturns
 *
 * The number the exercise is actually for: how often the governed rules, run
 * on each stage's OWN sample with each stage's OWN entitlement (one look,
 * plug-in sigma), reach a different conclusion than the stage did. Anything
 * that differs here is the rules; anything that differs between this and the
 * headline verdict is the third of the sample spent on sigma.
 */
function stage2OwnVerdicts() {
  const out = {};
  for (const [fixture, file] of [['oracle_market', 'forecast-combination-fixture-oracle-market.json'],
    ['weak_market', 'forecast-combination-fixture-weak-market.json']]) {
    const j = JSON.parse(fs.readFileSync(path.join(EVIDENCE, file), 'utf8'));
    out[fixture] = {};
    for (const row of j.arms[0].significance.vs_baseline) {
      out[fixture][row.method] = row.significantly_better ? 'better'
        : row.significantly_worse ? 'worse' : 'indistinguishable';
    }
  }
  return out;
}
function stage3OwnVerdicts() {
  const out = {};
  for (const [fixture, file] of [['football', 'joint-score-report-football.json'],
    ['gaussian', 'joint-score-report-gaussian.json']]) {
    const j = JSON.parse(fs.readFileSync(path.join(EVIDENCE, file), 'utf8'));
    out[fixture] = {};
    for (const c of j.comparisons) {
      if (c.b !== 'incumbent') continue;
      for (const [loss, metric] of [['crps', 'crps'], ['squared', 'squared']]) {
        const v = c.losses?.[loss];
        if (!v || v.error) continue;
        // stage 3 reports the loss difference as a - b, so negative = a better.
        out[fixture][`${c.a}|${metric}`] = v.verdict === 'indistinguishable' ? 'indistinguishable'
          : (v.mean_loss_diff < 0 ? 'better' : 'worse');
      }
    }
  }
  return out;
}

const own2 = stage2OwnVerdicts(), own3 = stage3OwnVerdicts();
const GOVERNED_TO_OWN = { promote: 'better', reject: 'worse', inconclusive: 'indistinguishable' };
const overturns = [];
for (const r of stage2.results) {
  const method = String(r.challenger).split(':').pop();
  const stageSaid = own2[r.fixture]?.[method];
  if (!stageSaid) continue;
  const rulesSaid = GOVERNED_TO_OWN[r.rules_only_full_sample.verdict];
  overturns.push({ stage: 2, fixture: r.fixture, challenger: method, metric: r.primary_metric,
    stage_said: stageSaid, governed_rules_said: rulesSaid, headline_verdict: r.verdict,
    overturned: stageSaid !== rulesSaid });
}
for (const r of stage3.results) {
  // governedComparison's own `challenger` field (a label) overwrites the bare
  // method name on the spread, so recover the name the stage reports it under.
  const method = String(r.challenger).split(':').pop();
  const stageSaid = own3[r.fixture]?.[`${method}|${r.primary_metric}`];
  if (!stageSaid) continue;
  const rulesSaid = GOVERNED_TO_OWN[r.rules_only_full_sample.verdict];
  overturns.push({ stage: 3, fixture: r.fixture, challenger: method, metric: r.primary_metric,
    stage_said: stageSaid, governed_rules_said: rulesSaid, headline_verdict: r.verdict,
    overturned: stageSaid !== rulesSaid });
}
report.overturns = overturns;
fs.writeFileSync(out, JSON.stringify(report, null, 2));

line(146);
console.log('OVERTURNS — the stage\'s own conclusion vs the governed rules on the SAME sample and sigma');
line(146);
console.log(pad('stage', 7) + pad('fixture', 15) + pad('challenger', 36) + pad('metric', 9) +
  pad('stage said', 19) + pad('governed rules say', 21) + 'overturned');
console.log('-'.repeat(146));
for (const o of overturns) {
  console.log(pad(o.stage, 7) + pad(o.fixture, 15) + pad(String(o.challenger).slice(0, 34), 36) +
    pad(o.metric, 9) + pad(o.stage_said, 19) + pad(o.governed_rules_said, 21) +
    (o.overturned ? 'YES' : ''));
}
const n = overturns.filter(o => o.overturned).length;
console.log(`\n${n} of ${overturns.length} comparisons overturned by the governance rules alone.`);
for (const dir of [['better', 'indistinguishable'], ['worse', 'indistinguishable'],
  ['indistinguishable', 'better'], ['indistinguishable', 'worse']]) {
  const c = overturns.filter(o => o.stage_said === dir[0] && o.governed_rules_said === dir[1]).length;
  if (c) console.log(`  ${c}x  "${dir[0]}" -> "${dir[1]}"`);
}

const all = [...stage2.results, ...stage3.results];
for (const [name, field] of [['plug-in', 'sensitivity_plugin_sigma'], ['sibling-fixture', 'sensitivity_sibling_sigma']]) {
  const disagree = all.filter(r => r[field] && r[field].verdict !== r.verdict);
  console.log(`\nverdicts that CHANGE under the ${name} sigma instead of the hold-out sigma: ${disagree.length}`);
  for (const r of disagree) {
    console.log(`  stage ${r.stage} ${pad(r.fixture, 14)} ${pad(String(r.challenger).slice(0, 34), 36)} ` +
      `holdout=${pad(r.verdict, 13)} ${name}=${r[field].verdict}`);
  }
}
const noSigma = all.filter(r => !(r.declared_sigma > 0));
if (noSigma.length) {
  console.log(`\ncomparisons where the calibration season could not supply a sigma: ${noSigma.length}`);
  console.log('  (the two models had identical losses on every calibration observation, so the paired');
  console.log('   difference had zero variance — gate 5 fires, which is the correct outcome)');
  for (const r of noSigma) {
    console.log(`  stage ${r.stage} ${pad(r.fixture, 14)} ${pad(String(r.challenger).slice(0, 34), 36)} ` +
      `calib sigma ${r.declared_sigma}`);
  }
}

const falsePromotions = all.filter(r => r.sensitivity_sibling_sigma?.verdict === 'promote' && r.verdict !== 'promote');
if (falsePromotions.length) {
  console.log(`\nPROMOTIONS THE SIBLING-FIXTURE SIGMA WOULD HAVE MANUFACTURED: ${falsePromotions.length}`);
  console.log('  (its sigma was too small on that fixture, which is the anti-conservative direction)');
}

console.log(`\npromoted by the governed procedure: ` +
  ([...stage2.results, ...stage3.results].filter(r => r.promotable).map(r => `${r.fixture}/${r.challenger}`).join(', ') || 'NONE'));
console.log(`written: ${out}`);
