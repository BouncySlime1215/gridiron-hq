/**
 * E-LATENCY (ONE-PLAN batch D item 7): how long each manager takes to answer a
 * trade offer, and a "no reply after N h" follow-up / withdraw hint.
 *
 * DESCRIPTIVE ONLY. Nothing here is a P(yes) input and nothing here may become
 * one: `p_yes_input: false` rides on every table. Whether reply time signals
 * the answer is ONE-PLAN 3b row 17, untested; this unit does not test it.
 *
 * ONE PAIRING. Reply times come from decided-offers.js (the one producer of
 * "which answer belongs to which offer"): an offer's `proposed_at` (the app's
 * `sent_at` when it has one) to its `decided_at`. Silent offers (withdrawn,
 * expired, unanswered) come from the same pairing's `silent` list and are
 * counted beside the answers, never mixed into the reply-time quantiles.
 *
 * THE HINT. N for a manager is the p90 of their reply hours when he has at least
 * MIN_N answers, else his league's pooled p90, else no basis. A pending offer
 * waiting < N is "wait", >= N "follow_up", >= 2N "withdraw_or_resend" (the 2x
 * multiplier is a guess, labelled so). The hint is shadow (not actionable)
 * until gradeHint() passes HINT_BAR.
 *
 * THE GRADE (pre-registered 2026-09-25, before any number was read): walk the
 * answered offers in proposal-time order; each one gets the N computed from
 * the answers DECIDED BEFORE it was proposed (no look-ahead). It is "late" if
 * its reply took longer than N: the hint would have told Nick to chase or
 * withdraw an offer that was going to be answered. Pass when at least 30
 * offers are graded and the late rate is <= 0.15. Fail otherwise; below 30 it
 * reads "n=k of 30", not a pass.
 *
 * Served (route /api/reply-latency) only with GRIDIRON_REPLY_LATENCY=1.
 */
import { loadDecidedOffers } from './decided-offers.js';

export const REPLY_LATENCY_FLAG = 'GRIDIRON_REPLY_LATENCY';
export const MIN_N = 5;
export const WITHDRAW_MULTIPLIER = 2;
export const HINT_BAR = Object.freeze({ min_graded: 30, max_late_rate: 0.15 });

const H = 3_600_000;
const t = s => (s == null ? NaN : Date.parse(s));
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Linear-interpolated quantile of a numeric list; null when empty. */
export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Reply hours of one decided offer, or null when its times cannot be read. */
function replyHours(o) {
  const start = t(o.sent_at ?? o.proposed_at);
  const end = t(o.decided_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / H;
}

function summary(hours) {
  return {
    n_answered: hours.length,
    median_h: round(quantile(hours, 0.5)),
    p75_h: round(quantile(hours, 0.75)),
    p90_h: round(quantile(hours, 0.9)),
    within_24h: hours.length ? round(hours.filter(h => h <= 24).length / hours.length, 3) : null,
  };
}

/**
 * The table: per league, one row per receiving manager (by team id) and a
 * pooled row. `offers` and `silent` are decided-offers.js output.
 */
export function replyLatencyTable({ offers = [], silent = [] } = {}) {
  const skipped = { bad_times: 0, no_counterparty: 0 };
  const leagues = new Map();
  const bucket = (lid, team) => {
    const L = leagues.get(String(lid)) ?? leagues.set(String(lid), { hours: [], silent: { expired: 0, withdrawn: 0, unanswered: 0 }, managers: new Map() }).get(String(lid));
    if (team == null) return { L, M: null };
    const M = L.managers.get(String(team)) ?? L.managers.set(String(team), { hours: [], silent: { expired: 0, withdrawn: 0, unanswered: 0 } }).get(String(team));
    return { L, M };
  };
  for (const o of offers) {
    const h = replyHours(o);
    if (h == null) { skipped.bad_times += 1; continue; }
    if (o.counterparty_team_id == null) { skipped.no_counterparty += 1; continue; }
    const { L, M } = bucket(o.league_id, o.counterparty_team_id);
    L.hours.push(h); M.hours.push(h);
  }
  for (const s of silent) {
    const { L, M } = bucket(s.league_id, s.counterparty_team_id);
    L.silent[s.excluded] += 1;
    if (M) M.silent[s.excluded] += 1;
  }

  const out = {};
  for (const [lid, L] of [...leagues].sort(([a], [b]) => Number(a) - Number(b))) {
    const pooled = { ...summary(L.hours), n_expired: L.silent.expired, n_withdrawn: L.silent.withdrawn, n_unanswered: L.silent.unanswered };
    const managers = {};
    for (const [team, M] of [...L.managers].sort(([a], [b]) => Number(a) - Number(b))) {
      const own = summary(M.hours);
      const [basis, thr] = own.n_answered >= MIN_N ? ['manager', own.p90_h]
        : pooled.n_answered >= MIN_N ? ['league', pooled.p90_h] : ['none', null];
      managers[team] = { ...own, n_expired: M.silent.expired, n_withdrawn: M.silent.withdrawn, n_unanswered: M.silent.unanswered,
        threshold_h: thr, threshold_basis: basis };
    }
    out[lid] = { pooled, managers };
  }
  return { leagues: out, skipped, min_n: MIN_N, p_yes_input: false };
}

/** N for (league, team) from a table, with its basis. */
function thresholdFor(table, lid, team) {
  const L = table.leagues[String(lid)];
  const M = L?.managers[String(team)];
  if (M) return { threshold_h: M.threshold_h, basis: M.threshold_basis };
  if (L && L.pooled.n_answered >= MIN_N) return { threshold_h: L.pooled.p90_h, basis: 'league' };
  return { threshold_h: null, basis: 'none' };
}

/**
 * One hint per pending offer ({league_id, counterparty_team_id, sent_at |
 * proposed_at}). `grade` is gradeHint()'s result; without a pass the hint is
 * shadow.
 */
export function followUpHints(pending, table, { now = new Date().toISOString(), grade = null } = {}) {
  const nowMs = t(now);
  const live = grade?.pass === true;
  return pending.map(p => {
    const since = t(p.sent_at ?? p.proposed_at);
    const waited = Number.isFinite(since) ? (nowMs - since) / H : null;
    const { threshold_h, basis } = thresholdFor(table, p.league_id, p.counterparty_team_id);
    let hint;
    let reason;
    if (waited == null) { hint = 'no_basis'; reason = 'no send time on record'; }
    else if (threshold_h == null) { hint = 'no_basis'; reason = `no answered offers to time: fewer than ${MIN_N} in this league`; }
    else if (waited >= WITHDRAW_MULTIPLIER * threshold_h) { hint = 'withdraw_or_resend'; reason = `no reply after ${round(waited, 1)} h, over ${WITHDRAW_MULTIPLIER}x the ${round(threshold_h, 1)} h this manager answers 90% of offers within (the ${WITHDRAW_MULTIPLIER}x is a guess)`; }
    else if (waited >= threshold_h) { hint = 'follow_up'; reason = `no reply after ${round(waited, 1)} h; this manager answers 90% of offers within ${round(threshold_h, 1)} h`; }
    else { hint = 'wait'; reason = `${round(waited, 1)} h so far; 90% of this manager's answers come within ${round(threshold_h, 1)} h`; }
    return { ...p, hours_waiting: round(waited), threshold_h, threshold_basis: basis, hint, reason, shadow: !live, graded: live };
  });
}

/** The pre-registered forward grade of the hint (see the header). */
export function gradeHint(offers) {
  const rows = offers.map(o => ({ o, h: replyHours(o), start: t(o.sent_at ?? o.proposed_at), end: t(o.decided_at) }))
    .filter(r => r.h != null && r.o.counterparty_team_id != null)
    .sort((a, b) => a.start - b.start);
  let graded = 0;
  let late = 0;
  const byBasis = { manager: 0, league: 0 };
  for (const r of rows) {
    const before = rows.filter(x => x.end < r.start && String(x.o.league_id) === String(r.o.league_id));
    const own = before.filter(x => String(x.o.counterparty_team_id) === String(r.o.counterparty_team_id)).map(x => x.h);
    const [basis, thr] = own.length >= MIN_N ? ['manager', quantile(own, 0.9)]
      : before.length >= MIN_N ? ['league', quantile(before.map(x => x.h), 0.9)] : [null, null];
    if (thr == null) continue;
    graded += 1; byBasis[basis] += 1;
    if (r.h > thr) late += 1;
  }
  const lateRate = graded ? late / graded : null;
  const enough = graded >= HINT_BAR.min_graded;
  const pass = enough && lateRate <= HINT_BAR.max_late_rate;
  const verdict = !enough ? `not graded: n=${graded} of ${HINT_BAR.min_graded}`
    : pass ? `pass: ${late} of ${graded} late (${round(lateRate, 3)} <= ${HINT_BAR.max_late_rate})`
      : `fail: ${late} of ${graded} late (${round(lateRate, 3)} > ${HINT_BAR.max_late_rate})`;
  return { n_graded: graded, n_late: late, late_rate: round(lateRate, 3), by_basis: byBasis, bar: HINT_BAR, pass, verdict };
}

/** Parameterised read of the app's sent offers still waiting on an answer. */
function pendingAppOffers(database, leagueId) {
  const cols = new Set(database.prepare('SELECT name FROM pragma_table_info(?)').all('trade_outcomes').map(c => c.name));
  if (!cols.has('sent_at')) return [];
  const matched = cols.has('matched_tx_id') ? 'matched_tx_id' : 'NULL AS matched_tx_id';
  const where = leagueId == null ? '' : ' AND league_id = ?';
  return database.prepare(`SELECT league_id, season, proposer_team_id, counterparty_team_id, proposed_at, sent_at, idea_id, ${matched}
    FROM trade_outcomes WHERE source = 'app_proposed' AND sent_at IS NOT NULL AND status = 'proposed' AND resolved_at IS NULL${where}`)
    .all(...(leagueId == null ? [] : [Number(leagueId)]));
}

/**
 * Read the db: the table, the grade, and a hint per pending offer (the app's
 * sent offers, then ESPN offers still unanswered that are not the ESPN copy of
 * one of them).
 */
export function loadReplyLatency(database, { leagueId = null, season = null, now = new Date().toISOString() } = {}) {
  const built = loadDecidedOffers(database, { season });
  const inLeague = x => leagueId == null || String(x.league_id) === String(leagueId);
  const offers = built.offers.filter(inLeague);
  const silent = (built.silent ?? []).filter(inLeague);
  const table = replyLatencyTable({ offers, silent });
  const grade = gradeHint(offers);

  const app = built.sources.includes('trade_outcomes')
    ? pendingAppOffers(database, leagueId).filter(r => season == null || Number(r.season) === Number(season)) : [];
  const claimed = new Set(app.filter(a => a.matched_tx_id != null).map(a => `${a.league_id}:${a.season}:${a.matched_tx_id}`));
  const pending = [
    ...app.map(a => ({ source: 'app_proposed', offer_id: a.idea_id != null ? `app:${a.idea_id}` : null, league_id: a.league_id,
      proposer_team_id: a.proposer_team_id, counterparty_team_id: a.counterparty_team_id, sent_at: a.sent_at })),
    ...silent.filter(s => s.excluded === 'unanswered' && s.proposed_at && !claimed.has(`${s.league_id}:${s.season}:${s.espn_tx_id}`))
      .map(s => ({ source: 'espn', offer_id: s.espn_tx_id, league_id: s.league_id,
        proposer_team_id: s.proposer_team_id, counterparty_team_id: s.counterparty_team_id, proposed_at: s.proposed_at })),
  ];
  return { table, grade, pending: followUpHints(pending, table, { now, grade }), sources: built.sources, reason: built.reason };
}

/*
 * REPLY-CLOCK: when to send a league-mate an offer. Extends the table above
 * (same pairing, same reply hours, same MIN_N); nothing here is a P(yes)
 * input either.
 *
 * Per receiving manager (never Nick's own team): the median reply hours, the
 * reply rate (answered / (answered + expired + unanswered); an offer Nick
 * withdrew is his act, not theirs, so it is left out of the rate), and the best
 * send window: the answered offers' SEND times grouped by US Eastern weekday x
 * part of day (night 0-6, morning 6-12, afternoon 12-18, evening 18-24); the
 * window with the most answers wins, ties to the faster median, then the
 * earlier week slot. `guess` is true below MIN_N answers or when the window
 * rests on one answer; the text then ends "(guess)". With no answers at all
 * the text says so and names no window.
 *
 * Flag GRIDIRON_REPLY_CLOCK: unset/0 off; 'shadow' computed and served only on
 * GET /api/reply-latency/clock (marked shadow, drawn nowhere); '1' also drawn
 * as one "send when" line on War Room trade cards and in the Numbers & People
 * people lane. Served plan numbers never change: the line rides beside them.
 */
export const REPLY_CLOCK_FLAG = 'GRIDIRON_REPLY_CLOCK';
export const CLOCK_TZ = 'America/New_York';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PARTS = [['night', 0], ['morning', 6], ['afternoon', 12], ['evening', 18]];

/** 'off' | 'shadow' | 'on'. */
export function replyClockMode(env = process.env) {
  const v = env[REPLY_CLOCK_FLAG];
  return v === '1' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
}

const slotFmt = new Intl.DateTimeFormat('en-US', { timeZone: CLOCK_TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
/** The US Eastern send slot of a timestamp, or null. */
export function sendSlot(iso) {
  const ms = t(iso);
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(slotFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const dow = DAYS.indexOf(p.weekday);
  const hour = Number(p.hour) % 24;
  const pi = PARTS.reduce((k, [, from], i) => (hour >= from ? i : k), 0);
  return { day: DAYS[dow], part: PARTS[pi][0], key: dow * 4 + pi };
}

/** "within the hour", "~3 h", "~2 days". */
export function hoursText(h) {
  if (h == null) return null;
  if (h < 1) return 'within the hour';
  if (h < 36) return `within ~${Math.round(h)}\u00a0h`; // no break between the number and its unit
  return `within ~${Math.round(h / 24)}\u00a0days`;
}

function clockRow(hoursWithSlots, silent) {
  const hours = hoursWithSlots.map(x => x.h);
  const n = hours.length;
  const noReply = silent.expired + silent.unanswered;
  const asked = n + noReply;
  const median = quantile(hours, 0.5);
  const cells = new Map();
  for (const x of hoursWithSlots) {
    if (!x.slot) continue;
    const c = cells.get(x.slot.key) ?? cells.set(x.slot.key, { ...x.slot, hours: [] }).get(x.slot.key);
    c.hours.push(x.h);
  }
  const best = [...cells.values()].map(c => ({ ...c, n: c.hours.length, median_h: quantile(c.hours, 0.5) }))
    .sort((a, b) => b.n - a.n || a.median_h - b.median_h || a.key - b.key)[0] ?? null;
  const window = best ? { day: best.day, part: best.part, n: best.n, median_h: round(best.median_h) } : null;
  const guess = n < MIN_N || (window?.n ?? 0) < 2;
  const rate = asked ? `answers ${n} of ${asked}` : null;
  const text = !n
    ? (noReply ? `Send when: no reply times yet (0 of ${noReply} ${noReply === 1 ? 'offer' : 'offers'} answered)` : 'Send when: no offers to time yet')
    : `Best time to send: ${window ? `${window.day} ${window.part}` : 'any time'} (replies ${hoursText(median)})${rate ? ` · ${rate}` : ''}${guess ? ' (guess)' : ''}`;
  return {
    n_answered: n, n_no_reply: noReply, n_withdrawn: silent.withdrawn,
    median_h: round(median), reply_rate: asked ? round(n / asked, 3) : null, window, guess, text,
  };
}

/**
 * The clock: per league, one row per receiving manager except `me` (a map
 * league id -> Nick's team id). `offers` and `silent` are decided-offers.js output.
 */
export function replyClock({ offers = [], silent = [] } = {}, { me = {} } = {}) {
  const leagues = new Map();
  const mgr = (lid, team) => {
    if (team == null || String(me[String(lid)] ?? '') === String(team)) return null;
    const L = leagues.get(String(lid)) ?? leagues.set(String(lid), new Map()).get(String(lid));
    return L.get(String(team)) ?? L.set(String(team), { answered: [], silent: { expired: 0, withdrawn: 0, unanswered: 0 } }).get(String(team));
  };
  for (const o of offers) {
    const h = replyHours(o);
    const M = h == null ? null : mgr(o.league_id, o.counterparty_team_id);
    if (M) M.answered.push({ h, slot: sendSlot(o.sent_at ?? o.proposed_at) });
  }
  for (const s of silent) {
    const M = mgr(s.league_id, s.counterparty_team_id);
    if (M && s.excluded in M.silent) M.silent[s.excluded] += 1;
  }
  const out = {};
  for (const [lid, L] of [...leagues].sort(([a], [b]) => Number(a) - Number(b))) {
    out[lid] = {};
    for (const [team, M] of [...L].sort(([a], [b]) => Number(a) - Number(b))) out[lid][team] = clockRow(M.answered, M.silent);
  }
  return { leagues: out, min_n: MIN_N, tz: CLOCK_TZ, p_yes_input: false };
}

/** Read the db: the clock for one league (or all), Nick's team left out. */
export function loadReplyClock(database, { leagueId = null, season = null } = {}) {
  const built = loadDecidedOffers(database, { season });
  const inLeague = x => leagueId == null || String(x.league_id) === String(leagueId);
  const me = Object.fromEntries(database.prepare('SELECT id, my_team_id FROM leagues').all()
    .filter(r => r.my_team_id != null).map(r => [String(r.id), String(r.my_team_id)]));
  const clock = replyClock({ offers: built.offers.filter(inLeague), silent: (built.silent ?? []).filter(inLeague) }, { me });
  return { ...clock, sources: built.sources, reason: built.reason };
}

/**
 * The "send when" lines for one league, keyed by team id, ready to draw; null
 * unless the flag is '1' (so off and shadow change no served payload). Never
 * throws: a failed read draws nothing.
 */
export function sendWhenLines(database, leagueId, env = process.env) {
  if (replyClockMode(env) !== 'on' || leagueId == null) return null;
  try {
    const rows = loadReplyClock(database, { leagueId }).leagues[String(leagueId)] ?? {};
    return Object.fromEntries(Object.entries(rows).map(([team, r]) => [team, { text: r.text, guess: r.guess, n: r.n_answered }]));
  } catch (e) {
    console.warn(`[reply-clock] league ${leagueId}: ${String(e?.message ?? e).slice(0, 200)}`);
    return null;
  }
}
