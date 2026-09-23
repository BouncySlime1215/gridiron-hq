/**
 * RL-9-3 liveness: lineup_value reaches the two Trade Machine routes it was built
 * for, POST /api/trades/:id/evaluate and GET /api/trades/:id/find, on a seeded
 * six-team ESPN league whose unrostered seed players are the wire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-value-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '4';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
// Side-effect imports: the tables other suites rely on (see test/find-trades.test.js).
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
await runMigrations();
seedIfEmpty();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const players = (position, n) => rows(`SELECT id, name, position FROM players
  WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT ?`, position, n);
const qb = players('QB', 6), rb = players('RB', 18), wr = players('WR', 18), te = players('TE', 6);
let fakeId = 900000;
const teams = [];
for (let i = 0; i < 6; i++) {
  const roster = [qb[i], ...rb.slice(i * 3, i * 3 + 3), ...wr.slice(i * 3, i * 3 + 3), te[i]].filter(Boolean);
  teams.push({ id: i + 1, name: `Team ${i + 1}`, roster: { entries: roster.map(p => ({ playerPoolEntry:
    { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } });
}
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
     VALUES (301, 'espn', 'espn-lv-301', 2026, 'LV League', ?, 6, '1', ?)`,
JSON.stringify({ teams, settings: { name: 'LV League' } }), JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
// Market values, so the finder's value prune has something to sum (the seed has none).
const { deriveFormat } = await import('../server/services/format.js');
const { formatKey } = deriveFormat(rows('SELECT * FROM leagues WHERE id = 301')[0]);
rows(`SELECT id FROM players WHERE fantasy_relevant = 1 AND position IN ('QB','RB','WR','TE') ORDER BY id`)
  .forEach((p, i) => run(`INSERT OR REPLACE INTO dynasty_values(format_key, player_id, value) VALUES (?, ?, ?)`,
    formatKey, p.id, Math.max(100, 6000 - 40 * i)));
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (9301, 'lv-route-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (9301, ?, datetime('now','+1 day'))`, hashSessionToken('lv-token'));
run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (301, 9301, 'member')`);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, body
    ? { method: 'POST', headers: { authorization: 'Bearer lv-token', 'content-type': 'application/json' },
      body: JSON.stringify(body) }
    : { headers: { authorization: 'Bearer lv-token' } });
  return { status: res.status, body: await res.json() };
};

test('POST /evaluate: a 2-for-1 carries lineup_value on both sides, the freed spot filled from the wire', async () => {
  // Team 1 gives one RB, gets team 2's two WRs.
  const { status, body } = await call('/api/trades/301/evaluate', {
    my_team_id: '1', their_team_id: '2', give: [rb[0].id], get: [wr[3].id, wr[4].id] });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.me.value_delta != null, true, 'the summed value is still there');
  const me = body.me.lineup_value, them = body.them.lineup_value;
  assert.equal(me.status, 'not yet validated');
  assert.equal(me.roster_spots, 1);
  assert.equal(me.dropped.length, 1);
  assert.equal(them.roster_spots, -1);
  assert.equal(them.replacement.length, 1, 'team 2 fills its freed spot from the wire');
  const rostered = new Set(teams.flatMap(t => t.roster.entries.map(e => e.playerPoolEntry.player.fullName)));
  assert.ok(!rostered.has(them.replacement[0].name), `the replacement is unrostered: ${them.replacement[0].name}`);
  // Week 4, no league calendar in this payload -> default 14 regular + 3 playoff weeks.
  assert.equal(me.weeks, 14);
});

/**
 * The finder. GET /find is findTrades(); the seed carries no projections (every
 * ppg is 0), so over HTTP it returns no deal to read (checked: considered 0). The
 * same findTrades() is driven here on a priced fixture through its override
 * branch, which runs the same findTradesUncached() the route's cache wraps.
 */
test('findTrades (GET /find): every returned deal carries lineup_value next to value_delta', async () => {
  const { findTrades } = await import('../server/services/trade-engine.js');
  let id = 1;
  const P = (name, position, ppg, value) => ({ id: 800000 + id++, name, position, team_abbr: 'AAA',
    adj_ppg: ppg, ppg, ros_ppg: ppg, value, proj: ppg * 17 });
  const me = { roster_id: '1', owner: 'Team 1', players: [
    P('M QB', 'QB', 20, 3000), P('M RB1', 'RB', 18, 5000), P('M RB2', 'RB', 16, 4500), P('M RB3', 'RB', 15, 4000),
    P('M WR1', 'WR', 9, 2000), P('M WR2', 'WR', 8, 1800), P('M TE', 'TE', 9, 1500), P('M WR3', 'WR', 5, 500)] };
  const them = { roster_id: '2', owner: 'Team 2', players: [
    P('T QB', 'QB', 19, 3000), P('T RB1', 'RB', 9, 2000), P('T RB2', 'RB', 8, 1800),
    P('T WR1', 'WR', 18, 5000), P('T WR2', 'WR', 16, 4500), P('T WR3', 'WR', 15, 4000),
    P('T TE', 'TE', 8, 1400), P('T RB3', 'RB', 5, 500)] };
  const wire = [P('Free WR', 'WR', 7, 600), P('Free RB', 'RB', 6, 500)];
  const assets = new Map([...me.players, ...them.players, ...wire].map(p => [p.id, p]));
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];
  const out = findTrades(lg, { myTeamId: '1', requireMutual: false, limit: 50, counterparty: false,
    teamsOverride: [me, them], assetsOverride: assets, playoffOdds: 0.5, playoffOddsSource: 'fixture' });
  assert.ok(!out.error, out.error);
  assert.ok(out.deals.length > 0, 'known-nonzero: the priced fixture produces deals');
  for (const d of out.deals) {
    assert.ok(Number.isFinite(d.me.value_delta), 'the summed value is still there');
    assert.equal(d.me.lineup_value?.status, 'not yet validated');
    assert.equal(d.them.lineup_value?.status, 'not yet validated');
    assert.equal(d.me.lineup_value.roster_spots, d.i_get.length - d.i_give.length);
  }
});
