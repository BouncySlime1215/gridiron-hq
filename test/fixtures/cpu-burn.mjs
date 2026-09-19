/**
 * A deliberately synchronous CPU burn, for the off-thread scheduler test.
 *
 * It must block whatever thread it runs on — that is the whole point. A
 * `setTimeout` would prove nothing, because the bug being fixed is a job that
 * holds the thread, not one that merely takes a long time.
 */
export function burn(ms = 1000) {
  const until = Date.now() + ms;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);
  return { burned_ms: ms, checksum: Number.isFinite(n) };
}
