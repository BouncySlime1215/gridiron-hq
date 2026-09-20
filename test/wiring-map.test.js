/**
 * The wiring map has to be right about the two things it claims.
 *
 * It exists because the same two gaps kept being found by hand: something
 * produced that reaches no surface, and something a surface depends on that
 * nothing produces. A map that misses one of those is worse than no map,
 * because people trust it — so every case below is one that was found by hand
 * first, and the map has to reproduce it from the source alone.
 *
 * The scanner cases are the ones that bit during development. SQL lives in
 * string literals and imports live in code, so a scanner that blanks the wrong
 * one silently reports zero of everything, which looks like a clean repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const {
  acceptGuard, NEVER_BASELINE, GRANDFATHERED,
  foreignOnlyFile, valueUsageCounts,
  scan, sqlEdges, moduleEdges, routeHandlers, routeMounts, schedulerJobs,
  clientCalls, payloadKeys, keyReads, declarations,
  foreignHandles, handleFor, gatedRegions, blindCaches,
  functionUnits, functionReach, tableColumns, statementTables, columnEvidence,
  imageDirs, runtimeFilePaths, routeWorkload, routeLiteralAbsent, bulkInScope, outboundUrlPaths, unreachablePages, entryPointScripts,
  routeAnswersCall, columnDefaults,
} = await import('../scripts/wiring-map.mjs');

test('scan keeps string bodies out of the code view and offsets intact', () => {
  const src = [
    "const q = 'SELECT * FROM players';",
    '// import fake from "./nope.js"',
    "import { real } from './yes.js';",
  ].join('\n');
  const { code, text, strings } = scan(src);
  assert.ok(!code.includes('SELECT'), 'string body must not appear in the code view');
  assert.ok(text.includes('SELECT'), 'string body must survive in the text view');
  assert.ok(!text.includes('nope.js'), 'a commented-out import is not an import');
  assert.equal(strings[0].text, 'SELECT * FROM players');
  assert.equal(strings[0].line, 1);
  assert.equal(code.split('\n').length, src.split('\n').length, 'line count must not move');
});

test('scan survives a quote inside a regex literal', () => {
  const { strings } = scan("const re = /it's/; const t = 'kept';");
  assert.deepEqual(strings.map(s => s.text), ['kept']);
});

test('sqlEdges reads INSERT OR IGNORE, not just INSERT INTO', () => {
  // This exact gate was wrong once and hid 21 real writers, which turned 21
  // healthy tables into "written by nothing" findings.
  const { writes } = sqlEdges([{ text: 'INSERT OR IGNORE INTO nfl_feature_revisions (a) VALUES (?)', line: 3, at: 0 }]);
  assert.deepEqual(writes.map(w => [w.table, w.line]), [['nfl_feature_revisions', 3]]);
});

test('sqlEdges separates DELETE FROM from a read', () => {
  const { writes, reads } = sqlEdges([{ text: 'DELETE FROM nfl_availability_rates', line: 1, at: 0 }]);
  assert.deepEqual(writes.map(w => w.table), ['nfl_availability_rates']);
  assert.deepEqual(reads, [], 'a delete is not a read');
});

test('sqlEdges counts INSERT ... SELECT as both a write and a read', () => {
  const { writes, reads } = sqlEdges([{ text: 'INSERT INTO a SELECT x FROM b JOIN c ON 1', line: 1, at: 0 }]);
  assert.deepEqual(writes.map(w => w.table), ['a']);
  assert.deepEqual(reads.map(r => r.table).sort(), ['b', 'c']);
});

test('moduleEdges finds static, dynamic and re-exported imports', () => {
  const { imports, exports } = moduleEdges([
    "import { alpha } from './a.js';",
    "const { default: beta } = await import('./b.js');",
    "const run = () => import('./c.js').then(m => m.gamma());",
    "export * from './d.js';",
    'export function delta() {}',
    'export const epsilon = 1;',
    'export default zeta;',
  ].join('\n'));
  assert.deepEqual(imports.map(i => i.spec), ['./a.js', './d.js', './b.js', './c.js']);
  assert.ok(imports.find(i => i.spec === './a.js').names.includes('alpha'));
  assert.ok(imports.find(i => i.spec === './c.js').names.includes('gamma'),
    'a job registered as import().then(m => m.fn()) must resolve to fn');
  assert.deepEqual(exports.map(e => e.name).sort(), ['default', 'delta', 'epsilon']);
});

test('routeHandlers reads whatever the router variable is called', () => {
  const found = routeHandlers("r.get('/:leagueId/lineup', h);\nrouter.post('/scan', h);\nmap.get('key');");
  assert.deepEqual(found.map(h => `${h.method} ${h.path}`), ['GET /:leagueId/lineup', 'POST /scan']);
});

test('routeMounts joins a mount prefix to the file behind it', () => {
  const mounts = routeMounts([
    "const { default: tradesRouter } = await import('./routes/trades.js');",
    "app.use('/api/trades', ...legacyAuthenticated, tradesRouter);",
  ].join('\n'));
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].prefix, '/api/trades');
  assert.match(mounts[0].file, /routes\/trades\.js$/);
});

test('schedulerJobs reads both shapes of run:', () => {
  const jobs = schedulerJobs([
    'export const JOBS = {',
    "  nfl_injuries: { run: refreshNflInjuries, maxAgeMinutes: 360, tier: 'live', label: 'x' },",
    "  play_by_play: { run: () => import('./nfl-espn-pbp.js').then(m => m.pollLiveGames({})), tier: 'live' },",
    '};',
  ].join('\n'), 'server/services/scheduler.js');
  assert.deepEqual(jobs.map(j => j.name), ['nfl_injuries', 'play_by_play']);
  assert.equal(jobs[0].runFn, 'refreshNflInjuries');
  assert.equal(jobs[0].tier, 'live');
  assert.equal(jobs[1].runFn, 'pollLiveGames');
});

test('clientCalls prefixes /api and blanks path parameters', () => {
  const calls = clientCalls('await api(`/leagues/${id}/sync`, { method: "POST" });');
  assert.deepEqual(calls.map(c => c.path), ['/api/leagues/:p/sync']);
});

test('payloadKeys flags an attached field, not a key in a returned literal', () => {
  // The distinction is the whole point. An API response may carry a field this
  // repository never reads back, because a person reads the JSON. A field
  // attached to a shared computed object is different: it costs work on every
  // request and reaches nobody.
  const keys = payloadKeys([
    'engine.external_benchmarks = { ffopportunity: prior(id) };',
    'return { leagues_warmed: n };',
    'res.locals = {};',
  ].join('\n'));
  assert.deepEqual([...keys.keys()], ['external_benchmarks']);
});

test('keyReads counts an access and a destructure, never an assignment', () => {
  const reads = keyReads([
    'engine.external_benchmarks = {};',
    'const x = payload.news_context;',
    'const { model_reasoning } = payload;',
  ].join('\n'), []);
  assert.ok(reads.has('news_context'));
  assert.ok(reads.has('model_reasoning'));
  assert.ok(!reads.has('external_benchmarks'), 'assigning a field is not reading it');
});

test('declarations sees a computed value that is never used again', () => {
  const decls = declarations('const playerOpportunity = a * 0.55 + b * 0.35;');
  assert.equal(decls.has('playerOpportunity'), true);
  assert.equal(decls.get('playerOpportunity'), 1);
});

test('a value used only inside a template literal is not "computed and never used"', () => {
  // Found 2026-09-19 running the map against another thread's tree, which is
  // the only way this was ever going to surface: it reported
  // lineup-posture.js#startingSlotCount as abandoned while line 371 reads it,
  // inside a template literal. scan() blanks the whole literal out of the code
  // view, so the rule saw the declaration and nothing else. Every value whose
  // only use is building a message was exposed to the same false positive.
  const src = [
    'const slots = 7;',
    'const startingSlotCount = slots + 2;',
    'const note = `modelled starting slots only (${slots} of ${startingSlotCount})`;',
  ].join('\n');
  const counts = valueUsageCounts(scan(src));
  assert.equal(counts.get('startingSlotCount'), 2,
    'the declaration plus the interpolation that reads it');
  assert.equal(counts.get('slots'), 3, 'declared, read in the sum, read in the interpolation');
});

test('a value genuinely used once is still reported, template literals present', () => {
  // The other half: the fix must not silence the rule by counting every word
  // in every string. `abandoned` appears only as a declaration; the literal
  // mentioning it does so as TEXT, not as an interpolation.
  const src = [
    'const abandoned = compute();',
    'const note = `abandoned is a word in this sentence`;',
  ].join('\n');
  const counts = valueUsageCounts(scan(src));
  assert.equal(counts.get('abandoned'), 1, 'text inside a literal is not a use');
});

test('sqlEdges attributes a query to the handle that ran it', () => {
  // The whole reason this exists: the league chat corpus is a SECOND SQLite
  // file opened on its own handle. Pooling both databases into one namespace
  // reported four corpus tables as "read by the app and written by nothing",
  // which was a false alarm — they are filled by replacing the file.
  const src = [
    "const chat = new DatabaseSync(chatDbPath(), { readOnly: true });",
    "const a = chat.prepare('SELECT x FROM messages').all();",
    "const b = rows('SELECT y FROM players');",
  ].join('\n');
  const file = { path: 'server/services/x.js', text: src, strings: scan(src).strings };
  const foreign = foreignHandles(file);
  assert.ok(foreign.has('chat'));
  const { reads } = sqlEdges(file.strings, at => handleFor(file, at, foreign));
  const byTable = Object.fromEntries(reads.map(r => [r.table, r.handle]));
  assert.equal(byTable.messages, 'chat', 'a corpus read must not be attributed to the app');
  assert.equal(byTable.players, 'app');
});

test("server/db/index.js's own DatabaseSync is the app database, not a second one", () => {
  const src = "export const db = new DatabaseSync(DB_PATH);";
  assert.equal(foreignHandles({ path: 'server/db/index.js', text: src }).size, 0);
  assert.equal(foreignHandles({ path: 'server/services/other.js', text: src }).size, 1);
});

test('gatedRegions finds a call only a script can switch on', () => {
  // Real case: player-week-engine.js reads the availability tables inside
  // applyRedistribution, behind `redistributeVolume = false`, which only
  // scripts/eval-redistribution.mjs ever sets true. Real as code, false as
  // behaviour — and drawing it cost a wrong sentence in a release plan.
  const engine = [
    'function applyRedistribution(out) {',
    "  const a = rows('SELECT p_active FROM nfl_availability_rates');",
    '  return a;',
    '}',
    'export function build({ redistributeVolume = false } = {}) {',
    '  if (redistributeVolume) applyRedistribution(out);',
    '}',
  ].join('\n');
  const mk = (path, src) => ({ path, tree: path.startsWith('test/') ? 'test' : 'x', code: scan(src).code });
  const files = new Map([
    ['server/e.js', mk('server/e.js', engine)],
    ['scripts/eval.mjs', mk('scripts/eval.mjs', 'build({ redistributeVolume: true });')],
  ]);
  const gated = gatedRegions(files);
  assert.equal(gated.get('server/e.js')?.[0]?.flag, 'redistributeVolume');
  assert.equal(gated.get('server/e.js')[0].callee, 'applyRedistribution');
  assert.deepEqual(gated.get('server/e.js')[0].enabled_by, ['scripts/eval.mjs']);
});

test('gatedRegions leaves the edge alone when the app itself switches it on', () => {
  const engine = [
    'function applyRedistribution(out) { return out; }',
    'export function build({ redistributeVolume = false } = {}) {',
    '  if (redistributeVolume) applyRedistribution(out);',
    '}',
  ].join('\n');
  const mk = (path, src) => ({ path, tree: 'x', code: scan(src).code });
  const files = new Map([
    ['server/e.js', mk('server/e.js', engine)],
    ['server/routes/r.js', mk('server/routes/r.js', 'build({ redistributeVolume: true });')],
  ]);
  assert.equal(gatedRegions(files).size, 0, 'a flag the server turns on is a live edge');
});


/* ------------------------------------------------- what should be wired --- */

const mkFile = (path, src, tree = 'server') => {
  const { code, text, strings } = scan(src);
  const { imports, exports } = moduleEdges(text);
  return { path, tree, code, text, strings, imports, exports,
    sql: sqlEdges(strings), routes: [], calls: [], scope: 'shared' };
};

test('functionUnits does not mistake a destructured parameter for the body', () => {
  // `function availability({ through = 2025 } = {})` opens a brace inside its
  // PARAMETERS. Taking that one as the body gave the function a four-character
  // body, so every query in it was attributed to nobody -- which is how the
  // pair rule missed availability() vs weeklyAvailability() the first time.
  const src = [
    'export function availability({ through = 2025 } = {}) {',
    "  return rows('SELECT x FROM player_week_usage');",
    '}',
  ].join('\n');
  const units = functionUnits(mkFile('server/c.js', src));
  const u = units.get('availability');
  assert.ok(u, 'the function must be found');
  assert.ok(u.end - u.start > 40, `body looks truncated: ${u.end - u.start} chars`);
  assert.equal(u.exported, true);
});

test('functionReach attributes each query to its function and inherits through calls', () => {
  const src = [
    "function fitted() { return rows('SELECT p_active FROM nfl_availability_rates'); }",
    "export function availability() { return rows('SELECT games FROM player_week_usage'); }",
    'export function weeklyAvailability() {',
    '  const base = availability();',
    '  const f = fitted();',
    "  return rows('SELECT * FROM nfl_injuries').map(() => [base, f]);",
    '}',
  ].join('\n');
  const files = new Map([['server/c.js', mkFile('server/c.js', src)]]);
  const nodes = functionReach(files);
  const a = nodes.get('server/c.js#availability');
  const w = nodes.get('server/c.js#weeklyAvailability');
  assert.deepEqual([...a.reach].sort(), ['player_week_usage']);
  assert.ok(w.reach.has('nfl_availability_rates'),
    'the fitted table must be inherited through the call to fitted()');
  assert.ok(!a.reach.has('nfl_availability_rates'),
    'the short name must NOT inherit what only the long one reads');
});

test('moduleEdges records the local alias an export was imported under', () => {
  const { imports } = moduleEdges("import { syncAll as syncNflverse } from './nflverse.js';");
  assert.deepEqual(imports[0].names, ['syncAll']);
  assert.deepEqual(imports[0].aliases, [{ imported: 'syncAll', local: 'syncNflverse' }]);
});

test('an export reached through a namespace binding is imported, not dead', () => {
  // `const scheduler = await import('./scheduler.js')` then `scheduler.reapAbandonedRuns()`
  // is the form test/abandoned-run-backoff.test.js uses, and it is how 195 dynamic
  // bindings in this repository read a module. The destructured form beside it was
  // already understood; this one recorded no names at all, so every export only ever
  // reached this way was reported as "exported and never imported".
  const { imports } = moduleEdges([
    "const scheduler = await import('./scheduler.js');",
    'scheduler.reapAbandonedRuns();',
    'const n = scheduler.BOOT_JOBS.length;',
  ].join('\n'));
  const scheduler = imports.find(i => i.spec === './scheduler.js');
  assert.ok(scheduler, 'the file edge itself was never the problem');
  assert.deepEqual([...scheduler.names].sort(), ['BOOT_JOBS', 'reapAbandonedRuns']);
});

test('a static namespace import is read the same way', () => {
  const { imports } = moduleEdges([
    "import * as contingency from './contingency.js';",
    'export const x = contingency.availabilityBasis();',
  ].join('\n'));
  const c = imports.find(i => i.spec === './contingency.js');
  assert.deepEqual(c.names, ['availabilityBasis']);
});

test('a namespace binding does not claim members of an unrelated object', () => {
  // The whole risk of reading `ns.member` is over-claiming: two bindings in one file,
  // and a same-named local that is not a namespace at all.
  const { imports } = moduleEdges([
    "const a = await import('./one.js');",
    "const b = await import('./two.js');",
    'a.fromOne();',
    'b.fromTwo();',
    'const notANamespace = { fromOne: 1 };',
    'notANamespace.fromOne;',
  ].join('\n'));
  assert.deepEqual(imports.find(i => i.spec === './one.js').names, ['fromOne']);
  assert.deepEqual(imports.find(i => i.spec === './two.js').names, ['fromTwo']);
});

test('the destructured dynamic form keeps working, and claims only what it names', () => {
  const { imports } = moduleEdges([
    "const { runMigrations } = await import('./migrate.js');",
    'runMigrations();',
  ].join('\n'));
  assert.deepEqual(imports.find(i => i.spec === './migrate.js').names, ['runMigrations']);
});

test('tableColumns reads CREATE TABLE and ALTER TABLE ADD COLUMN', () => {
  const src = [
    "db.exec(`CREATE TABLE IF NOT EXISTS players (",
    '  id INTEGER PRIMARY KEY, name TEXT, bye_week INTEGER,',
    '  PRIMARY KEY (id)',
    ')`);',
    "run('ALTER TABLE players ADD COLUMN gsis_id TEXT');",
  ].join('\n');
  const cols = tableColumns(new Map([['server/s.js', mkFile('server/s.js', src)]]));
  const players = cols.get('players');
  assert.ok(players.has('bye_week'));
  assert.ok(players.has('gsis_id'), 'a column added by ALTER is declared too');
  assert.ok(!players.has('PRIMARY'), 'a table constraint is not a column');
});

const colFiles = (list) => new Map(list.map((f, i) => [f.path ?? `f${i}`, {
  path: f.path ?? `f${i}`, tree: f.tree,
  strings: f.sql.map((text, k) => ({ text, line: k + 1 })),
}]));
const DECLARED = new Map([['bye_week', new Set(['players'])]]);

test('a test fixture is not a writer: it cannot clear a column-read-never-written finding', () => {
  // THE BUG: `column-read-never-written` GATES, and the read side already excluded the
  // test tree while the write side did not. One fixture line inside a test file
  // therefore cleared the finding that says production never writes the column. Found
  // when PR #67 — which changes one service and adds a test — made players.bye_week
  // disappear from the gating list while nothing had started writing it.
  const { colWritten, colRead } = columnEvidence(colFiles([
    { path: 'server/services/draft-assist.js', tree: 'server',
      sql: ['SELECT p.id, p.bye_week FROM players p'] },
    { path: 'test/bye-risk.test.js', tree: 'test',
      sql: ['UPDATE players SET bye_week = 9 WHERE id = 1'] },
  ]), DECLARED);
  assert.ok(!colWritten.has('players.bye_week'), 'a fixture write is not a writer');
  assert.deepEqual(colRead.get('players.bye_week')?.map(w => w.file),
    ['server/services/draft-assist.js']);
});

test('a production or script writer still counts', () => {
  const { colWritten } = columnEvidence(colFiles([
    { path: 'scripts/backfill-byes.mjs', tree: 'scripts',
      sql: ['UPDATE players SET bye_week = 9 WHERE id = 1'] },
  ]), DECLARED);
  assert.ok(colWritten.has('players.bye_week'),
    'a backfill script is a real writer; excluding it would invent findings');
});

test('a test fixture cannot mark a table opaque either', () => {
  // The same asymmetry through the other door: an opaque write suppresses every column
  // finding on that table, so a fixture insert would have silenced the whole table.
  const { opaqueWrite } = columnEvidence(colFiles([
    { path: 'test/seed.test.js', tree: 'test',
      sql: ['INSERT INTO players (${COLS.join(",")}) VALUES (1)'] },
  ]), DECLARED);
  assert.equal(opaqueWrite.size, 0);
});

test('imageDirs reads the runtime stage, not the build stage', () => {
  // The build stage does `COPY . .`, so reading the whole Dockerfile would say the
  // image contains everything and the rule below would never fire.
  const dirs = imageDirs([
    'FROM node:22-slim AS build',
    'WORKDIR /app',
    'COPY . .',
    'RUN npm run build',
    'FROM node:22-slim',
    'WORKDIR /app',
    'COPY package.json package-lock.json* ./',
    'COPY --from=build /app/client/dist ./client/dist',
    'COPY server ./server',
    'COPY scripts ./scripts',
  ].join('\n'));
  assert.deepEqual([...dirs].sort(), ['client', 'scripts', 'server']);
});

test('a default data path outside the image is found, and an env override is noted', () => {
  // history-corpus.js opens data/derived/sleeper_history.sqlite under cwd. The
  // runtime stage copies client/dist, server and scripts, so that file is never in
  // the image and the module is inert in production whatever the import graph says.
  // An accepted_orphan_modules line for it would have hidden the cause.
  const found = runtimeFilePaths([
    "const DB_PATH = process.env.GRIDIRON_LEAGUE_HISTORY_PATH",
    "  ?? path.join(process.cwd(), 'data', 'derived', 'sleeper_history.sqlite');",
    "const CHAT = process.env.GRIDIRON_CHAT_DB_PATH || path.join(ROOT, 'data/derived/league_chat.sqlite');",
  ].join('\n'));
  assert.deepEqual(found.map(f => f.dir).sort(), ['data', 'data']);
  assert.ok(found.every(f => f.repoRelative), 'both are joined to the repo root');
  assert.ok(found.every(f => f.override), 'both carry an env override, which the finding must say');
});

test('a path joined to a directory inside the image is not repo-root-based', () => {
  // server/data/analyst-notes-2026.json IS in the image, and reads as `data/...` too.
  // The literal alone cannot tell the two apart, so the base is what decides: only
  // process.cwd() and the repo-root names resolve to a repo-relative directory.
  const found = runtimeFilePaths("const NOTES = path.join(SERVER_ROOT, 'data', 'analyst-notes-2026.json');");
  assert.deepEqual(found.filter(f => f.repoRelative), [],
    'SERVER_ROOT is not the repo root, so this names no repo directory to check');
  assert.deepEqual(found.map(f => f.base), ['SERVER_ROOT'], 'but it is still seen');
});

test('an uncalled route carries how much work it does for nobody', () => {
  // 462 route-no-caller findings is, in practice, a rule that reports nothing: two of
  // the most expensive endpoints in this app sat inside that list for weeks and were
  // found by hand instead. A DELETE nobody calls and a 300-line join nobody calls are
  // different facts, and the map printed them identically.
  const src = [
    "import { trendExploits } from '../services/trend-exploits.js';",
    "import { rosterRisk } from '../services/roster-risk.js';",
    "r.get('/:leagueId/trends', (req, res) => {",
    "  const t = trendExploits(req.params.leagueId);",
    "  const r2 = rosterRisk(req.params.leagueId);",
    "  const rows = db.all('SELECT * FROM player_week_usage JOIN players ON players.id = 1');",
    "  res.json({ t, r2, rows });",
    '});',
    "r.delete('/rankings/:id', (req, res) => {",
    "  db.run('DELETE FROM rankings WHERE id = ?', req.params.id);",
    "  res.json({ ok: true });",
    '});',
  ].join('\n');
  const w = routeWorkload(src);
  const trends = w.find(x => x.path === '/:leagueId/trends');
  const del = w.find(x => x.path === '/rankings/:id');
  assert.deepEqual(trends.services.sort(), ['rosterRisk', 'trendExploits']);
  assert.deepEqual(trends.tables.sort(), ['player_week_usage', 'players']);
  assert.ok(trends.weight > del.weight,
    'the join must outrank the delete, or the ranking is not a ranking');
  assert.deepEqual(del.services, []);
  assert.deepEqual(del.tables, ['rankings']);
});

test('THE CASE THAT MOTIVATED THIS: a thin handler over a heavy service outranks a fat one over nothing', () => {
  // The first version of this ranking counted only the handler body, and
  // GET /api/trades/:leagueId/trends came 295th of 462 — below the middle of the
  // list it was supposed to rise to the top of. Its handler is one line; the 324-line
  // join is in the service it calls. A ranking that buries the case it was built for
  // is not a ranking, so the cost of what a handler calls has to count.
  const src = [
    "import { trendExploits } from '../services/trend-exploits.js';",
    "r.get('/thin', (req, res) => res.json(trendExploits(req.params.id)));",
    "r.get('/fat', (req, res) => {",
    "  const a = 1; const b = 2; const c = 3;",
    "  const rows = db.all('SELECT * FROM notes');",
    "  res.json({ a, b, c, rows });",
    '});',
  ].join('\n');
  // The evidence for the bug is the measured rank on the real repository, not this
  // fixture: a two-route file is too small to reproduce a 462-row ordering, and an
  // assertion that pretended otherwise would be asserting my own fixture.
  const flat = routeWorkload(src);
  assert.equal(flat.find(x => x.path === '/thin').callee_cost, 0,
    'with no cost function the callee contributes nothing, which is what made the rank wrong');

  const costOf = name => (name === 'trendExploits' ? 40 : 0);
  const ranked = routeWorkload(src, costOf);
  assert.ok(ranked.find(x => x.path === '/thin').weight > ranked.find(x => x.path === '/fat').weight,
    'with it, the thin handler over the heavy service wins');
  assert.equal(ranked.find(x => x.path === '/thin').callee_cost, 40);
});

test('a handler claims only its own body, not the next route down', () => {
  // The whole ranking is worthless if a handler swallows the file after it: every
  // route in a big router would score the same, which is the state this replaces.
  const src = [
    "import { one } from '../services/one.js';",
    "import { two } from '../services/two.js';",
    "r.get('/first', (req, res) => { res.json(one()); });",
    "r.get('/second', (req, res) => { res.json(two()); });",
  ].join('\n');
  const w = routeWorkload(src);
  assert.deepEqual(w.find(x => x.path === '/first').services, ['one']);
  assert.deepEqual(w.find(x => x.path === '/second').services, ['two']);
});

test('a route whose path the client builds in a variable is not uncalled', () => {
  // route-no-caller reports 462 routes on this repository and a share of them are
  // wrong: clientCalls() sees only inline string literals, and this client builds
  // paths in variables. GET /api/trades/:leagueId/post-draft-plan and
  // .../rosters both sit in that list, and `post-draft-plan` appears in the client
  // once and `rosters` fifty times. A list that long with false positives in it is
  // why two genuinely dead endpoints went unnoticed inside it.
  const clientText = "const p = `/trades/${id}/post-draft-plan`; const r = api('/trades/1/rosters');";
  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/post-draft-plan', clientText), false);
  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/rosters', clientText), false);
});

test('a route whose distinctive segment appears nowhere in the client is uncalled', () => {
  const clientText = "const p = `/trades/${id}/post-draft-plan`;";
  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/trends', clientText), true);
  assert.equal(routeLiteralAbsent('/api/decision-inbox', clientText), true);
});

test('a route that is all parameters after its family is judged on the family', () => {
  assert.equal(routeLiteralAbsent('/api/players/:id', "api('/players/' + id)"), false);
  assert.equal(routeLiteralAbsent('/api/players/:id', "api('/leagues/1')"), true);
});

test('a generic tail segment is not a route\'s distinctive literal', () => {
  // The first cut judged a route on its LAST literal segment, which made
  // GET /api/betting/status "called" because some unrelated /status exists in the
  // client. Five endpoints under /api/betting and /api/edge vanished that way. The
  // distinctive literal is the longest run of consecutive literals, so the fragment
  // that must appear is /betting/status, not /status.
  assert.equal(routeLiteralAbsent('/api/betting/status', "api('/model/status')"), true);
  assert.equal(routeLiteralAbsent('/api/betting/status', "api('/betting/status')"), false);
  // The run wins over a longer generic tail even when the tail also appears.
  assert.equal(routeLiteralAbsent('/api/decision-inbox/summary', "api('/leagues/1/summary')"), true);
  // Two runs of equal length: the longer, more distinctive name decides, not the later
  // one. Judged on `resolve` this route is suppressed by any unrelated /resolve while
  // its own sibling above stays a finding, which is two answers about one endpoint.
  assert.equal(routeLiteralAbsent('/api/decision-inbox/:id/resolve', "api('/trades/1/resolve')"), true);
  assert.equal(routeLiteralAbsent('/api/decision-inbox/:id/resolve', "api(`/decision-inbox/${id}/resolve`)"), false);
});

test('THE CONTROL: four routes known to be called are not flagged', () => {
  // Supplied by the feature-audit thread as a check on this gate, with handler and
  // client call site for each, and they were right to ask: 405 uncalled out of 548
  // handlers is 74% of the app, and every one of these four is reached through a
  // template literal with an interpolation — the exact shape a literal matcher misses.
  // There is no contiguous `/trades/:leagueId/evaluate` anywhere in the client.
  // These are the real call sites on 791b131, copied verbatim.
  const calls = [
    ['/api/trades/:leagueId/evaluate', 'await api(`/trades/${leagueId}/evaluate`, {'],
    ['/api/trades/:leagueId/sense-check', 'setSense(await api(`/trades/${leagueId}/sense-check`, { method: 0 }))'],
    ['/api/drafts/:id/assist', 'const s = await api(`/drafts/${id}/assist`);'],
    ['/api/players/:id/analyze', 'await api(`/players/${id}/analyze`, { method: 0 })'],
  ];
  for (const [route, call] of calls) {
    assert.equal(routeLiteralAbsent(route, call), false, `${route} is called at ${call}`);
  }
  // And the gate still says yes when the call really is absent, so the control is not
  // passing by being permissive about everything.
  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/evaluate', 'await api(`/trades/${leagueId}/sense-check`)'), true);
});

test('a bulk rule names its in-scope rows instead of counting them', () => {
  // THE FAILURE THIS ENCODES: route-no-caller rendered as a file-count table and
  // named nothing, so GET /api/decision-inbox and GET /api/trades/:leagueId/trends
  // were both counted, never printed, and both were found by hand instead. Betting is
  // 324 of the 405 rows and is out of scope for work, so dropping it leaves 81 — a
  // list a person reads.
  const g = [
    { subject: 'GET /api/decision-inbox', scope: 'shared', weight: 22 },
    { subject: 'GET /api/nfl-betting/status', scope: 'betting', weight: 244 },
    { subject: 'GET /api/trades/:leagueId/trends', scope: 'fantasy', weight: 24 },
    { subject: 'POST /api/league-chat/upload', scope: 'fantasy', weight: 95 },
  ];
  assert.deepEqual(bulkInScope(g).map(f => f.subject), [
    'POST /api/league-chat/upload',
    'GET /api/trades/:leagueId/trends',
    'GET /api/decision-inbox',
  ]);
  // A row with no weight sorts last, not first, and never throws.
  assert.deepEqual(
    bulkInScope([{ subject: 'b', scope: 'shared' }, { subject: 'a', scope: 'shared', weight: 1 }])
      .map(f => f.subject), ['a', 'b']);
});

test('a script forked by URL or named in package.json is an entry point', () => {
  // RAISED BY THE SCHEDULER THREAD, and it is right. module-imported-by-nothing called
  // server/scripts/run-nfl-ai-replay.js dead; nfl-ai-replay.js:376 forks it by URL:
  //   fork(new URL('../scripts/run-nfl-ai-replay.js', import.meta.url), [String(id)])
  // and server/scripts/sync-history.js is `npm run sync:history`. Neither is imported
  // by anything and both run. Same shape as every other blind spot in this file: the
  // extractor sees the construct and loses the path read out of it.
  const roots = entryPointScripts(
    new Map([['server/services/nfl-ai-replay.js', { path: 'server/services/nfl-ai-replay.js', tree: 'server',
      text: "const child = fork(new URL('../scripts/run-nfl-ai-replay.js', import.meta.url), [String(id)], {});" }]]),
    { scripts: { 'sync:history': 'node server/scripts/sync-history.js', check: 'npm run typecheck && npm run lint' } });
  assert.ok(roots.has('server/scripts/run-nfl-ai-replay.js'), 'forked by URL');
  assert.ok(roots.has('server/scripts/sync-history.js'), 'named in package.json');
  // A script name that merely chains other npm scripts adds no file.
  assert.equal([...roots].filter(r => r.includes('typecheck')).length, 0);

  // THIRD SHAPE, and the one the first cut missed: the path is not the first argument
  // at all, it is inside the argv array after a bare 'node'.
  //   audit-bottom-up-team-total.mjs:27
  //   execFileSync('node', ['scripts/_bottom-up-team-total-worker.mjs', OUT_JSON], {})
  // This path is relative to the working directory, not to the calling file, so it must
  // NOT be joined with the caller's dirname the way the new URL(...) form is.
  const argv = entryPointScripts(new Map([['scripts/audit-bottom-up-team-total.mjs',
    { path: 'scripts/audit-bottom-up-team-total.mjs', tree: 'script',
      text: "execFileSync('node', ['scripts/_bottom-up-team-total-worker.mjs', OUT_JSON], {});" }]]), {});
  assert.deepEqual([...argv], ['scripts/_bottom-up-team-total-worker.mjs']);
});

test('a page nothing can open does not count as a caller', () => {
  // FOUND BY DELETING, NOT BY INSPECTION. Edge.tsx is one of the four pages left over
  // from the nine-tab removal: nothing imports it and no route renders it. It still
  // contains api('/edge/movers'), api('/edge/volatility'), api('/edge/schedule-edge'),
  // api('/edge/efficiency') and api('/edge/simulate'), and the literal-absence gate
  // read the whole client tree, so all five routes looked called. They are not.
  const files = new Map([
    ['client/src/pages/Edge.tsx', { tree: 'client', path: 'client/src/pages/Edge.tsx' }],
    ['client/src/pages/DraftRoom.tsx', { tree: 'client', path: 'client/src/pages/DraftRoom.tsx' }],
    ['client/src/pages/Leagues.tsx', { tree: 'client', path: 'client/src/pages/Leagues.tsx' }],
  ]);
  // DraftRoom is routed in App.tsx; Leagues is not routed but IS imported by a live tab,
  // which is the trap the page-never-routed rule already documents.
  const importedBy = new Map([
    ['client/src/pages/DraftRoom.tsx', new Set(['client/src/App.tsx'])],
    ['client/src/pages/Leagues.tsx', new Set(['client/src/pages/LeagueHub.tsx'])],
  ]);
  assert.deepEqual([...unreachablePages(files, importedBy)], ['client/src/pages/Edge.tsx']);
});

test('a route the server publishes to a third party has an external caller', () => {
  // Raised by the Google sign-in thread: GET /api/auth/google/callback was the top
  // in-scope row of route-no-caller and nothing in the client calls it, correctly —
  // Google does. Their proposal was a category rather than one annotation per route,
  // and it does not need to be declared at all: the server itself hands the path to
  // the provider, so the evidence is in the repository.
  //   google-auth.js:42  return `${publicOrigin(req)}/api/auth/google/callback`;
  const got = outboundUrlPaths('return `${publicOrigin(req)}/api/auth/google/callback`;');
  assert.deepEqual([...got.keys()], ['/api/auth/google/callback']);
  assert.equal(got.get('/api/auth/google/callback'), 'published');
  // An absolute URL written out reads the same way.
  assert.ok([...outboundUrlPaths("store('https://hooks.example.com/api/webhooks/espn')")
    .keys()].includes('/api/webhooks/espn'));
});

test('a script that dials our own route is a caller, not a publisher', () => {
  // POST /api/league-chat/upload was the TOP fantasy row of route-no-caller, and it is
  // not dead — scripts/chat-sync.mjs:351 fetches it, and Nick runs that script by hand
  // (`npm run chat:sync`). The rule never saw it because it only ever scanned the client
  // tree. Same shape for /api/auth/tunnel-url, dialled by tunnel.mjs and launcher.mjs.
  // Both suppress the finding, but for opposite reasons, so the kind has to survive.
  const called = outboundUrlPaths('res = await fetch(`${HOST}/api/league-chat/upload`, { method: 0 })');
  assert.equal(called.get('/api/league-chat/upload'), 'called');
  const published = outboundUrlPaths('return `${publicOrigin(req)}/api/auth/google/callback`;');
  assert.equal(published.get('/api/auth/google/callback'), 'published');
  // A path that appears both ways is a caller: something here really does dial it.
  const both = outboundUrlPaths('const u = `${H}/api/x/y`; await fetch(`${H}/api/x/y`);');
  assert.equal(both.get('/api/x/y'), 'called');
  // A dialer that has already CLOSED is not the call this path sits in. Walking back to
  // the nearest `(` finds `fetch(` here and it is the wrong one; without the check that
  // the call is still open, a published path two statements later reads as dialled.
  // Found by injection — dropping that check failed nothing until this case existed.
  const after = outboundUrlPaths('await fetch(z); return `${ORIGIN}/api/a/b`;');
  assert.equal(after.get('/api/a/b'), 'published');
});

test('fetching a third-party URL is not publishing one of our routes', () => {
  // The server calls plenty of outbound URLs that are nobody's route here. If those
  // leaked into the evidence set they would suppress real findings, and this gate can
  // only ever suppress — so a false entry is the one direction that costs something.
  const sleeper = outboundUrlPaths('fetch(`https://api.sleeper.app/v1/players/nfl/trending/${kind}?x=1`)');
  assert.deepEqual([...sleeper.keys()].filter(p => p.startsWith('/api/')), []);
  const nflverse = outboundUrlPaths('await eachRow(`${REL}/snap_counts/snap_counts_${season}.csv.gz`)');
  assert.deepEqual([...nflverse.keys()].filter(p => p.startsWith('/api/')), []);
});

test('statementTables separates what a statement reads from what it writes', () => {
  const t = statementTables('INSERT INTO a (x) SELECT x FROM b JOIN c ON c.id = b.id');
  assert.deepEqual([...t.writes], ['a']);
  assert.deepEqual([...t.reads].sort(), ['b', 'c']);
});


/*
 * THE ACCEPT LIST MUST NOT BE ABLE TO SILENCE producer-with-no-caller.
 *
 * Raised by the Opportunity thread on 2026-09-19: an uncalled producer whose
 * table has live readers is the failure this repository keeps hitting, and it
 * is the one most likely to be accepted away the moment it is inconvenient.
 *
 * Every case below is an ATTACK, not a happy path, and that is deliberate. The
 * bare-subject dodge passed the first implementation, which tested the rule name
 * as a prefix: an entry reading "syncEspnMarket()" rather than
 * "producer-with-no-caller syncEspnMarket()" silenced the rule cleanly. That is
 * the same defect as a completeness checker deriving its expectation from the
 * table it is checking — the check is built from the same assumption as the
 * thing it checks, so it passes the exact case it exists to catch, and no amount
 * of reading it finds that. Only running it against a copy somebody broke on
 * purpose does. So: four attacks, one control proving an unprotected rule is
 * still baselineable (a gate that blocks everything gets switched off), and one
 * test that fails if a future GRANDFATHERED entry omits its owner, its citation
 * or its retirement condition.
 */
const SYNC = { rule: 'producer-with-no-caller', subject: 'syncEspnMarket()' };

test('accept-list cannot silence a protected rule via the long form', () => {
  const { accepted, refused } = acceptGuard({
    accepted: ['producer-with-no-caller syncEspnMarket()', 'league_season_teams'],
    found: [SYNC],
  });
  assert.deepEqual(accepted, ['league_season_teams'], 'the unprotected entry still works');
  assert.equal(refused.length, 1);
  assert.deepEqual(refused[0], ['producer-with-no-caller syncEspnMarket()', 'producer-with-no-caller']);
});

test('accept-list cannot silence a protected rule via the bare subject', () => {
  // The dodge: drop the rule prefix so a prefix test would not match.
  const { accepted, refused } = acceptGuard({ accepted: ['syncEspnMarket()'], found: [SYNC] });
  assert.deepEqual(accepted, []);
  assert.deepEqual(refused[0], ['syncEspnMarket()', 'producer-with-no-caller']);
});

test('the orphan accept list is guarded by the same rule as the missing-feed one', () => {
  const { orphanOk, refused } = acceptGuard({
    orphans: ['syncEspnMarket()', 'server/services/opportunity-model.js'],
    found: [SYNC],
  });
  assert.ok(orphanOk.has('server/services/opportunity-model.js'));
  assert.ok(!orphanOk.has('syncEspnMarket()'));
  assert.equal(refused.length, 1);
});

test('an unprotected rule is still baselineable, so the gate stays usable', () => {
  const found = [{ rule: 'column-read-never-written', subject: 'players.bye_week' }];
  const { accepted, refused } = acceptGuard({
    accepted: ['column-read-never-written players.bye_week'], found,
  });
  assert.equal(refused.length, 0);
  assert.equal(accepted.length, 1);
});

test('the protected list and its exceptions live in source, not in annotations.json', async () => {
  // The whole argument: a never-baseline list the check reads out of the file it
  // polices can be deleted by the same edit it exists to prevent.
  const ann = JSON.parse(await readFile(new URL('../docs/wiring/annotations.json', import.meta.url)));
  const fields = JSON.stringify(ann);
  assert.ok(NEVER_BASELINE.has('producer-with-no-caller'));
  for (const key of GRANDFATHERED.keys()) {
    assert.ok(!(ann.accepted_missing_feeds ?? []).includes(key),
      `${key} is grandfathered in source and must not also sit in the accept list`);
    const bare = key.slice('producer-with-no-caller '.length);
    assert.ok(!(ann.accepted_missing_feeds ?? []).includes(bare),
      `${bare} must not be baselined by its bare subject either`);
  }
  // A pointer explaining where the real list lives is fine and wanted. A list of
  // RULES is not: the moment one is readable from here, deleting it silences the
  // rule, which is the hole this whole design closes.
  const pointer = ann._NEVER_BASELINE ?? {};
  assert.deepEqual(Object.keys(pointer).filter(k => k !== '_why'), [],
    '_NEVER_BASELINE in annotations.json is a pointer to the source, never a list');
  for (const rule of NEVER_BASELINE.keys()) {
    assert.ok(!Object.keys(pointer).includes(rule),
      `${rule} must not be listed as data in the file it polices`);
  }
  assert.ok(fields.includes('scripts/wiring-map.mjs'),
    'the pointer must say where the enforced list actually lives');
});

test('every grandfathered entry names an owner or a scope, and what retires it', () => {
  assert.ok(GRANDFATHERED.size > 0);
  for (const [key, why] of GRANDFATHERED) {
    assert.match(why, /RETIRES WHEN:/, `${key} must say what would retire it`);
    assert.match(why, /Owner:|BETTING SCOPE/, `${key} must name an owner or its out-of-scope reason`);
    assert.match(why, /\.js:\d+/, `${key} must cite the file and line it was found at`);
  }
});


/*
 * A PAGE THAT NOTHING ROUTES, WITHOUT THE THREE FALSE POSITIVES NEXT TO IT.
 *
 * The mirror image of module-reaches-no-surface: not something built that
 * reaches no surface, but something that LOOKS like a surface and is reached by
 * nothing. Reported by the UI-rebuild thread, whose own first pass called seven
 * pages orphans and was wrong about three — LeagueHub.tsx imports Leagues and
 * MyTeam as tabs, DraftHub.tsx imports Drafts. A rule that read App.tsx's
 * route table instead of the import graph would repeat that mistake, so the
 * live-by-import case is pinned here rather than trusted.
 */
test('a page is an orphan only when nothing imports it, tabs included', () => {
  const page = p => ({ path: `client/src/pages/${p}`, tree: 'client', scope: 'shared' });
  const pages = ['Model.tsx', 'MyTeam.tsx', 'Drafts.tsx', 'NotFound.tsx'];
  const importedBy = new Map([
    // Live as a tab, not as a route. The trap.
    ['client/src/pages/MyTeam.tsx', ['client/src/pages/LeagueHub.tsx']],
    ['client/src/pages/Drafts.tsx', ['client/src/pages/DraftHub.tsx']],
    // Live as a lazy route.
    ['client/src/pages/NotFound.tsx', ['client/src/App.tsx']],
    // Nothing at all.
    ['client/src/pages/Model.tsx', []],
  ]);
  const orphaned = pages.map(page).filter(f => !(importedBy.get(f.path) ?? []).length);
  assert.deepEqual(orphaned.map(f => f.path), ['client/src/pages/Model.tsx'],
    'only the page with no importer at all is an orphan');
});

test('every page-never-routed finding is baselined or the gate would be red on arrival', async () => {
  const ann = JSON.parse(await readFile(new URL('../docs/wiring/annotations.json', import.meta.url)));
  const accepted = ann.accepted_orphan_modules ?? [];
  for (const f of ['Edge', 'Model', 'Projections', 'Rankings']) {
    assert.ok(accepted.includes(`client/src/pages/${f}.tsx`),
      `${f}.tsx is a known unrouted page and must be baselined, not left to fail the build on arrival`);
  }
});


/*
 * A SECOND DATABASE WRAPPED IN A LOCAL HELPER IS STILL A SECOND DATABASE.
 *
 * Found by running the check against PR #42 before it landed, which is the
 * whole argument for doing that. league-history.js opens its own read-only
 * DatabaseSync and then queries it through a LOCAL rows() helper, so every SQL
 * literal in it is handed to a name handleFor has never seen. Falling back to
 * 'app' invented app-side reads of tables that live in another file: the writer
 * (collect-sleeper-history.mjs) was correctly read as foreign, the readers were
 * not, and three tables with a writer sitting in the repository were reported as
 * "written by nothing". Same shape as the league-chat false alarm that this tool
 * already carries as a printed limit, one level of indirection deeper — which is
 * why the limit alone was not enough and the inference had to be made.
 */
const fileOf = text => ({ path: 'server/services/x.js', text, code: text, strings: [] });

test('a file with its own handle and no app-db import is foreign throughout', () => {
  const f = fileOf(`import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    function rows(sql, ...a) { return db.prepare(sql).all(...a); }
    const x = rows(\`SELECT * FROM sh_team_weeks\`);`);
  const foreign = foreignHandles(f);
  assert.ok(foreign.has('db'));
  assert.equal(foreignOnlyFile(f, foreign), true);
  f.foreignOnlyFile = true;
  // The query goes through rows(), which is neither an app helper nor a handle.
  const at = f.text.indexOf('SELECT * FROM sh_team_weeks');
  assert.notEqual(handleFor(f, at, foreign).handle, 'app',
    'an unattributed query in a foreign-only file must not be credited to the app database');
});

test('a file holding BOTH handles still needs per-query attribution', () => {
  // Conservative on purpose: importing the app db at all disqualifies the file,
  // because such a module really can query either database.
  const f = fileOf(`import { rows } from '../db/index.js';
    import { DatabaseSync } from 'node:sqlite';
    const other = new DatabaseSync('x.sqlite');
    const a = rows(\`SELECT * FROM players\`);`);
  const foreign = foreignHandles(f);
  assert.ok(foreign.has('other'));
  assert.equal(foreignOnlyFile(f, foreign), false);
});

test('a file with no handle of its own is the app database, as before', () => {
  const f = fileOf(`import { rows } from '../db/index.js';
    const a = rows(\`SELECT * FROM players\`);`);
  assert.equal(foreignOnlyFile(f, foreignHandles(f)), false);
});


/*
 * THE WORSE CASE MUST NOT BE THE ONE THAT PASSES.
 *
 * Nick asked on 2026-09-19 whether the checker had been run against a
 * deliberately broken tree. Testing it rather than answering from memory found
 * this: a new module imported by a TEST failed the build (module-only-tested
 * gates), while a new module imported by NOTHING AT ALL passed. A service
 * writing a table nothing reads was reported three ways and gated on none.
 * The gating set is asymmetric by accident if this test is ever removed.
 */
test('every "a new module reaches nothing" rule gates, including the worst one', async () => {
  const src = await readFile(new URL('../scripts/wiring-map.mjs', import.meta.url), 'utf8');
  const decl = src.match(/const NEW_ORPHAN = new Set\(\[([^\]]*)\]\)/s);
  assert.ok(decl, 'NEW_ORPHAN must still be a literal set the test can read');
  for (const rule of ['module-reaches-no-surface', 'module-only-tested',
    'page-never-routed', 'module-imported-by-nothing']) {
    assert.ok(decl[1].includes(`'${rule}'`),
      `${rule} must gate: a module imported by nothing is worse than one imported only by a test`);
  }
});

/*
 * THE CROSSING — two wildcards sliding past each other in opposite directions.
 *
 * This is the case that named the rule, read off the live tree: nothing in this
 * repository calls `GET /api/model/ask/:capability`, and the map said something
 * did. The suppression happened before evidence was collected, so the endpoint
 * simply vanished from `route-no-caller` with no file named and nothing to check.
 * A missing row is a gap; this was a specific false reassurance about a specific
 * endpoint, which is worse.
 *
 * The first case below is that exact pair, verbatim, from
 * client/src/components/TradeCard.tsx:179. The three after it are the honest
 * matches the fix must not break — each has a wildcard on one side only, which
 * is ordinary and correct.
 */
test('a call wildcard and a route parameter cannot excuse each other in opposite positions', () => {
  // THE LIVE CASE. `ask` is excused by the call's `:p`, and `:capability` by the
  // call's `trade-impact`. Neither substitution survives the other.
  assert.equal(routeAnswersCall('/api/model/ask/:capability', '/api/model/:p/trade-impact'), false);

  // A call filling a declared parameter with a literal: ordinary, must still match.
  assert.equal(routeAnswersCall('/api/teams/:abbr', '/api/teams/DAL'), true);
  // A call interpolating where the route has a literal: also ordinary, must still match.
  assert.equal(routeAnswersCall('/api/model/ask/capability', '/api/model/:p/capability'), true);
  // Both sides variable in the same place: the common case.
  assert.equal(routeAnswersCall('/api/model/:leagueId/simulate', '/api/model/:p/simulate'), true);

  // A literal disagreement is still a literal disagreement, crossing or not.
  assert.equal(routeAnswersCall('/api/model/status', '/api/model/state'), false);
  // Length is still the first gate.
  assert.equal(routeAnswersCall('/api/model/ask/:capability', '/api/model/:p'), false);
});

/*
 * THE PATH THAT STARTS THE STRING.
 *
 * Both outbound patterns need a marker to the LEFT of the path — a `}` closing an
 * interpolation, or a `://`. scripts/bootstrap-data.mjs:104 has neither: the literal
 * comes first and the interpolation is in the query string. Seven routes a bootstrap
 * script dials were therefore sitting in route-no-caller as "nothing calls this", and
 * the deletion of one of them was one manual check away from shipping.
 *
 * The first string below is that line verbatim. The last two are the limit: a path
 * that does not start the string is not this pattern's business, and a path that is
 * only a fragment of a longer word must not match either.
 */
test('outboundUrlPaths sees a path that starts the string, not only one that follows a marker', () => {
  const strings = [
    { text: '/api/edge/gamelogs/sync?season=' },   // scripts/bootstrap-data.mjs:104, verbatim
    { text: '/api/aggregates/refresh-all' },       // :102 — feature audit's file
    { text: 'Weekly boxscores ' },                 // the label beside it, not a path
    { text: 'api/edge/board' },                    // no leading slash: not a path we serve
  ];
  const seen = outboundUrlPaths('', strings);
  assert.equal(seen.get('/api/edge/gamelogs/sync'), 'called');
  assert.equal(seen.get('/api/aggregates/refresh-all'), 'called');
  assert.equal(seen.has('api/edge/board'), false);
  assert.equal(seen.size, 2);

  // Passing no strings at all must leave the two original patterns exactly as they
  // were: this is an addition, and a script's own text still has to earn its rows.
  const textOnly = outboundUrlPaths('fetch(`${origin}/api/edge/board`)');
  assert.equal(textOnly.get('/api/edge/board'), 'called');
  assert.equal(outboundUrlPaths('fetch(`${origin}/api/edge/board`)', []).size, 1);
});

/*
 * A DEFAULT IS A WRITER, AND `column-read-never-written` GATES.
 *
 * The rule reads INSERT and UPDATE column lists. A DEFAULT appears in neither, so
 * `draft_pick_quarantine.first_seen_at` and `draft_pick_corrections.applied_at` —
 * both `DEFAULT (datetime('now'))`, at server/db/schema/core-and-fantasy.js:562 and
 * :579 — were reported as null on every row forever while every insert was in fact
 * stamping them with the current time. Two false positives on a rule that can fail a
 * build, about timestamps that are not merely written but written automatically.
 *
 * The first two lines below are those two columns, copied from the schema. The rest
 * are the boundary: DEFAULT NULL writes the same nothing the rule complains about, so
 * counting it would silence a TRUE finding, and `players.bye_week` (core-and-fantasy.js:94,
 * `bye_week INTEGER` with no default) is the one real finding this must leave standing.
 */
test('a column DEFAULT counts as a writer, and DEFAULT NULL does not', () => {
  const files = new Map([['server/db/schema/fixture.js', { strings: [{ text: `CREATE TABLE IF NOT EXISTS draft_pick_quarantine (
      id INTEGER PRIMARY KEY,
      first_seen_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      reason TEXT
    )` }, { text: `CREATE TABLE IF NOT EXISTS draft_pick_corrections (
      id INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )` }, { text: `CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      bye_week INTEGER,
      retired INTEGER DEFAULT 0,
      nickname TEXT DEFAULT NULL,
      full_label TEXT GENERATED ALWAYS AS (id || nickname) VIRTUAL
    )` }] }]]);

  const defaulted = columnDefaults(files);
  assert.equal(defaulted.has('draft_pick_quarantine.first_seen_at'), true);
  assert.equal(defaulted.has('draft_pick_corrections.applied_at'), true);
  assert.equal(defaulted.has('players.retired'), true, 'a bare literal default still writes');
  assert.equal(defaulted.has('players.full_label'), true, 'a generated column is always filled');

  assert.equal(defaulted.has('players.bye_week'), false, 'no default: the real finding must survive');
  assert.equal(defaulted.has('draft_pick_quarantine.resolved_at'), false);
  assert.equal(defaulted.has('players.nickname'), false, 'DEFAULT NULL writes the nothing the rule is about');
});

/*
 * THE RULE THAT MUST NOT FIRE ON A CONVENTION.
 *
 * `same-name-two-modules` catches one exported name meaning two different things —
 * `gameScriptFor` in gamescript.js and vegas-fantasy.js, with the first two arguments
 * swapped, imported from both by the same route file. Written without the
 * exactly-two-modules filter it produced 1,895 rows: `down()` in forty migrations,
 * `alters()` in every schema file, `cacheStatus()` in three caches. Those are
 * interface contracts a family implements on purpose, and nobody reaching for `down`
 * is confused about which module they mean.
 *
 * This asserts the filter is still in the source, because the difference between this
 * rule and a wall of unreadable text is that one line, and a wall of text is how the
 * last one died.
 */
test('same-name-two-modules only fires on a name in exactly two modules, never on a family', async () => {
  const src = await readFile(new URL('../scripts/wiring-map.mjs', import.meta.url), 'utf8');
  const rule = src.slice(src.indexOf('THE INVERSE: ONE NAME, TWO MODULES'),
    src.indexOf("rule: 'same-name-two-modules'"));
  assert.match(rule, /new Set\(list\.map\(n => n\.file\)\)\.size !== 2/,
    'the exactly-two filter is what keeps down() and alters() out of this rule');
  assert.match(rule, /pa === pb && !extra\.length/,
    'two modules exporting the same name for the same thing is a re-export, not a trap');
  assert.match(rule, /linked\(a\.file, b\.file\)/,
    'if one module imports the other the name is one symbol, not two');
});
