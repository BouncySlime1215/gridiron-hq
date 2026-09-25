/**
 * BROKEN-H team keys: counterpartyLayer asks activity-model for `<league>:<roster_id>`
 * with roster ids from `manager_signals`; the activity producer writes
 * `<league>:<team>` with teams from the engine events the backfill makes out of
 * `manager_signals` (team_id = roster_id) and `league_transactions_raw` (ESPN integer
 * toTeamId / fromTeamId). broken-h-checked-out.test.js hand-writes those events with
 * matching ids; this test goes through the real backfill adapters instead, so a key
 * mismatch (e.g. '07' vs '7', or an ESPN id that is not a roster id) shows up as a
 * withheld term.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-broken-h-keys-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';
delete process.env.GRIDIRON_LIVING01A_ENABLED;
delete process.env.GRIDIRON_RECEPTIVENESS_ACTIVITY;

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { backfillStream } = await import('../server/services/engine/backfill.js');
const activity = await import('../server/services/engine/activity-model.js');
const pricing = await import('../server/services/counterparty-pricing.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const L = 92;
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (${L}, 'espn', 'bh-92', 2026, 'Fixture', '1', 3, 1, '{}', '2026-09-18 01:00:00')`);
if (rows('PRAGMA table_info(leagues)').some(c => c.name === 'current_week')) run('UPDATE leagues SET current_week = 3 WHERE id = ?', L);
// Rosters 1, 2 and 10 in manager_signals (TEXT ids, as the signal build writes them).
// 1 and 10 have ESPN adds and a trade (INTEGER ids in items_json); 2 has none, like a
// real roster that has not touched the wire this season.
for (const team of ['1', '2', '10']) {
  run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
       VALUES (?, ?, 'lineup_dead_starts_last_week', 0, 9, 'roster', '2026-09-22 10:00:00')`, L, team);
}
// The Python collector creates this table, not a migration (same shape as the live DB).
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const tx = (id, type, period, at, items, exec = null) => run(`INSERT INTO league_transactions_raw
  (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at, team_id, scoring_period,
   is_pending, items_json, first_seen_at, last_seen_at)
  VALUES (?, 2026, ?, ?, 'EXECUTED', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  L, id, type, exec, at, at, items[0].toTeamId ?? items[0].fromTeamId, period, JSON.stringify(items), at, at);
tx('t1', 'FREEAGENT', 1, '2026-09-09T12:00:00Z', [{ type: 'ADD', playerId: 1001, toTeamId: 1 }]);
tx('t2', 'WAIVER', 2, '2026-09-16T12:00:00Z', [{ type: 'ADD', playerId: 1002, toTeamId: 10 }]);
tx('t3', 'TRADE_ACCEPT', 2, '2026-09-17T12:00:00Z',
  [{ type: 'TRADE', playerId: 1003, fromTeamId: 1, toTeamId: 10 }, { type: 'TRADE', playerId: 1004, fromTeamId: 10, toTeamId: 1 }], 'PROCESS');
run(`INSERT INTO sync_log (job, last_run_at, last_status, runs) VALUES ('league_transactions', '2026-09-22 11:00:00', 'ok', 1)`);

for (const s of ['transactions', 'manager_signals', 'coverage']) backfillStream(s);
await activity.produceActivityStates({ leagueId: L, season: 2026, through: 2, asOf: '2026-09-22T12:00:00Z', weeksLeft: 12 });

test('every manager_signals roster id has an activity.manager row under the same <league>:<team> key', () => {
  const rosters = rows('SELECT DISTINCT roster_id FROM manager_signals WHERE league_id = ?', L).map(r => `${L}:${r.roster_id}`).sort();
  const produced = rows(`SELECT DISTINCT entity_id FROM engine_state WHERE field = 'activity.manager' AND league_id = ?`, L)
    .map(r => r.entity_id).sort();
  assert.deepEqual(produced, rosters);
});

test('under preview counterpartyLayer finds that row for every roster: one checked_out entry, none withheld', () => {
  const old = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    const layer = pricing.counterpartyLayer(L, { season: 2026, week: 3 });
    assert.equal(layer.size, 3);
    for (const [team, v] of layer) {
      const c = v.receptiveness_factors.filter(f => f.source === 'checked_out');
      assert.equal(c.length, 1, `roster ${team}`);
      assert.equal(c[0].engine?.field, 'activity.manager', `roster ${team}`);
      assert.ok(Number.isFinite(c[0].effect), `roster ${team} withheld: ${c[0].why}`);
    }
  } finally {
    if (old == null) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = old;
  }
});
