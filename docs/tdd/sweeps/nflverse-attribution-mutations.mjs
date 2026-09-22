// Mutation sweep for test/nflverse-attribution.test.js. Each mutation breaks one
// promise the descriptor or the route makes; the test must fail on every one.
// Runs in a throwaway git worktree at HEAD with node_modules linked in, so the
// working tree is never written.
// Usage: node docs/tdd/sweeps/nflverse-attribution-mutations.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const src = 'server/services/nflverse.js';
const route = 'server/routes/data-freshness.js';
const adv = 'server/services/nfl-advanced.js';
const mutations = [
  ['M1 route drops sources', route, (s) => s.replace(',\n    sources: [NFLVERSE_SOURCE, FFOPPORTUNITY_SOURCE]', '')],
  ['M2 route drops ffopportunity', route, (s) => s.replace('sources: [NFLVERSE_SOURCE, FFOPPORTUNITY_SOURCE]', 'sources: [NFLVERSE_SOURCE]')],
  ['M3 descriptor not frozen', src, (s) => s.replace('export const NFLVERSE_SOURCE = Object.freeze({', 'export const NFLVERSE_SOURCE = ({')],
  ['M4 wrong licence', src, (s) => s.replace("  data_license: 'CC BY 4.0',\n  license_url", "  data_license: 'CC BY-SA 4.0',\n  license_url")],
  ['M5 licence link dropped', src, (s) => s.replace("  license_url: 'https://creativecommons.org/licenses/by/4.0/',\n", '')],
  ['M6 claims unmodified', src, (s) => s.replace('  modified: true,', '  modified: false,')],
  ['M7 modification not described', src, (s) => s.replace(/  modification: '[^']*',\n/, '')],
  ['M8 creator dropped', src, (s) => s.replace("  creator: 'nflverse',\n", '')],
  ['M9 a second fetch base drifts from the descriptor', adv, (s) => s.replace("const REL = 'https://github.com/nflverse/nflverse-data/releases/download';", "const REL = 'https://github.com/nflverse/nflverse-data/releases/download-mirror';")],
  ['M10 descriptor names a narrower release URL', src, (s) => s.replace('  release_url: RELEASE,', "  release_url: RELEASE + '/players',")],
];

const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nflverse-mut-'));
const wt = path.join(dir, 'wt');
execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', '-q', wt, 'HEAD']);
fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules'));
let survivors = 0;
try {
  for (const [name, file, mutate] of mutations) {
    const target = path.join(wt, file);
    const before = fs.readFileSync(target, 'utf8');
    const after = mutate(before);
    if (code(after) === code(before)) { console.log(`INVALID  ${name} (changed nothing, or only comments)`); survivors++; continue; }
    fs.writeFileSync(target, after);
    const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', 'test/nflverse-attribution.test.js'], {
      cwd: wt, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--import ./test/offline-guard.mjs' }
    });
    fs.writeFileSync(target, before);
    const failed = (r.stdout.match(/^not ok \d+ - (.*)$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
    if (r.status === 0) { survivors++; console.log(`SURVIVED ${name}`); }
    else console.log(`killed   ${name}  <- ${failed.join(' | ')}`);
  }
} finally {
  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', wt]);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${mutations.length} applied, ${mutations.length - survivors} killed, ${survivors} survived or invalid`);
process.exit(survivors ? 1 : 0);
