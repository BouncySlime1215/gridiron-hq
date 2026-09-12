#!/usr/bin/env node
/**
 * Runs Giant Plan 7.5's exit test for the weather wiring and prints both
 * numbers: total-line error for the old flat league constant and for the
 * per-offense response, on the same held-out games, split by how pass-heavy
 * the two offenses are.
 *
 * This measures a forecasting change, so "the tests pass" is not the question
 * it answers. The question is whether error went down on games nobody fitted
 * on, and the honest answer may be no -- in which case that is the finding,
 * and the wiring should not be promoted on the strength of being correct.
 *
 * It needs populated history (game_lines with scores, weather and totals, plus
 * nfl_team_week_features). Point it at a COPY of a populated database, never
 * at a live one:
 *
 *   GRIDIRON_DB_PATH=/tmp/history-copy.sqlite SCHEDULER_DISABLED=1 \
 *     node scripts/measure-weather-split.mjs [evalFrom]
 */
process.env.SCHEDULER_DISABLED ??= '1';

const evalFrom = Number(process.argv[2] ?? 2022);
const { weatherComponentDiagnostic } = await import('../server/services/nfl-ensemble.js');
const out = weatherComponentDiagnostic({ evalFrom });

if (out.error) {
  console.error(`cannot measure: ${out.error}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 8) => String(v == null ? '—' : v).padStart(n);

console.log(`\nweather_total — flat constant vs per-offense response`);
console.log(`evaluation from ${out.eval_from}, ${out.weather_games} weather-affected games\n`);
console.log(pad('split', 12), num('n', 6), num('flat RMSE'), num('new RMSE'), num('ΔRMSE'),
  num('flat MAE'), num('new MAE'), num('ΔMAE'), num('paired t'), num('differ'));
for (const [name, s] of Object.entries(out.splits)) {
  if (!s) { console.log(pad(name, 12), '  (no games)'); continue; }
  console.log(pad(name, 12), num(s.n, 6), num(s.flat.rmse), num(s.wired.rmse), num(s.rmse_delta),
    num(s.flat.mae), num(s.wired.mae), num(s.mae_delta), num(s.paired_t), num(s.differing_games));
}
console.log(`\n${out.note}`);
console.log('A change that does not lower error here has not earned promotion, however correct it is.\n');
