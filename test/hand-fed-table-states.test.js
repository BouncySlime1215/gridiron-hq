/**
 * S-18: three fantasy tables that only change when a person runs something, and
 * a reader for each one that could not tell "nothing was fetched" from "nothing
 * is there".
 *
 *   league_roster_snapshots  bluff-detector.js ownedPlayersByChatName. Empty, it
 *                            falls back to the CURRENT roster, so a declaration
 *                            about a player he has since traded away (the bluff
 *                            the read exists to catch) drops out, silently.
 *   trending_players         trade-engine.js buildAssetUniverse. Empty, every
 *                            asset reads trend_kind: null, the same value as
 *                            "not trending".
 *   correlation_estimates    correlation.js pairCorrelation. Empty, every
 *                            archetype becomes DEFAULTS (0.05 / 0.02) and every
 *                            lineup spread narrows with nothing saying why.
 *
 * Each reader now carries its table's state as a FIELD: table_absent | empty |
 * stale | fresh. Every empty case below is paired with a known-nonzero case on
 * the same read, so a check that can only ever say "empty" fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hand-fed-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;

// A present corpus with no messages: the credibility read runs its real branch.
{
  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec(`
    CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
      is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
      question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));`);
  chat.close();
}

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const freshness = await import('../server/services/data-freshness.js');
const bluff = await import('../server/services/bluff-detector.js');
const correlation = await import('../server/services/correlation.js');
const engine = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const pick = s => (s ? { table: s.table, state: s.state, rows: s.rows } : s);

// ------------------------------------------------------------- the one verdict

test('tableState names the absence as a field: fresh, stale, empty, table_absent', () => {
  db.exec('CREATE TABLE s18_probe (x INTEGER, at TEXT)');
  const entry = table => ({ table, updated_col: 'at',
    current_rule: { description: 'written in the last day', predicate: "julianday(at) >= julianday('now', '-1 days')", bind: [] } });
  // Known-nonzero first: the same read that will say "empty" can see a row.
  run(`INSERT INTO s18_probe VALUES (1, datetime('now'))`);
  assert.deepEqual(pick(freshness.tableState(entry('s18_probe'))), { table: 's18_probe', state: 'fresh', rows: 1 });
  run(`UPDATE s18_probe SET at = '2020-01-01 00:00:00'`);
  assert.equal(freshness.tableState(entry('s18_probe')).state, 'stale');
  run('DELETE FROM s18_probe');
  assert.deepEqual(pick(freshness.tableState(entry('s18_probe'))), { table: 's18_probe', state: 'empty', rows: 0 });
  assert.deepEqual(pick(freshness.tableState(entry('s18_no_such_table'))),
    { table: 's18_no_such_table', state: 'table_absent', rows: 0 },
    'not in this database is a different fix from present-and-empty, and has to be a different word');
  // The canonical verdict keeps its own vocabulary; the distinction is one added field.
  assert.equal(freshness.tableFreshness(entry('s18_no_such_table'), {}).present, false);
  assert.equal(freshness.tableFreshness(entry('s18_probe'), {}).present, true);
  assert.equal(freshness.tableFreshness(entry('s18_no_such_table'), {}).status, 'empty');
});

// ------------------------------------------------------ league_roster_snapshots

function snapshotRow(changedAt) {
  run(`INSERT INTO league_roster_snapshots
       (league_id, season, scoring_period_id, team_id, espn_player_id, player_name, lineup_slot_id,
        is_starter, on_roster, source, first_seen_at, changed_at)
       VALUES (70, 2026, 2, 3, 555, 'Held Player', 2, 1, 1, 'live', ?, ?)`, changedAt, changedAt);
}
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (70, 'espn', 's18-70', 2026, 'Snapshots', '1', 10, 1, '{"teams":[]}', '2026-09-18 01:00:00')`);

test('roster history: the credibility read carries its table state, and a snapshot write is not served the old read', () => {
  const empty = bluff.declarationCredibility();
  assert.equal(empty.available, true, 'fixture: the corpus is present, so this is the real branch');
  assert.deepEqual(pick(empty.roster_history), { table: 'league_roster_snapshots', state: 'empty', rows: 0 });

  // Known-nonzero control on the same read.
  snapshotRow(new Date().toISOString());
  const fresh = bluff.declarationCredibility();
  assert.notEqual(fresh, empty,
    'ownership is checked against league_roster_snapshots; a write there must not be served the cached read');
  assert.deepEqual(pick(fresh.roster_history), { table: 'league_roster_snapshots', state: 'fresh', rows: 1 });

  run(`UPDATE league_roster_snapshots SET changed_at = '2026-01-01T00:00:00.000Z' WHERE league_id = 70`);
  assert.equal(bluff.declarationCredibility().roster_history.state, 'stale');
});

test('roster history: with no corpus on this machine the table state still travels', () => {
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-such-chat.sqlite');
  try {
    const r = bluff.declarationCredibility();
    assert.equal(r.available, false);
    assert.equal(r.roster_history?.table, 'league_roster_snapshots');
    assert.equal(r.roster_history?.state, 'stale', 'the one aged row from the previous test');
  } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
});

test('untouchable stance says when ownership was checked against current rosters only', () => {
  run(`INSERT INTO league_member_identity (league_id, roster_id, chat_name, match_method, confidence)
       VALUES (70, '3', 'Sam', 'confirmed by Nick', 'confirmed')`);
  run(`INSERT INTO manager_player_view (league_id, roster_id, player_name, sentiment, n, last_mention, source)
       VALUES (70, '3', 'Held Player', 3.5, 5, date('now'), 'chat')`);
  const record = { name: 'Sam', credibility: 0.8, declarations: 5, hard_reversals: 1, hedged: 0, held: 4,
    confidence: 'thin' };
  const cred = history => ({ byManager: new Map([['Sam', record]]), events: [], available: true,
    roster_history: { table: 'league_roster_snapshots', state: history, rows: history === 'empty' ? 0 : 9,
      last_write: null } });

  // Control first: full roster history adds no caveat.
  const held = bluff.untouchableStance(70, '3', cred('fresh'));
  assert.equal(held.stance, 'respect', 'fixture: 0.8 credibility respects the declaration');
  assert.equal(held.roster_history?.state, 'fresh');
  assert.doesNotMatch(held.note, /current rosters only/);

  const thin = bluff.untouchableStance(70, '3', cred('empty'));
  assert.equal(thin.roster_history?.state, 'empty',
    'the field travels with the stance; the route serves the stance (routes/trades.js:485)');
  assert.match(thin.note, /current rosters only/,
    'with no roster history a traded-away declaration drops out, and the note Nick sees has to say so');
  assert.match(thin.note, /league_roster_snapshots is empty/, 'which table, and which absence');

  // Not read at all (no corpus): no roster claim is made about a record nobody read.
  const unread = bluff.untouchableStance(70, '3', { byManager: new Map(), events: [], available: false,
    roster_history: { table: 'league_roster_snapshots', state: 'empty', rows: 0, last_write: null } });
  assert.equal(unread.roster_history, null);
  assert.doesNotMatch(unread.note, /current rosters only/);
});

// -------------------------------------------------------- correlation_estimates

test('correlation basis: an empty store is named with the defaults standing in; a fit is the control', () => {
  const empty = correlation.correlationBasis();
  assert.deepEqual(pick(empty), { table: 'correlation_estimates', state: 'empty', rows: 0 });
  assert.deepEqual(empty.fallback, { team: 0.05, opp: 0.02 },
    'what every archetype became, so a spread built on it can say so');
  assert.equal(correlation.pairCorrelation({ position: 'QB', team: 'KC', opponent: 'BUF' },
    { position: 'WR', team: 'KC', opponent: 'BUF' }), 0.05, 'fixture: the default is what the sampler used');

  run(`INSERT INTO correlation_estimates (key, correlation, pairs, fitted_at)
       VALUES ('QB|WR|team', 0.18, 14000, datetime('now'))`);
  correlation.clearCorrelationCache();
  const fitted = correlation.correlationBasis();
  assert.deepEqual(pick(fitted), { table: 'correlation_estimates', state: 'fresh', rows: 1 });
  assert.equal(fitted.fallback, null);
});

// ------------------------------------------------- trade engine: the served read

const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] };
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (71, 'espn', 's18-71', 2026, 'Hand fed', '1', 10, 1, ?, '2026-09-18 01:00:00')`, JSON.stringify(payload));
const lg = () => row('SELECT * FROM leagues WHERE id = 71');
const universe = () => engine.assetUniverse(lg(), deriveFormat(lg()).formatKey);

test('the asset universe context names both hand-fed inputs, and moves when either table does', () => {
  const u0 = universe();
  const h0 = u0.context?.hand_fed;
  assert.ok(h0, 'the served context (model_context on /api/trades/:leagueId/find) carries hand_fed');
  assert.deepEqual(pick(h0.trending_players), { table: 'trending_players', state: 'empty', rows: 0 });
  assert.deepEqual(pick(h0.correlation_estimates), { table: 'correlation_estimates', state: 'fresh', rows: 1 },
    'the same producer as correlationBasis(), not a second read of the table');

  // Known-nonzero control on the served read.
  run(`INSERT INTO trending_players (player_id, kind, count, fetched_at) VALUES (1, 'add', 500, datetime('now'))`);
  const u1 = universe();
  assert.notEqual(u1, u0);
  assert.deepEqual(pick(u1.context.hand_fed.trending_players), { table: 'trending_players', state: 'fresh', rows: 1 });

  // A re-sync rewrites the same rows in place (ON CONFLICT DO UPDATE): no row count moves.
  run(`UPDATE trending_players SET fetched_at = '2026-01-01 00:00:00'`);
  assert.equal(universe().context.hand_fed.trending_players.state, 'stale');

  // A refit rewrites fitted_at in place and stays "fresh": only the table's own stamp can see it.
  const before = universe();
  run(`UPDATE correlation_estimates SET fitted_at = datetime('now', '-1 hours')`);
  const after = universe();
  assert.notEqual(after, before, 'lineupSpread reads correlation_estimates on this universe; a refit must reach it');
  assert.equal(after.context.hand_fed.correlation_estimates.last_write,
    row('SELECT MAX(fitted_at) AS m FROM correlation_estimates').m);
});

test('findTrades keys its cache on the correlation store it prices spreads with', () => {
  const names = engine.ASSET_INPUT_TABLES.map(t => (typeof t === 'string' ? t : t.table));
  assert.ok(names.includes('correlation_estimates'),
    'findTrades fingerprints ASSET_INPUT_TABLES; lineupSpread reads correlation_estimates inside it');
  const trending = engine.ASSET_INPUT_TABLES.find(t => (typeof t === 'string' ? t : t.table) === 'trending_players');
  assert.equal(trending?.stamp, 'fetched_at', 'the in-place re-sync above changes no row count');
});
