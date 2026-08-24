import test from 'node:test';
import assert from 'node:assert/strict';
import { slotForPick, pickNumbersForSlot, assignRosterSlots, DEFAULT_ROSTER_POSITIONS, isDraftComplete } from '../server/draft/engine.js';

/* --------------------------------------------------------------- pick order */

test('snake order alternates direction every round', () => {
  const teamCount = 4;
  // Round 1: 1 2 3 4 | Round 2: 4 3 2 1 | Round 3: 1 2 3 4
  const expected = [1, 2, 3, 4, 4, 3, 2, 1, 1, 2, 3, 4];
  const actual = expected.map((_, i) => slotForPick(i + 1, teamCount, 'snake'));
  assert.deepEqual(actual, expected);
});

test('linear order is the same team sequence every round', () => {
  const teamCount = 4;
  const expected = [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4];
  const actual = expected.map((_, i) => slotForPick(i + 1, teamCount, 'linear'));
  assert.deepEqual(actual, expected);
});

test('third_round_reversal repeats round 2s direction in round 3, then resumes alternating', () => {
  const teamCount = 4;
  // R1 asc, R2 desc, R3 desc (the reversal), R4 asc, R5 desc, R6 asc
  const expected = [
    1, 2, 3, 4,       // round 1
    4, 3, 2, 1,       // round 2
    4, 3, 2, 1,       // round 3 — repeats round 2's direction instead of flipping back
    1, 2, 3, 4,       // round 4
    4, 3, 2, 1,       // round 5
    1, 2, 3, 4,       // round 6
  ];
  const actual = expected.map((_, i) => slotForPick(i + 1, teamCount, 'third_round_reversal'));
  assert.deepEqual(actual, expected);
});

test('every pick number maps to exactly one slot, and every slot gets rounds picks', () => {
  const teamCount = 6, rounds = 4;
  for (const orderType of ['snake', 'linear', 'third_round_reversal']) {
    const bySlot = new Map();
    for (let p = 1; p <= teamCount * rounds; p++) {
      const slot = slotForPick(p, teamCount, orderType);
      bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1);
    }
    assert.equal(bySlot.size, teamCount, `${orderType}: every slot should appear`);
    for (const count of bySlot.values()) assert.equal(count, rounds, `${orderType}: every slot should pick exactly once per round`);
  }
});

test('pickNumbersForSlot agrees with slotForPick', () => {
  const teamCount = 8, rounds = 3;
  for (const orderType of ['snake', 'linear', 'third_round_reversal']) {
    for (let slot = 1; slot <= teamCount; slot++) {
      const picks = pickNumbersForSlot(slot, teamCount, rounds, orderType);
      assert.equal(picks.length, rounds);
      for (const p of picks) assert.equal(slotForPick(p, teamCount, orderType), slot);
    }
  }
});

test('rejects an unknown order_type rather than silently defaulting', () => {
  assert.throws(() => slotForPick(1, 10, 'random-draft'), /unknown draft order_type/);
});

test('isDraftComplete is exact at the boundary', () => {
  const draft = { team_count: 10, rounds: 5 };
  assert.equal(isDraftComplete(draft, 49), false);
  assert.equal(isDraftComplete(draft, 50), true);
  assert.equal(isDraftComplete(draft, 51), true);
});

/* -------------------------------------------------------- roster assignment */

test('FLEX fills from RB/WR/TE only, never QB, after dedicated slots are full', () => {
  const players = [
    { position: 'QB' }, { position: 'RB' }, { position: 'RB' }, { position: 'WR' },
    { position: 'WR' }, { position: 'TE' }, { position: 'RB' }, { position: 'QB' },
  ];
  const { assigned, unfilled } = assignRosterSlots(players, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 2 });
  assert.equal(assigned.QB.length, 1);
  assert.equal(assigned.RB.length, 2);
  assert.equal(assigned.WR.length, 2);
  assert.equal(assigned.TE.length, 1);
  assert.equal(assigned.FLEX.length, 1);
  assert.equal(assigned.FLEX[0].position, 'RB', 'the third RB should fill FLEX, not sit on the bench ahead of it');
  assert.deepEqual(unfilled, {});
});

test('SUPERFLEX accepts a second QB when every other slot is already spoken for', () => {
  const players = [
    { position: 'QB', id: 1 }, { position: 'QB', id: 2 }, { position: 'RB', id: 3 }, { position: 'RB', id: 4 },
    { position: 'WR', id: 5 }, { position: 'WR', id: 6 }, { position: 'TE', id: 7 },
  ];
  const { assigned } = assignRosterSlots(players, { QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1, BENCH: 0 });
  assert.equal(assigned.QB.length, 1);
  assert.equal(assigned.SUPERFLEX.length, 1);
  assert.equal(assigned.SUPERFLEX[0].position, 'QB', 'the second QB should fill SUPERFLEX since no other position is available to fill it');
});

test('reports unfilled starting slots instead of silently under-assigning', () => {
  const players = [{ position: 'RB' }, { position: 'WR' }];
  const { unfilled } = assignRosterSlots(players, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 0 });
  assert.equal(unfilled.QB, 1);
  assert.equal(unfilled.RB, 1);
  assert.equal(unfilled.TE, 1);
  assert.equal(unfilled.FLEX, 1);
});

test('DEFAULT_ROSTER_POSITIONS assigns a full standard roster with no leftovers unaccounted for', () => {
  const players = [
    { position: 'QB' }, { position: 'RB' }, { position: 'RB' }, { position: 'RB' },
    { position: 'WR' }, { position: 'WR' }, { position: 'WR' }, { position: 'TE' },
    { position: 'K' }, { position: 'DEF' },
  ];
  const { assigned, unfilled, bench } = assignRosterSlots(players, DEFAULT_ROSTER_POSITIONS);
  const totalAssigned = Object.values(assigned).reduce((n, arr) => n + arr.length, 0);
  assert.equal(totalAssigned + bench.length, players.length);
  assert.deepEqual(unfilled, {});
});
