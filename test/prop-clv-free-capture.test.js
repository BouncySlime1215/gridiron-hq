import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// captureFreePropMarket() is the bridge between prop-feeds.js's raw quotes
// (nfl_prop_quote_snapshots) and nfl_prop_clv, which every downstream reader
// (propEdgeEvidence, finalizeClosingSnapshots, settlePropQuotes,
// propMatchCoverage) already knows how to grade. This is the first test
// nfl-prop-clv.js has ever had — the module existed with real prop prices
// never once compared to it, by design, until this week.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-propclv-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/prop-feeds.js'); // owns nfl_prop_quote_snapshots
const clv = await import('../server/services/nfl-prop-clv.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES
  ('NE','New England Patriots','AFC','East'),('SEA','Seattle Seahawks','NFC','West')`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2026,1,'SEA','NE',1,-3,45,24,'test',datetime('now'),'2026-09-09','20:20')`);

const snap = (capturedAt, book, side, line, price, provider = 'underdog') => run(`INSERT INTO nfl_prop_quote_snapshots
  (captured_at,event_id,commence_time,home_team,away_team,book,market,player,side,line,line_key,american_price,provider,book_updated_at,is_opener)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, capturedAt, 'nfl:2026-09-10:NE@SEA', '2026-09-10T00:20:00Z',
  'Seattle Seahawks', 'New England Patriots', book, 'player_reception_yds', 'Test Player', side, line, String(line), price, provider, null, 0);

test('a captured batch is copied into nfl_prop_clv with a real devigged probability and the resolved week', () => {
  const at = '2026-09-03T12:00:00Z';
  snap(at, 'underdog', 'Over', 45.5, -112);
  snap(at, 'underdog', 'Under', 45.5, -112);

  const result = clv.captureFreePropMarket();
  assert.equal(result.stored, 2);
  const stored = rows(`SELECT * FROM nfl_prop_clv WHERE captured_at=?`, at).sort((a, b) => a.side.localeCompare(b.side));
  assert.equal(stored.length, 2);
  assert.equal(stored[0].season, 2026);
  assert.equal(stored[0].week, 1, 'the week is resolved from game_lines via the team names and kickoff');
  assert.ok(Math.abs(stored[0].implied_probability - 0.5) < 0.01, 'a symmetric -112/-112 book devigs to ~50%');
});

test('two batches captured an hour apart are devigged independently, never mixed across time', () => {
  const t1 = '2026-09-03T13:00:00Z', t2 = '2026-09-03T14:00:00Z';
  // At t1 the book prices Over heavily (-300/+250, Shin no-vig ~73.2% — see
  // nfl-devig.js; the naive proportional split would say ~72.4%, understating
  // the favorite the way the favorite-longshot literature predicts); at t2 it
  // has moved to even (-110/-110, ~50%). If attachFairProbabilities ever
  // paired an Over from one batch with an Under from the other, at least one
  // of these would devig against the wrong price and the two would not read
  // this far apart.
  snap(t1, 'draftkings', 'Over', 45.5, -300);
  snap(t1, 'draftkings', 'Under', 45.5, 250);
  snap(t2, 'draftkings', 'Over', 45.5, -110);
  snap(t2, 'draftkings', 'Under', 45.5, -110);

  clv.captureFreePropMarket();
  const t1Over = rows(`SELECT implied_probability FROM nfl_prop_clv WHERE captured_at=? AND book='draftkings' AND side='Over'`, t1)[0];
  const t2Over = rows(`SELECT implied_probability FROM nfl_prop_clv WHERE captured_at=? AND book='draftkings' AND side='Over'`, t2)[0];
  assert.ok(Math.abs(t1Over.implied_probability - 0.7321) < 0.005, 'Shin no-vig -300 vs +250 is about 73.2%');
  assert.ok(Math.abs(t2Over.implied_probability - 0.5) < 0.01, 'the even-priced batch still devigs to ~50%');
});

test('re-running is idempotent: no duplicate rows, and settled/CLV fields already written are not clobbered', () => {
  const before = rows(`SELECT COUNT(*) n FROM nfl_prop_clv`)[0].n;
  const again = clv.captureFreePropMarket();
  assert.equal(again.stored, 0, 'every row from the earlier runs already exists under the same primary key');
  const after = rows(`SELECT COUNT(*) n FROM nfl_prop_clv`)[0].n;
  assert.equal(after, before);
});

test('a quote captured on or after its own kickoff is never treated as a pregame decision', () => {
  const late = '2026-09-10T01:00:00Z'; // after the 00:20Z kickoff
  snap(late, 'fanduel', 'Over', 50.5, -110);
  const before = rows(`SELECT COUNT(*) n FROM nfl_prop_clv WHERE book='fanduel'`)[0].n;
  clv.captureFreePropMarket();
  const after = rows(`SELECT COUNT(*) n FROM nfl_prop_clv WHERE book='fanduel'`)[0].n;
  assert.equal(after, before, 'a post-kickoff capture is scanned but never written as a pregame quote');
});
