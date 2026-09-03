import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

// Same isolated-DB pattern used across this test suite (see fantasy-workflows.test.js):
// point GRIDIRON_DB_PATH at a throwaway file before anything imports server/db/index.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-post-draft-plan-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
// Side-effect imports: the trade engine (assetUniverse -> vorBoard etc.) reads
// several tables that are created ad-hoc at import time by other route files —
// same "~40 files create tables on import" wiring server/index.js relies on for
// the real app, so the isolated test app needs the same imports for side effects.
await import('../server/routes/stats.js');       // player_season_stats
await import('../server/routes/aggregates.js');  // player_metrics
await import('../server/routes/tradelab.js');    // trending_players
await import('../server/routes/nfldata.js');     // roster_players
const { default: tradesRouter } = await import('../server/routes/trades.js');

await runMigrations();
seedIfEmpty();

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'request failed' }));

const TOKEN = 'post-draft-plan-token';

before(() => {
  db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (881,'pdp-user','PDP User')`).run();
  db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (881,?,datetime('now','+1 day'))`)
    .run(hashSessionToken(TOKEN));
});

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

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

// ESPN roster payload shape loadRosters() reads: teams[].roster.entries[].playerPoolEntry.player.
// Seeded players don't carry an espn_id, so loadRosters falls back to its
// name+position key match — mirror that here instead of relying on espn_id.
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
function entry(player, fakeId) {
  return { playerPoolEntry: { player: { id: fakeId, fullName: player.name, defaultPositionId: POS_ID[player.position] } } };
}

function espnPlayers(position, n) {
  return rows(`SELECT id, name, position FROM players
              WHERE position = ? AND fantasy_relevant = 1
              ORDER BY id LIMIT ?`, position, n);
}

function insertLeague(id, payload, { teamCount = 10, myTeamId = '1' } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'PDP League', ?, ?, ?, ?, 'x', 'y', 'connected')`,
    id, `espn-${id}`, payload ? JSON.stringify(payload) : null, teamCount, myTeamId,
    JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}

function draftedRoster() {
  const qb = espnPlayers('QB', 2), rb = espnPlayers('RB', 6), wr = espnPlayers('WR', 6), te = espnPlayers('TE', 2);
  const roster1 = [...qb.slice(0, 1), ...rb.slice(0, 3), ...wr.slice(0, 3), ...te.slice(0, 1)];
  const roster2 = [...qb.slice(1, 2), ...rb.slice(3, 6), ...wr.slice(3, 6), ...te.slice(1, 2)];
  let fakeId = 900000;
  const withEntries = list => list.map(p => entry(p, fakeId++));
  return {
    teams: [
      { id: 1, name: 'My Team', roster: { entries: withEntries(roster1) } },
      { id: 2, name: 'Rival Team', roster: { entries: withEntries(roster2) } }
    ],
    settings: { name: 'PDP League' }
  };
}

test('post-draft-plan requires a synced league', async () => {
  const res = await request('/api/trades/999/post-draft-plan');
  assert.equal(res.status, 404);
});

test('post-draft-plan returns an explicit not-yet-drafted response (200, not an error) for an empty roster', async () => {
  insertLeague(101, { teams: [], settings: { name: 'PDP League' } });
  const res = await request('/api/trades/101/post-draft-plan');
  assert.equal(res.status, 200);
  assert.equal(res.body.drafted, false);
  assert.ok(res.body.message);
  assert.equal(res.body.self_scout, undefined);
});

test('post-draft-plan combines self-scout, trades, and best-lineup output for a completed draft', async () => {
  insertLeague(102, draftedRoster());
  const res = await request('/api/trades/102/post-draft-plan?team_id=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.drafted, true);
  assert.ok(res.body.self_scout && Array.isArray(res.body.self_scout.fixes));
  assert.ok(res.body.lineup && Array.isArray(res.body.lineup.slots));
  assert.ok(res.body.trades && Array.isArray(res.body.trades.deals));
  // best_lineup is reused straight off selfScout's own bestLineup() call, so the
  // two must be the exact same lineup, not two independently-computed ones.
  assert.deepEqual(res.body.lineup, res.body.self_scout.lineup);
});

test('post-draft-plan never starts a K or DEF (SCORED-only lineup, no regression from the shared exclusion)', async () => {
  insertLeague(103, draftedRoster());
  const res = await request('/api/trades/103/post-draft-plan?team_id=1');
  const startedPositions = res.body.lineup.slots.map(s => s.player?.position).filter(Boolean);
  assert.ok(!startedPositions.includes('K') && !startedPositions.includes('DEF'));
});

test('post-draft-plan is ESPN-only', async () => {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id)
       VALUES (104, 'sleeper', 'sleeper-104', 2026, 'Sleeper League', ?, 10, '1')`,
    JSON.stringify({ rosters: [], users: [] }));
  const res = await request('/api/trades/104/post-draft-plan');
  assert.equal(res.status, 400);
});
