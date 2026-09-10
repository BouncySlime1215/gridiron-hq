/**
 * Codex plan section 6.3, the T−60 decision-time protocol — specifically the
 * capacity rule, which the plan singles out as unreproducible today:
 *
 *   "The existing policy ranks the entire week's candidates and keeps five.
 *    This cannot be reused as a retrospective ranking of all games' eventual
 *    T−60 outputs. At Thursday's cutoff, Sunday/Monday T−60 inputs do not
 *    exist. ... process cutoff batches chronologically, rank only candidates
 *    available in the same batch, consume the remaining predeclared weekly
 *    slots, and preserve exclusions after capacity is reached. ... Reserve a
 *    slot on selection, commit it on a qualifying paper observation/
 *    acceptance, and release it on failed refresh or expiry; released
 *    capacity becomes available only to later cutoff batches."
 *
 * Every test below pins one clause of that paragraph.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decisionCutoff, cutoffBatches, sequentialCapacity, retrospectiveWeeklyCapacity,
  DECISION_LEAD_MINUTES, T60_PROTOCOL_VERSION } from '../server/services/nfl-t60-protocol.js';

const game = (id, kickoff, edge) => ({ id, kickoff, edge_points: edge });

/** A realistic NFL week: Thursday night, the Sunday windows, Monday night. */
const WEEK = [
  game('thu', '2026-09-17T00:15:00Z', 6.0),
  game('sun-early-a', '2026-09-20T17:00:00Z', 9.0),
  game('sun-early-b', '2026-09-20T17:00:00Z', 8.0),
  game('sun-early-c', '2026-09-20T17:00:00Z', 7.0),
  game('sun-late-a', '2026-09-20T20:25:00Z', 10.0),
  game('sun-late-b', '2026-09-20T20:25:00Z', 4.0),
  game('mon', '2026-09-22T00:15:00Z', 11.0)
];

const batchesOf = games => cutoffBatches(games).map(b => ({
  ...b, candidates: b.games.map(g => ({ id: g.id, edge_points: g.edge_points }))
}));

test('the decision instant is exactly 60 minutes before kickoff, and carries the schedule version that set it', () => {
  const c = decisionCutoff('2026-09-20T17:00:00Z', { scheduleVersion: 'nflverse-2026-09-15' });
  assert.equal(c.cutoff_at, '2026-09-20T16:00:00.000Z');
  assert.equal(c.lead_minutes, DECISION_LEAD_MINUTES);
  assert.equal(c.schedule_version, 'nflverse-2026-09-15');
  assert.equal(c.protocol_version, T60_PROTOCOL_VERSION);
  assert.equal(decisionCutoff('not a time'), null, 'an unparseable kickoff has no cutoff, never a guessed one');
});

test('games are grouped into chronological cutoff batches, earliest first', () => {
  const batches = cutoffBatches(WEEK);
  assert.deepEqual(batches.map(b => b.cutoff_at), [
    '2026-09-16T23:15:00.000Z', // Thursday
    '2026-09-20T16:00:00.000Z', // Sunday early
    '2026-09-20T19:25:00.000Z', // Sunday late
    '2026-09-21T23:15:00.000Z'  // Monday
  ]);
  assert.deepEqual(batches[1].games.map(g => g.id), ['sun-early-a', 'sun-early-b', 'sun-early-c']);
});

test('THE CORE CLAUSE: a Thursday decision cannot be ranked against Sunday candidates that do not exist yet', () => {
  const result = sequentialCapacity(batchesOf(WEEK), { weeklySlots: 5 });
  const thursday = result.decisions.find(d => d.id === 'thu');
  // Thursday's edge of 6.0 would NOT make the week's top five if the whole
  // week were ranked together (9, 10, 11, 8, 7 all beat it). Under the only
  // policy that is actually executable at T-60, Thursday is selected: at its
  // own cutoff it is the sole candidate and the week is entirely unspent.
  assert.equal(thursday.selected, true,
    'at Thursday\'s cutoff there is nothing else to compare against and five slots are free');

  const retrospective = retrospectiveWeeklyCapacity(batchesOf(WEEK), { weeklySlots: 5 });
  assert.equal(retrospective.decisions.find(d => d.id === 'thu').selected, false,
    'the whole-week ranking drops Thursday -- which it can only do with information from later in the week');
  assert.match(retrospective.caveat, /NOT a T-60-reproducible policy/);
});

test('capacity is consumed chronologically, so a later, better candidate can be excluded by an earlier, worse one', () => {
  const result = sequentialCapacity(batchesOf(WEEK), { weeklySlots: 5 });
  const selected = result.decisions.filter(d => d.selected).map(d => d.id);
  // Thursday (1) + three Sunday-early (4) + the best Sunday-late (5) = full.
  assert.deepEqual(selected, ['thu', 'sun-early-a', 'sun-early-b', 'sun-early-c', 'sun-late-a']);
  // Monday's 11.0 -- the single best edge of the entire week -- never gets a
  // slot, because the week's capacity was already spent before it existed.
  // That is a real cost of an honest sequential policy, and it is recorded
  // rather than hidden.
  const monday = result.decisions.find(d => d.id === 'mon');
  assert.equal(monday.selected, false);
  assert.equal(monday.exclusion_reason, 'weekly_capacity_exhausted_at_this_cutoff');
  assert.equal(result.summary.excluded_for_capacity, 2); // sun-late-b and mon
});

test('within one batch, candidates ARE ranked against each other — that comparison is legitimate', () => {
  const oneBatch = batchesOf([
    game('a', '2026-09-20T17:00:00Z', 3.0),
    game('b', '2026-09-20T17:00:00Z', 9.0),
    game('c', '2026-09-20T17:00:00Z', 6.0)
  ]);
  const result = sequentialCapacity(oneBatch, { weeklySlots: 2 });
  assert.deepEqual(result.decisions.filter(d => d.selected).map(d => d.id), ['b', 'c'],
    'these three share a cutoff, so ranking them against each other uses no future information');
  assert.equal(result.decisions.find(d => d.id === 'a').exclusion_reason, 'weekly_capacity_exhausted_at_this_cutoff');
});

test('a pending reservation counts against the cap — capacity that might still be used is not free', () => {
  const result = sequentialCapacity(batchesOf(WEEK), { weeklySlots: 2 });
  assert.equal(result.summary.reserved, 2);
  assert.equal(result.summary.selected, 2);
  assert.equal(result.decisions.filter(d => d.exclusion_reason).length, 5);
});

test('a RELEASED slot returns capacity to later batches only, never retroactively to an excluded earlier one', () => {
  // Thursday's bet fails its refresh and releases its slot. Two Sunday-early
  // games are committed. With 2 weekly slots: Thursday reserves then
  // releases, so Sunday-early gets the freed capacity.
  // Codex correction C12: a release now carries the instant it happened.
  // Thursday's slot comes free on the Thursday night, long before Sunday's
  // 16:00 cutoff, so Sunday genuinely does inherit that capacity.
  const result = sequentialCapacity(batchesOf(WEEK), {
    weeklySlots: 2,
    outcomes: {
      thu: { state: 'released', at: '2026-09-17T00:30:00Z' },
      'sun-early-a': { state: 'committed' }
    }
  });
  assert.equal(result.summary.released, 1);
  const selected = result.decisions.filter(d => d.selected).map(d => d.id);
  // Thursday took a slot and released it; that capacity reappears for the
  // Sunday-early batch, which now fits two rather than one.
  assert.deepEqual(selected, ['thu', 'sun-early-a', 'sun-early-b']);
  assert.equal(result.decisions.find(d => d.id === 'sun-early-c').exclusion_reason,
    'weekly_capacity_exhausted_at_this_cutoff');
  assert.match(result.summary.note, /never revisited when a later slot frees up/);
});

test('the whole policy is a pure function: identical frozen batches reproduce identical decisions', () => {
  const a = sequentialCapacity(batchesOf(WEEK), { weeklySlots: 5 });
  const b = sequentialCapacity(batchesOf(WEEK), { weeklySlots: 5 });
  assert.deepEqual(a.decisions, b.decisions);
  assert.deepEqual(a.slots, b.slots);
});

test('ties inside a batch break deterministically, so a replay cannot reorder them', () => {
  const tied = batchesOf([
    game('zebra', '2026-09-20T17:00:00Z', 5.0),
    game('alpha', '2026-09-20T17:00:00Z', 5.0)
  ]);
  const result = sequentialCapacity(tied, { weeklySlots: 1 });
  assert.deepEqual(result.decisions.filter(d => d.selected).map(d => d.id), ['alpha']);
});

test('an empty week produces an empty, honest result rather than throwing', () => {
  const result = sequentialCapacity([], { weeklySlots: 5 });
  assert.deepEqual(result.decisions, []);
  assert.equal(result.summary.selected, 0);
  assert.deepEqual(cutoffBatches([]), []);
  assert.deepEqual(cutoffBatches(null), []);
});

/* ======================================================================
 * Codex correction C12 — "Sequential capacity exists as a helper, not a
 * durable decision path." Its close-with list begins with the release-time
 * counterexample, which is the defect the API shape made possible.
 * ====================================================================== */

test('C12: a slot released AFTER a later batch\'s cutoff is still held at that cutoff', () => {
  // The audit's exact counterexample, at the scale it describes: one slot,
  // A reserved at its cutoff, released ten minutes later, B's cutoff five
  // minutes after A's. Handed A's FINAL state, the old code saw a free slot
  // and let B in -- but nobody standing at B's cutoff could have known the
  // slot would come free five minutes afterwards.
  const twoGames = [
    game('A', '2026-09-20T13:00:00Z', 9),   // cutoff 12:00
    game('B', '2026-09-20T13:05:00Z', 8)    // cutoff 12:05
  ];
  const refused = sequentialCapacity(batchesOf(twoGames), {
    weeklySlots: 1,
    outcomes: { A: { state: 'released', at: '2026-09-20T12:10:00Z' } }
  });
  const b = refused.decisions.find(d => d.id === 'B');
  assert.equal(b.selected, false,
    'at 12:05 the only slot was still held; a 12:10 release cannot reach backwards');
  assert.equal(b.exclusion_reason, 'weekly_capacity_exhausted_at_this_cutoff');

  // Released BEFORE B's cutoff, the capacity is genuinely available.
  const allowed = sequentialCapacity(batchesOf(twoGames), {
    weeklySlots: 1,
    outcomes: { A: { state: 'released', at: '2026-09-20T12:02:00Z' } }
  });
  assert.equal(allowed.decisions.find(d => d.id === 'B').selected, true);
});

test('C12: a release with NO recorded time is treated as still held', () => {
  // "We do not know when it came free" must never resolve to "it was always
  // free". The conservative reading is the only safe one, and it is reported
  // so a caller can see that a legacy outcome shape was involved.
  const twoGames = [
    game('A', '2026-09-20T13:00:00Z', 9),
    game('B', '2026-09-20T13:05:00Z', 8)
  ];
  const result = sequentialCapacity(batchesOf(twoGames), {
    weeklySlots: 1, outcomes: { A: 'released' }
  });
  assert.equal(result.decisions.find(d => d.id === 'B').selected, false);
  assert.equal(result.decisions.find(d => d.id === 'A').release_time_unknown, true);
});

test('C12: a same-cutoff tie is broken deterministically, by edge then by id', () => {
  const tied = [
    game('zebra', '2026-09-20T13:00:00Z', 7),
    game('alpha', '2026-09-20T13:00:00Z', 7),
    game('mid', '2026-09-20T13:00:00Z', 9)
  ];
  const a = sequentialCapacity(batchesOf(tied), { weeklySlots: 2 });
  const b = sequentialCapacity(batchesOf(tied), { weeklySlots: 2 });
  assert.deepEqual(a.decisions.map(d => d.id), b.decisions.map(d => d.id));
  assert.deepEqual(a.decisions.filter(d => d.selected).map(d => d.id), ['mid', 'alpha'],
    'highest edge first, then the canonical id — never insertion order');
});

test('C12: a later game can never influence an earlier batch, whatever its edge', () => {
  // The Monday game has the biggest edge in the week. It must not displace a
  // Thursday selection, because on Thursday it has not been considered yet.
  const result = sequentialCapacity(batchesOf(WEEK), { weeklySlots: 1 });
  const selected = result.decisions.filter(d => d.selected).map(d => d.id);
  assert.deepEqual(selected, ['thu'], 'the first cutoff takes the only slot');
  assert.equal(result.decisions.find(d => d.id === 'mon').selected, false);
});
