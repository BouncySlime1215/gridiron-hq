/**
 * Promote one stored fantasy-coordinator fit so it is the served fit (S-03).
 *
 * Since S-03 a fit in fantasy_coordinator_fits is a candidate until it is promoted:
 * fantasy-coordinator.js#activeFantasyCoordinatorFit returns only the promoted row, and with
 * none the served weekly number is the ensemble alone (labelled). This is the one way a row
 * gets promoted, and it writes nothing unless every check passes:
 *
 *   1. migration 072 has run on the database (the promotion columns exist);
 *   2. the evidence is S-03's committed --walk-forward output, and it names this fit (id,
 *      through season, structural target); its per-window decisions become the windows;
 *   3. the stored fit reproduces: the served fitter on examples 2022..through_season, with
 *      the engine as it is now, gives identical coefficients and row count. (On the local
 *      copy five rows all "through 2025" carry intercepts from −0.574 to +0.578: which engine
 *      a row was fitted on matters, and this is where it is checked);
 *   4. promoteFantasyCoordinatorFit's own gates (ready, fitter version, known target).
 *
 * Usage (the database it is pointed at is the one it changes):
 *   GRIDIRON_DB_PATH=<db> SCHEDULER_DISABLED=1 NFL_SEASON=2026 node --max-old-space-size=3072 \
 *     scripts/promote-fantasy-coordinator-fit.mjs --id <n> \
 *     --evidence docs/evidence/2026-09-22/weekly-construction-walk-forward-output.json [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIT_FROM = 2022;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** The evidence must be committed and unchanged where a checkout exists to say so. */
function evidenceState(rel) {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    return { git: false, note: `no git checkout here (${error.message.split('\n')[0]}); the file's hash is recorded instead` };
  }
  if (!tracked) throw new Error(`${rel} is not committed; promote only on a committed grade`);
  if (execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: ROOT, encoding: 'utf8' }).trim()) {
    throw new Error(`${rel} has uncommitted changes`);
  }
  return { git: true, commit: execFileSync('git', ['log', '-1', '--format=%H', '--', rel], { cwd: ROOT, encoding: 'utf8' }).trim() };
}

async function main() {
  const id = Number(arg('--id'));
  const evidencePath = arg('--evidence');
  const dryRun = process.argv.includes('--dry-run');
  if (!Number.isInteger(id)) throw new Error('--id <fantasy_coordinator_fits id> is required');
  if (!evidencePath) throw new Error('--evidence <S-03 walk-forward output JSON> is required');
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to the database to promote in');
  process.env.SCHEDULER_DISABLED = '1';

  const rel = path.relative(ROOT, path.resolve(ROOT, evidencePath));
  const text = fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const state = evidenceState(rel);
  const report = JSON.parse(text);

  const { dbPath, rows } = await import('../server/db/index.js');
  const coordinator = await import('../server/services/fantasy-coordinator.js');
  const wf = await import('./weekly-construction-walk-forward-lib.mjs');

  // 1. Migration 072.
  const cols = rows('PRAGMA table_info(fantasy_coordinator_fits)').map(c => c.name);
  if (!cols.includes('promoted') || !cols.includes('promotion_json')) {
    throw new Error('migration 072 has not run on this database: start the server once (it migrates at boot) or run npm run db:migrate');
  }
  const stored = rows('SELECT id, version, through_season, rows, created_at, fit_json FROM fantasy_coordinator_fits WHERE id = ?', id)[0];
  if (!stored) throw new Error(`no fantasy_coordinator_fits row ${id}`);
  const fit = JSON.parse(stored.fit_json);

  // 2. The evidence names this fit, and its decisions are the windows.
  const { windows } = wf.promotionFromEvidence(report, { id, through_season: stored.through_season, target: coordinator.fitTargetOf(fit) });
  console.log(`[promote] ${path.basename(dbPath)}: fit ${id} (through ${stored.through_season}, ${stored.rows} rows, created ${stored.created_at})`);
  console.log(`[promote] evidence ${rel} sha256 ${sha.slice(0, 16)} ${state.git ? `committed ${state.commit.slice(0, 8)}` : state.note}`);
  console.log(`[promote] windows ${JSON.stringify(windows)}`);

  // 3. The stored fit reproduces from this database now.
  const examples = await coordinator.buildFantasyCoordinatorExamples({ fromSeason: FIT_FROM, throughSeason: stored.through_season });
  const refit = coordinator.fitFantasyCoordinator(examples);
  if (refit.rows !== stored.rows) throw new Error(`the refit has ${refit.rows} rows, the stored fit ${stored.rows}: the data changed since it was fitted`);
  const reproduction = wf.refitReproduces(fit, refit);
  console.log(`[promote] reproduction: ${examples.length} examples, max coefficient difference ${reproduction.max_abs_coefficient_diff}`);

  if (dryRun) { console.log('[promote] --dry-run: every check passed, nothing written'); return; }
  // 4. The service's own gates, then the write (one transaction; the previous row is demoted).
  const served = coordinator.promoteFantasyCoordinatorFit(id, { windows, evidence: `${rel} sha256:${sha.slice(0, 16)}` });
  console.log(`[promote] served fit is now ${served.fit_row.id}: ${JSON.stringify(served.promotion)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), error => { console.error(error.message ?? error); process.exit(1); });
}
