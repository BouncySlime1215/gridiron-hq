// Mutation sweep for test/data-credit-line.test.js (unit F-08). Each mutation
// breaks one promise the credit line, its App mount, the route's `sources`, or
// a descriptor makes; the test must fail on every one. Runs in a throwaway git
// worktree at HEAD with node_modules linked in, so the working tree is never
// written.
// Usage: node docs/tdd/sweeps/data-credit-line-mutations.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const banner = 'client/src/components/DataFreshnessBanner.tsx';
const appFile = 'client/src/App.tsx';
const route = 'server/routes/data-freshness.js';
const ftn = 'server/services/ftn-charting-source.js';
const ffo = 'server/services/ffopportunity.js';
const loader = 'server/services/nfl-formations.js';
const ftnRow = "  { repo: 'nflverse/nflverse-data', dataset: 'ftn_charting', name: 'FTN Data via nflverse',\n    href: 'https://github.com/nflverse/nflverse-data/releases/tag/ftn_charting',\n    license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },\n";

const mutations = [
  // The unit: the credit component and its list.
  ['M1 credit hides when every source is current', banner, (s) => s.replace('export function DataCredit() {\n  return (',
    "export function DataCredit() {\n  const { data } = useApi<FreshnessReport>('/data-freshness');\n  if (data?.all_fresh) return null;\n  return (")],
  ['M2 credit hides once the banner is dismissed', banner, (s) => s.replace('export function DataCredit() {\n  return (',
    "export function DataCredit() {\n  if (sessionStorage.getItem('data-freshness-dismissed') === '1') return null;\n  return (")],
  ['M3 FTN dropped from the credit list', banner, (s) => s.replace(ftnRow, '')],
  ['M4 FTN credited under CC BY 4.0', banner, (s) => s.replace(ftnRow, ftnRow.replace("license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/'", "license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/'"))],
  ['M5 FTN named without "via nflverse"', banner, (s) => s.replace("name: 'FTN Data via nflverse'", "name: 'FTN Data'")],
  ['M6 licence names shown but not linked', banner, (s) => s.replace('<a href={c.licenseUrl} target="_blank" rel="noreferrer license" className={creditLink}>{c.license}</a>', '{c.license}')],
  ['M7 no note that the data was changed', banner, (s) => s.replace('      , adapted for this app.\n', '      .\n')],
  // The route and the descriptors: the one producer of the source list.
  ['M8 route drops FTN from sources', route, (s) => s.replace('sources: [NFLVERSE_SOURCE, FFOPPORTUNITY_SOURCE, FTN_CHARTING_SOURCE]', 'sources: [NFLVERSE_SOURCE, FFOPPORTUNITY_SOURCE]')],
  ['M9 ffopportunity back to CC BY 4.0', ffo, (s) => s.replace("  data_license: 'CC BY-SA 4.0',\n  license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',", "  data_license: 'CC BY 4.0',\n  license_url: 'https://creativecommons.org/licenses/by/4.0/',")],
  ['M10 FTN descriptor names a release the loader does not fetch', ftn, (s) => s.replace("releases/download/ftn_charting',", "releases/download/ftn_charts',")],
  ['M11 FTN descriptor not frozen', ftn, (s) => s.replace('export const FTN_CHARTING_SOURCE = Object.freeze({', 'export const FTN_CHARTING_SOURCE = ({')],
  ['M12 loader fetches a different FTN release', loader, (s) => s.replace('fetch(`${BASE}/ftn_charting/ftn_charting_${season}.csv`', 'fetch(`${BASE}/ftn_charts/ftn_charts_${season}.csv`')],
  // The call site: App must mount it once, after the page, unconditionally.
  ['M13 App no longer renders the credit', appFile, (s) => s.replace('        <DataCredit />\n', '')],
  ['M14 App renders the credit behind a condition', appFile, (s) => s.replace('        <DataCredit />\n', '        {!inBetting && <DataCredit />}\n')],
  ['M15 App renders the credit above the page, beside the banner', appFile, (s) => s.replace('        <DataCredit />\n', '').replace('        <DataFreshnessBanner />\n', '        <DataFreshnessBanner />\n        <DataCredit />\n')],
];

// Controls. The surviving control changes the footer's text colour, a real code
// edit the tests deliberately do not pin: if it is killed, the tests over-pin
// styling. The not-applied control targets text that is not in the file, so the
// runner must report it INVALID rather than count it as killed.
const controls = [
  ['C1 footer text colour changed (must survive)', banner, (s) => s.replace('leading-relaxed text-slate-500', 'leading-relaxed text-slate-400'), 'survived'],
  ['C2 pattern absent (must be INVALID)', ftn, (s) => s.replace("data_license: 'ODbL'", "data_license: 'CC0'"), 'invalid'],
];

const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-credit-mut-'));
const wt = path.join(dir, 'wt');
execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', '-q', wt, 'HEAD']);
fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules'));
let survivors = 0;
let controlFailures = 0;
try {
  for (const [name, file, mutate, expected] of [...mutations, ...controls]) {
    const target = path.join(wt, file);
    const before = fs.readFileSync(target, 'utf8');
    const after = mutate(before);
    let outcome;
    let failed = [];
    if (code(after) === code(before)) outcome = 'invalid';
    else {
      fs.writeFileSync(target, after);
      const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', 'test/data-credit-line.test.js'], {
        cwd: wt, encoding: 'utf8',
        env: { ...process.env, SCHEDULER_DISABLED: '1', NODE_OPTIONS: '--import ./test/offline-guard.mjs' }
      });
      fs.writeFileSync(target, before);
      failed = (r.stdout.match(/^not ok \d+ - (.*)$/gm) || []).map((l) => l.replace(/^not ok (\d+) - .*/, 'test $1'));
      outcome = r.status === 0 ? 'survived' : 'killed';
    }
    const detail = failed.length ? `  <- ${failed.join(', ')}` : '';
    if (expected) {
      if (outcome !== expected) controlFailures++;
      console.log(`${outcome === expected ? 'control ' : 'CONTROL FAILED'} ${name}: ${outcome}${detail}`);
    } else {
      if (outcome !== 'killed') survivors++;
      const label = { invalid: 'INVALID ', survived: 'SURVIVED', killed: 'killed  ' }[outcome];
      console.log(`${label} ${name}${outcome === 'invalid' ? ' (changed nothing, or only comments)' : ''}${detail}`);
    }
  }
} finally {
  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', wt]);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${mutations.length} applied, ${mutations.length - survivors} killed, ${survivors} survived or invalid; ${controls.length - controlFailures} of ${controls.length} controls as designed`);
process.exit(survivors || controlFailures ? 1 : 0);
