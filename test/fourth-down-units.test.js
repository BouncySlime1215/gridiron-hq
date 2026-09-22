/**
 * `off_fourth_down_rate` is conversions over go-for-it attempts — punts and
 * field goals never reach the accumulator, because nfl-pbp.js:215 drops every
 * play_type that is not pass or run. Four consumers read it as an aggression
 * rate instead:
 *
 *   nfl-sim-policy.js:503   "how often this team actually goes for it"
 *   nfl-sim-learn.js:52     league prior 0.20
 *   football-context.js:195 the trait label "goes for it on fourth down"
 *   td-features.js:262      "a team that does not trust its kicker goes for it more"
 *
 * Measured over 1,602 team-weeks of 2022-2025 the field means 0.544, not 0.20,
 * so coachAggression pins 63.2% of team-weeks at its -0.6 clamp floor and
 * reports them all as maximally aggressive staffs. The clamp swallows it: no
 * error, no warning, a number that is simply wrong by a factor of two and a
 * half. See docs/tdd/fourth-down-units.tdd.md.
 *
 * The fix here is the producer half only: emit the go-for-it rate as its own
 * field with punts and field goals in the denominator, and leave the existing
 * conversion rate untouched so no stored row changes meaning.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fourth-units-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const COLS = ['season_type', 'week', 'posteam', 'defteam', 'home_team', 'play_type',
  'down', 'ydstogo', 'yardline_100', 'epa', 'success', 'first_down', 'penalty'];

/** One play. Anything omitted is blank, which the parser reads as null. */
const play = o => COLS.map(c => (o[c] ?? '')).join(',');

/**
 * BUF's week 1: four fourth downs — two go-for-its (one converted), one punt,
 * one field goal. The go-for-it rate is 2/4 = 0.5; the conversion rate is
 * 1/2 = 0.5 as well, so the fixture also uses week 2 to separate them.
 *
 * Week 2: three go-for-its, none converted, plus three punts. Go rate 3/6 =
 * 0.5, conversion rate 0/3 = 0. A field that conflates the two cannot report
 * both.
 */
const base = { season_type: 'REG', posteam: 'BUF', defteam: 'MIA', home_team: 'BUF', epa: '0.1', success: '1' };
const csv = [COLS.join(',')]
  // week 1
  , w1 = [
    { ...base, week: 1, play_type: 'run', down: 4, ydstogo: 1, yardline_100: 45, first_down: 1 },
    { ...base, week: 1, play_type: 'pass', down: 4, ydstogo: 8, yardline_100: 55, first_down: 0 },
    { ...base, week: 1, play_type: 'punt', down: 4, ydstogo: 12, yardline_100: 70 },
    { ...base, week: 1, play_type: 'field_goal', down: 4, ydstogo: 6, yardline_100: 25 },
    // a first-down snap so the week has ordinary plays too
    { ...base, week: 1, play_type: 'run', down: 1, ydstogo: 10, yardline_100: 75 }
  ]
  , w2 = [
    { ...base, week: 2, play_type: 'pass', down: 4, ydstogo: 4, yardline_100: 50, first_down: 0 },
    { ...base, week: 2, play_type: 'pass', down: 4, ydstogo: 9, yardline_100: 60, first_down: 0 },
    { ...base, week: 2, play_type: 'run', down: 4, ydstogo: 2, yardline_100: 40, first_down: 0 },
    { ...base, week: 2, play_type: 'punt', down: 4, ydstogo: 14, yardline_100: 80 },
    { ...base, week: 2, play_type: 'punt', down: 4, ydstogo: 10, yardline_100: 75 },
    { ...base, week: 2, play_type: 'punt', down: 4, ydstogo: 7, yardline_100: 65 },
    // a fourth-down penalty: the down replays, so it is not a fourth-down decision
    { ...base, week: 2, play_type: 'no_play', down: 4, ydstogo: 5, yardline_100: 50, penalty: 1 },
    { ...base, week: 2, play_type: 'run', down: 1, ydstogo: 10, yardline_100: 75 }
  ];
for (const p of [...w1, ...w2]) csv.push(play(p));

globalThis.fetch = async () => ({
  ok: true, status: 200,
  body: Readable.toWeb(Readable.from([zlib.gzipSync(Buffer.from(csv.join('\n') + '\n'))]))
});

const { syncPbpSeason } = await import('../server/services/nfl-pbp.js');
await syncPbpSeason(2024);

const feat = week => JSON.parse(rows(
  'SELECT features FROM nfl_team_week_features WHERE season=2024 AND week=? AND team=?', week, 'BUF')[0].features);

test('the go-for-it rate counts punts and field goals in its denominator', () => {
  assert.equal(feat(1).off_fourth_down_go_rate, 0.5);   // 2 go-for-its of 4 fourth downs
  assert.equal(feat(2).off_fourth_down_go_rate, 0.5);   // 3 of 6; the penalty is not a decision
});

test('the conversion rate stays conversions over go-for-it attempts', () => {
  assert.equal(feat(1).off_fourth_down_rate, 0.5);      // 1 converted of 2 attempts
  assert.equal(feat(2).off_fourth_down_rate, 0);        // 0 of 3 — a week the two rates disagree
});

test('the attempt and situation counts are published, so a rate over one snap is visible', () => {
  assert.equal(feat(1).off_fourth_down_attempts, 2);
  assert.equal(feat(1).off_fourth_down_situations, 4);
  assert.equal(feat(2).off_fourth_down_attempts, 3);
  assert.equal(feat(2).off_fourth_down_situations, 6);
});

test('the defense gets the same pair, read from the other side', () => {
  assert.equal(JSON.parse(rows(
    'SELECT features FROM nfl_team_week_features WHERE season=2024 AND week=1 AND team=?', 'MIA')[0].features)
    .def_fourth_down_situations, 4);
});
