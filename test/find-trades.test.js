import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-find-trades-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
// Side-effect imports: same "~40 files create tables on import" wiring the
// rest of the suite relies on (see test/post-draft-plan.test.js).
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { findTrades } = await import('../server/services/trade-engine.js');

await runMigrations();
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
function entry(player, fakeId) {
  return { playerPoolEntry: { player: { id: fakeId, fullName: player.name, defaultPositionId: POS_ID[player.position] } } };
}
function espnPlayers(position, n) {
  return rows(`SELECT id, name, position FROM players
              WHERE position = ? AND fantasy_relevant = 1
              ORDER BY id LIMIT ?`, position, n);
}
function insertLeague(id, payload) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'FT League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
    id, `espn-ft-${id}`, JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}

// Six real drafted teams (not just two) — a small but genuine multi-partner
// league, so findTrades has more than one possible counterparty to search.
function sixTeamLeague() {
  const qb = espnPlayers('QB', 6), rb = espnPlayers('RB', 18), wr = espnPlayers('WR', 18), te = espnPlayers('TE', 6);
  let fakeId = 700000;
  const teams = [];
  for (let i = 0; i < 6; i++) {
    const roster = [qb[i], ...rb.slice(i * 3, i * 3 + 3), ...wr.slice(i * 3, i * 3 + 3), te[i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, roster: { entries: roster.map(p => entry(p, fakeId++)) } });
  }
  return { teams, settings: { name: 'FT League' } };
}

test('requireMutual=false still only returns real, fair, no-red-flag deals — not everything unfiltered', () => {
  insertLeague(201, sixTeamLeague());
  const lg = rows('SELECT * FROM leagues WHERE id = 201')[0];

  const relaxed = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 100 });
  assert.ok(!relaxed.error, relaxed.error);
  for (const d of relaxed.deals) {
    assert.equal(d.plausible, true, `every deal in the relaxed set must still be plausible: ${JSON.stringify(d.red_flags)}`);
    assert.equal(d.red_flags.length, 0, 'every deal in the relaxed set must have no red flags');
  }
});

test('requireMutual=true is a strict subset of requireMutual=false (every mutual deal is also plausible)', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 201')[0];
  const strict = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: true, limit: 100 });
  const relaxed = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 100 });

  const relaxedKeys = new Set(relaxed.deals.map(d => `${d.partner_id}:${d.i_give.map((p) => p.id).sort()}:${d.i_get.map((p) => p.id).sort()}`));
  for (const d of strict.deals) {
    assert.equal(d.mutual, true, 'requireMutual=true must never return a non-mutual deal');
    const key = `${d.partner_id}:${d.i_give.map((p) => p.id).sort()}:${d.i_get.map((p) => p.id).sort()}`;
    assert.ok(relaxedKeys.has(key), 'every strict-mode deal must also appear in the relaxed set');
  }
  assert.ok(relaxed.deals.length >= strict.deals.length, 'relaxing mutual must never find FEWER real deals');
});

test('a second identical search is served from cache, not recomputed, until the underlying data changes', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 201')[0];
  const first = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: true, limit: 100 });
  const second = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: true, limit: 100 });
  // Same object reference is the cache's own contract (compute-cache.js
  // returns the stored value directly on a hit) — not just equal content.
  assert.equal(second, first, 'an identical search must return the cached result, not a fresh computation');

  // A real roster change (a manager profile flips to "never trade") must
  // still invalidate the cache — it must never go stale just because it's fast.
  run(`INSERT INTO manager_profiles (league_id, roster_id, tradeability) VALUES (?,?,'never')
       ON CONFLICT(league_id, roster_id) DO UPDATE SET tradeability='never'`, 201, '2');
  const third = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: true, limit: 100 });
  assert.notEqual(third, first, 'a real underlying change must bust the cache, not silently keep serving the old answer');
});
