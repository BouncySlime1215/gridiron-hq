/**
 * RADAR-WIRE (ONE-PLAN s5 night 8): "why now" on every flip row, and the RADAR-GRADE ledger.
 *
 * Each flip row gets one `why_now` label, from the first source that has something to say:
 *   1. a validated O1 radar cell (adapter.opportunityOf, PR #377) with its n and CI;
 *   2. FantasyCalc's own 30-day move for this league's format (`dynasty_values`, adapter.fcTrendOf) when it
 *      is at least TREND_MIN_PCT of the value 30 days ago. Until `dynasty_value_history` holds
 *      TREND_MIN_DAYS capture days the trend is a watch label only (ONE-PLAN 4b row 10);
 *   3. a watch-only radar event (below the #377 gate): 'watch', never 'act'.
 * A negative news signal inside NEWS_WINDOW_H (ruled out / doubtful, or a role cut) overrides
 * the status to 'check_first': the prices behind the spread predate the news. When the news
 * extractor has written nothing in NEWS_WINDOW_H the label says "news dead" (ONE-PLAN D2) and
 * news never raises check_first.
 *
 * The label moves no number: flag off vs on differs only in `why_now` paths
 * (test/radar-wire.test.js). Flag GRIDIRON_RADAR_WIRE: only =1 turns it on. Unset or anything
 * else is off, preview mode included (integration-9 policy: no unit switches on via
 * GRIDIRON_PREVIEW_UNCONFIRMED without its own flag).
 *
 * RADAR-GRADE: one ledger row per served flip row. A row with a direction predicts the sign of
 * the player's FantasyCalc value over GRADE_AFTER_DAYS; gradeLedger grades it once, against the
 * share of that week's ledger players that moved the same way. gateSummary is the weekly gate
 * (the #402 style): 90% CI clustered by week, lower bound above 0 on >= GRADE_MIN_ROWS rows.
 */
export const RADAR_WIRE_ENV = 'GRIDIRON_RADAR_WIRE';
export const TREND_MIN_PCT = 0.10;
export const TREND_MIN_DAYS = 7;
export const NEWS_WINDOW_H = 48;
export const GRADE_AFTER_DAYS = 14;
/** #405 finding 4: a row first reached later than this is not a 14-day grade; it is closed ungraded. */
export const GRADE_MAX_DAYS = 21;
export const GRADE_MIN_ROWS = 20;
const DAY = 24 * 3600e3;
const WEEK = 7 * DAY;

/** 'on' | 'off'. Only its own flag turns it on; preview mode never does. */
export function radarWireFlag(env = process.env) {
  return env[RADAR_WIRE_ENV] === '1' ? 'on' : 'off';
}

const signed = (x, d = 0) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const fin = Number.isFinite;

/** The 30-day move as a share of the value 30 days ago (aggregates.js#trendPct's rule), or null. */
export function trendShare(trend) {
  if (!trend || !fin(trend.value) || !fin(trend.trend30)) return null;
  const prior = trend.value - trend.trend30;
  return prior > 0 ? trend.trend30 / prior : null;
}

/** A news row that contradicts buying now: ruled out / doubtful / on IR, or a role cut. */
function contradicts(s) {
  if (s?.signal_type === 'role') return fin(s.role_delta) && s.role_delta < 0;
  if (s?.signal_type === 'availability') return (fin(s.unavailable_probability) && s.unavailable_probability >= 0.5)
    || /^(out|doubtful|ir|injured_reserve|suspended)$/i.test(String(s.status ?? ''));
  return false;
}

/**
 * One flip row's label. radar: 'on' | 'off' | 'not_merged'; opp: opportunityOf's row or null;
 * trend: { value, trend30 } or null; historyDays: capture days in dynasty_value_history;
 * news: this player's signals (any age; filtered to NEWS_WINDOW_H here); newsAlive: any signal in the window.
 */
export function whyNowOf({ radar = 'not_merged', opp = null, trend = null, historyDays = 0, news = [], newsAlive = false, now = Date.now() } = {}) {
  const sources = { radar: radar === 'on' ? 'none' : radar, trend: 'missing', news: newsAlive ? 'quiet' : 'dead' };
  const parts = [];
  let out = { status: 'none', kind: 'none', direction: null };

  const events = radar === 'on' && Array.isArray(opp?.opportunity_events) ? opp.opportunity_events : [];
  const passed = events.filter(e => e.passes_gate && fin(e.effect));
  const share = trendShare(trend);
  if (share != null) sources.trend = Math.abs(share) < TREND_MIN_PCT ? 'small' : historyDays >= TREND_MIN_DAYS ? 'ok' : 'label_only';

  if (passed.length) {
    sources.radar = 'validated';
    const lead = [...passed].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))[0];
    const net = passed.reduce((s, e) => s + e.effect, 0);
    out = { status: 'act', kind: 'validated_cell', direction: net >= 0 ? 'up' : 'down', n: lead.n,
      ...(Array.isArray(lead.ci) ? { ci: lead.ci } : {}) };
    parts.push(`${lead.label}: ${signed(lead.effect, 1)} ${lead.unit} (n ${lead.n}${Array.isArray(lead.ci) ? `, 90% CI ${signed(lead.ci[0], 1)} to ${signed(lead.ci[1], 1)}` : ''}).`);
  } else if (sources.trend === 'ok' || sources.trend === 'label_only') {
    out = { status: sources.trend === 'ok' ? 'act' : 'watch', kind: 'fc_trend', direction: share >= 0 ? 'up' : 'down' };
    parts.push(`FantasyCalc value ${signed(share * 100)}% over 30 days`
      + (sources.trend === 'ok' ? '.' : ` (watch: ${historyDays} of ${TREND_MIN_DAYS} days of value history).`));
  } else if (events.length) {
    sources.radar = 'watch';
    const e = events[0];
    out = { status: 'watch', kind: 'watch_cell', direction: null, n: e.n ?? 0 };
    parts.push(`${e.label}: below the radar's bar (n ${e.n ?? 0}), a watch flag only.`);
  } else {
    parts.push('No why-now signal this week.');
  }

  const recent = (Array.isArray(news) ? news : []).filter(s => now - Date.parse(s.published_at) <= NEWS_WINDOW_H * 3600e3);
  const bad = recent.filter(contradicts);
  if (newsAlive && bad.length) {
    sources.news = 'contradiction';
    out = { ...out, status: 'check_first', direction: 'down', check_first: true };
    const s = bad[0];
    parts.push(`Check first: news in the last ${NEWS_WINDOW_H} h says ${s.signal_type === 'role' ? 'his role shrank' : String(s.status ?? 'he may miss time')}; the prices predate it.`);
  }
  if (!newsAlive) parts.push(`Not checked: news dead (no signal in ${NEWS_WINDOW_H} h).`);
  if (radar === 'not_merged') parts.push('O1 radar not on this build.');
  else if (radar === 'off') parts.push('O1 radar off.');
  return { ...out, text: parts.join(' '), sources };
}

/**
 * Label every flip row of a produced entry (in place, before the contract check) and return the
 * RADAR-GRADE ledger rows. adapter reads: opportunityOf (absent until #377), fcTrendOf, fcHistoryDays,
 * newsOf, newsAlive; any read that is missing counts as no data, and the label says which.
 */
export function applyWhyNow(entry, adapter, { as_of, flag = 'on' } = {}) {
  const rows = entry?.flip_map?.status === 'ok' && Array.isArray(entry.flip_map.value) ? entry.flip_map.value : [];
  const now = Date.parse(as_of);
  const radar = typeof adapter.opportunityOf !== 'function' ? 'not_merged' : 'on';
  const historyDays = adapter.fcHistoryDays?.() ?? 0;
  const newsAlive = !!adapter.newsAlive?.(now);
  const ledger = [];
  const counts = { act: 0, watch: 0, check_first: 0, none: 0 };
  for (const r of rows) {
    const opp = radar === 'on' ? adapter.opportunityOf(r.player) : null;
    const trend = adapter.fcTrendOf?.(r.player) ?? null;
    const w = whyNowOf({ radar, opp, trend, historyDays,
      news: adapter.newsOf?.(r.player, now) ?? [], newsAlive, now });
    r.why_now = w;
    counts[w.status]++;
    const row = { type: 'serve', as_of, league: String(entry.league), player: r.player, buy_from: r.buy_from, sell_to: r.sell_to,
      status: w.status, kind: w.kind, direction: w.direction, value_at: fin(trend?.value) ? trend.value : null,
      format_key: adapter.fcFormatKey ?? null,
      grade_after: new Date(now + GRADE_AFTER_DAYS * DAY).toISOString() };
    ledger.push({ ...row, key: serveKeyOf(row) });
  }
  if (entry._run) entry._run.inputs = { ...entry._run.inputs,
    why_now: { flag, radar, history_days: historyDays, news: newsAlive ? 'alive' : 'dead', rows: rows.length, ...counts } };
  return ledger;
}

/** ISO week of a timestamp, 'YYYY-Www' (UTC). */
export function isoWeek(iso) {
  const d = new Date(Date.parse(iso));
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
/**
 * #405 finding 3: one serve row per flip per ISO week. The producer runs many times a day; keying
 * on as_of made N identical serve rows (and N grades), so GRADE_MIN_ROWS was met by a few flips
 * repeated and the base rate was weighted by run frequency. Old rows (no `key`) keep their key.
 */
export const serveKeyOf = r => `${isoWeek(r.as_of)}|${r.league}|${r.player}|${r.buy_from}|${r.sell_to}|${r.direction ?? 'none'}`;
const keyOf = r => r.key ?? `${r.as_of}|${r.league}|${r.player}|${r.buy_from}|${r.sell_to}`;
const weekOf = iso => Math.floor(Date.parse(iso) / WEEK);

/** Serve rows whose (ISO week, league, player, buy_from, sell_to, direction) is not in `rows` yet (nor earlier in `served`). */
export function newServeRows(rows, served) {
  const seen = new Set(rows.filter(r => r.type !== 'grade').map(keyOf));
  const out = [];
  for (const r of served) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
const moveOf = (at, then) => (then > at ? 'up' : then < at ? 'down' : 'flat');

/**
 * Grade every serve row at least GRADE_AFTER_DAYS old that has no grade row yet.
 * valueNow(player, row) -> today's FantasyCalc value in the row's league format (row.format_key).
 * Returns the new grade rows and the gate summary
 * over every grade row (old and new).
 */
export function gradeLedger(rows, { valueNow, now = Date.now() } = {}) {
  const done = new Set(rows.filter(r => r.type === 'grade').map(r => r.key));
  const age = r => (now - Date.parse(r.as_of)) / DAY;
  const open = rows.filter(r => r.type !== 'grade' && !done.has(keyOf(r)) && fin(r.value_at) && age(r) >= GRADE_AFTER_DAYS);
  // Past GRADE_MAX_DAYS the horizon is no longer ~14 days (the producer did not run for a while):
  // the row is closed with hit null, so it never counts toward the gate.
  const late = open.filter(r => age(r) > GRADE_MAX_DAYS).map(r => ({ type: 'grade', key: keyOf(r), as_of: r.as_of,
    graded_at: new Date(now).toISOString(), graded_after_days: +age(r).toFixed(2), week: weekOf(r.as_of), league: r.league,
    player: r.player, direction: r.direction ?? null, move: null, hit: null, base: null,
    skipped: `first reached at ${age(r).toFixed(1)} days, past the ${GRADE_MAX_DAYS}-day horizon` }));
  const due = open.filter(r => age(r) <= GRADE_MAX_DAYS && fin(valueNow(r.player, r)));
  const moved = due.map(r => ({ r, move: moveOf(r.value_at, valueNow(r.player, r)) }));
  const byWeek = new Map();
  for (const m of moved) {
    const w = weekOf(m.r.as_of);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(m.move);
  }
  const graded = moved.map(({ r, move }) => {
    const peers = byWeek.get(weekOf(r.as_of));
    const base = r.direction ? peers.filter(x => x === r.direction).length / peers.length : null;
    return { type: 'grade', key: keyOf(r), as_of: r.as_of, graded_at: new Date(now).toISOString(),
      graded_after_days: +age(r).toFixed(2), week: weekOf(r.as_of),
      league: r.league, player: r.player, direction: r.direction ?? null, move,
      hit: r.direction ? move === r.direction : null, base };
  });
  return { graded: [...graded, ...late], summary: gateSummary([...rows.filter(r => r.type === 'grade'), ...graded]) };
}

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

/** The weekly gate over grade rows: gain = mean(hit - base), 90% CI clustered by week. */
export function gateSummary(gradeRows, { reps = 1000, seed = 20261001 } = {}) {
  const rows = gradeRows.filter(r => r.direction && typeof r.hit === 'boolean' && fin(r.base));
  const n = rows.length;
  if (n < GRADE_MIN_ROWS) return { status: 'not_enough_data', n, min_rows: GRADE_MIN_ROWS };
  const weeks = new Map();
  for (const r of rows) {
    if (!weeks.has(r.week)) weeks.set(r.week, []);
    weeks.get(r.week).push((r.hit ? 1 : 0) - r.base);
  }
  const clusters = [...weeks.values()];
  const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
  const gain = mean(rows.map(r => (r.hit ? 1 : 0) - r.base));
  const next = rng(seed);
  const draws = [];
  for (let i = 0; i < reps; i++) {
    const pick = [];
    for (let j = 0; j < clusters.length; j++) pick.push(...clusters[Math.floor(next() * clusters.length)]);
    draws.push(mean(pick));
  }
  draws.sort((a, b) => a - b);
  const ci = [draws[Math.floor(0.05 * reps)], draws[Math.ceil(0.95 * reps) - 1]];
  const status = ci[0] > 0 ? 'passing' : ci[1] < 0 ? 'failing' : 'inconclusive';
  return { status, n, weeks: clusters.length, gain, ci, hit_rate: mean(rows.map(r => (r.hit ? 1 : 0))), base: mean(rows.map(r => r.base)) };
}
