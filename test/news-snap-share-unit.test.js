/**
 * `snap_share` means one thing everywhere, and the News card was the exception.
 *
 * `player_week_snaps.offense_pct` is written straight from nflverse's
 * `snap_counts_<season>.csv` (server/services/nflverse.js:283, no arithmetic on
 * the way in) and every other reader in this codebase treats it as a fraction:
 * contingency.js averages it into a `share`, role-scenario-engine.js applies
 * 35%/72% ratio bars to that share, nfl-postgame-truth.js serves it as
 * `offense_snap_share` untouched, who-plays.js serves it rounded to four
 * decimals, role-changepoint.js to three.
 *
 * news-fantasy-impact.js served the same column, under the same name, as a
 * percentage — and decided the unit per row:
 *
 *     snap_share: round(Number(offense_pct) * (Number(offense_pct) <= 1 ? 100 : 1))
 *
 * Two things are wrong with that, and neither is the number a reader sees today.
 * For every legal input the arithmetic is right, and News.tsx prints "85% snaps"
 * correctly. State it plainly rather than inventing a wrong number: this is not
 * a bug report about a figure on screen.
 *
 *   1. One stat name, two units. A consumer reading `snap_share` off the news
 *      card gets 85 where the same field from who-plays gives 0.85. That is the
 *      normalised-name rule broken at exactly one site.
 *   2. The row decides its own unit, so a unit error upstream is unfalsifiable.
 *      If a row ever stored 85 for 85%, the guard's second arm passes it through
 *      untouched and the card prints "85% snaps" — the right answer by accident,
 *      and indistinguishable from the measured one. A value this layer cannot
 *      read has to say so, not be quietly rescued.
 *
 * So: the column is a fraction, the served field is a fraction, the card does
 * the formatting, and a value outside [0, 1] is refused with a reason rather
 * than coerced.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-snap-unit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const SEASON = 2026, WEEK = 2, PLAYER = 11;
run(`INSERT INTO players (id, name, position, fantasy_relevant) VALUES (?, 'Fixture Receiver', 'WR', 1)`, PLAYER);
run(`INSERT INTO game_lines (season, week, team, opponent, gameday) VALUES (?,?,'KC','BUF','2026-09-20')`, SEASON, WEEK);
// A finished week: the usage row is what makes `finished` true, so the tracker
// reaches the `actual` block at all.
run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, receptions, receiving_yards)
     VALUES (?,?,?,'KC','WR',8,6,74)`, PLAYER, SEASON, WEEK);

const RECEIVER = {
  player_id: PLAYER, name: 'Fixture Receiver', team: 'KC', position: 'WR',
  volume: { targets_per_game: 8, carries_per_game: 0, attempts_per_game: 0, target_share: 0.25 },
  player_week_engine: { cutoff: '2026 week 1' }
};

mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    buildPlayerWeekEngine: () => new Map([[PLAYER, RECEIVER]]),
    playerWeekDistribution: (_p, { activeProbability = 1 } = {}) =>
      ({ mean: 10 * activeProbability, p10: 4, p90: 18 })
  }
});

mock.module('../server/services/contingency.js', {
  namedExports: {
    availabilityBasis: () => ({ basis: 'role', missing: [], stamp: 'fixture' }),
    weeklyAvailability: () => new Map([[PLAYER, {
      player_id: PLAYER, active_probability: 0.9,
      source: 'fitted availability by role (starter/noreport/full, n=812)'
    }]])
  }
});

const { newsFantasyTracker } = await import('../server/services/news-fantasy-impact.js');

const signal = {
  player_id: PLAYER, player_name: RECEIVER.name, team: 'KC',
  signal_type: 'role', status: 'role_up', confidence: 1, role_delta: 0,
  published_at: '2026-09-18T12:00:00Z'
};

/** The served `actual` block for one stored offense_pct. */
function servedFor(offensePct) {
  run(`DELETE FROM player_week_snaps WHERE player_id=? AND season=? AND week=?`, PLAYER, SEASON, WEEK);
  if (offensePct !== undefined) {
    run(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)`,
      PLAYER, SEASON, WEEK, 50, offensePct);
  }
  const actual = newsFantasyTracker([signal]).signals[0].tracking?.actual;
  assert.ok(actual, 'the fixture week is not being treated as finished — the tracker served no actual block');
  return actual;
}

test('U1: a stored 0.85 is served as the fraction 0.85, the same unit every other reader gets', () => {
  assert.equal(servedFor(0.85).snap_share, 0.85);
});

test('U2: every snap played is 1, not 100 — a number that also reads as one per cent', () => {
  // This is the case the old guard handled correctly and unreadably: 1.0 became
  // 100, which is a legal percentage AND a legal count of nothing much.
  assert.equal(servedFor(1).snap_share, 1);
});

test('U3: one snap in a hundred survives the rounding', () => {
  // The module's default round() is one decimal, which would flatten 0.01 to 0.
  // A fraction needs three, which is what role-changepoint.js already uses.
  assert.equal(servedFor(0.01).snap_share, 0.01);
});

test('U4: a value outside [0, 1] is refused with a reason, not rescued into a plausible one', () => {
  // 85 stored where 0.85 was meant. The old guard multiplied by 1 and served
  // "85", which the card printed as "85% snaps" — correct by accident, and
  // indistinguishable from a measured 0.85.
  const actual = servedFor(85);
  assert.equal(actual.snap_share, null, 'a value this layer cannot read was served as a number anyway');
  assert.equal(actual.snap_share_unreadable, true, 'the layer went inert and the payload does not say so');
});

test('U5: a negative share is refused the same way', () => {
  const actual = servedFor(-0.2);
  assert.equal(actual.snap_share, null);
  assert.equal(actual.snap_share_unreadable, true);
});

test('U6: never measured and cannot be read are different answers', () => {
  // No snaps row at all. The share is null, as before — but nothing is wrong
  // with the data, so the card must not claim anything is.
  const actual = servedFor(undefined);
  assert.equal(actual.snap_share, null);
  assert.equal(actual.snap_share_unreadable, false,
    'an absent measurement is being reported as an unreadable one');
});

test('U7: the card does the formatting, and says so when it cannot', () => {
  // Source text, because node:test cannot import .tsx. The server hands over a
  // fraction; turning it into "85% snaps" is a display decision and belongs at
  // the display boundary, which is the whole reason the field changed unit.
  const page = fs.readFileSync(new URL('../client/src/pages/News.tsx', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function usageLine'), page.indexOf('function TrackerMetric'));
  assert.ok(fn.startsWith('function usageLine('), 'usageLine has moved — re-point this test');
  assert.ok(fn.length < 900, `the usageLine slice is ${fn.length} chars — it ran past the function`);
  assert.match(fn, /snap_share \* 100/, 'the card prints the served fraction as if it were already a percentage');
  assert.match(fn, /snap_share_unreadable/, 'the card cannot tell the reader the share was unreadable');
});
