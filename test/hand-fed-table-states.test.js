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
 * Each reader carries its table's state as a FIELD: table_absent | empty |
 * stale | fresh | unknown, from ONE entry per table (data-freshness.js
 * servedTableEntry): the served-table registry's when it exports one, the same
 * rule text otherwise, so a reader and the Data Health panel cannot disagree on
 * the same input. Every empty case below is paired with a known-nonzero case on
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
// The roster-snapshot rule binds the season being played; the reader takes it from
// the same producer the Data Health route does (weekly-learning.js currentNflWeek).
process.env.NFL_SEASON = '2026';
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;

// A present corpus with ONE declaration: Sam calls "New Player" untouchable. It only
// counts once the ownership check says New Player is his (bluff-detector.js
// declarations), which is exactly what the roster history decides.
{
  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec(`
    CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
      is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
      question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));
    INSERT INTO messages VALUES (1, 'group', 'league', 'h1', 'Sam', 0, '2026-09-10T12:00:00Z',
      'not moving him', 0, 0);
    INSERT INTO jev_chat_signals VALUES (1, 'Sam', 'group', 'New Player', 'own_roster.untouchable', 0.9,
      '2026-09-10T13:00:00Z');`);
  chat.close();
}

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const freshness = await import('../server/services/data-freshness.js');
const bluff = await import('../server/services/bluff-detector.js');
const correlation = await import('../server/services/correlation.js');
const engine = await import('../server/services/trade-engine.js');
const pricing = await import('../server/services/counterparty-pricing.js');
const { deriveFormat } = await import('../server/services/format.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const pick = s => (s ? { table: s.table, state: s.state, rows: s.rows } : s);
const HAND_FED = ['league_roster_snapshots', 'trending_players', 'correlation_estimates'];

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

test('one entry per hand-fed table, and a rule that binds a value the reader did not supply is unknown, not stale', () => {
  for (const table of HAND_FED) {
    const entry = freshness.servedTableEntry(table);
    assert.equal(entry?.table, table, `${table} has exactly one entry to read its rule from`);
  }
  assert.throws(() => freshness.servedTableEntry('s18_nobody_registered_this'), /no served-table entry/);
  // league_roster_snapshots binds the season. Asked with none, the rule would bind
  // NULL, match nothing and say "stale": a claim about the data from a missing input.
  run(`INSERT INTO league_roster_snapshots
       (league_id, season, scoring_period_id, team_id, espn_player_id, player_name, lineup_slot_id,
        is_starter, on_roster, source, first_seen_at, changed_at)
       VALUES (69, 2026, 1, 1, 1, 'Probe', 2, 1, 1, 'live', '2026-09-01', '2026-09-01')`);
  try {
    assert.equal(freshness.servedTableState('league_roster_snapshots', { currentSeason: 2026 }).state, 'fresh',
      'control: with the season supplied the same row is current');
    assert.equal(freshness.servedTableState('league_roster_snapshots').state, 'unknown');
  } finally { run('DELETE FROM league_roster_snapshots WHERE league_id = 69'); }
});

// ------------------------------------------------------ league_roster_snapshots

function snapshotRow(playerName, espnId, changedAt, season = 2026) {
  run(`INSERT INTO league_roster_snapshots
       (league_id, season, scoring_period_id, team_id, espn_player_id, player_name, lineup_slot_id,
        is_starter, on_roster, source, first_seen_at, changed_at)
       VALUES (70, ?, 2, 3, ?, ?, 2, 1, 1, 'live', ?, ?)`, season, espnId, playerName, changedAt, changedAt);
}
const league70 = { teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }, { id: 3, name: 'Sams', roster: { entries: [] } }] };
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (70, 'espn', 's18-70', 2026, 'Snapshots', '1', 10, 1, ?, '2026-09-18 01:00:00')`, JSON.stringify(league70));
run(`INSERT INTO league_member_identity (league_id, roster_id, chat_name, match_method, confidence)
     VALUES (70, '3', 'Sam', 'confirmed by Nick', 'confirmed')`);
// What he has declared in this database (the stance reads it; counterpartyLayer profiles him on it).
run(`INSERT INTO manager_player_view (league_id, roster_id, player_name, sentiment, n, last_mention, source)
     VALUES (70, '3', 'Held Player', 3.5, 5, date('now'), 'chat')`);
const samDeclarations = cred => cred.byManager.get('Sam')?.declarations ?? 0;

test('roster history: the credibility read carries its table state, and every snapshot write is seen, not only a state flip', () => {
  const empty = bluff.declarationCredibility();
  assert.equal(empty.available, true, 'fixture: the corpus is present, so this is the real branch');
  assert.deepEqual(pick(empty.roster_history), { table: 'league_roster_snapshots', state: 'empty', rows: 0 });
  assert.equal(samDeclarations(empty), 0, 'no history and an empty current roster: New Player is not his');

  // Known-nonzero control on the same read: empty -> fresh.
  snapshotRow('Held Player', 555, new Date().toISOString());
  const fresh = bluff.declarationCredibility();
  assert.notEqual(fresh, empty,
    'ownership is checked against league_roster_snapshots; a write there must not be served the cached read');
  assert.deepEqual(pick(fresh.roster_history), { table: 'league_roster_snapshots', state: 'fresh', rows: 1 });
  assert.equal(samDeclarations(fresh), 0, 'Held Player is his, New Player still is not');

  // fresh -> fresh: the state does not move, who owns whom does.
  snapshotRow('New Player', 556, new Date(Date.now() + 1000).toISOString());
  const more = bluff.declarationCredibility();
  assert.equal(more.roster_history.state, 'fresh');
  assert.equal(samDeclarations(more), 1,
    'a snapshot write that leaves the state fresh still changes ownership; the cache has to see it');

  // In place: the collector's markGone (collect-roster-snapshots.mjs writePeriod) sets
  // on_roster = 0 and bumps changed_at. No row count and no state moves.
  run(`UPDATE league_roster_snapshots SET on_roster = 0, changed_at = ? WHERE espn_player_id = 556`,
    new Date(Date.now() + 2000).toISOString());
  const gone = bluff.declarationCredibility();
  assert.equal(gone.roster_history.state, 'fresh');
  assert.equal(samDeclarations(gone), 0, 'an in-place re-capture moves only changed_at; the cache has to see that too');
  run('UPDATE league_roster_snapshots SET on_roster = 1 WHERE espn_player_id = 556');

  // No write at all: the season rolls over and the same rows stop being current.
  process.env.NFL_SEASON = '2027';
  try {
    const rolled = bluff.declarationCredibility();
    assert.equal(rolled.roster_history.state, 'stale',
      'the rule asks for a snapshot of the season being played; a new season with none is stale, with no write');
  } finally { process.env.NFL_SEASON = '2026'; }

  // Rows, none for this season: stale by the registry's own rule.
  run('UPDATE league_roster_snapshots SET season = 2025 WHERE league_id = 70');
  assert.equal(bluff.declarationCredibility().roster_history.state, 'stale');
});

test('roster history: with no corpus nothing reads the table state, so it is not returned', () => {
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-such-chat.sqlite');
  try {
    const r = bluff.declarationCredibility();
    assert.equal(r.available, false);
    assert.equal('roster_history' in r, false,
      'untouchableStance qualifies only a record it read; a field on this branch would have no reader');
    assert.doesNotMatch(bluff.untouchableStance(70, '3', r).note, /league_roster_snapshots/,
      'no roster claim about a record nobody read');
  } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
});

test('untouchable stance: the note names which absence the ownership check worked from', () => {
  const record = { name: 'Sam', credibility: 0.8, declarations: 5, hard_reversals: 1, hedged: 0, held: 4,
    confidence: 'thin' };
  const cred = (state, lastWrite = null) => ({ byManager: new Map([['Sam', record]]), events: [], available: true,
    roster_history: { table: 'league_roster_snapshots', state, rows: state === 'empty' || state === 'table_absent' ? 0 : 9,
      last_write: lastWrite } });

  // Control first: full roster history adds no caveat.
  const held = bluff.untouchableStance(70, '3', cred('fresh'));
  assert.equal(held.stance, 'respect', 'fixture: 0.8 credibility respects the declaration');
  assert.doesNotMatch(held.note, /league_roster_snapshots/);
  assert.equal('roster_history' in held, false,
    'routes/trades.js:485 serves word_stance and word_note only; the state reaches Nick through the note');

  const thin = bluff.untouchableStance(70, '3', cred('empty'));
  assert.match(thin.note, /current rosters only/,
    'with no roster history a traded-away declaration drops out, and the note Nick sees has to say so');
  assert.match(thin.note, /league_roster_snapshots is empty/, 'which table, and which absence');

  const absent = bluff.untouchableStance(70, '3', cred('table_absent'));
  assert.match(absent.note, /current rosters only/);
  assert.match(absent.note, /league_roster_snapshots is not in this database/, 'a different fix from empty');

  const behind = bluff.untouchableStance(70, '3', cred('stale', '2026-08-30T00:00:00Z'));
  assert.match(behind.note, /league_roster_snapshots is stale/,
    'stale history is the one way a stopped collector reaches Nick; it has to be named');
  assert.match(behind.note, /2026-08-30/, 'with the last write when the entry records one');
  assert.doesNotMatch(behind.note, /current rosters only/, 'stale is not empty: the history exists, it is behind');

  const unread = bluff.untouchableStance(70, '3', { byManager: new Map(), events: [], available: false });
  assert.doesNotMatch(unread.note, /league_roster_snapshots/);
});

test('the served note: counterpartyLayer, which /brain/managers serves as word_note, carries the live state', () => {
  // State left by the tests above: rows for 2025 only, so stale for 2026.
  const stale = pricing.counterpartyLayer(70, { season: 2026, week: 2 }).get('3');
  assert.ok(stale?.stance, 'fixture: roster 3 is profiled');
  assert.match(stale.stance.note, /league_roster_snapshots is stale/,
    'counterparty-pricing hands untouchableStance the credibility it read; the caveat has to survive that hop');

  // Known-nonzero control: a 2026 snapshot makes the history current and the caveat goes.
  run('UPDATE league_roster_snapshots SET season = 2026 WHERE league_id = 70');
  const current = pricing.counterpartyLayer(70, { season: 2026, week: 2 }).get('3');
  assert.doesNotMatch(current.stance.note, /league_roster_snapshots/);
  assert.match(current.stance.note, /^Sam: 1 declarations/, 'and the declaration the history made his is counted');
});

// -------------------------------------------------------- correlation_estimates

test('correlation basis: an empty store is named with the defaults standing in; an undated row is stale; a fit is the control', () => {
  const empty = correlation.correlationBasis();
  assert.deepEqual(pick(empty), { table: 'correlation_estimates', state: 'empty', rows: 0 });
  assert.deepEqual(empty.fallback, { team: 0.05, opp: 0.02 },
    'what every archetype became, so a spread built on it can say so');
  assert.equal(correlation.pairCorrelation({ position: 'QB', team: 'KC', opponent: 'BUF' },
    { position: 'WR', team: 'KC', opponent: 'BUF' }), 0.05, 'fixture: the default is what the sampler used');

  run(`INSERT INTO correlation_estimates (key, correlation, pairs, fitted_at) VALUES ('QB|WR|team', 0.18, 14000, NULL)`);
  assert.equal(correlation.correlationBasis().state, 'stale', 'fitted_at is nullable: an estimate nobody can date');

  run(`UPDATE correlation_estimates SET fitted_at = datetime('now')`);
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
const find = () => engine.findTrades(lg(), { myTeamId: '1' });

test('the asset universe and the find-trades body name both hand-fed inputs, and move when either table does', () => {
  const u0 = universe();
  const h0 = u0.context?.hand_fed;
  assert.ok(h0, 'the universe context carries hand_fed');
  assert.deepEqual(pick(h0.trending_players), { table: 'trending_players', state: 'empty', rows: 0 });
  assert.deepEqual(pick(h0.correlation_estimates), { table: 'correlation_estimates', state: 'fresh', rows: 1 },
    'the same producer as correlationBasis(), not a second read of the table');

  // The consumer: GET /api/trades/:leagueId/find returns findTrades' body.
  const f0 = find();
  assert.ok(!f0.error, f0.error);
  assert.deepEqual(pick(f0.model_context?.hand_fed?.trending_players), { table: 'trending_players', state: 'empty', rows: 0 },
    'model_context on the find-trades body carries the state');

  // Known-nonzero control on both reads.
  run(`INSERT INTO trending_players (player_id, kind, count, fetched_at) VALUES (1, 'add', 500, datetime('now'))`);
  const u1 = universe();
  assert.notEqual(u1, u0);
  assert.deepEqual(pick(u1.context.hand_fed.trending_players), { table: 'trending_players', state: 'fresh', rows: 1 });
  assert.equal(find().model_context.hand_fed.trending_players.state, 'fresh',
    'a trending sync is not served the cached search');

  // A re-sync rewrites the same rows in place (ON CONFLICT DO UPDATE): no row count moves.
  run(`UPDATE trending_players SET fetched_at = '2026-01-01 00:00:00'`);
  assert.equal(universe().context.hand_fed.trending_players.state, 'stale');

  // A refit rewrites fitted_at in place and stays "fresh": only the table's own stamp can see it.
  const before = universe();
  const printBefore = engine.tradeIdeasFingerprint(lg(), { myTeamId: '1' });
  run(`UPDATE correlation_estimates SET fitted_at = datetime('now', '-1 hours')`);
  const after = universe();
  assert.notEqual(after, before, 'lineupSpread reads correlation_estimates on this universe; a refit must reach it');
  assert.equal(after.context.hand_fed.correlation_estimates.last_write,
    row('SELECT MAX(fitted_at) AS m FROM correlation_estimates').m);
  assert.notEqual(engine.tradeIdeasFingerprint(lg(), { myTeamId: '1' }), printBefore,
    'findTrades keys its cache on this fingerprint; lineupSpread prices every deal with the refit correlations');
});

test('findTrades keys its cache on the correlation store it prices spreads with', () => {
  const names = engine.ASSET_INPUT_TABLES.map(t => (typeof t === 'string' ? t : t.table));
  assert.ok(names.includes('correlation_estimates'),
    'findTrades fingerprints ASSET_INPUT_TABLES; lineupSpread reads correlation_estimates inside it');
  const trending = engine.ASSET_INPUT_TABLES.find(t => (typeof t === 'string' ? t : t.table) === 'trending_players');
  assert.equal(trending?.stamp, 'fetched_at', 'the in-place re-sync above changes no row count');
});

// ----------------------------------------------------- one rule per table (S-18 fix)

test('one rule per table: each reader gives the Data Health verdict on the same input; a fit store is judged by coverage, not age', () => {
  const ctx = { currentSeason: 2026, currentWeek: 2 };
  const panel = table => freshness.tableFreshness(freshness.servedTableEntry(table), ctx).status;

  // Correlations fitted ten days ago. The registry's rule (and data-freshness.js's own
  // contract for a fit store) is coverage; S-18's first cut said "stale" after 8 days.
  run(`UPDATE correlation_estimates SET fitted_at = datetime('now', '-10 days')`);
  correlation.clearCorrelationCache();
  assert.equal(panel('correlation_estimates'), 'fresh');
  assert.equal(correlation.correlationBasis().state, panel('correlation_estimates'));
  assert.equal(universe().context.hand_fed.correlation_estimates.state, panel('correlation_estimates'));

  // A snapshot for this season, last changed ten days ago: current by the registry's rule.
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  run('UPDATE league_roster_snapshots SET changed_at = ? WHERE league_id = 70', tenDaysAgo);
  assert.equal(panel('league_roster_snapshots'), 'fresh');
  assert.equal(bluff.declarationCredibility().roster_history.state, panel('league_roster_snapshots'));

  // Known-nonzero disagreement check: the same comparison on a stale trending feed.
  assert.equal(panel('trending_players'), 'stale');
  assert.equal(universe().context.hand_fed.trending_players.state, panel('trending_players'));
});
