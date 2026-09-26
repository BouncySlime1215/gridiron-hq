/**
 * DATA QUALITY PANEL (Batch D item 35): one read-only report for Settings -> Health.
 *
 * Four sections, each read from the producer that already owns it (never a second copy):
 *
 *   freshness            data-freshness.js#dataFreshness, the call GET /api/data-freshness makes
 *   offer_orphans        eval/decided-offers.js#loadDecidedOffers `.orphans` (ESPN answers whose offer
 *                        was never collected), plus app offers Nick marked sent that no ESPN proposal
 *                        has matched after ORPHAN_SENT_HOURS (trade_outcomes, read here)
 *   number_health_trend  number-audit.js#readNumberHealthTrend (migration 118's daily points)
 *   fallbacks            the plans file (war-room-view.js#loadPlans) through campaign/plan-age.js#planAge,
 *                        the brain report's fell_back_to, and stale fit stores from the freshness rows
 *
 * It serves no number that feeds a decision. Every `headline` and `detail` is a plain sentence: no
 * table, file, env or model names, no raw error text (the error goes to the server log). A section
 * whose reader throws is served as 'unknown' in words, never dropped and never read as fine.
 *
 * Flag GRIDIRON_DATA_QUALITY, OFF by default; only '1' switches it on. Preview mode plays no part.
 * The client card is not drawn here (see the PR body); the route is its whole source.
 */
import { planAge } from './campaign/plan-age.js';

export const DATA_QUALITY_ENV = 'GRIDIRON_DATA_QUALITY';
export const DATA_QUALITY_OFF_REASON =
  'The data quality panel is off by default until its first read on the live database is checked. ' +
  `Set ${DATA_QUALITY_ENV}=1 to switch it on.`;

/** A sent app offer ESPN has not matched after this long is an orphan (ESPN serves ~3 days back). */
export const ORPHAN_SENT_HOURS = 72;
/** Days of number-health points the trend shows, today included. */
export const TREND_DAYS = 14;

/** Read per call, so a test or a run can flip it. */
export function dataQualityFlag(env = process.env) {
  return env?.[DATA_QUALITY_ENV] === '1' ? { enabled: true } : { enabled: false, reason: DATA_QUALITY_OFF_REASON };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------ freshness */

const STATUS_ORDER = { empty: 0, stale: 1, unknown: 2, fresh: 3 };
const STALE_DETAIL = {
  week: 'Missing rows for the current week.',
  season: 'Nothing for the season being played yet.',
  static: 'Not refreshed within its window.',
  fit: 'The model that reads it is answering on a fallback.',
};

function freshnessDetail(t) {
  if (t.status === 'fresh') return 'Current.';
  if (t.status === 'empty') return t.present === false ? 'Not built in this database yet.' : 'Holds no rows yet.';
  if (t.status === 'unknown') return 'Could not be checked, so it is not counted as current.';
  return STALE_DETAIL[t.grain] ?? 'Behind its current-data rule.';
}

/** tables: dataFreshness()'s rows. Statuses pass through untouched (B2). */
export function freshnessSection(tables) {
  const counts = { fresh: 0, stale: 0, empty: 0, unknown: 0 };
  for (const t of tables) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const sources = tables
    .map(t => ({ label: t.label, status: t.status, grain: t.grain ?? null, last_write: t.last_write ?? null, detail: freshnessDetail(t) }))
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.label.localeCompare(b.label));
  const behind = tables.length - counts.fresh;
  return {
    status: behind ? 'attention' : 'ok',
    headline: behind ? `${behind} of ${plural(tables.length, 'source')} behind` : `All ${plural(tables.length, 'source')} current`,
    counts, sources,
  };
}

/* ------------------------------------------------------------ offer orphans */

/** Sent app offers that no ESPN proposal has matched and nothing has settled. Parameterised read. */
export function readUnmatchedSent(database) {
  const cols = new Set(database.prepare('SELECT name FROM pragma_table_info(?)').all('trade_outcomes').map(c => c.name));
  if (!cols.has('sent_at') || !cols.has('matched_tx_id')) return [];
  return database.prepare(`SELECT league_id, season, sent_at FROM trade_outcomes
    WHERE source = ? AND sent_at IS NOT NULL AND matched_tx_id IS NULL AND status = ?`).all('app_proposed', 'proposed');
}

/** decided: loadDecidedOffers()'s return; sent: readUnmatchedSent()'s rows; now: ms. */
export function orphansSection({ decided, sent = [], now = Date.now() }) {
  const leagues = new Map();
  const L = id => {
    const k = Number(id);
    if (!leagues.has(k)) leagues.set(k, { league_id: k, answers_without_offer: 0, sent_not_found: 0, oldest_at: null });
    return leagues.get(k);
  };
  const older = (a, b) => (a == null || (b != null && b < a) ? b : a);
  for (const o of decided?.orphans ?? []) {
    const l = L(o.league_id);
    l.answers_without_offer += 1;
    l.oldest_at = older(l.oldest_at, o.decided_at ?? null);
  }
  const cutoff = now - ORPHAN_SENT_HOURS * 3_600_000;
  for (const s of sent) {
    const t = Date.parse(s.sent_at);
    if (!Number.isFinite(t) || t > cutoff) continue;
    const l = L(s.league_id);
    l.sent_not_found += 1;
    l.oldest_at = older(l.oldest_at, s.sent_at);
  }
  const list = [...leagues.values()].sort((a, b) => a.league_id - b.league_id).map(l => ({
    ...l,
    detail: [
      l.answers_without_offer ? `${plural(l.answers_without_offer, 'answer')} ESPN gave to an offer that was never collected` : null,
      l.sent_not_found ? `${plural(l.sent_not_found, 'offer')} you marked sent that ESPN has not shown after ${ORPHAN_SENT_HOURS} h` : null,
    ].filter(Boolean).join('; ') + '.',
  }));
  const total = list.reduce((s, l) => s + l.answers_without_offer + l.sent_not_found, 0);
  return {
    status: total ? 'attention' : 'ok',
    headline: total ? `${plural(total, 'offer')} not tied to a record` : 'Every offer is tied to a record',
    total, leagues: list,
  };
}

/* ------------------------------------------------------------ number-health trend */

const bad = p => p.broken + p.warn;

/** points: readNumberHealthTrend()'s rows (oldest first per league). */
export function trendSection(points) {
  const by = new Map();
  for (const p of points) {
    const k = Number(p.league_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p);
  }
  const leagues = [...by].sort(([a], [b]) => a - b).map(([league_id, ps]) => {
    ps.sort((a, b) => a.day.localeCompare(b.day));
    const first = ps[0];
    const last = ps.at(-1);
    const direction = ps.length < 2 ? 'too_new' : bad(last) > bad(first) ? 'worse' : bad(last) < bad(first) ? 'better' : 'flat';
    const since = ps.length < 2 ? 'one day of history so far' : `${bad(first)} problems ${ps.length} days back`;
    return {
      league_id, direction, latest: { day: last.day, broken: last.broken, warn: last.warn, ok: last.ok },
      points: ps.map(p => ({ day: p.day, broken: p.broken, warn: p.warn, ok: p.ok })),
      detail: `League ${league_id}: ${last.broken} broken and ${last.warn} to watch today, ${since}.`,
    };
  });
  const worse = leagues.filter(l => l.direction === 'worse').length;
  const broken = leagues.filter(l => l.latest.broken > 0).length;
  return {
    status: leagues.length === 0 ? 'ok' : (worse || broken) ? 'attention' : 'ok',
    headline: leagues.length === 0 ? 'No history yet'
      : worse ? `${plural(worse, 'league')} getting worse`
      : broken ? `${plural(broken, 'league')} with a broken number` : 'Steady',
    days: TREND_DAYS, leagues,
  };
}

/* ------------------------------------------------------------ last-good fallbacks */

/**
 * plans: loadPlans()'s return; tables: dataFreshness()'s rows (for fit stores); now: ms.
 * Each item: { kind, league_id?, label?, detail }.
 */
export function fallbacksSection({ plans, tables = [], now = Date.now() }) {
  const items = [];
  if (plans?.status !== 'ok') {
    items.push({ kind: 'no_plans', detail: plans?.status === 'unknown'
      ? 'No plan has been run yet, so there is no last good plan to fall back on.'
      : 'The plans could not be read, so every plan is hidden.' });
  } else {
    const entries = plans.entries ?? [];
    for (const e of entries) {
      const league_id = Number(e?.league);
      if (typeof e?.error === 'string') {
        items.push({ kind: 'planner_failed', league_id, detail: `League ${league_id}: the last planner run failed, so its plans are hidden until the next run.` });
        continue;
      }
      const age = planAge(e, { entries, now });
      if (age.status === 'out_of_date') {
        items.push({ kind: 'plan_out_of_date', league_id, detail: age.age_hours == null
          ? `League ${league_id}: showing a plan kept from an older run whose age is unknown, so it is hidden.`
          : `League ${league_id}: the last good plan is ${age.age_hours} h old (over ${age.max_hours} h), so it is hidden until the next run.` });
      } else if (typeof e?.planned_at === 'string' && typeof plans.as_of === 'string' && Date.parse(e.planned_at) < Date.parse(plans.as_of)) {
        items.push({ kind: 'plan_kept', league_id, detail: `League ${league_id}: showing its last good plan from ${age.age_hours} h ago; the latest run did not replan it.` });
      }
      if (e?.brain_report?.fell_back_to === 'balanced') {
        items.push({ kind: 'balanced_fallback', league_id, detail: `League ${league_id}: risk mode fell back to Balanced because the brain check is failing or out of date.` });
      }
    }
  }
  for (const t of tables) {
    if (t.grain === 'fit' && t.status !== 'fresh') {
      items.push({ kind: 'model_fallback', label: t.label, detail: `${t.label}: no current fit, so the model that reads it answers on its fallback.` });
    }
  }
  items.sort((a, b) => (a.league_id ?? 1e9) - (b.league_id ?? 1e9) || a.kind.localeCompare(b.kind));
  const hidden = items.filter(i => ['no_plans', 'planner_failed', 'plan_out_of_date'].includes(i.kind)).length;
  return {
    status: items.length ? 'attention' : 'ok',
    headline: !items.length ? 'Nothing is running on a fallback'
      : hidden ? `${plural(hidden, 'plan')} hidden, ${plural(items.length - hidden, 'other fallback')}`
      : `${plural(items.length, 'fallback')} in use`,
    items,
  };
}

/* ------------------------------------------------------------ the report */

export const SECTIONS = Object.freeze(['freshness', 'offer_orphans', 'number_health_trend', 'fallbacks']);

/**
 * readers: { [section]: () => section }. A reader that throws becomes an 'unknown' section in
 * words and its error goes to `log` (the server log), never into the response.
 */
export function composeReport(readers, { now = Date.now(), log = m => console.warn(m) } = {}) {
  const sections = {};
  for (const name of SECTIONS) {
    try {
      sections[name] = readers[name]();
    } catch (e) {
      log(`[data-quality] ${name} could not be read: ${e?.stack ?? e}`);
      sections[name] = { status: 'unknown', headline: 'Could not be read', detail: 'This part of the panel could not be read, so it is not counted as healthy.' };
    }
  }
  const statuses = SECTIONS.map(n => sections[n].status);
  const overall = statuses.includes('unknown') ? 'unknown' : statuses.includes('attention') ? 'attention' : 'ok';
  return { enabled: true, as_of: new Date(now).toISOString(), overall, sections };
}

/**
 * The whole report from the live producers. The route supplies what only it can: the current
 * season and week (currentNflWeek), the loaded plans file, and the producers themselves, passed
 * in so this file opens no database on import.
 */
export function readDataQuality({ database, currentSeason, currentWeek, plans, now = Date.now(), log,
  dataFreshness, registry, loadDecidedOffers, readNumberHealthTrend }) {
  let tables = null;
  const freshnessRows = () => (tables ??= dataFreshness({ registry, currentSeason, currentWeek, database }));
  return composeReport({
    freshness: () => freshnessSection(freshnessRows()),
    offer_orphans: () => orphansSection({ decided: loadDecidedOffers(database), sent: readUnmatchedSent(database), now }),
    number_health_trend: () => trendSection(readNumberHealthTrend(database, { days: TREND_DAYS, now })),
    fallbacks: () => fallbacksSection({ plans, tables: freshnessRows(), now }),
  }, { now, log });
}
