/**
 * The main-thread allow-list has to hold on every path, not one of them
 * (2026-09-20).
 *
 * `MAIN_THREAD_ONLY` was consulted only by `bootOffThread`, so it governed the
 * boot pass and nothing else. It looked like it held: all three entries are
 * `live`-tier with no `offThread` flag, so no other path ever had a reason to
 * send one to a worker. That is a coincidence, not a guarantee. Flag one
 * `offThread: true`, or move one to the heavy tier, and the tier timer would
 * hand it to a worker with the allow-list sitting there saying it must not go.
 *
 * Same shape as the defect #63 fixed one layer up: a fix that holds until the
 * next tick is not a fix. These tests call `resolveOffThread` exactly the way
 * each path calls it — the timer with no override, the boot pass with one —
 * and assert the allow-list wins in both.
 *
 * The second half pins the PREMISE of the newest entry. An allow-list entry is
 * only as true as the reason written next to it, and a reason that quietly
 * stops being true is worse than no entry, because the next person reads it
 * and believes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JOBS, MAIN_THREAD_ONLY, resolveOffThread, bootOffThread, mainThreadOnlyReason }
  from '../server/services/scheduler.js';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('every allow-listed name is a real job, with a reason', () => {
  for (const [name, reason] of MAIN_THREAD_ONLY) {
    assert.ok(JOBS[name], `MAIN_THREAD_ONLY names ${name}, which is not in JOBS; `
      + 'an entry for a job that does not exist protects nothing and reads as though it does');
    assert.ok(typeof reason === 'string' && reason.length > 20,
      `${name} needs a reason saying what state it shares, not a bare listing`);
  }
});

test('the allow-list beats the heavy tier, which goes off-thread by default', () => {
  // The heavy tier resolves off-thread with no flag at all, so an allow-listed
  // job moved to that tier is the quietest way to lose the guarantee.
  //
  // This has to mutate the REAL entry and put it back. Every allow-listed job
  // is `live`-tier today, so asserting on it as it stands proves nothing — it
  // would resolve main-thread whether the allow-list were consulted or not,
  // which is the exact coincidence this change exists to remove. And a spread
  // copy cannot be used either: the lookup matches by identity against JOBS,
  // so `{ ...job, tier: 'heavy' }` is a different object and is never
  // allow-listed. The first version of this test did that and passed with the
  // allow-list check deleted.
  for (const name of MAIN_THREAD_ONLY.keys()) {
    const job = JOBS[name];
    assert.equal(mainThreadOnlyReason(job), MAIN_THREAD_ONLY.get(name));
    const tier = job.tier;
    try {
      job.tier = 'heavy';
      assert.equal(resolveOffThread(job), false,
        `${name} is allow-listed and must stay main-thread even on the heavy tier`);
    } finally { job.tier = tier; }

    const flag = job.offThread;
    try {
      job.offThread = true;
      assert.equal(resolveOffThread(job), false,
        `${name} is allow-listed and must stay main-thread even when flagged offThread`);
    } finally {
      if (flag === undefined) delete job.offThread; else job.offThread = flag;
    }
  }
});

test('the heavy-tier precondition is real, on a job that is not allow-listed', () => {
  // The other half of the test above: if a heavy job did NOT resolve
  // off-thread, the assertions there would pass for the wrong reason.
  assert.equal(resolveOffThread({ tier: 'heavy' }), true);
});

test('the allow-list beats an explicit override, on the boot path', () => {
  for (const name of MAIN_THREAD_ONLY.keys()) {
    assert.equal(bootOffThread(name), false, `${name} must not go off-thread at boot`);
    // And if a caller passes true anyway — a future boot pass, a script, a
    // hand-run — the allow-list still wins rather than the caller.
    assert.equal(resolveOffThread(JOBS[name], true), false,
      `an explicit override must not be able to send ${name} to a worker`);
  }
});

test('a job that is not allow-listed is unaffected', () => {
  // The regression guard: the new branch must not have made everything
  // main-thread, which would undo #56/#59/#61/#63 while every other test here
  // still passed.
  assert.equal(resolveOffThread({ tier: 'live' }, true), true);
  assert.equal(resolveOffThread({ tier: 'heavy' }, false), false);
  assert.equal(resolveOffThread({ tier: 'live' }), false);
  assert.equal(resolveOffThread({ tier: 'heavy' }), true);
  assert.equal(resolveOffThread(JOBS.nfl_model_growth), true,
    'the job the whole restart cycle traced back to must still resolve off-thread');
  assert.equal(mainThreadOnlyReason({ tier: 'heavy' }), null);
});

test('no job is both allow-listed and flagged off-thread', () => {
  // resolveOffThread resolves the contradiction in favour of the allow-list,
  // but a contradiction in the tree means one of the two is a mistake and
  // nobody knows which. Refuse it here rather than silently picking.
  for (const name of MAIN_THREAD_ONLY.keys()) {
    assert.notEqual(JOBS[name].offThread, true,
      `${name} is allow-listed main-thread-only and also flagged offThread`);
  }
});

test('the asset-universe warm job is allow-listed, for the reason it is', () => {
  const reason = MAIN_THREAD_ONLY.get('trade_asset_universe_warm');
  assert.ok(reason, 'trade_asset_universe_warm warms an in-process cache; off-thread it warms '
    + 'a worker that then exits, reports leagues_warmed and speeds up nothing');
  assert.match(reason, /in-process|worker/,
    'the reason must say what makes this one different from a memo');
});

test('the premise still holds: compute-cache keeps its store in memory only', () => {
  // The entry above is true only while this is. If the asset universe is ever
  // persisted the way report-cache.js persists to nfl_cached_reports, the
  // allow-list entry becomes wrong and the job can move off-thread — which is
  // the point of pinning the premise rather than the conclusion.
  const cache = read('../server/services/compute-cache.js');
  assert.match(cache, /^const store = new Map\(\);$/m,
    'compute-cache.js holds its results in a module-level Map; if that changed, '
    + "trade_asset_universe_warm's allow-list entry needs rereading");
  assert.doesNotMatch(cache, /INSERT\s+INTO/i,
    'compute-cache.js writes nothing to SQLite, which is why a worker cannot warm it');
});

test('the job really does warm that cache and persist nothing', () => {
  const scheduler = read('../server/services/scheduler.js');
  const body = /async function refreshTradeAssetUniverse\(\)\s*\{([\s\S]*?)\n\}/.exec(scheduler);
  assert.ok(body, 'refreshTradeAssetUniverse must still be a named function to read');
  assert.match(body[1], /assetUniverse\(lg, formatKey\)/,
    'the job calls assetUniverse for its side effect on the cache');
  assert.doesNotMatch(body[1], /INSERT\s+INTO|\brun\(/,
    'the job writes nothing; its only product is the populated cache, and that is '
    + 'the whole reason it cannot run in a worker');
});
