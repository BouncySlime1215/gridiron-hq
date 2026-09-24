#!/usr/bin/env node
/**
 * COACH-01a Step 0 (RL-18-3): score Coach's people gate on population tells with separate
 * windows, against the TELLS-01a screen's outcome verdicts.
 *
 * Reads the LOCAL panel built by scripts/rnd/coach-gate-panel.py (never committed) and the
 * committed screen. Prints, per window mode and outcome (adds, checkout, trade, any):
 * templates, confirmed, gate passes, precision next to the base rate, recall, lift and a
 * league-clustered bootstrap 90% CI. Writes nothing unless --out is given (aggregates only).
 *
 *   node scripts/coach-gate-rerun.mjs --panel <local>/coach-gate-panel.ndjson.gz \
 *     [--reps 1000] [--seed 1] [--min-clusters 1] [--out <file>.json]
 *
 * Pre-registered reading (ENGINE-SPECS COACH-01a PRE): the gate's precision is claimed for an
 * outcome only when its 90% CI clears that outcome's base rate. Otherwise the gate is reported
 * as repeatability-only. An outcome with no confirmed tell is "no replicated signal", never
 * "predicts nothing".
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { gateRerun, WINDOW_MODES } from '../server/services/coach/people/gate-rerun.js';
import { loadTellsScreen } from '../server/services/coach/people/grading.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const panelPath = arg('panel');
if (!panelPath) {
  console.error('usage: node scripts/coach-gate-rerun.mjs --panel <coach-gate-panel.ndjson.gz>\n'
    + 'Build the panel first with scripts/rnd/coach-gate-panel.py on the machine with the Sleeper copy.');
  process.exit(1);
}
const reps = Number(arg('reps', 1000));
const seed = Number(arg('seed', 1));
const minClusters = Number(arg('min-clusters', 1));

const byMode = new Map(Object.values(WINDOW_MODES).map(m => [m, new Map()]));
let meta = null;
const input = panelPath.endsWith('.gz') ? createReadStream(panelPath).pipe(createGunzip()) : createReadStream(panelPath);
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.meta) { meta = row.meta; continue; }
  const mode = byMode.get(row.mode);
  if (!mode) throw new Error(`panel has an unknown window mode ${row.mode}`);
  mode.set(row.template, new Map(Object.entries(row.clusters)));
}

const screen = loadTellsScreen();
const pad = (s, w) => String(s ?? '—').padEnd(w);
const report = { meta, screen_version: screen.version, modes: {} };
for (const [mode, pairs] of byMode) {
  if (!pairs.size) { console.log(`\n${mode}: no rows in the panel.`); continue; }
  const r = gateRerun({ pairs, screen, reps, seed, minClusters });
  report.modes[mode] = r;
  console.log(`\n${mode}: ${r.clusters} league-seasons, ${r.templates} screened templates `
    + `(${r.templates_unscreened} in the panel but not in the screen). Validator base rate: ${r.validator_base_rate}.`);
  console.log(`${pad('outcome', 10)}${pad('templ', 7)}${pad('conf', 6)}${pad('passes', 8)}${pad('base', 8)}`
    + `${pad('prec', 8)}${pad('recall', 8)}${pad('lift', 7)}${pad('90% CI', 18)}beats base`);
  for (const [o, s] of Object.entries(r.outcomes)) {
    console.log(`${pad(o, 10)}${pad(s.templates, 7)}${pad(s.confirmed, 6)}${pad(s.passes, 8)}${pad(s.base_rate, 8)}`
      + `${pad(s.precision, 8)}${pad(s.recall, 8)}${pad(s.lift, 7)}${pad(`${s.ci90[0]}..${s.ci90[1]}`, 18)}${s.beats_base}`);
  }
  for (const [o, s] of Object.entries(r.outcomes)) console.log(`  ${o}: ${s.statement}`);
  console.log(`  gate claim: ${r.gate_claim}${r.claimed_for.length ? ` (${r.claimed_for.join(', ')})` : ''}`);
}

const out = arg('out');
if (out) {
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`\nwrote ${out} (aggregates only)`);
} else {
  console.log('\nNothing written. Pass --out <file>.json to keep the table.');
}
