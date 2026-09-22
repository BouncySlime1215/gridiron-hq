#!/usr/bin/env node
/**
 * Walk-forward bake-off: the score-driven joint scoring model against the
 * champion market-residual blend.
 *
 * Measurement only. It fits nothing into production, writes no weight, and
 * changes no forecast.
 *
 *   GRIDIRON_DB_PATH=/tmp/some-fresh.sqlite \
 *   SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
 *   node scripts/joint-score-report.mjs --fixture --scoring football \
 *     --test-seasons 2022,2023,2024
 *
 * Flags:
 *   --test-seasons A,B,C  Held-out seasons, each fit only on seasons before it.
 *                         MUST be at or after the ensemble's calibration
 *                         boundary (2022) or the incumbent's own component
 *                         forecasts are not cutoff-safe for that season.
 *   --fixture             Seed the deterministic synthetic league first. ONLY
 *                         valid against an empty scratch database; the numbers
 *                         then describe the fixture generator, not football,
 *                         and the report is stamped synthetic.
 *   --scoring MODE        `gaussian` (the default fixture, whose scoreboard is
 *                         two normals split between the teams) or `football`
 *                         (a drive simulation). See the option's documentation
 *                         in test/helpers/seed-ensemble-fixture.js for exactly
 *                         what each one is and is not evidence for.
 *   --fixture-market-noise S  How far the fixture's market sits from the truth.
 *                         1.6 is the near-oracle default; a large value is the
 *                         control in which the market can actually be beaten.
 *   --iterations N        Nelder-Mead iteration cap per season fit. Default 700.
 *   --out PATH            Where to write the JSON report.
 */
import path from 'node:path';
import url from 'node:url';
import { writeEvidenceReport } from './lib/evidence-report.mjs';

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

const { run, rows } = await import(path.join(root, 'server/db/index.js'));
await (await import(path.join(root, 'server/db/migrate.js')).catch(e => { throw e; })).runMigrations();

const scoring = value('scoring', 'gaussian');
let fixture = null;
if (flag('fixture')) {
  const { seedEnsembleFixture } = await import(path.join(root, 'test/helpers/seed-ensemble-fixture.js'));
  fixture = seedEnsembleFixture({ run, rows }, {
    scoring,
    marketNoise: Number(value('fixture-market-noise', '1.6'))
  });
  console.error(`[fixture] ${JSON.stringify(fixture)}`);
}

const {
  loadJointGames, walkForwardJointScore, championPredictions,
  intersect, scoreSet, compareOn, JOINT_BACKTEST_VERSION
} = await import(path.join(root, 'server/services/joint-score-backtest.js'));
const { JOINT_SCORE_VERSION } = await import(path.join(root, 'server/services/nfl-joint-score.js'));

const testSeasons = (value('test-seasons', '2022,2023,2024') ?? '').split(',').map(Number).filter(Boolean);
const iterations = Number(value('iterations', '700'));

const games = loadJointGames({});
console.error(`[data] ${games.length} games, seasons ${Math.min(...games.map(g => g.season))}-${Math.max(...games.map(g => g.season))}`);

/* ---------------------------------------------------------------- descriptives */

/**
 * What the scoreboard in this database actually looks like.
 *
 * Printed first and on every run, because every number below is conditional on
 * it. A joint score model evaluated on data whose two scoreboards are
 * negatively correlated and which has no key-number structure is being asked a
 * question it was not built to answer, and the reader has to be able to see
 * that before reading the result.
 */
function describeScoring(list) {
  const h = list.map(g => g.home_score), a = list.map(g => g.away_score);
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd = arr => { const m = mean(arr); return Math.sqrt(mean(arr.map(v => (v - m) ** 2))); };
  const mh = mean(h), ma = mean(a);
  let cov = 0;
  for (let i = 0; i < h.length; i++) cov += (h[i] - mh) * (a[i] - ma);
  cov /= h.length;
  const margin = list.map(g => g.home_score - g.away_score);
  const total = list.map(g => g.home_score + g.away_score);
  const keyMass = {};
  for (const k of [3, 6, 7, 10, 14]) {
    keyMass[k] = +(margin.filter(m => Math.abs(m) === k).length / margin.length * 100).toFixed(2);
  }
  return {
    games: list.length,
    home_score_mean: +mh.toFixed(2), away_score_mean: +ma.toFixed(2),
    team_score_sd: +sd(h).toFixed(2),
    score_correlation: +(cov / (sd(h) * sd(a))).toFixed(4),
    margin_mean: +mean(margin).toFixed(2), margin_sd: +sd(margin).toFixed(2),
    total_mean: +mean(total).toFixed(2), total_sd: +sd(total).toFixed(2),
    abs_margin_mass_pct: keyMass,
    impossible_scores: h.concat(a).filter(s => s === 1).length,
    real_nfl_reference: {
      note: 'from margin-distribution.js, measured on 6,991 real games 1999-2024',
      abs_margin_mass_pct: { 3: 15.08, 6: 6.08, 7: 9.03, 10: 5.59, 14: 4.92 }
    }
  };
}

const descriptives = describeScoring(games);
console.error(`[scoring] corr=${descriptives.score_correlation} marginSd=${descriptives.margin_sd} ` +
  `mass@3=${descriptives.abs_margin_mass_pct[3]}% mass@7=${descriptives.abs_margin_mass_pct[7]}%`);

/* ----------------------------------------------------------------- challenger */

console.error('[challenger] walking forward the score-driven joint model...');
const t0 = Date.now();
const challenger = walkForwardJointScore({
  games, testSeasons, maxIterations: iterations,
  onSeason: r => console.error(`  ${r.season}: scaling=${r.scaling} ll/game=${r.train_log_lik_per_game} ` +
    `test=${r.test_games} evals=${r.optimiser?.evaluations}`)
});
console.error(`[challenger] ${challenger.predictions.length} forecasts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.error(`[anchored] per-season market-anchor weights ${JSON.stringify(
  challenger.seasons.map(s => ({ season: s.season, w: s.market_anchor_weight, n: s.market_anchor_train_n })))}`);

/* ------------------------------------------------------------------ incumbent */

console.error('[incumbent] replaying the champion blend at weekly cadence...');
const t1 = Date.now();
const champion = championPredictions({ games, testSeasons });
if (champion.error) {
  console.error(`[incumbent] FAILED: ${champion.error}`);
  process.exit(1);
}
console.error(`[incumbent] ${champion.incumbent.length} forecasts in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

/* ---------------------------------------------------------------- comparison */

const aligned = intersect({
  market: champion.market,
  incumbent: champion.incumbent,
  joint_gas: challenger.predictions,
  joint_gas_independent: challenger.independencePredictions,
  joint_gas_market_anchored: challenger.anchoredPredictions
});

const scores = {};
for (const [name, preds] of Object.entries(aligned)) scores[name] = scoreSet(preds);

/**
 * Every comparison that the research's stated gate asks about, plus the two
 * that decide whether the thing is worth keeping at all.
 */
const comparisons = [];
const pairs = [
  ['joint_gas', 'incumbent', 'Standalone challenger vs the champion. Expected to lose: the champion has the market and this does not.'],
  ['joint_gas', 'market', 'Standalone challenger vs the raw closing line.'],
  ['joint_gas_market_anchored', 'incumbent', 'THE SHIPPING GATE. Challenger blended onto the market, against the champion.'],
  ['joint_gas_market_anchored', 'market', 'Does one weight on this model improve the market at all.'],
  ['incumbent', 'market', 'Control: the champion against its own anchor.'],
  ['joint_gas', 'joint_gas_independent', 'THE DEPENDENCE TEST. Same marginals, shared scoring-event shock on vs off.']
];
for (const [a, b, why] of pairs) {
  if (!aligned[a]?.length || !aligned[b]?.length) continue;
  const entry = { a, b, why, losses: {} };
  for (const loss of ['squared', 'absolute', 'crps', 'log_score', 'cover_brier', 'joint_log_score']) {
    const hasLoss = aligned[a].some(p => Number.isFinite(
      loss === 'joint_log_score' ? p.joint_log_score
        : loss === 'crps' ? p.crps : loss === 'log_score' ? p.log_score : 1));
    if (!hasLoss) continue;
    const dm = compareOn(aligned[a], aligned[b], loss);
    if (!dm?.ok) { entry.losses[loss] = { error: dm?.reason ?? dm?.error ?? 'unavailable' }; continue; }
    entry.losses[loss] = {
      statistic: +dm.statistic.toFixed(3),
      p_two_sided: +dm.pTwoSided.toFixed(4),
      mean_loss_diff: +dm.meanLossDiff.toPrecision(4),
      relative_effect: +dm.relative_effect.toPrecision(3),
      // A degenerate comparison never returns a verdict, however small its
      // p-value. See the guards in compareOn for the two runs that made this
      // necessary.
      verdict: dm.degenerate ? `no verdict: ${dm.degenerate}`
        : dm.pTwoSided >= 0.05 ? 'indistinguishable'
          : (dm.statistic < 0 ? `${a} better` : `${b} better`),
      degenerate: dm.degenerate,
      informative_clusters: dm.informative_clusters,
      clusters: dm.clusters, observations: dm.observations
    };
  }
  comparisons.push(entry);
}

/** Same-game correlation the model actually produced, which is claim (a). */
const corrs = aligned.joint_gas.map(p => p.correlation).filter(Number.isFinite);
const correlationSummary = corrs.length ? {
  n: corrs.length,
  mean: +(corrs.reduce((s, v) => s + v, 0) / corrs.length).toFixed(4),
  min: +Math.min(...corrs).toFixed(4), max: +Math.max(...corrs).toFixed(4),
  realised_in_data: descriptives.score_correlation
} : null;

const report = {
  generated_at: new Date().toISOString(),
  model_version: JOINT_SCORE_VERSION,
  harness_version: JOINT_BACKTEST_VERSION,
  synthetic: Boolean(fixture),
  fixture,
  scoring_mode: fixture ? scoring : 'real-database',
  test_seasons: testSeasons,
  data_disclaimer: fixture
    ? 'SYNTHETIC. Every number below is a property of the fixture generator, not of football. '
      + 'See docs/evidence/2026-09-12/JOINT-SCORING-STAGE-3.md.'
    : 'Run against the configured database.',
  scoring_descriptives: descriptives,
  aligned_games: aligned.joint_gas?.length ?? 0,
  scores,
  comparisons,
  same_game_correlation: correlationSummary,
  // Every held-out forecast, so this evidence can be re-scored or re-tested
  // later without paying for another three-season refit. Stored as a column
  // header plus one array per game rather than 408 objects per method: the
  // object form pretty-printed to 580KB and 31,000 lines, which is not an
  // evidence file anyone opens.
  per_game: {
    columns: ['season', 'week', 'home', 'away', 'actual', 'market', 'forecast',
      'crps', 'log_score', 'joint_log_score', 'cover_probability', 'cover_outcome', 'correlation'],
    rows: Object.fromEntries(Object.entries(aligned).map(([name, preds]) => [name,
      preds.map(p => [
        p.season, p.week, p.home, p.away, p.actual,
        p.market == null ? null : +p.market, +p.forecast.toFixed(4),
        p.crps == null ? null : +p.crps.toFixed(4),
        p.log_score == null ? null : +p.log_score.toFixed(4),
        p.joint_log_score == null ? null : +p.joint_log_score.toFixed(4),
        p.cover_probability == null ? null : +p.cover_probability.toFixed(4),
        p.cover_outcome,
        p.correlation == null ? null : +p.correlation.toFixed(4)
      ])]))
  },
  challenger_seasons: challenger.seasons,
  anchor_weights: challenger.seasons.map(s => ({ season: s.season, weight: s.market_anchor_weight, train_n: s.market_anchor_train_n }))
};

const out = value('out', path.join(root, `docs/evidence/2026-09-12/joint-score-report-${fixture ? scoring : 'real'}.json`));

/* Everything this run actually produced, and what must be non-empty for the
 * bake-off to mean anything.
 *
 * Without this the report writes on an empty run: `aligned_games` reports 0,
 * `comparisons` carries entries whose every field is a degenerate-guard string,
 * `same_game_correlation` is null, and the file lands with a model version, a
 * harness version, a season list and a disclaimer -- everything that makes it
 * look like a measurement, and no measurement. Nothing throws, because the
 * per-comparison guards downstream are written to survive thin data, which is
 * the right behaviour for one comparison and the wrong behaviour for all of them.
 *
 * `test_seasons_requested` is recorded, not required: it is an argument, so
 * requiring it asserts that the caller typed something, which is not a fact
 * about the data.
 */
const SOURCES = {
  test_seasons_requested: testSeasons.length,
  challenger_seasons_fit: challenger.seasons.length,
  aligned_games: aligned.joint_gas?.length ?? 0,
  methods_aligned: Object.keys(aligned).length,
  comparison_pairs: comparisons.length,
  same_game_correlations: correlationSummary?.n ?? 0,
};

// Indent everything except the per-game rows, which stay one line per game:
// the object form pretty-printed to 580KB, which is not an evidence file anyone
// opens. Passed to the guard rather than replacing it, so the refusal stays on
// the write path.
const { file: outFile } = writeEvidenceReport({
  outDir: path.dirname(out), filename: path.basename(out), report,
  sources: SOURCES,
  required: ['challenger_seasons_fit', 'aligned_games', 'methods_aligned',
    'comparison_pairs', 'same_game_correlations'],
  stampAt: 'inputs',
  serialize: (r) => JSON.stringify(r, null, 2)
    .replace(/\[\n\s+(?=(?:-?\d|"[A-Z]))((?:[^[\]]|\[[^\]]*\])*?)\n\s+\]/g,
      (whole, body) => (/^[^{}]*$/.test(body) ? `[${body.replace(/\s*\n\s*/g, ' ')}]` : whole)),
});

console.log(`\n=== ${fixture ? `SYNTHETIC (${scoring} scoring)` : 'DATABASE'} — ${report.aligned_games} held-out games ===`);
console.log('metric'.padEnd(30), 'RMSE'.padStart(9), 'MAE'.padStart(8), 'CRPS'.padStart(9), 'LogS'.padStart(9), 'CovBrier'.padStart(10));
for (const [name, s] of Object.entries(scores)) {
  console.log(name.padEnd(30), String(s.rmse ?? '-').padStart(9), String(s.mae ?? '-').padStart(8),
    String(s.crps ?? '-').padStart(9), String(s.log_score ?? '-').padStart(9), String(s.cover_brier ?? '-').padStart(10));
}
console.log('\n--- Diebold-Mariano (clustered by week; negative statistic = first named is better) ---');
for (const c of comparisons) {
  console.log(`\n${c.a} vs ${c.b}`);
  console.log(`  ${c.why}`);
  for (const [loss, r] of Object.entries(c.losses)) {
    if (r.error) { console.log(`  ${loss.padEnd(16)} ${r.error}`); continue; }
    console.log(`  ${loss.padEnd(16)} DM* ${String(r.statistic).padStart(8)}  p=${String(r.p_two_sided).padStart(6)}  ${r.verdict}`);
  }
}
console.log(`\nwritten: ${outFile}`);
