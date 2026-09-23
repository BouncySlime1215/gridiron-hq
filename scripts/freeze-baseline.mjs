#!/usr/bin/env node
/**
 * Build Order 0.3 — freeze the current fantasy-model accuracy numbers as an
 * immutable artifact.
 *
 * Runs the exact same backtest GET /api/model/accuracy does, then pins two
 * things alongside the numbers: the git commit the code was measured at, and
 * a hash of the exact rows (players + player_week_usage for the graded and
 * prior season) the backtest read. Without both, "we improved the model"
 * is unverifiable — a later number could differ because the code changed,
 * because the dataset was resynced, or because of Monte Carlo noise, and
 * there'd be no way to tell which.
 *
 * Usage: node scripts/freeze-baseline.mjs [season] [--out DIR]
 *        (season defaults to SEASON - 1, --out to docs/evidence/baselines)
 *
 * WHAT THIS REFUSES TO FREEZE. Two preconditions were here already -- no graded
 * season and no prior season each throw. A third was missing, and it is the one
 * that produces a finished-looking artifact: `ids` is the intersection of "has a
 * projection", "played at least 4 games in the graded season" and "appears in the
 * prior season". All three inputs can be non-empty while that intersection is,
 * and then every `gradePoint` call errors out, `.filter(x => !x.error)` removes
 * every row, and the file is written with `players_graded: 0`, an empty `table`,
 * a real git commit and a real dataset hash. A baseline nothing was measured
 * against, pinned as the thing later work must beat.
 *
 * `datasetHash` is not a guard against that. It hashes whatever the two queries
 * return, and an empty result set hashes perfectly well.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveOutDir, writeEvidenceReport } from './lib/evidence-report.mjs';
import { rows } from '../server/db/index.js';
import { buildProjections, seasonDistribution } from '../server/services/projections.js';
import { actuals, gradePoint, gradeDistribution, weeklyDecisionBacktest } from '../server/services/backtest.js';
import { withRandomSeed } from '../server/services/stats-util.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEASON = Number(process.env.NFL_SEASON) || 2026;
const season = Number(process.argv[2]) || SEASON - 1;

function gitInfo() {
  const opts = { cwd: ROOT, encoding: 'utf8' };
  try {
    return {
      commit: execSync('git rev-parse HEAD', opts).trim(),
      dirty: execSync('git status --porcelain', opts).trim().length > 0
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

/**
 * Fingerprints exactly the rows this backtest reads, so a resync is detectable.
 *
 * Also COUNTS them. The hash alone cannot distinguish "the dataset changed" from
 * "there was no dataset": an empty result set has a perfectly stable digest.
 */
const datasetCounts = {};
function datasetHash(season) {
  const hash = createHash('sha256');
  const players = rows('SELECT * FROM players ORDER BY id');
  const usage = rows(
    'SELECT * FROM player_week_usage WHERE season IN (?, ?) ORDER BY player_id, season, week',
    season, season - 1);
  datasetCounts.players_rows_read = players.length;
  datasetCounts.player_week_usage_rows_read = usage.length;
  hash.update(JSON.stringify(players));
  hash.update(JSON.stringify(usage));
  return hash.digest('hex');
}

const truth = actuals(season);
if (!truth.size) throw new Error(`no weekly usage data for ${season} — sync nflverse first`);
const proj = buildProjections({ through: season - 1 });
if (!proj.size) throw new Error(`no usage data before ${season} to build a projection from`);

// Same construction as the /api/model/accuracy route: grade every source on
// one identical player set, or the comparison means nothing.
const prior = actuals(season - 1);
const ids = [...proj.keys()].filter(id => truth.get(id)?.games >= 4 && prior.has(id));
const t = new Map(ids.map(id => [id, truth.get(id)]));
const mk = f => new Map(ids.map(id => [id, f(id)]));
const sources = {
  'Gridiron model': mk(id => proj.get(id).points),
  'Last season points': mk(id => prior.get(id).points),
  'Last season ppg x 17': mk(id => prior.get(id).ppg * 17),
  'Blend (60/40)': mk(id => 0.6 * proj.get(id).points + 0.4 * prior.get(id).points)
};
const table = Object.entries(sources)
  .map(([source, preds]) => ({ source, ...gradePoint(preds, t) }))
  .filter(x => !x.error)
  .sort((a, b) => (b.spearman ?? -1) - (a.spearman ?? -1));

// Fixed seed: the whole point of freezing this report is that rerunning it
// against the same commit and the same data reproduces the same number.
const samples = new Map();
withRandomSeed(20260826, () => {
  for (const id of ids.slice(0, 150)) samples.set(id, seasonDistribution(proj.get(id), { runs: 300 }).samples);
});

const report = {
  frozen_at: new Date().toISOString(),
  season,
  players_graded: ids.length,
  table,
  distribution: gradeDistribution(samples, t),
  weekly_decisions: weeklyDecisionBacktest(proj, truth),
  code: gitInfo(),
  dataset_hash: datasetHash(season),
  note: 'Reproduce with: node scripts/freeze-baseline.mjs ' + season +
    ' — checkout the pinned commit first if HEAD has since moved.'
};

// Relocated 2026-09-10 with the documentation consolidation (see
// docs/reference/architecture/FOLDER-REORGANIZATION.md): baselines are frozen
// evidence and live under docs/evidence/ with the rest of it.
//
// `--out` so the generator can be exercised without overwriting the committed
// baseline it would be compared against.
const dir = resolveOutDir(process.argv, join(ROOT, 'docs', 'evidence', 'baselines'), ROOT);

// Everything real this run read or graded. The three counts that can be zero
// while the run still completes are required; `table_rows` is required too,
// because a scored table with no rows in it is the artifact this guard exists
// to stop.
const SOURCES = {
  players_rows_read: datasetCounts.players_rows_read,
  player_week_usage_rows_read: datasetCounts.player_week_usage_rows_read,
  graded_season_players: truth.size,
  projected_players: proj.size,
  prior_season_players: prior.size,
  common_player_set: ids.length,
  table_rows: table.length,
  distribution_samples: samples.size,
};

const { file, report: written } = writeEvidenceReport({
  outDir: dir, filename: `${season}-baseline.json`, report,
  sources: SOURCES,
  required: ['players_rows_read', 'player_week_usage_rows_read', 'graded_season_players',
    'projected_players', 'prior_season_players', 'common_player_set', 'table_rows',
    'distribution_samples'],
  stampAt: 'inputs',
  serialize: (r) => JSON.stringify(r, null, 2) + '\n',
});

console.log(`Wrote ${file}`);
console.table(table.map(({ source, n, mae, spearman, r2 }) => ({ source, n, mae, spearman, r2 })));
console.log('dataset_hash:', written.dataset_hash);
console.log('inputs:', written.inputs.sources);
