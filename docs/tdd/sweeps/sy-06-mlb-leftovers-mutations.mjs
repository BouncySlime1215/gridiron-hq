// Mutation sweep for SY-06 (PR #159): test/mlb-removed.test.js tests 14-17 and the MLB
// case in test/decision-inbox.test.js. Each mutant puts one piece of the removal back,
// in the unit or at a call site: an MLB export or sport key, 'MLB' as an accepted sport,
// the MLB props board or its saved-slip router (at its old path, imported or mounted
// from anywhere, or copied to a new path), or a reader or writer of the two tables those
// routers owned. The tests must fail on every one, and on the test written for it.
// Runs in a throwaway git worktree at HEAD with node_modules linked in, so the working
// tree is never written; the worktree is checked clean after every mutant.
// Usage: node docs/tdd/sweeps/sy-06-mlb-leftovers-mutations.mjs [--rev <commit>] [--only ID,ID]
// (--rev replays chosen mutants against an older commit's tests, e.g. the ones that
// survived at 40ffeee0; the full sweep is meant for HEAD.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE = 'd3dca8b62661af6616f08808255fa3e00d364d47';   // #159's base: both routers still mounted
const TESTS = ['test/mlb-removed.test.js', 'test/decision-inbox.test.js'];

const DI = 'server/routes/decision-inbox.js';
const IDX = 'server/index.js';
const BH = 'server/routes/betting-hub.js';
const OA = 'server/services/odds-api.js';
const NB = 'server/routes/nfl-betting.js';
const SCHEMA = 'server/db/schema/core-and-fantasy.js';

// Test names, so a kill is credited only to the test built for it, never to a crash.
const T14 = 'odds-api.js no longer exports MLB-only symbols';
const T15 = 'the MLB props board and its saved-slip router are deleted';
const T16 = 'betting-hub.js no longer computes an MLB standing';
const T17 = 'props_auto_picks and saved_prop_tickets stay on disk';
const TDI = 'a publish with sport MLB is rejected rather than stored';

const SPORT_LINE = "const SPORT = 'americanfootball_nfl';\n";
const FLATTEN_DOC = '/**\n * Flattens the nested bookmaker -> market -> outcome shape';
const SPORT_CHECK = "  if (!VALID_SPORT.has(sport)) throw new Error(`publishRecommendation: invalid sport \"${sport}\"`);\n";
const INSERT_TAIL = "    sourceModel, sourceVersion, link, dedupKey);\n  return toRecommendation(row('SELECT * FROM decision_recommendations WHERE id = ?', id));\n";
const IDX_IMPORT_ANCHOR = "const { default: nflMarketRouter } = await import('./routes/nfl-market.js');\n";
const IDX_MOUNT_ANCHOR = "app.use('/api/nfl-market', ...legacyAuthenticated, nflMarketRouter);\n";
const IDX_STATIC_ANCHOR = "import { healthHandler } from './platform/health.js';\n";
const BH_IMPORT_ANCHOR = "import { usage as oddsUsage } from '../services/odds-api.js';\n";
const BH_SUMMARY_ANCHOR = '      odds_api: oddsUsage(),\n';
const BH_DOC_ANCHOR = '/**\n * What actually has a case for being +EV right now, cached hourly.';
const MLB_STANDING = [
  '/**',
  " * MLB's ledger lives in localStorage-backed auto-picks on the client for the",
  ' * slip, but the auto-pick table is server-side, so the record is computed the',
  ' * same way here. Grading needs the results feed, which the props route already',
  ' * proxies — so this reports only what can be settled from stored picks.',
  ' */',
  'function mlbStanding() {',
  '  const picks = rows(`SELECT * FROM props_auto_picks ORDER BY pick_date DESC, rank`);',
  '  return {',
  '    tracked_picks: picks.length,',
  '    days_tracked: new Set(picks.map(p => p.pick_date)).size,',
  '    latest_slate: picks[0]?.pick_date ?? null,',
  "    note: 'Grading runs client-side against the results feed on the Auto Picks page.'",
  '  };',
  '}',
  '',
  ''].join('\n');

// Edit ops: ['replace', file, anchor, text] needs the anchor exactly once; ['create',
// file, text] and ['copy', fromRev, fromPath, toPath] need the target to be absent.
// Anything else is NOT APPLIED, never a silent run of the unmutated tree.
const mutations = [
  // odds-api.js, test 14. Unit: the export itself. Call site: a caller handing the
  // shared sportEvents()/eventOdds() the MLB sport key.
  ['OA-U1', 'unit', T14, 'the four removed MLB exports, restored verbatim', [
    ['replace', OA, SPORT_LINE, `${SPORT_LINE}const MLB_SPORT = 'baseball_mlb';\n`],
    ['replace', OA, FLATTEN_DOC, "export const MLB_MARKETS = ['totals_1st_1_innings', 'batter_total_bases', 'pitcher_strikeouts'];\n"
      + 'export const mlbEvents = options => sportEvents(MLB_SPORT, options);\n'
      + 'export const mlbEventOdds = (eventId, options = {}) => eventOdds(MLB_SPORT, eventId,\n'
      + '  { markets: MLB_MARKETS, ...options });\n\n' + FLATTEN_DOC]]],
  ['OA-U2', 'unit', T14, 'an unexported MLB_SPORT constant', [
    ['replace', OA, SPORT_LINE, `${SPORT_LINE}const MLB_SPORT = 'baseball_mlb';\n`]]],
  ['OA-U3', 'unit', T14, 'the MLB events export under a new name (survived the head-40ffeee0 test)', [
    ['replace', OA, SPORT_LINE, `${SPORT_LINE}export const baseballEvents = options => sportEvents('baseball_mlb', options);\n`]]],
  ['OA-C1', 'call-site', T14, "betting-hub.js asks the shared sportEvents() for 'baseball_mlb'", [
    ['replace', BH, BH_IMPORT_ANCHOR, "import { usage as oddsUsage, sportEvents } from '../services/odds-api.js';\n"],
    ['replace', BH, BH_SUMMARY_ANCHOR, `      mlb_events: sportEvents('baseball_mlb'),\n${BH_SUMMARY_ANCHOR}`]]],

  // decision-inbox.js, its MLB test. Unit: the allow-list and where it is enforced.
  // Call site: the argument handed to the VALID_SPORT predicate.
  ['DI-U1', 'unit', TDI, "'MLB' back in VALID_SPORT (the exact pre-fix line)", [
    ['replace', DI, "const VALID_SPORT = new Set(['NFL']);", "const VALID_SPORT = new Set(['NFL', 'MLB']);"]]],
  ['DI-U2', 'unit', TDI, 'the sport check moved after the insert: rejects, but leaves the row', [
    ['replace', DI, SPORT_CHECK, ''],
    ['replace', DI, INSERT_TAIL, "    sourceModel, sourceVersion, link, dedupKey);\n" + SPORT_CHECK
      + "  return toRecommendation(row('SELECT * FROM decision_recommendations WHERE id = ?', id));\n"]]],
  ['DI-U3', 'unit', TDI, 'MLB dropped silently (returns null) instead of rejected', [
    ['replace', DI, SPORT_CHECK, `  if (sport === 'MLB') return null;\n${SPORT_CHECK}`]]],
  ['DI-C1', 'call-site', TDI, "the predicate is handed 'NFL' when the caller sent 'MLB'", [
    ['replace', DI, 'if (!VALID_SPORT.has(sport))', "if (!VALID_SPORT.has(sport === 'MLB' ? 'NFL' : sport))"]]],
  ['DI-C2', 'call-site', TDI, "the caller's 'MLB' coerced to 'NFL' before the check (stored as NFL)", [
    ['replace', DI, SPORT_CHECK, `  if (String(sport).toUpperCase() === 'MLB') sport = 'NFL';\n${SPORT_CHECK}`]]],

  // The two routers, test 15 (test 17 also sees any copy that writes their tables).
  // Unit: the file. Call site: an import or a mount, from any file, in any form.
  ['IX-U1', 'unit', T15, 'server/routes/props.js restored from the base, unmounted', [
    ['copy', BASE, 'server/routes/props.js', 'server/routes/props.js']]],
  ['IX-U2', 'unit', T15, 'server/routes/props-tickets.js restored from the base, unmounted', [
    ['copy', BASE, 'server/routes/props-tickets.js', 'server/routes/props-tickets.js']]],
  ['IX-C1', 'call-site', T15, "index.js regains the base's two dynamic imports and mounts (a stale merge)", [
    ['replace', IDX, IDX_IMPORT_ANCHOR, "const { default: propsRouter } = await import('./routes/props.js');\n"
      + "const { default: propsTicketsRouter } = await import('./routes/props-tickets.js');\n" + IDX_IMPORT_ANCHOR],
    ['replace', IDX, IDX_MOUNT_ANCHOR, "app.use('/api/props', ...legacyAuthenticated, propsRouter);\n"
      + "app.use('/api/props-tickets', ...legacyAuthenticated, propsTicketsRouter);\n" + IDX_MOUNT_ANCHOR]]],
  ['IX-C2', 'call-site', T15, 'static import, template-literal mount at /api/props (survived at 40ffeee0)', [
    ['replace', IDX, IDX_STATIC_ANCHOR, `${IDX_STATIC_ANCHOR}import propsRouter from './routes/props.js';\n`],
    ['replace', IDX, IDX_MOUNT_ANCHOR, `app.use(\`/api/props\`, ...legacyAuthenticated, propsRouter);\n${IDX_MOUNT_ANCHOR}`]]],
  ['IX-C3', 'call-site', T15, 'static import, mounted at a new path /api/mlb-props (survived at 40ffeee0)', [
    ['replace', IDX, IDX_STATIC_ANCHOR, `${IDX_STATIC_ANCHOR}import propsRouter from './routes/props.js';\n`],
    ['replace', IDX, IDX_MOUNT_ANCHOR, `app.use('/api/mlb-props', ...legacyAuthenticated, propsRouter);\n${IDX_MOUNT_ANCHOR}`]]],
  ['IX-C4', 'call-site', T15, 'betting-hub.js mounts the board at /api/betting/props (survived at 40ffeee0)', [
    ['replace', BH, BH_IMPORT_ANCHOR, `${BH_IMPORT_ANCHOR}import propsRouter from './props.js';\n`],
    ['replace', BH, 'const r = Router();\n', "const r = Router();\nr.use('/props', propsRouter);\n"]]],
  ['IX-C5', 'call-site', T15, 'betting-hub.js re-exports the saved-slip router', [
    ['replace', BH, BH_IMPORT_ANCHOR, `${BH_IMPORT_ANCHOR}export { default as propsTicketsRouter } from './props-tickets.js';\n`]]],
  ['IX-C6', 'call-site', T15, 'a script under scripts/ imports the saved-slip router', [
    ['create', 'scripts/sy06-mutant-slips.mjs', "import tickets from '../server/routes/props-tickets.js';\nconsole.log(Boolean(tickets));\n"]]],
  ['IX-C7', 'call-site', T15, 'dynamic imports in double quotes', [
    ['replace', IDX, IDX_IMPORT_ANCHOR, 'const { default: propsRouter } = await import("./routes/props.js");\n' + IDX_IMPORT_ANCHOR]]],
  ['IX-C8', 'call-site', T15, 'a mount at /api/props-tickets with no import at all', [
    ['replace', IDX, IDX_MOUNT_ANCHOR, `app.use('/api/props-tickets', ...legacyAuthenticated, nflMarketRouter);\n${IDX_MOUNT_ANCHOR}`]]],
  ['IX-C9', 'call-site', T17, 'the board copied to routes/mlb-board.js and mounted at /api/mlb-board', [
    ['copy', BASE, 'server/routes/props.js', 'server/routes/mlb-board.js'],
    ['replace', IDX, IDX_IMPORT_ANCHOR, "const { default: mlbBoardRouter } = await import('./routes/mlb-board.js');\n" + IDX_IMPORT_ANCHOR],
    ['replace', IDX, IDX_MOUNT_ANCHOR, `app.use('/api/mlb-board', ...legacyAuthenticated, mlbBoardRouter);\n${IDX_MOUNT_ANCHOR}`]]],
  ['IX-C10', 'call-site', T17, 'the saved-slip router copied to routes/slips.js and mounted at /api/slips', [
    ['copy', BASE, 'server/routes/props-tickets.js', 'server/routes/slips.js'],
    ['replace', IDX, IDX_IMPORT_ANCHOR, "const { default: slipsRouter } = await import('./routes/slips.js');\n" + IDX_IMPORT_ANCHOR],
    ['replace', IDX, IDX_MOUNT_ANCHOR, `app.use('/api/slips', ...legacyAuthenticated, slipsRouter);\n${IDX_MOUNT_ANCHOR}`]]],

  // Readers of the stopped feed, tests 16 and 17. Unit: betting-hub's own standing.
  // Call site: a read of either table under another name, key or file.
  ['BH-U1', 'unit', T16, 'mlbStanding() and the mlb key restored verbatim', [
    ['replace', BH, BH_IMPORT_ANCHOR, `${BH_IMPORT_ANCHOR}import { rows } from '../db/index.js';\n`],
    ['replace', BH, BH_DOC_ANCHOR, MLB_STANDING + BH_DOC_ANCHOR],
    ['replace', BH, BH_SUMMARY_ANCHOR, `      mlb: { standing: mlbStanding() },\n${BH_SUMMARY_ANCHOR}`]]],
  ['BH-U2', 'unit', T16, 'the same read renamed baseballRecord(), mlb key kept', [
    ['replace', BH, BH_IMPORT_ANCHOR, `${BH_IMPORT_ANCHOR}import { rows } from '../db/index.js';\n`],
    ['replace', BH, BH_DOC_ANCHOR, 'function baseballRecord() {\n  const picks = rows(`SELECT * FROM props_auto_picks ORDER BY pick_date DESC, rank`);\n'
      + '  return { tracked_picks: picks.length };\n}\n\n' + BH_DOC_ANCHOR],
    ['replace', BH, BH_SUMMARY_ANCHOR, `      mlb: { standing: baseballRecord() },\n${BH_SUMMARY_ANCHOR}`]]],
  ['BH-C1', 'call-site', T16, 'a props key on /summary reads props_auto_picks (survived at 40ffeee0)', [
    ['replace', BH, BH_IMPORT_ANCHOR, `${BH_IMPORT_ANCHOR}import { rows } from '../db/index.js';\n`],
    ['replace', BH, BH_SUMMARY_ANCHOR, '      props: { tracked_picks: rows(`SELECT * FROM props_auto_picks`).length },\n' + BH_SUMMARY_ANCHOR]]],
  ['BH-C2', 'call-site', T17, 'nfl-betting.js reads props_auto_picks', [
    ['replace', NB, "import { Router } from 'express';\n",
      "import { Router } from 'express';\nconst MLB_PICK_COUNT_SQL = 'SELECT COUNT(*) AS n FROM props_auto_picks';\n"]]],
  ['BH-C3', 'call-site', T17, 'a slips key on /summary reads saved_prop_tickets', [
    ['replace', BH, BH_IMPORT_ANCHOR, `${BH_IMPORT_ANCHOR}import { rows } from '../db/index.js';\n`],
    ['replace', BH, BH_SUMMARY_ANCHOR, '      slips: rows(`SELECT id FROM saved_prop_tickets`).length,\n' + BH_SUMMARY_ANCHOR]]],

  // The tables stay, test 17.
  ['TB-U1', 'unit', T17, 'props_auto_picks renamed out of its declaration', [
    ['replace', SCHEMA, 'CREATE TABLE IF NOT EXISTS props_auto_picks (', 'CREATE TABLE IF NOT EXISTS props_auto_picks_v2 (']]],
  ['TB-U2', 'unit', T17, 'a new migration drops props_auto_picks', [
    ['create', 'server/migrations/071_sy06_mutant_drop_props.js', "export const name = '071_sy06_mutant_drop_props';\n"
      + 'export function up(db) {\n  db.exec(`DROP TABLE IF EXISTS props_auto_picks`);\n}\nexport function down() {}\n']]],
];

// Controls. A surviving control is a real edit the tests deliberately do not pin: if
// it is killed, they over-pin. A not-applied control targets text that is not there,
// and the runner must report it NOT APPLIED rather than count it as killed or survived.
const controls = [
  ['CTRL-S1', 'survived', 'a comment in index.js quoting the deleted import lines and mounts', [
    ['replace', IDX, IDX_MOUNT_ANCHOR, "// Before SY-06: const { default: propsRouter } = await import('./routes/props.js');\n"
      + "// app.use('/api/props', ...legacyAuthenticated, propsRouter);\n"
      + "/* app.use('/api/props-tickets', ...legacyAuthenticated, propsTicketsRouter); */\n" + IDX_MOUNT_ANCHOR]]],
  ['CTRL-S2', 'survived', 'a live NFL player-props read added to /summary (NFL props are the product)', [
    ['replace', BH, BH_SUMMARY_ANCHOR, `      nfl_props: propEdgeEvidence(),\n${BH_SUMMARY_ANCHOR}`]]],
  ['CTRL-NA1', 'not-applied', "anchor is the pre-fix VALID_SPORT line, absent at HEAD", [
    ['replace', DI, "const VALID_SPORT = new Set(['NFL', 'MLB']);", "const VALID_SPORT = new Set(['NFL']);"]]],
  ['CTRL-NA2', 'not-applied', 'create a file that already exists', [
    ['create', BH, '// replaced\n']]],
];

const argValue = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const rev = argValue('--rev') ?? 'HEAD';
const only = argValue('--only')?.split(',');
if (only) {
  const known = new Set([...mutations, ...controls].map(([id]) => id));
  const unknown = only.filter(id => !known.has(id));
  if (unknown.length) throw new Error(`--only names no such mutant or control: ${unknown.join(', ')}`);
  for (const list of [mutations, controls]) list.splice(0, list.length, ...list.filter(([id]) => only.includes(id)));
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sy06-mut-'));
const wt = path.join(dir, 'wt');
git('-C', root, 'worktree', 'add', '--detach', '-q', wt, rev);
fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(wt, 'node_modules'));
const head = git('-C', wt, 'rev-parse', '--short', 'HEAD').trim();
const tree = git('-C', wt, 'write-tree').trim();

function apply(edits) {
  const created = [];
  const touched = new Set();
  for (const edit of edits) {
    const [op] = edit;
    if (op === 'replace') {
      const [, file, anchor, text] = edit;
      const target = path.join(wt, file);
      const src = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const count = src.split(anchor).length - 1;
      if (count !== 1) return { applied: false, why: `anchor found ${count} times in ${file}`, created, touched };
      fs.writeFileSync(target, src.replace(anchor, () => text));
      touched.add(file);
    } else {
      const [file, text] = op === 'create' ? [edit[1], edit[2]] : [edit[3], git('-C', wt, 'show', `${edit[1]}:${edit[2]}`)];
      const target = path.join(wt, file);
      if (fs.existsSync(target)) return { applied: false, why: `${file} already exists`, created, touched };
      fs.writeFileSync(target, text);
      created.push(file);
    }
  }
  return { applied: true, created, touched };
}

function restore({ created, touched }) {
  for (const file of created) fs.rmSync(path.join(wt, file), { force: true });
  if (touched.size) git('-C', wt, 'checkout', '-q', 'HEAD', '--', ...touched);
  const status = git('-C', wt, 'status', '--porcelain').trim();
  if (status) throw new Error(`worktree not clean after restore:\n${status}`);
}

function run() {
  const db = fs.mkdtempSync(path.join(dir, 'db-'));
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-concurrency=1', '--test-reporter=tap', ...TESTS], {
    cwd: wt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SCHEDULER_DISABLED: '1', GRIDIRON_DB_PATH: path.join(db, 'test.sqlite'),
      NODE_OPTIONS: '--import ./test/offline-guard.mjs' }
  });
  fs.rmSync(db, { recursive: true, force: true });
  const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
  const total = /^# tests (\d+)/m.exec(r.stdout)?.[1];
  return { status: r.status, failed, total };
}

console.log(`SY-06 mutation sweep at ${head} (tree ${tree}); tests: ${TESTS.join(', ')}`);
const baseline = run();
console.log(`baseline: exit ${baseline.status}, ${baseline.total} tests, ${baseline.failed.length} failing`);
let problems = baseline.status === 0 ? 0 : 1;
try {
  for (const [id, kind, expectedKiller, what, edits] of mutations) {
    const result = apply(edits);
    let line;
    if (!result.applied) { line = `NOT APPLIED ${id} (${result.why})`; problems++; }
    else {
      const { status, failed } = run();
      const byDesign = failed.some(name => name.startsWith(expectedKiller));
      const outcome = status === 0 ? 'SURVIVED' : byDesign ? 'killed' : 'KILLED BY ANOTHER TEST';
      if (outcome !== 'killed') problems++;
      line = `${outcome.padEnd(8)} ${id} [${kind}] ${what}${failed.length ? `  <- ${failed.join(' | ')}` : ''}`;
    }
    restore(result);
    console.log(line);
  }
  for (const [id, expected, what, edits] of controls) {
    const result = apply(edits);
    let outcome = 'not-applied';
    let failed = [];
    if (result.applied) {
      const r = run();
      failed = r.failed;
      outcome = r.status === 0 ? 'survived' : 'killed';
    }
    restore(result);
    if (outcome !== expected) problems++;
    console.log(`${outcome === expected ? 'control ' : 'CONTROL FAILED'} ${id}: ${what}: ${outcome}${result.why ? ` (${result.why})` : ''}${failed.length ? `  <- ${failed.join(' | ')}` : ''}`);
  }
} finally {
  git('-C', root, 'worktree', 'remove', '--force', wt);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${mutations.length} mutants, ${controls.length} controls; ${problems ? `${problems} problem(s)` : 'every mutant killed by the test built for it, every control as designed'}`);
process.exit(problems ? 1 : 0);
