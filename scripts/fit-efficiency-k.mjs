#!/usr/bin/env node
/**
 * One constant is serving two statistics across four positions. Should it?
 *
 * `projections.js`'s `K.yards_per = 34` is applied to `ypt` (receiving yards per
 * target) and `ypc` (rushing yards per carry), at every position, in raw
 * opportunities. The file's own header already says the asymmetry that creates
 * is "visible instead of hidden; it is not a claim that it is correct": 34 raw
 * opportunities is 6.8 games of receiving, 4.3 of rushing and 3.4 of passing, so
 * one number buys a different amount of regression per metric and per position.
 *
 * WHAT THIS IS NOT. The method-of-moments fitter's efficiency k is a TESTED
 * REJECTION and this does not revisit it: substituting it made 2025 worse (4.773
 * against 4.749) because "player" is not a stable group for efficiency within a
 * season, so the between-player variance that method estimates is inflated.
 * That verdict stands and `VOLUME_METRICS` in shrinkage-fit.js excludes
 * efficiency for that reason.
 *
 * This is the other method, the one that selected `int_rate: 1600` in the same
 * object: a held-out sweep of the constant itself, scored on data the sweep did
 * not see. A variance decomposition and a held-out sweep can disagree, and where
 * they do the held-out sweep is the one that answers "does this projection get
 * better".
 *
 * PROCEDURE, and the order matters.
 *   1. Coordinate-wise sweep on the SELECT seasons (2021, 2022): for each
 *      (metric, position), sweep k with every other cell left at 34.
 *   2. Combine the per-cell winners into one vector and grade that on SELECT.
 *      The cells are NOT independent -- a receiver's ypt changes the team volume
 *      every other player is measured against -- so the combination is graded
 *      rather than assumed to be the sum of its parts.
 *   3. Open 2023 ONCE, with the incumbent and with the combined vector, paired
 *      per player-week and bootstrapped clustered by player.
 *
 * 2024 and 2025 are not read at all, by either stage, so they remain available
 * for a confirmation nobody has spent yet.
 *
 * NOTHING IS PROMOTED. This writes no row and changes no served constant; the
 * output is a table and a verdict. Promotion needs the ensemble weights re-fitted
 * against the new head and Nick's word, for the reason the projections.js header
 * gives about the 4.749 -> 4.376 finding it already carries.
 *
 * BASE. This sits on the arm-alignment branch rather than on `main`, deliberately:
 * stage 3 pairs two replays per player-week and bootstraps them clustered by
 * player, and that is exactly the call shape whose unguarded version compared
 * different seasons to each other in the offseason model. The study uses the
 * guarded `clusteredDiff`, which throws rather than pair rows that do not line
 * up, so a misaligned pairing here cannot quietly become a finding.
 *
 * Usage: node --env-file-if-exists=.env scripts/fit-efficiency-k.mjs
 */
process.env.SCHEDULER_DISABLED = '1';

const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
const { clusteredDiff } = await import('../server/services/pooled-arms.js');

const SELECT = [2021, 2022];
const TEST = 2023;
const METRICS = ['ypt', 'ypc'];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const INCUMBENT = 34;
// Spanning three orders of magnitude around the incumbent, plus the two ends
// that mean something on their own: 1 is "trust the player's own rate", Infinity
// is "ignore it entirely and serve the prior".
const GRID = [1, 2, 4, 8, 15, 25, 34, 50, 75, 120, 200, 400, Infinity];

const r3 = x => (x == null ? null : +Number(x).toFixed(3));

/**
 * Absolute errors per graded player-week, KEYED. The harness returns its own
 * pooled arrays too, and they would pair by index -- which is precisely the
 * defect this repo just fixed in the offseason model, so the pairing here is by
 * the row's own identity and the recomputed MAE is checked against the
 * harness's own figure before anything is believed.
 */
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
console.log(`# incumbent: one shared k = ${INCUMBENT} for every cell below\n`);

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

// ---- stage 1: coordinate-wise sweep.
console.log('## stage 1 — one cell at a time, everything else left at 34');
console.log('metric\tposition\t' + GRID.map(k => (k === Infinity ? 'inf' : k)).join('\t') + '\twinner\tgain');
const winners = [];
for (const metric of METRICS) {
  for (const position of POSITIONS) {
    const scores = [];
    for (const k of GRID) {
      scores.push(selectScore(vectorFor([[metric, position, k]])).mae);
    }
    let bestI = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] < scores[bestI]) bestI = i;
    const incumbentI = GRID.indexOf(INCUMBENT);
    const gain = scores[incumbentI] - scores[bestI];
    winners.push({ metric, position, k: GRID[bestI], gain, scores, flat: gain < 0.0005 });
    console.log(`${metric}\t${position}\t` + scores.map(v => r3(v)).join('\t')
      + `\t${GRID[bestI] === Infinity ? 'inf' : GRID[bestI]}\t${gain.toFixed(4)}`);
  }
}
console.log();

// ---- stage 2: the combination, graded rather than assumed.
const chosen = winners.filter(w => !w.flat).map(w => [w.metric, w.position, w.k]);
const combined = vectorFor(chosen);
const combinedSelect = selectScore(combined);
const sumOfParts = winners.reduce((s, w) => s + Math.max(0, w.gain), 0);
console.log('## stage 2 — the per-cell winners together, on the selection seasons');
console.log(`  cells kept (non-flat): ${chosen.length ? JSON.stringify(combined) : 'none'}`);
console.log(`  sum of the individual gains: ${sumOfParts.toFixed(4)}`);
console.log(`  the combination's own gain : ${(baseSelect.mae - combinedSelect.mae).toFixed(4)}`);
console.log(`  -> the cells are ${Math.abs(sumOfParts - (baseSelect.mae - combinedSelect.mae)) < 0.002
  ? 'close to additive' : 'NOT additive, and the combination is what counts'}\n`);

// ---- stage 3: the held-out season, opened once.
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
console.log(`\n# nothing was promoted; no row was written.`);
