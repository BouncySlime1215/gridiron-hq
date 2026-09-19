/**
 * Child process for the loop-watchdog test. Starts the watchdog, then blocks
 * the event loop for longer than its threshold. A live watchdog kills this
 * process; a broken one lets it print "survived" and exit 0.
 */
import { startLoopWatchdog } from '../../server/platform/loop-watchdog.js';

const thresholdMs = Number(process.argv[2]);
const blockMs = Number(process.argv[3]);

startLoopWatchdog({ thresholdMs, armAfterMs: 0 });

// Let the heartbeat and the worker start before blocking anything.
setTimeout(() => {
  const until = Date.now() + blockMs;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);
  console.log('survived', Number.isFinite(n));
  process.exit(0);
}, 300);
