/**
 * The coaching-profile fourth-down trait must describe the number it actually has.
 *
 * `football-context.js:195` prints a sentence about a team's coaching style —
 * "goes for it on fourth down", or its inverse "punts and kicks" — driven by
 * `off_fourth_down_rate`. That field is not a go-for-it rate.
 *
 * `nfl-pbp.js:247` increments `fourth_att` on EVERY fourth-down play, punts and
 * field goals included, and `fourth_conv` only when the play gained a first
 * down, which only a go-for-it attempt produces. `:461` then divides one by the
 * other. So the field is the share of all fourth downs that ended in a first
 * down — approximately go-for-it rate times conversion rate.
 *
 * Measured on the 2024 regular season, from the same play-by-play the code
 * reads (docs/evidence/2026-09-22/fourth-down-rate-unit-mismatch.md, Model
 * evidence audit's branch):
 *
 *     what the code computes, fourth_conv/fourth_att   0.1199
 *     the go-for-it rate the label claims              0.1866
 *     go-for-it rate x conversion rate                 0.1060
 *
 * The label is wrong by a factor of 1.6, and it is wrong where Nick can see it:
 * this is one of the few places the mismatch prints as an English sentence about
 * a coach.
 *
 * The honest go-for-it rate is not available to fix this with. It would need
 * `nfl-pbp.js` to publish a rate whose denominator keeps punts and field goals,
 * and that file is not this one's to edit. Checked at the time of writing:
 * `off_fourth_down_go_rate` exists on none of the 155 remote branches, against a
 * control of `off_fourth_down_rate`, which is on all of them.
 *
 * So the fix available here is to stop claiming a quantity this file does not
 * have, and describe the one it does. A team high on this number converted more
 * of its fourth downs into first downs than most teams. That is true, it is
 * useful, and it does not tell Nick his coach is aggressive on the strength of a
 * number that mostly reflects punting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fourth-down-trait-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { coachingProfile } = await import('../server/services/football-context.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
// Twenty teams over two completed weeks: past the 32-row floor coachingProfile
// needs, and past the 16-team floor the percentile gate needs.
const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ',
  'KKK', 'LLL', 'MMM', 'NNN', 'OOO', 'PPP', 'QQQ', 'RRR', 'SSS', 'TTT'];

// The other four tendencies are SPREAD across the league, and rotated so that the
// two teams under test sit mid-pack on every one of them. Giving every team the
// same value does not work: the percentile is then 0 for all of them, so all four
// fire as their inverse, and since `reading` prints only the first three traits
// the fourth-down sentence never appears — a test written that way passes without
// ever exercising the thing it names.
function features(i, fourthDownRate) {
  const rot = (i + 10) % TEAMS.length;   // TTT -> 9, AAA -> 10: the middle.
  return JSON.stringify({
    off_proe: -0.05 + (rot * 0.005),
    off_seconds_per_drive: 25 + (rot * 0.5),
    off_no_huddle_rate: 0.02 + (rot * 0.005),
    off_deep_attempt_rate: 0.08 + (rot * 0.005),
    off_fourth_down_rate: fourthDownRate
  });
}

for (const [i, team] of TEAMS.entries()) {
  // TTT highest, AAA lowest, everyone else evenly between.
  const rate = 0.02 + (i * 0.02);
  for (const week of [1, 2]) {
    run(`INSERT INTO nfl_team_week_features (season, week, team, opponent, home, features)
         VALUES (?, ?, ?, 'ZZZ', 1, ?)`, SEASON, week, team, features(i, rate));
  }
}

const HIGH = 'TTT';
const LOW = 'AAA';
const profileFor = team => coachingProfile(team, SEASON, 3);

// The two claims the number cannot support, in the wording the file used.
const AGGRESSION = /goes for it|going for it/i;
const TIMIDITY = /punts and kicks|punts/i;

test('the fixture leaves fourth down as the only tendency in play', () => {
  // Guards the assertions below: if another trait fired, it would take one of the
  // three slots `reading` prints and the sentence test would pass vacuously.
  for (const team of [HIGH, LOW]) {
    const metrics = profileFor(team).traits.map(t => t.metric);
    assert.deepEqual(metrics, ['off_fourth_down_rate'],
      `${team} fired a trait other than fourth down, so the reading test would not be testing it`);
  }
});

test('the top team is not described as going for it on fourth down', () => {
  const p = profileFor(HIGH);
  const t = p.traits.find(x => x.metric === 'off_fourth_down_rate');
  assert.ok(t, 'the fourth-down trait did not fire for the top team, so nothing is under test');
  assert.doesNotMatch(t.trait, AGGRESSION,
    'the trait still claims aggression from a rate whose denominator is mostly punts');
});

test('the bottom team is not described as punting and kicking', () => {
  const p = profileFor(LOW);
  const t = p.traits.find(x => x.metric === 'off_fourth_down_rate');
  assert.ok(t, 'the fourth-down trait did not fire for the bottom team, so nothing is under test');
  assert.doesNotMatch(t.trait, TIMIDITY,
    'the inverse still claims timidity from a rate that does not measure the choice');
});

test('the sentence Nick reads makes neither claim', () => {
  for (const team of [HIGH, LOW]) {
    const p = profileFor(team);
    assert.doesNotMatch(p.reading, AGGRESSION, `${team}'s reading claims aggression`);
    assert.doesNotMatch(p.reading, TIMIDITY, `${team}'s reading claims timidity`);
  }
});

test('the trait still says something true rather than being deleted', () => {
  const p = profileFor(HIGH);
  const t = p.traits.find(x => x.metric === 'off_fourth_down_rate');
  assert.match(t.trait, /first down/i,
    'the trait no longer describes converting fourth downs into first downs, which is what the number is');
  // The direction still has to be right: the top team converts more, not less.
  const low = profileFor(LOW).traits.find(x => x.metric === 'off_fourth_down_rate');
  assert.notEqual(t.trait, low.trait, 'the top and bottom teams read identically');
  assert.ok(t.percentile > low.percentile, 'the percentile ordering inverted');
});

test('the trait carries the value it was derived from, so the sentence can be checked', () => {
  const t = profileFor(HIGH).traits.find(x => x.metric === 'off_fourth_down_rate');
  assert.equal(typeof t.value, 'number');
  assert.ok(t.value > 0 && t.value <= 1, 'the value is not a rate');
});
