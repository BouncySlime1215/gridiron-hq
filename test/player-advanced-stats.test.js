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

  // The three assertions above all compare the constant against itself, so
  // rewriting the constant moves both sides together and they notice nothing.
  // The sweep proved it: a reason rewritten to "this player has no routes on
  // file" survived every one of them. What has to be pinned is the CLAIM — that
  // the data does not exist here, said without reference to any player.
  assert.match(UNAVAILABLE.routes, /no routes-run data exists/i,
    'the reason no longer says the data itself is absent from the platform');
  assert.doesNotMatch(UNAVAILABLE.routes, /\bthis player\b|\bhe\b|\bhis\b|on file for/i,
    'the routes reason describes a player rather than the platform, which turns a '
    + 'missing data source into a claim about someone\'s workload');
});

test('snap share is not offered as route participation under another name', () => {
  const participation = stat(get(), 'route_participation');
  const snaps = stat(get(), 'snap_share');
  assert.equal(participation.value, null);
  // Tolerance, not equality: (0.88 + 0.80) / 2 lands on 0.8400000000000001 in
  // binary floating point. Pinning the exact double would fail on a correct
  // change to how the mean is taken rather than on a wrong one.
  assert.ok(Math.abs(snaps.value - 0.84) < 1e-9,
    `snap share is a real measurement and should be shown; got ${snaps.value}`);
  assert.doesNotMatch(String(participation.label), /snap/i,
    "route participation is wearing snap share's name");
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
  // And the reason has to be the right absence. "No snap counts on file"
  // describes a table target share does not read; "no usage rows" is what
  // actually happened. A sweep row that flipped only the reason survived every
  // assertion above until this one existed.
  const share = report.stats.find(s => s.key === 'target_share');
  assert.equal(share.unavailable_reason, UNAVAILABLE.noUsage,
    'a player with no usage rows is explained by something other than the missing rows');
});

test('weeks_measured says how much data is behind the numbers', () => {
  assert.equal(get(1).weeks_measured, 2);
});

/**
 * The block has to reach the page, and the three absences have to survive the
 * trip. A service that reports them honestly and a panel that filters them out
 * before rendering is the same silence with more steps.
 *
 * Source-text checks, because there is no DOM harness in this repository.
 */
const read = p => fs.readFileSync(p, 'utf8');

test('the panel is mounted on the player page and asks the right endpoint', () => {
  const page = read('client/src/pages/PlayerDetail.tsx');
  assert.match(page, /<AdvancedStatsPanel/, 'the block never reaches the player page');
  const panel = read('client/src/components/AdvancedStatsPanel.tsx');
  assert.match(panel, /useApi<[^>]*>\(`\/players\/\$\{playerId\}\/advanced-stats`\)/,
    'the panel does not call the advanced-stats endpoint');
});

test('the panel renders the unmeasurable stats rather than filtering them away', () => {
  const panel = read('client/src/components/AdvancedStatsPanel.tsx');
  assert.match(panel, /unavailable_reason/,
    'the panel never shows why a stat has no number');
  // Anchored on the absent list being built and rendered, not on the word
  // appearing somewhere: a panel that computed `absent` and then never mapped
  // over it would still contain the identifier.
  // Both lists must be mapped over. The first draft of this assertion forbade
  // `stats.filter(s => s.value != null)` outright, which fails on the correct
  // code: the panel legitimately splits the stats in two and that filter is how
  // it builds the measured half. What must not happen is only one half being
  // rendered, so both maps are what gets pinned.
  assert.match(panel, /measured\.map\(/, 'the measured stats are never rendered');
  assert.match(panel, /absent\.map\(/,
    'the unmeasurable stats are computed and then dropped before rendering');
});

test('a failed load is not rendered as a player with no advanced stats', () => {
  const panel = read('client/src/components/AdvancedStatsPanel.tsx');
  const errorGuard = panel.indexOf('if (error');
  const silentReturn = panel.indexOf('if (!report');
  assert.ok(errorGuard >= 0, 'the panel has no branch for a failed request');
  assert.ok(silentReturn >= 0, 'the early return is gone; this test pins its ordering');
  assert.ok(errorGuard < silentReturn,
    'the silent return runs first, so a failed load renders nothing at all');
});
