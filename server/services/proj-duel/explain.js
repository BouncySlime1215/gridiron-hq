/**
 * PROJ-DUEL explain: why our shadow model says what it says (drivers), and what happened after the
 * games (residuals), per player per week. The only writer of exgb_shadow_drivers and
 * proj_duel_residuals (migration 120); the text the view and Coach show is built here too.
 *
 * Drivers come from scripts/eval/exgb_drivers.py (XGBoost pred_contribs on the locked A_xgb artifacts;
 * it never writes a prediction or a model). Each row keeps the prediction it recomputed and whether it
 * equals the stored forecast, so "the model did not change" is checked on every row. Residuals join
 * the grader's numbers (frozen ESPN, latest pre-kickoff forecast, actual points) with the panel's own
 * observation of the game (carries, targets, snaps, red zone, xfp, TDs) and the team's points scored
 * vs implied. The job runs with GRIDIRON_EXGB=1 only; $0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, dbPath, row, rows, run } from '../../db/index.js';
import { exgbEnabled, exgbModelDir, exgbPython } from '../exgb-flag.js';
import { frozenEspnForGrading } from '../espn-weekly-projection-capture.js';
import { latestForecasts, actualPoints, weekFinal } from '../exgb-grader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARM = 'A_xgb';
/**
 * The driver set a stored row holds, appended to its manifest hash: 'all-v2' rows carry every
 * feature's contribution (the breakdown sheet's bar list); rows from before carry the top 5 only and
 * are recomputed once (the table is append-only, so the new set is a new row, never an update).
 */
export const DRIVER_SET = 'all-v2';
const TIMEOUT_MS = 10 * 60 * 1000;
const tableIn = name => !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
const r1 = x => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10) / 10);

function python(cmd, season, week, { spawn = spawnSync } = {}) {
  const out = path.join(os.tmpdir(), `proj-duel-${cmd}-${season}-w${week}-${process.pid}-${Date.now()}.json`);
  const args = [path.join('scripts', 'eval', 'exgb_drivers.py'), cmd, '--db', dbPath, '--season', String(season), '--week', String(week),
    '--out', out, ...(cmd === 'drivers' ? ['--model-dir', exgbModelDir()] : [])];
  const r = spawn(exgbPython(), args, { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS });
  try {
    if (r.error || r.status !== 0) {
      throw new Error(`exgb_drivers.py ${cmd} week ${week} failed: ${String(r.error?.message ?? `${r.stderr ?? ''}`.trim().split('\n').at(-1) ?? `exit ${r.status}`).slice(0, 300)}`);
    }
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally { fs.rmSync(out, { force: true }); }
}

/** Store one week's drivers payload; returns { inserted, matched, mismatched }. */
export function ingestDrivers(payload, { now = new Date() } = {}) {
  const stored = latestForecasts(payload.season, payload.week);
  let inserted = 0, matched = 0, mismatched = 0;
  db.exec('BEGIN');
  try {
    for (const r of payload.rows ?? []) {
      if (r.arm !== ARM) continue;
      const s = stored.get(`${ARM}:${r.player_id}`);
      const match = s != null && s === r.prediction ? 1 : 0;
      const res = run(`INSERT OR IGNORE INTO exgb_shadow_drivers (season, week, player_id, arm, manifest_sha256, computed_at, base,
        contribs_json, expected_json, prediction_recomputed, matches_prediction) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      payload.season, payload.week, r.player_id, ARM, `${payload.manifest_sha256 ?? 'unknown'}|${DRIVER_SET}`, now.toISOString(), r.base ?? null,
      JSON.stringify(r.contribs ?? []), JSON.stringify(r.expected ?? {}), r.prediction ?? null, match);
      if (Number(res.changes)) { inserted++; if (s != null) (match ? matched++ : mismatched++); }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { inserted, matched, mismatched };
}

/** Store one finished week's residual rows from the usage payload; returns rows inserted. */
export function ingestResiduals(season, week, usagePayload, { now = new Date() } = {}) {
  const espn = new Map(frozenEspnForGrading(season, week, 'ppr').filter(r => r.player_id != null).map(r => [Number(r.player_id), r]));
  const forecasts = latestForecasts(season, week);
  const actual = actualPoints(season, week);
  const usage = new Map((usagePayload?.rows ?? []).map(u => [Number(u.player_id), u]));
  const scored = new Map(rows('SELECT team, team_score FROM game_lines WHERE season = ? AND week = ?', season, week).map(g => [g.team, g.team_score]));
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const [pid, e] of espn) {
      const ours = forecasts.get(`${ARM}:${pid}`);
      if (ours == null) continue;
      const a = actual.get(pid)?.pts ?? 0;
      const u = usage.get(pid) ?? {};
      const res = run(`INSERT OR IGNORE INTO proj_duel_residuals (season, week, player_id, position, ours, espn, actual, err_ours, err_espn,
        team, carries, targets, receptions, snap_pct, rz_share, xfp, tds, team_points, team_implied, graded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      season, week, pid, e.position ?? null, ours, e.projected_pts, a, Math.abs(a - ours), Math.abs(a - e.projected_pts),
      u.team ?? null, u.carries ?? null, u.targets ?? null, u.receptions ?? null, u.snap_pct ?? null, u.rz_share ?? null,
      u.xfp ?? null, u.tds ?? null, u.team ? (scored.get(u.team) ?? null) : null, u.team_implied ?? null, now.toISOString());
      n += Number(res.changes) || 0;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

/**
 * The scheduler job: drivers for every week with shadow forecasts and none stored for the current
 * artifacts; residuals for every finished week not yet stored (the backfill of every graded week).
 */
export async function refreshProjDuelExplain({ season = null, now = new Date(), spawn = spawnSync } = {}) {
  if (!exgbEnabled()) return { skipped: 'GRIDIRON_EXGB is off (the shadow model only runs with it on)' };
  if (!tableIn('exgb_shadow_drivers') || !tableIn('exgb_shadow_predictions')) return { skipped: 'migration 120 not applied yet' };
  const yr = season ?? row('SELECT MAX(season) AS s FROM exgb_shadow_predictions')?.s;
  if (!yr) return { skipped: 'no shadow forecasts yet' };
  const weeks = rows('SELECT DISTINCT week FROM exgb_shadow_predictions WHERE season = ? AND arm = ? ORDER BY week', yr, ARM).map(r => r.week);
  const out = { season: yr, drivers: [], residuals: [] };
  for (const w of weeks) {
    const have = row('SELECT COUNT(*) AS n FROM exgb_shadow_drivers WHERE season = ? AND week = ? AND arm = ? AND manifest_sha256 LIKE ?',
      yr, w, ARM, `%|${DRIVER_SET}`)?.n ?? 0;
    const lastRun = row(`SELECT MAX(predicted_at) AS at FROM exgb_shadow_runs WHERE season = ? AND week = ? AND status = 'ok'`, yr, w)?.at;
    const lastDrivers = row('SELECT MAX(computed_at) AS at FROM exgb_shadow_drivers WHERE season = ? AND week = ?', yr, w)?.at;
    if (!have || (lastRun && lastDrivers && lastRun > lastDrivers)) {
      out.drivers.push({ week: w, ...ingestDrivers(python('drivers', yr, w, { spawn }), { now }) });
    }
    const graded = row('SELECT COUNT(*) AS n FROM proj_duel_residuals WHERE season = ? AND week = ?', yr, w)?.n ?? 0;
    if (!graded && weekFinal(yr, w, now)) out.residuals.push({ week: w, inserted: ingestResiduals(yr, w, python('usage', yr, w, { spawn }), { now }) });
  }
  return out;
}

/* ------------------------------------------------------------------ plain words */

const pct = v => `${Math.round(Number(v) * 100)}%`;
const INJ = ['not on the injury report', 'listed questionable', 'listed doubtful', 'listed out'];
/** What a feature means, with its value, in the words the view shows. Null for one not worth saying. */
export function featureText(feature, value, position = null) {
  const v = value == null ? null : Number(value);
  if (v == null || !Number.isFinite(v)) return null;
  // A share below 0 is a data artifact (negative air yards), not something to say out loud.
  if (/_share$|snap_pct$/.test(feature) && v < 0) return null;
  const n = x => r1(x);
  const T = {
    lag1_carries: `${n(v)} carries last game`, trail3_carries: `3-week carries ${n(v)}`, trail5_carries: `5-week carries ${n(v)}`,
    lag1_targets: `${n(v)} targets last game`, trail3_targets: `3-week targets ${n(v)}`, trail5_targets: `5-week targets ${n(v)}`,
    lag1_receptions: `${n(v)} catches last game`, trail3_receptions: `3-week catches ${n(v)}`,
    lag1_snap_pct: `${pct(v)} of snaps last game`, trail3_snap_pct: `3-week snap share ${pct(v)}`, trail5_snap_pct: `5-week snap share ${pct(v)}`,
    lag1_rz_share: `${pct(v)} red-zone share last game`, trail3_rz_share: `3-week red-zone share ${pct(v)}`,
    lag1_xfp: `${n(v)} expected points last game`, trail3_xfp: `3-week expected points ${n(v)}`, trail5_xfp: `5-week expected points ${n(v)}`,
    lag1_ppr: `${n(v)} points last game`, trail3_ppr: `3-week points ${n(v)}`, trail5_ppr: `5-week points ${n(v)}`,
    lag1_target_share: `${pct(v)} target share last game`, trail3_target_share: `3-week target share ${pct(v)}`,
    lag1_attempts: `${n(v)} pass attempts last game`, trail3_attempts: `3-week pass attempts ${n(v)}`,
    lag1_wopr: `opportunity rating ${n(v)} last game`, trail3_wopr: `3-week opportunity rating ${n(v)}`,
    lag1_air_yards_share: `${pct(v)} air-yards share last game`, trail3_air_yards_share: `3-week air-yards share ${pct(v)}`,
    std_ppr: `season average ${n(v)}`, prev_season_ppg: `last season ${n(v)} a game`, prev_season_games: `${n(v)} games last season`,
    n_games_std: `${n(v)} games this season`, missed_last_team_game: v ? 'missed the last team game' : 'played the last team game',
    team_implied: `team implied ${n(v)}`, team_spread: `spread ${v > 0 ? '+' : ''}${n(v)}`, game_total: `game total ${n(v)}`,
    home: v ? 'at home' : 'on the road', inj_status: INJ[Math.round(v)] ?? null, inj_dnp: v ? 'missed practice' : null,
    opp_allowed_pos_trail: `opponent allows ${n(v)} to ${position ? `${position}s` : 'the position'} lately`,
    opp_allowed_pos_prev_season: `opponent allowed ${n(v)} to ${position ? `${position}s` : 'the position'} last season`,
  };
  return T[feature] ?? null;
}

/**
 * "Ours lower: 3-week carries 11, team implied 20.5, opponent allows 18.2 to RBs": the features that
 * pushed our number in the direction it differs from ESPN, biggest first (up to 3).
 */
export function driversText({ ours, espn, contribs, position }) {
  if (ours == null || espn == null || !Array.isArray(contribs) || Math.abs(ours - espn) < 0.05) return null;
  const lower = ours < espn;
  const toward = contribs.filter(c => (lower ? c.contribution < 0 : c.contribution > 0))
    .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
    .map(c => featureText(c.feature, c.value, position)).filter(Boolean).slice(0, 3);
  if (toward.length) return `Ours ${lower ? 'lower' : 'higher'}: ${toward.join(', ')}.`;
  // Nothing pushed our number toward the gap: the model's own ceiling (or floor) is the reason.
  const against = contribs.filter(c => (lower ? c.contribution > 0 : c.contribution < 0))
    .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
    .map(c => featureText(c.feature, c.value, position)).filter(Boolean).slice(0, 2);
  if (!against.length) return null;
  return lower
    ? `Ours lower even though ${against.join(' and ')}: the model tops out below ESPN for top players.`
    : `Ours higher even though ${against.join(' and ')}: the model sits above ESPN for this player.`;
}

/** A feature's plain name (no value), for the breakdown's bar list. */
export function featureLabel(feature, position = null) {
  const base = String(feature).replace(/^(lag1|trail3|trail5)_/, '');
  const when = /^lag1_/.test(feature) ? 'last game' : /^trail3_/.test(feature) ? '3-week' : /^trail5_/.test(feature) ? '5-week' : null;
  const WHAT = { ppr: 'points', targets: 'targets', carries: 'carries', receptions: 'catches', target_share: 'target share',
    air_yards_share: 'air-yards share', wopr: 'opportunity rating', receiving_air_yards: 'air yards', attempts: 'pass attempts',
    snap_pct: 'snap share', rz_share: 'red-zone share', xfp: 'expected points' };
  if (when && WHAT[base]) return when === 'last game' ? `${WHAT[base]} last game` : `${when} ${WHAT[base]}`;
  const L = { std_ppr: 'season average', n_games_std: 'games this season', prev_season_ppg: 'last season per game',
    prev_season_games: 'games last season', missed_last_team_game: 'missed the last team game', team_implied: 'team implied total',
    team_spread: 'spread', game_total: 'game total', line_src: 'line source', home: 'home game', inj_status: 'injury status',
    inj_dnp: 'missed practice', opp_allowed_pos_trail: `opponent vs ${position ?? 'position'} lately`,
    opp_allowed_pos_prev_season: `opponent vs ${position ?? 'position'} last season`, week: 'week of the season' };
  return L[feature] ?? String(feature).replace(/_/g, ' ');
}

/** "14 carries vs 17 expected, 0 TDs, team scored 13 vs 24 implied" from a residual row and its expected usage. */
export function happenedText(res, expected = {}) {
  if (!res) return null;
  const parts = [];
  const vs = (actual, exp, what) => (actual == null ? null : exp == null ? `${r1(actual)} ${what}` : `${r1(actual)} ${what} vs ${r1(exp)} expected`);
  const heavy = Number(expected.trail3_carries ?? 0) >= Number(expected.trail3_targets ?? 0) ? 'carries' : 'targets';
  parts.push(heavy === 'carries' ? vs(res.carries, expected.trail3_carries, 'carries') : vs(res.targets, expected.trail3_targets, 'targets'));
  if (res.snap_pct != null) parts.push(`${pct(res.snap_pct)} of snaps`);
  if (res.tds != null) parts.push(`${r1(res.tds)} TD${Number(res.tds) === 1 ? '' : 's'}`);
  if (res.team_points != null && res.team_implied != null) parts.push(`team scored ${r1(res.team_points)} vs ${r1(res.team_implied)} implied`);
  const text = parts.filter(Boolean).join(', ');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : null;
}

/** The stored drivers and residual rows for one week, by player id. */
export function explainRows(season, week) {
  const drivers = new Map(), residuals = new Map();
  if (tableIn('exgb_shadow_drivers')) {
    for (const d of rows(`SELECT d.* FROM exgb_shadow_drivers d JOIN (SELECT player_id, MAX(computed_at) AS at FROM exgb_shadow_drivers
      WHERE season = ? AND week = ? AND arm = ? GROUP BY player_id) l ON l.player_id = d.player_id AND l.at = d.computed_at
      WHERE d.season = ? AND d.week = ? AND d.arm = ?`, season, week, ARM, season, week, ARM)) {
      drivers.set(Number(d.player_id), { contribs: JSON.parse(d.contribs_json), expected: JSON.parse(d.expected_json), matches: d.matches_prediction === 1 });
    }
  }
  if (tableIn('proj_duel_residuals')) {
    for (const r of rows('SELECT * FROM proj_duel_residuals WHERE season = ? AND week = ?', season, week)) residuals.set(Number(r.player_id), r);
  }
  return { drivers, residuals };
}
