/**
 * SPEND-SERVER: the spend summary Settings -> AI & developer (and the morning brief) read.
 * Server only; the screen does not recompute any of these numbers.
 *
 *   - Days are America/New_York calendar days, named explicitly (never the server's zone).
 *   - Today: totals, by model, by feature and by source (app / offline / test; rows written
 *     before the source column are 'app').
 *   - The total daily budget: the sum of the per-feature budgets (llm-budget.js), and what
 *     today's app and offline calls on those features spent against it.
 *   - Anomaly: today against the mean of the prior 7 full days. anomaly = today >= 2x that
 *     mean AND today >= $0.25. top_driver is the feature that cost the most today.
 *   - Credit errors (ai_usage.error = 'credit', migration 116): today and over the period.
 *   - The shared ledger (ai-ledger.js) is ingested first, so calls made on DB copies count.
 */
import { rows } from '../db/index.js';
import { rowCostUsd, listBudgets, budgetKeyFor } from './llm-budget.js';
import { ingestShared } from './ai-ledger.js';
import { SPEND_TZ, etDay, dayBefore } from './et-day.js';
import { spendDisplay } from './ai-spend-display.js';

export { SPEND_TZ, etDay, dayBefore };
export const ANOMALY = Object.freeze({ ratio: 2, min_usd: 0.25, prior_days: 7 });

const blank = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, calls: 0, cost: 0, unpriced_calls: 0 });
function add(acc, r) {
  acc.input_tokens += r.input_tokens ?? 0;
  acc.output_tokens += r.output_tokens ?? 0;
  acc.cache_read_input_tokens += r.cache_read_input_tokens ?? 0;
  acc.cache_creation_input_tokens += r.cache_creation_input_tokens ?? 0;
  acc.calls += r.calls ?? 0;
  const cost = rowCostUsd(r);
  if (cost == null) acc.unpriced_calls += r.calls ?? 0;
  else acc.cost += cost;
  return acc;
}
const money = v => +v.toFixed(4);
const rounded = g => ({ ...g, cost: money(g.cost) });
function groupBy(list, keyOf, seed) {
  const groups = new Map();
  for (const r of list) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { ...seed(r), ...blank() });
    add(groups.get(k), r);
  }
  return [...groups.values()].map(rounded).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
}

/**
 * The summary. `days`: how many New York days `daily` and the period totals cover.
 * `ingest`: false skips reading the shared ledger (tests of the arithmetic).
 */
export function spendSummary(days = 30, opts = {}) {
  const s = spendData(days, opts);
  // SPEND-UI: what Settings -> AI & developer draws, built from these same numbers (the screen computes nothing).
  return { ...s, display: spendDisplay(s) };
}

function spendData(days = 30, { now = new Date(), ingest = true } = {}) {
  const shared = ingest ? ingestShared() : { status: 'skipped' };
  const cols = new Set(rows('PRAGMA table_info(ai_usage)').map(c => c.name));
  const since = new Date(now.getTime() - (Math.max(days, ANOMALY.prior_days + 1) + 2) * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const all = rows(`SELECT feature, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, calls, cost_usd, created_at,
                           ${cols.has('source') ? 'source' : 'NULL AS source'}, ${cols.has('error') ? 'error' : 'NULL AS error'}
                    FROM ai_usage WHERE created_at >= ?`, since)
    .map(r => ({ ...r, day: etDay(r.created_at), source: r.source ?? 'app' }));

  const today = etDay(now);
  const yesterday = dayBefore(today);
  const first = dayBefore(today, days - 1);
  const period = all.filter(r => r.day >= first && r.day <= today);
  const todays = all.filter(r => r.day === today);

  // Per day, every day in the window (a day with no calls is $0, not missing).
  const byDay = new Map();
  for (const r of all) byDay.set(r.day, add(byDay.get(r.day) ?? blank(), r));
  const dayCost = d => byDay.get(d)?.cost ?? 0;
  const priorDays = Array.from({ length: ANOMALY.prior_days }, (_, i) => dayBefore(today, i + 1));
  const avg7 = priorDays.reduce((s, d) => s + dayCost(d), 0) / ANOMALY.prior_days;
  const todayCost = dayCost(today);
  const ratio = avg7 > 0 ? todayCost / avg7 : null;
  const byFeatureToday = groupBy(todays, r => r.feature, r => ({ feature: r.feature }));
  const top = byFeatureToday[0] ?? null;

  const budgets = listBudgets();
  const family = budgets.filter(b => !String(b.key).includes(':') && b.budget_usd != null);
  const budgeted = new Set(family.map(b => b.key));
  const spentOnBudgeted = todays.filter(r => r.source !== 'test' && budgeted.has(budgetKeyFor(r.feature)))
    .reduce((s, r) => s + (rowCostUsd(r) ?? 0), 0);
  const totalBudget = family.reduce((s, b) => s + b.budget_usd, 0);

  return {
    timezone: SPEND_TZ,
    today: { ...rounded(todays.reduce(add, blank())), date: today },
    yesterday: { ...rounded(all.filter(r => r.day === yesterday).reduce(add, blank())), date: yesterday },
    today_by_model: groupBy(todays, r => r.model ?? 'unknown', r => ({ model: r.model ?? 'unknown' })),
    today_by_feature: byFeatureToday,
    today_by_source: groupBy(todays, r => r.source, r => ({ source: r.source })),
    period_days: days,
    period_cost: money(period.reduce(add, blank()).cost),
    daily: groupBy(period, r => `${r.day}|${r.model}`, r => ({ date: r.day, model: r.model })).sort((a, b) => b.date.localeCompare(a.date) || b.cost - a.cost),
    day_totals: Array.from({ length: days }, (_, i) => dayBefore(today, i)).map(d => ({ date: d, ...rounded(byDay.get(d) ?? blank()) })),
    by_feature: groupBy(period, r => r.feature, r => ({ feature: r.feature })).sort((a, b) => b.calls - a.calls),
    by_source: groupBy(period, r => r.source, r => ({ source: r.source })),
    budgets,
    total_budget: { budget_usd: money(totalBudget), spent_usd: money(spentOnBudgeted), remaining_usd: money(Math.max(0, totalBudget - spentOnBudgeted)),
      basis: 'the sum of the per-feature daily budgets; spent is today\'s app and offline calls on those features (test calls do not count against it)' },
    anomaly: { avg_7d_usd: money(avg7), today_usd: money(todayCost), ratio: ratio == null ? null : +ratio.toFixed(2),
      anomaly: todayCost >= ANOMALY.min_usd && (avg7 === 0 || todayCost >= ANOMALY.ratio * avg7),
      top_driver: top ? { feature: top.feature, cost_usd: top.cost, share: todayCost > 0 ? +(top.cost / todayCost).toFixed(3) : null } : null,
      rule: `today >= ${ANOMALY.ratio}x the mean of the prior ${ANOMALY.prior_days} full days and today >= $${ANOMALY.min_usd.toFixed(2)}` },
    credit_errors: { today: todays.filter(r => r.error === 'credit').length, period: period.filter(r => r.error === 'credit').length },
    shared_ledger: shared
  };
}

/** The morning brief's spend line: yesterday's API cost and calls, New York day. */
export function yesterdaySpend({ now = new Date() } = {}) {
  const s = spendSummary(2, { now });
  return { date: s.yesterday.date, cost_usd: s.yesterday.cost, calls: s.yesterday.calls, timezone: SPEND_TZ };
}
