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
 * Usage: node scripts/freeze-baseline.mjs [season]   (defaults to SEASON - 1)
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

/** Fingerprints exactly the rows this backtest reads, so a resync is detectable. */
function datasetHash(season) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(rows('SELECT * FROM players ORDER BY id')));
  hash.update(JSON.stringify(rows(
    'SELECT * FROM player_week_usage WHERE season IN (?, ?) ORDER BY player_id, season, week',
    season, season - 1)));
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

const dir = join(ROOT, 'docs', 'baselines');
mkdirSync(dir, { recursive: true });
const path = join(dir, `${season}-baseline.json`);
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');

console.log(`Wrote ${path}`);
console.table(table.map(({ source, n, mae, spearman, r2 }) => ({ source, n, mae, spearman, r2 })));
console.log('dataset_hash:', report.dataset_hash);
console.log('code:', report.code);
