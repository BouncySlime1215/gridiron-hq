/**
 * The injury-return model (WO / O2): the availability term `ros-projection.js` and
 * `trade-engine.js` both say in their own comments that they do not have.
 *
 * These run on rows inserted here rather than on a developer's synced database, so
 * they pass on a clean checkout. The numbers asserted are structural properties —
 * mass conservation, fallback order, what a zero hazard implies — not the fitted
 * rates, because the fitted rates move with the data and a test that pins them would
 * fail every time nflverse revises a week. The measured rates are reported by
 * `scripts/audit-injury-return.mjs`, which is where a number belongs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-injury-return-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const {
  bucketOf, groupOf, stateSequence, stateOf, stateKey, fitInjuryReturn, curveFor,
  playProbabilities, expectedGamesRemaining, availabilityPanel
} = await import('../server/services/injury-return.js');
const { playerSeasonPanel, rosterWeeklyStatus } = await import('../server/services/nfl-roster-weekly.js');

test('weeks-out buckets follow the boundaries the hazard table is cut on', () => {
  assert.equal(bucketOf(1), '1');
  assert.equal(bucketOf(2), '2');
  assert.equal(bucketOf(3), '3-4');
  assert.equal(bucketOf(4), '3-4');
  assert.equal(bucketOf(5), '5-8');
  assert.equal(bucketOf(8), '5-8');
  assert.equal(bucketOf(9), '9+');
  assert.equal(bucketOf(30), '9+');
});

test('only the two documented reserve codes get their own group; everything else pools', () => {
  assert.equal(groupOf('R48'), 'designated_to_return');
  assert.equal(groupOf('r48'), 'designated_to_return');
  assert.equal(groupOf('R59'), 'short_term');
  assert.equal(groupOf('R01'), 'long_term');
  // An unseen code must pool rather than create a group of one, which is the whole
  // point of grouping on meaning instead of on outcome.
  assert.equal(groupOf('R99'), 'long_term');
  assert.equal(groupOf(null), 'long_term');
});

test('weeks-out restarts after a return, so a second injury is not charged the first one\'s duration', () => {
  const seq = stateSequence([
    { week: 1, status: 'ACT', status_detail: 'A01', played: 1 },
    { week: 2, status: 'RES', status_detail: 'R01', played: 0 },
    { week: 3, status: 'RES', status_detail: 'R01', played: 0 },
    { week: 4, status: 'ACT', status_detail: 'A01', played: 1 },
    { week: 5, status: 'RES', status_detail: 'R01', played: 0 }
  ]);
  assert.deepEqual(seq.map(s => s.weeks_out), [0, 1, 2, 0, 1]);
  assert.deepEqual(seq.map(s => s.state),
    ['active_played', 'ir', 'ir', 'active_played', 'ir']);
});

test('an active player who did not take a snap is a distinct state from one who did', () => {
  const seq = stateSequence([
    { week: 1, status: 'ACT', status_detail: 'A01', played: 0 },
    { week: 2, status: 'ACT', status_detail: 'A01', played: 1 }
  ]);
  assert.deepEqual(seq.map(s => s.state), ['active_idle', 'active_played']);
  // Neither counts as being out, so neither starts a weeks-out clock.
  assert.deepEqual(seq.map(s => s.weeks_out), [0, 0]);
});

test('practice squad counts as unavailable, because no practice-squad week records a snap', () => {
  const seq = stateSequence([{ week: 1, status: 'DEV', status_detail: 'P01', played: 0 }]);
  assert.equal(seq[0].state, 'ir');
  assert.equal(seq[0].weeks_out, 1);
});

/** A tiny synthetic panel with a hazard we control, so the chain can be checked exactly. */
function fitFromRows(playerWeeks) {
  return fitInjuryReturn({ seasons: [2099], panel: playerWeeks });
}

test('a thin cell falls back to its group, then to all reserve weeks, and says which', () => {
  // 60 players on long-term reserve for weeks 9 to 12. Weeks-out counts the unbroken
  // run, not the week number, so week 9 is their FIRST week out and lands in bucket
  // '1' — which is the point worth pinning, since reading it as '9+' is the natural
  // mistake. Nothing at all lands in the short-term group, so a short-term request
  // has to fall back twice.
  const panel = [];
  for (let p = 0; p < 60; p++) {
    for (let w = 9; w <= 12; w++) {
      panel.push({ season: 2099, week: w, gsis_id: `p${p}`, position: 'WR',
        status: 'RES', status_detail: 'R01', played: 0 });
    }
  }
  const fit = fitFromRows(panel);
  const own = curveFor(fit, { state: 'ir', group: 'long_term', bucket: '1' }, 1);
  assert.equal(own.basis, 'cell');
  assert.ok(own.n >= fit.min_cell);
  // The bucket they are never in has no cell of its own and falls back one level.
  const wrongBucket = curveFor(fit, { state: 'ir', group: 'long_term', bucket: '9+' }, 1);
  assert.equal(wrongBucket.basis, 'group');
  // A group never observed at all cannot use a cell or a group rate.
  const unseen = curveFor(fit, { state: 'ir', group: 'short_term', bucket: '1' }, 1);
  assert.equal(unseen.basis, 'all_reserve');
  assert.equal(unseen.rate, fit.reserve_curve[1].rate);
  // An active state has no reserve parent to fall back to, so it reports nothing
  // rather than borrowing a rate measured on injured players.
  const noActive = curveFor(fit, { state: 'active_played', group: null, bucket: null }, 1);
  assert.equal(noActive.basis, 'none');
  assert.equal(noActive.rate, null);
});

test('the minimum-cell constant is the one the fallback ladder actually uses', () => {
  // The fallback test above compares a cell with 240 observations against cells with
  // none, so it passes for ANY value of MIN_CELL -- a retroactive mutation sweep on
  // 2026-09-20 dropped it to 1 and nothing failed. A threshold needs its own boundary
  // tested, or it is not a threshold, it is a comment.
  //
  // Two weeks on reserve gives each player exactly one horizon-1 observation (week 1 to
  // week 2), so the cell's n is the player count and the boundary is addressable. The
  // constant is read off the fit rather than restated, so the test cannot drift from it.
  const reserveWeeks = players => {
    const rows = [];
    for (let i = 0; i < players; i++) {
      for (let w = 1; w <= 2; w++) {
        rows.push({ season: 2099, week: w, gsis_id: `m${i}`, position: 'TE',
          status: 'RES', status_detail: 'R01', played: 0 });
      }
    }
    return rows;
  };
  const min = fitFromRows(reserveWeeks(1)).min_cell;
  assert.ok(min > 1, 'a minimum cell of 1 is no minimum at all');

  const cell = { state: 'ir', group: 'long_term', bucket: '1' };
  const atThreshold = curveFor(fitFromRows(reserveWeeks(min)), cell, 1);
  assert.equal(atThreshold.basis, 'cell', `${min} observations is exactly enough`);
  assert.equal(atThreshold.n, min);

  const below = curveFor(fitFromRows(reserveWeeks(min - 1)), cell, 1);
  assert.notEqual(below.basis, 'cell',
    `${min - 1} observations must not be reported as a cell rate`);
});

test('a horizon past the end of the fit holds the last fitted value and is labelled', () => {
  const panel = [];
  for (let p = 0; p < 60; p++) {
    for (let w = 1; w <= 3; w++) {
      panel.push({ season: 2099, week: w, gsis_id: `q${p}`, position: 'RB',
        status: 'ACT', status_detail: 'A01', played: 1 });
    }
  }
  // Three weeks of data support horizons 1 and 2 only.
  const fit = fitFromRows(panel);
  const near = curveFor(fit, { state: 'active_played', group: null, bucket: null }, 2);
  assert.equal(near.held_flat, false);
  const far = curveFor(fit, { state: 'active_played', group: null, bucket: null }, 9);
  assert.equal(far.held_flat, true);
  assert.equal(far.rate, near.rate);
});

test('the state a caller describes maps to the cell the fit stores', () => {
  assert.deepEqual(stateOf({ status: 'ACT', playedLastWeek: true }),
    { state: 'active_played', group: null, bucket: null });
  assert.deepEqual(stateOf({ status: 'ACT', playedLastWeek: false }),
    { state: 'active_idle', group: null, bucket: null });
  assert.deepEqual(stateOf({ status: 'RES', statusDetail: 'R48', weeksOut: 6 }),
    { state: 'ir', group: 'designated_to_return', bucket: '5-8' });
  // A caller who says "on reserve" without a week count is treated as one week out,
  // never as zero: zero would read as "available".
  assert.deepEqual(stateOf({ status: 'RES', statusDetail: 'R01' }),
    { state: 'ir', group: 'long_term', bucket: '1' });
  assert.equal(stateKey({ state: 'ir', group: 'long_term', bucket: '3-4' }), 'ir|long_term|3-4');
  assert.equal(stateKey({ state: 'active_idle' }), 'active_idle');
});

test('an unfitted model returns nothing rather than a guess', () => {
  const fit = fitFromRows([]);
  assert.deepEqual(playProbabilities(fit, { status: 'RES', statusDetail: 'R01', weeksOut: 2 }), []);
  const e = expectedGamesRemaining(fit, { weeksLeft: 6, status: 'RES', statusDetail: 'R01', weeksOut: 2 });
  assert.equal(e.expected_games, null);
});

/**
 * A fit where nobody on reserve ever returns, every active player who played plays
 * again, and nobody who sat ever plays. Every horizon then has a rate of exactly 0
 * or exactly 1, so the arithmetic is checkable by hand — the only way to know the
 * curve is being read at the right horizon rather than approximately.
 */
function degenerateFit() {
  const panel = [];
  for (let p = 0; p < 50; p++) {
    for (let w = 1; w <= 12; w++) {
      panel.push({ season: 2099, week: w, gsis_id: `out${p}`, position: 'RB',
        status: 'RES', status_detail: 'R01', played: 0 });
      panel.push({ season: 2099, week: w, gsis_id: `fit${p}`, position: 'RB',
        status: 'ACT', status_detail: 'A01', played: 1 });
      panel.push({ season: 2099, week: w, gsis_id: `sat${p}`, position: 'RB',
        status: 'ACT', status_detail: 'A01', played: 0 });
    }
  }
  return fitFromRows(panel);
}

test('with a zero return hazard an injured player never plays, at any horizon', () => {
  const fit = degenerateFit();
  assert.equal(fit.reserve_curve[1].rate, 0);
  assert.equal(fit.curve.active_played[1].rate, 1);
  assert.equal(fit.curve.active_idle[1].rate, 0);
  const series = playProbabilities(fit, { status: 'RES', statusDetail: 'R01', weeksOut: 3, horizon: 6 });
  assert.equal(series.length, 6);
  for (const s of series) assert.equal(s.p_plays, 0);
  const e = expectedGamesRemaining(fit, { weeksLeft: 6, status: 'RES', statusDetail: 'R01', weeksOut: 3 });
  assert.equal(e.expected_games, 0);
});

test('a healthy player who played last week is expected to play every remaining week', () => {
  const fit = degenerateFit();
  const e = expectedGamesRemaining(fit, { weeksLeft: 7, status: 'ACT', statusDetail: 'A01', playedLastWeek: true });
  assert.equal(e.expected_games, 7);
  assert.equal(e.share_of_weeks, 1);
});

test('a bye week is removed from the expectation, not priced', () => {
  const fit = degenerateFit();
  const none = expectedGamesRemaining(fit, { weeksLeft: 8, status: 'ACT', playedLastWeek: true });
  const one = expectedGamesRemaining(fit, { weeksLeft: 8, byeWeeksLeft: 1, status: 'ACT', playedLastWeek: true });
  assert.equal(none.expected_games, 8);
  assert.equal(one.expected_games, 7);
  // More byes than weeks cannot produce a negative expectation.
  const absurd = expectedGamesRemaining(fit, { weeksLeft: 3, byeWeeksLeft: 99, status: 'ACT', playedLastWeek: true });
  assert.equal(absurd.expected_games, 0);
});

test('every reported probability is a real rate with the denominator it came from', () => {
  // A mix of returns and non-returns so the reserve cells sit strictly inside (0, 1).
  const panel = [];
  for (let p = 0; p < 100; p++) {
    const comesBack = p < 30;
    panel.push({ season: 2099, week: 5, gsis_id: `h${p}`, position: 'WR', status: 'RES', status_detail: 'R01', played: 0 });
    panel.push({ season: 2099, week: 6, gsis_id: `h${p}`, position: 'WR',
      status: comesBack ? 'ACT' : 'RES', status_detail: comesBack ? 'A01' : 'R01', played: comesBack ? 1 : 0 });
    panel.push({ season: 2099, week: 7, gsis_id: `h${p}`, position: 'WR',
      status: 'ACT', status_detail: 'A01', played: p % 2 ? 1 : 0 });
  }
  const fit = fitFromRows(panel);
  const series = playProbabilities(fit, { status: 'RES', statusDetail: 'R01', weeksOut: 1, horizon: 6 });
  assert.equal(series.length, 6);
  for (const s of series) {
    assert.ok(s.p_plays >= 0 && s.p_plays <= 1, `p_plays out of range at k=${s.k}: ${s.p_plays}`);
    assert.ok(s.n > 0, 'a reported rate must carry the count it was measured on');
    assert.ok(['cell', 'group', 'all_reserve'].includes(s.basis));
  }
  // The one-week rate is exactly the observed frequency, not a smoothed version of it:
  // 30 of 100 reserve players recorded a snap the following week.
  assert.equal(series[0].p_plays, 0.3);
});

test('the panel reads availability from snaps, not from the roster status', () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO players (id, name, position, gsis_id) VALUES (?,?,?,?)`)
    .run(9001, 'Panel Tester', 'WR', '00-9999001');
  for (const [week, status, detail] of [[1, 'ACT', 'A01'], [2, 'ACT', 'A01'], [3, 'RES', 'R01']]) {
    db.prepare(`INSERT INTO nfl_roster_weekly
      (season, week, gsis_id, team, position, status, status_detail, player_name, ingested_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(2099, week, '00-9999001', 'PIT', 'WR', status, detail, 'Panel Tester', now);
  }
  // Week 1 he played; week 2 he was active and did not (a healthy scratch), and the
  // status alone cannot tell those apart.
  db.prepare(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
    VALUES (?,?,?,?,?)`).run(9001, 2099, 1, 41, 0.62);

  const panel = playerSeasonPanel('00-9999001', 2099);
  assert.deepEqual(panel.map(r => [r.week, r.status, r.has_snap_row, r.offense_snaps]),
    [[1, 'ACT', 1, 41], [2, 'ACT', 0, 0], [3, 'RES', 0, 0]]);

  const viaModel = availabilityPanel({ seasons: [2099], positions: ['WR'] });
  assert.deepEqual(viaModel.map(r => [r.week, r.played]), [[1, 1], [2, 0], [3, 0]]);

  const status = rosterWeeklyStatus();
  const season = status.seasons.find(s => s.season === 2099);
  assert.equal(season.rows, 3);
  assert.equal(season.reserve, 1);
  assert.equal(season.active, 2);
});

test('a gap in the panel stops the horizon walk; the week past it is never graded', () => {
  // THIS TEST USED TO PROVE NOTHING. It asserted empty curves on a two-row fixture, and
  // two rows are below `min_cell`, so the curves are empty whatever the walk does — a
  // retroactive mutation sweep on 2026-09-20 removed the gap guard and nothing failed.
  // The fixture now has to be big enough that a wrongly-counted horizon would show.
  //
  // 60 players on reserve in weeks 1 and 2, then ACTIVE AND PLAYING in week 4, with week
  // 3 missing from the panel. Week 4 is a real horizon-3 target from week 1 by
  // arithmetic, and grading it would credit these players with a return nothing observed
  // — the panel does not say they were on the roster in week 3 at all.
  const rows = [];
  for (let i = 0; i < 60; i++) {
    for (const [week, status, detail, played] of [
      [1, 'RES', 'R01', 0], [2, 'RES', 'R01', 0], [4, 'ACT', 'A01', 1]
    ]) rows.push({ season: 2099, week, gsis_id: `gap${i}`, position: 'TE', status, status_detail: detail, played });
  }
  const fit = fitFromRows(rows);

  // Horizon 1 is observed for every player (week 1 -> week 2), so the curve exists.
  assert.ok(fit.reserve_curve[1], 'the one adjacent pair in this panel is graded');
  assert.equal(fit.reserve_curve[1].rate, 0, 'nobody played in week 2');

  // Nothing past the gap may appear, at any horizon. Week 4 is the only week anyone
  // played, so any non-zero rate here is week 4 leaking across a week nobody was observed.
  for (const k of [2, 3, 4]) {
    assert.equal(fit.reserve_curve[k], undefined,
      `horizon ${k} crosses the missing week 3 and must not be graded`);
  }
  for (const [key, curve] of Object.entries(fit.curve)) {
    for (const k of Object.keys(curve)) {
      assert.equal(Number(k), 1, `cell ${key} graded horizon ${k} across the gap`);
    }
  }
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
