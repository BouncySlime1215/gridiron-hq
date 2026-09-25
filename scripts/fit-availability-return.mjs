#!/usr/bin/env node
/**
 * AVAIL-HORIZON: fit and grade the return-to-play curve (server/services/availability-return.js).
 *
 * The question: a player's role state is known as of week t (snap-share tier, games his
 * team has played since his last appearance). What is P(he records usage in week t+h),
 * h = 1..16? Today the app answers with the ONE-week-ahead rate for every h (the gap is
 * frozen, contingency.js#weeklyAvailability), which is what zeroes Nick's league-4 title
 * odds (evidence/title-zero.md).
 *
 * ============================== PRE-REGISTRATION ==============================
 * Written 2026-09-24 before any curve number on any season was computed.
 *
 * Rows. For each season s and anchor week t = 1..17: every skill player in role scope
 * in roleStates(s, t) (gap bucket g0/g1/g2), and every target week t+h <= 18 in which
 * the team on his anchor state has a game (byes skipped). y = 1 if he has a
 * player_week_usage row in week t+h (any team), the same "active" as the one-week fit.
 * roleStates(s, t) reads only seasons s-1..s before week t, and targets stop at week 18
 * of s, so the 2024 grade never reads 2025. 2025 is not read at all.
 *
 * Candidate. fitReturnCurve (h bucket -> h|gap -> h|gap|tier, beta-binomial shrinkage,
 * k = 20 fixed, no selection), fit on 2021-2023, predicting the 2024 rows.
 *
 * Baseline ("frozen gap"): what production serves for a future week today:
 * playerActiveProbability with no report, the anchor role state, the durability prior
 * availability({ through: s-1 }), and the fitted tables ON FILE (nfl_availability_rates
 * + nfl_availability_role_rates, which were fit on 2021-2024: in-sample on 2024, so
 * this baseline has an advantage the candidate does not).
 *
 * Metric. Mean per-row log loss on 2024 (rowLogLoss, p clipped to [0.001, 0.999]).
 * Paired difference candidate - baseline, player-clustered bootstrap (pairedBootstrapDiff,
 * 2000 iterations, seed 1, 90% CI). Clustered by player, not league: NFL availability
 * has no league dimension, and a player's rows across anchors and horizons are the
 * correlated unit.
 *
 * PASS (ship the curve behind the flag) only if the 90% CI upper bound < 0. Reported,
 * not gating: Brier, ECE, and log loss by anchor gap bucket (g0 / g1 / g2) and by h
 * bucket. If it fails: declined, the curve is not emitted, and the app is unchanged.
 * On a pass, --emit refits on 2021-2024 (same k) and prints the rows for
 * availability-return.js#RETURN_CURVE_FIT.
 * ==============================================================================
 *
 * Usage (read-only on the DB):
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy> node scripts/fit-availability-return.mjs [--emit] [--report=path.json]
 */
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');
const {
  availability, roleStates, buildAvailabilityLookup, playerActiveProbability, rowLogLoss, availabilityScores
} = await import('../server/services/contingency.js');
const { fitReturnCurve, buildReturnLookup, horizonBucket } = await import('../server/services/availability-return.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');

export const FIT_SEASONS = [2021, 2022, 2023];
export const GRADE_SEASON = 2024;
export const EMIT_SEASONS = [2021, 2022, 2023, 2024];
export const K = 20;
const LAST_WEEK = 18;

const EMIT = process.argv.includes('--emit');
const REPORT_PATH = process.argv.find(a => a.startsWith('--report='))?.slice('--report='.length) ?? null;

/** Every (anchor state, target week) row of one season, with the anchor state kept for the baseline. */
function horizonRows(season) {
  const teamWeeks = new Set(rows(`SELECT DISTINCT team, week FROM player_week_usage
                                  WHERE season = ? AND team IS NOT NULL`, season).map(r => `${r.team}|${r.week}`));
  const played = new Set(rows('SELECT player_id, week FROM player_week_usage WHERE season = ?', season)
    .map(r => `${r.player_id}|${r.week}`));
  const out = [];
  for (let t = 1; t < LAST_WEEK; t++) {
    for (const st of roleStates(season, t).values()) {
      if (!st.gap_bucket || !st.team) continue;
      for (let target = t + 1; target <= LAST_WEEK; target++) {
        if (!teamWeeks.has(`${st.team}|${target}`)) continue;
        out.push({
          season, anchor: t, h: target - t, player_id: st.player_id, role: st,
          gap: st.gap_bucket, tier: st.tier, active: played.has(`${st.player_id}|${target}`) ? 1 : 0
        });
      }
    }
  }
  return out;
}

const t0 = Date.now();
const bySeason = new Map();
for (const s of new Set([...FIT_SEASONS, GRADE_SEASON, ...(EMIT ? EMIT_SEASONS : [])])) {
  bySeason.set(s, horizonRows(s));
  console.log(`season ${s}: ${bySeason.get(s).length} rows (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

// Candidate: fit on the fit seasons, predict the grade season.
const fitRows = FIT_SEASONS.flatMap(s => bySeason.get(s));
const curve = buildReturnLookup(fitReturnCurve(fitRows, { k: K }));

// Baseline: the one-week tables on file, exactly as weeklyAvailability reads them.
const rates = rows('SELECT scope,team,report_status,practice_status,p_active,n FROM nfl_availability_rates');
const roleRates = rows(`SELECT report_status,practice_status,position,tier,gap,p_active,n,config
                        FROM nfl_availability_role_rates`);
const onFile = buildAvailabilityLookup({ rates, roleRates });
if (!onFile.hasRole) throw new Error('no role table on file: the frozen-gap baseline cannot be priced');
const prior = availability({ through: GRADE_SEASON - 1 });
const baselineMemo = new Map();
const baselineOf = r => {
  const key = `${r.anchor}|${r.player_id}`;
  if (!baselineMemo.has(key)) {
    const pr = prior.get(r.player_id)?.available ?? 0.92;
    baselineMemo.set(key, +playerActiveProbability({ fitted: onFile, report: null, prior: pr, role: r.role }).active.toFixed(3));
  }
  return baselineMemo.get(key);
};

const graded = bySeason.get(GRADE_SEASON).map(r => ({
  player_id: r.player_id, y: r.active, gap: r.gap, hb: horizonBucket(r.h),
  p_base: baselineOf(r), p_curve: curve.lookup(r)?.p ?? baselineOf(r)
}));
const ll = (list, key) => list.reduce((s, r) => s + rowLogLoss(r[key], r.y), 0) / list.length;
const boot = pairedBootstrapDiff(graded.map(r => rowLogLoss(r.p_base, r.y)), graded.map(r => rowLogLoss(r.p_curve, r.y)),
  { iterations: 2000, seed: 1, groups: graded.map(r => r.player_id) });
const sBase = availabilityScores(graded.map(r => ({ p: r.p_base, y: r.y })));
const sCurve = availabilityScores(graded.map(r => ({ p: r.p_curve, y: r.y })));
const slice = (name, keep) => {
  const l = graded.filter(keep);
  return { slice: name, n: l.length, actual: +(l.reduce((s, r) => s + r.y, 0) / l.length).toFixed(4),
    mean_base: +(l.reduce((s, r) => s + r.p_base, 0) / l.length).toFixed(4),
    mean_curve: +(l.reduce((s, r) => s + r.p_curve, 0) / l.length).toFixed(4),
    ll_base: +ll(l, 'p_base').toFixed(4), ll_curve: +ll(l, 'p_curve').toFixed(4) };
};
const pass = boot.ci90 && boot.ci90[1] < 0;
const report = {
  prereg: 'scripts/fit-availability-return.mjs header', fit_seasons: FIT_SEASONS, grade_season: GRADE_SEASON, k: K,
  rows_fit: fitRows.length, rows_graded: graded.length, players_graded: new Set(graded.map(r => r.player_id)).size,
  log_loss_base: +ll(graded, 'p_base').toFixed(4), log_loss_curve: +ll(graded, 'p_curve').toFixed(4),
  diff_curve_minus_base: boot.mean_diff, ci90: boot.ci90, bootstrap: 'player-clustered, 2000, seed 1',
  brier_base: sBase.brier, brier_curve: sCurve.brier, ece_base: sBase.ece, ece_curve: sCurve.ece,
  by_gap: ['g0', 'g1', 'g2'].map(g => slice(g, r => r.gap === g)),
  by_h: ['h1', 'h2', 'h3', 'h4', 'h5-6', 'h7-9', 'h10+'].map(h => slice(h, r => r.hb === h)),
  pass
};
console.log(JSON.stringify(report, null, 1));

if (EMIT) {
  if (!pass) {
    console.log('\nGATE FAILED: nothing emitted; availability-return.js stays empty (the app is unchanged).');
  } else {
    const all = fitReturnCurve(EMIT_SEASONS.flatMap(s => bySeason.get(s)), { k: K });
    report.emitted = { fit_seasons: EMIT_SEASONS, rows: all.length };
    console.log('\n// RETURN_CURVE_FIT rows (fit ' + EMIT_SEASONS.join(',') + ', k ' + K + '):');
    console.log(JSON.stringify(all.map(r => ({ h: r.h, gap: r.gap, tier: r.tier, p_active: r.p_active, n: r.n }))));
  }
}
if (REPORT_PATH) fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
