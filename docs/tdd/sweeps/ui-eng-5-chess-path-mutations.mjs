// UI-ENG-5 mutation sweep: apply one string mutant, run the chess-path + layout tests, restore. Run from the repo root.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const V = 'server/services/war-room-view.js';
const C = 'client/src/components/warroom/ChessPath.tsx';
const W = 'client/src/components/warroom/WarRoom.tsx';
const M = [
  ['M1 backup: drop the shared-prefix check', V, "if (other.steps.slice(0, k).map(moveKey).join('|') !== prefix) continue;", ''],
  ['M2 backup: allow the same move as the backup', V, 'if (moveKey(alt) === own) continue;', ''],
  ['M3 claim not_modelled priced as its p (100%)', V, "return s.p_basis === 'not_modelled' ?", "return false ?"],
  ['M4 keep = this step, not the previous one', V, 'chessChange(p.steps[k - 1])', 'chessChange(p.steps[k])'],
  ['M5 call site: chess_path reads entry.acq', V, 'view.chess_path = chessPath(n, entry.chess);', 'view.chess_path = chessPath(n, entry.acq);'],
  ['M6 call site: failed league run leaves chess visible', V, "flips: failed(r, 'sim.title'), chess_path: failed(r, 'sim.title') }, flag);\n  }\n  if", "flips: failed(r, 'sim.title') }, flag);\n  }\n  if"],
  ['M7 client: compact shows every branch', C, 'showBranch={big || sel === k}', 'showBranch={true}'],
  ['M8 client: no branch unless big', C, 'showBranch={big || sel === k}', 'showBranch={big}'],
  ['M9 client: claim unknown shows the generic state', C, "s.kind === 'claim' && s.p_yes.status === 'unknown'", 'false'],
  ['M10 grid: path area removed', W, "'next next path stops coach',\n  'next next path flip coach',", "'next next stops stops coach',\n  'next next flip flip coach',"],
  ['CONTROL survive: reword the path note (not asserted)', V, 'Searched paths, best expected gain first.', 'Searched paths, best first.'],
  ['CONTROL not-applied: pattern absent', V, 'THIS STRING IS NOT IN THE FILE', 'x'],
];
const rows = [];
for (const [name, file, from, to] of M) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { rows.push([name, 'not applied']); continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync('node', ['--test', 'test/war-room-chess-path.test.js', 'test/war-room-layout.test.js'], { encoding: 'utf8' });
    const fail = /# fail (\d+)/.exec(r.stdout)?.[1];
    rows.push([name, fail && fail !== '0' ? `killed (${fail} failing)` : 'SURVIVED']);
  } finally { fs.writeFileSync(file, orig); }
}
for (const [n, r] of rows) console.log(`| ${n} | ${r} |`);
