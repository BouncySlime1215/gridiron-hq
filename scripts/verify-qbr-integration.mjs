#!/usr/bin/env node
// Sanity check: replaySeasonWeekly (the production walk-forward harness),
// QB-only, qbrSignal on vs off, confirming the wired-in feature reproduces
// the standalone analysis in scripts/analyze-qbr-fantasy-signal.mjs.
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { QBR_SIGNAL } from '../server/services/projections.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

for (const season of [2024, 2025]) {
  console.log(`\n=== season ${season} ===`);
  const on = replaySeasonWeekly(season, { qbrSignal: QBR_SIGNAL, distributions: false });
  const off = replaySeasonWeekly(season, { qbrSignal: { ...QBR_SIGNAL, enabled: false }, distributions: false });
  for (const [label, r] of [['QBR ON', on], ['QBR OFF', off]]) {
    const qb = r._predictions.filter(p => p.position === 'QB');
    const err = qb.map(p => Math.abs(p.prediction - p.actual));
    const bias = qb.map(p => p.prediction - p.actual);
    console.log(`${label}: n=${qb.length} MAE=${mean(err).toFixed(3)} bias=${mean(bias).toFixed(3)}`);
  }
}
