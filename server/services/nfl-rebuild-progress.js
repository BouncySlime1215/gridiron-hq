import { rows } from '../db/index.js';

const parse = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };

export function nflRebuildProgress(runKey = 'nfl-2022-2025-shared-state-v1') {
  let progress = [], checkpoints = [];
  try {
    progress = rows(`SELECT phase,current,total,unit,status,detail_json,updated_at
      FROM nfl_rebuild_progress WHERE run_key=? ORDER BY rowid`, runKey).map(item => ({
      ...item, percent: item.total ? +((item.current / item.total) * 100).toFixed(1) : 0,
      detail: parse(item.detail_json), detail_json: undefined
    }));
  } catch { /* runner has not created the progress table yet */ }
  try {
    checkpoints = rows(`SELECT phase,status,started_at,finished_at,error
      FROM nfl_rebuild_checkpoints WHERE run_key=? ORDER BY started_at`, runKey);
  } catch { /* runner has not created the checkpoint table yet */ }
  const active = progress.find(item => item.status === 'running')
    ?? checkpoints.find(item => item.status === 'running') ?? null;
  return { run_key: runKey, active, progress, checkpoints };
}
