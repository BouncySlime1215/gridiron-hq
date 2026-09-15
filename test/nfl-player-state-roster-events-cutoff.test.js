/**
 * Regression coverage for the ingested_at receipt-clock fix in
 * nfl-player-state.js's syncRosterEventsFromNews: when called with a
 * historical `before` cutoff (a replay context, as opposed to the default
 * live/current-only call with no cutoff at all), the news_items query only
 * checked published_at, never ingested_at (this pipeline's own receipt
 * clock -- see server/news/store.js's upsertNormalizedNewsItem, which only
 * advances ingested_at when content genuinely changes). A transaction wire
 * published before the cutoff but not actually ingested until after it is
 * not knowable at that cutoff, and must not be materialized into
 * nfl_player_roster_events for a replay run at that cutoff -- the same class
 * of look-ahead risk already closed in nfl-news-signal.js's
 * playerNewsSignal/teamNewsSignals (created_at).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-player-state-roster-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { syncRosterEventsFromNews } = await import('../server/services/nfl-player-state.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES (951,'ZRE','Zed Roster','AFC','East')`);

let nextPlayerId = 8001, nextNewsId = 7001;
function seedTransaction({ published_at, ingested_at, headline }) {
  const playerId = nextPlayerId++, newsId = nextNewsId++;
  run(`INSERT INTO players (id,name,position) VALUES (?,?,'WR')`, playerId, `Test Player${playerId}`);
  const entities = JSON.stringify({ players: [{ id: playerId, name: `Test Player${playerId}`, confidence: 0.99 }] });
  const reliability = JSON.stringify({ tier: 'official_wire', score: 0.95 });
  run(`INSERT INTO news_items (id,date,team_id,headline,source,source_url,published_at,ingested_at,entities_json,reliability_json)
    VALUES (?,?,?,?,'ESPN Transactions','https://espn.com/x',?,?,?,?)`,
    newsId, published_at.slice(0, 10), 951, headline.replace('Test Player', `Test Player${playerId}`), published_at, ingested_at, entities, reliability);
  return { playerId, newsId };
}

const CUTOFF = '2026-11-02T00:00:00.000Z';

test('syncRosterEventsFromNews with a historical `before` excludes a transaction published before cutoff but ingested after it', () => {
  const { newsId } = seedTransaction({ published_at: '2026-11-01T10:00:00.000Z',
    ingested_at: '2026-11-03T00:00:00.000Z', headline: 'Waived WR Test Player.' });

  syncRosterEventsFromNews({ before: CUTOFF });
  const event = rows(`SELECT * FROM nfl_player_roster_events WHERE news_id=?`, newsId);
  assert.equal(event.length, 0,
    'a transaction not actually ingested by the historical cutoff must not be materialized as knowable at that cutoff');
});

test('syncRosterEventsFromNews with a historical `before` still includes a transaction published AND ingested before cutoff', () => {
  const { newsId } = seedTransaction({ published_at: '2026-11-01T10:00:00.000Z',
    ingested_at: '2026-11-01T10:05:00.000Z', headline: 'Waived WR Test Player.' });

  syncRosterEventsFromNews({ before: CUTOFF });
  const event = rows(`SELECT * FROM nfl_player_roster_events WHERE news_id=?`, newsId);
  assert.equal(event.length, 1,
    'a transaction genuinely ingested before the historical cutoff must still be materialized');
  assert.equal(event[0].event_type, 'waived');
  assert.equal(event[0].roster_status, 'free_agent');
});

test('syncRosterEventsFromNews with no `before` (live/current-only call) still picks up a late-ingested transaction, since there is no cutoff to leak across', () => {
  const { newsId } = seedTransaction({ published_at: '2026-11-01T10:00:00.000Z',
    ingested_at: '2026-11-05T00:00:00.000Z', headline: 'Waived WR Test Player.' });

  syncRosterEventsFromNews();
  const event = rows(`SELECT * FROM nfl_player_roster_events WHERE news_id=?`, newsId);
  assert.equal(event.length, 1,
    'the default no-cutoff call materializes everything up to now regardless of ingested_at timing');
});
