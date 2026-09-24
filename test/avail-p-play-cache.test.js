/**
 * FIX-285-2: the title-odds caches carry the avail.p_play flag state.
 *
 * GET /api/model/:id/simulate (server/routes/model.js memo) and
 * titleOddsTrades (server/services/title-odds-trades.js _cache) both hold
 * simulated odds whose pools are priced on avail.p_play when
 * GRIDIRON_AVAIL_P_PLAY is on. Before this fix neither key named the flag, so
 * flipping it mid-process served the other state's cached odds.
 *
 * The simulator is mocked to report the flag state it ran under: the odds
 * themselves are not under test, which cached answer comes back is.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-avail-p-play-cache-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_AVAIL_P_PLAY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const flagState = () => (process.env.GRIDIRON_AVAIL_P_PLAY === '1' ? 'on' : 'off');
const realSim = await import('../server/services/season-sim.js');
mock.module('../server/services/season-sim.js', {
  namedExports: {
    ...realSim,
    simulateSeason: () => ({ from_week: 3, teams: [], ran_with_p_play: flagState() }),
    fastRescoreEnabled: () => false,
    tradeImpact: () => ({
      me: { title_before: 0.1, title_after: 0.2, title_delta: flagState() === 'on' ? 0.05 : 0.01 },
      them: { title_delta: 0 }
    })
  }
});
const realTe = await import('../server/services/trade-engine.js');
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTe,
    findTrades: () => ({ deals: [{ partner: 'P', partner_id: '2',
      i_give: [{ id: 1, name: 'A', position: 'WR', value: 1 }], i_get: [{ id: 2, name: 'B', position: 'WR', value: 1 }] }] })
  }
});

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: modelRouter } = await import('../server/routes/model.js');
const { titleOddsTrades } = await import('../server/services/title-odds-trades.js');
const { pPlayCacheTag } = await import('../server/services/avail-p-play.js');
const express = (await import('express')).default;

run(`INSERT INTO users (subject, display_name) VALUES ('fix2852', 'fix2852')`);
const userId = rows('SELECT last_insert_rowid() AS id')[0].id;
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`,
  userId, hashSessionToken('fix2852-token'));
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, espn_s2, swid, connection_status, current_week, payload_season, fetched_at)
     VALUES (2852, 'espn', 'espn-2852', 2026, 'Cache League', '{"teams":[]}', 6, '1', '["WR"]', 'x', 'y',
     'connected', 3, 2026, '2026-09-20T00:00:00Z')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (2852, ?, 'commissioner')`, userId);

const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/model`;
const auth = { Authorization: 'Bearer fix2852-token' };

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const withFlag = async (value, fn) => {
  const saved = process.env.GRIDIRON_AVAIL_P_PLAY;
  if (value == null) delete process.env.GRIDIRON_AVAIL_P_PLAY; else process.env.GRIDIRON_AVAIL_P_PLAY = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.GRIDIRON_AVAIL_P_PLAY; else process.env.GRIDIRON_AVAIL_P_PLAY = saved;
  }
};

test('the cache tag names all three flag states', async () => {
  assert.equal(await withFlag(null, pPlayCacheTag), '');
  assert.equal(await withFlag('1', pPlayCacheTag), ':pplay');
  const saved = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try { assert.equal(await withFlag(null, pPlayCacheTag), ':pplay-preview'); }
  finally { if (saved === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = saved; }
});

test('GET /simulate: toggling the flag does not return the other state\'s cached odds', async () => {
  const get = () => fetch(`${base}/2852/simulate?runs=300&seed=9`, { headers: auth }).then(r => r.json());
  const off = await withFlag(null, get);
  assert.equal(off.ran_with_p_play, 'off', JSON.stringify(off));
  const on = await withFlag('1', get);
  assert.equal(on.ran_with_p_play, 'on', 'flag on was answered from the flag-off memo');
  const offAgain = await withFlag(null, get);
  assert.equal(offAgain.ran_with_p_play, 'off', 'flag off was answered from the flag-on memo');
});

test('titleOddsTrades: toggling the flag does not return the other state\'s cached odds', async () => {
  const call = () => titleOddsTrades(2852, { teamId: '1', shortlist: 1, runs: 100 });
  const off = await withFlag(null, call);
  assert.equal(off.deals[0].title_delta, 0.01, JSON.stringify(off).slice(0, 300));
  const on = await withFlag('1', call);
  assert.equal(on.deals[0].title_delta, 0.05, 'flag on was answered from the flag-off cache');
  const offAgain = await withFlag(null, call);
  assert.equal(offAgain.deals[0].title_delta, 0.01, 'flag off was answered from the flag-on cache');
  assert.equal(offAgain, off, 'control: the same state still hits its own cache');
});
