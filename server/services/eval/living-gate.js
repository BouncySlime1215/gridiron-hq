/**
 * LIVING-01b re-gate: a weekly graded test, replacing "40 finished team-seasons"
 * (E3-live's MIN_TEAM_SEASONS), which cannot pass before the season ends.
 * Pre-registered in docs/tdd/2026-09-25-living-01b-regate.tdd.md; scope from the
 * coordinator comment on PR #261 (decision from Nick, 2026-09-24).
 *
 * Three brain_report rows, graded every refresh tick by the one grader producer
 * (eval/index.js#runAll):
 *
 *   L01B-ACT   next week's adds, drops and trades per team. Baseline: each team's
 *              own trailing rate, shrunk to the league rate (ACTIVITY-01's B0,
 *              alpha 2). Model: that rate times ACTIVITY-01's (#334) activity
 *              multiplier. Poisson log-loss and Brier on "any move", model minus
 *              baseline. A week passes when both are lower.
 *   L01B-SIM   next week's starting-lineup points per team, the sim with
 *              league-mates acting vs the static sim on the same seed, recorded
 *              BEFORE the week (living_gate_sim_predictions, migration 103) and
 *              graded on league_week_scores. A week passes when living's absolute
 *              error is lower.
 *   L01B-GATE  passing when each part's two latest graded weeks are consecutive
 *              and both pass. The grader flips nothing: promotion into served
 *              title odds is a coordinator decision after a local measurement.
 *
 * As-of: week w is predicted from weeks < w only; the ESPN feed returns ~3 days,
 * so history starts at the first week the collector saw whole (firstCoveredWeek).
 * CIs are 90% team-clustered bootstraps and are reported; the weekly pass is the
 * point estimate, and two consecutive weeks is the guard (pre-registration).
 */
import { STATUS, result, readSource, waiting } from './common.js';
import { bootstrapCI, mean, round } from './stats.js';
import { addsByTeam, completedTrades, dropsByTeam } from '../manager-signals.js';

export const CHECK = 'L01B-GATE';
export const ACT_CHECK = 'L01B-ACT';
export const SIM_CHECK = 'L01B-SIM';
export const NAME = 'LIVING-01b weekly gate';
/**
 * The gate grades a unit that serves nothing yet, so its rows carry
 * detail.shadow_only and brain-rule.js never lowers the risk mode on them.
 */
export const SHADOW_ONLY = true;
export const MIN_TEAM_WEEKS = 20;
export const MIN_HISTORY_WEEKS = 2;
export const ALPHA = 2;
export const FLOOR = 1e-3;
export const STREAMS = Object.freeze(['adds', 'drops', 'trades']);
const CI = { alpha: 0.10, reps: 1000, seed: 303 };
const ACT_BAR = 'model log-loss AND Brier below the trailing-rate baseline in 2 consecutive graded weeks (>= 20 team-weeks each)';
const SIM_BAR = 'living-sim absolute error below the static sim in 2 consecutive graded weeks (>= 20 team-weeks each)';
const GATE_BAR = 'L01B-ACT and L01B-SIM both pass 2 consecutive weeks';
const TX_COLUMNS = ['league_id', 'season', 'tx_id', 'type', 'status', 'execution_type', 'scoring_period', 'items_json', 'first_seen_at'];
const SCORE_COLUMNS = ['league_id', 'season', 'week', 'roster_id', 'points', 'opponent_roster_id'];
const SIM_COLUMNS = ['league_id', 'season', 'week', 'team_id', 'pred_static', 'pred_living', 'runs', 'seed', 'model'];

const zero = () => ({ adds: 0, drops: 0, trades: 0 });

/** Realised moves: team (string roster id) -> week -> { adds, drops, trades }. */
export function weeklyMoves(rows) {
  const out = new Map();
  const cell = (team, week) => {
    const k = String(team);
    const byWeek = out.get(k) ?? out.set(k, new Map()).get(k);
    return byWeek.get(week) ?? byWeek.set(week, zero()).get(week);
  };
  for (const [team, periods] of addsByTeam(rows)) for (const p of periods) cell(team, p).adds++;
  for (const [team, periods] of dropsByTeam(rows)) for (const p of periods) cell(team, p).drops++;
  for (const t of completedTrades(rows)) for (const team of t.parties) cell(team, t.period).trades++;
  return out;
}

/**
 * The first week the collector saw whole: one after the lowest scoring period
 * among the rows its first run saw (ESPN answers with ~3 days, so that week was
 * caught part-way). Draft rows are not moves. Null when there are no rows.
 */
export function firstCoveredWeek(rows) {
  const moves = rows.filter(r => r.type !== 'DRAFT' && Number(r.scoring_period) > 0 && r.first_seen_at);
  if (!moves.length) return null;
  const first = moves.reduce((m, r) => (r.first_seen_at < m ? r.first_seen_at : m), moves[0].first_seen_at);
  return Math.min(...moves.filter(r => r.first_seen_at === first).map(r => Number(r.scoring_period))) + 1;
}

/**
 * Next-week rates for every team in one league, from weeks fromWeek..week-1 only.
 * `intensity` is ACTIVITY-01's leagueActivityIntensity(teams, week) (or null):
 * it is handed the covered history, so its week argument is that history's
 * length + 1. Returns team -> { base, model, multiplier, model_reason }.
 */
export function activityPredictions(moves, { teams, week, fromWeek, points, intensity }) {
  const hist = [];
  for (let w = fromWeek; w < week; w++) hist.push(w);
  const h = hist.length;
  const count = (team, s) => hist.reduce((a, w) => a + (moves.get(team)?.get(w)?.[s] ?? 0), 0);
  const leagueRate = Object.fromEntries(STREAMS.map(s =>
    [s, teams.length && h ? teams.reduce((a, t) => a + count(t, s), 0) / (teams.length * h) : 0]));
  let model = null;
  if (intensity) {
    const inputs = teams.map(t => ({
      roster_id: t,
      adds: hist.map(w => moves.get(t)?.get(w)?.adds ?? 0),
      points: hist.map(w => points.get(t)?.get(w)?.points ?? null),
      opp_points: hist.map(w => points.get(t)?.get(w)?.opp ?? null),
      // not read here yet: ACTIVITY-01 zeroes these terms and names them in `missing`
      dead: hist.map(() => null),
      empty: hist.map(() => null),
    }));
    model = intensity(inputs, h + 1);
  }
  const out = new Map();
  for (const t of teams) {
    const base = Object.fromEntries(STREAMS.map(s => [s, Math.max((count(t, s) + ALPHA * leagueRate[s]) / (h + ALPHA), FLOOR)]));
    const m = model?.get(String(t));
    const multiplier = m && m.lambda != null && Number.isFinite(m.log_ratio) ? Math.exp(m.log_ratio) : null;
    out.set(t, {
      base,
      model: multiplier == null ? null : Object.fromEntries(STREAMS.map(s => [s, Math.max(base[s] * multiplier, FLOOR)])),
      multiplier,
      model_reason: multiplier == null ? (intensity ? (m?.reason ?? 'no intensity for this team') : 'no activity model') : null,
    });
  }
  return out;
}

const logFact = y => { let s = 0; for (let k = 2; k <= y; k++) s += Math.log(k); return s; };
/** Poisson log-loss (nats), summed over the streams. */
const poissonLoss = (lam, y) => STREAMS.reduce((a, s) => a - (y[s] * Math.log(lam[s]) - lam[s] - logFact(y[s])), 0);
/** Brier on "any move of stream s", averaged over the streams. */
const anyBrier = (lam, y) => mean(STREAMS.map(s => ((1 - Math.exp(-lam[s])) - (y[s] > 0 ? 1 : 0)) ** 2));

const ciOf = (items, key) => {
  const ci = bootstrapCI(items.length, idx => mean(idx.map(i => items[i][key])), { ...CI, clusters: items.map(i => i.team) });
  return ci ? [round(ci[0], 5), round(ci[1], 5)] : null;
};

function espnLeagues(database) {
  const src = readSource(database, 'leagues', ['id', 'platform', 'season', 'payload'],
    `SELECT id, platform, season, payload FROM leagues WHERE platform = 'espn' AND payload IS NOT NULL ORDER BY id`);
  if (!src.ok) return src;
  const leagues = [];
  for (const r of src.rows) {
    const p = JSON.parse(r.payload);
    leagues.push({
      id: r.id, season: r.season ?? p.seasonId,
      teams: (p.teams ?? []).map(t => String(t.id)),
      lastCompleted: Number(p.scoringPeriodId) - 1,
    });
  }
  return { ok: true, leagues };
}

/** team -> week -> { points, opp } for one league-season, from league_week_scores rows. */
function weekPoints(scoreRows, leagueId, season) {
  const rows = scoreRows.filter(r => r.league_id === leagueId && r.season === season);
  const pts = new Map(rows.map(r => [`${r.roster_id}:${r.week}`, r.points]));
  const out = new Map();
  for (const r of rows) {
    const k = String(r.roster_id);
    (out.get(k) ?? out.set(k, new Map()).get(k)).set(Number(r.week),
      { points: r.points, opp: r.opponent_roster_id == null ? null : pts.get(`${r.opponent_roster_id}:${r.week}`) ?? null });
  }
  return out;
}

/**
 * ACTIVITY part, every graded week pooled across leagues. `intensityFor({ leagueId })`
 * returns ACTIVITY-01's leagueActivityIntensity for that league, or null.
 */
export function gradeActivity(database, { intensityFor = null } = {}) {
  const lg = espnLeagues(database);
  if (!lg.ok) return { weeks: [], reason: lg.reason };
  const tx = readSource(database, 'league_transactions_raw', TX_COLUMNS);
  if (!tx.ok) return { weeks: [], reason: tx.reason };
  // Points only feed ACTIVITY-01's result terms; without the table those terms are 0 and named missing.
  const scores = readSource(database, 'league_week_scores', SCORE_COLUMNS);
  const scoreRows = scores.ok ? scores.rows : [];
  const byWeek = new Map();
  const coverage = {};
  let modelMissing = 0, noModelReason = null;
  for (const l of lg.leagues) {
    const rows = tx.rows.filter(r => r.league_id === l.id && r.season === l.season);
    const fromWeek = firstCoveredWeek(rows);
    coverage[l.id] = fromWeek;
    if (fromWeek == null) continue;
    const moves = weeklyMoves(rows);
    const points = weekPoints(scoreRows, l.id, l.season);
    const intensity = intensityFor ? intensityFor({ leagueId: l.id }) : null;
    for (let w = fromWeek + MIN_HISTORY_WEEKS; w <= l.lastCompleted; w++) {
      const preds = activityPredictions(moves, { teams: l.teams, week: w, fromWeek, points, intensity });
      for (const [team, p] of preds) {
        if (!p.model) { modelMissing++; noModelReason ??= p.model_reason; continue; }
        const y = moves.get(team)?.get(w) ?? zero();
        const item = {
          team: `${l.id}:${team}`,
          ll_b: poissonLoss(p.base, y), ll_m: poissonLoss(p.model, y),
          br_b: anyBrier(p.base, y), br_m: anyBrier(p.model, y),
        };
        item.ll_d = item.ll_m - item.ll_b;
        item.br_d = item.br_m - item.br_b;
        (byWeek.get(w) ?? byWeek.set(w, []).get(w)).push(item);
      }
    }
  }
  const weeks = [];
  let short = 0;
  for (const [week, items] of [...byWeek].sort((a, b) => a[0] - b[0])) {
    if (items.length < MIN_TEAM_WEEKS) { short += items.length; continue; }
    const ll = mean(items.map(i => i.ll_d)), br = mean(items.map(i => i.br_d));
    weeks.push({
      week, n: items.length,
      ll_base: round(mean(items.map(i => i.ll_b)), 5), ll_model: round(mean(items.map(i => i.ll_m)), 5),
      ll_delta: round(ll, 5), ll_ci: ciOf(items, 'll_d'),
      brier_base: round(mean(items.map(i => i.br_b)), 5), brier_model: round(mean(items.map(i => i.br_m)), 5),
      brier_delta: round(br, 5), brier_ci: ciOf(items, 'br_d'),
      pass: ll < 0 && br < 0,
    });
  }
  return {
    weeks, team_weeks_short: short, coverage, team_weeks_without_model: modelMissing,
    reason: !intensityFor ? 'the activity model (ACTIVITY-01, #334) is not on this build' : noModelReason && !weeks.length ? noModelReason : null,
  };
}

/** SIM part: forward-recorded rows graded on completed weeks' lineup points. */
export function gradeSim(database) {
  const lg = espnLeagues(database);
  if (!lg.ok) return { weeks: [], reason: lg.reason };
  const src = readSource(database, 'living_gate_sim_predictions', SIM_COLUMNS);
  if (!src.ok) return { weeks: [], reason: src.reason };
  if (!src.rows.length) {
    return { weeks: [], reason: 'no forward prediction recorded yet; the recorder waits on the LIVING-01b sim (#261)' };
  }
  const last = new Map(lg.leagues.map(l => [l.id, l]));
  const scores = readSource(database, 'league_week_scores', SCORE_COLUMNS);
  if (!scores.ok) return { weeks: [], reason: scores.reason };
  const real = new Map(scores.rows.map(r => [`${r.league_id}:${r.season}:${r.week}:${r.roster_id}`, r.points]));
  const byWeek = new Map();
  for (const r of src.rows) {
    const l = last.get(r.league_id);
    // A week is graded once it is complete; unplayed weeks are stored as 0 (ONE-PLAN data row 7).
    if (!l || r.season !== l.season || r.week > l.lastCompleted) continue;
    const y = real.get(`${r.league_id}:${r.season}:${r.week}:${r.team_id}`);
    if (y == null) continue;
    const item = {
      team: `${r.league_id}:${r.team_id}`,
      abs_d: Math.abs(r.pred_living - y) - Math.abs(r.pred_static - y),
      sq_d: (r.pred_living - y) ** 2 - (r.pred_static - y) ** 2,
      abs_s: Math.abs(r.pred_static - y), abs_l: Math.abs(r.pred_living - y),
    };
    (byWeek.get(r.week) ?? byWeek.set(r.week, []).get(r.week)).push(item);
  }
  const weeks = [];
  let short = 0;
  for (const [week, items] of [...byWeek].sort((a, b) => a[0] - b[0])) {
    if (items.length < MIN_TEAM_WEEKS) { short += items.length; continue; }
    const d = mean(items.map(i => i.abs_d));
    weeks.push({
      week, n: items.length,
      abs_static: round(mean(items.map(i => i.abs_s)), 4), abs_living: round(mean(items.map(i => i.abs_l)), 4),
      abs_delta: round(d, 4), abs_ci: ciOf(items, 'abs_d'),
      mse_delta: round(mean(items.map(i => i.sq_d)), 4), mse_ci: ciOf(items, 'sq_d'),
      pass: d < 0,
    });
  }
  return { weeks, team_weeks_short: short, recorded: src.rows.length, reason: weeks.length ? null : 'no recorded week is complete yet' };
}

/** pass: the two latest graded weeks are consecutive and both pass. */
export function partVerdict(weeks) {
  const w = [...weeks].sort((a, b) => a.week - b.week);
  if (w.length < 2) return { state: 'waiting', graded: w.length };
  const [a, b] = w.slice(-2);
  const pass = b.week === a.week + 1 && a.pass && b.pass;
  return { state: pass ? 'pass' : 'fail', graded: w.length, latest: [a.week, b.week] };
}

function partRow({ check, name, metricName, passBar, part, metricKey, ciKey }) {
  const v = partVerdict(part.weeks);
  const n = part.weeks.reduce((a, w) => a + w.n, 0);
  const detail = { ...part, verdict: v, shadow_only: true };
  if (v.state === 'waiting') {
    return waiting({ check, name, metricName, passBar, minN: 2, n: part.weeks.length, unit: 'weeks',
      reason: part.reason ?? `${part.weeks.length} graded week(s) so far`, detail });
  }
  const latest = part.weeks[part.weeks.length - 1];
  return result({
    check, name, status: v.state === 'pass' ? STATUS.PASSING : STATUS.FAILING,
    metricName, metric: latest[metricKey], ci: latest[ciKey], n, passBar, detail,
  });
}

export function run(database, opts = {}) {
  const act = partRow({
    check: ACT_CHECK, name: `${NAME}: league-mate activity`, metricName: 'logloss_delta_model_vs_trailing_latest_week',
    passBar: ACT_BAR, part: gradeActivity(database, opts), metricKey: 'll_delta', ciKey: 'll_ci',
  });
  const sim = partRow({
    check: SIM_CHECK, name: `${NAME}: sim with league-mates vs static`, metricName: 'abs_error_delta_living_vs_static_latest_week',
    passBar: SIM_BAR, part: gradeSim(database), metricKey: 'abs_delta', ciKey: 'abs_ci',
  });
  const parts = [act, sim];
  const passing = parts.filter(r => r.status === STATUS.PASSING).length;
  const common = { check: CHECK, name: NAME, metricName: 'parts_passing', metric: passing, n: 2, passBar: GATE_BAR,
    detail: { shadow_only: true, act: act.status, sim: sim.status, promotes: 'GRIDIRON_LIVING=1 after a local measurement; this grader flips nothing' } };
  let gate;
  if (parts.some(r => r.status === STATUS.NOT_ENOUGH_DATA)) {
    const needs = Math.max(...parts.map(r => r.needs_n ?? 0), 1);
    gate = result({ ...common, status: STATUS.NOT_ENOUGH_DATA, needsN: needs, needsUnit: 'weeks',
      needsText: `needs ${needs} more graded week(s): ${parts.filter(r => r.needs_text).map(r => `${r.check} ${r.needs_text}`).join('; ')}` });
  } else {
    gate = result({ ...common, status: passing === 2 ? STATUS.PASSING : STATUS.FAILING });
  }
  return [act, sim, gate];
}
