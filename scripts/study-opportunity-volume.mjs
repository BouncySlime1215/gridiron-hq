#!/usr/bin/env node
/**
 * O1 walk-forward study — does the opportunity model beat the honest baselines?
 *
 * Season-blocked: every graded season is predicted by a model fitted only on
 * earlier seasons. Nothing from the graded season, and nothing from the graded
 * week, participates in the fit. The comparison is paired on the same rows and
 * bootstrapped with the resample clustered by player, because one receiver
 * contributes seventeen correlated rows and treating them as independent is how
 * a 2% difference acquires a confident-looking interval.
 *
 * Usage: GRIDIRON_DB_PATH=... node scripts/study-opportunity-volume.mjs
 */
import {
  buildOpportunityRows, fitOpportunityModel, predictOpportunity,
  fitVacatedCorrection, applyVacatedCorrection, BASELINES
} from '../server/services/opportunity-model.js';

const HEADS = [
  ['WR/TE targets', ['WR', 'TE'], 'targets'],
  ['RB carries', ['RB'], 'carries'],
  ['RB targets', ['RB'], 'targets'],
  ['QB attempts', ['QB'], 'attempts']
];
/**
 * Expanding window: the model that grades season s is fitted on every season
 * before s and nothing else. 2024 is therefore judged by a 2021-2023 fit and
 * 2025 by a 2021-2024 one, which is the shape production would actually run.
 */
const FIRST_SEASON = 2021;
const GRADE_SEASONS = [2024, 2025];
const BOOTSTRAP = 2000;

const mae = (rowsIn, predict) =>
  rowsIn.reduce((sum, r) => sum + Math.abs(predict(r) - r.actual), 0) / rowsIn.length;

function spearman(pairs) {
  const rank = values => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(values.length);
    for (let i = 0; i < order.length;) {
      let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[order[k][1]] = r;
      i = j + 1;
    }
    return out;
  };
  const a = rank(pairs.map(p => p[0])), b = rank(pairs.map(p => p[1]));
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Paired bootstrap, resampling whole players so correlated weeks move together. */
function clusteredBootstrap(rowsIn, predictA, predictB, seed = 20260919) {
  const byPlayer = new Map();
  for (const r of rowsIn) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(Math.abs(predictA(r) - r.actual) - Math.abs(predictB(r) - r.actual));
  }
  const clusters = [...byPlayer.values()];
  let s = seed >>> 0;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const draws = [];
  for (let b = 0; b < BOOTSTRAP; b++) {
    let acc = 0, n = 0;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      for (const d of c) { acc += d; n++; }
    }
    draws.push(acc / n);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(BOOTSTRAP * 0.05)], draws[Math.floor(BOOTSTRAP * 0.95)]];
}

const pct = (a, b) => `${(100 * (a - b) / b).toFixed(2)}%`;

const rowCache = new Map();
const seasonRows = (season, positions, stat) => {
  const ck = `${season}|${positions.join('/')}|${stat}`;
  if (!rowCache.has(ck)) rowCache.set(ck, buildOpportunityRows(season, { positions, stat }));
  return rowCache.get(ck);
};

for (const [label, positions, stat] of HEADS) {
  console.log(`\n=== ${label} ===`);
  for (const season of GRADE_SEASONS) {
    const trainSeasons = [];
    for (let s = FIRST_SEASON; s < season; s++) trainSeasons.push(s);
    const train = trainSeasons.flatMap(s => seasonRows(s, positions, stat));
    const graded = seasonRows(season, positions, stat);
    if (!graded.length) { console.log(`  ${season}: no rows`); continue; }
    const model = fitOpportunityModel(train);
    const correction = fitVacatedCorrection(train);
    if (!model) { console.log(`  ${season}: not enough data to fit (${train.length} rows)`); continue; }

    const results = Object.entries(BASELINES).map(([name, fn]) => [name, mae(graded, fn)]);
    const best = results.reduce((a, b) => (a[1] <= b[1] ? a : b));
    const baseline = BASELINES[best[0]];
    const modelPredict = r => predictOpportunity(model, r);
    const correctedPredict = r => applyVacatedCorrection(correction, r, baseline(r));

    console.log(`  ${season}  n=${graded.length}, fitted on ${trainSeasons.join('+')} (${model.n} player-weeks)`);
    for (const [name, value] of results) console.log(`    baseline ${name.padEnd(20)} MAE ${value.toFixed(3)}`);

    for (const [name, predict] of [['ridge model', modelPredict], ['baseline + vacated', correctedPredict]]) {
      const value = mae(graded, predict);
      const ci = clusteredBootstrap(graded, predict, baseline);
      console.log(`    ${name.padEnd(20)}         MAE ${value.toFixed(3)}   vs ${best[0]} ${pct(value, results.find(r => r[0] === best[0])[1])}`
        + `   CI [${ci[0].toFixed(4)}, ${ci[1].toFixed(4)}]`
        + `   Spearman ${spearman(graded.map(r => [predict(r), r.actual])).toFixed(3)}`);
    }
    console.log(`    ${''.padEnd(20)}         baseline Spearman ${spearman(graded.map(r => [baseline(r), r.actual])).toFixed(3)}`);

    // Where redistribution is supposed to matter: somebody on the team was ruled out.
    const affected = graded.filter(r => r.vacated_same_pos > 0.02);
    if (affected.length > 100) {
      const affBase = mae(affected, baseline);
      console.log(`    same-position teammate ruled out: ${affected.length} rows (${(100 * affected.length / graded.length).toFixed(1)}%)`);
      for (const [name, predict] of [['ridge model', modelPredict], ['baseline + vacated', correctedPredict]]) {
        const value = mae(affected, predict);
        const ci = clusteredBootstrap(affected, predict, baseline);
        console.log(`      ${name.padEnd(20)} MAE ${value.toFixed(3)} vs baseline ${affBase.toFixed(3)}  ${pct(value, affBase)}`
          + `  CI [${ci[0].toFixed(4)}, ${ci[1].toFixed(4)}]`);
      }
    }
    if (correction) {
      console.log(`    vacated coefficients: same-position ${correction.samePosition.toFixed(3)}`
        + `, other-position ${correction.otherPosition.toFixed(3)}, questionable ${correction.questionable.toFixed(3)}`);
    }
    const top = model.featureNames
      .map((name, i) => [name, model.weights[i]])
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
    console.log(`    strongest ridge coefficients: ${top.map(([n, w]) => `${n} ${w.toFixed(3)}`).join(', ')}`);
  }
}
process.exit(0);
