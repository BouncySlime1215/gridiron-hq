import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The forecast half of nfl-weather.js (docs/PROFIT_ROADMAP.md 0.5): fetch
// kickoff-hour wind for games still ahead of kickoff, and make sure a
// forecast row never blocks the eventual archive row once the game happens.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weather-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js'); // owns game_lines
const weather = await import('../server/services/nfl-weather.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES
  ('GB','Green Bay Packers','NFC','North'),('CHI','Chicago Bears','NFC','North'),
  ('MIN','Minnesota Vikings','NFC','North'),('DET','Detroit Lions','NFC','North')`);

// A few days out — always inside the 16-day forecast horizon, always future.
const future = new Date(Date.now() + 3 * 86400000);
const gameday = future.toISOString().slice(0, 10);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2026,1,'GB','CHI',1,-3,44,22,'test',datetime('now'),?,'13:00')`, gameday);
// MIN is flagged indoor in STADIUMS — must never get a forecast row.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2026,1,'MIN','DET',1,-2,45,23.5,'test',datetime('now'),?,'13:00')`, gameday);

function mockOpenMeteo(hourlyByHost) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    const host = u.includes('archive-api.open-meteo.com') ? 'archive' : 'forecast';
    return { ok: true, status: 200, json: async () => hourlyByHost[host] };
  };
  return () => { globalThis.fetch = real; };
}

function hourlySeries(startIso, hours, windByHour) {
  const time = [], wind = [], gust = [], precip = [], temp = [];
  for (let i = 0; i < hours; i++) {
    time.push(new Date(new Date(startIso).getTime() + i * 3600000).toISOString().slice(0, 13));
    wind.push(windByHour[i] ?? 10); gust.push((windByHour[i] ?? 10) + 8); precip.push(0); temp.push(15);
  }
  return { hourly: { time, wind_speed_10m: wind, wind_gusts_10m: gust, precipitation: precip, temperature_2m: temp } };
}

test('a forecast is written for an outdoor game ahead of kickoff, and skips the dome entirely', async () => {
  const kickoffIso = `${gameday}T17:00:00Z`;
  const restore = mockOpenMeteo({
    forecast: hourlySeries(`${gameday}T00:00:00Z`, 24, { 17: 27 })
  });
  try {
    const result = await weather.syncForecastWeather();
    assert.equal(result.written, 1, `expected exactly the one outdoor game; got ${JSON.stringify(result)}`);
  } finally { restore(); }

  const gb = weather.gameWeather(2026, 1, 'GB');
  assert.ok(gb, 'GB got a forecast row');
  assert.equal(gb.source, 'open-meteo-forecast');
  assert.equal(gb.wind_kmh, 27);
  assert.equal(weather.gameWeather(2026, 1, 'MIN'), null, 'the dome never gets a forecast row');
});

test('re-running the forecast sync overwrites the same row as the forecast changes', async () => {
  const restore = mockOpenMeteo({ forecast: hourlySeries(`${gameday}T00:00:00Z`, 24, { 17: 41 }) });
  try { await weather.syncForecastWeather(); } finally { restore(); }
  const gb = weather.gameWeather(2026, 1, 'GB');
  assert.equal(gb.wind_kmh, 41, 'the forecast row reflects the latest fetch, not the first one');
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_game_weather WHERE season=2026 AND week=1 AND home='GB'`)[0].n, 1,
    'still exactly one row for this game, not a second one alongside it');
});

test('a forecast row does not block the archive sync once the game is in the past', async () => {
  // Move the game into the past so syncGameWeather will consider it, and give
  // it a real final score's worth of context by simply rewriting gameday.
  run(`UPDATE game_lines SET gameday='2026-08-20', gametime='13:00' WHERE season=2026 AND week=1 AND team='GB'`);
  const restore = mockOpenMeteo({ archive: hourlySeries('2026-08-20T00:00:00Z', 24, { 17: 19 }) });
  try {
    const result = await weather.syncGameWeather({ seasons: [2026] });
    assert.equal(result.written, 1, `the archive sync must still write GB despite its stale forecast row; got ${JSON.stringify(result)}`);
  } finally { restore(); }
  const gb = weather.gameWeather(2026, 1, 'GB');
  assert.equal(gb.source, 'open-meteo-archive', 'the archive row replaces the forecast row for the same game');
  assert.equal(gb.wind_kmh, 19);
});
