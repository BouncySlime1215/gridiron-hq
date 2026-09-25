/**
 * PROJ-ESPN Q2: calibrated weekly ranges, ESPN mean + empirical positional residual quantiles.
 *
 * A player's week is drawn as   max(0, ESPN mean + k x Q_pos(u))
 * where Q_pos is the empirical quantile function of (actual PPR - ESPN projection) at his
 * position over the 2022-2025 panel (range-residuals.json, built by
 * scripts/eval/proj-espn-residuals.mjs) and k is ONE global width multiplier fitted so the
 * lineup total's p10-p90 covers 80% of real team-weeks. lineup-week-range.js (the one range
 * producer, #426) supplies u from the league world's own draws (so the copula's same-game
 * correlation and the paired runs across a trade's two sides are kept); the fit and the
 * weekly coverage replay here supply independent seeded uniforms.
 *
 * Pre-registered weekly rule (docs/tdd/PROJ-ESPN-PREREG.md): every Tuesday, refit k on the
 * trailing 4 completed weeks, but only CHANGE it when the trailing coverage is outside
 * [72%, 88%]. Every fit (and every "kept") is a range_calibration row with its fit date;
 * realised coverage is logged weekly per league (range_coverage_log) and read by
 * number_health `range_coverage`.
 */
import { db } from '../db/index.js';
import { espnWeekProjections } from './espn-week-projection.js';
import { residuals, REPLAY_RUNS, REPLAY_SEED } from './range-residuals.js';
import { replayBand } from './lineup-week-range.js';

export const TARGET_COVERAGE = 0.80;
export const KEEP_BAND = Object.freeze([0.72, 0.88]);
export const TRAILING_WEEKS = 4;
export const K_GRID = Object.freeze({ lo: 0.30, hi: 3.00, step: 0.01 });
export { REPLAY_RUNS, REPLAY_SEED };

/** Realised p10-p90 coverage of `teamWeeks` ([{ starters, actual }]) at width k. */
export function coverageAt(teamWeeks, k, opts = {}) {
  let covered = 0, below = 0, above = 0;
  teamWeeks.forEach((tw, i) => {
    const b = replayBand(tw.starters, k, { ...opts, key: tw.key ?? i });
    if (tw.actual < b.p10) below++;
    else if (tw.actual > b.p90) above++;
    else covered++;
  });
  const n = teamWeeks.length;
  return { n, covered, below_p10: below, above_p90: above, coverage: n ? covered / n : null };
}

/**
 * The smallest k on K_GRID whose coverage reaches the target (coverage is non-decreasing in k
 * up to draw noise; a grid scan, not a bisection, so a noisy step cannot skip the answer).
 * Coarse pass at 0.05, then 0.01 steps inside the bracketing interval.
 */
export function fitK(teamWeeks, { target = TARGET_COVERAGE, ...opts } = {}) {
  if (!teamWeeks.length) return null;
  const at = k => coverageAt(teamWeeks, +k.toFixed(2), opts).coverage;
  let lo = K_GRID.lo, hit = null;
  for (let k = K_GRID.lo; k <= K_GRID.hi + 1e-9; k += 0.05) {
    if (at(k) >= target) { hit = +k.toFixed(2); break; }
    lo = k;
  }
  if (hit == null) return { k: K_GRID.hi, coverage: at(K_GRID.hi), capped: true };
  for (let k = Math.max(K_GRID.lo, lo); k <= hit + 1e-9; k += K_GRID.step) {
    const c = at(k);
    if (c >= target) return { k: +k.toFixed(2), coverage: c, capped: false };
  }
  return { k: hit, coverage: at(hit), capped: false };
}

/** The pre-registered rule: change k only when the trailing coverage is outside the band. */
export function refitDecision(trailingCoverage, band = KEEP_BAND) {
  if (!Number.isFinite(trailingCoverage)) return 'skipped';
  return trailingCoverage < band[0] || trailingCoverage > band[1] ? 'refit' : 'kept';
}

/* ------------------------------------------------------------------ database */

const hasTable = (database, name) => Boolean(database.prepare(
  `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));

/**
 * The k in force: the latest range_calibration row (initial / refit / kept all carry the k
 * then in force), else the shipped initial fit in range-residuals.json. { k, fit_date, source }.
 */
export function currentK(database = db, table = null) {
  if (hasTable(database, 'range_calibration')) {
    const r = database.prepare(`SELECT k, fit_date, decision FROM range_calibration
      WHERE decision IN ('initial', 'refit', 'kept') ORDER BY id DESC LIMIT 1`).get();
    if (r) return { k: Number(r.k), fit_date: r.fit_date, source: `range_calibration (${r.decision})` };
  }
  const t = table ?? residuals();
  return { k: Number(t.k.value), fit_date: t.k.fit_date, source: 'range-residuals.json (initial fit)' };
}

/**
 * Real team-weeks for a replay: every league's starters (league_roster_snapshots, is_starter = 1)
 * with a final score, each starter's mean the FROZEN pre-kickoff ESPN number in that league's
 * scoring (espn-week-projection.js selection). K / D/ST and any starter without a frozen number
 * make the team-week incomplete unless `retroFallback` (the initial fit only: the league
 * snapshot's projected_points, which ESPN backfilled after the games - labelled RETRO).
 */
export function replayTeamWeeks({ season, weeks, leagueIds = null, retroFallback = false, database = db } = {}) {
  const out = [];
  const sources = { frozen: 0, retro: 0, kdst_retro: 0, incomplete: 0 };
  for (const week of weeks) {
    const leagues = database.prepare(`SELECT DISTINCT league_id FROM league_roster_snapshots
      WHERE season = ? AND scoring_period_id = ? AND is_starter = 1`).all(season, week).map(r => Number(r.league_id))
      .filter(id => !leagueIds || leagueIds.includes(id));
    for (const lg of leagues) {
      // As of far in the future: every player's latest PRE-kickoff capture, no staleness check.
      const frozen = espnWeekProjections({ season, week, leagueRowId: lg, now: Date.parse('2100-01-01'), database, replay: true });
      const teams = new Map();
      for (const s of database.prepare(`SELECT team_id, espn_player_id, position, projected_points, actual_points
          FROM league_roster_snapshots WHERE season = ? AND scoring_period_id = ? AND league_id = ? AND is_starter = 1`)
        .all(season, week, lg)) {
        if (!teams.has(s.team_id)) teams.set(s.team_id, []);
        teams.get(s.team_id).push(s);
      }
      for (const [team, st] of teams) {
        if (st.some(s => s.actual_points == null)) { sources.incomplete++; continue; }
        const starters = [];
        let ok = true, retro = false;
        for (const s of st) {
          const f = frozen.byEspnId.get(Number(s.espn_player_id));
          if (f) { starters.push({ position: s.position, mean: f.pts }); continue; }
          if ((retroFallback || !['QB', 'RB', 'WR', 'TE'].includes(s.position)) && Number.isFinite(s.projected_points)) {
            starters.push({ position: s.position, mean: Number(s.projected_points) });
            if (['QB', 'RB', 'WR', 'TE'].includes(s.position)) retro = true; else sources.kdst_retro++;
            continue;
          }
          ok = false; break;
        }
        if (!ok) { sources.incomplete++; continue; }
        sources[retro ? 'retro' : 'frozen']++;
        out.push({ season, week, league_id: lg, team_id: String(team), key: season * 1e6 + week * 1e4 + lg * 100 + Number(team),
          starters, actual: st.reduce((a, s) => a + Number(s.actual_points), 0), basis: retro ? 'retro' : 'frozen' });
      }
    }
  }
  return { teamWeeks: out, sources };
}

/** Completed weeks of `season`: every game of the week has a final score. */
export function completedWeeks(season, database = db) {
  return database.prepare(`SELECT week FROM game_lines WHERE season = ? AND week IS NOT NULL
      GROUP BY week HAVING SUM(team_score IS NULL) = 0 ORDER BY week`).all(season).map(r => Number(r.week));
}

const etParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));

/**
 * The scheduled job (range_calibration). Two steps, both idempotent:
 *  1. log realised coverage for every completed week of the season not yet logged, per league,
 *     at the k in force, on frozen ESPN only (a week with no frozen capture is not logged);
 *  2. on a Tuesday (ET) with no fit row dated that day: pooled trailing-4-week coverage, then the
 *     pre-registered rule - refit k on those weeks only when coverage is outside [72%, 88%].
 */
export function runRangeCalibration({ now = Date.now(), season = null, database = db } = {}) {
  if (!hasTable(database, 'range_calibration')) return { skipped: 'migration 112 not applied' };
  const yr = season ?? database.prepare('SELECT MAX(season) AS s FROM game_lines').get()?.s;
  if (!yr) return { skipped: 'no game_lines season' };
  const k = currentK(database);
  const at = new Date(now).toISOString();
  const done = completedWeeks(yr, database);
  const logged = new Set(database.prepare('SELECT week || \':\' || league_id AS k FROM range_coverage_log WHERE season = ?')
    .all(yr).map(r => r.k));
  let wrote = 0;
  for (const week of done) {
    const { teamWeeks } = replayTeamWeeks({ season: yr, weeks: [week], database });
    const byLeague = new Map();
    for (const tw of teamWeeks) {
      if (!byLeague.has(tw.league_id)) byLeague.set(tw.league_id, []);
      byLeague.get(tw.league_id).push(tw);
    }
    for (const [lg, tws] of byLeague) {
      if (logged.has(`${week}:${lg}`)) continue;
      const c = coverageAt(tws, k.k);
      database.prepare(`INSERT OR IGNORE INTO range_coverage_log (season, week, league_id, n_team_weeks, covered, coverage,
          below_p10, above_p90, k, source, logged_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(yr, week, lg, c.n, c.covered, c.coverage, c.below_p10, c.above_p90, k.k, 'frozen_espn_replay', at);
      wrote++;
    }
  }
  const et = etParts(now);
  const today = `${et.year}-${et.month}-${et.day}`;
  let decision = null;
  const fittedToday = database.prepare('SELECT 1 FROM range_calibration WHERE fit_date = ? AND decision != \'initial\'').get(today);
  if (et.weekday === 'Tue' && !fittedToday) {
    const trailing = done.slice(-TRAILING_WEEKS);
    const { teamWeeks } = replayTeamWeeks({ season: yr, weeks: trailing, database });
    const before = teamWeeks.length ? coverageAt(teamWeeks, k.k) : null;
    decision = refitDecision(before?.coverage);
    let newK = k.k, after = before?.coverage ?? null, note = null;
    if (decision === 'refit') {
      const f = fitK(teamWeeks);
      newK = f.k; after = f.coverage; note = f.capped ? `k capped at ${K_GRID.hi}` : null;
    }
    if (decision === 'skipped') note = 'no completed week with a frozen ESPN capture in the trailing window';
    database.prepare(`INSERT INTO range_calibration (k, fitted_at, fit_date, season, fit_weeks, coverage_before, coverage_after,
        n_team_weeks, decision, rule, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newK, at, today, yr, JSON.stringify(trailing), before?.coverage ?? null, after, teamWeeks.length, decision,
        `Tuesday refit on the trailing ${TRAILING_WEEKS} weeks; change k only outside [${KEEP_BAND[0]}, ${KEEP_BAND[1]}]`, note);
  }
  return { season: yr, k: k.k, coverage_rows: wrote, decision };
}

/** Pooled coverage over the latest `weeks` logged weeks, for number_health `range_coverage`. */
export function trailingCoverage({ leagueId = null, weeks = TRAILING_WEEKS, database = db } = {}) {
  if (!hasTable(database, 'range_coverage_log')) return null;
  const rowsOut = database.prepare(`SELECT season, week, SUM(n_team_weeks) AS n, SUM(covered) AS c, MAX(k) AS k
      FROM range_coverage_log WHERE (? IS NULL OR league_id = ?) GROUP BY season, week
      ORDER BY season DESC, week DESC LIMIT ?`).all(leagueId, leagueId, weeks);
  if (!rowsOut.length) return { n: 0, coverage: null, weeks: [] };
  const n = rowsOut.reduce((a, r) => a + r.n, 0), c = rowsOut.reduce((a, r) => a + r.c, 0);
  return { n, covered: c, coverage: n ? c / n : null, weeks: rowsOut.map(r => r.week).reverse(), k: rowsOut[0].k };
}
