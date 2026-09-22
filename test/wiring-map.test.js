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
  clientCalls, payloadKeys, keyReads, declarations, bodyRange,
  foreignHandles, handleFor, gatedRegions, blindCaches,
  functionUnits, functionReach, tableColumns, statementTables, columnEvidence,
  imageDirs, runtimeFilePaths, routeWorkload, routeLiteralAbsent, bulkInScope, outboundUrlPaths, unreachablePages, entryPointScripts,
  routeAnswersCall, columnDefaults, docsCitations, sameNameCollisions, docsRuntimeReads,
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

test('keyReads sees a destructured parameter that has a default value', () => {
  // Found 2026-09-22 by composedKeysNeverRead, which reported `regularSeasonEnd`
  // (server/services/trade-horizon.js:62) and `calibrationPassed`
  // (server/routes/nfl-betting.js:983) as read by nothing. Both are read, as
  // destructured PARAMETERS with defaults:
  //   export function safeStakeFor({ winProb, calibrationPassed = false, ... })
  // The destructuring branch split each part on ':' and then required the
  // remainder to be a bare identifier, so `calibrationPassed = false` matched
  // nothing and the read was lost. A default value is the ordinary way this
  // repository writes an options bag, so the miss was not rare: it made every
  // optional field of every options object look unread.
  const reads = keyReads([
    'export function f({ winProb, calibrationPassed = false, weeks = WEEKS }) { return winProb; }',
    'const { alias: bound = 3 } = opts;',
  ].join('\n'), []);
  assert.ok(reads.has('calibrationPassed'), 'a default value does not stop it being a read');
  assert.ok(reads.has('weeks'));
  assert.ok(reads.has('alias'), 'the SOURCE key is the read, not the local binding');
  assert.ok(!reads.has('bound'), 'the local binding name is not a key of the object');
});

test('keyReads sees a destructured parameter that is not the first parameter', () => {
  // The other half of the same miss, found the same way: the destructuring
  // pattern required `const`, `let`, `var` or `(` immediately before the
  // brace, so `horizonWeights(week, { regularSeasonEnd = ... })` — a bag in
  // the SECOND position — matched nothing.
  // server/services/trade-horizon.js:80-82 is that signature, and :62 writes
  // the key composedKeysNeverRead then reported as unread.
  //
  // Allowing ',' also counts the keys of an object ARGUMENT, `f(a, { k: 1 })`,
  // as reads. That is not new and not a mistake: `(` already did it for a
  // first-position argument, and this helper is deliberately generous in one
  // direction. An over-counted read silences a finding; an under-counted one
  // calls live code dead, and that is the expensive failure.
  const reads = keyReads(
    'export function horizonWeights(week, { playoffOdds = 0.5, regularSeasonEnd = END } = {}) { return week; }',
    []);
  assert.ok(reads.has('regularSeasonEnd'));
  assert.ok(reads.has('playoffOdds'));
});

test('bodyRange skips a destructured parameter list', () => {
  // bodyRange took the first `{` after the function name as the body. For
  // `export function f({ a = 1 } = {}) { … }` that brace is the PARAMETER
  // object, which closes immediately, so the range covered the signature and
  // nothing else.
  //
  // Found 2026-09-22 on server/services/scheduler.js:
  // refreshManagerSignalsOffThread({ leagueIds = null, timeoutMs = 120_000 })
  // constructs the Worker that does the work, and the job resolver saw an
  // empty body and reported that the scheduler does it itself. Every other
  // caller of bodyRange had the same blind spot on every options-bag
  // function in the repository.
  const src = [
    'export function withBag({ leagueIds = null, timeoutMs = 120 } = {}) {',
    '  const marker = 1;',
    '  return marker + leagueIds;',
    '}',
  ].join('\n');
  const range = bodyRange(src, 'withBag');
  assert.ok(range, 'a range is found');
  const body = src.slice(range.start, range.end);
  assert.match(body, /const marker = 1;/, 'the range covers the real body');
  assert.doesNotMatch(body, /timeoutMs = 120/, 'the range does not stop at the parameter object');
});

test('bodyRange walks the whole parameter list, not to the first close paren', () => {
  // Added because a mutation survived: stopping at the FIRST ')' instead of
  // the one that balances passes the test above, since that signature holds no
  // nested parens. A default that calls something does, and then the next '{'
  // is the destructured parameter rather than the body.
  const src = [
    'function withCall(a = fn(), { b } = {}) {',
    '  const marker = 3;',
    '  return marker + a + b;',
    '}',
  ].join('\n');
  const body = ((r) => src.slice(r.start, r.end))(bodyRange(src, 'withCall'));
  assert.match(body, /const marker = 3;/);
  assert.doesNotMatch(body, /\bb \} = \{\}/, 'the range does not stop inside the signature');
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
  // The query goes through rows(), which IS an app helper name and is here a local
  // wrapper around a second database. The offset is the backtick, as build() passes it:
  // the first version of this test passed the offset of the SQL text one character
  // later, so the bare-call branch never matched and the test could not tell whether
  // the foreign-only question was asked before or after the app-helper one. It has to
  // be before, and this is the assertion that says so.
  const at = f.text.indexOf('SELECT * FROM sh_team_weeks') - 1;
  assert.equal(f.text[at], '`', 'the offset handleFor is given is the quote, not the SQL');
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
test('same-name-two-modules only fires on a name in exactly two modules, never on a family', () => {
  // This test used to read the checker's own SOURCE and assert the three guard lines
  // were present. That passes for a rewrite that keeps the lines and loses the
  // behaviour, which is not a test of the rule — it is a test of the text. The rule
  // is a function now so a fixture can reach every guard.
  const node = (name, file, line, reach) => ({ name, file, line, reach: new Set(reach) });
  const run = (pairs, opts = {}) => sameNameCollisions(new Map(pairs), {
    // paramsOf returns the parameter list WITHOUT its brackets — the caller adds them.
    // The first draft of this fixture returned '(team, season, week)' and the rule
    // printed '((team, season, week))', which is the fixture being wrong about the
    // contract rather than the rule being wrong about the code.
    paramsOf: n => opts.params?.[`${n.file}#${n.name}`] ?? 'season, week',
    linked: (x, y) => Boolean(opts.linked?.includes([x, y].sort().join('|'))),
    ignored: new Set(opts.ignored ?? []),
  });

  const a = node('gameScriptFor', 'server/services/gamescript.js', 389, ['games']);
  const b = node('gameScriptFor', 'server/services/vegas-fantasy.js', 124, ['games']);
  const params = {
    'server/services/gamescript.js#gameScriptFor': 'team, season, week',
    'server/services/vegas-fantasy.js#gameScriptFor': 'season, week, team, opts',
  };

  // The live case that named the rule: same name, two modules, arguments swapped.
  const hit = run([['gameScriptFor', [a, b]]], { params });
  assert.equal(hit.length, 1, 'two modules exporting one name for different things is the rule');
  assert.match(hit[0].why, /different arguments/);
  assert.match(hit[0].why, /\(team, season, week\) against \(season, week, team, opts\)/,
    'a row that does not show both signatures leaves the reader to go and look');

  // GUARD 1, exactly two. A name in three modules is an interface convention — down()
  // in forty migrations — and reporting those produced 1,895 rows and no readers.
  //
  // The first draft of this fixture gave the three members identical parameters and
  // no tables, so relaxing guard 1 to `size < 2` left it green: GUARD 2 was holding
  // the family, and guard 1 was never reached. A mutation that survives is a finding
  // about the test. Each member below differs from the others, so guard 1 is the only
  // thing that can keep them out.
  const family = ['a', 'b', 'c'].map((s, i) => node('down', `server/db/migrations/${s}.js`, i + 1, [s]));
  const familyParams = Object.fromEntries(
    family.map((n, i) => [`${n.file}#down`, `db, step${i}`]));
  assert.deepEqual(run([['down', family]], { params: familyParams }), [],
    'three modules is a family, and the family is the point');
  assert.equal(run([['down', family.slice(0, 2)]], { params: familyParams }).length, 1,
    'and exactly two of them, differing, is the rule firing — guard 1 is a count, not a mood');

  // GUARD 2, actually different. Same parameters and the same tables underneath is one
  // symbol re-exported, not a trap.
  const c = node('alters', 'server/db/schema/one.js', 5, ['players']);
  const d = node('alters', 'server/db/schema/two.js', 9, ['players']);
  assert.deepEqual(run([['alters', [c, d]]]), [], 'the same thing twice is not a collision');

  // ... but the same signature over different tables IS one, and says which.
  const e = node('alters', 'server/db/schema/two.js', 9, ['players', 'draft_picks']);
  const byTable = run([['alters', [c, e]]]);
  assert.equal(byTable.length, 1);
  assert.match(byTable[0].why, /read different tables — draft_picks/);

  // GUARD 3, neither imports the other. If one does, the name is one symbol.
  assert.deepEqual(run([['gameScriptFor', [a, b]]],
    { params, linked: ['server/services/gamescript.js|server/services/vegas-fantasy.js'] }), [],
    're-exporting a name is not two modules meaning different things by it');

  // And an accepted collision stays accepted.
  assert.deepEqual(run([['gameScriptFor', [a, b]]], { params,
    ignored: ['collision:server/services/gamescript.js|server/services/vegas-fantasy.js#gameScriptFor'] }), [],
    'a row ruled on by hand does not come back the next run');
});

/*
 * PROSE ABOUT SQL IS NOT SQL, and the census is where that matters most.
 *
 * The title of the test two above this one reads "tableColumns reads CREATE TABLE and
 * ALTER TABLE ADD COLUMN". It is a sentence describing a test. The scan read it as two
 * statements and the table census gained `and` and `ADD` — two rows out of 308, in the
 * one artefact whose entire job is to be an authoritative count of what tables exist.
 *
 * Two guards, because one does not cover the other: a CREATE must be followed by a
 * body (`(` or `AS`), and no match may be a reserved word. A real table cannot be
 * named with a reserved word without quoting it, so refusing these loses nothing.
 */
test('a sentence naming SQL statements does not create tables', () => {
  const prose = [
    { text: 'tableColumns reads CREATE TABLE and ALTER TABLE ADD COLUMN', line: 1 },
    { text: 'we should CREATE TABLE somewhere for this', line: 2 },
  ];
  const { creates } = sqlEdges(prose);
  assert.deepEqual(creates.map(c => c.table), [],
    'a description of SQL must not put tables in the census');

  // And the real statements still land, both forms, including CREATE TABLE ... AS.
  const real = [
    { text: 'CREATE TABLE IF NOT EXISTS manager_signals (league_id INTEGER)', line: 3 },
    { text: 'ALTER TABLE players ADD COLUMN gsis_id TEXT', line: 4 },
    { text: 'CREATE TABLE weekly_rollup AS SELECT * FROM player_week_usage', line: 5 },
  ];
  assert.deepEqual(sqlEdges(real).creates.map(c => c.table).sort(),
    ['manager_signals', 'players', 'weekly_rollup']);
});

/*
 * THE SEARCH FRAGMENT WAS THE ROUTER'S MOUNT PREFIX, AND IT SUPPRESSED THREE ROUTES.
 *
 * `routeLiteralAbsent` is a GATE: it runs before a `route-no-caller` finding is
 * created, so when it is wrong the route does not appear anywhere and nothing says one
 * was dropped. It searched the client for the longest run of literal segments in the
 * path, and that run is the router's own mount prefix whenever the prefix is as long as
 * the tail. A mount prefix appears in the client for every route on that router.
 *
 * Two shapes of the same defect, both measured on this tree:
 *
 *   TOO BROAD. `GET /api/trades/:leagueId/inbox` has two one-segment runs, `trades` and
 *   `inbox`. They tie on segment count, the tie-break took the longer NAME, and the
 *   client writes `/trades` on nearly every line of TradeLab. Suppressed. It has no
 *   caller at all. `GET /api/tradelab/:leagueId/analysis` went the same way — `tradelab`
 *   and `analysis` are both eight characters, and the tie went to the prefix.
 *
 *   TOO GENERIC. `POST /api/drafts/:id/simulate` was judged on `/simulate`, which the
 *   client does write — at client/src/pages/MyTeam.tsx:62, dialling
 *   `/model/${active.id}/simulate`, a different route on a different router. A tail
 *   segment is not unique either.
 *
 * The same heuristic was copied into scripts/route-verdict-list.mjs, where it searched
 * the row for `GET /api/trades/:leagueId/trends` by `/trades` and reported 26 dials and
 * 81 mentions. A row reading 26 dials says "obviously keep" to anyone scanning. That
 * copy was visible and got caught; this one was a silence and did not.
 *
 * So there is one implementation now, exported and shared, and the pattern is the whole
 * path with each `:param` written as `[^/]+` — one segment of anything, which matches
 * an interpolation and cannot cross a separator.
 */
test('a route is searched by its whole path, not by the longest literal run of it', async () => {
  const { routeLiteralAbsent, routePattern } = await import('../scripts/wiring-map.mjs');

  // The client says /trades everywhere, and dials two real routes on that router.
  const tradesClient = [
    'const a = useApi(`/trades/${leagueId}/brain/state`);',
    'const b = useApi(`/trades/${leagueId}/offer?team_id=${teamId}`);',
    'const c = api(`/trades/${leagueId}/player/${picked.id}`);',
  ].join('\n');

  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/inbox', tradesClient), true,
    'TOO BROAD: /trades is the mount prefix; it must not answer for /inbox');
  assert.equal(routeLiteralAbsent('/api/tradelab/:leagueId/analysis', tradesClient), true,
    'TOO BROAD: /tradelab ties with /analysis on length and must not win the tie');

  // The routes that client really does dial stay suppressed, which is this gate's job.
  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/brain/state', tradesClient), false,
    'an honest caller must still suppress its own route');
  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/offer', tradesClient), false);

  // A tail segment is not unique either: a different router owns this /simulate.
  const modelClient = 'const simUrl = `/model/${active.id}/simulate?runs=1500`;';
  assert.equal(routeLiteralAbsent('/api/drafts/:id/simulate', modelClient), true,
    "TOO GENERIC: another router's /simulate must not answer for this one");
  assert.equal(routeLiteralAbsent('/api/model/:id/simulate', modelClient), false,
    'the route that call really dials is still suppressed');

  // Anchoring survives: a longer word starting with the last segment is not a match.
  assert.equal(routeLiteralAbsent('/api/trades/:leagueId/trends', 'x = `/trades/${id}/trending`'), true,
    '/trends must not match /trending');

  // A path with nothing literal in it has nothing to search for, and is not a finding.
  assert.equal(routeLiteralAbsent('/api/:id', 'anything at all'), false);

  // The pattern itself, so a reader can see what is searched without running it.
  assert.equal(routePattern('/api/trades/:leagueId/inbox'), 'trades/[^/]+/inbox');
  assert.equal(routePattern('/api/drafts/:id/simulate'), 'drafts/[^/]+/simulate');
  assert.equal(routePattern('/api/trades/dvp'), 'trades/dvp');
  assert.equal(routePattern('/api/:id'), null, 'nothing literal means no pattern');
});

/*
 * ONE IMPLEMENTATION, NOT TWO. The defect above existed in two files because the
 * heuristic was written twice. Fixing one copy and leaving the other is how the report
 * and the gate came to disagree in the first place, so this pins that the report reads
 * the checker's own function rather than carrying its own.
 */
test('the verdict list searches by the checker\'s pattern, not a copy of it', async () => {
  const src = await readFile(new URL('../scripts/route-verdict-list.mjs', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*\broutePattern\b[^}]*\}\s*from\s*'\.\/wiring-map\.mjs'/,
    'the verdict list must import routePattern from the checker');
  assert.doesNotMatch(src, /runs\.sort|\bruns\.push\b/,
    'a second copy of the longest-run heuristic is what this test exists to prevent');
});

/*
 * "ONLY A TEST REACHES IT" IS NOT "NOTHING REACHES IT", AND BOTH REPORTS SAID IT WAS.
 *
 * Two rows on this tree, each one wrong in the opposite direction:
 *
 *   The verdict list counts a test's `fetch()` as a dial. `GET /api/tradelab/:leagueId/analysis`
 *   reads "dials: 3", and all three are test/cross-account-league-access.test.js. A
 *   reader scanning for a live route stops there. Nothing in this app reaches it.
 *
 *   The impact report excludes test/ from `survivors()`, which is right — a test is not
 *   a reason to keep production code alive — and then prints "reached only through:
 *   GET /api/trades/:leagueId/brain/liquidity → positionLiquidity()". That sentence is
 *   false: test/pick-reasoning.test.js:9 imports positionRequirements() and :114 calls
 *   it. The VERDICT is right and the SENTENCE is wrong, and the sentence is what
 *   somebody acts on. They delete the symbol, the suite goes red, and nothing told them
 *   the test was coming with it.
 *
 * So a test caller is counted, named, and kept in its own column, in both reports, from
 * one predicate rather than three copies of `startsWith('test/')`.
 */
test('a test caller is its own class, counted separately and never silently dropped', async () => {
  const { isTestPath } = await import('../scripts/wiring-map.mjs');

  assert.equal(isTestPath('test/pick-reasoning.test.js'), true);
  assert.equal(isTestPath('test/cross-account-league-access.test.js'), true);
  assert.equal(isTestPath('server/services/position-liquidity.js'), false);
  assert.equal(isTestPath('scripts/bootstrap-data.mjs'), false,
    'a repo script is an external caller, not a test — deleting a route breaks it for real');
  assert.equal(isTestPath('client/src/pages/TradeLab.tsx'), false);
  assert.equal(isTestPath('server/services/trade-engine.js'), false,
    'a production file whose name contains "test" nowhere near the path root is not a test');
  // Built rather than written: a literal docs/*.md path in this file is read by the
  // citation rule as a citation, and this one named a document that has never existed.
  assert.equal(isTestPath(['docs', 'tdd', 'latest.md'].join('/')), false);
});

test('both reports read that one predicate rather than carrying their own', async () => {
  for (const script of ['route-verdict-list.mjs', 'route-deletion-impact.mjs']) {
    const src = await readFile(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
    assert.match(src, /import\s*\{[^}]*\bisTestPath\b[^}]*\}\s*from\s*'\.\/wiring-map\.mjs'/,
      `${script} must import isTestPath from the checker`);
    assert.doesNotMatch(src, /startsWith\('test\/'\)/,
      `${script} must not carry its own copy of the test-path check`);
  }
});

test('the impact report names the tests that come with a falling symbol', async () => {
  const src = await readFile(new URL('../scripts/route-deletion-impact.mjs', import.meta.url), 'utf8');
  assert.match(src, /testSites/,
    'a falling symbol with test callers must carry them, or "reached only through" is a lie');
  assert.match(src, /reached by tests only/i,
    'the already-unreached list must separate "no caller at all" from "a test seam"');
});

/*
 * A RETIRED MODULE CAN BE NAMED IN A STRING, AND NOTHING BREAKS.
 *
 * Three cases turned up on one night, and none of them is an import, so none broke a
 * build or failed a test:
 *
 *   - `server/services/gridiron-model.js:164` declared the registry entry `fantasy.trends`
 *     with `module: 'weekly-trends + trend-exploits'` while trend-exploits.js was being
 *     retired whole on the branch that owns it.
 *   - A note in trend-watch described the same module.
 *   - The `/brain/plan` tombstone told callers the weekly plan was being rebuilt on the
 *     Decision Inbox, a successor that no longer existed.
 *
 * The first two are a module NAME with no file. The third is a SUCCESSOR PATH no route
 * answers, which no name-based rule can see, so it is a second rule and not a wider
 * version of the first.
 *
 * Both are report-only. A string that has gone stale is a documentation fault, not a
 * broken build, and gating on it would fail the suite for a sentence.
 *
 * THE FILTER IS PART OF THE RULE. Written the obvious way — any kebab-case token in any
 * string that is not a file — this produced 1,317 distinct tokens on this tree,
 * `append-only`, `play-by-play`, `red-zone`, ordinary English. That is not a finding,
 * it is a word list. Narrowed to the two places a module is actually NAMED as a module —
 * a filename with its extension inside a string, and the value of a `module:` field when
 * that value is module-shaped — it produces two, and both are real.
 */
test('a string naming a module file that no longer exists is reported', async () => {
  const { deadModuleNames } = await import('../scripts/wiring-map.mjs');

  const files = [
    { path: 'server/services/gridiron-model.js', tree: 'server', scope: 'fantasy',
      raw: "const registry = [{ id: 'fantasy.trends', module: 'weekly-trends + trend-exploits' }];",
      strings: [{ text: 'weekly-trends + trend-exploits', line: 1 }] },
    { path: 'server/services/trend-watch.js', tree: 'server', scope: 'fantasy',
      raw: "const note = 'the roster join lives in trend-exploits.js';",
      strings: [{ text: 'the roster join lives in trend-exploits.js', line: 1 }] },
    { path: 'server/services/weekly-trends.js', tree: 'server', scope: 'fantasy', raw: '', strings: [] },
  ];
  const found = deadModuleNames(files);
  const named = found.map(f => f.name).sort();
  assert.deepEqual(named, ['trend-exploits', 'trend-exploits'],
    'both the registry field and the note name a module with no file; weekly-trends has one');

  // The filter is the rule: ordinary English must not become a finding.
  const prose = [{ path: 'server/services/x.js', tree: 'server', scope: 'fantasy',
    raw: "const t = 'an append-only, play-by-play, red-zone summary';",
    strings: [{ text: 'an append-only, play-by-play, red-zone summary', line: 1 }] }];
  assert.deepEqual(deadModuleNames(prose), [],
    'a kebab-case word in a sentence is a word, not a module');
});

test('a tombstone whose successor no route answers is reported', async () => {
  const { deadTombstoneTargets } = await import('../scripts/wiring-map.mjs');

  const routes = [
    { name: 'GET /api/trades/:leagueId/find', file: 'server/routes/trades.js', line: 10 },
    { name: 'GET /api/trades/:leagueId/brain/plan', file: 'server/routes/trades.js', line: 20 },
  ];
  const files = [{ path: 'server/routes/trades.js', tree: 'server', scope: 'fantasy',
    raw: [
      "r.get('/:leagueId/brain/plan', retired('/api/trades/:leagueId/find', 'moved'));",
      "r.get('/:leagueId/old', retired('/api/decision-inbox', 'rebuilt on the Decision Inbox'));",
    ].join('\n') }];

  const found = deadTombstoneTargets(files, routes);
  assert.deepEqual(found.map(f => f.target), ['/api/decision-inbox'],
    'a successor that exists is fine; one that does not is the whole point of the rule');
  assert.equal(found[0].file, 'server/routes/trades.js');
  assert.equal(found[0].line, 2);
});

/*
 * A NEW CHECKER IS NOT TRUSTED UNTIL IT REPRODUCES A FINDING SOMEBODY ALREADY MADE BY
 * HAND. The three cases above cannot fire on THIS tree — trend-exploits.js still exists
 * here, and /brain/plan's successor /api/trades/:leagueId/find is live — so the fixtures
 * are the only proof of the mechanism, and fixtures can be written to pass.
 *
 * So the rule is held to real data as well. It found two on its first run, in a place
 * nobody was looking: server/db/schema/nfl-a-to-m.js:18 and nfl-n-to-z.js:11 list
 * `server/services/nfl-clv.js` and `server/services/nfl-neural-replay.js` in a `sources`
 * array. Both files were collapsed away by commit 47965a5, "Stage 2: collapse duplicate
 * engines — one CLV module, one neural-replay engine". The arrays still name them.
 */
test('the rule reproduces the two real cases, and the tree is clean of them now', async () => {
  const { deadModuleNames } = await import('../scripts/wiring-map.mjs');

  // The two real lines, verbatim, against a tree where the survivors exist and the
  // collapsed modules do not — which is exactly the state this repository was in.
  const asFound = [
    { path: 'server/db/schema/nfl-a-to-m.js', tree: 'server', scope: 'betting', raw: '',
      strings: [{ text: 'server/services/nfl-clv.js', line: 18 }] },
    { path: 'server/db/schema/nfl-n-to-z.js', tree: 'server', scope: 'betting', raw: '',
      strings: [{ text: 'server/services/nfl-neural-replay.js', line: 11 }] },
    { path: 'server/services/clv-core.js', tree: 'server', scope: 'betting', raw: '', strings: [] },
    { path: 'server/services/nfl-replay.js', tree: 'server', scope: 'betting', raw: '', strings: [] },
  ];
  assert.deepEqual(deadModuleNames(asFound).map(f => `${f.file}:${f.line} ${f.name}`), [
    'server/db/schema/nfl-a-to-m.js:18 nfl-clv',
    'server/db/schema/nfl-n-to-z.js:11 nfl-neural-replay',
  ], 'the rule must still catch the shape it was proved on');

  // And the live tree carries none, because those two entries were fixed on the same
  // branch the rule landed on. This is the half that rots: if a stale name comes back,
  // or the rule stops seeing one, this is what says so.
  const map = JSON.parse(await readFile(new URL('../docs/wiring/wiring-map.json', import.meta.url), 'utf8'));
  const live = map.findings.filter(f => f.rule === 'string-names-a-deleted-module');
  assert.deepEqual(live.map(r => `${r.subject} (${r.evidence[0]})`), [],
    'a string naming a module with no file is a finding, not a thing to leave lying around');
});

/*
 * HOW A TABLE COMES TO EXIST, DERIVED AND NOT LISTED.
 *
 * Twelve tables in this app are in no migration, and "is there a migration for this?"
 * is not a question about tidiness. `league_season_teams` is created only by
 * scripts/backfill-league-history.mjs, and manager-archetypes.js reads it at three
 * places and throws where the backfill never ran. A table created at import exists
 * wherever its module is loaded; a table created on first write appears when that path
 * first runs; a table created by a script exists where somebody remembered to run it.
 * Those are four different promises.
 *
 * So it is a field on every table, derived from the CREATE sites the scan already
 * collects. Never a hand-kept exception list: a list of twelve is out of date the
 * moment somebody adds a thirteenth, and nothing would say so.
 *
 * Three defects in the first version, each of which produced a confident wrong answer:
 *
 *   1. DEPTH WAS MEASURED THROUGH THE LINE ITSELF, so `db.exec(`CREATE TABLE …` read as
 *      depth 1 — the paren it opens on that very line — and five tables created at
 *      import were reported as created on first write.
 *   2. A TEST FIXTURE COUNTED AS A SCRIPT. test/data-lineage-inventory.test.js creates
 *      deliberately fake tables, and one fixture in THIS file created `weekly_rollup`.
 *      They landed in the same bucket as a real backfill script.
 *   3. A DDL CONSTANT COUNTED AS A CREATION. server/services/contingency.js:121 and :133
 *      hold the availability DDL so the fit script, the loader and the tests share one
 *      definition; nothing there executes it. Reading the text's location as the
 *      creation site said those tables exist on every install. They exist where somebody
 *      ran scripts/fit-availability.mjs.
 */
test('the creation site is read from where the DDL runs, not where its text sits', async () => {
  const { creationSite, depthAtLine, ddlDefinitionName, resolveDefinition } =
    await import('../scripts/wiring-map.mjs');

  const atImport = "import { db } from '../db/index.js';\ndb.exec(`CREATE TABLE IF NOT EXISTS manager_signals (\n  id INTEGER)`);\n";
  assert.equal(depthAtLine(atImport, 2), 0, 'depth is measured at the START of the line');
  assert.equal(creationSite('server/services/manager-signals.js', 2, atImport), 'import');

  const inFunction = "function ensure() {\n  db.exec(`CREATE TABLE IF NOT EXISTS reports (id INTEGER)`);\n}\n";
  assert.equal(creationSite('server/services/x.js', 2, inFunction), 'first_write');

  assert.equal(creationSite('server/migrations/020_decision_recommendations.js', 5, ''), 'migration');
  assert.equal(creationSite('server/db/schema/core-and-fantasy.js', 5, ''), 'migration',
    'the frozen fragments are applied by 000_legacy_schema at database open');
  assert.equal(creationSite('scripts/backfill-league-history.mjs', 48, ''), 'script');
  assert.equal(creationSite('test/data-lineage-inventory.test.js', 59, ''), 'test_only',
    'a table only a test creates is a fixture, not a script table');

  const definition = "export const RATES_DDL = `CREATE TABLE IF NOT EXISTS nfl_availability_rates (\n  n INTEGER)`;\n";
  assert.equal(creationSite('server/services/contingency.js', 1, definition), 'definition');
  assert.equal(ddlDefinitionName(definition, 1), 'RATES_DDL');
  assert.equal(ddlDefinitionName(atImport, 2), null, 'a line that executes DDL is not a definition');

  // And a definition resolves to whoever executes it.
  const executors = [
    { path: 'server/services/contingency.js', code: definition },
    { path: 'scripts/fit-availability.mjs', code: "db.exec(RATES_DDL);\n" },
  ];
  assert.deepEqual(resolveDefinition('RATES_DDL', executors),
    { site: 'script', file: 'scripts/fit-availability.mjs', line: 1 });
  assert.equal(resolveDefinition('RATES_DDL', [executors[0]]), null,
    'a definition nothing executes stays a definition — that is a finding, not a gap');
});

test('the derived field agrees with every table that was catalogued by hand', async () => {
  const map = JSON.parse(await readFile(new URL('../docs/wiring/wiring-map.json', import.meta.url), 'utf8'));
  const by = new Map(map.tables.map(t => [t.table, t]));

  // The ten rows of the hand-made catalogue that exist in THIS tree. Two of the twelve
  // (coach_answers, coach_person_context) and one script table (coach_person_variables)
  // live on another branch and cannot be checked from here.
  const catalogued = {
    manager_signals: ['import', 'server/services/manager-signals.js:42'],
    manager_player_view: ['import', 'server/services/manager-signals.js:51'],
    manager_archetypes: ['import', 'server/services/manager-archetypes.js:74'],
    manager_archetype_jev: ['import', 'server/services/manager-archetypes.js:86'],
    league_member_identity: ['import', 'server/services/manager-identity.js:17'],
    nfl_ensemble_rank_reports: ['first_write', null],
    nfl_availability_rates: ['script', 'scripts/fit-availability.mjs:54'],
    nfl_availability_role_rates: ['script', 'scripts/fit-availability.mjs:55'],
    // MOVED, and the move is real. It was created by scripts/backfill-league-history.mjs:48
    // when this catalogue was made by hand; #89 landed server/migrations/064_league_history_tables.js,
    // which creates it. The map reported the change and the catalogue had not. A table that
    // gains a migration stops being something an operator has to remember to run, which is the
    // distinction `created_by` exists to draw — so the new value is the interesting one.
    league_season_teams: ['migration', 'server/migrations/064_league_history_tables.js:29'],
  };
  for (const [table, [kind, site]] of Object.entries(catalogued)) {
    const row = by.get(table);
    assert.ok(row, `${table} is missing from the census`);
    assert.equal(row.created_by, kind, `${table} should be ${kind}, not ${row.created_by}`);
    if (site) assert.equal(row.created_at_site, site, `${table} site`);
  }

  // The two availability tables keep a pointer to where their DDL is written, which is
  // the whole reason they were hard to catalogue by hand.
  assert.equal(by.get('nfl_availability_rates').created_via, 'server/services/contingency.js:121');
  assert.equal(by.get('nfl_availability_role_rates').created_via, 'server/services/contingency.js:133');

  // decision_recommendations is migration 020, not runtime-created — a correction to
  // the catalogue that the derived field makes on its own.
  assert.equal(by.get('decision_recommendations').created_by, 'migration');
  assert.match(by.get('decision_recommendations').created_at_site, /^server\/migrations\/020_/);

  // PRECEDENCE, which nothing above touches. A mutation setting migration's rank to
  // last survived the first version of this test: almost every table has exactly one
  // KIND of create site, so the ordering never came up. `player_gamelog` is created by
  // a frozen fragment AND by two test fixtures, so the answer depends entirely on
  // migration winning, and it must, because a table with a migration has one whatever
  // else also creates it.
  const mixed = map.tables.find(t => t.table === 'player_gamelog');
  assert.ok(mixed.created_in.some(c => c.startsWith('server/db/schema/')));
  assert.ok(mixed.created_in.some(c => c.startsWith('test/')),
    'this row is only a precedence test while a test also creates it');
  assert.equal(mixed.created_by, 'migration',
    'a migration outranks every other create site for the same table');

  // Every table has an answer. A null here means a CREATE the classifier could not
  // place, which is the one outcome that must never pass silently.
  const unplaced = map.tables.filter(t => !t.created_by).map(t => t.table);
  assert.deepEqual(unplaced, [], 'every table in the census must say how it comes to exist');
});


/*
 * A BRANCH THAT CANNOT MATCH IS NOT A BRANCH.
 *
 * handleFor asks three questions in order: did this SQL go to `x.prepare(`, to a
 * bare `name(`, or to nothing it recognises. The second question was asked with
 * `before.match(/<BS>([A-Za-z_$][\w$]*)\s*\(\s*$/)` — a literal BACKSPACE byte
 * (0x08) where `\b` was written. No source file contains that byte, so the match
 * was always null and both bare-call branches were dead from the day they were
 * committed. `grep -P '\x08'` over the tree finds exactly one occurrence and it is
 * that regex.
 *
 * Nothing went red, because the branch below it returns 'app' too and almost every
 * file is an app file. It surfaced on league_transactions_raw, whose create in
 * test/refresh-loop-steps.test.js:169 — a plain run(`CREATE TABLE ...`) on the app
 * handle — was reported as running on a `chat` handle declared twenty-three lines
 * BELOW it. Two faults compounded: the dead branch, and foreignOnlyFile reading
 * only STATIC imports, so a file whose app handle arrives through
 * `await import('../server/db/index.js')` was judged to hold no app handle at all
 * and had its queries handed to the first foreign name in the file.
 *
 * The ordering matters as much as the byte. `rows` is an app helper AND the name
 * league-history.js gives its own foreign wrapper, so the foreign-only question
 * has to be asked first — the test above ("a file with its own handle and no
 * app-db import is foreign throughout") is what fails if someone restores the byte
 * without moving it.
 *
 * The fixture tables below are named zz_fixture_* on purpose. This file's SQL
 * fixtures are read by the census like any other source, so a fixture that names a
 * real table hands that table a create site in test/wiring-map.test.js — which is
 * what the first draft of these two tests did to league_transactions_raw and
 * messages, in a commit whose whole point was that that row was wrong.
 */
test('the app handle is recognised when it arrives through a dynamic import', () => {
  const f = fileOf(`import { DatabaseSync } from 'node:sqlite';
    const { rows, run } = await import('../server/db/index.js');
    const chat = new DatabaseSync(chatFile);
    run(\`CREATE TABLE IF NOT EXISTS zz_fixture_app_table (league_id INTEGER)\`);
    chat.exec(\`CREATE TABLE zz_fixture_chat_table (msg_id INTEGER)\`);`);
  const foreign = foreignHandles(f);
  assert.ok(foreign.has('chat'), 'the second handle is still a second handle');
  assert.equal(foreignOnlyFile(f, foreign), false,
    'a file that imports the app db dynamically holds the app handle');
  f.foreignOnlyFile = foreignOnlyFile(f, foreign);

  const atApp = f.text.indexOf('CREATE TABLE IF NOT EXISTS zz_fixture_app_table');
  assert.equal(handleFor(f, atApp - 1, foreign).handle, 'app',
    'run() is the app helper, whatever else the file opens');

  const atChat = f.text.indexOf('CREATE TABLE zz_fixture_chat_table');
  assert.equal(handleFor(f, atChat - 1, foreign).handle, 'chat',
    'and the query that really is on the second handle still says so');
});

test('a bare call on a foreign handle is attributed to that handle, not the app', () => {
  // openChatDb returns something queried by calling it, so the SQL reaches a bare
  // name that is a KNOWN foreign handle. This is the only branch of handleFor whose
  // answer differs from the default, and with the backspace in place it could never
  // be taken: the file imports the app db, so the fallthrough said 'app'.
  const f = fileOf(`import { rows } from '../db/index.js';
    const chatQuery = openChatDb(CHAT_PATH);
    const a = chatQuery(\`SELECT msg_id FROM zz_fixture_chat_table\`);`);
  const foreign = foreignHandles(f);
  assert.ok(foreign.has('chatQuery'));
  f.foreignOnlyFile = foreignOnlyFile(f, foreign);
  assert.equal(f.foreignOnlyFile, false);
  const at = f.text.indexOf('SELECT msg_id FROM zz_fixture_chat_table');
  assert.equal(handleFor(f, at - 1, foreign).handle, 'chatQuery',
    'a query handed to a second database is not the app database');
});

test('the checker source holds no control characters', async () => {
  // The fault above renders as nothing in most editors and as an invisible gap in a
  // terminal, which is why it survived every reading of that function. A byte-level
  // check is the only kind that catches it. Tab, newline and carriage return are the
  // three that legitimately appear in source.
  for (const name of ['wiring-map.mjs', 'route-verdict-list.mjs', 'route-deletion-impact.mjs']) {
    const src = await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    const bad = [];
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) {
        bad.push(`${name}:${src.slice(0, i).split('\n').length} 0x${c.toString(16).padStart(2, '0')}`);
      }
    }
    assert.deepEqual(bad, [], 'a control character in source is a corrupted escape, not a character');
  }
});


/*
 * A CITATION IS A PROMISE, AND THIS REPOSITORY BREAKS 80 OF THEM.
 *
 * `server/routes/aggregates.js:217` says "See docs/CONSENSUS_WEIGHTS.md before
 * re-attempting this". The file is real and it is at
 * docs/evidence/historical/CONSENSUS_WEIGHTS.md. So the one pointer whose entire job is
 * to stop somebody redoing an experiment that already failed is broken at exactly the
 * moment of the redo — the reader types the path, gets nothing, and concludes the note
 * is stale.
 *
 * Two states, not one, and the difference decides what to do. MOVED: the basename
 * resolves somewhere under docs/, so the citation is repairable mechanically and the
 * document is still there to read. GONE: no file of that name exists anywhere, so the
 * citation is a claim about something that no longer exists and needs a person.
 *
 * This rule reads f.raw, not the scanned views, and that is the whole reason it can
 * exist: scan() blanks comment bodies in both `code` and `text`, and nearly every
 * citation in this repository is in a comment. Report-only — it never gates, because a
 * broken link should not stop a deploy.
 */
// The fixture paths are BUILT rather than written, and that is not fussiness. This
// rule reads raw source, the test tree is in scope, and the first draft of these
// fixtures wrote that path as a literal — so the checker found five citations in its
// own test file and reported them as findings about the repository. Same fault as the
// zz_fixture_* rename two commits ago, in a new rule.
//
// This sentence does not name the path either. The first version of this comment
// explained the fix by quoting the literal it was about, which put the row straight
// back into the report — a comment describing a fixture is read by the rule exactly
// like the fixture.
const D = 'docs';
const docFixture = (path, raw) => ({ path, raw, tree: 'server', scope: null, strings: [] });

test('a citation that resolves is not a finding, and one that moved says where it went', () => {
  const index = {
    has: new Set([`${D}/reference/fantasy/PRESEASON_MODEL.md`, `${D}/HERE.md`]),
    byBase: new Map([['PRESEASON_MODEL.md', [`${D}/reference/fantasy/PRESEASON_MODEL.md`]],
      ['HERE.md', [`${D}/HERE.md`]]]),
  };
  const out = docsCitations([
    docFixture('server/a.js', `// see ${D}/HERE.md for the method\n`),
    docFixture('server/b.js', `const x = 1;\n// measured in ${D}/PRESEASON_MODEL.md.\n`),
    docFixture('server/c.js', `// the plan was ${D}/NEVER_EXISTED.md\n`),
  ], index);

  assert.equal(out.some(r => r.cited === `${D}/HERE.md`), false,
    'a citation that resolves is not a finding');

  const moved = out.find(r => r.cited === `${D}/PRESEASON_MODEL.md`);
  assert.ok(moved, 'a citation in a COMMENT must be seen: that is where nearly all of them are');
  assert.equal(moved.state, 'moved');
  assert.equal(moved.line, 2, 'the line is the line of the citation, not of the file');
  assert.deepEqual(moved.resolves_to, [`${D}/reference/fantasy/PRESEASON_MODEL.md`]);

  const gone = out.find(r => r.cited === `${D}/NEVER_EXISTED.md`);
  assert.ok(gone);
  assert.equal(gone.state, 'gone');
  assert.deepEqual(gone.resolves_to, [],
    'gone means no file of that name anywhere, which is a different job from repointing');
});

test('the rule reproduces the citation that was found by hand', async () => {
  const map = JSON.parse(await readFile(new URL('../docs/wiring/wiring-map.json', import.meta.url), 'utf8'));
  const rows = (map.findings ?? []).filter(f => f.rule === 'docs-citation-points-at-nothing');
  assert.ok(rows.length, 'the rule must fire on this tree, which has 80 of these');

  // The one that named the rule. A new checker is not trusted until it reproduces a
  // finding somebody already made by hand.
  const consensus = rows.find(r => r.evidence?.[0]?.startsWith('server/routes/aggregates.js')
    && r.subject === 'docs/CONSENSUS_WEIGHTS.md');
  assert.ok(consensus, 'aggregates.js cites docs/CONSENSUS_WEIGHTS.md and the file is elsewhere');
  assert.match(consensus.detail, /docs\/evidence\/historical\/CONSENSUS_WEIGHTS\.md/,
    'a row that cannot say where the document went leaves the reader exactly where they were');

  // And it must not fire on a citation that is correct.
  assert.equal(rows.some(r => r.subject === `${D}/tdd/wiring-map-route-deletions.tdd.md`), false,
    'this file exists and is cited: a rule that flags it is a rule nobody will read twice');
});


/*
 * THE BRANCH NOBODY TESTED.
 *
 * `handleFor` has three ways of answering, and the last commit proved two of them
 * and left the first alone. `viaMethod` — `someHandle.prepare(`, `.exec(`, `.run(`,
 * `.all(`, `.get(` — was never broken, so nothing here noticed it, and the evidence
 * file said so in as many words: "no test above would notice if its regex lost a
 * byte the same way". A `0x08` is not a one-off. It is a class of fault, and the
 * function it hit has another regex of the same shape sitting above the one that
 * got it.
 *
 * What makes the method branch worth its own test rather than a comment is the
 * FALLTHROUGH. Delete it and nothing throws: `audit.prepare(` still matches the
 * bare-call branch below it, on the word `prepare`, which is not a foreign handle
 * and not an app helper, so the answer becomes 'app' — a query on a second database
 * silently filed as the app's. That is the same wrong answer the backspace produced,
 * reached by a different road, and it is invisible in the output for the same
 * reason: a wrong attribution does not print, it merges.
 *
 * Fixture tables are zz_fixture_* for the reason written above test 76.
 */
test('a query handed to a handle by method call is that handle, and the app is the default', () => {
  // The fixture SQL reuses the two zz_fixture_* tables test 76 and test 77 already
  // create, and adds no CREATE of its own. A fixture that creates a table adds a row
  // to the census — that is how zz_fixture_method_foreign appeared for one run of this
  // test and had to be taken back out. Reads and inserts against a table the fixtures
  // already declare cost the census nothing.
  const f = fileOf(`import { rows, run } from '../db/index.js';
    const audit = new DatabaseSync(AUDIT_PATH);
    db.prepare(\`SELECT league_id FROM zz_fixture_app_table\`);
    audit.exec(\`INSERT INTO zz_fixture_chat_table (msg_id) VALUES (1)\`);
    audit.prepare(\`SELECT msg_id FROM zz_fixture_chat_table WHERE msg_id > 0\`).get();
    pool.all(\`SELECT league_id FROM zz_fixture_app_table WHERE league_id > 0\`);`);
  const foreign = foreignHandles(f);
  assert.deepEqual([...foreign.keys()], ['audit'], 'one second handle, opened once');
  f.foreignOnlyFile = foreignOnlyFile(f, foreign);
  assert.equal(f.foreignOnlyFile, false, 'the file imports the app db, so it has an app handle');

  const at = needle => f.text.indexOf(needle) - 1;

  // The receiver is a KNOWN foreign handle: the answer is that handle, and it is the
  // only answer that differs from the default. Both methods, because the method list
  // is part of the regex and dropping one of them is a live way to break this.
  assert.equal(handleFor(f, at('INSERT INTO zz_fixture_chat_table'), foreign).handle, 'audit',
    'exec() on the audit handle writes to the audit database, not the app');
  assert.equal(handleFor(f, at('SELECT msg_id FROM zz_fixture_chat_table WHERE'), foreign).handle, 'audit',
    'prepare() on the audit handle reads the audit database, not the app');

  // The receiver is not a foreign handle. In a file that holds the app's database,
  // that is the app, whether the receiver is the app's own name or one this checker
  // has never heard of.
  assert.equal(handleFor(f, at('SELECT league_id FROM zz_fixture_app_table`'), foreign).handle, 'app',
    'db.prepare() in a file that imports the app db is the app db');
  assert.equal(handleFor(f, at('SELECT league_id FROM zz_fixture_app_table WHERE'), foreign).handle, 'app',
    'an unrecognised receiver is not evidence of a second database');

  // And where there IS no app handle, an unrecognised receiver cannot be the app.
  // This is foreignDefault(), reached through the method branch rather than the bare
  // one — the case league-history.js made necessary, asked the other way round.
  const g = fileOf(`const hist = new DatabaseSync(HIST_PATH);
    pool.get(\`SELECT msg_id FROM zz_fixture_chat_table LIMIT 1\`);`);
  const gForeign = foreignHandles(g);
  g.foreignOnlyFile = foreignOnlyFile(g, gForeign);
  assert.equal(g.foreignOnlyFile, true, 'no app-db import, so no app handle');
  assert.equal(handleFor(g, g.text.indexOf('SELECT msg_id FROM zz_fixture_chat_table LIMIT 1') - 1, gForeign).handle,
    'hist', 'a file with no app database cannot answer "app"');
});


/*
 * AN ABSOLUTE PATH FROM SOMEBODY'S LAPTOP IS STILL A CITATION.
 *
 * A second, by-hand pass over the other direction — citations written INSIDE the
 * markdown under docs/, pointing at source — reported 17 missing files on its first
 * run. Thirteen of them were the resolver, not the docs: those citations carry
 * absolute paths beginning with a home directory, and a resolver that matches a fixed
 * prefix fails on a path that is perfectly good. A gate that cries wolf on its first
 * run gets an exception added to it and is then ignored, which is worse than not
 * having it.
 *
 * This rule was never going to hit that, because it resolves by BASENAME and its
 * pattern starts at the `docs/` segment wherever that segment sits. That is worth a
 * test rather than a claim: the failure mode is known now, and an assertion is the
 * only thing that stops a later "tidy the regex" from introducing it.
 */
test('a citation carrying an absolute path from a developer machine still resolves', () => {
  const D = 'docs';
  const moved = `${D}/reference/fantasy/OFFSEASON_MODEL.md`;
  const index = { has: new Set([moved]), byBase: new Map([['OFFSEASON_MODEL.md', [moved]]]) };
  const at = (raw) => docsCitations([{ path: 'server/services/x.js', raw, scope: null }], index);

  const home = at(`// the fit is described in /Users/somebody/Code/gridiron-hq/${D}/OFFSEASON_MODEL.md\n`);
  assert.equal(home.length, 1, 'the docs/ segment is the citation, whatever sits to the left of it');
  assert.equal(home[0].cited, `${D}/OFFSEASON_MODEL.md`);
  assert.deepEqual(home[0].resolves_to, [moved],
    'resolving by basename is what makes an absolute path harmless');

  // The same document, cited at its real path, is not a finding at all.
  assert.deepEqual(at(`// see ${moved}\n`), [],
    'a citation that is correct must never appear, or the report is noise');

  // And a repo-relative citation to the same moved document still resolves.
  const rel = at(`// see ${D}/OFFSEASON_MODEL.md\n`);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].state, 'moved');
});


/*
 * A PATH IN A STRING IS AN EDGE NO IMPORT GRAPH CAN SEE.
 *
 * `docs/CLAUDE-NEXT-STEPS.md` is not documentation. `nfl-research-lab.js:279` reads it
 * off disk and serves it, and `nfl-execution-integrity.test.js` compares it byte for
 * byte, so editing a markdown file changes what a route returns and turns the suite
 * red. Nothing in the map said so: 2,331 findings and not one mentioned that file.
 *
 * The parts were all there. `runtimeFilePaths()` has read `path.join(BASE, '…')` since
 * it was written — but fed exactly one question, whether the Docker image copies the
 * directory, behind a gate requiring BASE to be a recognised repo-root name.
 * `nfl-research-lab.js` joins a local `root`, so the row was dropped before anything
 * looked at it. The gap was not a missing parser. It was a file read modelled as a
 * deployment question and never as a dependency.
 */
test('a source module reading a file under docs at runtime is an edge, and it is reported', () => {
  const D = 'docs';
  const index = { has: new Set([`${D}/CLAUDE-NEXT-STEPS.md`]), byBase: new Map() };
  const file = (path, tree, text) => ({ path, tree, text, scope: null, strings: [] });

  // A SERVED read: the running application returns the contents of this file.
  const served = docsRuntimeReads([file('server/services/nfl-research-lab.js', 'server',
    `export async function researchMasterPlan() {\n`
    + `  return fs.readFile(path.join(root, '${D}/CLAUDE-NEXT-STEPS.md'), 'utf8');\n}`)], index);
  assert.equal(served.length, 1, 'the read that named this rule must be the row it produces');
  assert.equal(served[0].cited, `${D}/CLAUDE-NEXT-STEPS.md`);
  assert.equal(served[0].klass, 'served', 'a server module makes it application data');
  assert.equal(served[0].exists, true);

  // A local `root` rather than PROJECT_ROOT is the exact reason the existing rule
  // dropped this row, so it is asserted rather than assumed.
  assert.equal(runtimeFilePaths(`fs.readFile(path.join(root, '${D}/CLAUDE-NEXT-STEPS.md'))`)[0]
    .repoRelative, false, 'the old gate discards this, which is why a second rule exists');

  // TOOLING is a different consequence and gets a different class: moving the file
  // breaks a report, not a route.
  const tooling = docsRuntimeReads([file('scripts/route-verdict-list.mjs', 'script',
    `const d = JSON.parse(fs.readFileSync('${D}/wiring/route-verdicts.json', 'utf8'));`)], index);
  assert.equal(tooling.length, 1);
  assert.equal(tooling[0].klass, 'tooling');
  assert.equal(tooling[0].exists, true, 'this one is in the repository');

  // A read of a path that is not there is the strongest row of the three, and the
  // rule finds one on this tree: nfl-learned-shadow-explain.js builds a docs/ path
  // under an audit directory no commit has produced.
  const missing = docsRuntimeReads([file('server/services/x.js', 'server',
    `fs.readFileSync(path.join(PROJECT_ROOT, '${D}/betting-model/nowhere/LATEST.json'))`)], index);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].exists, false, 'a path nothing produces is the row worth having');

  // A test file is not in scope. This file is full of docs/ paths, and reading them
  // would make the checker report its own fixtures as facts about the repository
  // for the fourth time.
  assert.deepEqual(docsRuntimeReads([file('test/x.test.js', 'test',
    `fs.readFileSync('${D}/CLAUDE-NEXT-STEPS.md')`)], index), []);
});

test('the rule reproduces the runtime docs read that was found by hand', async () => {
  const map = JSON.parse(await readFile(new URL('../docs/wiring/wiring-map.json', import.meta.url), 'utf8'));
  const rows = map.findings.filter(f => f.rule === 'source-reads-a-file-under-docs');
  assert.ok(rows.length, 'the rule must fire on this tree');

  const plan = rows.find(r => r.evidence[0].startsWith('server/services/nfl-research-lab.js'));
  assert.ok(plan, 'the read another thread found by hand is the one this must reproduce');
  assert.match(plan.subject, /CLAUDE-NEXT-STEPS\.md$/);
  assert.match(plan.detail, /application data rather than documentation/);
});

/*
 * A JOB'S LINE IS THE LINE ITS OWN KEY IS ON.
 *
 * Found while chasing a different bug: the inventory was rendering job paths
 * as "null:1280", and the null turned out to be the smaller half of it. Every
 * job in the map was cited at the PREVIOUS job's line — mlb_logs at the line
 * holding `mlb_schedule:`, player_rosters at the line holding
 * `mlb_tomorrow_picks:` — and the first job at `export const JOBS = {` itself.
 * Of 62 job surfaces, the number cited at a line containing their own key
 * was zero.
 *
 * The cause is that RE_JOB opens with `(^|[\n{,])`, so m.index is the offset
 * of the delimiter — the comma that ENDS the previous entry — and not of the
 * name. One character of slack, one entry of error, on every job citation the
 * map has ever emitted.
 *
 * The second test is the one that matters. The scheduler thread cited
 * scheduler.js:1196 for refreshPlayerRosters from their own reading, weeks
 * before this map disagreed with them at 1195. They were right. A fix that
 * cannot reproduce a number somebody already got by hand is not a fix, it is
 * a second guess, so the real file is the fixture here on purpose.
 */
test('schedulerJobs cites each job at the line its own key is on', () => {
  const src = [
    'export const JOBS = {',                                        // 1
    "  zz_fixture_first: { run: runFirst, tier: 'live' },",         // 2
    "  zz_fixture_second: { run: runSecond, tier: 'heavy' },",      // 3
    '  zz_fixture_third: {',                                        // 4
    "    run: runThird, tier: 'growth',",                           // 5
    "    label: 'ends with a brace and a comma' },",                // 6
    '};',                                                           // 7
  ].join('\n');

  const jobs = schedulerJobs(src, 'server/services/scheduler.js');
  assert.deepEqual(
    jobs.map((j) => [j.name, j.line]),
    [['zz_fixture_first', 2], ['zz_fixture_second', 3], ['zz_fixture_third', 4]],
    'each job belongs on its own line, not on the line of the entry before it',
  );
});

test('every job in the real scheduler is cited at a line holding that job key', async () => {
  const file = 'server/services/scheduler.js';
  const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const lines = src.split('\n');
  const jobs = schedulerJobs(src, file);

  // Not a sample: every one of them, named when wrong, because a count alone
  // would not say which citation to stop trusting.
  const wrong = jobs
    .filter((j) => !new RegExp(`\\b${j.name}\\s*:\\s*\\{`).test(lines[j.line - 1] ?? ''))
    .map((j) => `${j.name} cited :${j.line} -> ${JSON.stringify((lines[j.line - 1] ?? '').trim().slice(0, 50))}`);
  assert.deepEqual(wrong, [], `${wrong.length} of ${jobs.length} job citations point at the wrong line`);

  // The scheduler thread read `player_rosters` at :1196 by hand, before this map
  // existed to disagree with them, and that number was asserted as a constant. It
  // survived until #89 and #91 added lines above it and the job moved to :1217 —
  // at which point the assertion was measuring scheduler.js's layout, a file this
  // thread does not own, and not the map's arithmetic at all.
  //
  // What the hand-read number was actually worth is a SECOND OPINION: somebody
  // found that line without using the scanner. So take the second opinion the same
  // way every run, by reading the file directly, and let the citation move when the
  // file does. A frozen line number in another thread's file is a fixture that goes
  // stale on somebody else's commit and says nothing when it does.
  const byHand = lines.findIndex((l) => /\bplayer_rosters\s*:\s*\{/.test(l)) + 1;
  assert.ok(byHand > 0, 'player_rosters is not in scheduler.js any more');
  assert.equal(jobs.find((j) => j.name === 'player_rosters')?.line, byHand);

  // The census, counted a different way than schedulerJobs counts it, because
  // a defect injection that dropped the FIRST job left every surviving
  // citation correct and every assertion above it green. A line-anchored count
  // over the JOBS block shares no code with the scanner's offset arithmetic,
  // so the two agreeing means something.
  const open = lines.findIndex((l) => l.startsWith('export const JOBS'));
  const close = lines.findIndex((l, i) => i > open && l === '};');
  const keyed = lines.slice(open, close).filter((l) => /^ {2}[a-z]\w*:\s*\{/.test(l)).length;
  assert.equal(jobs.length, keyed, 'one job surface per top-level key in JOBS, no more and no fewer');
});
