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
import { JOBS, MAIN_THREAD_ONLY, ON_REQUEST_THREAD, resolveOffThread, bootOffThread }
  from '../server/services/scheduler.js';

// Every job in the registry, heavy excluded: heavy resolves off-thread by
// default and is gated on AUTO_HEAVY_SYNC, so it has neither question to
// answer. Live is in here because #59's boot fix does not reach the live
// timer, which is the whole reason this list grew past the background tier.
const ACCOUNTABLE = Object.entries(JOBS).filter(([, j]) => (j.tier ?? 'live') !== 'heavy');

test('every job is accounted for, on every tier', () => {
  const unaccounted = ACCOUNTABLE
    .filter(([name, job]) => !resolveOffThread(job)
      && !MAIN_THREAD_ONLY.has(name) && !ON_REQUEST_THREAD.has(name))
    .map(([name]) => name);
  assert.deepEqual(unaccounted, [],
    'these jobs run on the request thread and nothing says why. THE TIER DOES NOT DO IT: '
    + "resolveOffThread reads `job.offThread ?? job.tier === 'heavy'`, so only the heavy "
    + "tier goes off-thread by default and a 'growth', 'live' or 'metered' job needs "
    + '`offThread: true` on its own definition. Choosing a lighter tier to stay clear of '
    + "the heavy tier's AUTO_HEAVY_SYNC gate therefore also puts the job on the request "
    + 'thread, which is not what the author of such a job is usually choosing. So: add '
    + '`offThread: true`, or add them to ON_REQUEST_THREAD with the reason, or to '
    + 'MAIN_THREAD_ONLY if they genuinely cannot move. A job that blocks the app is '
    + 'allowed; an unexplained one is not');
});

test('the boot pass and the live timer agree about the same job', () => {
  // #59 took the boot pass off the request thread by passing bootOffThread(j)
  // as an override. The live timer calls runIfStale(j) with no override, so a
  // job could go into a worker once at boot and run inline every 90 seconds
  // afterwards -- and fourteen did. #63 fixed that shape for one job on the
  // background tier; this is the same question asked of every live job.
  //
  // Not an assertion that they must agree: a job CAN legitimately be worth a
  // worker at boot and not on the tick. It is an assertion that where they
  // disagree, someone has written down why.
  const disagree = Object.entries(JOBS)
    .filter(([name, job]) => (job.tier ?? 'live') === 'live')
    .filter(([name, job]) => resolveOffThread(job, bootOffThread(name)) !== resolveOffThread(job))
    .filter(([name]) => !ON_REQUEST_THREAD.has(name) && !MAIN_THREAD_ONLY.has(name))
    .map(([name]) => name);
  assert.deepEqual(disagree, [],
    'these live jobs run in a worker at boot and on the request thread every 90 seconds '
    + 'after it, with nothing saying that is deliberate');
});

test('the audited fantasy jobs actually run off the request thread', () => {
  // Called the way the tier timer calls it — no override — because that is the
  // path #63 found a fix could hold everywhere else and still fail on.
  for (const name of ['espn_depth_chart', 'espn_season_stats', 'sleeper_players',
    'espn_rosters', 'nfl_coaches', 'nfl_offseason_depth_injury',
    'rss_news', 'espn_news', 'nfl_news_signals', 'league_rosters',
    'player_rosters', 'nfl_injuries', 'nfl_transactions']) {
    assert.ok(JOBS[name], `${name} is no longer a job; this list needs updating`);
    assert.equal(resolveOffThread(JOBS[name]), true,
      `${name} fetches and parses a feed and writes rows; it has no business doing that `
      + 'on the thread that serves requests');
  }
});

test('nothing is both moved and excused', () => {
  for (const [name, job] of ACCOUNTABLE) {
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
  // boot-path-off-thread.test.js. Twenty-six is what is left across all three
  // accountable tiers: 13 live, 6 metered, 7 growth. Every one is either in
  // ON_REQUEST_THREAD (22) or MAIN_THREAD_ONLY (4), and 22 + 4 = 26 is the
  // arithmetic that makes the test above more than a formality.
  //
  // Was 29 (16 live, ON_REQUEST_THREAD 25) until mlb_schedule, mlb_probables
  // and mlb_boxscores moved off-thread on 2026-09-22. They were excused as a
  // sport nothing here reads, which said why nobody needed the rows and never
  // said the job was free; it blocked every request for its full duration
  // either way. See test/mlb-jobs-off-thread.test.js.
  //
  // Moving another job off-thread lowers this number and this line is edited
  // down; adding a new job that blocks the request thread raises it, and that
  // should cost an argument rather than a quiet commit.
  const onThread = ACCOUNTABLE.filter(([, j]) => !resolveOffThread(j)).length;
  assert.ok(onThread <= 26,
    `${onThread} jobs now run on the request thread, up from 26. `
    + 'If that is deliberate, lower this bound in the same commit and say why');
  assert.equal(ON_REQUEST_THREAD.size + MAIN_THREAD_ONLY.size, onThread,
    'every job that blocks the request thread should be in exactly one of the two '
    + 'lists, and nothing else should be');
});
