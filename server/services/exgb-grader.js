/**
 * E-XGB weekly grader: the pre-registered test (docs/tdd/EXGB-PREREG.md, addendum 1), run
 * after each week's finals. GRIDIRON_EXGB=1 only; it grades shadow forecasts, serves nothing.
 *
 * Population (prereg section 3): QB/RB/WR/TE player-games with BOTH a frozen ESPN PPR
 * projection (frozenEspnForGrading: latest capture strictly before the player's kickoff,
 * never a late row) AND our weekly projection (weekly_prediction_snapshots). A player with
 * no stat line scores 0. An arm with no pre-kickoff forecast for a player is scored with our
 * projection (a counted fallback, never a drop).
 *
 * Actual points (addendum 1): nflverse full PPR (nfl_ffopportunity_weekly.actual_fantasy_points,
 * two-point conversions included); else the prereg formula from player_week_usage (no 2-pt),
 * counted as n_actual_fallback.
 *
 * Running result per arm over the confirmatory weeks graded so far: paired d =
 * |actual - comparator| - |actual - model|, week-blocked bootstrap (10,000 draws, seed
 * 20261015), one-sided p = share of draws with mean d <= 0, Holm across the 4 positions per
 * comparator; pass = >= 6 graded weeks, Holm p < 0.05 vs BOTH, and MAE lower by >= 0.20 pts
 * AND >= 2% vs BOTH. Every row before the outcome freeze (2026-12-15) is provisional.
 */
import crypto from 'node:crypto';
import { db, row, rows, run } from '../db/index.js';
import { exgbEnabled } from './exgb-flag.js';
import { frozenEspnForGrading } from './espn-weekly-projection-capture.js';
import { holm, random, withRandomSeed } from './stats-util.js';
import { ARMS } from './exgb-shadow.js';

export const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
export const CONFIRMATORY_SEASON = 2026;
export const CONFIRMATORY_WEEKS = [6, 7, 8, 9, 10, 11, 12, 13];
export const OUTCOME_FREEZE = '2026-12-15T00:00:00.000Z';
const BOOTSTRAP_DRAWS = 10_000;
const BOOTSTRAP_SEED = 20261015;
const MIN_WEEKS = 6;
const ALPHA = 0.05;
const MIN_POINTS = 0.20;
const MIN_REL = 0.02;
// Finals: nflverse's weekly file lands the day after Monday night; grade a day after the last kickoff.
const FINAL_AFTER_MS = 24 * 3600e3;

const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function formulaPpr(u) {
  const g = k => Number(u[k] ?? 0);
  return 0.04 * g('passing_yards') + 4 * g('passing_tds') - 2 * g('interceptions')
    + 0.1 * (g('rushing_yards') + g('receiving_yards')) + 6 * (g('rushing_tds') + g('receiving_tds'))
    + g('receptions') - 2 * g('fumbles_lost');
}

/** player_id -> { pts, source } for players with a stat line that week. */
export function actualPoints(season, week) {
  const out = new Map();
  for (const u of rows('SELECT * FROM player_week_usage WHERE season = ? AND week = ?', season, week)) {
    out.set(u.player_id, { pts: Math.round(formulaPpr(u) * 1e4) / 1e4, source: 'usage_formula' });
  }
  for (const f of rows(`SELECT p.id AS player_id, f.actual_fantasy_points AS pts FROM nfl_ffopportunity_weekly f
                        JOIN players p ON p.gsis_id = f.player_gsis_id
                        WHERE f.season = ? AND f.week = ? AND f.actual_fantasy_points IS NOT NULL`, season, week)) {
    out.set(f.player_id, { pts: f.pts, source: 'ffopportunity' });
  }
  return out;
}

export function weekFinal(season, week, now = new Date()) {
  const last = row(`SELECT MAX(gameday || ' ' || COALESCE(gametime, '23:59')) AS k FROM game_lines WHERE season = ? AND week = ?`,
    season, week)?.k;
  const hasFinals = row('SELECT COUNT(*) AS n FROM player_week_usage WHERE season = ? AND week = ?', season, week)?.n > 0;
  // gameday/gametime are Eastern wall time; +5 h is the latest the UTC instant can be.
  return Boolean(last && hasFinals && Date.parse(`${last.replace(' ', 'T')}:00Z`) + 5 * 3600e3 + FINAL_AFTER_MS <= now.getTime());
}

function latestForecasts(season, week) {
  const out = new Map(); // `${arm}:${player_id}` -> prediction
  for (const r of rows(`SELECT arm, player_id, prediction, predicted_at FROM exgb_shadow_predictions
                        WHERE season = ? AND week = ? AND late = 0 AND kickoff_at IS NOT NULL AND predicted_at < kickoff_at
                        ORDER BY predicted_at`, season, week)) {
    out.set(`${r.arm}:${r.player_id}`, r.prediction);
  }
  return out;
}

/** The week's population with every arm's number and the actual; `pairs` feed the running test. */
export function gradeWeek(season, week) {
  const espn = new Map(frozenEspnForGrading(season, week, 'ppr').filter(r => r.player_id != null)
    .map(r => [r.player_id, r]));
  const current = new Map(rows(`SELECT player_id, prediction FROM weekly_prediction_snapshots WHERE season = ? AND week = ?`,
    season, week).map(r => [r.player_id, r.prediction]));
  const pos = new Map(rows('SELECT id, position FROM players').map(p => [p.id, p.position]));
  const actual = actualPoints(season, week);
  const forecasts = latestForecasts(season, week);
  const population = [...espn.keys()].filter(id => current.has(id) && POSITIONS.includes(espn.get(id).position ?? pos.get(id)))
    .sort((a, b) => a - b);
  const out = [], pairs = [];
  for (const arm of ARMS) {
    for (const p of POSITIONS) {
      const ids = population.filter(id => (espn.get(id).position ?? pos.get(id)) === p);
      let fallbackModel = 0, fallbackActual = 0;
      const e = [], c = [], m = [];
      for (const id of ids) {
        const a = actual.get(id);
        if (a?.source === 'usage_formula') fallbackActual += 1;
        const y = a?.pts ?? 0;
        const f = forecasts.get(`${arm}:${id}`);
        if (f == null) fallbackModel += 1;
        const model = f ?? current.get(id);
        m.push(Math.abs(y - model)); e.push(Math.abs(y - espn.get(id).projected_pts)); c.push(Math.abs(y - current.get(id)));
        pairs.push({ arm, position: p, week, d_espn: e.at(-1) - m.at(-1), d_current: c.at(-1) - m.at(-1),
          ae_model: m.at(-1), ae_espn: e.at(-1), ae_current: c.at(-1), se_model: m.at(-1) ** 2 });
      }
      const rm = a => (a.length ? Math.sqrt(mean(a.map(x => x * x))) : null);
      out.push({ season, week, position: p, arm, n: ids.length, mae_model: r4(mean(m)), mae_espn: r4(mean(e)),
        mae_current: r4(mean(c)), rmse_model: r4(rm(m)), rmse_espn: r4(rm(e)), rmse_current: r4(rm(c)),
        n_model_fallback: fallbackModel, n_actual_fallback: fallbackActual });
    }
  }
  return { rows: out, pairs };
}

/** One-sided week-blocked paired bootstrap: share of draws whose player-game mean d is <= 0. */
export function pairedBootstrapP(byWeek, { draws = BOOTSTRAP_DRAWS, seed = BOOTSTRAP_SEED } = {}) {
  const weeks = [...byWeek.keys()].filter(w => byWeek.get(w).length);
  if (!weeks.length) return null;
  let atOrBelow = 0;
  withRandomSeed(seed, () => {
    for (let t = 0; t < draws; t++) {
      let sum = 0, n = 0;
      for (let i = 0; i < weeks.length; i++) {
        const ds = byWeek.get(weeks[Math.floor(random() * weeks.length)]);
        for (const d of ds) { sum += d; n += 1; }
      }
      if (sum / n <= 0) atOrBelow += 1;
    }
  });
  return atOrBelow / draws;
}

/** The pre-registered result so far, per position, for one arm. */
export function runningResult(season, arm, { weeks = CONFIRMATORY_WEEKS, pairsByWeek } = {}) {
  const per = Object.fromEntries(POSITIONS.map(p => [p, { e: new Map(), c: new Map(), ae: [], aes: [], aec: [] }]));
  for (const w of weeks) {
    const pairs = pairsByWeek?.get(w) ?? gradeWeek(season, w).pairs;
    for (const x of pairs) {
      if (x.arm !== arm) continue;
      const s = per[x.position];
      if (!s.e.has(w)) { s.e.set(w, []); s.c.set(w, []); }
      s.e.get(w).push(x.d_espn); s.c.get(w).push(x.d_current);
      s.ae.push(x.ae_model); s.aes.push(x.ae_espn); s.aec.push(x.ae_current);
    }
  }
  const out = {};
  for (const p of POSITIONS) {
    const s = per[p];
    const graded = [...s.e.keys()].length;
    out[p] = { weeks: graded, n: s.ae.length, mae_model: r4(mean(s.ae)), mae_espn: r4(mean(s.aes)), mae_current: r4(mean(s.aec)),
      p_vs_espn: graded ? pairedBootstrapP(s.e) : null, p_vs_current: graded ? pairedBootstrapP(s.c) : null };
  }
  const he = holm(POSITIONS.map(p => out[p].p_vs_espn ?? 1));
  const hc = holm(POSITIONS.map(p => out[p].p_vs_current ?? 1));
  POSITIONS.forEach((p, i) => {
    const o = out[p];
    o.holm_p_vs_espn = r4(he[i]); o.holm_p_vs_current = r4(hc[i]);
    const beats = cmp => cmp != null && o.mae_model != null && cmp - o.mae_model >= MIN_POINTS && (cmp - o.mae_model) / cmp >= MIN_REL;
    o.verdict = o.weeks < MIN_WEEKS ? 'not_run'
      : (he[i] < ALPHA && hc[i] < ALPHA && beats(o.mae_espn) && beats(o.mae_current) ? 'pass' : 'fail');
  });
  return out;
}

function signatureOf(gradeRow, pairs) {
  const mine = pairs.filter(x => x.arm === gradeRow.arm && x.position === gradeRow.position);
  return crypto.createHash('sha256').update(JSON.stringify([gradeRow, mine.map(x => [x.ae_model, x.ae_espn, x.ae_current])]))
    .digest('hex').slice(0, 32);
}

/** The scheduled job: grade every final week of the season that has a population; write only changes. */
export async function runExgbWeeklyGrade({ now = new Date(), season = CONFIRMATORY_SEASON,
  confirmatoryWeeks = CONFIRMATORY_WEEKS } = {}) {
  if (!exgbEnabled()) return { skipped: 'GRIDIRON_EXGB is off (the grader scores shadow forecasts only)' };
  const weeks = rows(`SELECT DISTINCT week FROM espn_weekly_projection_snapshots WHERE season = ? ORDER BY week`, season)
    .map(r => r.week).filter(w => weekFinal(season, w, now));
  const graded = new Map();
  for (const w of weeks) graded.set(w, gradeWeek(season, w));
  const pairsByWeek = new Map([...graded].map(([w, g]) => [w, g.pairs]));
  const running = Object.fromEntries(ARMS.map(arm => [arm,
    runningResult(season, arm, { weeks: confirmatoryWeeks.filter(w => graded.has(w)), pairsByWeek })]));
  const at = now.toISOString();
  const provisional = at < OUTCOME_FREEZE || season !== CONFIRMATORY_SEASON ? 1 : 0;
  let written = 0;
  db.exec('BEGIN');
  try {
    for (const [w, g] of graded) {
      for (const r of g.rows) {
        if (!r.n) continue;
        const conf = confirmatoryWeeks.includes(w) ? 1 : 0;
        const run_ = conf ? running[r.arm][r.position] : null;
        const sig = signatureOf({ ...r, run_ }, g.pairs);
        const prev = row(`SELECT signature FROM exgb_weekly_grades WHERE season = ? AND week = ? AND position = ? AND arm = ?
                          ORDER BY graded_at DESC LIMIT 1`, season, w, r.position, r.arm);
        if (prev?.signature === sig) continue;
        run(`INSERT INTO exgb_weekly_grades (season, week, position, arm, graded_at, signature, n, mae_model, mae_espn,
               mae_current, rmse_model, rmse_espn, rmse_current, n_model_fallback, n_actual_fallback, confirmatory,
               running_weeks, running_n, running_mae_model, running_mae_espn, running_mae_current, p_vs_espn, p_vs_current,
               holm_p_vs_espn, holm_p_vs_current, verdict, provisional)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        season, w, r.position, r.arm, at, sig, r.n, r.mae_model, r.mae_espn, r.mae_current, r.rmse_model, r.rmse_espn,
        r.rmse_current, r.n_model_fallback, r.n_actual_fallback, conf,
        run_?.weeks ?? null, run_?.n ?? null, run_?.mae_model ?? null, run_?.mae_espn ?? null, run_?.mae_current ?? null,
        r4(run_?.p_vs_espn), r4(run_?.p_vs_current), run_?.holm_p_vs_espn ?? null, run_?.holm_p_vs_current ?? null,
        run_?.verdict ?? null, provisional);
        written += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { season, weeks_graded: graded.size, rows_written: written, provisional: Boolean(provisional) };
}

/** BENCHMARKS-style table: the latest row per (week, position, arm). */
export function benchmarksMarkdown(season = CONFIRMATORY_SEASON) {
  const latest = rows(`SELECT g.* FROM exgb_weekly_grades g
    JOIN (SELECT season, week, position, arm, MAX(graded_at) AS at FROM exgb_weekly_grades WHERE season = ?
          GROUP BY season, week, position, arm) l
      ON l.season = g.season AND l.week = g.week AND l.position = g.position AND l.arm = g.arm AND l.at = g.graded_at
    ORDER BY g.week, g.arm, CASE g.position WHEN 'QB' THEN 1 WHEN 'RB' THEN 2 WHEN 'WR' THEN 3 ELSE 4 END`, season);
  const f = x => (x == null ? '-' : Number(x).toFixed(3));
  const lines = ['| week | pos | arm | n | MAE model | MAE ESPN frozen | MAE ours | running weeks | Holm p vs ESPN | Holm p vs ours | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of latest) {
    lines.push(`| ${r.week} | ${r.position} | ${r.arm} | ${r.n} | ${f(r.mae_model)} | ${f(r.mae_espn)} | ${f(r.mae_current)} | `
      + `${r.running_weeks ?? '-'} | ${f(r.holm_p_vs_espn)} | ${f(r.holm_p_vs_current)} | `
      + `${r.verdict ?? 'exploratory'}${r.provisional ? ' (provisional)' : ''} |`);
  }
  return lines.join('\n');
}
