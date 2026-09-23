/**
 * What Coach can actually do, and the one shape everything it does comes back in.
 *
 * Two rules hold this together.
 *
 * ONE SHAPE. Every tool result becomes rows with named columns, recorded in
 * the ledger, so a claim cites a service answer exactly the way it cites a
 * SQL row. A nested object becomes one row with dotted column names
 * (`out.0.player`), which is ugly to read and exactly right to cite — a cite
 * has to name a scalar or it is not evidence.
 *
 * NEVER RE-IMPLEMENT. The existing services are the tools. whoPlays answers
 * "who is the depth", coachingProfile answers "what is the coach's scheme
 * like", footballContext answers "what does the game script look like". Coach
 * calls them; it does not grow a second opinion about any of them. The
 * platform already has one number per question and this keeps it that way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-tools-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { newLedger } = await import('../server/services/coach/ledger.js');
const { COACH_TOOLS, toolDefinitions, runCoachTool, toRows, CoachToolError } =
  await import('../server/services/coach/tools.js');

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division, head_coach, off_scheme)
     VALUES (1, 'PHI', 'Philadelphia Eagles', 'NFC', 'East', 'Nick Sirianni', 'wide zone')`);
run(`INSERT INTO players (id, name, position, team_id, depth_rank) VALUES (1, 'A Player', 'WR', 1, 1)`);

test('toRows: an array of objects is already rows', () => {
  const { rows, columns, truncated } = toRows([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
  assert.deepEqual(rows, [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
  assert.deepEqual(columns, ['a', 'b']);
  assert.equal(truncated, false);
});

test('toRows: a nested object becomes one row of dotted scalar columns', () => {
  const { rows, columns } = toRows({
    season: 2026, week: 3, team: 'PHI',
    out: [{ player: 'A Player', snap_share: 0.7 }],
    note: null
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].season, 2026);
  assert.equal(rows[0]['out.0.player'], 'A Player');
  assert.equal(rows[0]['out.0.snap_share'], 0.7);
  assert.equal(rows[0].note, null);
  assert.ok(columns.includes('out.0.player'));
});

test('toRows: an array of scalars becomes a row each, under `value`', () => {
  const { rows } = toRows(['a', 'b']);
  assert.deepEqual(rows, [{ value: 'a' }, { value: 'b' }]);
});

test('toRows: a wide result is capped and says it was capped', () => {
  const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
  const { rows, truncated } = toRows(wide, { maxColumns: 50 });
  assert.equal(Object.keys(rows[0]).length, 50);
  assert.equal(truncated, true);
});

test('toRows: nothing at all is no rows, not a row of nothing', () => {
  for (const empty of [null, undefined, []]) {
    const { rows } = toRows(empty);
    assert.deepEqual(rows, []);
  }
});

test('every tool declares a name, a description and an input schema Claude can read', () => {
  assert.ok(COACH_TOOLS.length >= 4);
  for (const tool of COACH_TOOLS) {
    assert.ok(tool.name && /^[a-z][a-z0-9_]*$/.test(tool.name), `bad tool name ${tool.name}`);
    assert.ok(tool.description?.length > 30, `${tool.name} has no useful description`);
    assert.equal(tool.input_schema.type, 'object');
    assert.equal(typeof tool.run, 'function');
  }
  const names = COACH_TOOLS.map(t => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name');
});

test('the definitions handed to Claude carry no functions', () => {
  const definitions = toolDefinitions();
  assert.equal(definitions.length, COACH_TOOLS.length);
  for (const definition of definitions) {
    assert.equal(definition.run, undefined);
    assert.ok(definition.name && definition.input_schema);
  }
  assert.doesNotThrow(() => JSON.stringify(definitions));
});

test('sql_select runs through the guarded layer and lands in the ledger', () => {
  const ledger = newLedger();
  const { entry, summary } = runCoachTool('sql_select',
    { sql: 'SELECT name, position FROM players', params: [] }, { ledger });
  assert.equal(entry.id, 'r1');
  assert.equal(entry.rows[0].name, 'A Player');
  assert.deepEqual(entry.tables, ['players']);
  assert.equal(ledger.cell('r1#0.position').value, 'WR');
  assert.match(summary.cite_prefix, /^r1#/);
});

test('sql_select honours the row ceiling it was asked for, and says it truncated', () => {
  for (let i = 2; i <= 6; i++) {
    run(`INSERT INTO players (id, name, position, team_id, depth_rank) VALUES (?, ?, 'WR', 1, ?)`,
      i, `Player ${i}`, i);
  }
  const ledger = newLedger();
  // The ceiling is the model's own choice, and ignoring it is silent: six rows
  // arrive where two were asked for, and nothing in the result says so.
  const { entry } = runCoachTool('sql_select',
    { sql: 'SELECT name FROM players ORDER BY id', max_rows: 2 }, { ledger });
  assert.equal(entry.row_count, 2, 'max_rows was ignored');
  assert.equal(entry.rows.length, 2);
  assert.equal(entry.truncated, true, 'a shortened result that does not say so is the failure mode');
  assert.equal(ledger.cell('r1#2.name'), null, 'a row past the ceiling must not be citable');
});

test('sql_select passes a refusal straight through, so the model sees the boundary', () => {
  const ledger = newLedger();
  assert.throws(() => runCoachTool('sql_select', { sql: 'DROP TABLE players' }, { ledger }),
    /may only read|refus/i);
  assert.equal(ledger.queries.length, 0, 'a refused query must not enter the ledger');
});

test('a service tool records rows the same way a query does', () => {
  const ledger = newLedger();
  const { entry } = runCoachTool('who_plays', { season: 2026, week: 3, team: 'PHI' }, { ledger });
  assert.equal(entry.id, 'r1');
  assert.equal(entry.tool, 'who_plays');
  assert.equal(entry.rows.length, 1);
  assert.equal(entry.rows[0].team, 'PHI');
  assert.ok(entry.provenance && Object.keys(entry.provenance).length > 0,
    'a service result still has to say where its data comes from');
});

test('every service tool names a function that really exists, so no second implementation can hide', async () => {
  const services = COACH_TOOLS.filter(t => t.kind === 'service');
  assert.ok(services.length >= 4, `only ${services.length} service tools`);
  for (const tool of services) {
    assert.match(tool.source, /^server\/services\/[a-z-]+\.js#[a-zA-Z]+$/,
      `${tool.name} does not name the existing service it calls`);
    // Shape is not enough: a plausible-looking path that exports nothing by
    // that name is exactly how a re-implementation would hide behind a
    // declaration. Import it and look.
    const [file, fn] = tool.source.split('#');
    const module = await import(`../${file}`);
    assert.equal(typeof module[fn], 'function',
      `${tool.name} says it calls ${tool.source}, which exports no such function`);
  }
});

test('compute goes through the ledger, so a worked-out number is traceable', () => {
  const ledger = newLedger();
  runCoachTool('sql_select', { sql: 'SELECT depth_rank, id FROM players' }, { ledger });
  const { entry } = runCoachTool('compute',
    { op: 'sum', inputs: ['r1#0.depth_rank', 'r1#0.id'], label: 'nonsense but traceable' }, { ledger });
  assert.equal(entry.id, 'd1');
  assert.equal(entry.value, 2);
  assert.match(entry.formula, /sum/);
});

test('an unknown tool is refused by name rather than ignored', () => {
  const ledger = newLedger();
  assert.throws(() => runCoachTool('delete_everything', {}, { ledger }), err => {
    assert.ok(err instanceof CoachToolError);
    assert.match(err.message, /delete_everything/);
    return true;
  });
});

test('catalog_lookup tells Coach what it may read without touching the ledger', () => {
  const ledger = newLedger();
  const { summary } = runCoachTool('catalog_lookup', {}, { ledger });
  assert.ok(summary.tables.includes('players'));
  assert.equal(ledger.queries.length, 0, 'metadata is not evidence and must not be citable');
  const one = runCoachTool('catalog_lookup', { table: 'players' }, { ledger }).summary;
  assert.equal(one.entry.table, 'players');
  assert.ok(one.entry.means.length > 10);
});

/*
 * Added after mutation M29 survived: the array cap inside a nested object was
 * applied without setting `truncated`, and no test noticed. A silently
 * shortened list is the exact failure this service exists to remove.
 */
test('toRows: a long array inside a nested object is capped and says so', () => {
  const value = { team: 'PHI', out: Array.from({ length: 80 }, (_, i) => ({ player: `P${i}` })) };
  const { rows, truncated } = toRows(value, { maxArray: 10 });
  assert.equal(truncated, true);
  assert.equal(rows[0]['out.9.player'], 'P9');
  assert.equal(rows[0]['out.10.player'], undefined);
});

test('source_trust wraps sourceTrustScore, the pooled-shrinkage math sql_select cannot do', () => {
  const ledger = newLedger();
  for (let i = 1; i <= 6; i++) {
    run(`INSERT INTO nfl_news_events (event_id, source_kind, source_ref, content_hash, claim_type, claim_text,
         evidence_span, reporter_handle, published_at, first_seen_time, extractor_version)
         VALUES (?, 'news_item', ?, ?, 'injury_status', 'x', 'x', 'RealReporter', '2025-09-04T00:00:00Z',
         '2025-09-04T00:00:00Z', 'test')`, `ev${i}`, `ev${i}`, `ev${i}`);
    run(`INSERT INTO beat_reporter_claim_resolutions (event_id, reporter_handle, claim_type, resolved_state,
         resolved_reason, resolved_at) VALUES (?, 'RealReporter', 'injury_status', ?, 'test', '2025-09-05T00:00:00Z')`,
      `ev${i}`, i <= 5 ? 'confirmed' : 'contradicted');
  }
  const { entry } = runCoachTool('source_trust', { handle: 'RealReporter' }, { ledger });
  assert.equal(entry.rows[0].state, 'measured');
  assert.equal(entry.rows[0].sample_size, 6);
  assert.ok(entry.tables.includes('beat_reporter_claim_resolutions'));
});

test('source_trust reports "none" honestly for a handle with zero resolved claims, never a score', () => {
  const ledger = newLedger();
  const { entry } = runCoachTool('source_trust', { handle: 'NobodyEver' }, { ledger });
  assert.equal(entry.rows[0].state, 'none');
  assert.equal(entry.rows[0].score, null);
});

test('source_trust refuses a blank handle rather than scoring an empty string', () => {
  const ledger = newLedger();
  assert.throws(() => runCoachTool('source_trust', { handle: '  ' }, { ledger }), CoachToolError);
});

/*
 * Added after mutation M27 could not be made to change a result: nothing
 * asserted that a service tool which throws leaves the ledger untouched. A
 * half-recorded entry would let a claim cite rows that were never returned.
 */
test('a tool that throws leaves the ledger exactly as it was', () => {
  const ledger = newLedger();
  runCoachTool('sql_select', { sql: 'SELECT name FROM players' }, { ledger });
  assert.equal(ledger.queries.length, 1);
  assert.throws(() => runCoachTool('who_plays', { season: 2026, week: 3, team: 'NOT A TEAM' }, { ledger }));
  assert.throws(() => runCoachTool('sql_select', { sql: 'SELECT * FROM nfl_bet_log' }, { ledger }));
  assert.throws(() => runCoachTool('compute', { op: 'sum', inputs: ['r9#0.x'] }, { ledger }));
  assert.equal(ledger.queries.length, 1, 'a failed tool call must not add a ledger entry');
  assert.equal(ledger.derived.length, 0);
});
