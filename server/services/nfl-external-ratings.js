/**
 * Two free public team power ratings, kept as a second opinion beside the
 * project's own ratings line. Neither is a model input by default; they are
 * snapshotted so a backtest can ask "did the public consensus already know
 * this?" and the weekly read can show where the house rating disagrees.
 *
 *   espn_fpi                – ESPN's Football Power Index (expected margin vs
 *                             an average opponent on a neutral field) with its
 *                             offense / defense / special-teams EPA components.
 *                             The endpoint has no history, so each run stores
 *                             one row per team under the current (season, week)
 *                             and the table becomes the history.
 *   teamrankings_predictive – TeamRankings' predictive rating, an HTML table
 *                             whose `?date=YYYY-MM-DD` returns the ratings as
 *                             they stood on that date. That makes it
 *                             backtestable: every game week since 2022 is
 *                             snapshotted on its Wednesday, the same day the
 *                             project's own weekly read is taken.
 *
 * Both land in `nfl_external_ratings` (source, season, week, team) with the
 * canonical team code from team-codes.js. A team name the resolver cannot
 * place is reported in the sync result and left out — never guessed.
 *
 * Verified 2026-09-02: the FPI payload carries `categories[].names` as the
 * column keys and `teams[].categories[].values` in the same order; the
 * TeamRankings page echoes the requested date back in its date input (a
 * future date is echoed too, with the latest ratings, so the sync never asks
 * for one). Both are undocumented public endpoints, read with a browser user
 * agent and a 1.5 s pause between TeamRankings requests.
 */
import { db, row, rows, run } from '../db/index.js';
import { canonicalTeamCode, teamResolver } from './team-codes.js';
import { appDate } from './date-util.js';

export const NFL_EXTERNAL_RATINGS_VERSION = 'nfl-external-ratings-v1';
export const SOURCES = Object.freeze({ fpi: 'espn_fpi', teamrankings: 'teamrankings_predictive' });

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FPI_URL = 'https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en';
const TEAMRANKINGS_URL = 'https://www.teamrankings.com/nfl/ranking/predictive-by-other/';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_external_ratings (
  source TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
  rating REAL NOT NULL, detail_json TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, season, week, team)
)`);

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function currentWeek(season) {
  // weekly-learning.js owns the "which week is it" answer; it is a heavy import,
  // so it is loaded only when a caller leaves the week to the default.
  const { currentNflWeek } = await import('./weekly-learning.js');
  return currentNflWeek(season ?? undefined);
}

function writeRatings(source, season, week, teams, fetchedAt) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of teams) {
      run(`INSERT OR REPLACE INTO nfl_external_ratings (source,season,week,team,rating,detail_json,fetched_at)
           VALUES (?,?,?,?,?,?,?)`, source, season, week, t.team, t.rating, JSON.stringify(t.detail), fetchedAt);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return teams.length;
}

/* ------------------------------------------------------------------ ESPN FPI */

/**
 * Parse ESPN's power-index payload into `{ teams, unresolved, season, last_updated }`.
 * `teams[]` carry the canonical code, the FPI rating and its components; a
 * team whose abbreviation and display name both fail the resolver is listed
 * under `unresolved` instead.
 */
export function parseFpi(payload, resolve = teamResolver()) {
  const category = (payload?.categories ?? []).find(c => c.name === 'fpi');
  const names = category?.names ?? [];
  const col = key => names.indexOf(key);
  const idx = { fpi: col('fpi'), off: col('epaoffense'), def: col('epadefense'), st: col('epaspecialteams'),
    rank: col('fpirank'), wins: col('numwins'), losses: col('numlosses') };
  if (idx.fpi < 0) throw new Error('ESPN FPI payload has no fpi column');
  const teams = [], unresolved = [];
  for (const t of payload?.teams ?? []) {
    const values = (t.categories ?? []).find(c => c.name === 'fpi')?.values ?? [];
    const pick = i => (i >= 0 ? num(values[i]) : null);
    const abbreviation = t.team?.abbreviation ?? null, name = t.team?.displayName ?? null;
    const resolved = resolve(abbreviation) ?? resolve(name);
    const rating = pick(idx.fpi);
    if (!resolved || rating == null) {
      unresolved.push({ abbreviation, name, reason: resolved ? 'no fpi value' : 'unknown team' });
      continue;
    }
    teams.push({ team: resolved.abbr, rating, detail: {
      epa_offense: pick(idx.off), epa_defense: pick(idx.def), epa_special_teams: pick(idx.st),
      fpi_rank: pick(idx.rank), wins: pick(idx.wins), losses: pick(idx.losses), espn_abbreviation: abbreviation } });
  }
  return { teams, unresolved, season: num(payload?.requestedSeason?.year), last_updated: payload?.lastUpdated ?? null };
}

/**
 * Snapshot ESPN FPI for one (season, week) — the current NFL week by default.
 * Re-running inside the same week overwrites that week's rows, which is the
 * point: the row is "FPI as of the latest sync in week N".
 */
export async function syncFpi({ season, week } = {}) {
  if (season == null || week == null) {
    const current = await currentWeek(season);
    season ??= current.season; week ??= current.week;
  }
  season = Number(season); week = Number(week);
  const res = await fetch(`${FPI_URL}&season=${season}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`espn fpi HTTP ${res.status}`);
  const parsed = parseFpi(await res.json());
  const base = { version: NFL_EXTERNAL_RATINGS_VERSION, source: SOURCES.fpi, season, week,
    last_updated: parsed.last_updated, unresolved: parsed.unresolved };
  if (parsed.season != null && parsed.season !== season) {
    return { ...base, written: 0, error: `ESPN returned season ${parsed.season} for a season=${season} request; nothing written` };
  }
  const fetchedAt = new Date().toISOString();
  const written = writeRatings(SOURCES.fpi, season, week, parsed.teams, fetchedAt);
  return { ...base, written, fetched_at: fetchedAt };
}

/* -------------------------------------------------------------- TeamRankings */

const clean = s => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

/**
 * Parse a TeamRankings predictive-ratings page. Returns
 * `{ teams, unresolved, as_of, columns }` where each team has the canonical
 * code, rank, rating (the full-precision `data-sort` value, which the site
 * stores as rating + 500, falling back to the displayed one-decimal figure
 * when the two disagree), record and the remaining columns keyed by header.
 * `as_of` is the date the page says it is showing, from its date input.
 */
export function parseTeamRankings(html, resolve = teamResolver()) {
  const table = /<table class="tr-table datatable scrollable">([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (!table) throw new Error('TeamRankings page has no ratings table');
  const headers = [...(/<thead>([\s\S]*?)<\/thead>/.exec(table)?.[1] ?? '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => clean(m[1]));
  if (headers[0] !== 'Rank' || headers[1] !== 'Team' || headers[2] !== 'Rating') {
    throw new Error(`TeamRankings table columns changed: ${headers.join(' | ')}`);
  }
  const dateInput = /data-query-param-name="date"[^>]*value="(\d{2})\/(\d{2})\/(\d{4})"/.exec(html);
  const as_of = dateInput ? `${dateInput[3]}-${dateInput[1]}-${dateInput[2]}` : null;
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? '';
  const teams = [], unresolved = [];
  for (const tr of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)]
      .map(m => ({ sort: /data-sort="([^"]*)"/.exec(m[1])?.[1] ?? null, raw: m[2], text: clean(m[2]) }));
    if (cells.length < 3) continue;
    const name = clean(/<a[^>]*>([\s\S]*?)<\/a>/.exec(cells[1].raw)?.[1] ?? cells[1].sort ?? cells[1].text);
    const slug = /\/nfl\/team\/([a-z0-9-]+)/.exec(cells[1].raw)?.[1] ?? null;
    const record = /\((\d+)-(\d+)(?:-(\d+))?\)/.exec(cells[1].text);
    const shown = num(cells[2].text);
    const precise = cells[2].sort == null ? null : num(Number(cells[2].sort) - 500);
    const rating = precise != null && shown != null && Math.abs(precise - shown) < 0.06 ? precise : shown;
    if (rating == null) { unresolved.push({ name, slug, reason: 'no rating value' }); continue; }
    const resolved = resolve(name) ?? (slug ? resolve(slug.replace(/-/g, ' ')) : null);
    if (!resolved) { unresolved.push({ name, slug, reason: 'unknown team' }); continue; }
    const columns = {};
    headers.slice(3).forEach((h, i) => { if (cells[3 + i]) columns[h] = cells[3 + i].text; });
    teams.push({ team: resolved.abbr, rating, detail: {
      rank: num(cells[0].text), rating_shown: shown, teamrankings_name: name,
      wins: record ? Number(record[1]) : null, losses: record ? Number(record[2]) : null,
      ties: record?.[3] != null ? Number(record[3]) : null, columns } });
  }
  return { teams, unresolved, as_of, columns: headers };
}

/** The Wednesday on or before a `YYYY-MM-DD` gameday — the snapshot day for that game week. */
export function wednesdayOf(gameday) {
  const d = new Date(`${gameday}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 3 + 7) % 7));
  return d.toISOString().slice(0, 10);
}

async function fetchTeamRankings(date) {
  const res = await fetch(`${TEAMRANKINGS_URL}?date=${date}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`teamrankings HTTP ${res.status}`);
  return parseTeamRankings(await res.text());
}

/**
 * Snapshot TeamRankings' predictive rating for every regular-season game week
 * in `game_lines` for `seasons` (weeks 1–18), dated the Wednesday of that
 * week, plus the current week when `current`. A week whose Wednesday has not
 * arrived is snapshotted as of today instead and refreshed once it has, so the
 * stored history is always "the Wednesday read" wherever one exists. Weeks
 * already holding their target-date snapshot are skipped, which is what makes
 * the ~70-request backfill a one-time cost. Team names the resolver cannot
 * place are returned under `unresolved` with the weeks they appeared in.
 */
export async function syncTeamRankings({ seasons = [2022, 2023, 2024, 2025], current = true, pauseMs = 1500, onProgress = null } = {}) {
  const today = appDate();
  const weeks = seasons.length
    ? rows(`SELECT season, week, MIN(gameday) first_gameday FROM game_lines
            WHERE season IN (${seasons.map(() => '?').join(',')}) AND week BETWEEN 1 AND 18 AND gameday IS NOT NULL
            GROUP BY season, week ORDER BY season, week`, ...seasons)
    : [];
  if (current) {
    const c = await currentWeek();
    if (!weeks.some(w => w.season === c.season && w.week === c.week)) {
      const first = row('SELECT MIN(gameday) first_gameday FROM game_lines WHERE season=? AND week=?', c.season, c.week)?.first_gameday ?? null;
      weeks.push({ season: c.season, week: c.week, first_gameday: first });
    }
  }
  const have = new Map(rows(`SELECT season, week, MIN(json_extract(detail_json,'$.as_of')) as_of
    FROM nfl_external_ratings WHERE source=? GROUP BY season, week`, SOURCES.teamrankings)
    .map(r => [`${r.season}|${r.week}`, r.as_of]));
  let fetched = 0, written = 0, skipped = 0;
  const failures = [], unresolved = new Map();
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    const wednesday = w.first_gameday ? wednesdayOf(w.first_gameday) : null;
    const date = wednesday && wednesday < today ? wednesday : today;
    if (have.get(`${w.season}|${w.week}`) === date) { skipped++; continue; }
    if (fetched && pauseMs) await sleep(pauseMs);
    fetched++;
    try {
      const parsed = await fetchTeamRankings(date);
      if (parsed.as_of && parsed.as_of !== date) {
        failures.push({ week: `${w.season} W${w.week}`, error: `asked for ${date}, page shows ${parsed.as_of}` });
        continue;
      }
      for (const u of parsed.unresolved) {
        const key = `${u.name}|${u.slug}`;
        const entry = unresolved.get(key) ?? { ...u, weeks: [] };
        entry.weeks.push(`${w.season} W${w.week}`);
        unresolved.set(key, entry);
      }
      if (!parsed.teams.length) { failures.push({ week: `${w.season} W${w.week}`, error: 'no teams parsed' }); continue; }
      const teams = parsed.teams.map(t => ({ ...t, detail: { ...t.detail, as_of: date, wednesday } }));
      written += writeRatings(SOURCES.teamrankings, w.season, w.week, teams, new Date().toISOString());
    } catch (error) { failures.push({ week: `${w.season} W${w.week}`, error: error.message }); }
    if (onProgress) onProgress({ current: i + 1, total: weeks.length, fetched, written, skipped, failures: failures.length });
  }
  return { version: NFL_EXTERNAL_RATINGS_VERSION, source: SOURCES.teamrankings, weeks: weeks.length, fetched, written, skipped,
    failures: failures.slice(0, 20), failure_count: failures.length, unresolved: [...unresolved.values()] };
}

/* ------------------------------------------------------------------ readers */

/**
 * Home-minus-away rating differences for a game, one per source. A source
 * missing either team for that (season, week) yields null — never 0, since a
 * zero would read as "the sources call it even".
 */
export function externalRatingsFeatures(season, week, home, away) {
  const h = canonicalTeamCode(home), a = canonicalTeamCode(away);
  const got = rows('SELECT source, team, rating FROM nfl_external_ratings WHERE season=? AND week=? AND team IN (?,?)',
    season, week, h, a);
  const diff = source => {
    const hr = got.find(r => r.source === source && r.team === h)?.rating;
    const ar = got.find(r => r.source === source && r.team === a)?.rating;
    return Number.isFinite(hr) && Number.isFinite(ar) ? hr - ar : null;
  };
  return { fpi_diff: diff(SOURCES.fpi), teamrankings_diff: diff(SOURCES.teamrankings) };
}

export function externalRatings(source, season, week) {
  return rows('SELECT team, rating, detail_json, fetched_at FROM nfl_external_ratings WHERE source=? AND season=? AND week=? ORDER BY rating DESC',
    source, season, week).map(r => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null }));
}

export function externalRatingsStatus() {
  return { version: NFL_EXTERNAL_RATINGS_VERSION, sources: Object.values(SOURCES),
    by_source: rows(`SELECT source, season, COUNT(DISTINCT week) weeks, MIN(week) first_week, MAX(week) last_week,
        COUNT(*) team_weeks, MAX(fetched_at) latest FROM nfl_external_ratings GROUP BY source, season ORDER BY source, season`),
    short_weeks: rows(`SELECT source, season, week, COUNT(*) teams FROM nfl_external_ratings
        GROUP BY source, season, week HAVING COUNT(*) < 32 ORDER BY source, season, week`),
    note: 'Second-opinion power ratings, not model inputs. ESPN FPI is snapshotted per week (no history upstream); TeamRankings is the Wednesday read of each game week via its ?date= archive.' };
}

export const __test = { parseFpi, parseTeamRankings, wednesdayOf };
