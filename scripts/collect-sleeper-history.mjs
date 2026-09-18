#!/usr/bin/env node
/**
 * Collect real public fantasy-league history from Sleeper's public API.
 *
 * Why (plan section 00, parts D2-D3): the Team Outlook, the trade horizon, waiver and
 * posture calibration and the Coach's "teams like yours" all need real league history
 * beyond Nick's 12 league-seasons — weekly scores, standings, max possible points,
 * playoff brackets and every trade/waiver move, from thousands of real managers.
 *
 * How it finds leagues: start from seed leagues, follow each league's members to their
 * other leagues in the target seasons (breadth-first), and keep only leagues that pass
 * `isEligibleLeague` (completed redraft NFL, 8-14 teams, real playoffs, no best ball).
 * The eligibility check runs on the user's league listing, so ineligible leagues cost
 * nothing beyond that one call.
 *
 * Privacy: user ids are needed only to discover leagues; they live in the crawl queue
 * and are deleted when the crawl completes. No display names, team names or owner ids
 * are written anywhere.
 *
 * Politeness: Sleeper asks callers to stay under 1,000 requests a minute. Default 12/s
 * (720/min), with retries and backoff on 429/5xx.
 *
 * Usage:
 *   node scripts/collect-sleeper-history.mjs [--seasons 2021-2025] [--per-season 500]
 *        [--rps 12] [--seed <league_id>] [--db data/derived/sleeper_history.sqlite]
 * Resumable: re-running continues from the stored queue.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isEligibleLeague, scoringType, regularSeasonWeeks, buildTeamSeasons, parseTransactions, leaguePlayed,
} from '../server/services/sleeper-history.js';

/** The league Sleeper's own API documentation uses as its example (a real 2018 league). */
export const DEFAULT_SEED = '289646328504385536';

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sh_leagues (
      league_id TEXT PRIMARY KEY, season INTEGER NOT NULL, num_teams INTEGER, playoff_teams INTEGER,
      playoff_week_start INTEGER, scoring TEXT, roster_positions TEXT, previous_league_id TEXT, fetched_at TEXT);
    CREATE TABLE IF NOT EXISTS sh_team_seasons (
      league_id TEXT NOT NULL, roster_id INTEGER NOT NULL, wins INTEGER, losses INTEGER, ties INTEGER,
      points_for REAL, points_against REAL, max_points REAL, reg_seed INTEGER, made_playoffs INTEGER, champion INTEGER,
      PRIMARY KEY (league_id, roster_id));
    CREATE TABLE IF NOT EXISTS sh_team_weeks (
      league_id TEXT NOT NULL, roster_id INTEGER NOT NULL, week INTEGER NOT NULL, points REAL,
      opponent_roster_id INTEGER, starters_json TEXT, players_json TEXT, PRIMARY KEY (league_id, roster_id, week));
    CREATE TABLE IF NOT EXISTS sh_transactions (
      league_id TEXT NOT NULL, week INTEGER NOT NULL, seq INTEGER NOT NULL, type TEXT, status TEXT,
      roster_ids_json TEXT, adds_json TEXT, drops_json TEXT, waiver_bid REAL, draft_picks INTEGER,
      created_ms INTEGER, latency_ms INTEGER, PRIMARY KEY (league_id, week, seq));
    CREATE TABLE IF NOT EXISTS sh_crawl (
      kind TEXT NOT NULL, id TEXT NOT NULL, season INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      PRIMARY KEY (kind, id, season));
    CREATE INDEX IF NOT EXISTS sh_crawl_pending ON sh_crawl (status, kind);
    CREATE INDEX IF NOT EXISTS sh_leagues_season ON sh_leagues (season);
  `);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const retryable = e => e?.status == null || e.status === 429 || e.status >= 500;

/**
 * The crawl. Everything it touches is passed in, so tests drive it with a fake API
 * and an in-memory database.
 * @returns {{done: boolean, stored: number, calls: number, perSeason: object}}
 */
export async function runCrawl({
  db, fetchJson, seeds = [DEFAULT_SEED], seasons, perSeason = 500, rps = 12,
  retries = 3, backoffMs = 2000, maxCalls = Infinity, log = console.log,
}) {
  schema(db);
  const q = {
    add: db.prepare('INSERT OR IGNORE INTO sh_crawl (kind, id, season, status) VALUES (?, ?, ?, \'pending\')'),
    mark: db.prepare('UPDATE sh_crawl SET status = ? WHERE kind = ? AND id = ? AND season = ?'),
    nextLeague: db.prepare("SELECT id, season FROM sh_crawl WHERE kind = 'league' AND status = 'pending' ORDER BY rowid LIMIT 1"),
    nextUser: db.prepare("SELECT id, season FROM sh_crawl WHERE kind = 'user' AND status = 'pending' ORDER BY rowid LIMIT 1"),
    seen: db.prepare("SELECT 1 FROM sh_crawl WHERE kind = 'league' AND id = ?"),
    stored: db.prepare('SELECT 1 FROM sh_leagues WHERE league_id = ?'),
    count: db.prepare('SELECT count(*) n FROM sh_leagues WHERE season = ?'),
    league: db.prepare(`INSERT OR IGNORE INTO sh_leagues VALUES (?,?,?,?,?,?,?,?,?)`),
    team: db.prepare(`INSERT OR REPLACE INTO sh_team_seasons VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    week: db.prepare(`INSERT OR REPLACE INTO sh_team_weeks VALUES (?,?,?,?,?,?,?)`),
    tx: db.prepare(`INSERT OR REPLACE INTO sh_transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  };
  const counts = Object.fromEntries(seasons.map(s => [s, q.count.get(s).n]));
  const full = s => counts[s] >= perSeason;
  const allFull = () => seasons.every(full);
  let calls = 0, stored = 0;
  const gap = rps > 0 ? 1000 / rps : 0;

  async function get(p) {
    for (let attempt = 0; ; attempt++) {
      if (calls >= maxCalls) throw Object.assign(new Error('call budget reached'), { budget: true });
      if (gap) await sleep(gap);
      calls++;
      try {
        return await fetchJson(p);
      } catch (e) {
        if (attempt >= retries || !retryable(e)) throw e;
        if (backoffMs) await sleep(backoffMs * (attempt + 1));
      }
    }
  }

  for (const id of seeds) if (!q.seen.get(id) && !q.stored.get(id)) q.add.run('league', id, 0);

  async function crawlLeague(id, qSeason) {
    const league = await get(`/league/${id}`);
    if (!league) { q.mark.run('missing', 'league', id, qSeason); return; }
    const season = Number(league.season);
    const prev = league.previous_league_id;
    if (prev && prev !== '0' && seasons.includes(season - 1) && !full(season - 1) && !q.seen.get(prev)) {
      q.add.run('league', prev, season - 1);
    }
    const users = (await get(`/league/${id}/users`)) ?? [];
    for (const u of users) {
      for (const s of seasons) if (!full(s) && u?.user_id) q.add.run('user', String(u.user_id), s);
    }
    if (!isEligibleLeague(league, { seasons }) || full(season) || q.stored.get(id)) {
      q.mark.run('skipped', 'league', id, qSeason); return;
    }
    // Fetch everything first; write only when the whole league-season is in hand, so a
    // failure never leaves a half-built league behind.
    const weeks = regularSeasonWeeks(league);
    const rosters = await get(`/league/${id}/rosters`);
    // A league can be status='complete' with the right format settings and still never
    // have drafted or played a game (found in the first crawl: 162 of 488 stored leagues,
    // 33%, were exactly this). isEligibleLeague cannot see it - format is set at creation,
    // before any game is played - so this checks outcomes instead, and skips before the
    // matchup/bracket/transaction calls a dead league would otherwise still cost.
    if (!leaguePlayed(rosters)) { q.mark.run('skipped', 'league', id, qSeason); return; }
    const matchups = {};
    for (const w of weeks) matchups[w] = (await get(`/league/${id}/matchups/${w}`)) ?? [];
    const bracket = (await get(`/league/${id}/winners_bracket`)) ?? [];
    const txs = [];
    for (const w of weeks) txs.push(...parseTransactions((await get(`/league/${id}/transactions/${w}`)) ?? [], w));
    const { teams, weeks: weekRows } = buildTeamSeasons(league, rosters ?? [], matchups, bracket);
    const s = league.settings;
    db.exec('BEGIN');
    try {
      q.league.run(id, season, Number(s.num_teams), Number(s.playoff_teams), Number(s.playoff_week_start),
        scoringType(league.scoring_settings), JSON.stringify(league.roster_positions ?? []),
        prev && prev !== '0' ? String(prev) : null, new Date().toISOString());
      for (const t of teams) q.team.run(id, t.roster_id, t.wins, t.losses, t.ties, t.points_for, t.points_against,
        t.max_points, t.reg_seed, t.made_playoffs, t.champion);
      for (const r of weekRows) q.week.run(id, r.roster_id, r.week, r.points, r.opponent_roster_id, r.starters_json, r.players_json);
      txs.forEach((t, i) => q.tx.run(id, t.week, i, t.type, t.status, t.roster_ids_json, t.adds_json, t.drops_json,
        t.waiver_bid, t.draft_picks, t.created_ms, t.latency_ms));
      q.mark.run('done', 'league', id, qSeason);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    counts[season]++; stored++;
    if (stored % 25 === 0) log(`stored ${stored} | ${seasons.map(x => `${x}:${counts[x]}`).join(' ')} | calls ${calls}`);
  }

  async function crawlUser(id, season) {
    const list = (await get(`/user/${id}/leagues/nfl/${season}`)) ?? [];
    for (const lg of list) {
      if (!lg?.league_id || full(season)) continue;
      if (isEligibleLeague(lg, { seasons }) && !q.seen.get(lg.league_id) && !q.stored.get(lg.league_id)) {
        q.add.run('league', String(lg.league_id), season);
      }
    }
    q.mark.run('done', 'user', id, season);
  }

  let budgetHit = false;
  while (!allFull()) {
    const lg = q.nextLeague.get();
    const next = lg ? { kind: 'league', ...lg } : (() => { const u = q.nextUser.get(); return u ? { kind: 'user', ...u } : null; })();
    if (!next) break;
    try {
      if (next.kind === 'league') await crawlLeague(next.id, next.season);
      else if (full(next.season)) q.mark.run('skipped', 'user', next.id, next.season);
      else await crawlUser(next.id, next.season);
    } catch (e) {
      if (e?.budget) { budgetHit = true; break; }
      q.mark.run('failed', next.kind, next.id, next.season);
      log(`failed ${next.kind} ${next.kind === 'user' ? '(id withheld)' : next.id}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  const done = !budgetHit;
  if (done) {
    // Privacy: the crawl is finished, so the user ids it used to discover leagues go.
    db.exec("DELETE FROM sh_crawl WHERE kind = 'user'");
  }
  log(`crawl ${done ? 'complete' : 'paused (call budget)'} | stored ${stored} this run | ${seasons.map(x => `${x}:${counts[x]}`).join(' ')} | calls ${calls}`);
  return { done, stored, calls, perSeason: { ...counts } };
}

// ------------------------------------------------------------------ CLI helpers (tested)
/** '2021-2025' -> [2021..2025]; '2024' -> [2024]. */
export function parseSeasons(str) {
  const [a, b] = String(str).split('-').map(Number);
  if (!Number.isInteger(a) || (b != null && !Number.isInteger(b)) || (b ?? a) < a) throw new Error(`bad --seasons ${str}`);
  return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
}

/** A fetchJson over Sleeper's public base URL; errors carry the HTTP status and never a user id. */
export function makeFetchJson(fetchImpl = fetch, base = 'https://api.sleeper.app/v1') {
  return async p => {
    const res = await fetchImpl(`${base}${p}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw Object.assign(new Error(`Sleeper ${res.status} on ${p.replace(/\/user\/[^/]+/, '/user/<id>')}`), { status: res.status });
    return res.json();
  };
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
  const seasons = parseSeasons(arg('seasons', '2021-2025'));
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dbPath = path.resolve(ROOT, arg('db', 'data/derived/sleeper_history.sqlite'));
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000;');
  const fetchJson = makeFetchJson();
  const seed = arg('seed', null);
  const r = await runCrawl({
    db, fetchJson, seasons, seeds: seed ? [seed] : [DEFAULT_SEED],
    perSeason: Number(arg('per-season', 500)), rps: Number(arg('rps', 12)),
  });
  db.close();
  process.exit(r.done ? 0 : 2);
}
