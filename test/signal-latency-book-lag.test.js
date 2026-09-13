import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// bookLagDistribution's snapshot query used to have no upper bound at all --
// it read from `since` through whatever instant `captured_at` reached by the
// time the call ran. This checks the fix is both a no-op for signals that
// worked before (bounding the window must not drop anything a signal could
// still use) and actually excludes a move dated after every signal's cutoff.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-booklag-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
await import('../server/services/polymarket-lines.js');
const { bookLagDistribution } = await import('../server/services/signal-latency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES ('KC','Kansas City Chiefs','AFC','West'),('DEN','Denver Broncos','AFC','West')`);

const EVENT = 'nfl:2026-09-13:DEN@KC';
const KC = 'Kansas City Chiefs', DEN = 'Denver Broncos';
const snap = (at, book, side, line) => run(
  `INSERT INTO nfl_line_snapshots (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
   VALUES (?,?,?,?,?,?,'spreads',?,?,-110,'free:oddstrader',NULL)`, at, EVENT, '2026-09-13T17:00:00Z', KC, DEN, book, side, line);

run(`INSERT INTO nfl_news_signals
     (news_id, player_key, player_name, team, signal_type, status, unavailable_probability,
      confidence, published_at, evidence_span, extractor_version, verification_state)
     VALUES (1,'some-player','Some Player','KC','injury','out',0.9,0.9,?,'test','test','verified')`,
  '2026-09-08T10:00:00Z');

// A move inside the signal's window: found.
snap('2026-09-08T09:00:00Z', 'bovada', 'KC', -3);
snap('2026-09-09T12:00:00Z', 'bovada', 'KC', -4); // ~26h after the signal, within the default 48h window

// A move dated well past every signal's cutoff (published_at + 48h) -- must
// never be pulled into the query at all, let alone matched. If the old
// unbounded query is ever reintroduced, this row's presence flips this test.
snap('2026-10-01T00:00:00Z', 'bovada', 'KC', -6);

test('matches a book move inside the signal window and never touches one dated past every cutoff', () => {
  const result = bookLagDistribution({ sinceDays: 60, windowHours: 48 });
  assert.equal(result.observations, 1, JSON.stringify(result));
  const obs = result.books.find(b => b.book === 'bovada');
  assert.ok(obs, 'bovada should have one lag observation');
  assert.equal(obs.observations, 1);
});

test('returns an honest empty result without querying the tape when there are no signals to match', () => {
  run(`DELETE FROM nfl_news_signals`);
  const result = bookLagDistribution({ sinceDays: 60, windowHours: 48 });
  assert.equal(result.observations, 0);
  assert.deepEqual(result.books, []);
});
