#!/usr/bin/env node
/**
 * U7 GAME-SHOCKS-CHECK (pre-registration docs/tdd/2026-09-25-u7-game-shocks-heldout.tdd.md).
 *
 * Public weekly stats (the registered decider, runs anywhere):
 *   node scripts/measure-game-shocks-heldout.mjs --csv stats_player_week_2021.csv,...,stats_player_week_2025.csv
 *   (files: https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_<season>.csv)
 *
 * The app's own weekly log (the local confirmation):
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy of the live db> node scripts/measure-game-shocks-heldout.mjs
 *
 * Options: --train 2021-2024 --test 2025 --reps 400 --boot 2000
 *
 * Fits archetype correlations on the train seasons only, then compares the held-out
 * season's same-game P(U_j > 0.9 | U_i > 0.9) with the Gaussian copula (flag off) and
 * the grouped-t nu 6 copula (flag on), with a game-bootstrap 95% interval. Prints PASS
 * or FAIL against the registered bar; q = 0.8 is printed for context only.
 * Read-only: nothing is written anywhere. Player ids only, no names.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const csvs = arg('--csv', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const [trainFrom, trainUntil] = arg('--train', '2021-2024').split('-').map(Number);
const testSeason = Number(arg('--test', 2025));
const reps = Number(arg('--reps', 400));
const B = Number(arg('--boot', 2000));

// The CSV route never touches the app database: point the module at a throwaway file.
let temp = null;
if (csvs && !process.env.GRIDIRON_DB_PATH) {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-u7-'));
  process.env.GRIDIRON_DB_PATH = path.join(temp, 'scratch.sqlite');
  process.env.SCHEDULER_DISABLED = '1';
}
const { sameGameResiduals, residualsFromLog } = await import('../server/services/correlation.js');
const { heldOutTailCheck, nflverseWeekRow } = await import('./lib/game-shocks-heldout.mjs');
const { parseCsv } = await import('../server/services/nflverse.js');

let train, test, source;
if (csvs) {
  const log = [];
  for (const f of csvs) {
    const { header, records } = parseCsv(fs.readFileSync(f, 'utf8'));
    for (const r of records) { const row = nflverseWeekRow(header, r); if (row) log.push(row); }
  }
  train = residualsFromLog(log, { from: trainFrom, until: trainUntil });
  test = residualsFromLog(log, { from: testSeason, until: testSeason });
  source = { kind: 'nflverse stats_player_week', files: csvs.map(f => path.basename(f)), rows: log.length };
} else {
  train = sameGameResiduals({ from: trainFrom, until: trainUntil });
  test = sameGameResiduals({ from: testSeason, until: testSeason });
  source = { kind: 'player_week_usage' };
}
if (!test.size) { console.log(`No held-out games for season ${testSeason}: nothing to measure.`); process.exit(1); }

const r4 = n => +n.toFixed(4);
const report = res => ({
  q: res.q, games: res.games, reps: res.reps, cholesky_fallbacks: res.cholesky_fallbacks,
  groups: Object.fromEntries(Object.entries(res.groups).map(([g, v]) => [g, {
    pairs: v.pairs, tail_events: v.events,
    ce_heldout: r4(v.ce_emp), ce_gaussian_off: r4(v.ce_off), ce_shocks_on: r4(v.ce_on),
    improvement: r4(v.diff), ci95: v.ci.map(r4), verdict: res.verdict.groups[g]
  }]))
});

const decide = heldOutTailCheck(train, test, { q: 0.9, reps, B, key: 7 });
const context = heldOutTailCheck(train, test, { q: 0.8, reps, B, key: 7 });
console.log(JSON.stringify({ source, train: [trainFrom, trainUntil], test: testSeason, nu: decide.nu, decides: report(decide), context_q08: report(context) }, null, 2));
console.log(`U7 ${decide.verdict.pass ? 'PASS' : 'FAIL'} (q 0.9, held-out ${testSeason}): ` +
  Object.entries(decide.verdict.groups).map(([g, v]) => `${g} ${v.pass ? 'pass' : 'fail'} (${v.reason})`).join('; '));
console.log(decide.verdict.pass
  ? 'GRIDIRON_GAME_SHOCKS may be turned on by Nick after the local confirmation run agrees.'
  : 'GRIDIRON_GAME_SHOCKS stays off.');

if (temp) fs.rmSync(temp, { recursive: true, force: true });
