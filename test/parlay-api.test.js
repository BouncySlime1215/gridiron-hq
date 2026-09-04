import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolated-DB pattern shared with the other suites.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-parlay-api-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.PARLAY_API_KEY;
delete process.env.ODDS_API_KEY;
delete process.env.MLB_ODDS_CAPTURE;

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const parlay = await import('../server/services/parlay-api.js');
const { captureMlbPregame } = await import('../server/services/mlb-pregame.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('with no key, every ParlayAPI call no-ops instead of throwing', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('should never be called without a key'); };
  try {
    assert.equal(parlay.hasKey(), false);
    assert.equal(await parlay.events(), null);
    assert.equal(await parlay.mlbEvents(), null);
    assert.equal(await parlay.gameOdds('americanfootball_nfl'), null);
    assert.equal(await parlay.playerProps('baseball_mlb', 'evt1'), null);
    assert.equal(fetched, 0, 'a missing key must never reach fetch');
    const status = parlay.reserveStatus();
    assert.equal(status.requests_remaining, null);
    assert.equal(status.exhausted, false, 'unknown usage is not treated as exhausted');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('gameOdds sends the documented request shape and records usage from headers', async () => {
  process.env.PARLAY_API_KEY = 'test-parlay-key';
  const realFetch = globalThis.fetch;
  let capturedUrl = null, capturedHeaders = null;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return {
      ok: true,
      headers: new Map([['x-requests-used', '10'], ['x-requests-remaining', '990'], ['x-requests-last', '2']]),
      json: async () => ([{
        id: 'evt1', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', commence_time: '2026-09-10T20:20:00Z',
        bookmakers: [{ key: 'draftkings', markets: [{ key: 'spreads', outcomes: [
          { name: 'Kansas City Chiefs', price: -110, point: -2.5 },
          { name: 'Buffalo Bills', price: -110, point: 2.5 }
        ] }] }]
      }])
    };
  };
  try {
    const payload = await parlay.gameOdds('americanfootball_nfl', { markets: 'spreads,totals', regions: 'us,eu', ttlMs: 0 });
    assert.ok(capturedUrl.startsWith('https://parlay-api.com/v1/sports/americanfootball_nfl/odds?'));
    assert.equal(new URL(capturedUrl).searchParams.get('markets'), 'spreads,totals');
    assert.equal(new URL(capturedUrl).searchParams.get('regions'), 'us,eu');
    assert.equal(capturedHeaders['X-API-Key'], 'test-parlay-key');
    assert.equal(payload.length, 1);
    assert.equal(payload[0].bookmakers[0].markets[0].outcomes[0].point, -2.5);
    const status = parlay.reserveStatus();
    assert.equal(status.requests_remaining, 990);
    assert.equal(status.exhausted, false);
    assert.equal(parlay.estimateOddsCost({ markets: 'spreads,totals', regions: 'us,eu' }), 4);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PARLAY_API_KEY;
  }
});

test('flattenProps splits ParlayAPI\'s flat over/under rows into per-side records', () => {
  const payload = [{
    bookmaker: 'draftkings', bookmaker_title: 'DraftKings', player: 'Aaron Judge',
    market_key: 'player_home_runs', market: 'Home Runs', line: 0.5, over_price: 290, under_price: -370,
    home_team: 'New York Yankees', away_team: 'Kansas City Royals',
    canonical_event_id: 'ee78855a3bdd1019', commence_time: '2026-05-01T19:35:00Z', last_update: 1746130000000, age_seconds: 3
  }];
  const flat = parlay.flattenProps(payload);
  assert.equal(flat.length, 2);
  const over = flat.find(r => r.side === 'Over');
  const under = flat.find(r => r.side === 'Under');
  assert.equal(over.american_price, 290);
  assert.equal(under.american_price, -370);
  assert.equal(over.market, 'player_home_runs');
  assert.equal(over.player, 'Aaron Judge');
  assert.equal(over.event_id, 'ee78855a3bdd1019');
  assert.equal(over.book, 'draftkings');
});

test('the reserve guard refuses to spend below the reserve and reports the hold, mirroring odds-api.js', async () => {
  process.env.PARLAY_API_KEY = 'test-parlay-key';
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true, headers: new Map(), json: async () => [] }; };
  try {
    run(`INSERT INTO parlay_usage (id,requests_used,requests_remaining,requests_last,last_call_at)
         VALUES (1,970,49,3,'2026-09-01T00:00:00Z')
         ON CONFLICT(id) DO UPDATE SET requests_used=970, requests_remaining=49`);
    const payload = await parlay.gameOdds('americanfootball_nfl', { markets: 'spreads,totals', ttlMs: 0 });
    assert.equal(payload, null, 'the call is refused, not sent');
    assert.equal(fetched, 0, 'no credit is spent');
    const status = parlay.reserveStatus();
    assert.equal(status.exhausted, true);
    assert.equal(status.last_hold.cost, 2);
    assert.equal(status.reserve, 50);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PARLAY_API_KEY;
  }
});

test('player props are metered at a flat 3 credits regardless of market count', async () => {
  process.env.PARLAY_API_KEY = 'test-parlay-key';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: new Map([['x-requests-remaining', '900']]), json: async () => [] });
  try {
    run(`INSERT INTO parlay_usage (id,requests_used,requests_remaining,requests_last,last_call_at)
         VALUES (1,900,52,null,'2026-09-01T00:00:00Z')
         ON CONFLICT(id) DO UPDATE SET requests_used=900, requests_remaining=52`);
    // 52 remaining, reserve 50 -> spendable 2, so a 3-credit props call must be refused.
    const refused = await parlay.playerProps('baseball_mlb', 'evt1', { markets: ['batter_total_bases', 'pitcher_strikeouts'], ttlMs: 0 });
    assert.equal(refused, null);
    assert.equal(parlay.reserveStatus().last_hold.cost, 3);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PARLAY_API_KEY;
  }
});

test('MLB pregame capture routes through ParlayAPI when its key is set, without needing MLB_ODDS_CAPTURE', async () => {
  process.env.PARLAY_API_KEY = 'test-parlay-key';
  const realFetch = globalThis.fetch;
  const date = '2031-08-01';
  run(`INSERT INTO mlb_games (game_pk, season, date, home_team, away_team, home_team_id, away_team_id)
       VALUES (9001, 2031, ?, 'New York Yankees', 'Boston Red Sox', 147, 111)`, date);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('statsapi.mlb.com')) {
      // No probable-starter schedule data and an empty boxscore; irrelevant to odds routing.
      if (u.includes('/boxscore')) return { ok: true, json: async () => ({ teams: {} }) };
      return { ok: true, json: async () => ({ dates: [] }) };
    }
    if (u.includes('parlay-api.com/v1/sports/baseball_mlb/events')) {
      return {
        ok: true, headers: new Map([['x-requests-remaining', '995']]),
        json: async () => ([{ id: 'mlb-evt-1', home_team: 'New York Yankees', away_team: 'Boston Red Sox', commence_time: `${date}T23:05:00Z` }])
      };
    }
    if (u.includes('parlay-api.com/v1/sports/baseball_mlb/odds')) {
      return {
        ok: true, headers: new Map([['x-requests-remaining', '992']]),
        json: async () => ([{
          id: 'mlb-evt-1', home_team: 'New York Yankees', away_team: 'Boston Red Sox', commence_time: `${date}T23:05:00Z`,
          bookmakers: [{ key: 'draftkings', markets: [{ key: 'pitcher_strikeouts', outcomes: [
            { name: 'Over', description: 'Gerrit Cole', point: 6.5, price: -115 }
          ] }] }]
        }])
      };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const result = await captureMlbPregame(date);
    assert.equal(result.odds_available, true);
    assert.equal(result.odds_source, 'parlay_api');
    assert.equal(result.parlay_capture_enabled, true);
    assert.equal(result.odds_capture_enabled, false, 'the Odds API flag stays off — this ran on the separate ParlayAPI budget');
    assert.equal(result.quotes, 1);
    const snap = rows(`SELECT odds_status, odds_source FROM mlb_pregame_snapshots WHERE game_pk=9001`)[0];
    assert.equal(snap.odds_status, 'captured');
    assert.equal(snap.odds_source, 'parlay_api');
    const quote = rows(`SELECT book, market, selection, price, source FROM mlb_market_quotes WHERE game_pk=9001`)[0];
    assert.equal(quote.source, 'parlay_api');
    assert.equal(quote.selection, 'Gerrit Cole');
    assert.equal(quote.price, -115);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PARLAY_API_KEY;
  }
});
