import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import * as setupMigration from '../server/migrations/013_espn_live_draft_setup.js';
import * as boardMigration from '../server/migrations/014_espn_authoritative_board.js';
import * as syncMigration from '../server/migrations/015_espn_durable_sync.js';

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE leagues (id INTEGER PRIMARY KEY);
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      team_count INTEGER, rounds INTEGER, status TEXT, league_row_id INTEGER,
      FOREIGN KEY (league_row_id) REFERENCES leagues(id)
    );
    CREATE TABLE players (id INTEGER PRIMARY KEY);
    CREATE TABLE draft_picks (
      id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL, pick_number INTEGER NOT NULL,
      team_slot INTEGER NOT NULL, player_id INTEGER NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(id)
    );
    INSERT INTO users VALUES (1);
    INSERT INTO leagues VALUES (10);
    INSERT INTO drafts VALUES (100,'ESPN','live',2,2,'active',10);
    INSERT INTO drafts VALUES (200,'Untouched mock','mock',8,4,'active',10);
  `);
  return db;
}

test('Phase 3 additive migrations backfill only linked live drafts and persist recovery state', () => {
  const db = legacyDatabase();
  try {
    setupMigration.up(db);
    boardMigration.up(db);
    db.prepare(`UPDATE drafts SET espn_league_id='4242', season=2026,
      last_synced_at='2026-08-25 12:00:00', espn_snapshot_pick_count=1,
      espn_board_revision=3 WHERE id=100`).run();
    syncMigration.up(db);

    assert.deepEqual(db.prepare(`SELECT draft_id,health_state,last_success_at,retry_status
      FROM espn_draft_sync_state`).all().map(value => ({ ...value })), [{
      draft_id: 100, health_state: 'healthy',
      last_success_at: '2026-08-25 12:00:00', retry_status: 'ready'
    }]);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM espn_draft_sync_state WHERE draft_id=200`).get().n, 0);
    assert.deepEqual({ ...db.prepare(`SELECT name,type,team_count,rounds,status,league_row_id
      FROM drafts WHERE id=200`).get() }, {
      name: 'Untouched mock', type: 'mock', team_count: 8, rounds: 4,
      status: 'active', league_row_id: 10
    });
    assert.throws(() => db.prepare(`UPDATE espn_draft_sync_state SET health_state='invented'
      WHERE draft_id=100`).run(), /CHECK constraint/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('Phase 3 sync migration rollback removes only its additive recovery table', () => {
  const db = legacyDatabase();
  try {
    setupMigration.up(db);
    boardMigration.up(db);
    syncMigration.up(db);
    syncMigration.down(db);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM sqlite_master
      WHERE type='table' AND name='espn_draft_sync_state'`).get().n, 0);
    assert.equal(db.prepare(`SELECT name FROM drafts WHERE id=200`).get().name, 'Untouched mock');
    assert.ok(db.prepare(`PRAGMA table_info(drafts)`).all().some(column => column.name === 'espn_board_revision'));
  } finally {
    db.close();
  }
});
