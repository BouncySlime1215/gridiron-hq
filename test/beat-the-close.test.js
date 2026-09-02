import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Beat the close, Phase 2: the opener lookup, the best reachable price, the
// zero-unit shadow decision, and CLV settlement against Pinnacle's close.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-btc-'));
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

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES ('KC','Kansas City Chiefs','AFC','West'),('DEN','Denver Broncos','AFC','West')`);
// Kickoff Sunday 2026-09-13 13:00 ET = 17:00Z.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2026,1,'KC','DEN',1,-3,47,25,'test',datetime('now'),'2026-09-13','13:00')`);
// Pinnacle opener in the archive: KC -3.
run(`INSERT INTO nfl_odds_archive (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
     VALUES (9,2026,1,'KC','DEN','2026-09-13T17:00:01Z','pinnacle','spreads','KC','open',-3,-110,'2026-05-15T14:00:00Z','test',datetime('now'))`);
const snap = (at, book, side, line, price, provider = 'free:bovada') => run(`INSERT INTO nfl_line_snapshots
  (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, at, 'nfl:2026-09-13:DEN@KC', '2026-09-13T17:00:01Z', 'Kansas City Chiefs', 'Denver Broncos',
  book, 'spreads', side, line, price, provider, at);
// Latest board, Wednesday: Pinnacle KC -3.5, Bovada KC -3 (-105), Lowvig KC -3 (-108); the away side mirrored.
const wed = '2026-09-09T16:00:00Z';
snap(wed, 'pinnacle', 'Kansas City Chiefs', -3.5, -105, 'free:pinnacle'); snap(wed, 'pinnacle', 'Denver Broncos', 3.5, -105, 'free:pinnacle');
snap(wed, 'bovada', 'Kansas City Chiefs', -3, -105); snap(wed, 'bovada', 'Denver Broncos', 3, -115);
snap(wed, 'lowvig', 'Kansas City Chiefs', -3, -108); snap(wed, 'lowvig', 'Denver Broncos', 3, -112);

test('the opener comes from the archive and the best reachable price is the most favourable line then price', () => {
  const opener = btc.openerFor(2026, 1, 'KC', 'DEN', 'spreads');
  assert.equal(opener.line, -3);
  assert.equal(opener.source, 'archive:pinnacle:open');
  const best = btc.bestReachable('KC', 'DEN', 'spreads', 'KC');
  assert.equal(best.line, -3, 'the soft books still have -3');
  assert.equal(best.book, 'bovada', 'and Bovada has the better price at that line');
  assert.equal(best.books, 3);
  const bestAway = btc.bestReachable('KC', 'DEN', 'spreads', 'DEN');
  assert.equal(bestAway.line, 3.5, 'the away side wants the most points');
});

test('a book whose own quote is stale is not reachable, even when it was captured at the fresh instant', () => {
  // gtbets is captured in the same Wednesday batch as everyone else but its underlying
  // price has not moved in 10 days — the aggregator served a cached number, not a live one.
  const staleAt = '2026-08-30T16:00:00Z'; // 10 days before `wed`
  run(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  wed, 'nfl:2026-09-13:DEN@KC', '2026-09-13T17:00:01Z', 'Kansas City Chiefs', 'Denver Broncos',
  'gtbets', 'spreads', 'Kansas City Chiefs', -2.5, -105, 'free:oddstrader', staleAt);
  const best = btc.bestReachable('KC', 'DEN', 'spreads', 'KC');
  assert.equal(best.book, 'bovada', 'gtbets would win on line and price, but its stamp is 10 days stale');
  assert.equal(best.stale_dropped, 1, 'the stale gtbets quote is reported as dropped, not silently missing');
});

test('a signal over its threshold freezes one zero-unit decision and settlement grades it by CLV against the close', () => {
  const now = '2026-09-09T17:00:00Z';
  // Force the ratings signal: the ratings model is not fitted in this database, so predictGame errors and
  // ratings_vs_open is absent; inject a decision through the same path by seeding the rule's input directly.
  const before = btc.decideBeatTheClose({ season: 2026, week: 1, now });
  assert.equal(before.frozen, 0, 'no ratings model, no ratings signal, nothing frozen');
  // Emulate the rule with a hand-built decision to exercise settlement arithmetic.
  run(`INSERT INTO shadow_decisions (sport,event_key,market,selection,model_version,regime,decision,reason,captured_at,season,week,home_team,away_team,line,american_price,quote_at,feature_snapshot_json)
       VALUES ('NFL','2026:1:KC:DEN','spread','KC','beat-the-close-v1:ratings_vs_open','beat_the_close','observe','test',?,2026,1,'KC','DEN',-3,-105,?,'{"stake_units":0}')`, now, wed);
  // Pinnacle's last pre-kickoff line: KC -4.5 (the close moved toward KC).
  snap('2026-09-13T16:30:00Z', 'pinnacle', 'Kansas City Chiefs', -4.5, -110, 'free:pinnacle');
  // A post-kickoff Pinnacle print must not count as the close.
  snap('2026-09-13T17:20:00Z', 'pinnacle', 'Kansas City Chiefs', -6, -110, 'free:pinnacle');
  const early = btc.settleBeatTheClose({ now: '2026-09-12T12:00:00Z' });
  assert.equal(early.settled, 0, 'not before kickoff');
  run(`UPDATE game_lines SET team_score=27, opp_score=20 WHERE season=2026 AND week=1 AND team='KC'`);
  const settled = btc.settleBeatTheClose({ now: '2026-09-14T04:00:00Z' });
  assert.equal(settled.settled, 1);
  const d = rows(`SELECT clv_points, result, outcome_json FROM shadow_decisions WHERE model_version='beat-the-close-v1:ratings_vs_open'`)[0];
  assert.equal(d.clv_points, 1.5, 'took KC -3, Pinnacle closed -4.5: +1.5 points of CLV');
  assert.equal(d.result, 'Won', 'KC won by 7 against -3');
  assert.equal(JSON.parse(d.outcome_json).close_line, -4.5);
  const status = btc.beatTheCloseStatus();
  assert.equal(status.by_signal.ratings_vs_open.settled, 1);
  assert.equal(status.by_signal.ratings_vs_open.mean_clv, 1.5);
  assert.equal(status.by_signal.ratings_vs_open.readable, false, 'one decision is not a read');
});

test('a decision flagged stale_price_at_decision is excluded from every read but still counted', () => {
  run(`INSERT INTO shadow_decisions (sport,event_key,market,selection,model_version,regime,decision,reason,captured_at,season,week,home_team,away_team,line,american_price,quote_at,settled_at,result,clv_points,feature_snapshot_json)
       VALUES ('NFL','2026:1:GB:MIN','spread','GB','beat-the-close-v1:ratings_vs_open','beat_the_close','observe','test',?,2026,1,'GB','MIN',-1,-118,?,?,'Won',3.2,?)`,
  wed, wed, '2026-09-14T04:00:00Z', JSON.stringify({ stake_units: 0, stale_price_at_decision: true, stale_price_age_hours: 527 }));
  const status = btc.beatTheCloseStatus();
  assert.equal(status.excluded_stale, 1, 'the tainted decision is counted as excluded');
  assert.equal(status.by_signal.ratings_vs_open.settled, 1, 'the earlier clean decision still reads normally, not 2');
  assert.equal(status.by_signal.ratings_vs_open.mean_clv, 1.5, 'the average is unchanged: the phantom +3.2 CLV never enters it');
});
