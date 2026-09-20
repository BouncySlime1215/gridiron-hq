/**
 * Every growth and metered job accounts for which thread it runs on
 * (2026-09-20).
 *
 * Nineteen of them were on the request thread. That number came out of a
 * census and nobody could act on it: it says how many without saying which,
 * or why any one of them is still there. node:sqlite is fully synchronous, so
 * each of those is a stretch of wall-clock during which the app answers
 * nothing — "a slow job" and "an outage" are the same event here.
 *
 * Six moved, after auditing what each keeps in memory rather than reading the
 * tier and assuming. The rest are named with a reason. The rule these tests
 * enforce is that there is no fourth option: a growth or metered job is
 * off-thread, or it MUST NOT be (MAIN_THREAD_ONLY), or it simply has not moved
 * and says why (ON_REQUEST_THREAD). A job added later cannot join the quiet
 * majority without someone writing a sentence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOBS, MAIN_THREAD_ONLY, ON_REQUEST_THREAD, resolveOffThread }
  from '../server/services/scheduler.js';

const BACKGROUND = Object.entries(JOBS).filter(([, j]) => j.tier === 'growth' || j.tier === 'metered');

test('every growth and metered job is accounted for', () => {
  const unaccounted = BACKGROUND
    .filter(([name, job]) => !resolveOffThread(job)
      && !MAIN_THREAD_ONLY.has(name) && !ON_REQUEST_THREAD.has(name))
    .map(([name]) => name);
  assert.deepEqual(unaccounted, [],
    'these jobs run on the request thread and nothing says why. Move them off-thread, '
    + 'or add them to ON_REQUEST_THREAD with the reason, or to MAIN_THREAD_ONLY if they '
    + 'genuinely cannot move. A job that blocks the app is allowed; an unexplained one is not');
});

test('the six audited fantasy ingests actually run off the request thread', () => {
  // Called the way the tier timer calls it — no override — because that is the
  // path #63 found a fix could hold everywhere else and still fail on.
  for (const name of ['espn_depth_chart', 'espn_season_stats', 'sleeper_players',
    'espn_rosters', 'nfl_coaches', 'nfl_offseason_depth_injury']) {
    assert.ok(JOBS[name], `${name} is no longer a job; this list needs updating`);
    assert.equal(resolveOffThread(JOBS[name]), true,
      `${name} fetches and parses a feed and writes rows; it has no business doing that `
      + 'on the thread that serves requests');
  }
});

test('nothing is both moved and excused', () => {
  for (const [name, job] of BACKGROUND) {
    if (!resolveOffThread(job)) continue;
    assert.ok(!ON_REQUEST_THREAD.has(name),
      `${name} runs off-thread but ON_REQUEST_THREAD still claims it does not; `
      + 'a stale excuse reads as a current one');
  }
});

test('the two lists stay separate, and every excuse is a sentence', () => {
  for (const [name, reason] of ON_REQUEST_THREAD) {
    assert.ok(JOBS[name], `ON_REQUEST_THREAD names ${name}, which is not a job`);
    assert.ok(!MAIN_THREAD_ONLY.has(name),
      `${name} is in both lists. MAIN_THREAD_ONLY means it must not move; `
      + 'ON_REQUEST_THREAD means it has not. They cannot both be true');
    assert.ok(typeof reason === 'string' && reason.length > 20,
      `${name} needs a reason someone can act on, not a placeholder`);
  }
});

test('the count is going down, not up', () => {
  // A ratchet, in the shape that caught the allow-list growing in
  // boot-path-off-thread.test.js. Thirteen is what is left after this change.
  // Moving another job off-thread lowers this number and this line is edited
  // down; adding a new job that blocks the request thread raises it, and that
  // should cost an argument rather than a quiet commit.
  const onThread = BACKGROUND.filter(([, j]) => !resolveOffThread(j)).length;
  assert.ok(onThread <= 13,
    `${onThread} growth/metered jobs now run on the request thread, up from 13. `
    + 'If that is deliberate, lower this bound in the same commit and say why');
});
