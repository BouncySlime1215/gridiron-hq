/**
 * E3 title-odds calibration: when the sim says 20%, do teams like that win
 * about 20%, and does it beat a standings-only baseline?
 *
 * Two rows.
 *
 * `E3` — the historical Sleeper week-7 replay, stored as a FIXED row. Numbers
 * are the pooled 2023-24 held-out result (fit 2021-22, 906 league-seasons,
 * 9,940 teams; league bootstrap, seed 303), BENCHMARKS.md E3 row and
 * rnd/eval/eval-hist.md. It validates the simulator STRUCTURE on each team's
 * own week 1-7 points, not the served sim's player projections; the detail
 * says so, and E3-live is what grades the served number.
 *
 * `E3-live` — 2026 forward. Source `title_odds_snapshots` (not built yet;
 * contract below): one row per team per week the served title odds were
 * snapshotted, with the outcome filled once known. Per team-season the week-7
 * snapshot is graded (the latest week <= 7, else the earliest), matching the
 * historical replay. Primary target: playoffs (titles need many seasons: one
 * champion per league). Baseline: the row's standings-only probability when the
 * producer stored one, else the league's own playoff share (labelled).
 *
 * Pass bar: Brier gain vs baseline CI > 0 and reliability slope 0.8-1.2.
 * Failing: gain CI wholly below 0 or slope CI wholly outside 0.8-1.2.
 */
import { STATUS, result, readSource, waiting } from './common.js';
import { bootstrapCI, brier, calibrationSlope, mean, moreNeeded, reliabilityBuckets } from './stats.js';

export const CHECK = 'E3';
export const LIVE_CHECK = 'E3-live';
export const NAME = 'Title-odds calibration';
export const MIN_TEAM_SEASONS = 40;
export const GRADE_WEEK = 7;
export const SLOPE_BAND = [0.8, 1.2];
const PASS_BAR = 'Brier gain vs standings-only CI > 0 and reliability slope 0.8-1.2';

export const HISTORICAL = Object.freeze({
  brier_gain_title: 0.0018, brier_gain_title_ci: [0.0012, 0.0024],
  brier_gain_playoffs: 0.026, brier_gain_playoffs_ci: [0.023, 0.028],
  slope_playoffs: 0.97, slope_playoffs_ci: [0.93, 1.01],
  slope_title: 0.94, slope_title_ci: [0.87, 1.05],
  league_seasons: 906, teams: 9940,
  split: 'fit 2021-22, graded 2023-24 (pooled), 2025 untouched',
  source: 'rnd/eval/eval-hist.md; BENCHMARKS.md E3 row',
  caveat: "uses each team's own week 1-7 points, not the served sim's projections",
});

/** The fixed historical row. Status is computed from the stored numbers, not asserted. */
export function historical(h = HISTORICAL) {
  const inBand = s => s >= SLOPE_BAND[0] && s <= SLOPE_BAND[1];
  const passes = h.brier_gain_title_ci[0] > 0 && h.brier_gain_playoffs_ci[0] > 0 && inBand(h.slope_playoffs) && inBand(h.slope_title);
  const fails = h.brier_gain_title_ci[1] < 0 || h.brier_gain_playoffs_ci[1] < 0
    || h.slope_title_ci[1] < SLOPE_BAND[0] || h.slope_title_ci[0] > SLOPE_BAND[1];
  return result({
    check: CHECK, name: `${NAME} (Sleeper replay, historical)`,
    status: fails ? STATUS.FAILING : passes ? STATUS.PASSING : STATUS.NOT_ENOUGH_DATA,
    metricName: 'brier_gain_title_vs_standings', metric: h.brier_gain_title, ci: h.brier_gain_title_ci,
    n: h.league_seasons, passBar: PASS_BAR, source: 'historical_fixed', detail: { ...h },
    ...(!fails && !passes ? { needsN: 1, needsUnit: 'league_seasons' } : {}),
  });
}

/** One snapshot per team-season: the latest week <= GRADE_WEEK, else the earliest. */
export function pickSnapshots(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.league_id}:${r.season}:${r.team_id}`;
    const cur = by.get(k);
    const better = !cur
      || (r.week <= GRADE_WEEK && (cur.week > GRADE_WEEK || r.week > cur.week))
      || (r.week > GRADE_WEEK && cur.week > GRADE_WEEK && r.week < cur.week);
    if (better) by.set(k, r);
  }
  return [...by.values()];
}

export function gradeLive(rows, { reason = null } = {}) {
  const snaps = pickSnapshots(rows).filter(r => r.p_playoffs != null && r.made_playoffs != null);
  const n = snaps.length;
  const common = { check: LIVE_CHECK, name: `${NAME} (2026 live)`, metricName: 'brier_gain_playoffs_vs_standings', passBar: PASS_BAR };
  if (n < MIN_TEAM_SEASONS) {
    return waiting({ ...common, minN: MIN_TEAM_SEASONS, n, unit: 'team_seasons',
      reason: reason ?? (rows.length && !n ? 'no snapshot has a resolved playoff outcome yet' : null) });
  }
  const p = snaps.map(r => Number(r.p_playoffs));
  const y = snaps.map(r => (r.made_playoffs ? 1 : 0));
  const leagueShare = new Map();
  for (const r of snaps) {
    const k = `${r.league_id}:${r.season}`;
    const s = leagueShare.get(k) ?? { yes: 0, n: 0 };
    s.yes += r.made_playoffs ? 1 : 0; s.n += 1; leagueShare.set(k, s);
  }
  const storedBaseline = snaps.every(r => r.baseline_p_playoffs != null);
  const b = snaps.map(r => (storedBaseline ? Number(r.baseline_p_playoffs)
    : leagueShare.get(`${r.league_id}:${r.season}`).yes / leagueShare.get(`${r.league_id}:${r.season}`).n));
  const gainOf = idx => brier(idx.map(i => b[i]), idx.map(i => y[i])) - brier(idx.map(i => p[i]), idx.map(i => y[i]));
  const clusters = snaps.map(r => `${r.league_id}:${r.season}`);
  const gain = gainOf(snaps.map((_, i) => i));
  const ci = bootstrapCI(n, gainOf, { clusters, seed: 303 });
  const slope = calibrationSlope(p, y);
  const slopeCI = bootstrapCI(n, idx => calibrationSlope(idx.map(i => p[i]), idx.map(i => y[i])), { clusters, reps: 300, seed: 307 });
  const titled = snaps.filter(r => r.p_title != null && r.won_title != null);
  const detail = {
    baseline: storedBaseline ? 'standings_only (stored by producer)' : "league playoff share (producer stored no standings-only baseline)",
    slope, slope_ci: slopeCI, reliability: reliabilityBuckets(p, y), grade_week: GRADE_WEEK,
    title: titled.length ? { n: titled.length, mean_predicted: mean(titled.map(r => Number(r.p_title))), observed: mean(titled.map(r => (r.won_title ? 1 : 0))) } : null,
  };
  const [lo, hi] = SLOPE_BAND;
  const slopeOut = slopeCI && (slopeCI[1] < lo || slopeCI[0] > hi);
  if ((ci && ci[1] < 0) || slopeOut) {
    return result({ ...common, status: STATUS.FAILING, metric: gain, ci, n, detail });
  }
  if (ci && ci[0] > 0 && slope != null && slope >= lo && slope <= hi) {
    return result({ ...common, status: STATUS.PASSING, metric: gain, ci, n, detail });
  }
  const needs = Math.max(ci ? moreNeeded(n, ci[1] - ci[0], Math.max(Math.abs(gain), 1e-3) * 2) : MIN_TEAM_SEASONS,
    slopeCI ? moreNeeded(n, slopeCI[1] - slopeCI[0], hi - lo) : 1);
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: gain, ci, n, needsN: needs, needsUnit: 'team_seasons', detail });
}

const COLS = ['league_id', 'season', 'team_id', 'week', 'p_playoffs', 'p_title', 'made_playoffs', 'won_title'];

export function load(database) {
  const s = readSource(database, 'title_odds_snapshots', COLS);
  if (!s.ok) return { rows: [], reason: `${s.reason}; migration 083 builds the view over serve-log (#243) served_numbers` };
  const hasBase = database.prepare(`SELECT 1 FROM pragma_table_info('title_odds_snapshots') WHERE name = 'baseline_p_playoffs'`).get();
  if (!hasBase) return { rows: s.rows };
  return { rows: database.prepare(`SELECT ${COLS.join(', ')}, baseline_p_playoffs FROM title_odds_snapshots`).all() };
}

export function run(database) {
  const { rows, reason } = load(database);
  return [historical(), gradeLive(rows, { reason })];
}
