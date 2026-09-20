/**
 * Trade Lab reported a confident NEED at every position the board cannot price
 * (2026-09-20).
 *
 * `analyzeLeague` ranks each team's position group against the league average:
 *
 *   const ratio = p.starter_value / (avg[pos] || 1);
 *   if (ratio < WEAK) { p.status = 'need'; t.needs.push(...) }
 *
 * `starter_value` sums `Math.max(0, p.vor)`, and `vor` is `v?.vor ?? 0` from
 * `vorBoard` — so a position with no projections on the board gives EVERY team a
 * starter_value of 0, a league average of 0, and then `0 / (0 || 1)` = 0. Zero is
 * below `WEAK`, so the position comes back `status: 'need'` with `ratio: 0` and a
 * gap of 0: the strongest possible verdict, derived from the complete absence of
 * information. There is no verdict to give there.
 *
 * This is not hypothetical on Nick's deployment; it is the normal state for any
 * position the corpus has not priced.
 *
 * It does not stop at the page. `trade-engine.js:156` builds
 * `needs: new Set(t.needs.map(n => n.position))` from this list, and that set is
 * passed as `theirNeeds` into offer generation and into the memo copy. So an
 * unpriceable position becomes a counterparty's stated need, and the engine
 * proposes trades to fill it.
 *
 * The fix is the one `routes/leagues.js:396-404` already made for the same
 * expression, and its comment is the spec:
 *
 *   "`starter_value / (averages[pos] || 1)` turned a league-wide 0 into a ratio
 *    of 0, i.e. a confident NEED, for a position nobody has a price for. There is
 *    no verdict to give there."
 *
 * League Hub got that guard; Trade Lab did not. Now both say `ratio: null`,
 * `status: 'unknown'`, and neither counts it as a need or a surplus.
 *
 * Both leagues below are built from the same rosters. QB, RB and WR carry
 * projections and therefore reach the VOR board; TE carries none and therefore
 * cannot. That contrast is the point: a fix that simply stopped reporting needs
 * would pass a test that only checked TE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-board-need-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');

const { analyzeLeague } = await import('../server/routes/tradelab.js');
const { deriveFormat } = await import('../server/services/format.js');
const { vorBoard } = await import('../server/routes/edge.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const POSITION_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
// TE is the unpriced one. Everything else reaches the board.
const PRICED = ['QB', 'RB', 'WR'];

const pool = Object.fromEntries(POSITIONS.map(pos => [pos,
  rows(`SELECT id, name FROM players WHERE position = ? AND fantasy_relevant = 1
        ORDER BY id LIMIT 4`, pos)]));
for (const pos of POSITIONS) {
  assert.equal(pool[pos].length, 4, `the seed must supply four distinct ${pos}s`);
}

// Four teams. Team 1 is deliberately thin at WR — a priced position where a real
// need exists — so the guard below can be shown NOT to suppress a genuine verdict.
// Projections descend across the teams rather than repeating. That is not
// decoration: VOR is `proj - replacementLevel`, and with one QB per team in a
// four-team league the replacement level IS the fourth-best QB, so four identical
// projections give every QB a VOR of exactly 0 and the QB average collapses to
// zero too — which would make QB a second unpriced position and destroy the
// contrast this file is built on.
const SQUADS = [
  { id: 1, name: 'Thin At Receiver', proj: { QB: 340, RB: 300, WR: 40 } },
  { id: 2, name: 'Balanced',         proj: { QB: 320, RB: 280, WR: 250 } },
  { id: 3, name: 'Balanced Two',     proj: { QB: 300, RB: 260, WR: 240 } },
  { id: 4, name: 'Balanced Three',   proj: { QB: 280, RB: 240, WR: 230 } }
];

// The whole fixture turns on this loop: a projected row is what puts a player on
// the VOR board, so TE is skipped and gets `vor: 0` for everyone by the same route
// a real unpriced position does — not by a special case written into the test.
for (const [i, squad] of SQUADS.entries()) {
  for (const pos of PRICED) {
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games)
         VALUES (?,2026,'projected',?,17)`, pool[pos][i].id, squad.proj[pos]);
  }
}

const entry = p => ({ playerPoolEntry: { player: {
  id: p.id, fullName: p.name, defaultPositionId: POSITION_ID[p.position] } } });

run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, league_type, connection_status)
     VALUES (801, 'espn', 'need-801', 2026, 'Board Needs', ?, 4, '1', ?, 'redraft', 'connected')`,
  JSON.stringify({ teams: SQUADS.map((squad, i) => ({
    id: squad.id, name: squad.name,
    roster: { entries: POSITIONS.map(pos => entry({ ...pool[pos][i], position: pos })) }
  })) }),
  JSON.stringify(SLOTS));
const lg = row('SELECT * FROM leagues WHERE id = 801');

// Prices, so the teams resolve and carry market capital. Not what this file is
// about — `starter_value` is built from `vor`, not from these — but without them
// `leagueRosters` has nothing to match and every squad comes back empty.
const { formatKey } = deriveFormat(lg);
for (const pos of POSITIONS) {
  for (const p of pool[pos]) {
    run(`INSERT OR REPLACE INTO dynasty_values (format_key, player_id, value, age, pos_rank, fetched_at)
         VALUES (?,?,?,?,?, '2026-09-20T00:00:00Z')`, formatKey, p.id, 40, 25, 1);
  }
}

const analysis = analyzeLeague(lg);
const teams = analysis.teams;
const byName = Object.fromEntries(teams.map(t => [t.owner, t]));

test('the fixture really does leave one position unpriced and the rest priced', () => {
  // Without this the rest of the file could pass over a board that prices nothing,
  // where "no need reported" is true for an entirely different reason.
  const board = vorBoard(4);
  const onBoard = pos => board.filter(p => p.position === pos).length;
  for (const pos of PRICED) assert.ok(onBoard(pos) > 0, `${pos} must reach the VOR board`);
  assert.equal(onBoard('TE'), 0, 'and TE must not, or there is no unpriced position here');
  assert.equal(teams.length, 4);
});

test('and the league average really is zero there, and non-zero elsewhere', () => {
  // The premise the defect needs. Asserted from the payload rather than assumed,
  // because if TE ever gained a price this file would go quietly vacuous.
  const avg = pos => teams.reduce((s, t) => s + t.positions[pos].starter_value, 0) / teams.length;
  assert.equal(avg('TE'), 0);
  for (const pos of PRICED) assert.ok(avg(pos) > 0, `${pos} must have a real average`);
});

test('a position the board cannot price is unknown, not a need', () => {
  for (const t of teams) {
    assert.equal(t.positions.TE.ratio, null, `${t.owner}: no ratio without an average`);
    assert.equal(t.positions.TE.status, 'unknown', `${t.owner}: and no verdict either`);
  }
});

test('and it is not counted as a need or a surplus', () => {
  for (const t of teams) {
    assert.ok(!t.needs.some(n => n.position === 'TE'),
      `${t.owner}: an unpriced position must not reach the needs list`);
    assert.ok(!t.surplus.some(s => s.position === 'TE'),
      `${t.owner}: nor the surplus list`);
  }
});

test('a team with nothing at a position the league CAN price is still a need', () => {
  // The control that makes the three above mean something, and the sharpest form
  // of it. This team's receiver is below replacement, so his VOR floors at 0 and
  // his starter_value is 0 — the same zero the unpriced position produces, on the
  // same team, in the same payload. The guard must key on the LEAGUE AVERAGE being
  // zero, not on any team's value being zero, or it suppresses exactly the verdict
  // a manager most needs to see.
  const wrAvg = teams.reduce((s, t) => s + t.positions.WR.starter_value, 0) / teams.length;
  assert.ok(wrAvg > 0, 'the league must be able to price receivers, or this proves nothing');
  const thin = teams.find(t => t.positions.WR.starter_value === 0);
  assert.ok(thin, 'and one team must have nothing startable there');
  assert.equal(thin.positions.WR.ratio, 0);
  assert.equal(thin.positions.WR.status, 'need');
  assert.ok(thin.needs.some(n => n.position === 'WR'),
    'a real hole is still reported as a hole');
});

test('the priced positions still carry a real ratio on every team', () => {
  // The guard must fire on the average being zero, not on any team being zero.
  for (const t of teams) {
    for (const pos of PRICED) {
      assert.equal(typeof t.positions[pos].ratio, 'number', `${t.owner} ${pos}`);
      assert.notEqual(t.positions[pos].status, 'unknown', `${t.owner} ${pos}`);
    }
  }
});

test('the needs that reach the trade engine no longer include it', () => {
  // The consumer, not the producer: trade-engine.js:156 builds
  // `new Set(t.needs.map(n => n.position))` from exactly this list and passes it
  // as `theirNeeds` into offer generation and the memo copy.
  for (const t of teams) {
    const asEngineSees = new Set(t.needs.map(n => n.position));
    assert.ok(!asEngineSees.has('TE'), `${t.owner}: TE must not become a counterparty need`);
  }
});
