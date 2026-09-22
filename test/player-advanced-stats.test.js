/**
 * The advanced-stats block, and the four numbers it must never invent.
 *
 * A fantasy player page is expected to carry yards per route run, route
 * participation, touchdown rate and red-zone share. Three of those four cannot
 * be computed here, and the temptation is to reach for the nearest column and
 * call it close enough — snap share relabelled as route participation, a
 * receiving line divided by something that is not routes. That is how this
 * project's signature bug gets built on purpose rather than by accident.
 *
 * Measured on this branch, with a control in the same scan:
 *
 *   grep -rci route server/db/schema/*.js   -> 23 hits, every one of them an
 *   HTTP route path, `routed_at`, or an index on an HTTP route column. Control:
 *   `targets` hits mlb-model-misc.js, which is the real player_week_usage
 *   definition, so the scan works.
 *
 * So there is no routes-run column anywhere. And `nfl_play_by_play`
 * (nfl-a-to-m.js:306) has `yards_to_endzone` but NO player column at all — only
 * a free-text `text` description — so a red-zone touch cannot be attributed to
 * anyone without parsing prose, which is a guess wearing a number's clothes.
 *
 * The contract this file pins:
 *
 *   1. A stat carries EITHER a value OR a reason it has none. Never both, never
 *      neither. A row with both null is a stat that quietly disappeared.
 *   2. The three unavailable stats are still LISTED, with their reason. Dropping
 *      them is the quieter lie: a reader counts what they can see and concludes
 *      the page shows everything it knows about.
 *   3. A zero denominator is `not measured`, never a rate of 0. A player with no
 *      targets has no touchdown rate; he does not have a touchdown rate of zero.
 *   4. The denominator is named on every rate, because "touchdown rate" alone is
 *      three different statistics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-adv-stats-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { playerAdvancedStats, UNAVAILABLE } =
  await import('../server/services/player-advanced-stats.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
db.prepare(`INSERT INTO players (id, name, position) VALUES (1, 'Test Receiver', 'WR')`).run();
db.prepare(`INSERT INTO players (id, name, position) VALUES (2, 'Test Passer', 'QB')`).run();
db.prepare(`INSERT INTO players (id, name, position) VALUES (3, 'Test Benchwarmer', 'WR')`).run();

const usage = (id, week, over = {}) => {
  const r = { targets: 0, carries: 0, attempts: 0, receiving_tds: 0, rushing_tds: 0,
    passing_tds: 0, target_share: null, wopr: null, ...over };
  db.prepare(`INSERT INTO player_week_usage
    (player_id, season, week, targets, carries, attempts, receiving_tds, rushing_tds,
     passing_tds, target_share, wopr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, SEASON, week, r.targets, r.carries, r.attempts, r.receiving_tds,
      r.rushing_tds, r.passing_tds, r.target_share, r.wopr);
};

// A receiver with two measured weeks: 20 targets, 2 receiving TDs.
usage(1, 1, { targets: 12, receiving_tds: 1, target_share: 0.26, wopr: 0.61 });
usage(1, 2, { targets: 8, receiving_tds: 1, target_share: 0.20, wopr: 0.49 });
db.prepare(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
            VALUES (1, ?, 1, 60, 0.88)`).run(SEASON);
db.prepare(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
            VALUES (1, ?, 2, 55, 0.80)`).run(SEASON);

// A passer: 60 attempts, 5 touchdown passes.
usage(2, 1, { attempts: 35, passing_tds: 3 });
usage(2, 2, { attempts: 25, passing_tds: 2 });

// On the roster, never used: rows exist, every denominator is zero.
usage(3, 1, {});

const get = (id = 1) => playerAdvancedStats(id, { season: SEASON, database: db });
const stat = (report, key) => report.stats.find(s => s.key === key);

test('every stat carries either a value or a reason, never both and never neither', () => {
  for (const id of [1, 2, 3]) {
    for (const s of get(id).stats) {
      const hasValue = s.value != null;
      const hasReason = s.unavailable_reason != null;
      assert.ok(hasValue !== hasReason,
        `${s.key} for player ${id} has ${hasValue && hasReason ? 'both' : 'neither'} `
        + `a value and a reason — ${JSON.stringify(s)}`);
    }
  }
});

test('the three uncomputable stats are listed with their reason, not dropped', () => {
  const keys = get().stats.map(s => s.key);
  for (const key of ['yards_per_route_run', 'route_participation', 'red_zone_share']) {
    assert.ok(keys.includes(key), `${key} was dropped from the block rather than explained`);
    const s = stat(get(), key);
    assert.equal(s.value, null, `${key} was given a number, and no number for it exists`);
    assert.ok((s.unavailable_reason ?? '').length > 20, `${key} has no real reason attached`);
  }
});

test('the routes reason says there is no routes data, not that the player has none', () => {
  for (const key of ['yards_per_route_run', 'route_participation']) {
    assert.match(stat(get(), key).unavailable_reason, /routes/i);
    assert.equal(stat(get(), key).unavailable_reason, UNAVAILABLE.routes,
      `${key} explains itself differently from the other routes-based stat`);
  }
  // The same reason must hold for a player with a full season of usage: it is a
  // fact about the platform, never about this player's workload.
  assert.equal(stat(get(1), 'route_participation').unavailable_reason,
    stat(get(3), 'route_participation').unavailable_reason,
    'the routes reason changes with the player, so it is describing the wrong thing');
});

test('snap share is not offered as route participation under another name', () => {
  const participation = stat(get(), 'route_participation');
  const snaps = stat(get(), 'snap_share');
  assert.equal(participation.value, null);
  assert.equal(snaps.value, 0.84, 'snap share is a real measurement and should be shown');
  assert.notMatch(String(participation.label), /snap/i);
});

test('touchdown rate is computed, with its denominator named', () => {
  const td = stat(get(1), 'td_rate');
  assert.equal(td.value, 0.1, '2 receiving touchdowns on 20 targets is 0.100');
  assert.match(td.basis, /target/i, 'the rate does not say what it is a rate of');
});

test('a passer\'s touchdown rate uses attempts, not targets', () => {
  const td = stat(get(2), 'td_rate');
  assert.ok(Math.abs(td.value - 5 / 60) < 1e-9, '5 touchdown passes on 60 attempts');
  assert.match(td.basis, /attempt/i);
});

test('a zero denominator is not measured, never a rate of zero', () => {
  const td = stat(get(3), 'td_rate');
  assert.notEqual(td.value, 0,
    'a player with no targets and no carries was given a touchdown rate of 0.000');
  assert.equal(td.value, null);
  assert.match(td.unavailable_reason, /no targets|no carries|opportunit/i);
});

test('a player with no usage rows at all is reported as such, not as all-zero', () => {
  const report = playerAdvancedStats(999, { season: SEASON, database: db });
  assert.equal(report.weeks_measured, 0);
  for (const s of report.stats) assert.equal(s.value, null, `${s.key} invented a value`);
});

test('weeks_measured says how much data is behind the numbers', () => {
  assert.equal(get(1).weeks_measured, 2);
});
