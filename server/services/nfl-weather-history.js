/**
 * What did the wind FORECAST say N days before each past kickoff?
 *
 * `nfl_game_weather` (nfl-weather.js) holds the archived kickoff-hour weather
 * that actually happened, and line-move-study.js uses it as a stand-in for a
 * Friday forecast — optimistic, because the real Friday forecast was wrong by
 * however much forecasts are wrong. Open-Meteo's free Previous Runs API keeps
 * every model run: `wind_speed_10m_previous_day2` at the kickoff hour is what
 * the model said two days earlier for that hour. Lead 0 is the archived day-of
 * forecast (`wind_speed_10m` on the same endpoint; the Historical Forecast API
 * returns the identical number and is the fallback when previous-runs fails).
 *
 * Verified live 2026-09-02 (BUF, 2024-11-17T18:00Z): lead0 12.7 / lead1 8.0 /
 * lead2 11.9 / lead3 13.5 / lead5 21.4 km/h vs archive actual 9.2. Lead 1-5
 * values are null before roughly 2024 (the previous-runs store starts there);
 * lead 0 goes back to 2022. Missing values are stored as NULL, never 0.
 */
import { db, rows, run } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';
import { STADIUMS } from './nfl-weather.js';

export const NFL_WEATHER_HISTORY_VERSION = 'nfl-weather-history-previous-runs-v1';
export const LEAD_DAYS = Object.freeze([0, 1, 2, 3, 5]);

const PREVIOUS_RUNS_API = 'https://previous-runs-api.open-meteo.com/v1/forecast';
const HISTORICAL_FORECAST_API = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const VARIABLES = Object.freeze({ wind_kmh: 'wind_speed_10m', gust_kmh: 'wind_gusts_10m', precip_mm: 'precipitation', temp_c: 'temperature_2m' });

db.exec(`CREATE TABLE IF NOT EXISTS nfl_game_weather_forecast_history (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL,
  kickoff TEXT NOT NULL, lead_days INTEGER NOT NULL,
  wind_kmh REAL, gust_kmh REAL, precip_mm REAL, temp_c REAL,
  source TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, home, lead_days)
)`);

// Same selection as nfl-weather.js's outdoorGames (copied, not imported — that one is private).
function outdoorGames(seasons) {
  return rows(`SELECT season,week,team home,gameday,gametime,roof,neutral_site FROM game_lines
    WHERE home=1 AND gameday IS NOT NULL AND season IN (${seasons.map(() => '?').join(',')})
      AND (roof IS NULL OR roof IN ('outdoors','open')) AND COALESCE(neutral_site,0)=0
    ORDER BY season,week,team`, ...seasons);
}

/** `wind_speed_10m` for lead 0, `wind_speed_10m_previous_day2` for lead 2. */
function hourlyKey(variable, lead) { return lead === 0 ? variable : `${variable}_previous_day${lead}`; }

async function fetchHourly(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  return (await res.json()).hourly ?? {};
}

function pickHour(hourly, kickoffIso) {
  const hour = kickoffIso.slice(0, 13);
  const idx = (hourly.time ?? []).findIndex(t => t.startsWith(hour));
  if (idx < 0) return null;
  return key => (Number.isFinite(hourly[key]?.[idx]) ? hourly[key][idx] : null);
}

/** One previous-runs call per game returns every lead for the kickoff hour. */
async function previousRunsAt(lat, lon, kickoffIso) {
  const day = kickoffIso.slice(0, 10);
  const vars = Object.values(VARIABLES).flatMap(v => LEAD_DAYS.map(lead => hourlyKey(v, lead)));
  const url = `${PREVIOUS_RUNS_API}?latitude=${lat}&longitude=${lon}&hourly=${vars.join(',')}&start_date=${day}&end_date=${day}&timezone=UTC`;
  const at = pickHour(await fetchHourly(url), kickoffIso);
  if (!at) return null;
  return LEAD_DAYS.map(lead => ({ lead_days: lead, source: 'open-meteo-previous-runs',
    ...Object.fromEntries(Object.entries(VARIABLES).map(([col, v]) => [col, at(hourlyKey(v, lead))])) }));
}

/** Fallback: the archived day-of forecast only (lead 0). */
async function historicalForecastAt(lat, lon, kickoffIso) {
  const day = kickoffIso.slice(0, 10);
  const url = `${HISTORICAL_FORECAST_API}?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}` +
    `&hourly=${Object.values(VARIABLES).join(',')}&timezone=UTC`;
  const at = pickHour(await fetchHourly(url), kickoffIso);
  if (!at) return null;
  return [{ lead_days: 0, source: 'open-meteo-historical-forecast',
    ...Object.fromEntries(Object.entries(VARIABLES).map(([col, v]) => [col, at(v)])) }];
}

/**
 * Fetch the forecast history for every outdoor, non-neutral, already-played
 * game that has no rows yet. Resumable: a game with any stored lead row is
 * skipped, so a second run only fills the gaps.
 */
export async function syncForecastHistory({ seasons = [2022, 2023, 2024, 2025], pauseMs = 200, limit = null, onProgress = null } = {}) {
  const games = outdoorGames(seasons);
  const have = new Set(rows('SELECT DISTINCT season, week, home FROM nfl_game_weather_forecast_history')
    .map(r => `${r.season}|${r.week}|${r.home}`));
  const now = new Date().toISOString();
  let written = 0, skipped = 0, fetched = 0;
  const failures = [];
  const insert = db.prepare(`INSERT OR REPLACE INTO nfl_game_weather_forecast_history
    (season,week,home,kickoff,lead_days,wind_kmh,gust_kmh,precip_mm,temp_c,source,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (limit != null && fetched >= limit) break;
    if (have.has(`${g.season}|${g.week}|${g.home}`)) { skipped++; continue; }
    const stadium = STADIUMS[g.home];
    if (!stadium || stadium.indoor) { skipped++; continue; }
    const kickoff = nflKickoffDate(g.gameday, g.gametime || '13:00')?.toISOString();
    if (!kickoff || kickoff > now) { skipped++; continue; }
    const label = `${g.season} W${g.week} ${g.home}`;
    fetched++;
    try {
      let leads = null, firstError = null;
      try { leads = await previousRunsAt(stadium.lat, stadium.lon, kickoff); }
      catch (error) { firstError = error; }
      if (!leads) leads = await historicalForecastAt(stadium.lat, stadium.lon, kickoff);
      if (!leads) { failures.push({ game: label, error: firstError ? `previous-runs: ${firstError.message}; historical-forecast: hour missing` : 'hour missing' }); continue; }
      for (const l of leads) insert.run(g.season, g.week, g.home, kickoff, l.lead_days, l.wind_kmh, l.gust_kmh, l.precip_mm, l.temp_c, l.source);
      written++;
    } catch (error) { failures.push({ game: label, error: error.message }); }
    if (onProgress) onProgress({ current: i + 1, total: games.length, written, skipped, failures: failures.length });
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return { version: NFL_WEATHER_HISTORY_VERSION, games: games.length, fetched, written, skipped, failures: failures.slice(0, 20), failure_count: failures.length };
}

/** Per-lead kickoff-hour forecast for one game; null where the store has nothing. */
export function forecastHistoryFeatures(season, week, home) {
  const byLead = new Map(rows('SELECT lead_days, wind_kmh, gust_kmh, precip_mm FROM nfl_game_weather_forecast_history WHERE season=? AND week=? AND home=?',
    season, week, home).map(r => [r.lead_days, r]));
  const pick = (lead, col) => { const v = byLead.get(lead)?.[col]; return Number.isFinite(v) ? v : null; };
  return {
    wind_kmh_lead5: pick(5, 'wind_kmh'), wind_kmh_lead3: pick(3, 'wind_kmh'), wind_kmh_lead2: pick(2, 'wind_kmh'),
    wind_kmh_lead1: pick(1, 'wind_kmh'), wind_kmh_lead0: pick(0, 'wind_kmh'),
    gust_kmh_lead2: pick(2, 'gust_kmh'), precip_mm_lead2: pick(2, 'precip_mm')
  };
}

export function forecastHistoryStatus() {
  return { version: NFL_WEATHER_HISTORY_VERSION, lead_days: [...LEAD_DAYS],
    by_season: rows(`SELECT season, COUNT(DISTINCT week||'|'||home) games,
        SUM(lead_days=0 AND wind_kmh IS NOT NULL) lead0_wind, SUM(lead_days=2 AND wind_kmh IS NOT NULL) lead2_wind,
        SUM(lead_days=5 AND wind_kmh IS NOT NULL) lead5_wind, MIN(fetched_at) first_fetched, MAX(fetched_at) last_fetched
      FROM nfl_game_weather_forecast_history GROUP BY season ORDER BY season`) };
}
