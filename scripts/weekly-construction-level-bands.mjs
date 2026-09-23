/**
 * S-02 amendment 1 §3.2: level (mean signed error) by projection band and by the weekly
 * starter proxy, on graded rows dumped from a weekly-construction-grade run. Report-only.
 *
 *   GRIDIRON_DB_PATH=<a copy> SCHEDULER_DISABLED=1 node scripts/weekly-construction-level-bands.mjs \
 *     --season 2025 --rows <rows-2025.ndjson> [--output <the run's output json>] [--out file.json]
 *
 * Rows: the runner's row objects, one JSON per line, as `--rows-dir` writes them
 * (player_id, week, position, played, decision, actual, lift, lift_applied, preds).
 * Stop condition (reproduction control): before any band is computed, the rows must
 * reproduce the run's committed output. 2025: n_played, n_decision, mae and signed_error of
 * every arm in both windows (held_out.windows). 2024: A's λ = 0 grid MAE and m0 of arms
 * A-S2 in both windows (fit_split). Any mismatch stops the script and prints it.
 *
 * Reads no database table; the database path is only needed because the library imports
 * the served modules. Output: aggregates only, labelled "local copy, not production".
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = 'docs/evidence/2026-09-22/weekly-construction-grade-output.json';
const WINDOWS = ['2-4', '5-17'];
const BAND_ARMS = ['A', 'B', 'C', 'D', 'S1', 'S2'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const season = Number(arg('--season'));
  const rowsPath = arg('--rows');
  if (![2024, 2025].includes(season)) throw new Error('--season must be 2024 (fit split) or 2025 (held out)');
  if (!rowsPath) throw new Error('--rows <ndjson> is required');
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a COPY of the app database');
  const lib = await import('./weekly-construction-grade-lib.mjs');
  const text = fs.readFileSync(path.resolve(rowsPath), 'utf8');
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  const output = JSON.parse(fs.readFileSync(path.resolve(ROOT, arg('--output') ?? DEFAULT_OUTPUT), 'utf8'));

  const byWindow = Object.fromEntries(WINDOWS.map(w => [w, rows.filter(r => lib.weekWindow(r.week) === w)]));
  const mismatches = [];
  for (const w of WINDOWS) {
    if (!byWindow[w].some(r => r.played)) throw new Error(`window ${w} has no played rows in ${rowsPath}`);
    if (season === 2025) {
      const table = output.held_out?.windows?.[w]?.arms;
      if (!table) throw new Error(`the output file has no held_out.windows['${w}'].arms`);
      for (const m of lib.reproductionMismatches(byWindow[w], table, lib.ARMS)) mismatches.push({ window: w, ...m });
    } else {
      const split = output.fit_split;
      if (!split?.lambda?.[w] || !split?.m0?.[w]) throw new Error(`the output file has no fit_split for window ${w}`);
      const lambdaRows = byWindow[w].map(r => ({ played: r.played, A: r.preds.A, lift: r.lift, lift_applied: r.lift_applied, actual: r.actual }));
      const got = lib.lambdaMaes(lambdaRows).find(e => e.lambda === 0).mae;
      const want = split.lambda[w].grid.find(e => e.lambda === 0).mae;
      if (!(Math.abs(got - want) < 5e-5)) mismatches.push({ window: w, field: 'A mae (lambda 0 grid)', got, want });
      for (const arm of BAND_ARMS) {
        const m0 = lib.m0For(byWindow[w], arm);
        if (!(Math.abs(m0 - split.m0[w][arm]) < 5e-5)) mismatches.push({ window: w, arm, field: 'm0', got: m0, want: split.m0[w][arm] });
      }
    }
  }
  if (mismatches.length) {
    console.error(JSON.stringify(mismatches, null, 1));
    throw new Error(`reproduction control failed: ${mismatches.length} mismatches; no band is reported`);
  }

  const report = {
    unit: 'S-02', what: 'amendment 1 section 3.2: mean signed error (prediction - actual) by band, player-clustered 90% CI',
    label: 'local copy, not production', season,
    rows: { file: path.basename(rowsPath), sha256: crypto.createHash('sha256').update(text).digest('hex'), n: rows.length },
    reproduction: season === 2025
      ? 'passed: n_played, n_decision, mae, signed_error of every arm in both windows match held_out.windows to 4 dp'
      : 'passed: A lambda-0 MAE and m0 of arms A-S2 in both windows match fit_split to 4 dp',
    starter_quota: lib.STARTER_QUOTA,
    windows: Object.fromEntries(WINDOWS.map(w => [w, lib.levelBands(byWindow[w], BAND_ARMS)]))
  };
  const out = arg('--out');
  if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  for (const w of WINDOWS) {
    console.log(`\n${season} weeks ${w}`);
    for (const [set, v] of Object.entries(report.windows[w])) {
      console.log(`  ${set.padEnd(18)} n=${String(v.n).padStart(5)}  ` + BAND_ARMS.map(a => {
        const x = v.arms[a];
        return `${a} ${x.mean >= 0 ? '+' : ''}${x.mean.toFixed(3)} [${x.ci90?.map(c => c.toFixed(3)).join(', ') ?? x.error}]`;
      }).join('  '));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
