// Mutation sweep for test/deploy-workflow.test.js. Each mutation breaks one
// promise the workflow or .dockerignore makes; the suite must fail on every
// one. Runs on copies in a temp dir, so the working tree is never written.
// Usage: node docs/tdd/sweeps/deploy-workflow-mutations.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const files = ['test/deploy-workflow.test.js', '.github/workflows/deploy.yml', '.dockerignore', 'Dockerfile'];

const wf = '.github/workflows/deploy.yml';
const di = '.dockerignore';
const mutations = [
  ['M1 also runs on push to main', wf, (s) => s.replace('on:\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n  push:\n    branches: [main]\n')],
  ['M2 also runs on a schedule', wf, (s) => s.replace('on:\n  workflow_dispatch:\n', "on:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 6 * * *'\n")],
  ['M3 no timeout', wf, (s) => s.replace(/\n\s+timeout-minutes: \d+/, '')],
  ['M4 deploy before the brake', wf, (s) => {
    const brake = s.slice(s.indexOf('      - name: Re-assert the brake'), s.indexOf('      - name: Deploy\n'));
    const deploy = s.slice(s.indexOf('      - name: Deploy\n'), s.indexOf('      - name: Confirm'));
    return s.replace(brake + deploy, deploy + brake);
  }],
  ['M5 brake step removed', wf, (s) => s.replace(/      - name: Re-assert the brake[\s\S]*?(?=      - name: Deploy\n)/, '')],
  ['M6 confirmation step removed', wf, (s) => s.replace(/      - name: Confirm[\s\S]*$/, '')],
  ['M7 releases the brake at the end', wf, (s) => s + '\n      - name: Release\n        env:\n          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}\n        run: flyctl secrets unset SCHEDULER_DISABLED --app gridiron-hq\n'],
  ['M8 local build instead of remote-only', wf, (s) => s.replace('run: flyctl deploy --remote-only', 'run: flyctl deploy')],
  ['M9 wrong app', wf, (s) => s.replace('run: flyctl deploy --remote-only --app gridiron-hq', 'run: flyctl deploy --remote-only --app gridiron-hq-staging')],
  ['M10 token interpolated into a script', wf, (s) => s.replace('run: flyctl deploy --remote-only --app gridiron-hq', 'run: FLY_API_TOKEN=${{ secrets.FLY_API_TOKEN }} flyctl deploy --remote-only --app gridiron-hq')],
  ['M11 token echoed', wf, (s) => s.replace('run: flyctl deploy --remote-only --app gridiron-hq', 'run: |\n          echo "token: $FLY_API_TOKEN"\n          flyctl deploy --remote-only --app gridiron-hq')],
  ['M12 shell tracing on', wf, (s) => s.replace('run: flyctl deploy --remote-only --app gridiron-hq', 'run: |\n          set -ex\n          flyctl deploy --remote-only --app gridiron-hq')],
  ['M13 commit sha interpolated straight into the script', wf, (s) => s.replace(/run: echo "Deploying \$\{SHA\}/, 'run: echo "Deploying ${{ github.sha }}')],
  ['M14 first step no longer names the commit', wf, (s) => s.replace(/      - name: Print the commit[\s\S]*?(?=      - name: Checkout)/, '')],
  ['M15 a second job', wf, (s) => s + '\n  notify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done\n'],
  ['M16 data/ back in the context', di, (s) => s.replace(/^data$/m, '')],
  ['M17 test/ back in the context', di, (s) => s.replace(/^test$/m, '')],
  ['M18 local sqlite files back in the context', di, (s) => s.replace(/^\*\*\/\*\.sqlite\*$/m, '')],
  ['M19 nested node_modules back in the context', di, (s) => s.replace(/^\*\*\/node_modules$/m, 'node_modules')],
  ['M20 data unanchored, taking server/data/ with it', di, (s) => s.replace(/^data$/m, '**/data')],
  ['M21 server/ excluded', di, (s) => s + '\nserver\n'],
  ['M22 client source excluded', di, (s) => s + '\nclient/src\n'],
];

// Controls. The surviving control is a real code edit that no promise covers,
// so the suite must pass it: if it is killed, the tests pin something they
// should not. The not-applied control targets text that is not in the file,
// so the runner must report it INVALID rather than count it as killed.
const controls = [
  ['C1 step renamed (must survive)', wf, (s) => s.replace('      - name: Checkout\n', '      - name: Check out the repository\n'), 'survived'],
  ['C2 pattern absent (must be INVALID)', wf, (s) => s.replace('run: flyctl deploy --local-only', 'run: flyctl deploy'), 'invalid'],
];

let survivors = 0;
let controlFailures = 0;
for (const [name, file, mutate, expected] of [...mutations, ...controls]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-mut-'));
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(dir, f));
  }
  const target = path.join(dir, file);
  const before = fs.readFileSync(target, 'utf8');
  const after = mutate(before);
  const code = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  let outcome;
  let failed = [];
  if (code(after) === code(before)) outcome = 'invalid';
  else {
    fs.writeFileSync(target, after);
    const r = spawnSync(process.execPath, ['--test', path.join(dir, 'test/deploy-workflow.test.js')], { encoding: 'utf8' });
    failed = (r.stdout.match(/^not ok \d+ - (.*)$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
    outcome = r.status === 0 ? 'survived' : 'killed';
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const label = { invalid: 'INVALID ', survived: 'SURVIVED', killed: 'killed  ' }[outcome];
  if (expected) {
    const ok = outcome === expected;
    if (!ok) controlFailures++;
    console.log(`${ok ? 'control ' : 'CONTROL FAILED'} ${name}: ${outcome}${failed.length ? `  <- ${failed.join(' | ')}` : ''}`);
  } else {
    if (outcome !== 'killed') survivors++;
    console.log(`${label} ${name}${outcome === 'invalid' ? ' (changed nothing, or only comments)' : ''}${failed.length ? `  <- ${failed.join(' | ')}` : ''}`);
  }
}
console.log(`\n${mutations.length} applied, ${mutations.length - survivors} killed, ${survivors} survived or invalid; ${controls.length - controlFailures} of ${controls.length} controls as designed`);
process.exit(survivors || controlFailures ? 1 : 0);
