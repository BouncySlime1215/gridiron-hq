/**
 * The My Team ceiling tab renders `week={scout?.week ?? 1}`
 * (client/src/pages/MyTeam.tsx:233). That `?? 1` is the whole reason the
 * `week` field exists on selfScout's payload: without it the tab hardcodes
 * week 1 for the entire season, which is the exact failure
 * trade-engine.js's own comment on the field was written to prevent.
 *
 * Nothing pinned it. Deleting `week:` from selfScout's return left the suite
 * green (served-field deletion sweep, 2026-09-20), so the page would have
 * silently gone back to pricing a season that has started as one that has
 * not — no error, no blank, just week 1 forever.
 *
 * These tests observe the field where the client observes it: on the JSON of
 * GET /api/trades/:leagueId/scout. A unit test on tradeWeekContext already
 * exists (test/trade-week-context-league.test.js) and did not catch this,
 * because the defect is not in the week it computes — it is in whether the
 * answer is handed out at all.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

// Same isolated-DB pattern used across this test suite (see post-draft-plan.test.js):
// point GRIDIRON_DB_PATH at a throwaway file before anything imports server/db/index.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-scout-week-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
// Set deliberately, and to neither league's week. tradeWeekContext() without a
// league falls back to the betting table and then to NFL_WEEK, so a test that
// left this unset could pass on the fallback agreeing with the fixture by luck.
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
// Side-effect imports: the trade engine reads several tables that other route
// files create ad-hoc at import time, the same wiring server/index.js relies on.
await import('../server/routes/stats.js');       // player_season_stats
await import('../server/routes/aggregates.js');  // player_metrics
await import('../server/routes/tradelab.js');    // trending_players
await import('../server/routes/nfldata.js');     // roster_players
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { rows } = await import('../server/db/index.js');

await runMigrations();
seedIfEmpty();

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'request failed' }));

const TOKEN = 'scout-week-token';

// At module scope, not in before(): the league_membership row needs its user to
// exist first (migration-006 trigger).
db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (884,'scout-week-user','Scout Week User')`).run();
db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (884,?,datetime('now','+1 day'))`)
  .run(hashSessionToken(TOKEN));

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

async function request(url) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = url; req.method = 'GET'; req.headers = { authorization: `Bearer ${TOKEN}` };
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    };
    app.handle(req, res, reject);
  });
}

// ESPN roster payload shape loadRosters() reads. Seeded players carry no
// espn_id, so loadRosters falls back to its name+position key match.
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
function espnPlayers(position, n) {
  return rows(`SELECT id, name, position FROM players
               WHERE position = ? AND fantasy_relevant = 1
               ORDER BY id LIMIT ?`, position, n);
}

let fakeId = 940000;
function rosteredLeague(id, currentMatchupPeriod) {
  const qb = espnPlayers('QB', 2), rb = espnPlayers('RB', 6), wr = espnPlayers('WR', 6), te = espnPlayers('TE', 2);
  const mine = [...qb.slice(0, 1), ...rb.slice(0, 3), ...wr.slice(0, 3), ...te.slice(0, 1)];
  const theirs = [...qb.slice(1, 2), ...rb.slice(3, 6), ...wr.slice(3, 6), ...te.slice(1, 2)];
  const entries = list => list.map(p => ({
    playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } }));
  const payload = {
    teams: [
      { id: 1, name: 'My Team', roster: { entries: entries(mine) } },
      { id: 2, name: 'Rival Team', roster: { entries: entries(theirs) } }
    ],
    settings: { name: `Scout League ${id}` },
    // The league's own matchup period, which is what leagueCurrentWeek(lg) reads.
    status: { currentMatchupPeriod }
  };
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, ?, ?, 10, '1', ?, 'x', 'y', 'connected')`,
    id, `espn-${id}`, `Scout League ${id}`, JSON.stringify(payload),
    JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 884, 'commissioner')`, id);
}

test('the scout payload carries a week at all', async () => {
  // The bare deletion check. If `week` stops being served, MyTeam.tsx's
  // `?? 1` takes over silently and the ceiling tab is week 1 in November.
  rosteredLeague(301, 6);
  const res = await request('/api/trades/301/scout?team_id=1');
  assert.equal(res.status, 200);
  assert.ok('week' in res.body, 'selfScout must serve `week`; MyTeam.tsx:233 falls back to 1 without it');
  assert.equal(typeof res.body.week, 'number');
});

test('the week served is the league\'s own matchup period', async () => {
  // Not merely present: right. A field that is served but hardcoded passes the
  // test above and fails the page just as badly.
  rosteredLeague(302, 6);
  const res = await request('/api/trades/302/scout?team_id=1');
  assert.equal(res.body.week, 6);
});

test('the week served is never the client\'s hardcoded fallback by accident', async () => {
  // The fixture's league is on week 6 and NFL_WEEK is 2, so a 1 here can only
  // be the fallback chain, never a coincidence.
  rosteredLeague(303, 6);
  const res = await request('/api/trades/303/scout?team_id=1');
  assert.notEqual(res.body.week, 1, 'a 1 here is the no-league fallback, i.e. the defect');
  assert.notEqual(res.body.week, Number(process.env.NFL_WEEK),
    'NFL_WEEK is the machine\'s week, not this league\'s');
});

test('two leagues on different weeks get different answers in one process', async () => {
  // The assertion the zero-argument form could not satisfy: tradeWeekContext()
  // returned one answer per process, so a second league inherited the first's.
  rosteredLeague(304, 4);
  rosteredLeague(305, 11);
  const a = await request('/api/trades/304/scout?team_id=1');
  const b = await request('/api/trades/305/scout?team_id=1');
  assert.equal(a.body.week, 4);
  assert.equal(b.body.week, 11);
});

test('the week sits beside the lineup it selects, on the same payload', async () => {
  // The field is only useful because the caller rendering the ceiling lineup
  // reads it off the same object it reads the lineup off. Splitting them would
  // put the two one request out of step at a week boundary.
  rosteredLeague(306, 9);
  const res = await request('/api/trades/306/scout?team_id=1');
  assert.equal(res.body.week, 9);
  assert.ok(res.body.lineup && Array.isArray(res.body.lineup.slots));
});
