/**
 * The three MLB feeds stop blocking the request thread (2026-09-22).
 *
 * WHAT WAS WRONG. `growth-jobs-off-thread.test.js` made every job account for
 * the thread it runs on, and these three accounted for themselves with a
 * sentence in ON_REQUEST_THREAD: "MLB feed; the fantasy half of this app never
 * reads it". That is a true sentence and it was the wrong conclusion. A job
 * nothing reads still costs exactly what it costs, because node:sqlite's
 * DatabaseSync is synchronous: while `mlb_schedule` parses a season of games
 * and writes them, the process is not answering anybody, about football or
 * anything else. The production log says so in the scheduler's own words --
 *
 *   [scheduler] 'mlb_schedule' took 1.5s -- every request was blocked for that
 *   long while it ran
 *
 * -- and that sentence is only reachable from the inline branch at the
 * slow-job warning (scheduler.js), so it is a measurement, not cosmetics. The
 * excuse explained why nobody NEEDED the data. It never claimed the job was
 * free, and it was read as if it had.
 *
 * WHY THESE THREE AND NOT THE REST OF THE LIST. The other entries name a real
 * blocker -- odds-api.js's module-level `_lastHold`, sportsgameodds.js's
 * `_lastCallAt`, state a worker would reset every run -- or a cadence short
 * enough (3 minutes) that a module graph per run has not been measured against
 * the saving. These three have neither. Their whole product is rows in
 * mlb_games, mlb_probable_starters and the boxscore tables; every reader
 * (`starterFor`, `coverage`, routes/mlb.js) goes back to SQLite for it;
 * services/mlb.js holds one module-level binding, `const BASE`, a string.
 * Their cadences are 30, 60 and 90 minutes, so a worker per run is amortised
 * over the same interval that made it worth it for the fantasy jobs.
 *
 * AND THEY ALREADY RUN IN A WORKER. BOOT_JOBS lists all three, and
 * `bootOffThread` sends anything not in MAIN_THREAD_ONLY off-thread, so every
 * boot of the deployed app runs these three in a worker already. Ninety
 * seconds later the live timer calls `runIfStale(name)` with no override and
 * runs them inline, and every 90 seconds after that forever. This is #63's
 * defect exactly, on the tier #59's fix does not reach -- the same shape the
 * "boot pass and live timer agree" test was written for, which these three
 * were excused from by being on the list. So this change does not introduce a
 * worker path for them. It removes the half of the day they are not using it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOBS, MAIN_THREAD_ONLY, ON_REQUEST_THREAD, resolveOffThread, bootOffThread, BOOT_JOBS }
  from '../server/services/scheduler.js';

const MLB_FEEDS = ['mlb_schedule', 'mlb_probables', 'mlb_boxscores'];

test('the three MLB feeds run off the request thread on the tick path', () => {
  // No override, because the tier timer passes none. That is the whole defect:
  // a fix that only holds when a caller remembers to ask for it is not a fix.
  for (const name of MLB_FEEDS) {
    assert.ok(JOBS[name], `${name} is no longer a job; this list needs updating`);
    assert.equal(resolveOffThread(JOBS[name]), true,
      `${name} fetches a feed over the network and writes rows synchronously; every `
      + 'request is blocked for as long as that takes, whether or not anyone reads '
      + 'the rows afterwards');
  }
});

test('boot and the live timer now agree about the three, with no excuse needed', () => {
  for (const name of MLB_FEEDS) {
    assert.ok(BOOT_JOBS.includes(name),
      `${name} is no longer in the boot pass; the premise of this test has changed`);
    assert.equal(resolveOffThread(JOBS[name], bootOffThread(name)), resolveOffThread(JOBS[name]),
      `${name} runs in a worker at boot and on the request thread every 90 seconds after `
      + 'it. Those are the same job doing the same work; they cannot need different threads');
  }
});

test('the excuse is gone from both lists, not moved between them', () => {
  for (const name of MLB_FEEDS) {
    assert.ok(!ON_REQUEST_THREAD.has(name),
      `${name} runs off-thread now; leaving it in ON_REQUEST_THREAD would leave a stale `
      + 'excuse reading as a current one');
    assert.ok(!MAIN_THREAD_ONLY.has(name),
      `${name} moved because it CAN, not because it must stay. MAIN_THREAD_ONLY is for a `
      + 'job whose product is in-process memory (trade_asset_universe_warm) or which shares '
      + 'module-level state with another job; neither is true here');
  }
});

test('the three keep the by-name worker path, and nothing else about them changes', () => {
  // job-worker.js has two shapes. Without a `worker` descriptor it imports
  // scheduler.js in the thread and calls JOBS[name].run() -- which is what lets
  // these closures move without being restructured. A `worker` descriptor added
  // here later would be a different contract and should be a deliberate edit.
  const expected = {
    mlb_schedule: { maxAgeMinutes: 60, tier: 'live' },
    mlb_probables: { maxAgeMinutes: 90, tier: 'live' },
    mlb_boxscores: { maxAgeMinutes: 30, tier: 'live' }
  };
  for (const name of MLB_FEEDS) {
    assert.equal(JOBS[name].worker, undefined,
      `${name} should still be looked up by name in the worker's own import of scheduler.js`);
    assert.equal(JOBS[name].maxAgeMinutes, expected[name].maxAgeMinutes,
      `${name}'s cadence changed. This unit moves a job between threads and changes `
      + 'nothing about when or how often it runs');
    assert.equal(JOBS[name].tier, expected[name].tier, `${name}'s tier changed`);
  }
});

test("refreshInBackground's promise is now actually in the background", () => {
  // routes/mlb.js:61 and :126 call refreshInBackground on a page load and do
  // not await it, and the comment above it says the request returns
  // immediately "with whatever is stored". That was true of the request that
  // fired it and false of every other request in flight: `await runIfStale(j)`
  // yields at the await, then runs the job's synchronous SQLite writes on the
  // one thread serving all of them. Fire-and-forget is only fire-and-forget
  // once the work is somewhere else.
  //
  // The default argument is the assertion: whatever refreshInBackground runs
  // by default has to be a job that does not block, or the name is a promise
  // the function cannot keep.
  for (const name of ['mlb_schedule', 'mlb_boxscores']) {
    assert.equal(resolveOffThread(JOBS[name]), true,
      `${name} is reachable from a page load through refreshInBackground; inline, it `
      + 'blocks the requests that come after the one that triggered it');
  }
});

test('the ratchet bound is not left stale after a reduction', () => {
  // Written because a mutation survived, and it is worth being exact about
  // what this does and does not do about it.
  //
  // growth-jobs-off-thread.test.js guards the count with `onThread <= 26`.
  // Raising that literal to 99 fails nothing, and no behavioural test can make
  // it fail: a loose upper bound has no behaviour to assert against. Its
  // companion assertion, ON_REQUEST_THREAD.size + MAIN_THREAD_ONLY.size ===
  // onThread, does not catch it either, because both sides move together when
  // a job is added to a list.
  //
  // So this does not kill that mutation. It covers the CONSEQUENCE of it: with
  // the bound left stale, a job quietly added to ON_REQUEST_THREAD raises the
  // count and nothing over there notices, and an exact number here does.
  // 26 = 13 live + 6 metered + 7 growth, measured, not read off the comment.
  // Moving another job off-thread means editing this line AND the bound over
  // there, and that is the intended cost -- the ratchet is only worth having
  // if a reduction has to be claimed out loud.
  const accountable = Object.entries(JOBS).filter(([, j]) => (j.tier ?? 'live') !== 'heavy');
  const onThread = accountable.filter(([, j]) => !resolveOffThread(j)).length;
  assert.equal(onThread, 26,
    `${onThread} jobs run on the request thread, not the 26 recorded here. If a job moved `
    + 'off-thread, lower this number and the `onThread <= 26` bound in '
    + 'growth-jobs-off-thread.test.js in the same commit. If one was added, say why there');
});
