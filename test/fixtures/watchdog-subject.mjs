/**
 * Child process for the loop-watchdog test. Starts the watchdog, then blocks
 * the event loop for longer than its threshold. A live watchdog kills this
 * process; a broken one lets it print "survived" and exit 0.
 */
import { startLoopWatchdog, armLoopWatchdog } from '../../server/platform/loop-watchdog.js';

const thresholdMs = Number(process.argv[2]);
const blockMs = Number(process.argv[3]);
// 'never-served' models a process that has not completed an HTTP response yet,
// which must never be killed however long it blocks -- that is a slow boot,
// and killing it would be a restart loop.
const served = process.argv[4] !== 'never-served';
// 'armed-early' models the real deployed order: startScheduler's onBootComplete
// fires synchronously under SCHEDULER_DISABLED=1, which is BEFORE app.listen
// and so before the watchdog exists. The arm has to survive that gap, or an
// app nobody visits wedges and is never restarted.
const armEarly = process.argv[4] === 'armed-early';

if (armEarly) armLoopWatchdog();
startLoopWatchdog({ thresholdMs });
if (served && !armEarly) armLoopWatchdog();

// Let the heartbeat and the worker start before blocking anything.
setTimeout(() => {
  const until = Date.now() + blockMs;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);
  console.log('survived', Number.isFinite(n));
  process.exit(0);
}, 300);
