// UI-ENG-5 mutation sweep (after the FIX-290 contract move): apply one string mutant, run the
// chess-path + layout tests, restore. Run from the repo root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const P = 'server/services/campaign/chess.js';
const S = 'server/services/campaign/plans-schema.js';
const E = 'server/services/campaign/view.js';
const B = 'scripts/campaign/produce-plans.mjs';
const C = 'client/src/components/warroom/ChessPath.tsx';
const W = 'client/src/components/warroom/WarRoom.tsx';
const A = 'server/services/warroom-actions/schema.js';
const M = [
  ['M1 backup: drop the shared-prefix check', P, "if (other.steps.slice(0, k).map(moveKey).join('|') !== prefix) continue;", ''],
  ['M2 backup: allow the same move as the backup', P, 'if (moveKey(alt) === own) continue;', ''],
  ['M3 claim not_modelled priced as its p (100%)', P, "const pYes = s => (s.p_basis === 'not_modelled' ?", 'const pYes = s => (false ?'],
  ['M4 clears_2se always true', P, 'out.clears_2se = fin(se) && se > 0 && Math.abs(value) > SE_MULTIPLE * se;', 'out.clears_2se = true;'],
  ['M5 deadline ignored', P, 'if (deadline == null || now == null) return path.steps;', 'return path.steps;'],
  ['M6 cut path keeps the whole path totals', P, 'const t = cut ? keptTotals(steps) : null;', 'const t = null;'],
  ['M7 replay flag read from preview', P, "export const chessReplayPassed = (env = process.env) => env[CHESS_REPLAY_ENV] === '1';",
    "export const chessReplayPassed = (env = process.env) => env[CHESS_REPLAY_ENV] === '1' || env.GRIDIRON_PREVIEW_UNCONFIRMED === '1';"],
  ['M8 argument slot dropped to ok', P, "argument: unknown(WHY.argument, 'coach.text'),", "argument: { status: 'ok', source: 'coach.text', value: { believes: 'x', why_yes: 'x', could_go_wrong: 'x', would_change: 'x' } },"],
  ['M9 contract: chess section removed', S, '  chess: field(chess)\n', ''],
  ['M10 producer: chess not passed to toEntry', B, 'number_health: brain ? brain.numberHealth(id) : null, chess: chessIn });', 'number_health: brain ? brain.numberHealth(id) : null });'],
  ['M11 toEntry: section names not merged', E, 'names: { ...names, ...chessOut.names },', 'names,'],
  ['M12 client: fallback ignored', C, 'if (!cp.replay_passed) return', 'if (false) return'],
  ['M13 client: no grey', C, "const grey = isOk(s.change_after) && s.change_after.clears_2se !== true;", 'const grey = false;'],
  ['M14 client: compact shows every branch', C, 'showBranch={big || sel === k}', 'showBranch={true}'],
  ['M15 client: deadline week not shown', C, "Trade deadline: {cp.deadline_week == null ? 'unknown' : `week ${cp.deadline_week}`}", 'Trade deadline'],
  ['M16 grid: clones area removed', W, "'next next clones flip_map coach',", "'next next flip_map flip_map coach',"],
  ['M17 coach: path not a focus_panel id', A, "  'path'\n]);", ']);'],
  ['CONTROL survive: reword the hint (not asserted)', C, 'One step a week from now.', 'A step a week.'],
  ['CONTROL not-applied: pattern absent', P, 'THIS STRING IS NOT IN THE FILE', 'x'],
];
const rows = [];
for (const [name, file, from, to] of M) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { rows.push([name, 'not applied']); continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const env = { ...process.env, SCHEDULER_DISABLED: '1', NODE_OPTIONS: '--import ./test/offline-guard.mjs',
      GRIDIRON_DB_PATH: path.join(os.tmpdir(), `ui-eng-5-sweep-${process.pid}-${rows.length}.sqlite`) };
    const r = spawnSync('node', ['--experimental-test-module-mocks', '--test', 'test/war-room-chess-path.test.js', 'test/war-room-layout.test.js'], { encoding: 'utf8', env });
    const fail = /# fail (\d+)/.exec(r.stdout)?.[1];
    rows.push([name, fail && fail !== '0' ? `killed (${fail} failing)` : fail === '0' ? 'SURVIVED' : `no result: ${r.stderr.slice(0, 120)}`]);
  } finally { fs.writeFileSync(file, orig); }
}
for (const [n, r] of rows) console.log(`| ${n} | ${r} |`);
