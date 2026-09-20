/**
 * Does the OPPORTUNITY number beat an average a manager could do in his head?
 *
 * The News page prints "N tgt · N car · N% tgt share" for a player. Those come
 * from the structural head's `params` (projections.js), and the volume shrinkage
 * behind them has only ever been validated on fantasy POINTS — never on
 * opportunity itself. This grades the opportunity number directly, against the
 * two baselines a user has without us:
 *
 *   - his own SEASON-TO-DATE AVERAGE, the thing anyone can do in his head, and
 *   - an EWMA of his own recent weeks at alpha 0.4 — the `ewma` baseline in
 *     `opportunity-model.js:350`, computed by the same recursion as `:64-69`.
 *     That module's own study (docs/OPPORTUNITY-FINDINGS-2026-09-19.md, section
 *     3) found a sixteen-feature ridge over air-yards share, WOPR, snap
 *     trajectory, expected points, vacated teammate share, spread and implied
 *     total could not beat this EWMA for next-week volume. It has never been
 *     graded against what the app actually ships, which is what this adds.
 *
 * Both baselines are computed from raw usage, so they are byte-identical in
 * every arm's output file and the comparison reads them from the first.
 *
 * WHAT MAKES THE COMPARISON FAIR, since the interesting run is a BEFORE/AFTER on
 * the volume shrinkage fit and a fitted k moves projections around:
 *
 *   - The population is defined from RAW USAGE ONLY — at least three prior
 *     in-season games and a prior mean of at least 3 targets+carries. Nothing in
 *     the gate reads a model output, so activating the fit cannot change WHO is
 *     graded. Filtering on `structural_ppg` instead (the obvious choice) silently
 *     drops ~14% of rows when the fit is on, and the two arms are then measuring
 *     different populations.
 *   - Each arm writes its rows keyed by `season|week|player_id`; `--compare`
 *     grades only the intersection, so both arms and the baseline share every row.
 *   - The engine for week w reads only weeks < w (buildPlayerWeekEngine is
 *     cutoff-safe), and `activeKVectorFor` re-fits k on seasons <= s-1 when the
 *     stored fit's cutoff is not strictly before the graded season. Neither arm
 *     can see the week it is predicting.
 *   - Significance is a paired bootstrap CLUSTERED BY PLAYER
 *     (backtest-significance.js#pairedBootstrapDiff): the same player appears in
 *     up to thirteen graded weeks and those errors are not independent draws.
 *     The reported interval is on `baseline_error - model_error`, so a positive
 *     interval means the model wins.
 *
 * USAGE
 *
 *   GRIDIRON_DB_PATH=/tmp/scratch.sqlite node scripts/grade-opportunity-vs-baseline.mjs --out before.json
 *   # ... activate a volume shrinkage fit (scripts/promote-volume-shrinkage.mjs) ...
 *   GRIDIRON_DB_PATH=/tmp/scratch.sqlite node scripts/grade-opportunity-vs-baseline.mjs --out after.json
 *   node scripts/grade-opportunity-vs-baseline.mjs --compare before.json after.json
 *
 * Run it against a SCRATCH database, never the live one: an arm needs the fit
 * toggled, and toggling it on `/data/data.sqlite` moves what the app serves.
 */
import fs from 'node:fs';
import { buildPlayerWeekEngine } from '../server/services/player-week-engine.js';
import { PPR } from '../server/services/scoring.js';
import { rows } from '../server/db/index.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

const SEASONS = [2024, 2025];
const WEEKS = { from: 5, to: 17 };
/** Raw-usage gate. Model-independent by construction — see the header. */
const MIN_PRIOR_GAMES = 3;
const MIN_PRIOR_OPPORTUNITIES = 3;

/** `opportunity-model.js:64-69` verbatim, at its own EWMA_ALPHA (`:40`). */
const EWMA_ALPHA = 0.4;
function ewma(series) {
  if (!series.length) return null;
  let acc = series[0];
  for (let i = 1; i < series.length; i++) acc = EWMA_ALPHA * series[i] + (1 - EWMA_ALPHA) * acc;
  return acc;
}

const mae = values => values.reduce((sum, v) => sum + Math.abs(v), 0) / values.length;
const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? null : process.argv[i + 1]; };

function grade() {
  const graded = [];
  for (const season of SEASONS) {
    for (let week = WEEKS.from; week <= WEEKS.to; week++) {
      const engine = buildPlayerWeekEngine({ season, week, scoring: PPR });
      const actual = new Map(rows(
        'SELECT player_id, targets, carries FROM player_week_usage WHERE season = ? AND week = ?',
        season, week).map(r => [r.player_id, r]));
      for (const projection of engine.values()) {
        if (!projection.params) continue;
        const was = actual.get(projection.player_id);
        if (!was) continue;                       // no box score that week: nothing to grade against
        const prior = rows(
          `SELECT targets, carries FROM player_week_usage
           WHERE player_id = ? AND season = ? AND week < ? ORDER BY week`,
          projection.player_id, season, week);
        if (prior.length < MIN_PRIOR_GAMES) continue;
        const meanTargets = prior.reduce((s, p) => s + (p.targets ?? 0), 0) / prior.length;
        const meanCarries = prior.reduce((s, p) => s + (p.carries ?? 0), 0) / prior.length;
        if (meanTargets + meanCarries < MIN_PRIOR_OPPORTUNITIES) continue;
        const ewmaTargets = ewma(prior.map(p => p.targets ?? 0)) ?? 0;
        const ewmaCarries = ewma(prior.map(p => p.carries ?? 0)) ?? 0;
        graded.push({
          key: `${season}|${week}|${projection.player_id}`, season,
          player: String(projection.player_id),
          model_targets: projection.params.targets - (was.targets ?? 0),
          model_carries: projection.params.carries - (was.carries ?? 0),
          baseline_targets: meanTargets - (was.targets ?? 0),
          baseline_carries: meanCarries - (was.carries ?? 0),
          ewma_targets: ewmaTargets - (was.targets ?? 0),
          ewma_carries: ewmaCarries - (was.carries ?? 0),
        });
      }
    }
  }
  return graded;
}

function compare(aPath, bPath) {
  const read = path => new Map(JSON.parse(fs.readFileSync(path, 'utf8')).map(r => [r.key, r]));
  const A = read(aPath), B = read(bPath);
  const keys = [...A.keys()].filter(k => B.has(k));
  console.log(`${aPath}: ${A.size} rows · ${bPath}: ${B.size} rows · graded on the intersection: ${keys.length}\n`);
  for (const season of SEASONS) {
    const ks = keys.filter(k => A.get(k).season === season);
    if (!ks.length) continue;
    const players = ks.map(k => A.get(k).player);
    for (const metric of ['targets', 'carries']) {
      // The baseline is raw usage, so it is identical in both files; read it from A.
      const baseline = ks.map(k => Math.abs(A.get(k)[`baseline_${metric}`]));
      const ewmaArm = ks.map(k => Math.abs(A.get(k)[`ewma_${metric}`] ?? NaN));
      const armA = ks.map(k => Math.abs(A.get(k)[`model_${metric}`]));
      const armB = ks.map(k => Math.abs(B.get(k)[`model_${metric}`]));
      const haveEwma = ewmaArm.every(Number.isFinite);
      // pairedBootstrapDiff(x, y) resamples mean(y) - mean(x), so passing
      // (model, baseline) makes a POSITIVE interval mean the model has less error.
      const gA = pairedBootstrapDiff(armA, baseline, { groups: players });
      const gB = pairedBootstrapDiff(armB, baseline, { groups: players });
      console.log(`${season} ${metric.padEnd(7)} n=${ks.length}`);
      console.log(`   own season-to-date average   ${mae(baseline).toFixed(3)}`);
      console.log(`   ${aPath.padEnd(24)} ${mae(armA).toFixed(3)}   baseline-minus-model 90% CI ${JSON.stringify(gA.ci90)}`);
      console.log(`   ${bPath.padEnd(24)} ${mae(armB).toFixed(3)}   baseline-minus-model 90% CI ${JSON.stringify(gB.ci90)}`);
      if (haveEwma) {
        // Same convention throughout: a POSITIVE interval means the first named
        // arm has the smaller error.
        const gE = pairedBootstrapDiff(ewmaArm, baseline, { groups: players });
        console.log(`   own recent form, EWMA a=0.4 ${mae(ewmaArm).toFixed(3)}   baseline-minus-ewma  90% CI ${JSON.stringify(gE.ci90)}`);
        for (const [label, armX] of [[aPath, armA], [bPath, armB]]) {
          const g = pairedBootstrapDiff(armX, ewmaArm, { groups: players });
          console.log(`      ewma-minus-${label.padEnd(20)} 90% CI ${JSON.stringify(g.ci90)}`);
        }
      }
    }
  }
}

const compareArgs = process.argv.indexOf('--compare');
if (compareArgs >= 0) {
  compare(process.argv[compareArgs + 1], process.argv[compareArgs + 2]);
} else {
  const graded = grade();
  const out = arg('--out');
  if (out) { fs.writeFileSync(out, JSON.stringify(graded)); console.log(`${graded.length} graded rows -> ${out}`); }
  else console.log(`${graded.length} graded rows (pass --out to keep them for --compare)`);
}
