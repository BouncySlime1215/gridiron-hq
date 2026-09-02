/**
 * Kickoff-hour weather for outdoor games from Open-Meteo's free archive
 * (NEXT_SESSION_PLAN 3d). nflverse carries one coarse `temp`/`wind` per
 * game; the archive gives the hour's wind, gusts, precipitation and
 * temperature at the stadium. Stadium coordinates are embedded (current
 * venues; every 2022+ home is covered). Neutral-site and indoor games are
 * skipped, never guessed.
 */
import { db, rows, run } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';

export const NFL_WEATHER_VERSION = 'nfl-weather-open-meteo-v1';

/** Current home stadiums, WGS84. Domes are listed so a wrong roof flag cannot fetch weather for them. */
export const STADIUMS = Object.freeze({
  ARI: { lat: 33.5276, lon: -112.2626, indoor: true }, ATL: { lat: 33.7554, lon: -84.4010, indoor: true },
  BAL: { lat: 39.2780, lon: -76.6227 }, BUF: { lat: 42.7738, lon: -78.7870 }, CAR: { lat: 35.2258, lon: -80.8528 },
  CHI: { lat: 41.8623, lon: -87.6167 }, CIN: { lat: 39.0954, lon: -84.5160 }, CLE: { lat: 41.5061, lon: -81.6995 },
  DAL: { lat: 32.7473, lon: -97.0945, indoor: true }, DEN: { lat: 39.7439, lon: -105.0201 }, DET: { lat: 42.3400, lon: -83.0456, indoor: true },
  GB: { lat: 44.5013, lon: -88.0622 }, HOU: { lat: 29.6847, lon: -95.4107, indoor: true }, IND: { lat: 39.7601, lon: -86.1639, indoor: true },
  JAX: { lat: 30.3239, lon: -81.6373 }, KC: { lat: 39.0489, lon: -94.4839 }, LV: { lat: 36.0909, lon: -115.1833, indoor: true },
  LAC: { lat: 33.9535, lon: -118.3392, indoor: true }, LAR: { lat: 33.9535, lon: -118.3392, indoor: true }, MIA: { lat: 25.9580, lon: -80.2389 },
  MIN: { lat: 44.9736, lon: -93.2575, indoor: true }, NE: { lat: 42.0909, lon: -71.2643 }, NO: { lat: 29.9511, lon: -90.0812, indoor: true },
  NYG: { lat: 40.8135, lon: -74.0745 }, NYJ: { lat: 40.8135, lon: -74.0745 }, PHI: { lat: 39.9008, lon: -75.1675 },
  PIT: { lat: 40.4468, lon: -80.0158 }, SF: { lat: 37.4032, lon: -121.9698 }, SEA: { lat: 47.5952, lon: -122.3316 },
  TB: { lat: 27.9759, lon: -82.5033 }, TEN: { lat: 36.1665, lon: -86.7713 }, WAS: { lat: 38.9076, lon: -76.8645 }
});

db.exec(`CREATE TABLE IF NOT EXISTS nfl_game_weather (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL,
  kickoff TEXT NOT NULL, temp_c REAL, wind_kmh REAL, gust_kmh REAL, precip_mm REAL,
  source TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, home)
)`);

function outdoorGames(seasons) {
  return rows(`SELECT season,week,team home,gameday,gametime,roof,neutral_site FROM game_lines
    WHERE home=1 AND gameday IS NOT NULL AND season IN (${seasons.map(() => '?').join(',')})
      AND (roof IS NULL OR roof IN ('outdoors','open')) AND COALESCE(neutral_site,0)=0
    ORDER BY season,week,team`, ...seasons);
}

async function hourAt(lat, lon, kickoffIso) {
  const day = kickoffIso.slice(0, 10);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}` +
    '&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation&timezone=UTC';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const hour = kickoffIso.slice(0, 13);
  const idx = (j.hourly?.time ?? []).findIndex(t => t.startsWith(hour));
  if (idx < 0) return null;
  const pick = key => (Number.isFinite(j.hourly[key]?.[idx]) ? j.hourly[key][idx] : null);
  return { temp_c: pick('temperature_2m'), wind_kmh: pick('wind_speed_10m'), gust_kmh: pick('wind_gusts_10m'), precip_mm: pick('precipitation') };
}

/** Fetch kickoff-hour weather for every outdoor, non-neutral game not already stored. */
export async function syncGameWeather({ seasons = [2022, 2023, 2024, 2025], pauseMs = 150, onProgress = null } = {}) {
  const games = outdoorGames(seasons);
  // Only a real archive row (the game already happened) should block a re-fetch —
  // a forecast row (source='open-meteo-forecast', written for a game still ahead of
  // kickoff) must not survive past kickoff; this is what lets the forecast get
  // replaced by what actually happened once the archive has it.
  const have = new Set(rows(`SELECT season, week, home FROM nfl_game_weather WHERE source='open-meteo-archive'`)
    .map(r => `${r.season}|${r.week}|${r.home}`));
  let written = 0, skipped = 0;
  const failures = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (have.has(`${g.season}|${g.week}|${g.home}`)) { skipped++; continue; }
    const stadium = STADIUMS[g.home];
    if (!stadium || stadium.indoor) { skipped++; continue; }
    const kickoff = nflKickoffDate(g.gameday, g.gametime || '13:00')?.toISOString();
    if (!kickoff || kickoff > new Date().toISOString()) { skipped++; continue; }
    try {
      const w = await hourAt(stadium.lat, stadium.lon, kickoff);
      if (!w) { failures.push({ game: `${g.season} W${g.week} ${g.home}`, error: 'hour missing' }); continue; }
      run(`INSERT OR REPLACE INTO nfl_game_weather (season,week,home,kickoff,temp_c,wind_kmh,gust_kmh,precip_mm,source,fetched_at)
           VALUES (?,?,?,?,?,?,?,?,'open-meteo-archive',datetime('now'))`, g.season, g.week, g.home, kickoff, w.temp_c, w.wind_kmh, w.gust_kmh, w.precip_mm);
      written++;
    } catch (error) { failures.push({ game: `${g.season} W${g.week} ${g.home}`, error: error.message }); }
    if (onProgress) onProgress({ current: i + 1, total: games.length, written, skipped, failures: failures.length });
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return { version: NFL_WEATHER_VERSION, games: games.length, written, skipped, failures: failures.slice(0, 20), failure_count: failures.length };
}

async function forecastHourAt(lat, lon, kickoffIso) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation&forecast_days=16&timezone=UTC';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const hour = kickoffIso.slice(0, 13);
  const idx = (j.hourly?.time ?? []).findIndex(t => t.startsWith(hour));
  if (idx < 0) return null;
  const pick = key => (Number.isFinite(j.hourly[key]?.[idx]) ? j.hourly[key][idx] : null);
  return { temp_c: pick('temperature_2m'), wind_kmh: pick('wind_speed_10m'), gust_kmh: pick('wind_gusts_10m'), precip_mm: pick('precipitation') };
}

/**
 * Forecast kickoff-hour wind for outdoor games still ahead of kickoff, within
 * Open-Meteo's 16-day forecast horizon (verified 2026-09-02: 384 hourly rows).
 * `INSERT OR REPLACE` deliberately overwrites the same game's row on every run
 * — the forecast changes as kickoff approaches, and `nfl_signal_snapshots`
 * (via beat-the-close.js's `wind_forecast_kmh` signal, snapshotted hourly) is
 * where the Wednesday-forecast-vs-Friday-forecast-vs-actual history lives, not
 * this table. Once the game kicks off, `syncGameWeather`'s archive read takes
 * over the same row (see the `source` filter there).
 */
export async function syncForecastWeather({ pauseMs = 150 } = {}) {
  const season = Number(process.env.NFL_SEASON) || new Date().getUTCFullYear();
  const now = new Date().toISOString();
  const horizonMs = 16 * 24 * 3600000;
  const games = outdoorGames([season]).filter(g => {
    const kickoff = nflKickoffDate(g.gameday, g.gametime || '13:00')?.toISOString();
    return kickoff && kickoff > now && new Date(kickoff).getTime() - Date.now() <= horizonMs;
  });
  let written = 0;
  const failures = [];
  for (const g of games) {
    const stadium = STADIUMS[g.home];
    if (!stadium || stadium.indoor) continue;
    const kickoff = nflKickoffDate(g.gameday, g.gametime || '13:00').toISOString();
    try {
      const w = await forecastHourAt(stadium.lat, stadium.lon, kickoff);
      if (!w) { failures.push({ game: `${g.season} W${g.week} ${g.home}`, error: 'hour outside forecast horizon' }); continue; }
      run(`INSERT OR REPLACE INTO nfl_game_weather (season,week,home,kickoff,temp_c,wind_kmh,gust_kmh,precip_mm,source,fetched_at)
           VALUES (?,?,?,?,?,?,?,?,'open-meteo-forecast',datetime('now'))`, g.season, g.week, g.home, kickoff, w.temp_c, w.wind_kmh, w.gust_kmh, w.precip_mm);
      written++;
    } catch (error) { failures.push({ game: `${g.season} W${g.week} ${g.home}`, error: error.message }); }
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return { version: NFL_WEATHER_VERSION, games: games.length, written, failures: failures.slice(0, 20), failure_count: failures.length };
}

export function gameWeather(season, week, home) {
  return rows('SELECT * FROM nfl_game_weather WHERE season=? AND week=? AND home=?', season, week, home)[0] ?? null;
}

export function weatherStatus() {
  return { version: NFL_WEATHER_VERSION,
    by_season: rows('SELECT season, COUNT(*) games, ROUND(AVG(wind_kmh),1) mean_wind_kmh, SUM(wind_kmh>=25) windy_games, SUM(precip_mm>0) wet_games FROM nfl_game_weather GROUP BY season ORDER BY season') };
}
