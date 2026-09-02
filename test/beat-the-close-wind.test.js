import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// wind_total (docs/PROFIT_ROADMAP.md 0.5): bet the Under when the forecast
// kickoff-hour wind clears 25 km/h and the total has not already drifted
// down since the opener. Unlike ratings_vs_open[_total], this rule is
// one-directional and reads the raw forecast, not the slate-centered value.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-btc-wind-'));
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

// GB is outdoor in STADIUMS; KC is outdoor; MIN is indoor — used below to
// confirm a dome never produces the signal at all.
run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES
  ('GB','Green Bay Packers','NFC','North'),('CHI','Chicago Bears','NFC','North'),
  ('KC','Kansas City Chiefs','AFC','West'),('DEN','Denver Broncos','AFC','West'),
  ('MIN','Minnesota Vikings','NFC','North'),('DET','Detroit Lions','NFC','North')`);

let eid = 100;
function seedGame(home, away, { totalOpen, totalNow, spreadOpen = -3, spreadNow = -3 }) {
  eid++;
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
       VALUES (2026,1,?,?,1,?,?,?,'test',datetime('now'),'2026-09-13','13:00')`, home, away, spreadOpen, totalOpen, totalOpen / 2);
  run(`INSERT INTO nfl_odds_archive (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
       VALUES (?,2026,1,?,?,'2026-09-13T17:00:01Z','pinnacle','totals','Over','open',?,-110,'2026-05-15T14:00:00Z','test',datetime('now'))`,
  eid, home, away, totalOpen);
  const homeName = rows('SELECT name FROM nfl_teams WHERE abbr=?', home)[0].name;
  const awayName = rows('SELECT name FROM nfl_teams WHERE abbr=?', away)[0].name;
  const at = '2026-09-09T16:00:00Z';
  const snapTotal = side => run(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, at, `nfl:2026-09-13:${away}@${home}`, '2026-09-13T17:00:01Z', homeName, awayName,
  'pinnacle', 'totals', side, totalNow, -110, 'free:pinnacle', at);
  snapTotal('Over'); snapTotal('Under');
  return { home, away, homeName, awayName };
}

function seedWeather(home, windKmh, source = 'open-meteo-forecast') {
  run(`INSERT OR REPLACE INTO nfl_game_weather (season,week,home,kickoff,temp_c,wind_kmh,gust_kmh,precip_mm,source,fetched_at)
       VALUES (2026,1,?,'2026-09-13T17:00:00Z',15,?,?,0,?,datetime('now'))`, home, windKmh, windKmh + 8, source);
}

test('wind at or above threshold, total unmoved: freezes an Under decision', () => {
  seedGame('GB', 'CHI', { totalOpen: 44, totalNow: 44 });
  seedWeather('GB', 28);
  const result = btc.decideBeatTheClose({ season: 2026, week: 1 });
  const wind = result.decisions.find(d => d.signal === 'wind_total');
  assert.ok(wind, `expected a wind_total decision among ${JSON.stringify(result.decisions)}`);
  assert.equal(wind.side, 'Under');
  assert.equal(wind.value, 28);
});

test('wind below threshold: no decision', () => {
  seedGame('KC', 'DEN', { totalOpen: 46, totalNow: 46 });
  seedWeather('KC', 14);
  const result = btc.decideBeatTheClose({ season: 2026, week: 1 });
  assert.ok(!result.decisions.some(d => d.signal === 'wind_total' && d.game === 'DEN at KC'));
});

test('wind is high but the total already moved down since the opener: no decision', () => {
  // Opener 45, now 43.5 — the market has already priced 1.5 points of the wind in.
  // CHI (outdoor, unlike DET's dome) as home, distinct from the other tests' home teams.
  const teams = seedGame('CHI', 'GB', { totalOpen: 45, totalNow: 43.5 });
  seedWeather('CHI', 30);
  const result = btc.decideBeatTheClose({ season: 2026, week: 1 });
  assert.ok(!result.decisions.some(d => d.signal === 'wind_total' && d.game === `${teams.away} at ${teams.home}`),
    'the rule requires the total to NOT have already moved down; betting after the fact is not the measured edge');
});

test('an indoor stadium never produces the wind signal at all, even with a high stored wind value', () => {
  // MIN is flagged indoor in STADIUMS; a stray row (e.g. bad data) must not leak through.
  seedGame('MIN', 'DET', { totalOpen: 44, totalNow: 44, spreadOpen: -2, spreadNow: -2 });
  seedWeather('MIN', 35);
  const signals = btc.signalsFor({ season: 2026, week: 1, home: 'MIN', away: 'DET' });
  assert.ok(!signals.some(s => s.signal === 'wind_forecast_kmh'), 'no wind signal is pushed for a dome');
});

test('the reachable-quote check still applies: no price, no decision, even with a strong wind signal', () => {
  // No totals snapshot at all beyond the opener for this game — bestReachable finds nothing.
  eid++;
  run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES ('BUF','Buffalo Bills','AFC','East'),('NYJ','New York Jets','AFC','East')`);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
       VALUES (2026,1,'BUF','NYJ',1,-3,42,22.5,'test',datetime('now'),'2026-09-13','13:00')`);
  run(`INSERT INTO nfl_odds_archive (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
       VALUES (?,2026,1,'BUF','NYJ','2026-09-13T17:00:01Z','pinnacle','totals','Over','open',42,-110,'2026-05-15T14:00:00Z','test',datetime('now'))`, eid);
  seedWeather('BUF', 30);
  const result = btc.decideBeatTheClose({ season: 2026, week: 1 });
  assert.ok(!result.decisions.some(d => d.game === 'NYJ at BUF'));
  assert.ok(result.no_reachable_price > 0);
});
