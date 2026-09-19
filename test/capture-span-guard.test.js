import test from 'node:test';
import assert from 'node:assert/strict';
import { processSpan, spanWarning, RESTART_TOLERANCE_MS }
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
