/**
 * REP-01: offer fatigue and the reputation budget.
 *
 * One question, asked before any offer goes out: should this app send THIS
 * offer to THIS manager NOW? The answer is `allow`, `deny` or `delay` (with the
 * time to retry), always with a reason in words the Coach can repeat.
 *
 * `offerGate` is pure: it takes the offer history as data and `now` as an
 * argument, so the campaign producer and the trade finder get the same answer
 * for the same inputs and a test can pin every branch. `offerGateFor` is the
 * one reader that fills those inputs from trade_outcomes + manager_profiles.
 * An app_proposed row with no sent_at is a suggestion Nick never sent, so it is
 * not an offer and never counts. The finder hook is behind GRIDIRON_REP_GATE
 * (offer-reputation-flag.js).
 *
 * What it counts, per manager:
 *   - offers sent in the last 7 days (fatigue). In the league reader this is
 *     THE one fatigue counter, FIX-07's sentThisWeek (scripts/campaign/league-adapter.mjs:
 *     ESPN's own proposals + trade_outcomes WHERE sent_at IS NOT NULL), so the
 *     War Room producer and this gate never disagree (RULINGS 4),
 *   - declines in a row (declined / ignored / expired; accepted or countered
 *     ends the run),
 *   - an unanswered offer still open,
 *   - lopsidedness spent: each lowball charges its cost against a budget that
 *     decays on a half-life, per manager and league-wide, so "no lowball spam"
 *     holds whether the spam goes to one manager or is spread across ten.
 *
 * Limits come from the manager's profile tier (league-brain.js TRADEABILITY).
 * "Hard to deal with" is stricter on every limit; "never" is always denied.
 *
 * NOT FITTED. Every number in REPUTATION_DEFAULTS, the half-life and the
 * lowball line are declared starting points, not measurements: trade_outcomes
 * has no settled app offers yet, so there is nothing to fit them on. The
 * prereg in ENGINE-SPECS REP-01 (accept rate vs prior lopsidedness) is what
 * replaces them once enough offers settle.
 */
import { row, rows } from '../db/index.js';
import { outcomesFor } from './trade-outcomes.js';
import { toTime } from './trade-tactics.js';
import { sentThisWeek } from '../../scripts/campaign/league-adapter.mjs';
import { repGateFields } from './offer-reputation-flag.js';

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const LOPSIDED_WINDOW_DAYS = 14;

/** Declared, not fitted: how fast a lowball is forgiven. */
export const REPUTATION_HALF_LIFE_DAYS = 14;

/**
 * With no priced lopsidedness, an offer whose P(accept) band tops out under
 * this line is treated as a lowball (cost 1). Labelled `p_accept_proxy`
 * wherever it is used, so it never reads as a measured lopsidedness.
 */
export const LOWBALL_P_ACCEPT = 0.2;

/** Decayed spend below this counts as spent-out, so a delay always ends. */
const SPENT_FLOOR = 0.05;
const EPS = 1e-9;

/** Per-manager limits by profile tier. Declared starting points. */
export const REPUTATION_DEFAULTS = Object.freeze({
  fair: Object.freeze({
    max_offers_7d: 3,
    max_decline_streak: 3,
    decline_cooldown_days: 1,
    streak_cooldown_days: 14,
    open_offer_wait_days: 2,
    lopsided_budget: 2,
  }),
  hard: Object.freeze({
    max_offers_7d: 2,
    max_decline_streak: 2,
    decline_cooldown_days: 3,
    streak_cooldown_days: 21,
    open_offer_wait_days: 3,
    lopsided_budget: 1,
  }),
});

/** League-wide cap on lopsided spend, across every manager. */
export const LEAGUE_REPUTATION_DEFAULTS = Object.freeze({ lopsided_budget: 4 });

const NO_STATUSES = new Set(['declined', 'ignored', 'expired']);
const RESET_STATUSES = new Set(['accepted', 'countered']);
const TIERS = new Set(['fair', 'hard', 'never']);

/** The limits for one tier, with explicit overrides. Throws on an unknown tier or limit. */
export function reputationLimits(tier, overrides = {}) {
  if (!TIERS.has(tier)) throw new Error(`unknown tier "${tier}" — expected fair, hard or never`);
  const base = tier === 'never' ? REPUTATION_DEFAULTS.hard : REPUTATION_DEFAULTS[tier];
  for (const k of Object.keys(overrides ?? {})) {
    if (!(k in base)) throw new Error(`unknown limit "${k}"`);
  }
  return { ...base, ...overrides };
}

function toMs(v, what) {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`${what} must be a date, got ${v}`);
  return ms;
}

const iso = ms => new Date(Math.ceil(ms)).toISOString();

/** What one offer costs against the budget, and on what basis. */
function costOf(o) {
  if (Number.isFinite(o?.lopsidedness)) {
    return { cost: Math.min(1, Math.max(0, o.lopsidedness)), basis: 'lopsidedness' };
  }
  const p = o?.p_accept_high ?? o?.model_p_accept_high ?? o?.model_p_accept;
  if (Number.isFinite(p)) return { cost: p < LOWBALL_P_ACCEPT ? 1 : 0, basis: 'p_accept_proxy' };
  return { cost: 0, basis: 'unpriced' };
}

/** Offers actually sent, as of `nowMs`, in a fixed order whatever the input order. */
function normalise(history, nowMs) {
  return (history ?? [])
    .filter(h => h && h.status !== 'not_proposed')
    .map(h => {
      const proposed = Date.parse(h.proposed_at ?? h.created_at);
      const resolved = h.resolved_at ? Date.parse(h.resolved_at) : proposed;
      return {
        counterparty: String(h.counterparty_id ?? h.counterparty_team_id ?? ''),
        proposed, resolved: Number.isFinite(resolved) ? resolved : proposed,
        status: h.status, ...costOf(h),
      };
    })
    .filter(h => Number.isFinite(h.proposed) && h.proposed <= nowMs)
    .sort((a, b) => b.resolved - a.resolved || b.proposed - a.proposed
      || a.counterparty.localeCompare(b.counterparty) || String(a.status).localeCompare(String(b.status)));
}

const decayed = (h, nowMs) => h.cost * 2 ** (-(nowMs - h.proposed) / (REPUTATION_HALF_LIFE_DAYS * DAY_MS));

/** The counts behind the gate, for one manager plus the league-wide spend. */
export function reputationLedger(history, { counterpartyId, now }) {
  const nowMs = toMs(now, 'now');
  const all = normalise(history, nowMs);
  const cp = String(counterpartyId);
  const mine = all.filter(h => h.counterparty === cp);

  const week = mine.filter(h => h.proposed > nowMs - WEEK_DAYS * DAY_MS);
  let streak = 0;
  let lastNo = null;
  let latestAnswer = null;
  for (const h of mine) {
    if (h.status === 'proposed') continue;
    latestAnswer ??= h;
    if (NO_STATUSES.has(h.status)) {
      streak += 1;
      lastNo ??= h.resolved;
    } else if (RESET_STATUSES.has(h.status)) break;
  }
  const open = mine.filter(h => h.status === 'proposed').sort((a, b) => b.proposed - a.proposed)[0] ?? null;

  return {
    counterparty_id: cp,
    offers_7d: week.length,
    oldest_7d_at: week.length ? iso(Math.min(...week.map(h => h.proposed))) : null,
    decline_streak: streak,
    last_decline_at: lastNo == null ? null : iso(lastNo),
    last_answer: latestAnswer ? { status: latestAnswer.status, at: iso(latestAnswer.resolved) } : null,
    open_offer_at: open ? iso(open.proposed) : null,
    lopsided_spent: mine.reduce((s, h) => s + decayed(h, nowMs), 0),
    lopsided_offers_14d: mine.filter(h => h.cost > 0 && h.proposed > nowMs - LOPSIDED_WINDOW_DAYS * DAY_MS).length,
    unpriced_offers: mine.filter(h => h.basis === 'unpriced').length,
    league_lopsided_spent: all.reduce((s, h) => s + decayed(h, nowMs), 0),
  };
}

/** When a decaying spend `spent` falls to `target`, in ms from now. */
function msUntilSpentBelow(spent, target) {
  const t = Math.max(target, SPENT_FLOOR);
  return REPUTATION_HALF_LIFE_DAYS * DAY_MS * Math.log2(spent / t);
}

/**
 * Should this offer go out now?
 *
 * @param {object} a
 * @param {object} a.offer    { counterparty_id, lopsidedness?  (0..1, on his screen),
 *                              p_accept_high? (the band's top, used only without lopsidedness) }
 * @param {object[]} a.history offers this app's team sent (trade_outcomes rows or the same shape)
 * @param {'fair'|'hard'|'never'|null} a.tier profile tier; null means unset -> 'fair'
 * @param {string|Date} a.now
 * @param {object} [a.overrides] per-limit replacements for the tier defaults
 * @param {number} [a.sentCount] offers sent this manager in the last 7 days from the one
 *   fatigue counter (sentThisWeek). Given, it replaces the history's own 7-day count.
 * @returns {{decision:'allow'|'deny'|'delay', code:string, reason:string, retry_at:string|null, ...}}
 */
export function offerGate({ offer, history, tier = null, now, overrides = {}, sentCount = null }) {
  if (now == null) throw new Error('offerGate needs `now`; it never reads the clock itself');
  const nowMs = toMs(now, 'now');
  const cp = offer?.counterparty_id;
  if (cp == null || String(cp).trim() === '') throw new Error('offer.counterparty_id is required');

  const tierSource = tier == null ? 'default' : 'profile';
  const t = tier ?? 'fair';
  const limits = reputationLimits(t, overrides);
  const ledger = reputationLedger(history, { counterpartyId: cp, now: nowMs });
  if (sentCount != null) {
    if (!Number.isInteger(sentCount) || sentCount < 0) throw new Error(`sentCount must be a count, got ${sentCount}`);
    ledger.offers_7d = sentCount;
    ledger.offers_7d_source = 'sentThisWeek';
  } else ledger.offers_7d_source = 'history';
  const { cost, basis } = costOf(offer);
  const leagueBudget = LEAGUE_REPUTATION_DEFAULTS.lopsided_budget;
  const base = { tier: t, tier_source: tierSource, limits, ledger, offer_cost: cost, offer_cost_basis: basis };
  const unpricedNote = basis === 'unpriced'
    ? ' This offer is unpriced (no lopsidedness and no P(accept) band), so it was not charged against the budget.'
    : '';
  const out = (decision, code, reason, retryMs = null) => ({
    decision, code, reason: reason + unpricedNote, retry_at: retryMs == null ? null : iso(retryMs), ...base,
  });

  if (t === 'never') {
    return out('deny', 'tier_never', 'This manager is marked "never trades"; offers to him are not sent.');
  }
  if (cost > limits.lopsided_budget + EPS || cost > leagueBudget + EPS) {
    return out('deny', 'offer_too_lopsided',
      `This offer is lopsided enough (${cost.toFixed(2)}) to use more than his whole budget ` +
      `(${limits.lopsided_budget}) on its own. Make it fairer rather than wait.`);
  }
  if (ledger.open_offer_at) {
    const retry = Date.parse(ledger.open_offer_at) + limits.open_offer_wait_days * DAY_MS;
    if (nowMs < retry) {
      return out('delay', 'open_offer',
        `He has not answered the offer sent ${ledger.open_offer_at}; wait for the answer or ` +
        `${limits.open_offer_wait_days} days.`, retry);
    }
  }
  if (ledger.decline_streak >= limits.max_decline_streak && ledger.last_decline_at) {
    const retry = Date.parse(ledger.last_decline_at) + limits.streak_cooldown_days * DAY_MS;
    if (nowMs < retry) {
      return out('delay', 'decline_streak',
        `${ledger.decline_streak} declines in a row from this manager; back off ` +
        `${limits.streak_cooldown_days} days from the last one.`, retry);
    }
  }
  if (ledger.last_answer && NO_STATUSES.has(ledger.last_answer.status)) {
    const retry = Date.parse(ledger.last_answer.at) + limits.decline_cooldown_days * DAY_MS;
    if (nowMs < retry) {
      return out('delay', 'decline_cooldown',
        `He ${ledger.last_answer.status === 'declined' ? 'declined' : 'let expire'} the last offer; ` +
        `wait ${limits.decline_cooldown_days} day(s) before the next.`, retry);
    }
  }
  if (ledger.offers_7d >= limits.max_offers_7d) {
    return out('delay', 'weekly_cap',
      `${ledger.offers_7d} offers in the last 7 days to this manager (cap ${limits.max_offers_7d}).`
      + (ledger.oldest_7d_at ? '' : ' The oldest is not in the app\'s log, so the retry time is unknown.'),
      ledger.oldest_7d_at ? Date.parse(ledger.oldest_7d_at) + WEEK_DAYS * DAY_MS : null);
  }
  if (cost > 0 && ledger.lopsided_spent + cost > limits.lopsided_budget + EPS) {
    return out('delay', 'reputation_budget',
      `You have sent him ${ledger.lopsided_offers_14d} lopsided offers in 2 weeks; this lowball ` +
      `waits until his budget (${limits.lopsided_budget}) recovers.`,
      nowMs + msUntilSpentBelow(ledger.lopsided_spent, limits.lopsided_budget - cost));
  }
  if (cost > 0 && ledger.league_lopsided_spent + cost > leagueBudget + EPS) {
    return out('delay', 'league_reputation_budget',
      `Lowballs across the league have used the league-wide budget (${leagueBudget}); this one waits.`,
      nowMs + msUntilSpentBelow(ledger.league_lopsided_spent, leagueBudget - cost));
  }
  return out('allow', 'ok', 'Within fatigue and reputation limits for this manager and the league.');
}

/**
 * The gate for one league, reading its own inputs: the offers this app's team
 * sent (trade_outcomes, any source but considered_only, and never an app_proposed
 * row that was not sent), the 7-day count from sentThisWeek, and the profile tier.
 * Throws on a league it cannot read: an unknown sender would count nothing and
 * allow blind.
 */
export function offerGateFor({ leagueId, season, offer, now, overrides }) {
  const lg = row('SELECT id, my_team_id FROM leagues WHERE id = ?', leagueId);
  if (!lg) throw new Error(`offerGateFor: league ${leagueId} not found`);
  const me = String(lg.my_team_id ?? '').trim();
  if (!me) throw new Error(`offerGateFor: league ${leagueId} has no my_team_id, so its sent offers cannot be told apart`);
  const profile = row('SELECT tradeability FROM manager_profiles WHERE league_id = ? AND roster_id = ?',
    leagueId, String(offer?.counterparty_id ?? ''));
  const history = outcomesFor(leagueId, season)
    .filter(r => r.source !== 'considered_only' && String(r.proposer_team_id ?? '') === me
      && !(r.source === 'app_proposed' && r.sent_at == null));
  const nowMs = toMs(now, 'now');
  // sentThisWeek counts ESPN's own proposals too; without the collector's table those
  // are unknown, and a count missing them would allow blind.
  if (!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'league_transactions_raw'`)) {
    throw new Error('league_transactions_raw does not exist here (the transactions collector has not run), '
      + "so ESPN's own proposals cannot be counted");
  }
  const sent = sentThisWeek({ db: { rows }, tactics: { toTime } }, leagueId, season, me, nowMs);
  const sentCount = sent.get(String(offer?.counterparty_id ?? '')) ?? 0;
  return offerGate({ offer, history, tier: profile?.tradeability ?? null, now: nowMs, overrides, sentCount });
}

/**
 * The trade finder's hook: every deal `findTrades` returns gets a `reputation`
 * verdict for its partner. Returns a copy — the finder's result is cached and
 * shared, so it is never written into. A league the gate cannot read gives each
 * deal `decision: null` with the reason, never a silent allow.
 *
 * Behind GRIDIRON_REP_GATE: off, the result is returned as it came (no
 * `reputation` field). On only through preview mode, each verdict says so.
 */
export function gateDeals(lg, result, { now = new Date() } = {}) {
  if (!Array.isArray(result?.deals)) return result;
  const flag = repGateFields();
  if (!flag.enabled) return result;
  const label = flag.preview ? { preview: true, preview_reason: flag.preview_reason } : {};
  const gate = d => {
    try {
      return { ...offerGateFor({ leagueId: lg.id, season: lg.season, now,
        offer: { counterparty_id: d.partner_id, p_accept_high: d.acceptance?.band?.high ?? null } }), ...label };
    } catch (e) {
      return { decision: null, code: 'unavailable', reason: `reputation gate not run: ${e.message}`, retry_at: null, ...label };
    }
  };
  return { ...result, deals: result.deals.map(d => ({ ...d, reputation: gate(d) })) };
}
