/**
 * Why none of the twelve clears breakeven: an audit of the specialists as
 * they actually forecast, from the immutable weekly expert rows.
 *
 * A directional hit rate alone hides three failure modes this audit measures
 * separately:
 *   1. SCALE — a forecast of ±5 points when the market is right to within
 *      ±0.5 is not an opinion, it is noise; RMSE against the market residual
 *      (a forecast of zero) says whether a specialist adds or removes error.
 *   2. CONVICTION — if the big forecasts are no more right than the small
 *      ones, the size carries no information and must be shrunk.
 *   3. DUPLICATION — two specialists correlated at 0.8 are one opinion
 *      counted twice; the coordinator must not weight them independently
 *      (PROFITABILITY_PLAN Priority 3, first item).
 * Breakeven at -110 is 52.38%; the audit states the sample beside every rate.
 */
import { rows } from '../db/index.js';
import { NFL_EXPERTS } from './nfl-expert-council.js';
import { fitExpertCoordinator } from './nfl-expert-coordinator.js';

export const BREAKEVEN_RATE = 0.5238;
const r3 = value => (Number.isFinite(value) ? +value.toFixed(3) : null);
const r4 = value => (Number.isFinite(value) ? +value.toFixed(4) : null);
const mean = list => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);
const rmse = list => (list.length ? Math.sqrt(mean(list.map(value => value * value))) : null);
function correlation(x, y) {
  const mx = mean(x), my = mean(y);
  const cov = x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0);
  const vx = x.reduce((sum, value) => sum + (value - mx) ** 2, 0), vy = y.reduce((sum, value) => sum + (value - my) ** 2, 0);
  return vx && vy ? cov / Math.sqrt(vx * vy) : null;
}

export function specialistAudit({ auditRunId = null, excludeSeasons = [2021] } = {}) {
  const runId = auditRunId ?? rows('SELECT MAX(audit_run_id) id FROM nfl_weekly_expert_examples')[0]?.id ?? null;
  if (runId == null) return { available: false, reason: 'no historical diagnostic rows recorded yet' };
  const all = rows(`SELECT expert_id,season,week,home,forecast_residual f,uncertainty u,actual_residual a,directional_correct d
    FROM nfl_weekly_expert_examples WHERE audit_run_id=? AND observed=1 AND forecast_residual IS NOT NULL AND actual_residual IS NOT NULL`, runId)
    .filter(row => !excludeSeasons.includes(Number(row.season)));
  const byExpert = new Map();
  for (const row of all) { const list = byExpert.get(row.expert_id) ?? []; list.push(row); byExpert.set(row.expert_id, list); }
  const gameKey = row => `${row.season}|${row.week}|${row.home}`;
  const marketRows = [...new Map(all.map(row => [gameKey(row), row])).values()];
  const marketRmse = rmse(marketRows.map(row => row.a));

  const specialists = [...byExpert.entries()].map(([id, list]) => {
    const registry = NFL_EXPERTS.find(expert => expert.id === id) ?? { id, name: id };
    const directional = list.filter(row => row.d != null);
    const rate = sub => (sub.length ? r4(mean(sub.map(row => Number(row.d)))) : null);
    const conviction = [[0, 1], [1, 2], [2, 4], [4, Infinity]].map(([lo, hi]) => {
      const sub = directional.filter(row => Math.abs(row.f) >= lo && Math.abs(row.f) < hi);
      return { band: hi === Infinity ? `${lo}+ pts` : `${lo}-${hi} pts`, n: sub.length, directional_rate: rate(sub) };
    });
    const own = rmse(list.map(row => row.f - row.a)), zero = rmse(list.map(row => row.a));
    const verdict = own == null ? 'unscored'
      : own > zero * 1.02 ? 'adds error: forecasts are too large for their accuracy; shrink or drop'
        : own < zero * 0.995 ? 'removes error: a real, small signal'
          : 'neutral: indistinguishable from the market';
    return { id, name: registry.name, lifecycle: registry.lifecycle, games: list.length,
      mean_abs_forecast: r3(mean(list.map(row => Math.abs(row.f)))),
      directional_calls: directional.length, directional_rate: rate(directional),
      clears_breakeven: directional.length >= 100 && rate(directional) > BREAKEVEN_RATE,
      rmse_vs_actual: r3(own), market_rmse: r3(zero), error_ratio: own != null && zero ? r4(own / zero) : null,
      conviction_bands: conviction, verdict };
  }).sort((a, b) => (a.error_ratio ?? 9) - (b.error_ratio ?? 9));

  const ids = specialists.filter(item => !['coordinator', 'combined_decision'].includes(item.id)).map(item => item.id);
  const maps = Object.fromEntries(ids.map(id => [id, new Map(byExpert.get(id).map(row => [gameKey(row), row.f]))]));
  const duplicates = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const keys = [...maps[ids[i]].keys()].filter(key => maps[ids[j]].has(key));
    if (keys.length < 50) continue;
    const c = correlation(keys.map(key => maps[ids[i]].get(key)), keys.map(key => maps[ids[j]].get(key)));
    if (c != null && Math.abs(c) >= 0.3) duplicates.push({ a: ids[i], b: ids[j], correlation: r3(c), games: keys.length });
  }
  duplicates.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const games = new Map();
  for (const id of ids) for (const row of byExpert.get(id)) {
    const entry = games.get(gameKey(row)) ?? { a: row.a, f: [] };
    entry.f.push(row.f); games.set(gameKey(row), entry);
  }
  const consensus = { agree_home: { n: 0, right: 0 }, agree_away: { n: 0, right: 0 }, split: { n: 0 } };
  for (const entry of games.values()) {
    const home = entry.f.filter(f => f > 0.5).length, away = entry.f.filter(f => f < -0.5).length;
    if (home >= 5 && Math.abs(entry.a) > 1e-9) { consensus.agree_home.n++; consensus.agree_home.right += entry.a > 0 ? 1 : 0; }
    else if (away >= 5 && Math.abs(entry.a) > 1e-9) { consensus.agree_away.n++; consensus.agree_away.right += entry.a < 0 ? 1 : 0; }
    else consensus.split.n++;
  }
  const agreeN = consensus.agree_home.n + consensus.agree_away.n;
  const agreeRight = consensus.agree_home.right + consensus.agree_away.right;

  const worst = specialists.filter(item => item.verdict.startsWith('adds error')).map(item => item.name);
  const findings = [
    `Market residual RMSE is ${r3(marketRmse)} points; ${specialists.filter(item => item.verdict.startsWith('removes')).length} of ${specialists.length} scored roles reduce it.`,
    worst.length ? `Adding error (forecasts too large for their accuracy): ${worst.join(', ')}. Their size, not their direction, is the problem.` : null,
    duplicates.length ? `Duplicated opinions (|r| ≥ 0.5): ${duplicates.filter(d => Math.abs(d.correlation) >= 0.5).map(d => `${d.a}~${d.b} ${d.correlation}`).join(', ') || 'none'}. The coordinator must weight these as one signal.` : null,
    agreeN ? `When five or more specialists agree on a side (${agreeN} games) they are right ${r4(agreeRight / agreeN)}; below ${100} games that is not evidence.` : null,
    'No role clears 52.4% on a sample that could support the claim. The fix is not more roles: it is shrinking every forecast toward zero by its own walk-forward error, de-duplicating correlated roles, and adding evidence the market does not already price (opening-to-close movement, verified availability, multi-book price) now that those feeds exist for 2022–2025.'
  ].filter(Boolean);

  // What the v4 coordinator would do with these roles: the scale each has
  // earned walk-forward, which ones it zeroes, and which it pools as one.
  let coordinator = null;
  try {
    const fit = fitExpertCoordinator(9999, 1, { auditRunId: runId });
    coordinator = fit.ready ? { version: fit.version, games: fit.games, weeks: fit.weeks,
      shrinkage: Object.fromEntries(Object.entries(fit.shrinkage).map(([id, v]) => [id, { k: v.k, gain: v.gain, t: v.t, n: v.n, reason: v.reason }])),
      families: fit.families, family_correlations: fit.family_correlations,
      column_weights: fit.columns.map((c, i) => ({ column: c.id, members: c.members, weight: +fit.coefficients[i + 1].toFixed(4) })) }
      : { ready: false, reason: fit.reason };
  } catch (error) { coordinator = { ready: false, reason: error.message }; }
  return { available: true, audit_run_id: runId, games: games.size, breakeven_rate: BREAKEVEN_RATE, coordinator,
    market_rmse: r3(marketRmse), specialists, duplicates, consensus: { ...consensus, agree_rate: agreeN ? r4(agreeRight / agreeN) : null },
    findings,
    rule: 'Scored on the immutable weekly expert rows of the latest historical diagnostic; 2021 excluded; every rate carries its sample.' };
}
