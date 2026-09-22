import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-redzone-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { __test } = await import('../server/services/td-regression.js');
const { exclusive, RUSH_CLASSES, REC_CLASSES } = __test;

/**
 * The classes are nested supersets, not disjoint buckets: a goal-to-go carry is
 * also a carry inside the 10 is also a red-zone carry is also a carry. exclusive()
 * makes each tier count only what the tier above did not, so the most valuable
 * touches are priced once. td-regression.js:57-64 is explicit that pricing them
 * more than once inflates expected touchdowns for exactly the backs whose whole
 * value is that they get them.
 */
test('rushing splits into four tiers, each counting only its own band', () => {
  const out = exclusive({
    goal_line_carries: 3, inside_10_carries: 5, red_zone_carries: 10, carries: 20
  }, RUSH_CLASSES);
  assert.equal(out.goal_line_carries, 3);
  assert.equal(out.inside_10_carries, 2, 'inside the 10 but not goal-to-go');
  assert.equal(out.red_zone_carries, 5, 'the 11-to-20 band');
  assert.equal(out.carries, 10, 'outside the red zone');
  assert.equal(out.goal_line_carries + out.inside_10_carries + out.red_zone_carries + out.carries, 20,
    'the tiers partition the carries exactly once');
});

/**
 * THE TRAP. Any database ingested before the inside-10 counter existed has no
 * such key. If red_zone_carries subtracts a missing key it subtracts zero, and
 * silently starts including the goal-line carries again — the treble-counting
 * the module exists to prevent, on live data, with nothing raising an error.
 * An absent counter must fall back to the old parent.
 */
test('a database without the inside-10 counter still excludes goal-line carries', () => {
  const out = exclusive({ goal_line_carries: 3, red_zone_carries: 10, carries: 20 }, RUSH_CLASSES);
  assert.equal(out.inside_10_carries, 0, 'no inside-10 data means no inside-10 tier');
  assert.equal(out.red_zone_carries, 7, 'falls back to subtracting goal-line, as before the change');
  assert.equal(out.carries, 10);
});

/**
 * Receiving needed no new counter. `end_zone_targets` is fed by ez_tgt, which
 * counts yl100 <= 10 (nfl-pbp.js:398) — inside the 10, despite the name — so
 * that band was already split. What was pooled is goal-to-go with the rest of
 * the inside-10 band, and goal_to_go_targets has been written to the blob all
 * along (nfl-pbp.js:642) with nothing reading it.
 */
test('receiving splits into four tiers using a counter that already existed', () => {
  const out = exclusive({
    goal_to_go_targets: 2, end_zone_targets: 4, red_zone_targets: 9, targets: 15
  }, REC_CLASSES);
  assert.equal(out.goal_to_go_targets, 2);
  assert.equal(out.end_zone_targets, 2, 'inside the 10 but not goal-to-go');
  assert.equal(out.red_zone_targets, 5, 'the 11-to-20 band');
  assert.equal(out.targets, 6);
  assert.equal(out.goal_to_go_targets + out.end_zone_targets + out.red_zone_targets + out.targets, 15);
});

test('a database without goal-to-go targets behaves exactly as it did before', () => {
  const out = exclusive({ end_zone_targets: 4, red_zone_targets: 9, targets: 15 }, REC_CLASSES);
  assert.equal(out.goal_to_go_targets, 0);
  assert.equal(out.end_zone_targets, 4);
  assert.equal(out.red_zone_targets, 5);
  assert.equal(out.targets, 6);
});

/**
 * Goal-to-go is not strictly a subset of inside-the-10: a penalty can leave
 * first-and-goal outside the 10. So a blob can hold goal_line carries with a
 * genuine zero inside the 10, and subtracting the named parent alone would let
 * those carries leak down into the 11-to-20 tier.
 */
test('goal-line carries outside the 10 do not leak into the tier below', () => {
  const out = exclusive({
    goal_line_carries: 3, inside_10_carries: 0, red_zone_carries: 10, carries: 20
  }, RUSH_CLASSES);
  assert.equal(out.inside_10_carries, 0);
  assert.equal(out.red_zone_carries, 7, 'the 3 goal-to-go carries are still excluded');
});

test('an inconsistent blob never yields a negative tier', () => {
  const out = exclusive({ goal_line_carries: 9, inside_10_carries: 2, red_zone_carries: 4, carries: 3 },
    RUSH_CLASSES);
  for (const [key, value] of Object.entries(out)) assert.ok(value >= 0, `${key} is not negative`);
});

test('the play-by-play ingest emits an inside-10 carry counter', async () => {
  const src = fs.readFileSync(new URL('../server/services/nfl-pbp.js', import.meta.url), 'utf8');
  assert.match(src, /inside_10_carries:/, 'the counter reaches the weekly feature blob');
  assert.match(src, /yl100 <= 10\) p\.rush_i10\+\+/, 'counted at the 10, from the same yardline field');
});

/**
 * Every class needs a seed. A class without one fits to null, and
 * touchdownRates() then returns a "rate" that is not a probability — which is
 * exactly how adding the two tiers broke the suite before this test existed.
 * The unit tests above all exercised exclusive() and none of them touched the
 * fit, so the gap was only caught by the full run.
 */
test('every opportunity class has a seed rate', async () => {
  const src = fs.readFileSync(new URL('../server/services/td-regression.js', import.meta.url), 'utf8');
  const seeds = key => new RegExp(`${key}:\\s*0?\\.\\d+`).test(src);
  for (const c of RUSH_CLASSES) assert.ok(seeds(c.key), `${c.key} has no seed rate`);
  for (const c of REC_CLASSES) assert.ok(seeds(c.key), `${c.key} has no seed rate`);
});
