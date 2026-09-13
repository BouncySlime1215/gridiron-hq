import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// u3-beat-the-close: settlement's Pinnacle-near-kickoff requirement, widened.
// Reproduces, on a fixture, the exact live-data failure this fixes: a game
// whose only pre-kickoff Pinnacle capture (or archived "close" row) is far
// from kickoff still settles, flagged, instead of sitting in `waiting`
// forever — and a line too stale to trust at all still refuses to settle.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-btc-fallback-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
await import('../server/services/odds-archive.js');
await import('../server/services/shadow-ledger.js');
const btc = await import('../server/services/beat-the-close.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES
  ('CAR','Carolina Panthers','NFC','South'),('CHI','Chicago Bears','NFC','North'),
  ('JAX','Jacksonville Jaguars','AFC','South'),('CLE','Cleveland Browns','AFC','North'),
  ('DET','Detroit Lions','NFC','North'),('NO','New Orleans Saints','NFC','South')`);

function seedGame(home, away, gameday, gametime) {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
       VALUES (2026,1,?,?,1,-3,47,25,'test',datetime('now'),?,?)`, home, away, gameday, gametime);
}
function decision(id, home, away, market, line) {
  run(`INSERT INTO shadow_decisions (sport,event_key,market,selection,model_version,regime,decision,reason,captured_at,season,week,home_team,away_team,line,american_price,quote_at,feature_snapshot_json)
       VALUES ('NFL',?,?,?,'beat-the-close-v1.1:ratings_vs_open','beat_the_close','observe','test','2026-09-01T00:00:00Z',2026,1,?,?,?,-110,'2026-09-01T00:00:00Z','{"stake_units":0}')`,
  `2026:1:${home}:${away}`, market, home, home, away, line);
}
const FULL_NAME = { CAR: 'Carolina Panthers', CHI: 'Chicago Bears', JAX: 'Jacksonville Jaguars',
  CLE: 'Cleveland Browns', DET: 'Detroit Lions', NO: 'New Orleans Saints' };

function liveSnap(at, home, away, homeLine) {
  // nfl_line_snapshots stores full team names (matching nfl_teams.name via teamNames()
  // in beat-the-close.js), not abbreviations — the same convention the archive uses abbrs for.
  const homeName = FULL_NAME[home], awayName = FULL_NAME[away];
  run(`INSERT INTO nfl_line_snapshots (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
       VALUES (?,?,?,?,?,'pinnacle','spreads',?,?,-110,'free:pinnacle',?)`,
  at, `nfl:test:${home}`, '2026-09-13T17:00:00Z', homeName, awayName, homeName, homeLine, at);
}
function archivedClose(home, away, homeLine, bookUpdatedAt) {
  run(`INSERT INTO nfl_odds_archive (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
       VALUES (?,2026,1,?,?,?,'pinnacle','spreads',?,'close',?,-110,?,'test',datetime('now'))`,
  `${home}-${away}-close`, home, away, '2026-09-13T17:00:00Z', home, homeLine, bookUpdatedAt);
}

// CAR/CHI, kickoff 2026-09-13T17:00:00Z: Pinnacle's last live capture is 40h
// before kickoff (well past NEAR_KICKOFF_HOURS, well inside STALE_BOOK_HOURS),
// and no closer archived close row exists.
seedGame('CAR', 'CHI', '2026-09-13', '13:00');
liveSnap('2026-09-12T01:00:00Z', 'CAR', 'CHI', -3.5); // 40h before kickoff
decision(1, 'CAR', 'CHI', 'spread', -3);

// JAX/CLE, same kickoff: NO live capture at all before kickoff, and the only
// archived "close" row is a 100-day-old preseason sync — reproduces the real
// 2026 week 1 archive rows found in server/data.sqlite (197h-2,491h gaps).
seedGame('JAX', 'CLE', '2026-09-13', '13:00');
archivedClose('JAX', 'CLE', -8, '2026-06-01T22:20:47.000Z');
decision(2, 'JAX', 'CLE', 'spread', -8);

run(`UPDATE game_lines SET team_score=24, opp_score=17 WHERE team='CAR' AND season=2026 AND week=1`);
run(`UPDATE game_lines SET team_score=20, opp_score=13 WHERE team='JAX' AND season=2026 AND week=1`);

test('a 40h-stale Pinnacle capture settles the widened window, flagged as a fallback, not a real close', () => {
  const result = btc.settleBeatTheClose({ now: '2026-09-14T04:00:00Z' });
  const d = rows(`SELECT settled_at, clv_points, outcome_json FROM shadow_decisions WHERE id=1`)[0];
  assert.ok(d.settled_at, 'settles instead of waiting forever for a quote that will never get closer');
  assert.equal(d.clv_points, 0.5, 'took CAR -3, best-available close -3.5: +0.5 CLV');
  const outcome = JSON.parse(d.outcome_json);
  assert.equal(outcome.close_source, 'free:pinnacle:fallback-window');
  assert.equal(outcome.close_is_fallback, true, 'never silently equivalent to a real kickoff-time quote');
  assert.match(outcome.close_fallback_reason, /40(\.0)?h/, 'the actual gap is recorded, not just a boolean');
  assert.ok(result.settled >= 1);
});

test('a 100-day-old archived "close" row (no live capture at all) still settles, flagged, from the widened window', () => {
  const d = rows(`SELECT settled_at, outcome_json FROM shadow_decisions WHERE id=2`)[0];
  assert.equal(d.settled_at, null, 'a gap this large (2,400h) is past STALE_BOOK_HOURS — refuses rather than settling against a preseason line');
});

test('beatTheCloseStatus surfaces the fallback flag on the settled decision, not just in outcome_json', () => {
  const status = btc.beatTheCloseStatus();
  const row = status.decisions.find(d => d.id === 1);
  assert.equal(row.close_is_fallback, true);
  assert.ok(row.close_fallback_reason);
  assert.equal(row.outcome_json, undefined, 'the raw JSON blob is stripped the same way feature_snapshot_json is');
});

test('pinnacleLineAt refuses (returns null) once the best candidate is older than STALE_BOOK_HOURS from kickoff', () => {
  const line = btc.pinnacleLineAt(2026, 1, 'JAX', 'CLE', 'spreads', '2026-09-13T17:00:00.000Z');
  assert.equal(line, null);
});

test('pinnacleLineAt picks whichever candidate — live or archived — is actually nearer to kickoff', () => {
  // DET/NO: a live capture 40h before kickoff AND an archived close row only 2h before it —
  // the old code always preferred "any live row" first, so it would have used the 40h-stale
  // capture unflagged even though the archive is the far better (and, at 2h, genuinely tight) candidate.
  seedGame('DET', 'NO', '2026-09-13', '13:00');
  liveSnap('2026-09-12T01:00:00Z', 'DET', 'NO', -6.5); // 40h before kickoff
  archivedClose('DET', 'NO', -7, '2026-09-13T15:00:00.000Z'); // 2h before kickoff
  const line = btc.pinnacleLineAt(2026, 1, 'DET', 'NO', 'spreads', '2026-09-13T17:00:00.000Z');
  assert.equal(line.line, -7, 'the archived row, not the older live capture');
  assert.equal(line.source, 'archive:pinnacle:close', 'within NEAR_KICKOFF_HOURS — a genuine close, not just a fallback');
  assert.equal(line.is_fallback, false);
});
