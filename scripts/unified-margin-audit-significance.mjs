/**
 * Week-clustered significance for a unified-margin audit run.
 *
 * `research/betting/nfl/unified_margin_audit.py` deliberately computes no
 * interval of its own -- this project already has exactly one tested block
 * bootstrap (`pairedBootstrapDiff`, which resamples whole clusters rather
 * than individual units for the Brill/Yurko/Wyner reason documented there),
 * and a second implementation in Python would be a second thing to keep
 * correct. This script is the seam: it reads that run's `predictions.json`
 * and hands the paired absolute errors to the existing function, clustered
 * by the week the model was refit for.
 *
 * Usage:
 *   node scripts/unified-margin-audit-significance.mjs <run-directory> [--a FIELD] [--b FIELD] [--b-run DIR]
 *
 * `--a`/`--b` pick which two `predictions.json` fields to compare (default
 * `unified`/`market`, the original comparison). Phase 1 also writes
 * `correction`/`football_alone` fields -- e.g.
 *   --a correction --b market
 *   --a correction --b football_alone
 * Both must be non-null on a row for it to enter the comparison (a strict
 * subset when either field is `correction`, since that head abstains on
 * games/weeks the unified model doesn't).
 *
 * `--b-run DIR` reads field B from ANOTHER run's predictions.json, joined on
 * the game id -- the recipe-vs-recipe comparison (RUNBOOK §4.1: correction
 * head v2 vs v1 on identical games):
 *   node scripts/unified-margin-audit-significance.mjs <v2-run> --a correction --b correction --b-run <v1-run>
 * It refuses to run if the two runs disagree on any joined game's outcome or
 * fit week, because then they were not the same experiment.
 *
 * Reported `mean_diff` is (a MAE - b MAE): negative means `a` had the lower
 * error. `significant` is true only when the 90% interval excludes zero.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// backtest-significance.js -> backtest.js -> db/index.js opens sqlite AT
// IMPORT TIME against GRIDIRON_DB_PATH, or the real server/data.sqlite when
// unset. This script never reads the database, but the import still does, so
// point it at a throwaway path before importing anything.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-audit-significance-'));
process.env.GRIDIRON_DB_PATH = path.join(scratch, 'unused.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const { db } = await import('../server/db/index.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

try {
  const runDir = process.argv[2];
  if (!runDir || runDir.startsWith('--')) {
    console.error('usage: node scripts/unified-margin-audit-significance.mjs <run-directory> [--a FIELD] [--b FIELD]');
    process.exit(2);
  }
  const fieldA = arg('--a', 'unified');
  const fieldB = arg('--b', 'market');
  const predictionsPath = path.join(runDir, 'predictions.json');
  const predictions = JSON.parse(fs.readFileSync(predictionsPath, 'utf8'));

  // `--b-run <other-run-dir>`: read field B from a DIFFERENT run's
  // predictions.json, joined on the game id. This is how two recipes of the
  // same candidate (e.g. correction head v1 vs v2, RUNBOOK §4.1) are compared
  // on identical games with the same one bootstrap. The join refuses to
  // proceed if the two runs disagree on a game's outcome or fit week --
  // that would mean they were not scoring the same thing.
  const bRunDir = arg('--b-run', null);
  let paired;
  if (bRunDir) {
    const other = JSON.parse(fs.readFileSync(path.join(bRunDir, 'predictions.json'), 'utf8'));
    const byGame = new Map(other.map(p => [p.game, p]));
    paired = [];
    for (const p of predictions) {
      const q = byGame.get(p.game);
      if (!q || p[fieldA] == null || q[fieldB] == null) continue;
      if (q.actual_margin !== p.actual_margin || q.fit_week !== p.fit_week) {
        throw new Error(`runs disagree on ${p.game}: actual ${p.actual_margin}/${q.actual_margin}, `
          + `fit_week ${p.fit_week}/${q.fit_week} -- not the same experiment`);
      }
      paired.push({ ...p, [`b:${fieldB}`]: q[fieldB] });
    }
  } else {
    paired = predictions.filter(p => p[fieldA] != null && p[fieldB] != null)
      .map(p => ({ ...p, [`b:${fieldB}`]: p[fieldB] }));
  }
  const errA = paired.map(p => Math.abs(p[fieldA] - p.actual_margin));
  const errB = paired.map(p => Math.abs(p[`b:${fieldB}`] - p.actual_margin));
  const groups = paired.map(p => p.fit_week);

  const result = pairedBootstrapDiff(errB, errA, { groups, iterations: 4000 });

  console.log(JSON.stringify({
    run: path.basename(runDir),
    ...(bRunDir ? { b_run: path.basename(bRunDir) } : {}),
    compared: bRunDir ? `${fieldA} (this run) vs ${fieldB} (${path.basename(bRunDir)})` : `${fieldA} vs ${fieldB}`,
    n_games: paired.length,
    n_weeks: new Set(groups).size,
    [`${fieldB}_mae`]: errB.reduce((s, v) => s + v, 0) / errB.length,
    [`${fieldA}_mae`]: errA.reduce((s, v) => s + v, 0) / errA.length,
    statistic: `mean_diff = ${fieldA} MAE - ${fieldB} MAE; negative favors ${fieldA}`,
    clustered_by: 'fit_week',
    ...result,
  }, null, 2));
} finally {
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
