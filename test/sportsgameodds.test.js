import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Verifies the SportsGameOdds parser against the exact oddID shape documented
// at sportsgameodds.com/docs (no live key exists to test against — this is
// the best available verification until one does).
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sgo-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const sgo = await import('../server/services/sportsgameodds.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (1,'KC','Kansas City Chiefs','AFC','West')`);
run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (2,'BUF','Buffalo Bills','AFC','East')`);

test('extractQuotes reads the documented oddID shape into spread/total/moneyline rows', () => {
  const event = {
    eventID: 'evt-1',
    status: { startsAt: '2026-09-14T17:00:00Z' },
    teams: { home: { names: { long: 'Kansas City Chiefs' } }, away: { names: { long: 'Buffalo Bills' } } },
    odds: {
      'points-home-game-sp-home': { oddID: 'points-home-game-sp-home', fairSpread: '-3', bookSpread: '-3',
        byBookmaker: { draftkings: { spread: '-3', odds: '-110', available: true } } },
      'points-away-game-sp-away': { oddID: 'points-away-game-sp-away', fairSpread: '3', bookSpread: '3',
        byBookmaker: { draftkings: { spread: '3', odds: '-110', available: true } } },
      'points-all-game-ou-over': { oddID: 'points-all-game-ou-over', fairOverUnder: '47.5',
        byBookmaker: { draftkings: { overUnder: '47.5', odds: '-105', available: true } } },
      'points-all-game-ou-under': { oddID: 'points-all-game-ou-under', fairOverUnder: '47.5',
        byBookmaker: { draftkings: { overUnder: '47.5', odds: '-115', available: true } } },
      'points-home-game-ml-home': { oddID: 'points-home-game-ml-home',
        byBookmaker: { draftkings: { odds: '-160', available: true } } },
      'points-away-game-ml-away': { oddID: 'points-away-game-ml-away',
        byBookmaker: { draftkings: { odds: '+140', available: true } } }
    }
  };
  const resolve = sgo.__test.teamResolver();
  const parsed = sgo.__test.extractQuotes(event, resolve);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.home, 'KC');
  assert.equal(parsed.away, 'BUF');
  assert.equal(parsed.quotes.length, 6);
  const spreadHome = parsed.quotes.find(q => q.market === 'spreads' && q.side === 'KC');
  assert.equal(spreadHome.line, -3);
  assert.equal(spreadHome.price, -110);
  const over = parsed.quotes.find(q => q.market === 'totals' && q.side === 'Over');
  assert.equal(over.line, 47.5);
  assert.equal(over.price, -105);
  const ml = parsed.quotes.find(q => q.market === 'h2h' && q.side === 'BUF');
  assert.equal(ml.price, 140);
});

test('extractQuotes fails closed when the team names cannot be resolved', () => {
  const event = { eventID: 'evt-2', teams: { home: { names: { long: 'Nonexistent Team' } },
    away: { names: { long: 'Also Nonexistent' } } }, odds: {} };
  const resolve = sgo.__test.teamResolver();
  const parsed = sgo.__test.extractQuotes(event, resolve);
  assert.ok(parsed.error);
});

test('an unavailable book quote is skipped, not stored as a live price', () => {
  const event = {
    eventID: 'evt-3', teams: { home: { names: { long: 'Kansas City Chiefs' } }, away: { names: { long: 'Buffalo Bills' } } },
    odds: { 'points-home-game-sp-home': { byBookmaker: { draftkings: { spread: '-3', odds: '-110', available: false } } } }
  };
  const resolve = sgo.__test.teamResolver();
  const parsed = sgo.__test.extractQuotes(event, resolve);
  assert.equal(parsed.quotes.length, 0);
});

test('captureSportsGameOddsSnapshot is a clean no-op without a key', async () => {
  delete process.env.SPORTSGAMEODDS_API_KEY;
  const result = await sgo.captureSportsGameOddsSnapshot();
  assert.equal(result.error, 'no SPORTSGAMEODDS_API_KEY configured');
});
