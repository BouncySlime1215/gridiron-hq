/**
 * NUMBERS-PEOPLE "Going forward": when the lanes differed, which lane was right, with an honest n.
 *
 * Pinned here:
 *   - only DIFFER reads are scored, the last one per item per week
 *   - a trade call settles on a resolved trade_outcomes row offered after the read (accepted: "go"
 *     was right; declined / expired / ignored: "wait" and "avoid" were); an open or countered
 *     offer has not settled
 *   - a target call settles on his points per game after the read vs before it (at least two
 *     games after); too few games is still pending
 *   - under MIN_N settled reads the board says so (enough: false) and still reports n
 * Ids and made-up data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-np-score-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { saveRun } = await import('../server/services/numbers-people/store.js');
const { scoreboard, MIN_N } = await import('../server/services/numbers-people/scoreboard.js');

const L = 7;
const lane = stance => ({ stance, basis: 'price', why: 'x', cites: [] });
function differ(type, id, a, b, { week = 3, at = '2026-09-20T12:00:00.000Z' } = {}) {
  const runId = saveRun(db, { leagueId: L, week, planAt: null, inputsHash: 'h', trigger: 'schedule', status: 'ok',
    reads: [{ item: { item_type: type, item_id: id }, lane_a: lane(a), lane_b: lane(b), verdict: a === b ? 'agree' : 'differ' }] });
  run('UPDATE numbers_people_reads SET created_at = ? WHERE run_id = ?', at, runId);
}
let tx = 0;
const outcome = (counterparty, status, { proposed = '2026-09-21T00:00:00Z', moveId = null } = {}) => run(
  `INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, status, espn_tx_id, proposed_at, created_at, move_id)
   VALUES (?, 2026, 'observed', '1', ?, ?, ?, ?, ?, ?)`, L, counterparty, status, `t${++tx}`, proposed, proposed, moveId);

// Points: player 50 went up after week 3, player 51 went down, player 52 has only one game after.
const actualsFor = () => new Map([
  [50, { weeks: new Map([[1, 8], [2, 10], [3, 20], [4, 22]]) }],
  [51, { weeks: new Map([[1, 20], [2, 18], [3, 6], [4, 4]]) }],
  [52, { weeks: new Map([[1, 10], [2, 10], [3, 30]]) }]
]);
const board = () => scoreboard(db, L, { me: '1', season: 2026, actualsFor });

test('nothing settled: an honest zero, not a score', () => {
  differ('partner', '9', 'go', 'avoid');                       // no outcome yet
  outcome('9', 'proposed');                                    // an open offer is not an outcome
  const b = board();
  assert.equal(b.n, 0);
  assert.equal(b.enough, false);
  assert.equal(b.pending, 1);
});

test('trade and points outcomes settle; below MIN_N the board says not enough', () => {
  differ('partner', '2', 'go', 'avoid');                       // accepted -> numbers right
  outcome('2', 'accepted');
  differ('partner', '3', 'go', 'wait');                        // declined -> people right
  outcome('3', 'declined');
  differ('partner', '4', 'go', 'wait');                        // offered BEFORE the read: not this read's outcome
  outcome('4', 'accepted', { proposed: '2026-09-10T00:00:00Z' });
  differ('target', '50', 'wait', 'go');                        // points up -> people right
  differ('target', '52', 'go', 'wait');                        // one game after: pending
  const b = board();
  assert.equal(b.n, 3);
  assert.equal(b.enough, false, `${b.n} < ${MIN_N}`);
  assert.equal(b.numbers_right, 1);
  assert.equal(b.people_right, 2);
  assert.equal(b.pending, 3, 'partner 9, partner 4 and target 52');
});

test('at MIN_N the score counts; wait vs avoid on a bad outcome is both right; the last read of a week wins', () => {
  differ('target', '51', 'go', 'avoid');                       // points down -> people right
  differ('move', 'M1', 'avoid', 'go');                         // accepted by move id -> people right
  outcome('5', 'accepted', { moveId: 'M1' });
  differ('partner', '6', 'wait', 'avoid');                     // expired -> both right
  outcome('6', 'expired');
  // A second read of partner 2 in the same week that flipped: only the last one is scored.
  differ('partner', '2', 'avoid', 'go', { at: '2026-09-20T18:00:00.000Z' });
  const b = board();
  assert.equal(b.n, 6);
  assert.equal(b.enough, true);
  assert.deepEqual([b.numbers_right, b.people_right, b.both_right], [0, 5, 1]);
  assert.deepEqual(b.by_type, { move: 1, target: 2, partner: 3 });
});
