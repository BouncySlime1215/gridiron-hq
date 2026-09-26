/**
 * SIM CALIBRATION MONITOR (batch D item 29): is the sim's probability still
 * honest THIS season, week by week, and has it started to drift?
 *
 * Two probabilities, graded against what happened:
 *
 * `CAL-MATCHUP` — the weekly matchup win probability, as served by its one
 *   producer (lineup-posture.js#lineupPosture). serve-log.js's weekly snapshot
 *   stores it for every matchup in every league (surface 'matchup_win', field
 *   'win_prob', entity `matchup:<week>:<roster>|<opponent>`) BEFORE the games,
 *   and only while this flag is on. Outcome: league_week_scores. A matchup is
 *   graded only when the week is behind the league's current week AND both
 *   teams scored > 0 (unplayed weeks are pre-created with points 0, ONE-PLAN
 *   section 7 row 7). Ties are left out and counted. Each pair is graded once,
 *   from the lower roster id's side (the other side is 1 - p by construction).
 *
 * `CAL-TITLE` — title and playoff odds from every weekly snapshot (the
 *   title_odds_snapshots view, migration 083), not only week 7 (E3-live grades
 *   week 7). Outcomes exist only once a season has ended, so in 2026 this row
 *   waits, and says so.
 *
 * Each row carries the Murphy Brier decomposition (reliability, resolution,
 * uncertainty), a per-week table, and a drift alarm. PRE-REGISTERED (PR body):
 *
 *   matchup  passing  n >= 100 AND Brier gain vs a coin flip, league-week
 *                     cluster bootstrap 95% CI > 0 AND slope in 0.8-1.2 AND
 *                     no drift alarm
 *            failing  drift alarm OR gain CI wholly < 0 OR slope CI wholly
 *                     outside 0.8-1.2 (only once n >= 100)
 *            drift    two-sided CUSUM on the weekly Spiegelhalter z (weeks
 *                     with >= 5 graded matchups), k = 0.5, h = 5. Under an
 *                     honest model the one-sided ARL0 is ~930 weeks, so a
 *                     false alarm in a 17-week season is ~4%.
 *   title    passing  >= 40 team-seasons AND playoff-odds Brier gain vs the
 *                     league's playoff share CI > 0 AND no week |z| > 3
 *            failing  any snapshot week |z| > 3 (Bonferroni over ~17 weeks at
 *                     5%) OR gain CI wholly < 0
 *
 * SHADOW: every row is detail.shadow_only, so brain-rule.js never lowers the
 * risk mode on it and brain-gate.js keeps it out of the War Room; it is read on
 * GET /api/brain-report. Default OFF: with GRIDIRON_CAL_MONITOR unset the
 * grader emits nothing and the weekly snapshot logs nothing new.
 */
import { STATUS, result, readSource, waiting } from './common.js';
import { bootstrapCI, brier, calibrationSlope, mean, moreNeeded, reliabilityBuckets, round } from './stats.js';

export const CHECK = 'CAL-MON';
export const MATCHUP_CHECK = 'CAL-MATCHUP';
export const TITLE_CHECK = 'CAL-TITLE';
export const ROW_IDS = Object.freeze([MATCHUP_CHECK, TITLE_CHECK]);
export const NAME = 'Sim calibration monitor';
export const SHADOW_ONLY = true;

export const CAL_MONITOR_ENV = 'GRIDIRON_CAL_MONITOR';
export const calMonitorEnabled = (env = process.env) => env[CAL_MONITOR_ENV] === '1';

export const SURFACE = 'matchup_win';
export const MIN_MATCHUPS = 100;
export const MIN_TEAM_SEASONS = 40;
export const MIN_WEEK_N = 5;
export const CUSUM_K = 0.5;
export const CUSUM_H = 5;
export const TITLE_Z_LIMIT = 3;
export const SLOPE_BAND = [0.8, 1.2];
const MATCHUP_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001];
const TITLE_EDGES = [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0000001];
const MATCHUP_BAR = `n >= ${MIN_MATCHUPS}; Brier gain vs coin flip CI > 0; slope 0.8-1.2; no CUSUM drift alarm (k ${CUSUM_K}, h ${CUSUM_H})`;
const TITLE_BAR = `>= ${MIN_TEAM_SEASONS} team-seasons; playoff-odds Brier gain vs league share CI > 0; no snapshot week |z| > ${TITLE_Z_LIMIT}`;

// ------------------------------------------------------------------ pure statistics
/**
 * Murphy decomposition of the Brier score over fixed bins:
 *   brier = reliability - resolution + uncertainty + within_bin
 * `within_bin` is what binning hides (0 when every forecast in a bin is equal);
 * it is reported, not dropped, so the identity always holds.
 */
export function brierDecomposition(p, y, edges = MATCHUP_EDGES) {
  const n = p.length;
  if (!n) return null;
  const base = mean(y.map(v => (v ? 1 : 0)));
  let rel = 0; let res = 0;
  for (let k = 0; k < edges.length - 1; k += 1) {
    const idx = [];
    for (let i = 0; i < n; i += 1) if (p[i] >= edges[k] && p[i] < edges[k + 1]) idx.push(i);
    if (!idx.length) continue;
    const pk = mean(idx.map(i => p[i]));
    const ok = mean(idx.map(i => (y[i] ? 1 : 0)));
    rel += idx.length * (pk - ok) ** 2;
    res += idx.length * (ok - base) ** 2;
  }
  const bs = brier(p, y);
  const reliability = rel / n; const resolution = res / n; const uncertainty = base * (1 - base);
  return { brier: bs, reliability, resolution, uncertainty, within_bin: bs - (reliability - resolution + uncertainty) };
}

/**
 * Spiegelhalter's z: under honest forecasts it is ~N(0, 1). Large |z| means the
 * forecasts are miscalibrated for these outcomes. Null when it cannot be formed.
 */
export function spiegelhalterZ(p, y) {
  let num = 0; let v = 0;
  for (let i = 0; i < p.length; i += 1) {
    num += ((y[i] ? 1 : 0) - p[i]) * (1 - 2 * p[i]);
    v += (1 - 2 * p[i]) ** 2 * p[i] * (1 - p[i]);
  }
  return v > 0 ? num / Math.sqrt(v) : null;
}

/** Two-sided tabular CUSUM over a series of z scores. `alarm_at` is the first index that crossed h. */
export function cusum(zs, { k = CUSUM_K, h = CUSUM_H } = {}) {
  let hi = 0; let lo = 0; let max = 0; let alarmAt = null;
  const path = [];
  for (let i = 0; i < zs.length; i += 1) {
    hi = Math.max(0, hi + zs[i] - k);
    lo = Math.max(0, lo - zs[i] - k);
    path.push({ hi: round(hi, 3), lo: round(lo, 3) });
    max = Math.max(max, hi, lo);
    if (alarmAt == null && (hi > h || lo > h)) alarmAt = i;
  }
  return { alarm: alarmAt != null, alarm_at: alarmAt, max: round(max, 3), path, k, h };
}

function weekTable(rows, edges) {
  const by = new Map();
  for (const r of rows) {
    const key = `${r.season}:${String(r.week).padStart(2, '0')}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.keys()].sort().map(key => {
    const g = by.get(key);
    const p = g.map(r => r.p); const y = g.map(r => r.y);
    const d = brierDecomposition(p, y, edges);
    return {
      season: g[0].season, week: g[0].week, n: g.length,
      mean_predicted: round(mean(p)), observed: round(mean(y)),
      brier: round(d.brier), reliability: round(d.reliability), resolution: round(d.resolution),
      z: round(spiegelhalterZ(p, y), 3),
    };
  });
}

const decomp = d => (d ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round(v, 5)])) : null);

// ------------------------------------------------------------------ matchup win probability
/**
 * Served weekly matchup rows + scores -> one graded row per matchup:
 * { league_id, season, week, p, y }. Returns counts of what was left out, and why.
 */
export function resolveMatchups({ served, scores, currentWeek }) {
  const pts = new Map(scores.map(s => [`${s.league_id}:${s.season}:${s.week}:${s.roster_id}`, s.points]));
  const seen = new Map();
  const skipped = { unplayed: 0, tie: 0, malformed: 0, duplicate: 0 };
  const ordered = [...served].sort((a, b) => String(a.served_at).localeCompare(String(b.served_at)));
  for (const s of ordered) {
    const m = /^matchup:(\d+):([^|]+)\|(.+)$/.exec(s.entity ?? '');
    const p = Number(s.value);
    if (!m || !(p >= 0 && p <= 1) || s.season == null) { skipped.malformed += 1; continue; }
    const week = Number(m[1]);
    const [a, b] = [m[2], m[3]];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${s.league_id}:${s.season}:${week}:${lo}|${hi}`;
    if (seen.has(key)) { skipped.duplicate += 1; continue; }
    seen.set(key, { league_id: s.league_id, season: s.season, week, lo, hi, p: a === lo ? p : 1 - p });
  }
  const rows = [];
  for (const g of seen.values()) {
    const cw = currentWeek.get(g.league_id);
    const pl = pts.get(`${g.league_id}:${g.season}:${g.week}:${g.lo}`);
    const ph = pts.get(`${g.league_id}:${g.season}:${g.week}:${g.hi}`);
    if (!(cw != null && g.week < cw) || !(pl > 0) || !(ph > 0)) { skipped.unplayed += 1; continue; }
    if (pl === ph) { skipped.tie += 1; continue; }
    rows.push({ league_id: g.league_id, season: g.season, week: g.week, p: g.p, y: pl > ph ? 1 : 0 });
  }
  return { rows, skipped };
}

export function gradeMatchups(rows, { reason = null, skipped = null } = {}) {
  const common = { check: MATCHUP_CHECK, name: `${NAME}: matchup win probability`, metricName: 'brier_gain_vs_coin', passBar: MATCHUP_BAR };
  const shadow = { shadow_only: true, flag: CAL_MONITOR_ENV, ...(skipped ? { skipped } : {}) };
  const n = rows.length;
  const p = rows.map(r => r.p); const y = rows.map(r => r.y);
  const weeks = weekTable(rows, MATCHUP_EDGES);
  const drift = cusum(weeks.filter(w => w.n >= MIN_WEEK_N && w.z != null).map(w => w.z));
  const detail = {
    ...shadow, decomposition: decomp(brierDecomposition(p, y, MATCHUP_EDGES)),
    reliability: n ? reliabilityBuckets(p, y) : [], weeks,
    drift: { alarm: drift.alarm, alarm_week: drift.alarm_at == null ? null : weeks.filter(w => w.n >= MIN_WEEK_N && w.z != null)[drift.alarm_at], max: drift.max, k: drift.k, h: drift.h },
  };
  if (n < MIN_MATCHUPS) {
    // A drift alarm is still reported (and fails the row) before n is reached: it
    // is a sequential test, valid at every look.
    if (drift.alarm) return result({ ...common, status: STATUS.FAILING, metric: n ? 0.25 - brier(p, y) : null, n, detail });
    return waiting({ ...common, minN: MIN_MATCHUPS, n, unit: 'matchups', reason, detail });
  }
  const clusters = rows.map(r => `${r.league_id}:${r.season}:${r.week}`);
  const gainOf = idx => 0.25 - brier(idx.map(i => p[i]), idx.map(i => y[i]));
  const gain = gainOf(rows.map((_, i) => i));
  const ci = bootstrapCI(n, gainOf, { clusters, seed: 2901 });
  const slope = calibrationSlope(p, y);
  const slopeCI = bootstrapCI(n, idx => calibrationSlope(idx.map(i => p[i]), idx.map(i => y[i])), { clusters, reps: 300, seed: 2902 });
  Object.assign(detail, { slope: round(slope), slope_ci: slopeCI && slopeCI.map(v => round(v)) });
  const [lo, hi] = SLOPE_BAND;
  const slopeOut = slopeCI && (slopeCI[1] < lo || slopeCI[0] > hi);
  if (drift.alarm || (ci && ci[1] < 0) || slopeOut) return result({ ...common, status: STATUS.FAILING, metric: gain, ci, n, detail });
  if (ci && ci[0] > 0 && slope != null && slope >= lo && slope <= hi) return result({ ...common, status: STATUS.PASSING, metric: gain, ci, n, detail });
  const needs = Math.max(ci ? moreNeeded(n, ci[1] - ci[0], Math.max(Math.abs(gain), 1e-3) * 2) : MIN_MATCHUPS,
    slopeCI ? moreNeeded(n, slopeCI[1] - slopeCI[0], hi - lo) : 1);
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: gain, ci, n, needsN: needs, needsUnit: 'matchups', detail });
}

// ------------------------------------------------------------------ title and playoff odds
/** Every weekly snapshot with a resolved outcome, graded; the baseline is the league's own share. */
export function gradeTitle(snapshots, { reason = null } = {}) {
  const common = { check: TITLE_CHECK, name: `${NAME}: title and playoff odds by week`, metricName: 'brier_gain_playoffs_vs_league_share', passBar: TITLE_BAR };
  const rows = snapshots.filter(r => r.p_playoffs != null && r.made_playoffs != null);
  const teamSeasons = new Set(rows.map(r => `${r.league_id}:${r.season}:${r.team_id}`)).size;
  const share = new Map();
  for (const r of rows) {
    const k = `${r.league_id}:${r.season}:${r.week}`;
    const s = share.get(k) ?? { yes: 0, n: 0 };
    s.yes += r.made_playoffs ? 1 : 0; s.n += 1; share.set(k, s);
  }
  const g = rows.map(r => ({ ...r, p: Number(r.p_playoffs), y: r.made_playoffs ? 1 : 0,
    b: share.get(`${r.league_id}:${r.season}:${r.week}`).yes / share.get(`${r.league_id}:${r.season}:${r.week}`).n }));
  const titled = snapshots.filter(r => r.p_title != null && r.won_title != null)
    .map(r => ({ season: r.season, week: r.week, p: Number(r.p_title), y: r.won_title ? 1 : 0 }));
  const weeks = weekTable(g, TITLE_EDGES);
  const worst = weeks.reduce((m, w) => (w.z != null && Math.abs(w.z) > Math.abs(m?.z ?? 0) ? w : m), null);
  const detail = {
    shadow_only: true, flag: CAL_MONITOR_ENV, team_seasons: teamSeasons,
    playoffs: { decomposition: decomp(brierDecomposition(g.map(r => r.p), g.map(r => r.y), TITLE_EDGES)), weeks },
    title: { decomposition: decomp(brierDecomposition(titled.map(r => r.p), titled.map(r => r.y), TITLE_EDGES)), weeks: weekTable(titled, TITLE_EDGES) },
    drift: { alarm: !!worst && Math.abs(worst.z) > TITLE_Z_LIMIT, worst_week: worst, z_limit: TITLE_Z_LIMIT },
    caveat: 'snapshots of one team across weeks share its outcome; the weekly z treats teams within a week as independent',
  };
  if (teamSeasons < MIN_TEAM_SEASONS) {
    return waiting({ ...common, minN: MIN_TEAM_SEASONS, n: teamSeasons, unit: 'team_seasons',
      reason: reason ?? (snapshots.length && !rows.length ? 'no snapshot has a resolved playoff outcome yet (the season has not ended)' : null), detail });
  }
  const clusters = g.map(r => `${r.league_id}:${r.season}`);
  const gainOf = idx => brier(idx.map(i => g[i].b), idx.map(i => g[i].y)) - brier(idx.map(i => g[i].p), idx.map(i => g[i].y));
  const gain = gainOf(g.map((_, i) => i));
  const ci = bootstrapCI(g.length, gainOf, { clusters, seed: 2903 });
  if (detail.drift.alarm || (ci && ci[1] < 0)) return result({ ...common, status: STATUS.FAILING, metric: gain, ci, n: teamSeasons, detail });
  if (ci && ci[0] > 0) return result({ ...common, status: STATUS.PASSING, metric: gain, ci, n: teamSeasons, detail });
  const needs = ci ? moreNeeded(teamSeasons, ci[1] - ci[0], Math.max(Math.abs(gain), 1e-3) * 2) : MIN_TEAM_SEASONS;
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: gain, ci, n: teamSeasons, needsN: needs, needsUnit: 'team_seasons', detail });
}

// ------------------------------------------------------------------ load + run
export function loadMatchups(database) {
  const served = readSource(database, 'served_numbers', ['league_id', 'surface', 'entity', 'field', 'value', 'trigger', 'season', 'served_at'],
    `SELECT league_id, entity, value, season, served_at FROM served_numbers
      WHERE surface = 'matchup_win' AND field = 'win_prob' AND trigger = 'weekly' AND value IS NOT NULL`);
  if (!served.ok) return { rows: [], reason: served.reason };
  if (!served.rows.length) return { rows: [], reason: 'no weekly matchup win probability has been logged yet (the snapshot logs it only while the flag is on)' };
  const scores = readSource(database, 'league_week_scores', ['league_id', 'season', 'week', 'roster_id', 'points']);
  if (!scores.ok) return { rows: [], reason: scores.reason };
  const leagues = readSource(database, 'leagues', ['id', 'current_week']);
  if (!leagues.ok) return { rows: [], reason: leagues.reason };
  const currentWeek = new Map(leagues.rows.filter(l => l.current_week != null).map(l => [l.id, Number(l.current_week)]));
  const { rows, skipped } = resolveMatchups({ served: served.rows, scores: scores.rows, currentWeek });
  return { rows, skipped, reason: rows.length ? null : 'no logged matchup has a final score yet' };
}

const TITLE_COLS = ['league_id', 'season', 'team_id', 'week', 'p_playoffs', 'p_title', 'made_playoffs', 'won_title'];

export function loadTitle(database) {
  const s = readSource(database, 'title_odds_snapshots', TITLE_COLS);
  return s.ok ? { rows: s.rows } : { rows: [], reason: s.reason };
}

export function run(database, { env = process.env } = {}) {
  if (!calMonitorEnabled(env)) return [];
  const m = loadMatchups(database);
  const t = loadTitle(database);
  return [gradeMatchups(m.rows, { reason: m.reason, skipped: m.skipped }), gradeTitle(t.rows, { reason: t.reason })];
}

// ------------------------------------------------------------------ weekly logging
/**
 * The weekly snapshot's matchup entries for one league: the served posture
 * payload of each matchup, once per pair. `posture` is lineup-posture.js
 * #lineupPosture (injected so this stays testable without the producer).
 */
export function matchupPostures(lg, posture) {
  const teams = JSON.parse(lg.payload ?? '{}').teams ?? [];
  const pairs = new Set();
  const out = [];
  for (const t of [...teams].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const id = String(t.id);
    if ([...pairs].some(k => k.split('|').includes(id))) continue;
    const res = posture(lg, { myTeamId: id });
    if (!res || res.error || res.opponent_roster_id == null || res.win_probability == null) continue;
    pairs.add(`${id}|${res.opponent_roster_id}`);
    out.push(res);
  }
  return out;
}
