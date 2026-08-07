/** Detached worker: keeps the interactive Express server responsive during a replay. */
import { runAiReplayWorker } from '../services/nfl-ai-replay.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id < 1) process.exitCode = 1;
else {
  try { await runAiReplayWorker(id); }
  catch (error) {
    // The service records operational failures in the run row. This is only a
    // last-resort exit marker for malformed worker startup.
    console.error(error);
    process.exitCode = 1;
  }
}
