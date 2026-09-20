/**
 * The fantasy side read its current week out of the BETTING schedule table
 * (2026-09-19).
 *
 * `tradeWeekContext()` took no league and derived the week from the first
 * unscored row in `game_lines`, falling back to 1. `game_lines` is filled by
 * the odds feeds, so the fantasy half of the app was reading its week out of a
 * table it neither owns nor fills: with no lines loaded, or with every line
 * already scored, it silently became week 1 — and week 1 in September prices a
 * season that has started as one that has not.
 *
 * `leagueCurrentWeek(lg)` has had the right answer the whole time (ESPN's own
 * `status.currentMatchupPeriod`, captured at the last league sync) and said so
 * in its docstring: "Never a hard-coded 1 — that is how the app spent two weeks
 * showing week-1 lineups."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-week-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db, row } = await import('../server/db/index.js');
const { tradeWeekContext } = await import('../server/services/trade-engine.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const SEASON = 2026;

function league({ currentWeek = null, payload = null } = {}) {
  db.exec('DELETE FROM leagues');
  db.prepare(`INSERT INTO leagues (platform, league_id, season, name, current_week, payload)
              VALUES ('espn', 'L1', ?, 'Test League', ?, ?)`).run(SEASON, currentWeek, payload);
  return row('SELECT * FROM leagues WHERE league_id = ?', 'L1');
}

function lines(weeks) {
  db.exec('DELETE FROM game_lines');
  const insert = db.prepare(`INSERT INTO game_lines (season, week, team, team_score) VALUES (?,?,?,NULL)`);
  for (const w of weeks) insert.run(SEASON, w, `T${w}`);
}

test('with no lines loaded at all the league still knows what week it is', () => {
  // The defect in its plainest form: the betting table is empty, so the old
  // code fell through to 1 while the league had been syncing week 7 all along.
  lines([]);
  assert.equal(tradeWeekContext(league({ currentWeek: 7 })).week, 7);
});

test('the league outranks the betting table when the two disagree', () => {
  // Not a tie-break for its own sake: game_lines is filled by the odds feeds on
  // their own cadence, and nothing makes its first unscored week agree with the
  // league's matchup period.
  lines([3, 4, 5]);
  assert.equal(tradeWeekContext(league({ currentWeek: 7 })).week, 7,
    'the league\'s own matchup period, not the first unscored betting line');
});

test('a league synced before the current_week column falls back to its payload', () => {
  lines([3]);
  const lg = league({ payload: JSON.stringify({ status: { currentMatchupPeriod: 9 } }) });
  assert.equal(tradeWeekContext(lg).week, 9);
});

test('the week is still clamped to the season', () => {
  lines([]);
  assert.equal(tradeWeekContext(league({ currentWeek: 40 })).week, 18);
  assert.equal(tradeWeekContext(league({ currentWeek: 0 })).week >= 1, true);
});

test('with no league in hand the old betting-table fallback is unchanged', () => {
  // Kept deliberately. A few callers genuinely have no league — a script, a
  // player page asked about a player rather than a roster — and for those an
  // approximate week beats throwing. It is the no-league path now, not the
  // only path.
  lines([6, 7]);
  assert.equal(tradeWeekContext().week, 6);
  assert.equal(tradeWeekContext(null).week, 6);
});

test('the season is left alone', () => {
  // A league's own `season` column can differ from the app's. Reconciling the
  // two is the NFL_SEASON tidy-up; doing it here would move every cache key in
  // trade-engine.js for a reason unrelated to the week.
  lines([]);
  assert.equal(tradeWeekContext(league({ currentWeek: 7 })).season, SEASON);
});
