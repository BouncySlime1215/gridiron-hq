/**
 * Off-thread body for the synthetic worker job in watchdog-scheduler-subject.mjs.
 * It sleeps in its own worker thread and never touches the main thread, so it
 * can be in flight while something else blocks the main thread.
 */
export async function sleepFor(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
  return { slept_ms: ms };
}
