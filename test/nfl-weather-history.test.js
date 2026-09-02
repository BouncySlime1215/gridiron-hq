import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// nfl-weather-history.js: the kickoff-hour wind FORECAST as it stood N days out,
// from Open-Meteo's previous-runs endpoint, one row per lead per past outdoor game.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weather-history-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js'); // owns game_lines
const history = await import('../server/services/nfl-weather-history.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// GB @ Lambeau, outdoors, well in the past (13:00 ET = 18:00Z in November).
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,roof)
     VALUES (2024,11,'GB','CHI',1,-3,44,22,'test',datetime('now'),'2024-11-17','13:00','outdoors')`);
// MIN is a dome in STADIUMS — must never be fetched even with a permissive roof value.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,roof)
     VALUES (2024,11,'MIN','DET',1,-2,45,23.5,'test',datetime('now'),'2024-11-17','13:00',NULL)`);
// A game still ahead of kickoff has no forecast history yet.
const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,roof)
     VALUES (2024,12,'CHI','GB',1,1,43,21,'test',datetime('now'),?,'13:00','outdoors')`, future);

function previousRunsPayload(day, hour, values) {
  const time = [], series = {};
  for (let i = 0; i < 24; i++) time.push(`${day}T${String(i).padStart(2, '0')}:00`);
  for (const [key, value] of Object.entries(values)) {
    series[key] = time.map((_, i) => (i === hour ? value : 5));
  }
  return { hourly: { time, ...series } };
}

function mockFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return handler(String(url)); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const leadValues = {
  wind_speed_10m: 12.7, wind_speed_10m_previous_day1: 8, wind_speed_10m_previous_day2: 11.9,
  wind_speed_10m_previous_day3: 13.5, wind_speed_10m_previous_day5: 21.4,
  wind_gusts_10m: 14.8, wind_gusts_10m_previous_day2: 20.9,
  precipitation: 0, precipitation_previous_day2: 0.3,
  temperature_2m: 10.8, temperature_2m_previous_day2: 9.1
  // gust/precip/temp for leads 1, 3, 5 deliberately absent → must be stored as NULL
};

test('sync writes one row per lead for the past outdoor game and skips the dome and the future game', async () => {
  const { calls, restore } = mockFetch(url => {
    assert.ok(url.startsWith('https://previous-runs-api.open-meteo.com/v1/forecast?'), `previous-runs is the target endpoint: ${url}`);
    assert.ok(url.includes('start_date=2024-11-17&end_date=2024-11-17'), 'asks for the kickoff day only');
    return { ok: true, status: 200, json: async () => previousRunsPayload('2024-11-17', 18, leadValues) };
  });
  let result;
  try { result = await history.syncForecastHistory({ seasons: [2024] }); } finally { restore(); }
  assert.equal(result.written, 1, `only GB should be fetched; got ${JSON.stringify(result)}`);
  assert.equal(result.skipped, 2, 'the dome and the future game are both skipped');
  assert.equal(result.failure_count, 0);
  assert.equal(calls.length, 1, 'one request per game, all leads in that request');

  const gb = rows(`SELECT * FROM nfl_game_weather_forecast_history WHERE season=2024 AND week=11 AND home='GB' ORDER BY lead_days`);
  assert.deepEqual(gb.map(r => r.lead_days), [0, 1, 2, 3, 5]);
  assert.deepEqual(gb.map(r => r.wind_kmh), [12.7, 8, 11.9, 13.5, 21.4]);
  assert.equal(gb[2].gust_kmh, 20.9);
  assert.equal(gb[2].precip_mm, 0.3);
  assert.equal(gb[2].temp_c, 9.1);
  assert.equal(gb[1].gust_kmh, null, 'a lead the payload does not carry is NULL, not 0');
  assert.equal(gb[0].kickoff, '2024-11-17T18:00:00.000Z');
  assert.ok(gb.every(r => r.source === 'open-meteo-previous-runs'));
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_game_weather_forecast_history WHERE home IN ('MIN','CHI')`)[0].n, 0);

  assert.deepEqual(history.forecastHistoryFeatures(2024, 11, 'GB'), {
    wind_kmh_lead5: 21.4, wind_kmh_lead3: 13.5, wind_kmh_lead2: 11.9, wind_kmh_lead1: 8, wind_kmh_lead0: 12.7,
    gust_kmh_lead2: 20.9, precip_mm_lead2: 0.3
  });
});

test('a second run is resumable: the stored game is skipped and nothing is fetched', async () => {
  const { calls, restore } = mockFetch(() => { throw new Error('network must not be touched'); });
  let result;
  try { result = await history.syncForecastHistory({ seasons: [2024] }); } finally { restore(); }
  assert.equal(calls.length, 0);
  assert.equal(result.written, 0);
  assert.equal(result.skipped, 3);
  assert.equal(result.failure_count, 0);
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_game_weather_forecast_history`)[0].n, 5, 'still exactly five lead rows');
});

test('features are all null for an unknown game, never 0', () => {
  const f = history.forecastHistoryFeatures(2023, 1, 'BUF');
  assert.deepEqual(Object.keys(f).sort(), ['gust_kmh_lead2', 'precip_mm_lead2', 'wind_kmh_lead0', 'wind_kmh_lead1', 'wind_kmh_lead2', 'wind_kmh_lead3', 'wind_kmh_lead5']);
  assert.ok(Object.values(f).every(v => v === null), JSON.stringify(f));
});

test('a previous-runs failure falls back to the historical-forecast endpoint for lead 0 and a failed game is isolated', async () => {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,roof)
       VALUES (2023,1,'BUF','MIA',1,-4,48,26,'test',datetime('now'),'2023-09-10','13:00','outdoors')`);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,roof)
       VALUES (2023,1,'NYJ','NE',1,-1,40,20.5,'test',datetime('now'),'2023-09-10','13:00','outdoors')`);
  const { restore } = mockFetch(url => {
    if (url.includes('latitude=40.8135')) throw new Error('socket hang up'); // NYJ: both endpoints down
    if (url.startsWith('https://previous-runs-api.')) return { ok: false, status: 500, json: async () => ({}) };
    assert.ok(url.startsWith('https://historical-forecast-api.open-meteo.com/v1/forecast?'), url);
    return { ok: true, status: 200, json: async () => previousRunsPayload('2023-09-10', 17, { wind_speed_10m: 9.8, wind_gusts_10m: 18.7, precipitation: 0, temperature_2m: 20.5 }) };
  });
  let result;
  try { result = await history.syncForecastHistory({ seasons: [2023] }); } finally { restore(); }
  assert.equal(result.written, 1, JSON.stringify(result));
  assert.equal(result.failure_count, 1);
  assert.equal(result.failures[0].game, '2023 W1 NYJ');
  const buf = rows(`SELECT * FROM nfl_game_weather_forecast_history WHERE season=2023 AND home='BUF'`);
  assert.equal(buf.length, 1, 'the fallback only knows lead 0');
  assert.equal(buf[0].lead_days, 0);
  assert.equal(buf[0].wind_kmh, 9.8);
  assert.equal(buf[0].source, 'open-meteo-historical-forecast');
  assert.deepEqual(history.forecastHistoryFeatures(2023, 1, 'BUF'), {
    wind_kmh_lead5: null, wind_kmh_lead3: null, wind_kmh_lead2: null, wind_kmh_lead1: null, wind_kmh_lead0: 9.8,
    gust_kmh_lead2: null, precip_mm_lead2: null
  });
  assert.equal(history.forecastHistoryStatus().by_season.find(s => s.season === 2023).games, 1);
});
