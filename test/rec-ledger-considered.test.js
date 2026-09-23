/**
 * Considered-not-shown rows (C-08): the ideas findTrades' edge test took away
 * become rows in the recommendation ledger, so the grader has a control group.
 *
 * Until now the engine reported only counts (`edge_removed`,
 * `edge_removed_variants`, trade-engine.js return of findTradesUncached) and
 * five examples; every removed idea past the fifth was gone. A ledger of what
 * was SHOWN is a ledger of the engine's own filter, which is the reason
 * `trade_outcomes` (067) keeps `considered_only` rows too.
 *
 * Real engine, real seeded players, priced and lopsided the way
 * trade-tactics.test.js prices its league. Names are generated ("Team 1"); nothing here is real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rec-ledger-considered-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
// The edge test is the REAL one (trade-tactics.js#edgeTest) with one extra
// failing check on a deterministic subset (odd hundredths of the weekly gain).
// A priced fixture alone produced no removed idea (probe on this tree:
// considered 137, deals 30, edge_removed 0), and the wiring from "removed" to
// "row" is what is under test here, not the thresholds.
const realTactics = await import('../server/services/trade-tactics.js');
mock.module('../server/services/trade-tactics.js', {
  namedExports: {
    ...realTactics,
    edgeTest: args => {
      const real = realTactics.edgeTest(args);
      if (Math.round(Number(args?.ppgDelta) * 100) % 2 === 0) return real;
      return { ...real, passes: false, failed: [...real.failed, 'test_forced'] };
    },
  },
});
const { findTrades } = await import('../server/services/trade-engine.js');

await runMigrations();
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const entry = (p, fakeId) => ({ playerPoolEntry: { player: { id: fakeId, fullName: p.name,
  defaultPositionId: POS_ID[p.position] } } });
const pick = (position, n) => rows(`SELECT id, name, position FROM players
  WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT ?`, position, n);
// Lopsided rosters, as in trade-tactics.test.js: six identical teams produce no
// trade at all. Team 1 is WR rich and RB poor; team 2 is the mirror image.
const SHAPE = [
  { qb: 3, rb: [9, 10, 11], wr: [0, 1, 2], te: 4 },
  { qb: 0, rb: [0, 1, 2], wr: [9, 10, 11], te: 0 },
  { qb: 1, rb: [3, 4, 5], wr: [3, 4, 5], te: 1 },
  { qb: 2, rb: [6, 7, 8], wr: [6, 7, 8], te: 2 },
  { qb: 4, rb: [12, 13, 14], wr: [12, 13, 14], te: 3 },
  { qb: 5, rb: [15, 16, 17], wr: [15, 16, 17], te: 5 },
];
function sixTeamLeague() {
  const qb = pick('QB', 6), rb = pick('RB', 18), wr = pick('WR', 18), te = pick('TE', 6);
  let fakeId = 710000;
  const teams = SHAPE.map((sh, i) => {
    const roster = [qb[sh.qb], ...sh.rb.map(k => rb[k]), ...sh.wr.map(k => wr[k]), te[sh.te]];
    return { id: i + 1, name: `Team ${i + 1}`, roster: { entries: roster.map(p => entry(p, fakeId++)) } };
  });
  return { teams, settings: { name: 'CL League' } };
}
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
     VALUES (81, 'espn', 'espn-cl-81', 2026, 'CL League', ?, 6, '1', ?)`,
JSON.stringify(sixTeamLeague()), JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
// Market values and a season projection. The seed carries neither, and the
// engine's first gate is a 0.4 ppg lineup gain, so an unpriced league searches
// nothing (considered 0), which is what find-trades.test.js's fixture does.
const { deriveFormat } = await import('../server/services/format.js');
const FORMAT_KEY = deriveFormat(rows('SELECT * FROM leagues WHERE id = 81')[0]).formatKey;
const PRICE = { QB: 4200, RB: 6800, WR: 6400, TE: 3200 };
const PROJ = { QB: [340, 9], RB: [300, 8], WR: [290, 7], TE: [200, 6] };
for (const [pos, n] of [['QB', 6], ['RB', 18], ['WR', 18], ['TE', 6]]) {
  pick(pos, n).forEach((p, i) => {
    const value = Math.round(PRICE[pos] * (1 - i * 0.028));
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank,
         fetched_at) VALUES (?,?,?,?,0,25,?,datetime('now'))`, FORMAT_KEY, p.id, value, value, i + 1);
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?,?,'projected',?,17,'{}',datetime('now'))`, p.id, 2026, PROJ[pos][0] - i * PROJ[pos][1]);
  });
}
const lg = rows(`SELECT id, platform, league_id, season, name, payload, team_count, my_team_id, ppr,
  superflex, roster_positions, league_type, current_week, payload_season FROM leagues WHERE id = 81`)[0];

const considered = () => rows(`SELECT kind, disposition, season, week, horizon, predicted_json
  FROM rec_ledger WHERE league_id = 81 ORDER BY id`);

test('every idea the edge test removed becomes a considered-not-shown trade row at +2 and +5', () => {
  const found = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 100 });
  assert.ok(!found.error, found.error);
  // Known-nonzero control: the fixture must actually produce removed ideas, or
  // a zero-row ledger below would prove nothing.
  assert.ok(found.edge_removed > 0, `fixture produced no edge-removed ideas (${found.edge_removed})`);
  const r = considered();
  assert.equal(r.length, found.edge_removed * 2);
  assert.ok(r.every(x => x.kind === 'trade' && x.disposition === 'considered_not_shown'));
  assert.deepEqual([...new Set(r.map(x => x.horizon))].sort(), [2, 5]);
  assert.ok(r.every(x => x.season === found.context.season && x.week === found.context.week));
  const p = JSON.parse(r[0].predicted_json);
  assert.ok(Array.isArray(p.give) && p.give.length && Number.isInteger(p.give[0].id));
  assert.ok(Array.isArray(p.get) && p.get.length && Number.isInteger(p.get[0].id));
  assert.ok(Array.isArray(p.failed) && p.failed.length, 'a removed idea carries the checks it failed');
  assert.equal(p.source, 'find:edge_removed');
  // The engine does not write the SHOWN deals; the route does (recordRoute).
  assert.equal(rows(`SELECT COUNT(*) n FROM rec_ledger WHERE league_id = 81 AND disposition = 'shown'`)[0].n, 0);
});

test('a cached second search writes nothing new', () => {
  const before = considered().length;
  findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 100 });
  assert.equal(considered().length, before);
});

test('the real waiver board carries player ids, so a claim reaches the ledger as a gradable row', async () => {
  const { waiverBoard } = await import('../server/services/waiver-wire.js');
  const { recordRoute } = await import('../server/services/rec-ledger.js');
  // A free agent (a seeded RB on no roster) priced well above team 1's backs.
  const [fa] = rows(`SELECT id FROM players WHERE position = 'RB' AND fantasy_relevant = 1
    ORDER BY id LIMIT 1 OFFSET 25`);
  run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank,
       fetched_at) VALUES (?,?,?,?,0,25,1,datetime('now'))`, FORMAT_KEY, fa.id, 7000, 7000);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
       VALUES (?,?,'projected',?,17,'{}',datetime('now'))`, fa.id, 2026, 420);
  const board = waiverBoard(lg, { myTeamId: '1', limit: 20, minProjected: 0 });
  assert.ok(!board.error, board.error);
  // Known-nonzero control: the priced free agent is on the board. With no game
  // lines in the fixture every this-week number is 0, so he is a stash (a
  // rest-of-season claim), not an immediate one.
  const claim = [...board.immediate, ...board.stashes].find(b => b.player_id === fa.id);
  assert.ok(claim, `the priced free agent is not on the board: ${JSON.stringify(board.stashes.map(b => b.player))}`);
  const drop = board.immediate.includes(claim) ? claim.drop_candidate : claim.ros_drop_candidate;
  assert.ok(Number.isInteger(drop?.player_id), 'the drop carries its id');
  const out = recordRoute('waivers', lg, board);
  assert.ok(out.inserted >= 2, JSON.stringify(out));
  const [w] = rows(`SELECT predicted_json FROM rec_ledger WHERE league_id = 81 AND kind = 'waiver'
    AND predicted_json LIKE ? LIMIT 1`, `%"id":${fa.id},%`);
  assert.equal(JSON.parse(w.predicted_json).drop.id, drop.player_id);
});
