import { rows } from '../db/index.js';

const parse = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };

/** Both tables here are created only by nfl-2022-2025-rebuild.mjs, on its
 * first run — absent on any machine that script has never been run on. A
 * bare catch around the read cannot tell that apart from a real query fault
 * (a locked database, a column the schema no longer has), and used to
 * report both as a silent empty answer. Checked explicitly instead, same
 * treatment as manager-signals.js's txIndex: the surface gets a named
 * "present: false" for the one case that is genuinely just "never run",
 * and every other read error now throws instead of vanishing. */
const tableExists = name => rows(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, name).length > 0;

export function nflRebuildProgress(runKey = 'nfl-2022-2025-shared-state-v2-decision-provenance') {
  const progressPresent = tableExists('nfl_rebuild_progress');
  const checkpointsPresent = tableExists('nfl_rebuild_checkpoints');

  const progress = progressPresent
    ? rows(`SELECT phase,current,total,unit,status,detail_json,updated_at
        FROM nfl_rebuild_progress WHERE run_key=? ORDER BY rowid`, runKey).map(item => ({
        ...item, percent: item.total ? +((item.current / item.total) * 100).toFixed(1) : 0,
        detail: parse(item.detail_json), detail_json: undefined
      }))
    : [];
  const checkpoints = checkpointsPresent
    ? rows(`SELECT phase,status,started_at,finished_at,error
        FROM nfl_rebuild_checkpoints WHERE run_key=? ORDER BY started_at`, runKey)
    : [];

  const active = progress.find(item => item.status === 'running')
    ?? checkpoints.find(item => item.status === 'running') ?? null;
  return {
    run_key: runKey, active, progress, checkpoints,
    progress_present: progressPresent, checkpoints_present: checkpointsPresent
  };
}
