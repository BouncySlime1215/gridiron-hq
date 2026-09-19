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
  scan, sqlEdges, moduleEdges, routeHandlers, routeMounts, schedulerJobs,
  clientCalls, payloadKeys, keyReads, declarations,
  foreignHandles, handleFor, gatedRegions, blindCaches,
  functionUnits, functionReach, tableColumns, statementTables,
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
 * The protection is only real if the three ways round it are closed, so each
 * one below is an attack, not a happy path.
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
  assert.ok(!fields.includes('"NEVER_BASELINE":'),
    'the protected-rule list must not be readable as data from the file it polices');
});

test('every grandfathered entry names an owner or a scope, and what retires it', () => {
  assert.ok(GRANDFATHERED.size > 0);
  for (const [key, why] of GRANDFATHERED) {
    assert.match(why, /RETIRES WHEN:/, `${key} must say what would retire it`);
    assert.match(why, /Owner:|BETTING SCOPE/, `${key} must name an owner or its out-of-scope reason`);
    assert.match(why, /\.js:\d+/, `${key} must cite the file and line it was found at`);
  }
});
