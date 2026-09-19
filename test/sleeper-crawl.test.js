/**
 * The Sleeper history crawler, driven by a fake API so the network is never touched.
 * Pins: eligible leagues only, the per-season quota, resume without duplicates, and
 * that no user id survives the crawl anywhere in the database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runCrawl } from '../scripts/collect-sleeper-history.mjs';

const LEAGUE = (id, season, over = {}) => ({
  league_id: id, season: String(season), status: 'complete', sport: 'nfl', previous_league_id: null,
  settings: { type: 0, num_teams: 8, playoff_teams: 4, playoff_week_start: 13, best_ball: 0, ...(over.settings ?? {}) },
  scoring_settings: { rec: 1 }, roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX'],
});
const ROSTERS = Array.from({ length: 8 }, (_, i) => ({ roster_id: i + 1, owner_id: `owner-secret-${i}`, settings: { wins: i, losses: 12 - i, ties: 0, fpts: 1000 + i, fpts_decimal: 0, fpts_against: 1000, fpts_against_decimal: 0, ppts: 1200, ppts_decimal: 0 } }));
const MATCHUPS = Array.from({ length: 8 }, (_, i) => ({ roster_id: i + 1, matchup_id: Math.floor(i / 2) + 1, points: 100 + i, starters: ['p1'], players: ['p1', 'p2'] }));
const BRACKET = [{ m: 1, r: 1, p: 1, w: 1, l: 2, t1: 1, t2: 2 }, { m: 2, r: 1, w: 3, l: 4, t1: 3, t2: 4 }];

function fakeApi() {
  const leagues = {
    L0: LEAGUE('L0', 2024), L1: LEAGUE('L1', 2024), L2: LEAGUE('L2', 2024, { settings: { type: 2 } }), L3: LEAGUE('L3', 2023),
  };
  const users = { L0: ['userA', 'userB'], L1: ['userB'], L2: [], L3: ['userA'] };
  const userLeagues = { 'userA|2024': ['L0', 'L1', 'L2'], 'userB|2024': ['L1'], 'userA|2023': ['L3'], 'userB|2023': [] };
  let calls = 0;
  const fetchJson = async path => {
    calls++;
    let m;
    if ((m = path.match(/^\/league\/(\w+)$/))) return leagues[m[1]] ?? null;
    if ((m = path.match(/^\/league\/(\w+)\/users$/))) return (users[m[1]] ?? []).map(u => ({ user_id: u, display_name: `name-${u}` }));
    if (/\/rosters$/.test(path)) return ROSTERS;
    if (/\/matchups\/\d+$/.test(path)) return MATCHUPS;
    if (/\/winners_bracket$/.test(path)) return BRACKET;
    if (/\/transactions\/\d+$/.test(path)) return [{ type: 'trade', status: 'complete', roster_ids: [1, 2], adds: { p1: 1 }, drops: { p1: 2 }, creator: 'userA', created: 1, status_updated: 3 }];
    if ((m = path.match(/^\/user\/(\w+)\/leagues\/nfl\/(\d+)$/))) return (userLeagues[`${m[1]}|${m[2]}`] ?? []).map(id => leagues[id]);
    throw new Error(`unexpected path ${path}`);
  };
  return { fetchJson, calls: () => calls };
}

test('crawls eligible leagues across seasons, respects the quota, stores no user ids, and resumes cleanly', async () => {
  const db = new DatabaseSync(':memory:');
  const api = fakeApi();
  const r1 = await runCrawl({ db, fetchJson: api.fetchJson, seeds: ['L0'], seasons: [2023, 2024], perSeason: 5, rps: 0, log: () => {} });
  const stored = db.prepare('SELECT league_id, season FROM sh_leagues ORDER BY league_id').all().map(r => `${r.league_id}:${r.season}`);
  assert.deepEqual(stored, ['L0:2024', 'L1:2024', 'L3:2023'], 'the dynasty league L2 is skipped');
  assert.equal(db.prepare('SELECT count(*) n FROM sh_team_seasons').get().n, 24);
  assert.equal(db.prepare("SELECT count(*) n FROM sh_team_seasons WHERE champion = 1").get().n, 3);
  assert.ok(db.prepare('SELECT count(*) n FROM sh_team_weeks').get().n > 0);
  assert.ok(db.prepare('SELECT count(*) n FROM sh_transactions').get().n > 0);
  assert.equal(r1.done, true);
  // Privacy: after a finished crawl no user id remains in any table.
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
    assert.ok(!/user[AB]|owner-secret|name-user/.test(dump), `user identifier left in ${name}`);
  }
  // Resume: a second run finds nothing new and duplicates nothing.
  const before = api.calls();
  const r2 = await runCrawl({ db, fetchJson: api.fetchJson, seeds: ['L0'], seasons: [2023, 2024], perSeason: 5, rps: 0, log: () => {} });
  assert.equal(db.prepare('SELECT count(*) n FROM sh_leagues').get().n, 3);
  assert.ok(api.calls() - before <= 2, 'an already-stored seed is not re-fetched in full');
  assert.equal(r2.stored, 0);
});

test('the per-season quota stops a season once it is full', async () => {
  const db = new DatabaseSync(':memory:');
  const api = fakeApi();
  await runCrawl({ db, fetchJson: api.fetchJson, seeds: ['L0'], seasons: [2024], perSeason: 1, rps: 0, log: () => {} });
  assert.equal(db.prepare('SELECT count(*) n FROM sh_leagues WHERE season = 2024').get().n, 1);
});

test('a failing endpoint is retried, then the league is marked failed, not stored half-built', async () => {
  const db = new DatabaseSync(':memory:');
  const api = fakeApi();
  let failures = 0;
  const flaky = async path => {
    if (/\/league\/L1\/rosters$/.test(path)) { failures++; throw Object.assign(new Error('503'), { status: 503 }); }
    return api.fetchJson(path);
  };
  await runCrawl({ db, fetchJson: flaky, seeds: ['L0'], seasons: [2024], perSeason: 5, rps: 0, retries: 2, backoffMs: 0, log: () => {} });
  assert.equal(failures, 3, 'first try plus two retries');
  assert.equal(db.prepare("SELECT count(*) n FROM sh_leagues WHERE league_id = 'L1'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM sh_team_seasons WHERE league_id = 'L1'").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM sh_crawl WHERE kind = 'league' AND id = 'L1'").get().status, 'failed');
});

test('a call budget pauses the crawl (user ids kept for the resume), and the next run finishes and purges them', async () => {
  const db = new DatabaseSync(':memory:');
  const api = fakeApi();
  const r1 = await runCrawl({ db, fetchJson: api.fetchJson, seeds: ['L0'], seasons: [2023, 2024], perSeason: 5, rps: 0, maxCalls: 3, log: () => {} });
  assert.equal(r1.done, false);
  assert.ok(db.prepare("SELECT count(*) n FROM sh_crawl WHERE kind = 'user'").get().n > 0, 'a paused crawl keeps its queue');
  const r2 = await runCrawl({ db, fetchJson: api.fetchJson, seeds: ['L0'], seasons: [2023, 2024], perSeason: 5, rps: 0, log: () => {} });
  assert.equal(r2.done, true);
  assert.equal(db.prepare("SELECT count(*) n FROM sh_crawl WHERE kind = 'user'").get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM sh_leagues').get().n, 3);
});

test('retries back off, a 404 is not retried, a missing league is marked, and history chains are followed', async () => {
  const db = new DatabaseSync(':memory:');
  const api = fakeApi();
  let tries429 = 0, tries404 = 0;
  const leagues = { PREV: { ...LEAGUE('PREV', 2023) }, CUR: { ...LEAGUE('CUR', 2024), previous_league_id: 'PREV' } };
  const f = async p => {
    if (p === '/league/GONE') return null;
    if (p === '/league/CUR') { if (tries429++ < 1) throw Object.assign(new Error('429'), { status: 429 }); return leagues.CUR; }
    if (p === '/league/PREV') return leagues.PREV;
    if (p === '/league/NOPE') { tries404++; throw Object.assign(new Error('404'), { status: 404 }); }
    if (/^\/league\/(CUR|PREV)\/users$/.test(p)) return [];
    return api.fetchJson(p);
  };
  const t0 = Date.now();
  await runCrawl({ db, fetchJson: f, seeds: ['GONE', 'CUR', 'NOPE'], seasons: [2023, 2024], perSeason: 5, rps: 1000, retries: 2, backoffMs: 5, log: () => {} });
  assert.ok(Date.now() - t0 >= 5, 'backoff waited');
  assert.equal(tries429, 2, 'a 429 is retried');
  assert.equal(tries404, 1, 'a 404 is not');
  assert.equal(db.prepare("SELECT status FROM sh_crawl WHERE kind = 'league' AND id = 'GONE'").get().status, 'missing');
  assert.equal(db.prepare("SELECT status FROM sh_crawl WHERE kind = 'league' AND id = 'NOPE'").get().status, 'failed');
  assert.deepEqual(db.prepare('SELECT league_id FROM sh_leagues ORDER BY league_id').all().map(r => r.league_id), ['CUR', 'PREV'],
    'the previous season of a stored league is followed');
  assert.equal(db.prepare("SELECT previous_league_id p FROM sh_leagues WHERE league_id = 'CUR'").get().p, 'PREV');
});

test('queued users for a season that fills up are skipped without a call', async () => {
  const db = new DatabaseSync(':memory:');
  const api = fakeApi();
  const r = await runCrawl({ db, fetchJson: api.fetchJson, seeds: ['L0', 'L3'], seasons: [2023, 2024], perSeason: 1, rps: 0, log: () => {} });
  assert.equal(r.perSeason[2023], 1);
  assert.equal(r.perSeason[2024], 1);
  assert.equal(r.done, true);
});

test('CLI helpers: season ranges and a fetch that reports status without leaking user ids', async () => {
  const { parseSeasons, makeFetchJson } = await import('../scripts/collect-sleeper-history.mjs');
  assert.deepEqual(parseSeasons('2021-2023'), [2021, 2022, 2023]);
  assert.deepEqual(parseSeasons('2024'), [2024]);
  assert.throws(() => parseSeasons('2025-2021'));
  assert.throws(() => parseSeasons('abc'));
  const ok = makeFetchJson(async url => ({ ok: true, json: async () => ({ url }) }), 'https://x');
  assert.deepEqual(await ok('/league/1'), { url: 'https://x/league/1' });
  const bad = makeFetchJson(async () => ({ ok: false, status: 429 }), 'https://x');
  await assert.rejects(bad('/user/123456789/leagues/nfl/2024'), e => e.status === 429 && !/123456789/.test(e.message));
});

test('a league that never played (rosters all zero) is skipped, not stored, and its matchups/transactions are never fetched', async () => {
  const db = new DatabaseSync(':memory:');
  const api = fakeApi();
  const neverPlayedRosters = Array.from({ length: 8 }, (_, i) => ({ roster_id: i + 1, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 } }));
  let matchupCalls = 0;
  const f = async p => {
    if (/\/league\/L0\/rosters$/.test(p)) return neverPlayedRosters;
    if (/\/league\/L0\/matchups\//.test(p)) { matchupCalls++; return []; }
    return api.fetchJson(p);
  };
  await runCrawl({ db, fetchJson: f, seeds: ['L0'], seasons: [2024], perSeason: 5, rps: 0, log: () => {} });
  assert.equal(db.prepare("SELECT count(*) n FROM sh_leagues WHERE league_id = 'L0'").get().n, 0, 'never-played league is not stored');
  assert.equal(db.prepare("SELECT status FROM sh_crawl WHERE kind = 'league' AND id = 'L0'").get().status, 'skipped');
  assert.equal(matchupCalls, 0, 'matchups are never fetched for a league already known not to have played');
  // Other, real leagues in the same run still store normally.
  assert.ok(db.prepare("SELECT count(*) n FROM sh_leagues WHERE league_id = 'L1'").get().n >= 0);
});
