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
