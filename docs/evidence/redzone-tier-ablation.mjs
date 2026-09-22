/**
 * A/B ablation: four opportunity tiers against three.
 * Fit on 2022-2024, scored once on 2025. Replicates fitRates() exactly
 * (EM over player-weeks, 12 iterations, MIN_EXPOSURE 200) with the class set
 * and seeds as parameters, so nothing in the repo is modified to run it.
 */
const DB = '/tmp/claude-0/-home-user-gridiron-hq/88465833-631d-5966-a586-9b2d13123842/scratchpad/gridiron.sqlite';
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(DB, { readOnly: true });

const THREE_RUSH = [
  { key: 'goal_line_carries', subtractFrom: null },
  { key: 'red_zone_carries', subtractFrom: 'goal_line_carries' },
  { key: 'carries', subtractFrom: 'red_zone_carries' }];
const THREE_REC = [
  { key: 'end_zone_targets', subtractFrom: null },
  { key: 'red_zone_targets', subtractFrom: 'end_zone_targets' },
  { key: 'targets', subtractFrom: 'red_zone_targets' }];
const FOUR_RUSH = [
  { key: 'goal_line_carries', subtractFrom: null },
  { key: 'inside_10_carries', subtractFrom: 'goal_line_carries' },
  { key: 'red_zone_carries', subtractFrom: 'inside_10_carries', fallbackSubtractFrom: 'goal_line_carries' },
  { key: 'carries', subtractFrom: 'red_zone_carries' }];
const FOUR_REC = [
  { key: 'goal_to_go_targets', subtractFrom: null },
  { key: 'end_zone_targets', subtractFrom: 'goal_to_go_targets' },
  { key: 'red_zone_targets', subtractFrom: 'end_zone_targets' },
  { key: 'targets', subtractFrom: 'red_zone_targets' }];

const SEED3_RUSH = { goal_line_carries: 0.15, red_zone_carries: 0.06, carries: 0.01 };
const SEED3_REC = { end_zone_targets: 0.30, red_zone_targets: 0.12, targets: 0.03 };
const SEED4_RUSH = { goal_line_carries: 0.15, inside_10_carries: 0.16, red_zone_carries: 0.045, carries: 0.01 };
const SEED4_REC = { goal_to_go_targets: 0.38, end_zone_targets: 0.29, red_zone_targets: 0.135, targets: 0.03 };

const exclusive = (f, classes) => {
  const out = {};
  for (const c of classes) {
    const raw = f[c.key] ?? 0;
    const above = c.subtractFrom == null ? 0
      : Math.max(f[c.subtractFrom] ?? 0, c.fallbackSubtractFrom == null ? 0 : f[c.fallbackSubtractFrom] ?? 0);
    out[c.key] = Math.max(0, raw - above);
  }
  return out;
};
const groupOf = pos => (pos === 'QB' ? 'QB' : pos === 'RB' ? 'RB' : 'REC');
const GROUPS = ['QB', 'RB', 'REC'];
const load = seasons => db.prepare(`SELECT season, week, player_id, position, features
  FROM nfl_player_week_features WHERE season IN (${seasons.map(() => '?').join(',')})`).all(...seasons)
  .map(r => ({ ...r, x: JSON.parse(r.features) }));

function fit(rowsIn, RUSH, REC, seedRush, seedRec) {
  const blank = cs => Object.fromEntries(cs.map(c => [c.key, { opp: 0, td: 0 }]));
  let rushRate = Object.fromEntries(GROUPS.map(g => [g, { ...seedRush }]));
  let recRate = Object.fromEntries(GROUPS.map(g => [g, { ...seedRec }]));
  const MIN = 200;
  for (let iter = 0; iter < 12; iter++) {
    const rush = Object.fromEntries(GROUPS.map(g => [g, blank(RUSH)]));
    const rec = Object.fromEntries(GROUPS.map(g => [g, blank(REC)]));
    for (const f of rowsIn) {
      const x = f.x, g = groupOf(f.position);
      const ro = exclusive(x, RUSH), co = exclusive(x, REC);
      const rExp = RUSH.reduce((s, c) => s + ro[c.key] * rushRate[g][c.key], 0);
      const cExp = REC.reduce((s, c) => s + co[c.key] * recRate[g][c.key], 0);
      for (const c of RUSH) {
        rush[g][c.key].opp += ro[c.key];
        if (rExp > 0) rush[g][c.key].td += (x.rushing_tds ?? 0) * (ro[c.key] * rushRate[g][c.key]) / rExp;
      }
      for (const c of REC) {
        rec[g][c.key].opp += co[c.key];
        if (cExp > 0) rec[g][c.key].td += (x.receiving_tds ?? 0) * (co[c.key] * recRate[g][c.key]) / cExp;
      }
    }
    rushRate = Object.fromEntries(GROUPS.map(g => [g, Object.fromEntries(RUSH.map(c =>
      [c.key, rush[g][c.key].opp >= MIN ? rush[g][c.key].td / rush[g][c.key].opp : rushRate[g][c.key]]))]));
    recRate = Object.fromEntries(GROUPS.map(g => [g, Object.fromEntries(REC.map(c =>
      [c.key, rec[g][c.key].opp >= MIN ? rec[g][c.key].td / rec[g][c.key].opp : recRate[g][c.key]]))]));
  }
  return { rushRate, recRate };
}

function score(rowsIn, RUSH, REC, rates) {
  let n = 0, sae = 0, sse = 0, expTot = 0, actTot = 0, nll = 0;
  for (const f of rowsIn) {
    const x = f.x, g = groupOf(f.position);
    const ro = exclusive(x, RUSH), co = exclusive(x, REC);
    const exp = RUSH.reduce((s, c) => s + ro[c.key] * rates.rushRate[g][c.key], 0)
      + REC.reduce((s, c) => s + co[c.key] * rates.recRate[g][c.key], 0);
    const act = (x.rushing_tds ?? 0) + (x.receiving_tds ?? 0);
    const opp = RUSH.reduce((s, c) => s + ro[c.key], 0) + REC.reduce((s, c) => s + co[c.key], 0);
    if (opp <= 0) continue;
    n++; sae += Math.abs(exp - act); sse += (exp - act) ** 2; expTot += exp; actTot += act;
    const lam = Math.max(exp, 1e-6);
    nll += lam - act * Math.log(lam);   // Poisson negative log-likelihood, constant dropped
  }
  return { n, mae: sae / n, rmse: Math.sqrt(sse / n), nll: nll / n,
    expected: expTot, actual: actTot, bias: (expTot - actTot) / actTot };
}

const train = load([2022, 2023, 2024]);
const test = load([2025]);
console.log(`fit rows ${train.length} (2022-2024), test rows ${test.length} (2025)\n`);

const arms = [
  ['three tiers (before)', THREE_RUSH, THREE_REC, SEED3_RUSH, SEED3_REC],
  ['four tiers  (after)', FOUR_RUSH, FOUR_REC, SEED4_RUSH, SEED4_REC]
];
const out = {};
for (const [name, R, C, sr, sc] of arms) {
  const rates = fit(train, R, C, sr, sc);
  const s = score(test, R, C, rates);
  out[name] = s;
  console.log(`${name}: n=${s.n} MAE=${s.mae.toFixed(5)} RMSE=${s.rmse.toFixed(5)} PoissonNLL=${s.nll.toFixed(5)} ` +
    `expected=${s.expected.toFixed(1)} actual=${s.actual} bias=${(s.bias * 100).toFixed(2)}%`);
}
const a = out['three tiers (before)'], b = out['four tiers  (after)'];
console.log(`\nMAE  ${a.mae.toFixed(5)} -> ${b.mae.toFixed(5)}  (${((b.mae - a.mae) / a.mae * 100).toFixed(2)}%)`);
console.log(`RMSE ${a.rmse.toFixed(5)} -> ${b.rmse.toFixed(5)}  (${((b.rmse - a.rmse) / a.rmse * 100).toFixed(2)}%)`);
console.log(`NLL  ${a.nll.toFixed(5)} -> ${b.nll.toFixed(5)}  (${((b.nll - a.nll) / a.nll * 100).toFixed(2)}%)`);
console.log(`bias ${(a.bias * 100).toFixed(2)}% -> ${(b.bias * 100).toFixed(2)}%`);
db.close();
