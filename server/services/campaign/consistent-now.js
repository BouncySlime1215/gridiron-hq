/**
 * AJ-HEALTHY: "a consistent weekly scorer now", measured. Nick 9/24 (ONE-PLAN 10b.3): A.J. Brown
 * (277) moves only for a Blue chip who is a CONSISTENT weekly scorer now (high floor, low
 * week-to-week variance, healthy, established role), not a boom/bust or future piece.
 *
 * The rule is pre-registered below (CONSISTENT_NOW) and is the only thing never-give.js's
 * consistentOf hook reads. It is switched on only by its own flag, GRIDIRON_AJ_HEALTHY=1, and stays
 * off until gradeConsistency() passes its bar on real seasons (Needs local measurement in the PR).
 * Off, 277 stays pinned exactly as before.
 *
 * Sources (strictly-prior weeks of the current season, week N itself is never read):
 *   weekly points   nfl_ffopportunity_weekly.actual_fantasy_points (PPR, keyed on players.gsis_id)
 *   role            nfl_ffopportunity_weekly.expected_fantasy_points (usage, not luck)
 *   healthy         love-inputs.js's week-N injury read (one reader; stale or unfiled = unknown)
 */
import { readLoveInputs } from './love-inputs.js';

export const AJ_HEALTHY_ENV = 'GRIDIRON_AJ_HEALTHY';
/** '1' switches the measured check on; anything else (and GRIDIRON_PREVIEW_UNCONFIRMED) leaves 277 pinned. */
export const ajHealthyOn = (env = process.env) => String(env[AJ_HEALTHY_ENV] ?? '').trim() === '1';

/**
 * Pre-registered 2026-09-25, before any real data was read. Every condition must hold:
 *   games       >= min_games played in the last `lookback` completed weeks
 *   role        mean expected points >= the position floor (an established role, not a lucky month)
 *   floor       share of those games at or above the position floor >= min_floor_share
 *   variance    coefficient of variation (population sd / mean, actual points) <= max_cv
 *   healthy     this week's injury report reads him healthy (unknown fails)
 * The grade bar (gradeConsistency) is pre-registered with it.
 */
export const CONSISTENT_NOW = Object.freeze({
  version: 'consistent-now-v1',
  lookback: 4,
  min_games: 3,
  floor_pts: Object.freeze({ QB: 15, RB: 10, WR: 10, TE: 8 }),
  min_floor_share: 0.75,
  max_cv: 0.4,
  grade: Object.freeze({
    horizon: 4,               // forward weeks N .. N+3
    min_flagged: 200,         // flagged player-weeks
    min_comparison: 50,       // eligible-but-not-flagged player-weeks
    min_forward_floor: 0.70,  // flagged players' forward share of games at or above the floor
    min_diff: 0.10,           // flagged minus comparison, forward floor share
    ci_lower_above: 0,        // player-clustered bootstrap 95% CI of the diff sits above this
    boot: 1000,
  }),
});

const REASONS = ['too_few_games', 'no_position_floor', 'no_established_role', 'below_floor', 'high_variance', 'not_healthy'];

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * One player's verdict from his last `lookback` games.
 * weeks: [{ actual, expected }] (games played; nulls are dropped). role: 'healthy' | 'unhealthy' | 'unknown'.
 * -> { consistent, reasons, games, mean, cv, floor_share, expected_mean, floor }
 */
export function consistencyVerdict(weeks, { position, role }, rule = CONSISTENT_NOW) {
  const played = (weeks ?? []).filter(w => Number.isFinite(w?.actual));
  const floor = rule.floor_pts[String(position ?? '').toUpperCase()] ?? null;
  const reasons = new Set();
  const out = { games: played.length, floor, mean: null, cv: null, floor_share: null, expected_mean: null };
  if (played.length < rule.min_games) reasons.add('too_few_games');
  else if (floor == null) reasons.add('no_position_floor');
  else {
    const xs = played.map(w => w.actual);
    const m = mean(xs);
    const sd = Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
    const ex = played.map(w => w.expected).filter(Number.isFinite);
    out.mean = +m.toFixed(3);
    out.cv = m > 0 ? +(sd / m).toFixed(3) : null;
    out.floor_share = +(xs.filter(x => x >= floor).length / xs.length).toFixed(3);
    out.expected_mean = ex.length ? +mean(ex).toFixed(3) : null;
    if (out.expected_mean == null || out.expected_mean < floor) reasons.add('no_established_role');
    if (out.floor_share < rule.min_floor_share) reasons.add('below_floor');
    if (out.cv == null || out.cv > rule.max_cv) reasons.add('high_variance');
  }
  if (role !== 'healthy') reasons.add('not_healthy');
  return { consistent: reasons.size === 0, reasons: REASONS.filter(r => reasons.has(r)), ...out };
}

function hasTable(db, name) {
  return !!db.row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
}

/**
 * Verdicts for app player ids in one season at week N (weeks N-lookback .. N-1 read).
 * -> { byId: Map id(string) -> verdict, sources: { weekly, injuries } }. A missing table is reported,
 * never thrown, and certifies nobody.
 */
export function readConsistency(db, { season, week, ids }, rule = CONSISTENT_NOW) {
  const want = [...new Set((ids ?? []).map(Number).filter(Number.isInteger))];
  const byId = new Map();
  const sources = { weekly: { status: 'ok', rows: 0 }, injuries: { status: 'not_read' } };
  if (!hasTable(db, 'nfl_ffopportunity_weekly')) {
    sources.weekly = { status: 'table_absent', reason: 'nfl_ffopportunity_weekly is not on this database' };
    for (const id of want) byId.set(String(id), consistencyVerdict([], { position: null, role: 'unknown' }, rule));
    return { byId, sources };
  }
  const love = readLoveInputs(db, { season, week, ids: want, lookback: rule.lookback });
  sources.injuries = love.sources.injuries;
  const base = want.length
    ? db.rows(`SELECT id, position, gsis_id FROM players WHERE id IN (${want.map(() => '?').join(', ')})`, ...want) : [];
  const gsis = base.map(p => p.gsis_id).filter(Boolean);
  const series = new Map();
  if (gsis.length) {
    const rows = db.rows(`SELECT player_gsis_id, week, expected_fantasy_points, actual_fantasy_points
                          FROM nfl_ffopportunity_weekly
                          WHERE season = ? AND week >= ? AND week < ? AND player_gsis_id IN (${gsis.map(() => '?').join(', ')})
                          ORDER BY week`, season, Math.max(1, week - rule.lookback), week, ...gsis);
    sources.weekly.rows = rows.length;
    for (const r of rows) {
      if (!series.has(r.player_gsis_id)) series.set(r.player_gsis_id, []);
      series.get(r.player_gsis_id).push({ actual: r.actual_fantasy_points, expected: r.expected_fantasy_points });
    }
  }
  for (const id of want) {
    const p = base.find(b => Number(b.id) === id);
    const weeks = p?.gsis_id ? series.get(p.gsis_id) ?? [] : [];
    const role = love.players.get(id)?.role?.status ?? 'unknown';
    byId.set(String(id), consistencyVerdict(weeks, { position: p?.position ?? null, role }, rule));
  }
  return { byId, sources };
}

/* ------------------------------------------------------------ the grade */

/** Deterministic PRNG for the bootstrap (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The pre-registered grade: does "consistent now" at week N predict a held floor over weeks N..N+3?
 * series: [{ player, position, season, weeks: [{ week, actual, expected }] }] (completed seasons).
 * Scoring part only: the backtest reads every player as healthy (historical week-N reports are a
 * separate source), so it grades games, role, floor and variance.
 * Eligible = games, role and position pass; flagged = also floor and variance pass; comparison =
 * eligible and not flagged. Outcome = forward share of games at or above the floor.
 * -> { bar, flagged: { n, forward_floor_share }, comparison: {...}, diff, diff_ci95, pass, fails }
 */
export function gradeConsistency(series, { seed = 1, rule = CONSISTENT_NOW } = {}) {
  const g = rule.grade;
  const obs = [];   // { player, flagged, outcome }
  for (const s of series ?? []) {
    const byWeek = new Map((s.weeks ?? []).filter(w => Number.isFinite(w?.actual)).map(w => [w.week, w]));
    const last = Math.max(0, ...byWeek.keys());
    for (let n = rule.lookback + 1; n + g.horizon - 1 <= last; n++) {
      const back = [];
      for (let w = n - rule.lookback; w < n; w++) if (byWeek.has(w)) back.push(byWeek.get(w));
      const v = consistencyVerdict(back, { position: s.position, role: 'healthy' }, rule);
      if (v.reasons.some(r => r !== 'below_floor' && r !== 'high_variance')) continue;
      const fwd = [];
      for (let w = n; w < n + g.horizon; w++) if (byWeek.has(w)) fwd.push(byWeek.get(w).actual);
      if (!fwd.length) continue;
      obs.push({ player: `${s.season}:${s.player}`, flagged: v.consistent, outcome: fwd.filter(x => x >= v.floor).length / fwd.length });
    }
  }
  const side = f => {
    const xs = obs.filter(o => o.flagged === f);
    return { n: xs.length, forward_floor_share: xs.length ? +mean(xs.map(o => o.outcome)).toFixed(4) : null };
  };
  const flagged = side(true), comparison = side(false);
  const diffOf = list => {
    const a = list.filter(o => o.flagged), b = list.filter(o => !o.flagged);
    return a.length && b.length ? mean(a.map(o => o.outcome)) - mean(b.map(o => o.outcome)) : null;
  };
  const diff = diffOf(obs);
  // Player-clustered bootstrap: resample players, keep all of each player's weeks.
  const byPlayer = new Map();
  for (const o of obs) byPlayer.set(o.player, [...(byPlayer.get(o.player) ?? []), o]);
  const players = [...byPlayer.values()];
  const draws = [];
  const r = rng(seed);
  if (players.length) {
    for (let i = 0; i < g.boot; i++) {
      const sample = [];
      for (let j = 0; j < players.length; j++) sample.push(...players[Math.floor(r() * players.length)]);
      const d = diffOf(sample);
      if (d != null) draws.push(d);
    }
  }
  draws.sort((a, b) => a - b);
  const ci = draws.length ? [draws[Math.floor(0.025 * draws.length)], draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))]].map(x => +x.toFixed(4)) : null;
  const fails = [];
  if (flagged.n < g.min_flagged) fails.push(`flagged player-weeks ${flagged.n} < ${g.min_flagged}`);
  if (comparison.n < g.min_comparison) fails.push(`comparison player-weeks ${comparison.n} < ${g.min_comparison}`);
  if (!(flagged.forward_floor_share >= g.min_forward_floor)) fails.push(`flagged forward floor share ${flagged.forward_floor_share} < ${g.min_forward_floor}`);
  if (!(diff >= g.min_diff)) fails.push(`diff ${diff == null ? null : diff.toFixed(4)} < ${g.min_diff}`);
  if (!(ci && ci[0] > g.ci_lower_above)) fails.push(`diff 95% CI lower ${ci?.[0] ?? null} <= ${g.ci_lower_above}`);
  return { bar: { version: rule.version, ...g }, flagged, comparison,
    diff: diff == null ? null : +diff.toFixed(4), diff_ci95: ci, pass: fails.length === 0, fails };
}
