/**
 * Start/Sit must name the starting slots it does not model.
 *
 * `lineupSlots` keeps only SCORED positions and flex slots, so a kicker and a
 * defence are dropped from every league's lineup before the solver ever runs.
 * That scope is deliberate (trade-engine.js#SCORED: both are near-random week to
 * week, so including them adds noise to every comparison) and it is not in
 * question here. What was missing is the page saying so: the lineup rendered
 * with two fewer slots than the manager's league actually starts, and nothing
 * connected the two.
 *
 * The invariant these tests hold is the one that survives new slot types:
 * EVERY entry in a league's roster_positions is either bench/IR depth, or a slot
 * the solver models, or one this function reports. Nothing may fall through
 * silently — which is exactly how a kicker went unmentioned for as long as it
 * did. The expectations below are written out by hand rather than derived from
 * lineupSlots, so a change that widens the drop set fails here instead of
 * agreeing with itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-not-modelled-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { lineupSlots } = await import('../server/services/trade-engine.js');
const { slotsNotModelled } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const lg = positions => ({ roster_positions: positions == null ? null : JSON.stringify(positions) });
const report = positions => slotsNotModelled(lg(positions), lineupSlots(lg(positions)));

/** ESPN writes BENCH/IR by name (espn-draft.js#SLOT_NAME); this is a standard league. */
const ESPN = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'K',
  'BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'IR'];
/** Sleeper writes its own vocabulary, including SUPER_FLEX and a taxi squad. */
const SLEEPER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF',
  'BN', 'BN', 'BN', 'BN', 'TAXI', 'IR'];

test('a standard ESPN league reports exactly its kicker and its defence', () => {
  assert.deepEqual(report(ESPN), [{ slot: 'DEF', count: 1 }, { slot: 'K', count: 1 }]);
});

test('Sleeper vocabulary reports the same two slots and keeps SUPER_FLEX modelled', () => {
  const out = report(SLEEPER);
  assert.deepEqual(out, [{ slot: 'K', count: 1 }, { slot: 'DEF', count: 1 }]);
  assert.ok(lineupSlots(lg(SLEEPER)).includes('SUPER_FLEX'),
    'SUPER_FLEX is a modelled flex slot, not an unmodelled one');
});

test('bench, taxi and IR depth is never reported as an unmodelled starting slot', () => {
  for (const positions of [ESPN, SLEEPER]) {
    const named = report(positions).map(r => r.slot);
    for (const depth of ['BENCH', 'BN', 'BE', 'IR', 'TAXI', 'RES', 'NA']) {
      assert.ok(!named.includes(depth), `${depth} is depth, not a starting slot`);
    }
  }
});

test('nothing in roster_positions may fall through silently', () => {
  // The property that catches the NEXT kicker: every recorded slot is depth,
  // modelled, or reported. A slot type nobody anticipated lands in the report
  // rather than vanishing from the page.
  const DEPTH = new Set(['BENCH', 'BN', 'BE', 'IR', 'TAXI', 'RES', 'NA']);
  for (const positions of [ESPN, SLEEPER, ['QB', 'RB', 'WR', 'DL', 'LB', 'DB', 'BN']]) {
    const modelled = new Set(lineupSlots(lg(positions)));
    const reported = new Set(report(positions).map(r => r.slot));
    for (const slot of positions) {
      assert.ok(DEPTH.has(slot) || modelled.has(slot) || reported.has(slot),
        `${slot} is neither depth, modelled, nor reported`);
    }
  }
});

test('an IDP league reports every unmodelled starting slot, with counts', () => {
  assert.deepEqual(report(['QB', 'RB', 'WR', 'DL', 'DL', 'LB', 'DB', 'K', 'BN']),
    [{ slot: 'DL', count: 2 }, { slot: 'LB', count: 1 }, { slot: 'DB', count: 1 }, { slot: 'K', count: 1 }]);
});

test('a league whose sync recorded no roster positions reports nothing', () => {
  // lineupSlots falls back to a default skill lineup here, so there is no
  // evidence this league starts a kicker at all. Claiming one would be
  // inventing a slot the sync never saw.
  assert.deepEqual(report(null), []);
  assert.deepEqual(report([]), []);
});

test('a corrupt roster_positions value degrades to nothing, never to a throw', () => {
  assert.deepEqual(slotsNotModelled({ roster_positions: '{not json' }, ['QB']), []);
  assert.deepEqual(slotsNotModelled({ roster_positions: '{"QB":1}' }, ['QB']), [],
    'an object is not the array this field holds');
  assert.deepEqual(slotsNotModelled({ roster_positions: JSON.stringify(['QB', null, 7, 'K']) }, ['QB']),
    [{ slot: 'K', count: 1 }], 'non-string entries are skipped, the real slot still lands');
});

test('starting slots and roster slots are different counts, and the scope uses the first', () => {
  // The matchup card said "7 of 17 roster slots", which counts seven bench seats
  // and the IR slot: it reads as ten missing starters when two are missing.
  // lineup-posture.js builds its denominator from these two numbers now.
  const slots = lineupSlots(lg(ESPN));
  const unmodelled = report(ESPN);
  const starting = slots.length + unmodelled.reduce((n, s) => n + s.count, 0);
  assert.equal(slots.length, 7);
  assert.equal(starting, 9, 'QB, 2 RB, 2 WR, TE, FLEX, DEF, K — the slots this league starts');
  assert.equal(ESPN.length, 17, 'the old denominator, which counted depth as if it were a starter');
});

test('the check fails on a deliberately broken copy of what it checks', () => {
  // MEMORY's rule: a checker that derives its expectation from the thing it
  // checks passes the exact defect it exists to catch. So prove this one bites
  // — hand it a modelled-slot list that wrongly claims to cover the kicker, and
  // the kicker must disappear from the report. If it does not, the function is
  // ignoring its input and every assertion above is decoration.
  const pretendsToModelK = [...lineupSlots(lg(ESPN)), 'K'];
  assert.deepEqual(slotsNotModelled(lg(ESPN), pretendsToModelK), [{ slot: 'DEF', count: 1 }]);
});
