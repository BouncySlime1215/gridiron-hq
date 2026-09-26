/**
 * SPEND-UI: the words and shares Settings -> AI & developer draws, built here so the screen
 * recomputes nothing (CLAUDE.md 2b, "one number, one producer").
 *
 * The 2b exception (this section only): dollars and model DISPLAY names are shown; raw model ids
 * and feature keys never are. A feature family with no label here is shown as "Other AI features".
 */
import { budgetKeyFor } from './llm-budget.js';

export const MODEL_LABELS = Object.freeze({
  'claude-haiku-4-5-20251001': 'Haiku 4.5', 'claude-haiku-4-5': 'Haiku 4.5', 'claude-sonnet-5': 'Sonnet 5', 'claude-opus-5-5': 'Opus 5.5',
  'typesafe-ai/jev': 'Jev'
});
export const FEATURE_LABELS = Object.freeze({
  coach: 'Coach', trade_proposals: 'Trade proposals', numbers_people: 'Numbers & People',
  'draft-advice': 'Draft advice', 'draft-advice-retry': 'Draft advice', 'draft-grade': 'Draft grades',
  'execution-slate-propose': 'Trade slates', 'execution-slate-review': 'Trade slates',
  injury_report: 'Injury reports', negotiation_profile: 'Negotiation profiles',
  'news-analyze': 'News', 'news-explain': 'News', 'news-roundup': 'News', 'nfl-news-typed-extraction': 'News',
  'nfl-news-event-typed-extraction': 'News', 'nfl-tweet-line-explain': 'News', 'nfl-press-role-inference': 'News',
  'nfl-page-explain-ai': 'Explain', 'nfl-pick-explain-ai': 'Explain', 'trade-explain': 'Explain',
  nfl_blind_replay_gate: 'Model checks', 'player-verdict': 'Player verdicts', 'scout-report': 'Scout reports',
  'team-analysis': 'Team analysis', 'trade-sense-check': 'Trade checks', 'trade-sense-check-retry': 'Trade checks',
  'weakness-review': 'Weakness review', 'llm-plumbing': 'Tests & builds'
});
export const SOURCE_LABELS = Object.freeze({ app: 'App', offline: 'Offline jobs', test: 'Tests & builds' });
export const OTHER_FEATURE = 'Other AI features';
export const OTHER_MODEL = 'Other model';
export const METER = Object.freeze({ warn: 0.8, over: 1 });

export const modelLabel = id => MODEL_LABELS[id] ?? OTHER_MODEL;
export const featureLabel = feature => FEATURE_LABELS[budgetKeyFor(feature)] ?? OTHER_FEATURE;
export const sourceLabel = s => SOURCE_LABELS[s] ?? SOURCE_LABELS.app;

const money = v => +v.toFixed(4);
const usd = v => `$${v.toFixed(2)}`;
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const weekday = date => WEEKDAY.format(new Date(`${date}T12:00:00Z`));

/** Rows grouped by their display label (several ids or keys can share one), largest first. */
function byLabel(list, labelOf) {
  const m = new Map();
  for (const r of list) {
    const label = labelOf(r);
    const g = m.get(label) ?? { label, cost_usd: 0, calls: 0 };
    g.cost_usd += r.cost ?? 0;
    g.calls += r.calls ?? 0;
    m.set(label, g);
  }
  const total = [...m.values()].reduce((s, g) => s + g.cost_usd, 0);
  return [...m.values()].map(g => ({ ...g, cost_usd: money(g.cost_usd), share: total > 0 ? +(g.cost_usd / total).toFixed(3) : 0 }))
    .sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
}

/** The DOM id of a budget's row, so a "budget used" message can link straight to it. */
export const budgetAnchor = key => `budget-${String(key).replace(/[^a-z0-9_-]/gi, '-')}`;

/** One Daily budgets row: a family is editable (setDailyBudget takes family names); a league's pot shows its spend. */
function budgetRow(b) {
  const family = budgetKeyFor(b.key);
  const scope = b.key.slice(family.length + 1);
  const name = FEATURE_LABELS[family] ?? OTHER_FEATURE;
  const share = b.budget_usd > 0 ? b.spent_usd / b.budget_usd : null;
  return {
    key: b.key, anchor: budgetAnchor(b.key), label: scope ? `${name} (${scope.replace(/^league-/, 'league ')})` : name,
    budget_usd: b.budget_usd, spent_usd: money(b.spent_usd), is_default: b.source === 'default',
    share: share == null ? null : +share.toFixed(3), level: share == null ? 'none' : share >= METER.over ? 'over' : share >= METER.warn ? 'warn' : 'ok',
    editable: !scope, off: b.budget_usd === 0
  };
}

/** The display block for one spendSummary(). */
export function spendDisplay(s) {
  const tb = s.total_budget;
  const share = tb.budget_usd > 0 ? tb.spent_usd / tb.budget_usd : null;
  const level = share == null ? 'none' : share >= METER.over ? 'over' : share >= METER.warn ? 'warn' : 'ok';
  const week = s.day_totals.slice(0, 7).reverse();
  const avg = week.length ? week.reduce((t, d) => t + d.cost, 0) / week.length : 0;
  const max = Math.max(avg, ...week.map(d => d.cost), 0);
  const a = s.anomaly;
  const top = a.top_driver ? featureLabel(a.top_driver.feature) : null;
  const hasSource = s.today_by_source.length > 0;
  const empty = s.today.calls === 0 && s.day_totals.every(d => d.calls === 0);
  return {
    empty,
    today: {
      spent_usd: tb.spent_usd, budget_usd: tb.budget_usd, all_sources_usd: s.today.cost, calls: s.today.calls,
      share: share == null ? null : +share.toFixed(3), level,
      line: tb.budget_usd > 0 ? `${usd(tb.spent_usd)} of ${usd(tb.budget_usd)} daily budget` : `${usd(s.today.cost)} today`,
      resets: 'Resets at midnight ET', estimate: true
    },
    last_7: {
      days: week.map(d => ({ date: d.date, label: weekday(d.date), cost_usd: d.cost, calls: d.calls, height: max > 0 ? +(d.cost / max).toFixed(3) : 0 })),
      avg_usd: money(avg), avg_height: max > 0 ? +(avg / max).toFixed(3) : 0, avg_line: `7-day average ${usd(avg)}`
    },
    breakdown: {
      feature: byLabel(s.today_by_feature, r => featureLabel(r.feature)),
      model: byLabel(s.today_by_model, r => modelLabel(r.model)),
      // Hidden until the source column exists (spec section 3.1): no rows means no column yet.
      source: hasSource ? byLabel(s.today_by_source, r => sourceLabel(r.source)) : null
    },
    brief_line: `Yesterday: ${usd(s.yesterday.cost)} API, ${s.yesterday.calls} call${s.yesterday.calls === 1 ? '' : 's'}`,
    anomaly: a.anomaly ? {
      line: a.avg_7d_usd > 0
        ? `AI spend today is ${a.ratio.toFixed(1)}x the 7-day average (${usd(a.today_usd)} vs ${usd(a.avg_7d_usd)})${top ? `, mostly ${top}` : ''}.`
        : `AI spend today is ${usd(a.today_usd)} with none in the last 7 days${top ? `, mostly ${top}` : ''}.`,
      tone: a.ratio == null || a.ratio >= 3 ? 'red' : 'amber'
    } : null,
    budgets: s.budgets.map(budgetRow),
    verified_note: "Not yet verified against Anthropic's billing.",
    credit_errors_today: s.credit_errors.today
  };
}
