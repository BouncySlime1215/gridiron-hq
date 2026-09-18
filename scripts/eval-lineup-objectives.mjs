/**
 * Combined regression eval: every lineup objective, every league, on the state that
 * actually ships.
 *
 *   GRIDIRON_DB_PATH=/path/copy.sqlite node scripts/eval-lineup-objectives.mjs [--json out.json]
 *
 * Why it exists. Each week-2 item was graded alone, against a snapshot of the others'
 * before-state, and nothing graded the combination: after the early-week blend made
 * every ensemble shift 0 and the fake-floors fix made a did-not-play week 0, every
 * floor was 0, and "Protect the floor" returned projection 0 with every margin a +0
 * coin flip in all five leagues. Run this on a fresh VACUUM INTO copy of production
 * after any promotion or availability refit.
 *
 * Rule (lineupObjectiveProblems): a call fails if it errors, if its lineup totals 0,
 * or if more than half of its contested margins are exact 0 ties while it claims to
 * have optimised the requested objective. An objective that falls back to week_points
 * and says so (objective_fallback) is honest and passes.
 *
 * Refuses the live database: lineupCall also computes the League Hub card, which writes
 * to decision_recommendations. Exit 0 = pass, 1 = a problem, 2 = refused or error.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

export const OBJECTIVES = ['mean', 'ceiling', 'floor'];

export function lineupObjectiveProblems(call) {
  if (call?.error) return [`error: ${call.error}`];
  const problems = [];
  const lineup = call?.lineup ?? [];
  if (lineup.length && !(call.projected_points > 0)) {
    problems.push(`projected_points ${call.projected_points} for a ${lineup.length}-player lineup`);
  }
  const contested = lineup.filter(c => c.margin != null);
  const ties = contested.filter(c => c.margin === 0).length;
  if (contested.length && ties > contested.length / 2 && !call.objective_fallback) {
    problems.push(`${ties} of ${contested.length} contested margins are exact ties on ${call.objective_used}`);
  }
  return problems;
}

async function main() {
  process.env.SCHEDULER_DISABLED = '1';
  const dbFile = process.env.GRIDIRON_DB_PATH;
  if (!dbFile || path.resolve(dbFile) === path.resolve('server/data.sqlite')) {
    console.error('Refusing: set GRIDIRON_DB_PATH to a copy (lineupCall writes Decision Inbox rows).');
    process.exit(2);
  }
  const { rows } = await import('../server/db/index.js');
  const { lineupCall } = await import('../server/services/lineup-brain.js');
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  const results = [];
  for (const lg of rows('SELECT id, name FROM leagues ORDER BY id')) {
    for (const objective of OBJECTIVES) {
      const call = lineupCall(lg.id, { objective });
      const problems = lineupObjectiveProblems(call);
      results.push({ league: lg.id, objective, used: call.objective_used ?? null,
        projected_points: call.projected_points ?? null, fallback: call.objective_fallback ?? null, problems });
      console.log(`${problems.length ? 'FAIL' : 'ok  '} league ${lg.id} ${objective.padEnd(7)} ` +
        `used ${String(call.objective_used).padEnd(11)} total ${call.projected_points}` +
        (problems.length ? `  -- ${problems.join('; ')}` : ''));
    }
  }
  const failed = results.filter(r => r.problems.length).length;
  console.log(`${failed ? 'FAIL' : 'PASS'}: ${results.length - failed} of ${results.length} calls clean`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ db: dbFile, results }, null, 1));
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error); process.exit(2); });
}
