/**
 * The efficiency half shrinks PROPORTIONS with the wrong helper, and this
 * measures what that costs.
 *
 * `stats-util.js:31-48` is explicit about which of the two shrinkage helpers to
 * use where:
 *
 *   "Use this instead of `shrink` whenever `observed` and `prior` are both
 *    proportions in [0,1] ... keep using plain `shrink` for stats that are not
 *    bounded proportions."
 *
 * with the reason given directly above it: a raw proportion's sampling variance
 * is p(1-p)/n, smallest near 0 or 1 and largest near 0.5, so a single fixed k
 * "over-corrects near the middle of the range and under-corrects near the
 * edges". `shrinkRate` blends in the arcsine-stabilised domain, where the
 * variance is ~1/(4n) regardless of p, so one k applies uniformly.
 *
 * Every caller of `shrinkRate` in this repository is on the MLB side
 * (`mlb-projections.js:282,283,294`). The NFL structural head shrinks
 * `catch_rate`, `rec_td_rate`, `rush_td_rate` and `pass_td_rate` — all
 * proportions in [0,1] — with plain `shrink` (`projections.js:564-578`).
 *
 * That gives a falsifiable prediction, not just a style complaint. Catch rate
 * sits near 0.63, the middle of the range, so it should be OVER-corrected —
 * pulled too far toward the positional prior. The touchdown rates sit near 0.05,
 * an edge, so they should be UNDER-corrected. If the docstring is right, moving
 * to the arcsine domain helps catch rate more than it helps the TD rates, and in
 * opposite directions.
 *
 * METHOD, and why it needs no change to `projections.js`
 *
 * `shrink` is linear in the weight w = n/(n+k):
 *
 *   shipped = w*observed + (1-w)*prior
 *
 * `buildProjections` will hand back all three of those terms if it is asked
 * three times for the same cutoff with a different constant:
 *
 *   k = 0         -> `observed`, the player's own rate to date, unshrunk
 *   k = Infinity  -> `prior`, the positional prior alone (`shrinkSafe`, :209)
 *   k = literal   -> `shipped`, what the app serves
 *
 * so w = (shipped - prior) / (observed - prior), and the arcsine arm is
 * arcsineInverse(w*arcsine(observed) + (1-w)*arcsine(prior)) — `shrinkRate`
 * evaluated at exactly the same evidence weight, on exactly the same rows,
 * without touching a server file. Rows where the player's rate is within
 * MIN_SPREAD of the prior are dropped: the reconstruction divides by that
 * difference, and those rows barely move under either helper anyway.
 *
 * Scored against forward usage, same gates and same player-clustered bootstrap
 * as `grade-efficiency-vs-baseline.mjs`. A POSITIVE interval means the arcsine
 * arm has less error than what ships.
 *
 *   GRIDIRON_DB_PATH=/tmp/scratch.sqlite node scripts/grade-proportion-shrinkage.mjs
 */
import { buildProjections } from '../server/services/projections.js';
import { PPR } from '../server/services/scoring.js';
import { arcsine, arcsineInverse } from '../server/services/stats-util.js';
import { rows } from '../server/db/index.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

const SEASONS = [2024, 2025];
const CUTOFFS = { from: 5, to: 14 };
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const MIN_SPREAD = 0.02;   // |observed - prior|, below which w is not recoverable

/** metric -> shipped constant, output field, and what the realized rate is made of. */
const PROPORTIONS = {
  catch_rate:   { k: 26, field: 'catch_rate',
                  num: 'receptions', den: 'targets', minDen: 20 },
  rec_td_rate:  { k: 70, field: 'rec_td_rate',
                  num: 'recTds', den: 'targets', minDen: 40 },
  rush_td_rate: { k: 70, field: 'rush_td_rate',
                  num: 'rushTds', den: 'carries', minDen: 40 },
};

const mae = xs => xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length;

function overrideFor(metric, k) {
  return { [metric]: Object.fromEntries(POSITIONS.map(p => [p, k])) };
}

function forwardActuals(season, week) {
  const out = new Map();
  for (const u of rows(
    `SELECT player_id, targets, carries, receptions, receiving_tds, rushing_tds
       FROM player_week_usage WHERE season = ? AND week > ?`, season, week)) {
    let a = out.get(u.player_id);
    if (!a) out.set(u.player_id, a = { targets: 0, carries: 0, receptions: 0, recTds: 0, rushTds: 0 });
    a.targets += u.targets ?? 0;  a.carries += u.carries ?? 0;
    a.receptions += u.receptions ?? 0;
    a.recTds += u.receiving_tds ?? 0; a.rushTds += u.rushing_tds ?? 0;
  }
  return out;
}

const result = {};
for (const metric of Object.keys(PROPORTIONS)) result[metric] = { shipped: [], arcsine: [], players: [], dropped: 0 };

for (const season of SEASONS) {
  for (let week = CUTOFFS.from; week <= CUTOFFS.to; week++) {
    const after = forwardActuals(season, week);
    for (const [metric, spec] of Object.entries(PROPORTIONS)) {
      const arms = {};
      for (const k of [0, spec.k, Infinity]) {
        arms[k] = buildProjections({
          through: season, throughWeek: week, scoring: PPR, kOverride: overrideFor(metric, k),
        });
      }
      const bucket = result[metric];
      for (const [id, shippedRow] of arms[spec.k]) {
        const was = after.get(shippedRow.player_id);
        if (!was || was[spec.den] < spec.minDen) continue;
        const observed = arms[0].get(id)?.efficiency?.[spec.field];
        const prior = arms[Infinity].get(id)?.efficiency?.[spec.field];
        const shipped = shippedRow.efficiency?.[spec.field];
        if (![observed, prior, shipped].every(Number.isFinite)) continue;
        if (Math.abs(observed - prior) < MIN_SPREAD) { bucket.dropped++; continue; }
        const w = Math.max(0, Math.min(1, (shipped - prior) / (observed - prior)));
        const asArm = arcsineInverse(w * arcsine(observed) + (1 - w) * arcsine(prior));
        const actual = was[spec.num] / was[spec.den];
        bucket.shipped.push(shipped - actual);
        bucket.arcsine.push(asArm - actual);
        bucket.players.push(String(shippedRow.player_id));
      }
    }
    process.stderr.write(`  ${season} w${week} done\n`);
  }
}

for (const [metric, spec] of Object.entries(PROPORTIONS)) {
  const b = result[metric];
  if (b.shipped.length < 10) { console.log(`\n${metric}: too few rows (${b.shipped.length})`); continue; }
  const shippedAbs = b.shipped.map(Math.abs), arcAbs = b.arcsine.map(Math.abs);
  const bias = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
  // Positive interval => the arcsine arm has LESS error than what ships.
  const d = pairedBootstrapDiff(arcAbs, shippedAbs, { groups: b.players });
  const verdict = d.ci90[0] > 0 ? 'ARCSINE WINS' : d.ci90[1] < 0 ? 'plain shrink wins' : 'no detectable difference';
  console.log(`\n=== ${metric}  (K = ${spec.k}, gate ${spec.minDen}+ forward ${spec.den}) ===`);
  console.log(`  n = ${b.shipped.length} rows, ${new Set(b.players).size} players, ${b.dropped} dropped as too close to the prior`);
  console.log(`  plain shrink (ships)  MAE ${mae(shippedAbs).toFixed(5)}  bias ${bias(b.shipped) >= 0 ? '+' : ''}${bias(b.shipped).toFixed(5)}`);
  console.log(`  arcsine (shrinkRate)  MAE ${mae(arcAbs).toFixed(5)}  bias ${bias(b.arcsine) >= 0 ? '+' : ''}${bias(b.arcsine).toFixed(5)}`);
  console.log(`  shipped-minus-arcsine 90% CI ${JSON.stringify(d.ci90.map(x => +x.toFixed(5)))}  ->  ${verdict}`);
}
