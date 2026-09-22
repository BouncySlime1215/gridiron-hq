import test from 'node:test';
import assert from 'node:assert/strict';
import { processSpan, spanWarning, readCrossedRestart, RESTART_TOLERANCE_MS }
  from '../scripts/lib/capture-span.mjs';

const at = iso => ({ read: true, uptime_s: 100, started_at: iso });

/**
 * The defect this guards. The availability capture reads five leagues in
 * sequence over several minutes. If the app restarts in the middle, the
 * leagues read before the restart were answered out of memos that carry no fit
 * id (routes/model.js, draft-assist.js) and the leagues read after were
 * recomputed. Compared against a baseline, that restart reads as the fit
 * having moved something. Every assertion here is about the capture refusing
 * to call itself comparable when it is not.
 */

test('a restart in the middle of a capture is not a comparable capture', () => {
  const span = processSpan(at('2026-09-19T22:27:34Z'), at('2026-09-19T22:33:17Z'));
  assert.equal(span.known, true);
  assert.equal(span.same_process, false, 'a 343-second move in the derived start is a restart');
  assert.match(spanWarning(span, 'this capture'), /restarted mid-capture/);
});

test('round-trip jitter within one process is not a restart', () => {
  // Two readings of the same process disagree by a few seconds: `uptime_s` is
  // whole seconds and each read's own latency lands inside the derived start.
  const span = processSpan(at('2026-09-19T22:27:34Z'), at('2026-09-19T22:27:37Z'));
  assert.equal(span.same_process, true);
  assert.equal(spanWarning(span, 'this capture'), null, 'a clean span says nothing');
});

test('the boundary is the tolerance, not somewhere near it', () => {
  const base = Date.parse('2026-09-19T22:27:34Z');
  const inside = processSpan(at(new Date(base).toISOString()),
    at(new Date(base + RESTART_TOLERANCE_MS).toISOString()));
  const outside = processSpan(at(new Date(base).toISOString()),
    at(new Date(base + RESTART_TOLERANCE_MS + 1000).toISOString()));
  assert.equal(inside.same_process, true, 'exactly at the tolerance still counts as one process');
  assert.equal(outside.same_process, false);
});

test('a failed health read is unknown, never a pass', () => {
  // The healthy-looking-and-not-working shape: if "could not tell" collapsed
  // into "fine", a capture taken while the app was wedging would present as
  // comparable.
  const failedBefore = processSpan({ read: false, status: 503 }, at('2026-09-19T22:27:34Z'));
  const failedAfter = processSpan(at('2026-09-19T22:27:34Z'), { read: false, status: 0 });
  for (const span of [failedBefore, failedAfter]) {
    assert.equal(span.known, false);
    assert.equal(span.same_process, undefined, 'an unknown span must not claim one process');
    assert.match(spanWarning(span, 'this capture'), /cannot say/);
  }
});

test('a capture taken before this guard existed is unestablished, not clean', () => {
  // docs/evidence/2026-09-19/availability-baseline.json has no process_span at
  // all. Treating a missing span as a pass would let the first --compare after
  // this landed attribute movement it cannot attribute.
  assert.match(spanWarning(undefined, 'the baseline'), /comparability is unestablished/);
  assert.match(spanWarning(null, 'the baseline'), /comparability is unestablished/);
});

/**
 * The second guard: a single read that proves its own validity.
 *
 * Fly's edge holds a request against a machine that is going down and replays
 * it into the machine that comes up, so a read issued before a restart can be
 * answered after one, with a 200 and nothing to show for it. The bracket above
 * cannot see that: both of its readings can be clean while a restart happened
 * inside one of them. The tell is in the response itself.
 *
 * Observed live on 2026-09-19: a request issued at 22:38:59Z returned
 * uptime_s 13 after 29.1 seconds in flight.
 */

test('a process younger than the request that reached it did not answer that request', () => {
  assert.equal(readCrossedRestart(13, 29100), true, 'the live 22:38:59Z read');
  assert.equal(readCrossedRestart(65, 23380), false, 'the live 22:28:15Z read was valid');
  assert.equal(readCrossedRestart(22, 346), false, 'a fast read on a young process is fine');
});

test('whole-second uptime rounding is not treated as a restart', () => {
  // server/platform/health.js:45 rounds uptime_s, so a read that took 900ms
  // against a process reporting 1s cannot be evidence of anything. Without the
  // margin this fires on every fast read against a freshly started process.
  assert.equal(readCrossedRestart(1, 900), false);
  assert.equal(readCrossedRestart(1, 1400), false, 'still inside the rounding margin');
  // Not a rounding case, though it looks like one. `uptime_s` 0 means a true
  // uptime under half a second, and the request was in flight for 1.5s, so the
  // process began after the request was sent. The margin must not swallow this.
  assert.equal(readCrossedRestart(0, 1500), true);
  assert.equal(readCrossedRestart(0, 5000), true, 'five seconds against a zero-uptime process is not rounding');
});

test('a missing or non-numeric reading is never a crossing', () => {
  // The caller reaches this with whatever the body carried. Guessing here would
  // turn a changed response shape into a fabricated restart.
  for (const bad of [undefined, null, NaN, '13']) {
    assert.equal(readCrossedRestart(bad, 29100), false);
    assert.equal(readCrossedRestart(13, bad), false);
  }
});

test('a crossed read is a detection, not a failure to detect', () => {
  // It must not be filed under "could not tell": the response established that
  // a restart happened. known stays true and same_process is false.
  const crossed = { read: false, crossed_restart: true, uptime_s: 13, ms: 29100 };
  const clean = at('2026-09-19T22:27:34Z');
  for (const span of [processSpan(crossed, clean), processSpan(clean, crossed)]) {
    assert.equal(span.known, true, 'a crossed read tells us a restart happened');
    assert.equal(span.same_process, false);
    assert.equal(span.crossed_restart, true);
    assert.match(spanWarning(span, 'this capture'), /younger than the request itself/);
  }
});

test('a clean bracket reports no crossing rather than leaving the field absent', () => {
  const span = processSpan(at('2026-09-19T22:27:34Z'), at('2026-09-19T22:27:37Z'));
  assert.equal(span.crossed_restart, false, 'absent would read as unknown to a later caller');
  assert.equal(spanWarning(span, 'this capture'), null);
});
