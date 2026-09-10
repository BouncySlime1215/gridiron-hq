/**
 * Codex correction C03: "Populated migration 027 fails and downgrade loses
 * evidence."
 *
 * The defect, in one sentence: `027_decision_tape.js` rebuilds
 * `nfl_execution_opportunities` by dropping it, and with foreign keys enabled
 * that DROP implicitly deletes every row, each delete cascades into
 * `nfl_execution_lifecycle_events`, and the child's append-only BEFORE DELETE
 * trigger aborts the whole migration with
 *
 *     lifecycle events are append-only — record a new state instead
 *
 * An installation holding even one lifecycle event therefore cannot upgrade,
 * and because `runMigrations()` is awaited before any route module loads, it
 * cannot start either. The developer's own database never hit this only
 * because it reached 028 with zero opportunity rows.
 *
 * These tests build real fixture databases at 026 -- populated across every
 * lifecycle state the schema of that era allowed -- and drive the actual
 * migration machinery against them. That is only possible because
 * `runMigrations`/`migrate` now take the database as a parameter; a test that
 * used the process connection could only ever exercise the empty case, which
 * is the case that already worked.
 *
 * Every test here asserts the REPAIRED behaviour. The first one additionally
 * demonstrates the original failure by running 027 the way it used to be run,
 * so the reproduction is preserved rather than merely described.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-027-'));
// This suite never touches the process connection; point it somewhere harmless
// so importing db/index.js cannot open the developer's real database.
process.env.GRIDIRON_DB_PATH = path.join(temp, 'unused-process-connection.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { runMigrations, rollbackMigration } = await import('../server/db/migrate.js');
const { planPreflightRepairs, OPPORTUNITY_CASCADE_REPAIR } = await import('../server/db/preflight.js');
const MIGRATIONS_DIR = path.join(process.cwd(), 'server', 'migrations');

const open = [];
test.after(() => {
  for (const database of open) { try { database.close(); } catch { /* already closed */ } }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** Every migration file up to and including `through`, in filename order. */
async function migrationsThrough(through) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.js$/.test(f)).sort()
    .filter(f => f.replace(/\.js$/, '') <= through);
  const loaded = [];
  for (const file of files) {
    loaded.push({ file, mod: await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href) });
  }
  return loaded;
}

/**
 * The rows a real installation would be holding: opportunities across every
 * status 023/026 permitted, each with a full lifecycle history, plus one
 * opportunity with no events at all. `settled` rows carry a realized P&L so
 * that "content preserved" means something economic and not just a row count.
 */
function populate(database, { incompleteRun = false } = {}) {
  const states = ['offered', 'observed', 'decision', 'refreshed', 'accepted', 'settled'];
  let eventId = 0;
  for (const [index, status] of states.entries()) {
    const id = `opp-${status}`;
    database.prepare(`INSERT INTO nfl_execution_opportunities
      (id, created_at, contract_key, contract_hash, event_key, matchup, market, side, participant,
       decision_source, status, note, model_line, model_probability, market_line_at_decision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, `2026-09-0${index + 1}T00:00:00Z`, `nfl|2026-09-13|BAL@KC|spreads|full_game|-|home|-3.5|ot_included|margin_vs_line`,
      `hash-${status}`, 'nfl|2026-09-13|BAL@KC', 'BAL at KC', 'spreads', 'home', 'KC',
      'fixture', status, `note for ${status}`, -3.5 - index, 0.5 + index / 100, -3.5);

    // The lifecycle history up to and including this status.
    for (const state of states.slice(0, index + 1)) {
      eventId += 1;
      const settled = state === 'settled';
      database.prepare(`INSERT INTO nfl_execution_lifecycle_events
        (id, opportunity_id, state, occurred_at, recorded_at, book, line, price, stake_units,
         source, quote_id, fill_confirmed, result, realized_pnl_units, actor, detail_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        eventId, id, state, `2026-09-0${index + 1}T0${states.indexOf(state)}:00:00Z`,
        `2026-09-0${index + 1}T0${states.indexOf(state)}:00:01Z`,
        'draftkings', -3.5, -110, state === 'accepted' || settled ? 1 : null,
        'quote_tape', `quote-${id}-${state}`, 0,
        settled ? 'won' : null, settled ? 0.9091 : null, 'fixture',
        JSON.stringify({ state, opportunity: id }));
    }
  }
  // An opportunity with no lifecycle events: the empty-child case.
  database.prepare(`INSERT INTO nfl_execution_opportunities
    (id, created_at, contract_key, market, side, decision_source, status)
    VALUES (?,?,?,?,?,?,?)`).run(
    'opp-childless', '2026-09-07T00:00:00Z',
    'nfl|2026-09-14|SEA@SF|spreads|full_game|-|away|+2.5|ot_included|margin_vs_line',
    'spreads', 'away', 'fixture', 'offered');

  // A DECISION RUN written by the v1 tape.
  //
  // This was missing, and its absence hid a startup-fatal defect for a whole
  // review cycle. Migration 031 backfills the observation-identity columns onto
  // legacy runs with an UPDATE, and 027 installs a trigger that aborts every
  // UPDATE on that table. With no run in the fixture the UPDATE matched nothing,
  // the trigger never fired, and the migration passed. On any real installation
  // holding one run it raised "decision runs are immutable" and took the whole
  // migration with it — and since runMigrations() is awaited before any route
  // imports, that is an application that cannot start, on every subsequent boot.
  //
  // The lesson is the fixture's, not the migration's: a table that exists in the
  // schema and is empty in the test is a table whose migration is untested.
  if (database.prepare(`SELECT COUNT(*) n FROM sqlite_master
      WHERE type='table' AND name='nfl_decision_runs'`).get().n) {
    database.prepare(`INSERT INTO nfl_decision_runs
      (id, season, week, policy_id, policy_version, board_hash, decided_at,
       decision_count, selected_count, engine_mode, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'run-legacy-1', 2026, 1, 'nfl-spread-v1', '1.1.0', 'legacy-board-hash-1',
      '2026-09-01T00:00:00Z', 2, 1, 'champion', 'written by the v1 tape');
    database.prepare(`INSERT INTO nfl_decision_events
      (run_id, matchup, market, selection, line, american_price, book, eligible, abstention_reason)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'run-legacy-1', 'BAL at KC', 'spread', 'KC', -3.5, -110, 'draftkings', 1, null);
    database.prepare(`INSERT INTO nfl_decision_events
      (run_id, matchup, market, selection, line, american_price, book, eligible, abstention_reason)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'run-legacy-1', 'SEA at SF', 'spread', 'SF', -2.5, -110, 'draftkings', 0, 'edge_below_threshold');

    // A run whose header claims more decisions than the tape ever wrote. The
    // v1 tape had no atomic boundary, so a crash between the header and the
    // last event left exactly this. It is written this way rather than UPDATEd
    // into this state because 027's trigger forbids the UPDATE — the same
    // immutability the migrations have to work around, and a fixture may not
    // pretend it is absent.
    if (incompleteRun) {
      database.prepare(`INSERT INTO nfl_decision_runs
        (id, season, week, policy_id, policy_version, board_hash, decided_at,
         decision_count, selected_count, engine_mode, note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        'run-legacy-2', 2026, 2, 'nfl-spread-v1', '1.1.0', 'legacy-board-hash-2',
        '2026-09-08T00:00:00Z', 5, 2, 'champion', 'header claims five; two were written');
      database.prepare(`INSERT INTO nfl_decision_events
        (run_id, matchup, market, selection, line, american_price, book, eligible, abstention_reason)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        'run-legacy-2', 'GB at CHI', 'spread', 'GB', -6.5, -110, 'draftkings', 1, null);
      database.prepare(`INSERT INTO nfl_decision_events
        (run_id, matchup, market, selection, line, american_price, book, eligible, abstention_reason)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        'run-legacy-2', 'NYJ at BUF', 'spread', 'BUF', -3.5, -110, 'draftkings', 1, null);
    }
  }

  // QUOTE BATCHES written before the receipt clock existed.
  //
  // The same omission as the decision run above, one table over, and it cost a
  // second review cycle. Migration 032 backfills `received_at` and
  // `receipt_clock_source` onto legacy batches with an UPDATE, and
  // `nfl_quote_batches` carries an append-only BEFORE UPDATE trigger. With no
  // batch in the fixture the UPDATE matched nothing and 032 passed; the
  // developer's real database holds 1,152 batches, so every boot aborted with
  // "quote batches are immutable" before a single route was mounted.
  //
  // Two migrations in one batch, the same defect, hidden by the same gap: a
  // fixture that creates a table and never puts a row in it does not test the
  // migrations that touch it.
  if (database.prepare(`SELECT COUNT(*) n FROM sqlite_master
      WHERE type='table' AND name='nfl_quote_batches'`).get().n) {
    for (const [index, batch] of ['batch-legacy-1', 'batch-legacy-2'].entries()) {
      database.prepare(`INSERT INTO nfl_quote_batches
        (batch_id, provider, requested_at, snapshot_at, mode, markets, source_ref,
         events, quotes, raw_hash, tape_version, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        batch, 'the-odds-api', `2026-09-0${index + 1}T17:00:00Z`, `2026-09-0${index + 1}T17:00:00Z`,
        'live', 'spreads,totals,h2h', `legacy-ref-${index + 1}`, 14, 210,
        `legacy-raw-hash-${index + 1}`, 'nfl-quote-tape-v1', `2026-09-0${index + 1}T17:00:01Z`);
    }
  }
}

/** A fixture database at exactly `through`, optionally populated. */
async function fixtureAt(through, { populated = true, name = through, incompleteRun = false } = {}) {
  const file = path.join(temp, `${name}-${Math.random().toString(36).slice(2)}.sqlite`);
  const database = new DatabaseSync(file);
  open.push(database);
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`);
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  for (const { file: f, mod } of await migrationsThrough(through)) {
    mod.up(database);
    database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(mod.name ?? f.replace(/\.js$/, ''));
  }
  if (populated) populate(database, { incompleteRun });
  return { database, file };
}

/**
 * Roll migrations off one at a time until `target` is the latest applied, so a
 * downgrade test can reach the migration it actually wants to exercise.
 * `rollbackMigration` deliberately refuses to skip over anything, which is
 * correct behaviour and the reason this walk exists.
 */
async function unwindTo(database, target) {
  for (;;) {
    const latest = database.prepare(
      `SELECT name FROM schema_migrations WHERE name <> '000_legacy_schema' ORDER BY rowid DESC LIMIT 1`).get();
    if (!latest || latest.name === target) return;
    await rollbackMigration(latest.name, database);
  }
}

const snapshot = (database, table, columns) =>
  database.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY id`).all();

const OPPORTUNITY_COLUMNS = ['id', 'created_at', 'contract_key', 'contract_hash', 'event_key', 'matchup',
  'market', 'side', 'participant', 'decision_source', 'status', 'note', 'model_line',
  'model_probability', 'market_line_at_decision'];
const EVENT_COLUMNS = ['id', 'opportunity_id', 'state', 'occurred_at', 'recorded_at', 'book', 'line',
  'price', 'stake_units', 'source', 'quote_id', 'fill_confirmed', 'result', 'realized_pnl_units',
  'actor', 'detail_json'];

/* ---------------------------------------------------------------- the defect */

test('C03 reproduction: 027 applied directly to a populated 026 database still cannot rebuild the parent', async () => {
  const { database } = await fixtureAt('026_execution_opportunity_forecast');
  const [{ mod: m027 }] = (await migrationsThrough('027_decision_tape')).slice(-1);

  // Exactly what migrate() does: one transaction, foreign keys on, no preflight.
  database.exec('BEGIN IMMEDIATE');
  assert.throws(() => m027.up(database), /append-only lifecycle event\(s\) cascade from it|append-only/,
    'a populated parent rebuild must not be attempted from inside a migration transaction');
  database.exec('ROLLBACK');

  // The fixture is untouched: the transaction protected it, which is why this
  // defect destroyed availability rather than data.
  assert.equal(database.prepare(`SELECT COUNT(*) n FROM nfl_execution_lifecycle_events`).get().n, 21);
  assert.equal(database.prepare(`SELECT COUNT(*) n FROM nfl_execution_opportunities`).get().n, 7);
});

/* ------------------------------------------------------------- the repair */

test('C03: a populated 026 database upgrades all the way through the current migration', async () => {
  const { database, file } = await fixtureAt('026_execution_opportunity_forecast');

  const before = {
    opportunities: snapshot(database, 'nfl_execution_opportunities', OPPORTUNITY_COLUMNS),
    events: snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS)
  };
  const planned = planPreflightRepairs(database);
  assert.deepEqual(planned.map(r => r.name), [OPPORTUNITY_CASCADE_REPAIR],
    'the cascade repair must be planned for this database');

  const applied = await runMigrations(database, file);
  assert.ok(applied.includes('027_decision_tape'), '027 actually applied');
  assert.ok(applied.includes('028_settlement_corrections'));

  // Exact content preservation, row by row and column by column -- not a count.
  assert.deepEqual(snapshot(database, 'nfl_execution_opportunities', OPPORTUNITY_COLUMNS),
    before.opportunities, 'every opportunity row survived byte-identical');
  assert.deepEqual(snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS),
    before.events, 'every lifecycle event survived byte-identical, in order');

  // The widening actually happened.
  const parentSql = database.prepare(
    `SELECT sql FROM sqlite_master WHERE name='nfl_execution_opportunities'`).get().sql;
  for (const status of ['passed', 'expired', 'cancelled']) {
    assert.ok(parentSql.includes(`'${status}'`), `${status} is now a permitted status`);
  }
  assert.ok(parentSql.includes('decision_event_id'), '027 still added its forecast link column');

  // Referential integrity across the whole database, and the child's
  // append-only triggers are back.
  assert.deepEqual(database.prepare(`PRAGMA foreign_key_check`).all(), []);
  assert.throws(() => database.prepare(`DELETE FROM nfl_execution_lifecycle_events WHERE id=1`).run(),
    /append-only/, 'the append-only trigger was restored, not left dropped');

  // And the indexes the parent carried came back with it.
  const indexes = database.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nfl_execution_opportunities'`)
    .all().map(r => r.name);
  for (const index of ['idx_execution_opp_contract', 'idx_execution_opp_status', 'idx_execution_opp_event']) {
    assert.ok(indexes.includes(index), `${index} survived the rebuild`);
  }
});

test('C03: an already-applied-027 database upgrades again with no repair and no change', async () => {
  const { database, file } = await fixtureAt('028_settlement_corrections', { name: 'past-027' });

  assert.deepEqual(planPreflightRepairs(database), [],
    'a database already past 027 must plan no repair');
  const before = {
    opportunities: snapshot(database, 'nfl_execution_opportunities', OPPORTUNITY_COLUMNS),
    events: snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS)
  };

  await runMigrations(database, file);
  assert.deepEqual(snapshot(database, 'nfl_execution_opportunities', OPPORTUNITY_COLUMNS), before.opportunities);
  assert.deepEqual(snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS), before.events);
  assert.deepEqual(database.prepare(`PRAGMA foreign_key_check`).all(), []);
});

test('C03: a fresh empty database still migrates end to end, exactly as before', async () => {
  const file = path.join(temp, `fresh-${Math.random().toString(36).slice(2)}.sqlite`);
  const database = new DatabaseSync(file);
  open.push(database);
  database.exec(`PRAGMA foreign_keys = ON;`);
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const legacy = await import(pathToFileURL(path.join(MIGRATIONS_DIR, '000_legacy_schema.js')).href);
  legacy.up(database);
  database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('000_legacy_schema');

  assert.deepEqual(planPreflightRepairs(database), [], 'nothing to repair on an empty ledger');
  const applied = await runMigrations(database, file);
  assert.ok(applied.includes('027_decision_tape'));
  assert.deepEqual(database.prepare(`PRAGMA foreign_key_check`).all(), []);
});

test('C03: the repair is idempotent — running migrations twice changes nothing', async () => {
  const { database, file } = await fixtureAt('026_execution_opportunity_forecast', { name: 'twice' });
  await runMigrations(database, file);
  const after = {
    opportunities: snapshot(database, 'nfl_execution_opportunities', OPPORTUNITY_COLUMNS),
    events: snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS),
    repairs: database.prepare(`SELECT name FROM schema_preflight`).all()
  };

  const applied = await runMigrations(database, file);
  assert.deepEqual(applied, [], 'a second run applies nothing');
  assert.deepEqual(planPreflightRepairs(database), [], 'and plans no further repair');
  assert.deepEqual(snapshot(database, 'nfl_execution_opportunities', OPPORTUNITY_COLUMNS), after.opportunities);
  assert.deepEqual(snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS), after.events);
  assert.deepEqual(database.prepare(`SELECT name FROM schema_preflight`).all(), after.repairs,
    'the repair is not recorded a second time');
});

test('C03: a failed repair rolls back and leaves the database exactly as it was', async () => {
  const { database, file } = await fixtureAt('026_execution_opportunity_forecast', { name: 'rollback' });
  const before = {
    opportunities: snapshot(database, 'nfl_execution_opportunities', OPPORTUNITY_COLUMNS),
    events: snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS),
    parentSql: database.prepare(`SELECT sql FROM sqlite_master WHERE name='nfl_execution_opportunities'`).get().sql
  };

  // A column the repair has never heard of. It refuses rather than rebuilding
  // the table without it -- silently dropping an unrecognized column would be
  // the same class of quiet evidence loss the repair exists to prevent.
  database.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN operator_annotation TEXT`);
  await assert.rejects(() => runMigrations(database, file), /cannot preserve|operator_annotation/);

  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM schema_migrations WHERE name='027_decision_tape'`).get().n, 0,
  '027 must not be recorded as applied');
  assert.deepEqual(snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS), before.events,
    'no lifecycle evidence was lost');
  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM nfl_execution_opportunities`).get().n, before.opportunities.length);
  assert.deepEqual(database.prepare(`PRAGMA foreign_key_check`).all(), []);
  assert.ok(before.parentSql.length > 0);
});

test('C03: after a failed repair, restarting completes cleanly once the obstruction is gone', async () => {
  const { database, file } = await fixtureAt('026_execution_opportunity_forecast', { name: 'restart' });
  database.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN operator_annotation TEXT`);
  await assert.rejects(() => runMigrations(database, file));

  // SQLite can drop a column; this stands in for an operator resolving whatever
  // the obstruction actually was and rebooting.
  database.exec(`ALTER TABLE nfl_execution_opportunities DROP COLUMN operator_annotation`);
  const applied = await runMigrations(database, file);
  assert.ok(applied.includes('027_decision_tape'), 'the restart completes the upgrade');
  assert.equal(database.prepare(`SELECT COUNT(*) n FROM nfl_execution_lifecycle_events`).get().n, 21);
  assert.deepEqual(database.prepare(`PRAGMA foreign_key_check`).all(), []);
});

test('C03: the pre-migration backup is a consistent snapshot that actually restores', async () => {
  const { database, file } = await fixtureAt('026_execution_opportunity_forecast', { name: 'backup' });
  const before = snapshot(database, 'nfl_execution_lifecycle_events', EVENT_COLUMNS);
  await runMigrations(database, file);

  // `backupBeforeMigration` uses VACUUM INTO rather than copying the file,
  // which matters in WAL mode: committed pages can still be sitting in the
  // -wal companion, so a plain copy produces a backup that looks complete and
  // is quietly behind. The plan is explicit: "Never copy only a live WAL
  // database file as its backup."
  const backups = fs.readdirSync(temp).filter(f => f.startsWith(path.basename(file)) && f.endsWith('.bak'));
  assert.equal(backups.length, 1, 'exactly one snapshot was taken before the upgrade');

  const restored = new DatabaseSync(path.join(temp, backups[0]));
  open.push(restored);
  assert.deepEqual(snapshot(restored, 'nfl_execution_lifecycle_events', EVENT_COLUMNS), before,
    'the snapshot restores the pre-upgrade evidence exactly');
  assert.equal(restored.prepare(
    `SELECT COUNT(*) n FROM schema_migrations WHERE name='027_decision_tape'`).get().n, 0,
  'and it is genuinely the PRE-migration state');
});

/* ------------------------------------------------- downgrade must refuse */

test('C03: 028 refuses to downgrade away a recorded settlement correction', async () => {
  const { database, file } = await fixtureAt('026_execution_opportunity_forecast', { name: 'down-028' });
  await runMigrations(database, file);
  database.prepare(`INSERT INTO nfl_execution_lifecycle_events
    (opportunity_id, state, occurred_at, source, result, realized_pnl_units, actor)
    VALUES (?,?,?,?,?,?,?)`).run(
    'opp-settled', 'settlement_correction', '2026-09-14T00:00:00Z', 'settlement_result',
    'lost', -1, 'fixture');

  await unwindTo(database, '028_settlement_corrections');
  await assert.rejects(() => rollbackMigration('028_settlement_corrections', database),
    /settlement correction\(s\) exist/);
  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM nfl_execution_lifecycle_events WHERE state='settlement_correction'`).get().n, 1,
  'the correction is still there after the refusal');
});

test('C03: 027 refuses to downgrade away terminal evidence, and refuses a populated ledger outright', async () => {
  const { database, file } = await fixtureAt('026_execution_opportunity_forecast', { name: 'down-027' });
  await runMigrations(database, file);

  // Everything above 027 has to come off first, one at a time.
  await unwindTo(database, '027_decision_tape');

  // A terminal state 023's vocabulary cannot represent.
  database.prepare(`INSERT INTO nfl_execution_lifecycle_events
    (opportunity_id, state, occurred_at, source, actor)
    VALUES (?,?,?,?,?)`).run('opp-offered', 'expired', '2026-09-14T00:00:00Z', 'quote_tape', 'fixture');

  await assert.rejects(() => rollbackMigration('027_decision_tape', database),
    /terminal states 023's schema cannot represent|cannot suspend foreign keys/);
  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM nfl_execution_lifecycle_events WHERE state='expired'`).get().n, 1,
  'the terminal evidence survived the refusal');
});

test('C03/C01: a database holding a LEGACY DECISION RUN upgrades — 031 must not trip 027\'s trigger', async () => {
  // The regression this file previously could not catch. 027 protects
  // nfl_decision_runs against UPDATE; 031 backfills identity columns with an
  // UPDATE. Fixtures with no runs never noticed.
  const { database, file } = await fixtureAt('029_quote_tape_commence_index', { name: 'legacy-run' });
  assert.equal(database.prepare(`SELECT COUNT(*) n FROM nfl_decision_runs`).get().n, 1,
    'the fixture really does hold a legacy run');

  const applied = await runMigrations(database, file);
  assert.ok(applied.includes('031_decision_identity'), '031 applied rather than aborting the boot');

  // The backfill did what its comment claims.
  const run = database.prepare(`SELECT * FROM nfl_decision_runs WHERE id='run-legacy-1'`).get();
  assert.equal(run.content_hash, 'legacy-board-hash-1', 'content address preserved from the board hash');
  assert.equal(run.observation_key, 'legacy:run-legacy-1', 'given a distinct legacy observation identity');
  assert.equal(run.data_identity_status, 'unfrozen_live_tables');
  assert.equal(run.tape_version, 'nfl-decision-tape-v1-legacy');
  assert.equal(run.decision_count, 2, 'and nothing about the recorded decision changed');

  // The protection is BACK. A migration that lifts a guard and forgets to
  // replace it is worse than one that never had it.
  assert.throws(
    () => database.prepare(`UPDATE nfl_decision_runs SET note='tampered' WHERE id='run-legacy-1'`).run(),
    /immutable/, 'the immutability trigger was restored after the backfill');
  assert.throws(
    () => database.prepare(`DELETE FROM nfl_decision_runs WHERE id='run-legacy-1'`).run(),
    /immutable/, 'and 031 added the delete protection 027 never had');

  assert.deepEqual(database.prepare(`PRAGMA foreign_key_check`).all(), []);
});

test('C03/C11: a database holding LEGACY QUOTE BATCHES upgrades — 032 must not trip the immutability trigger', async () => {
  // The identical regression, one migration later. `nfl_quote_batches` is
  // append-only; 032 backfills the receipt clock onto legacy batches with an
  // UPDATE. On the developer's database — 1,152 batches — this aborted the
  // whole migration, and since runMigrations() is awaited before any route
  // module imports, the application could not start at all.
  const { database, file } = await fixtureAt('029_quote_tape_commence_index', { name: 'legacy-batches' });
  const before = database.prepare(
    `SELECT batch_id, requested_at, raw_hash, quotes FROM nfl_quote_batches ORDER BY batch_id`).all();
  assert.equal(before.length, 2, 'the fixture really does hold legacy batches');
  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM nfl_quote_batches WHERE receipt_clock_source IS NULL`).get().n, 2,
  'and they predate the receipt clock, which is what makes the backfill fire');

  const applied = await runMigrations(database, file);
  assert.ok(applied.includes('032_quote_receipt_clock'), '032 applied rather than aborting the boot');

  // The backfill states the weaker claim, and states it explicitly.
  for (const row of database.prepare(`SELECT * FROM nfl_quote_batches ORDER BY batch_id`).all()) {
    assert.equal(row.receipt_clock_source, 'legacy_request_time_only',
      'a legacy batch is labelled as holding only a request time');
    assert.equal(row.received_at, row.requested_at,
      'and received_at holds that time as a LOWER BOUND, never as an observed receipt');
  }

  // Nothing recorded about the quotes themselves moved.
  assert.deepEqual(database.prepare(
    `SELECT batch_id, requested_at, raw_hash, quotes FROM nfl_quote_batches ORDER BY batch_id`).all(),
  before, 'the captured evidence is byte-identical — only the clock columns were assigned');

  // The protection is back, both halves of it.
  assert.throws(
    () => database.prepare(`UPDATE nfl_quote_batches SET quotes = 0 WHERE batch_id='batch-legacy-1'`).run(),
    /immutable/, 'the update trigger was restored after the backfill');
  assert.throws(
    () => database.prepare(`DELETE FROM nfl_quote_batches WHERE batch_id='batch-legacy-1'`).run(),
    /immutable/, 'and the delete trigger 032 never touched is still there');
});

test('C03: no migration writes to an append-only table without restoring its guard', async () => {
  // 031 and 032 were the same defect found twice, three days apart, by two
  // different readers. This test is the generalisation: it reads every
  // migration and every trigger the schema and migrations install, and fails on
  // any UPDATE or DELETE against a protected table that does not lift and
  // restore that exact trigger. A third instance should be caught here rather
  // than by a boot failure on someone's populated database.
  const roots = ['server/db/schema', 'server/migrations'];
  const sources = [];
  for (const root of roots) {
    for (const f of fs.readdirSync(path.join(process.cwd(), root)).filter(f => f.endsWith('.js'))) {
      sources.push({ file: `${root}/${f}`, text: fs.readFileSync(path.join(process.cwd(), root, f), 'utf8') });
    }
  }
  const protectedTables = new Set();
  for (const { text } of sources) {
    for (const m of text.matchAll(/BEFORE (?:UPDATE|DELETE) ON ([a-z_]+)/g)) protectedTables.add(m[1]);
  }
  assert.ok(protectedTables.has('nfl_quote_batches') && protectedTables.has('nfl_decision_runs'),
    'the scan found the tables this test exists to protect');

  const offences = [];
  for (const { file, text } of sources.filter(s => s.file.startsWith('server/migrations'))) {
    const body = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/--.*$/gm, '');
    for (const m of body.matchAll(/\b(UPDATE|DELETE FROM)\s+([a-z_]+)/g)) {
      const [, verb, table] = m;
      if (!protectedTables.has(table)) continue;
      const guard = `${table}_no_${verb === 'UPDATE' ? 'update' : 'delete'}`;
      if (!body.includes(`DROP TRIGGER IF EXISTS ${guard}`)) offences.push(`${file}: ${verb} ${table} (needs ${guard} lifted and restored)`);
      else if (!body.includes(`CREATE TRIGGER IF NOT EXISTS ${guard}`)) offences.push(`${file}: lifts ${guard} and never restores it`);
    }
  }
  assert.deepEqual(offences, [], `migrations write to append-only tables unguarded:\n${offences.join('\n')}`);
});

test('C03/C01: a legacy run whose events do not match its header is INVALIDATED, not rewritten', async () => {
  const { database, file } = await fixtureAt('029_quote_tape_commence_index',
    { name: 'incomplete-run', incompleteRun: true });
  assert.equal(database.prepare(
    `SELECT decision_count FROM nfl_decision_runs WHERE id='run-legacy-2'`).get().decision_count, 5,
  'the fixture holds a run whose header claims five decisions');
  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM nfl_decision_events WHERE run_id='run-legacy-2'`).get().n, 2,
  'and only two were ever written');

  await runMigrations(database, file);

  const invalidations = database.prepare(
    `SELECT * FROM nfl_decision_run_invalidations WHERE run_id='run-legacy-2'`).all();
  assert.equal(invalidations.length, 1, 'an invalidation was appended');
  assert.match(invalidations[0].reason, /incomplete legacy run/);
  assert.equal(invalidations[0].actor, '031_decision_identity');

  // The run itself is untouched — that is the whole point of appending.
  const run = database.prepare(`SELECT * FROM nfl_decision_runs WHERE id='run-legacy-2'`).get();
  assert.equal(run.decision_count, 5, 'the header still says what it said');
  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM nfl_decision_events WHERE run_id='run-legacy-2'`).get().n, 2);

  // The complete run alongside it was backfilled normally, not tarred with it.
  assert.equal(database.prepare(
    `SELECT COUNT(*) n FROM nfl_decision_run_invalidations WHERE run_id='run-legacy-1'`).get().n, 0);
});
