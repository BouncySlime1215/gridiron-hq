/**
 * Demonstrates D34: `pairedBootstrapDiff` will compare two model arms of
 * different lengths by index, and the `groups.length === n` guard added on
 * 2026-09-12 does not stop it.
 *
 * The guard's own comment names this caller shape -- "a caller passes a
 * `groups` array sized to ONE of the two value arrays (as every current caller
 * in offseason-model.js does) while the OTHER value array is shorter" -- and
 * concludes such a call falls back to the ungrouped resample. It does not.
 * `n = Math.min(A, B)`, so a `groups` array sized to the SHORTER array has
 * `groups.length === n` exactly and the clustered branch runs on a pairing
 * that lines 2023 baseline rows up against 2024 challenger rows.
 *
 * This reproduces on `main`. It reads no database and writes nothing.
 *
 *   node scripts/probe-paired-bootstrap-alignment.mjs
 */
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

// Two test seasons of per-row absolute errors. The baseline ("no_change") ran
// in both. The challenger ("gbm") threw in season A and only has season B --
// exactly what offseason-model.js:1073-1077 produces when fitGbm throws once.
const baselineErrs = [
  ...Array.from({ length: 30 }, () => 1.00), // season A, baseline errs 1.00
  ...Array.from({ length: 30 }, () => 0.10)  // season B, baseline errs 0.10
];
const gbmErrs = Array.from({ length: 30 }, () => 0.20); // season B only
// Built in lockstep with the candidate's own errs, as `p.groups` is.
const gbmGroups = Array.from({ length: 30 }, (_, i) => `B|team${i % 8}`);

const n = Math.min(baselineErrs.length, gbmErrs.length);
console.log(`valuesA ${baselineErrs.length}  valuesB ${gbmErrs.length}  n=min=${n}  groups=${gbmGroups.length}`);
console.log(`guard  groups.length === n  ->  ${gbmGroups.length === n}   (true = takes the CLUSTERED branch)\n`);

// Exactly the call offseason-model.js:1149 makes.
const asCalled = pairedBootstrapDiff(baselineErrs, gbmErrs,
  { iterations: 4000, seed: 23, groups: gbmGroups });
// Like for like: the baseline's season-B rows only.
const aligned = pairedBootstrapDiff(baselineErrs.slice(30), gbmErrs,
  { iterations: 4000, seed: 23, groups: gbmGroups });

const show = (label, r) =>
  console.log(`${label}:  mean ${r.mean_diff}  90% CI [${r.ci90}]  significant=${r.significant}  n=${r.n}`);
show('as the code calls it', asCalled);
show('aligned on season B ', aligned);

console.log(`\ntruth: the challenger is WORSE by +0.1000 on the only season it ran.`);
console.log(`pairedBootstrapDiff's convention is mean(B) - mean(A), so a negative`);
console.log(`mean_diff reads as "the challenger wins". The misaligned call inverts`);
console.log(`the sign and calls it significant.`);
