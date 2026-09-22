/**
 * THE REST OF THE K FAMILY: the cells `fit-efficiency-k.mjs` did not measure.
 *
 * That script swept `K.yards_per` at two of its three sites and reported the constant as
 * governing eight cells. It governs twelve -- `projections.js` reads `K.yards_per` at `ypt`
 * (:562), `ypc` (:570) AND `ypa` (:574) -- so passing yards per attempt was never measured.
 * The correction is in `docs/tdd/efficiency-k-split.tdd.md`. This script closes that gap and
 * takes the other two constants of the same shape at the same time:
 *
 *   K.yards_per  = 34   ypt, ypc, ypa                                 12 cells (8 measured)
 *   K.catch_rate = 26   catch_rate                                     4 cells
 *   K.td_rate    = 70   rec_td_rate, rush_td_rate, pass_td_rate       12 cells
 *
 * WHAT THIS IS NOT. Not a revisit of the method-of-moments efficiency k, which is a TESTED
 * REJECTION (`shrinkage-fit.js:465-473`; it made 2025 worse, 4.773 against 4.749). That fitted
 * a k from the data's moments. This measures, on held-out seasons, whether ONE k per constant is
 * the right shape at all, which is a different question and the one that has never been asked of
 * these three.
 *
 * NOTHING IS PROMOTED AND NOTHING IS WRITTEN. The output is the deliverable.
 *
 * The discipline is the first script's, unchanged and deliberately copied rather than
 * re-derived: selection seasons are 2021-2022, the held-out season is opened exactly once at
 * the end, 2024-2025 stay unspent, the graded population is `_predictions` keyed by
 * season|player|week, the recomputed mean must equal the harness's own MAE or the script exits
 * non-zero, and stage 3's interval is `clusteredDiff` -- which refuses rather than pairs rows
 * that do not line up.
 *
 * A DEAD CELL IS A RESULT, not a gap. `ypt` for quarterbacks was flat to 0.0000 across the
 * whole grid in the first study because quarterbacks have no targets. Expect the same of
 * `pass_td_rate` for every position but QB, and of `rush_td_rate` for QBs and receivers at the
 * margin. A constant that cannot move four of its twelve cells is not a tuning question.
 *
 *   node scripts/fit-efficiency-k-family.mjs
 */
const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
const { clusteredDiff } = await import('../server/services/pooled-arms.js');

const SELECT = [2021, 2022];
const TEST = 2023;

/**
 * Every (metric -> governing constant) pair `projections.js` actually has, with the incumbent
 * value read off `K` rather than retyped. `gain` is measured against each metric's OWN
 * incumbent, which is why they cannot share one number the way the first script assumed.
 */
const FAMILIES = [
  { constant: 'yards_per',  incumbent: 34, metrics: ['ypa'],
    note: 'the site the first study missed; ypt and ypc are already measured' },
  { constant: 'catch_rate', incumbent: 26, metrics: ['catch_rate'], note: 'one site, four cells' },
  { constant: 'td_rate',    incumbent: 70, metrics: ['rec_td_rate', 'rush_td_rate', 'pass_td_rate'],
    note: "projections.js calls this the most regression-prone number in fantasy" }
];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * One grid for all three, containing all three incumbents exactly (26, 34, 70) so every
 * metric's gain is measured against its own baseline rather than an interpolation. The ends
 * mean something on their own: 1 is "trust the player's own rate", Infinity is "ignore the
 * player and serve the prior".
 */
const GRID = [1, 2, 4, 8, 15, 26, 34, 50, 70, 100, 150, 250, 400, Infinity];

const r3 = x => (x == null ? null : +Number(x).toFixed(3));

function gradedRows(season, kOverride) {
  const out = replaySeasonWeekly(season, { distributions: false, kOverride });
  const rows = new Map();
  for (const r of out._predictions ?? []) {
    if (r.prediction == null || r.actual == null) continue;
    rows.set(`${season}|${r.player_id}|${r.week}`, {
      err: Math.abs(r.prediction - r.actual), player: String(r.player_id)
    });
  }
  return { rows, harness_mae: out.point.model.mae, n: out.point.model.n };
}

/**
 * WHICH ROWS, and the first version of this script had it wrong. It keyed on
 * `_decision_rows` filtered to `played`, which is the DECISION variant (players
 * active the previous week) and a different population: 3,314 rows against the
 * point MAE's 4,341 on 2021, and 4.987 against 4.875. Every relative comparison
 * would still have been internally consistent, so nothing would have looked
 * wrong -- the study would simply have answered a question nobody asked, under a
 * number that did not match the one it was quoted beside. The check below catches
 * it by construction: the recomputed mean must equal the harness's own MAE to
 * three decimals, and the script refuses to go on if it does not.
 */

const pooledMae = results => {
  let s = 0, n = 0;
  for (const { rows } of results) for (const { err } of rows.values()) { s += err; n++; }
  return { mae: n ? s / n : null, n };
};

/** MAE over the SELECT seasons for one candidate vector. */
function selectScore(kOverride) {
  return pooledMae(SELECT.map(s => gradedRows(s, kOverride)));
}

const vectorFor = cells => {
  const v = {};
  for (const [metric, position, k] of cells) (v[metric] ??= {})[position] = k;
  return v;
};

console.log(`# selection seasons ${SELECT.join(', ')}   held-out season ${TEST}`);
console.log('# families: ' + FAMILIES.map(f => `K.${f.constant}=${f.incumbent} over ${f.metrics.join(',')}`).join('  |  ') + '\n');

// ---- stage 0: the incumbent's own numbers, and the recomputation check.
const baseSelect = selectScore(undefined);
const perSeasonCheck = SELECT.map(s => {
  const g = gradedRows(s, undefined);
  const mine = [...g.rows.values()].reduce((a, b) => a + b.err, 0) / g.rows.size;
  return { season: s, harness: g.harness_mae, recomputed: r3(mine), rows: g.rows.size, harness_n: g.n };
});
console.log('## the grading agrees with the harness before anything is swept');
for (const c of perSeasonCheck) {
  console.log(`  ${c.season}: harness ${c.harness} over ${c.harness_n}, recomputed ${c.recomputed} over ${c.rows} rows`);
  if (c.harness !== c.recomputed || c.rows !== c.harness_n) {
    console.error(`REFUSING: ${c.season} recomputed ${c.recomputed} over ${c.rows} does not match the `
      + `harness's ${c.harness} over ${c.harness_n}. The rows being graded are not the rows the MAE `
      + `quotes, so nothing below would mean what it says.`);
    process.exit(1);
  }
}
console.log(`  incumbent pooled SELECT mae ${r3(baseSelect.mae)} over ${baseSelect.n}\n`);

// ---- stage 1: coordinate-wise sweep, each cell against its own constant's incumbent.
console.log('## stage 1 — one cell at a time, every other cell left at its incumbent');
console.log('constant\tmetric\tposition\t' + GRID.map(k => (k === Infinity ? 'inf' : k)).join('\t') + '\twinner\tgain');
const winners = [];
for (const fam of FAMILIES) {
  const incumbentI = GRID.indexOf(fam.incumbent);
  if (incumbentI < 0) { console.error(`REFUSING: ${fam.incumbent} is not on the grid, so no gain for K.${fam.constant} would be measured against its own baseline.`); process.exit(1); }
  for (const metric of fam.metrics) {
    for (const position of POSITIONS) {
      const scores = [];
      for (const k of GRID) scores.push(selectScore(vectorFor([[metric, position, k]])).mae);
      let bestI = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] < scores[bestI]) bestI = i;
      const gain = scores[incumbentI] - scores[bestI];
      const spread = Math.max(...scores) - Math.min(...scores);
      winners.push({ constant: fam.constant, metric, position, k: GRID[bestI], gain, scores,
        flat: spread < 0.0005 });
      console.log(`${fam.constant}\t${metric}\t${position}\t` + scores.map(v => r3(v)).join('\t')
        + `\t${GRID[bestI] === Infinity ? 'inf' : GRID[bestI]}\t${gain.toFixed(4)}`);
    }
  }
}
console.log();

// A cell whose whole grid moves the pooled MAE by less than 0.0005 cannot respond to the
// constant at all, and saying so is a result rather than a missing row.
const dead = winners.filter(w => w.flat);
console.log(`## dead cells — the grid moves the pooled MAE by < 0.0005 from end to end`);
console.log(dead.length
  ? dead.map(w => `  ${w.metric}/${w.position}`).join('\n')
  : '  none: every cell responds to its constant');
console.log(`  ${dead.length} of ${winners.length} cells are dead by construction\n`);

// ---- stage 2: the combination, graded rather than assumed.
const chosen = winners.filter(w => !w.flat && w.gain > 0).map(w => [w.metric, w.position, w.k]);
const combined = vectorFor(chosen);
const combinedSelect = chosen.length ? selectScore(combined) : baseSelect;
const sumOfParts = winners.reduce((s, w) => s + Math.max(0, w.gain), 0);
console.log('## stage 2 — the per-cell winners together, on the selection seasons');
console.log(`  cells kept: ${chosen.length ? JSON.stringify(combined) : 'none'}`);
console.log(`  sum of the individual gains: ${sumOfParts.toFixed(4)}`);
console.log(`  the combination's own gain : ${(baseSelect.mae - combinedSelect.mae).toFixed(4)}`);
console.log(`  -> the cells are ${Math.abs(sumOfParts - (baseSelect.mae - combinedSelect.mae)) < 0.002
  ? 'close to additive' : 'NOT additive, and the combination is what counts'}\n`);

// ---- stage 3: the held-out season, opened once.
if (!chosen.length) {
  console.log(`## stage 3 — NOT OPENED. Stage 1 found no cell worth carrying, so ${TEST} stays unspent.`);
  console.log('   A held-out season spent on a candidate identical to the incumbent buys nothing');
  console.log('   and cannot be spent again.');
} else {
  console.log(`## stage 3 — ${TEST}, opened once`);
  const testBase = gradedRows(TEST, undefined);
  const testCand = gradedRows(TEST, combined);
  const keys = [...testBase.rows.keys()].filter(k => testCand.rows.has(k));
  const a = keys.map(k => testBase.rows.get(k).err);
  const b = keys.map(k => testCand.rows.get(k).err);
  const groups = keys.map(k => testBase.rows.get(k).player);
  console.log(`  incumbent ${r3(testBase.harness_mae)}   candidate ${r3(testCand.harness_mae)}`
    + `   paired rows ${keys.length} of ${testBase.rows.size}/${testCand.rows.size}`);
  const interval = keys.length >= 10
    ? clusteredDiff(a, b, { iterations: 4000, seed: 31, groups })
    : { error: 'too few paired rows' };
  console.log(`  paired bootstrap, clustered by player: ${JSON.stringify(interval)}`);
}
console.log(`\n# nothing was promoted; no row was written.`);
