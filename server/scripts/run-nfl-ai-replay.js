/** Detached worker: keeps the interactive Express server responsive during a replay. */
import { runAiReplayWorker } from '../services/nfl-ai-replay.js';
import { run } from '../db/index.js';

const id = Number(process.argv[2]);
const recordFatal = error => {
  try { run(`UPDATE nfl_ai_replay_runs SET status='failed',error=? WHERE id=? AND status='running'`, String(error?.stack ?? error), id); }
  catch { /* parent exit handler is a second safety net */ }
};
process.on('uncaughtException', error => { recordFatal(error); process.exitCode = 1; });
process.on('unhandledRejection', error => { recordFatal(error); process.exitCode = 1; });
if (!Number.isInteger(id) || id < 1) process.exitCode = 1;
else {
  try { await runAiReplayWorker(id); }
  catch (error) {
    recordFatal(error);
    console.error(error);
    process.exitCode = 1;
  }
}
