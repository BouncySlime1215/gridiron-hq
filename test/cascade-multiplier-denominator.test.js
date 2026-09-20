/**
 * A cascade multiplier is a ratio, and `cascades()` shrinks it with the sample
 * size of the WITHOUT-starter games — never with the sample size of the
 * denominator, which is the quantity that actually makes it unstable. So a
 * beneficiary who was barely used alongside the starter keeps a tiny divisor
 * and the shrink toward 1 cannot tame it.
 *
 * The real instance, found by grading the shipped numbers against seasons they
 * were not fitted on (docs/tdd/cascade-grade.tdd.md):
 *
 *   Jordan Whittington (WR) behind Puka Nacua — ×26.38 on a 0.11 base.
 *   With Nacua on the field he averaged 0.11 opportunities a game; the whole
 *   with-starter sample holds about one observed target. One target cannot
 *   carry a ratio.
 *
 * And the case a naive cap would break, from the same run:
 *
 *   Mac Jones (QB) behind Brock Purdy — ×10.24 on a 2.67 base, over a sample
 *   of roughly twenty observed attempts. A backup quarterback really does go
 *   from mop-up duty to a full starter's workload. ×10 is the truth here, and
 *   clipping it would replace a correct number with a wrong one.
 *
 * Both fixtures below reproduce those two shapes. The rule that separates them
 * is the amount of opportunity the denominator was estimated from, not the rate
 * and not the size of the multiplier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cascade-mult-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { cascades } = await import('../server/services/contingency.js');

const SEASON = 2023;
const WR_STARTER = 1, THIN_MATE = 2, QB_STARTER = 3, QB_BACKUP = 4;

const usage = (id, week, cols) =>
  run(`INSERT INTO player_week_usage (player_id, season, week, team, opponent, position,
       attempts, carries, targets)
       VALUES (?,?,?,?,?,?,?,?,?)`,
  id, SEASON, week, cols.team, 'ZZZ', cols.position,
  cols.attempts ?? 0, cols.carries ?? 0, cols.targets ?? 0);

test.before(() => {
  for (const [id, name, position] of [
    [WR_STARTER, 'Starting Receiver', 'WR'],
    [THIN_MATE, 'Barely Used Receiver', 'WR'],
    [QB_STARTER, 'Starting Quarterback', 'QB'],
    [QB_BACKUP, 'Backup Quarterback', 'QB']
  ]) {
    run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant)
         VALUES (?,?,?,?,1)`, id, name, position, `00-000000${id}`);
  }

  // Both starters miss weeks 7-10 and play the other fourteen. The absence has to
  // sit BETWEEN appearances: `cascades()` bounds each starter's window to his own
  // first and last week on the roster, so a season-ending injury registers nothing.
  const OUT = new Set([7, 8, 9, 10]);

  // Team AAA: the receiver pair. Two observed targets across the whole
  // with-starter span, so base is 2/14 and the divisor rests on two opportunities.
  for (let week = 1; week <= 18; week++) {
    if (!OUT.has(week)) usage(WR_STARTER, week, { team: 'AAA', position: 'WR', targets: 9 });
    usage(THIN_MATE, week, {
      team: 'AAA', position: 'WR',
      targets: OUT.has(week) ? 6 : (week === 3 || week === 13 ? 1 : 0)
    });
  }

  // Team BBB: the quarterback pair, same absence shape, a well-estimated divisor.
  for (let week = 1; week <= 18; week++) {
    if (!OUT.has(week)) usage(QB_STARTER, week, { team: 'BBB', position: 'QB', attempts: 35 });
    usage(QB_BACKUP, week, {
      team: 'BBB', position: 'QB', attempts: OUT.has(week) ? 40 : 3
    });
  }
});

const beneficiary = (map, starterId, mateId) =>
  map.get(starterId)?.beneficiaries.find(b => b.player_id === mateId);

test('a beneficiary barely used alongside the starter publishes no multiplier', () => {
  const b = beneficiary(cascades({ through: SEASON }), WR_STARTER, THIN_MATE);
  assert.ok(b, 'the pair is still reported — the gain is real even when the ratio is not');
  assert.equal(b.multiplier, null,
    'two observed opportunities cannot carry a ratio; before the fix this published ×21.5');
});

test('the gain survives when the multiplier does not', () => {
  const b = beneficiary(cascades({ through: SEASON }), WR_STARTER, THIN_MATE);
  // 6 without the starter against 2/14 with him.
  assert.ok(Math.abs(b.opportunity_without - 6) < 0.01);
  assert.ok(b.gain > 5.8 && b.gain < 5.9, `gain was ${b.gain}`);
});

test('a large multiplier from a well-estimated divisor is kept', () => {
  const b = beneficiary(cascades({ through: SEASON }), QB_STARTER, QB_BACKUP);
  assert.ok(b, 'the backup quarterback is a beneficiary');
  // 40 attempts without against 3 with: raw 13.33, shrunk with n=4, k=4 toward 1.
  assert.ok(b.multiplier > 7 && b.multiplier < 7.3,
    `a real ×7 must not be clipped, got ${b.multiplier}`);
});

test('the denominator the multiplier rests on is published', () => {
  const map = cascades({ through: SEASON });
  const thin = beneficiary(map, WR_STARTER, THIN_MATE);
  const qb = beneficiary(map, QB_STARTER, QB_BACKUP);
  assert.equal(thin.denominator_opportunities, 2,
    'two targets across the whole with-starter span');
  assert.equal(qb.denominator_opportunities, 42,
    'three attempts a game across fourteen games');
});
