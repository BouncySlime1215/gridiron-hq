/**
 * E-XGB shadow forecasts (GRIDIRON_EXGB=1 only; nothing here is served).
 *
 * At each capture window of the in-progress and next game week (the same windows as the
 * frozen ESPN capture: Tuesday after waivers, Saturday morning, 2 h before each kickoff),
 * runs the locked models (`scripts/eval/exgb_shadow.py predict`, which refuses to run if
 * the feature/model code or artifacts no longer match the lock) and appends every arm's
 * forecast to exgb_shadow_predictions, stamped with the time. A forecast made at or after
 * the player's kickoff is flagged late and never graded (exgb-grader.js).
 *
 * U0 SHADOW-LIVE: a frozen ESPN capture can also land outside those windows (a manual or
 * catch-up capture, or one taken before this flag went live). Windows alone then leave
 * that week's frozen ESPN rows with no forecast beside them, and the week can never be
 * graded. So any ESPN capture newer than the week's latest forecast also triggers one
 * ('after_capture'), and exgbShadowHealth is the number_health check that says so when
 * frozen rows exist for a week but forecasts do not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, dbPath, row, rows, run } from '../db/index.js';
import { exgbEnabled, exgbModelDir, exgbPython } from './exgb-flag.js';
import { captureWindows, isLate, kickoffsByTeam } from './espn-weekly-projection-capture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ARMS = ['A_xgb', 'A_lgbm', 'B1', 'B2'];
const PREDICT_TIMEOUT_MS = 10 * 60 * 1000;
/** After a failed after_capture forecast, wait this long before trying the same week again. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

function recordRun(r) {
  run(`INSERT INTO exgb_shadow_runs (run_id, season, week, window_key, predicted_at, status, n_rows, n_late,
         lock_sha256, manifest_sha256, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  r.run_id, r.season, r.week, r.window_key, r.predicted_at, r.status, r.n_rows ?? 0, r.n_late ?? 0,
  r.lock_sha256 ?? null, r.manifest_sha256 ?? null, r.error ?? null);
}

/** Append one forecast payload (exgb_shadow.py predict's JSON). Returns { inserted, late, run_id }. */
export function ingestPredictions(payload, { now = new Date(), windowKey = 'manual' } = {}) {
  const at = now.toISOString();
  const runId = `${payload.season}-w${payload.week}-${windowKey}-${at}`;
  let inserted = 0, late = 0;
  db.exec('BEGIN');
  try {
    for (const r of payload.rows ?? []) {
      if (!ARMS.includes(r.arm) || !Number.isFinite(r.prediction)) continue;
      const l = isLate(at, r.kickoff_at ?? null);
      run(`INSERT INTO exgb_shadow_predictions (season, week, player_id, espn_id, position, arm, prediction, espn_input,
             predicted_at, kickoff_at, late, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      payload.season, payload.week, r.player_id, r.espn_id ?? null, r.position, r.arm, r.prediction,
      r.espn_input ?? null, at, r.kickoff_at ?? null, l, runId);
      inserted += 1; late += l;
    }
    recordRun({ run_id: runId, season: payload.season, week: payload.week, window_key: windowKey, predicted_at: at,
      status: 'ok', n_rows: inserted, n_late: late, lock_sha256: payload.lock_sha256, manifest_sha256: payload.manifest_sha256 });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { inserted, late, run_id: runId };
}

function doneWindows(season, week) {
  const keys = new Set();
  for (const r of rows(`SELECT window_key FROM exgb_shadow_runs WHERE season = ? AND week = ? AND status = 'ok'`, season, week)) {
    for (const k of String(r.window_key).split('+')) keys.add(k);
  }
  return keys;
}

/**
 * True when an ok frozen ESPN capture of this week (taken at or before `nowIso`) is newer than
 * the week's latest ok forecast, and no forecast attempt failed within RETRY_AFTER_MS.
 */
export function captureNeedsForecast(season, week, nowIso) {
  const cap = row(`SELECT MAX(captured_at) AS at FROM espn_weekly_projection_captures
                   WHERE season = ? AND week = ? AND status = 'ok' AND captured_at <= ?`, season, week, nowIso)?.at;
  if (!cap) return false;
  const last = row(`SELECT MAX(predicted_at) AS at FROM exgb_shadow_runs WHERE season = ? AND week = ? AND status = 'ok'`,
    season, week)?.at;
  if (last && last >= cap) return false;
  const failedAt = row(`SELECT MAX(predicted_at) AS at FROM exgb_shadow_runs WHERE season = ? AND week = ? AND status = 'error'`,
    season, week)?.at;
  return !(failedAt && failedAt >= cap && Date.parse(nowIso) - Date.parse(failedAt) < RETRY_AFTER_MS);
}

/** One locked forecast of `week` through the Python predictor, ingested. */
export function forecastWeek({ season, week, windowKey, now = new Date(), spawn = spawnSync }) {
  const out = path.join(os.tmpdir(), `exgb-${season}-w${week}-${process.pid}-${now.getTime()}.json`);
  const args = [path.join('scripts', 'eval', 'exgb_shadow.py'), 'predict', '--db', dbPath, '--model-dir', exgbModelDir(),
    '--season', String(season), '--week', String(week), '--as-of', now.toISOString(), '--out', out];
  const r = spawn(exgbPython(), args, { cwd: ROOT, encoding: 'utf8', timeout: PREDICT_TIMEOUT_MS });
  try {
    if (r.error || r.status !== 0) {
      const error = String(r.error?.message ?? `${r.stderr ?? ''}`.trim().split('\n').at(-1) ?? `exit ${r.status}`).slice(0, 300)
        || `exit ${r.status}`;
      recordRun({ run_id: `${season}-w${week}-${windowKey}-${now.toISOString()}`, season, week, window_key: windowKey,
        predicted_at: now.toISOString(), status: 'error', error });
      return { status: 'error', error };
    }
    const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
    return { status: 'ok', ...ingestPredictions(payload, { now, windowKey }) };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** The scheduled job: a forecast per open window of the in-progress and next week. */
export async function runExgbShadowPredict({ now = new Date(), spawn = spawnSync, season } = {}) {
  if (!exgbEnabled()) return { skipped: 'GRIDIRON_EXGB is off (shadow forecasts only run with it on)' };
  const yr = season ?? row('SELECT MAX(season) AS s FROM game_lines')?.s;
  if (!yr) return { skipped: 'no game_lines season' };
  const nowIso = now.toISOString();
  let runs = 0, failed = 0, attempted = 0;
  const weeks = [];
  for (const w of rows('SELECT DISTINCT week FROM game_lines WHERE season = ? AND week IS NOT NULL ORDER BY week', yr)) {
    const kicks = [...kickoffsByTeam(yr, w.week).values()];
    if (kicks.some(k => k > nowIso)) weeks.push({ week: w.week, kicks });
    if (weeks.length === 2) break;
  }
  for (const { week, kicks } of weeks) {
    const done = doneWindows(yr, week);
    const due = captureWindows(kicks).filter(x => x.opens_at <= nowIso && nowIso < x.closes_at && !done.has(x.key))
      .map(x => x.key);
    if (captureNeedsForecast(yr, week, nowIso)) due.push('after_capture');
    if (!due.length) continue;
    attempted += 1;
    const r = forecastWeek({ season: yr, week, windowKey: due.join('+'), now, spawn });
    if (r.status === 'ok') runs += 1; else failed += 1;
  }
  return { season: yr, weeks: weeks.map(w => w.week), runs, attempted, failed };
}

/**
 * number_health `exgb_shadow_capture`: every week with pre-kickoff frozen ESPN rows must have
 * pre-kickoff shadow forecasts beside it, or that week can never be graded (and is lost once
 * its games start). { status: 'off' | 'ok' | 'broken', weeks: [{ week, frozen, shadow }], missing: [week] }.
 */
export function exgbShadowHealth({ season } = {}) {
  const yr = season ?? row('SELECT MAX(season) AS s FROM espn_weekly_projection_snapshots')?.s;
  const frozen = yr == null ? [] : rows(`SELECT week, COUNT(*) AS n FROM espn_weekly_projection_snapshots
                                          WHERE season = ? AND late = 0 GROUP BY week ORDER BY week`, yr);
  const shadow = new Map(yr == null ? [] : rows(`SELECT week, COUNT(*) AS n FROM exgb_shadow_predictions
                                                  WHERE season = ? AND late = 0 GROUP BY week`, yr).map(r => [r.week, r.n]));
  const weeks = frozen.map(f => ({ week: f.week, frozen: f.n, shadow: shadow.get(f.week) ?? 0 }));
  const missing = weeks.filter(w => w.frozen > 0 && w.shadow === 0).map(w => w.week);
  const status = !exgbEnabled() ? 'off' : missing.length ? 'broken' : 'ok';
  return { status, season: yr ?? null, weeks, missing };
}
