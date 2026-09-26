/**
 * TM-34 DEADLINE MODE: the trade-deadline endgame, read off the planner's own ranked paths (pure).
 *
 * League 4's deadline is ESPN's deadlineDate (1796230800000 = Wed 2026-12-02 17:00 UTC, ONE-PLAN
 * spot-check 8). An offer only counts if it clears before that wall, so the last REAL send is earlier:
 * the league's review window (revisionHours, 24 h in league 4) plus his send window and ESPN
 * processing (HIS_WINDOW_HOURS, hand-set) = Mon 2026-11-30 17:00 UTC.
 *
 *   deadlineClock  countdown to the deadline and to the last real send, and the phase.
 *   stepSendBy     per step of a path, the latest time it can go out: a chained path's early legs
 *                  must leave room for the later ones (DAYS_PER_STEP each, itinerary.js).
 *   lastCall       one offer per partner: his best ranked path (already filtered by Nick's rules in the
 *                  search) that still fits before the last send; re-checked here against the blocked ids.
 *   holdList       Nick's players to keep through the deadline: his rule-blocked ones, and every player
 *                  no fitting path sells.
 *   quietRead      who goes quiet: the activity read the planner already trusts (checked_out, the proven
 *                  who-trades signal) plus days since his last own move in the league.
 *   waitValue      option value of waiting vs the real expiry (research E5): waiting on news was KILLED
 *                  (IDEA-151, R&D r24: no better than acting), so its option value is 0, labelled; the
 *                  cost of waiting is the speed curve's landing value (speed.js, the one landing model)
 *                  with every day to the last send vs with one round left.
 *
 * Flag GRIDIRON_DEADLINE_MODE: '1' or 'shadow' computes the report into _run.inputs.deadline_mode only;
 * anything else (default) is off and the entry is byte-for-byte unchanged. Nothing here is served until
 * the PR's pass bar is measured on league 4; preview mode never turns it on.
 */
import { DAYS_PER_STEP } from './itinerary.js';
import { speedCurve } from './speed.js';
import { dealKey } from './paths.js';

export const DEADLINE_ENV = 'GRIDIRON_DEADLINE_MODE';
/** League review window when the league settings carry none (league 4 measured: 24). */
export const REVIEW_HOURS_DEFAULT = 24;
/** His send window + ESPN processing before the review starts. Hand-set, pre-registered in the PR. */
export const HIS_WINDOW_HOURS = 24;
/** Deadline mode's phases start this many days before the deadline. Hand-set. */
export const DEADLINE_WINDOW_DAYS = 14;
/** The last-call phase: this many days (or fewer) to the last real send. Hand-set. */
export const LAST_CALL_DAYS = 7;
/** No own move in this many days reads as quiet. Hand-set, graded in the PR's pass bar. */
export const QUIET_DAYS = 10;
export const WAIT_KILLED_BY = 'R&D r24 (IDEA-151): waiting on the news tested no better than acting';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const round1 = x => Math.round(x * 10) / 10;

/** 'shadow' | 'off'. Only its own flag switches it; preview mode does not. */
export function deadlineMode(env = {}) {
  const v = env?.[DEADLINE_ENV];
  return v === '1' || v === 'shadow' ? 'shadow' : 'off';
}

/**
 * deadlineAt: ISO or ms of the league's trade deadline (null when the league settings carry none).
 * Returns { status: 'unknown', reason } or { status: 'ok', deadline_at, last_send_at, now, days_to_deadline,
 * days_to_last_send, hours_to_last_send, buffer_hours, review_hours, review_basis, phase }.
 */
export function deadlineClock({ deadlineAt, now, reviewHours = null }) {
  const dl = typeof deadlineAt === 'number' ? deadlineAt : Date.parse(deadlineAt ?? '');
  if (!(dl > 0)) return { status: 'unknown', reason: 'no trade deadline in the league settings' };
  if (!Number.isFinite(now)) throw new Error('deadlineClock: now must be a timestamp in ms');
  const review = Number.isFinite(reviewHours) && reviewHours >= 0 ? reviewHours : REVIEW_HOURS_DEFAULT;
  const buffer = review + HIS_WINDOW_HOURS;
  const last = dl - buffer * HOUR;
  const phase = now >= dl ? 'past' : now >= last ? 'closed'
    : (last - now) <= LAST_CALL_DAYS * DAY ? 'last_call' : (dl - now) <= DEADLINE_WINDOW_DAYS * DAY ? 'deadline' : 'normal';
  return {
    status: 'ok', deadline_at: iso(dl), last_send_at: iso(last), now: iso(now),
    deadline_ms: dl, last_send_ms: last, now_ms: now,
    days_to_deadline: round1((dl - now) / DAY), days_to_last_send: round1((last - now) / DAY),
    hours_to_last_send: Math.round((last - now) / HOUR), buffer_hours: buffer, review_hours: review,
    review_basis: Number.isFinite(reviewHours) && reviewHours >= 0 ? 'league settings' : `default ${REVIEW_HOURS_DEFAULT} h (none in league settings)`,
    phase,
  };
}

/**
 * Per step of a path, the latest time it can go out and still clear before the deadline. Independent
 * steps all go by the last send; a chained path's step k leaves (n - 1 - k) rounds for the legs after it.
 */
export function stepSendBy(plan, clock, { daysPerStep = DAYS_PER_STEP } = {}) {
  const n = plan.steps.length;
  return plan.steps.map((s, k) => {
    const by = clock.last_send_ms - (plan.chained ? (n - 1 - k) * daysPerStep * DAY : 0);
    return { step_index: k, team: String(s.team), send_by: iso(by), too_late: by < clock.now_ms };
  });
}

/** True when a path gives or gets an id Nick's rules block (never-give, never-get, untouchables). */
export function breaksRules(plan, blocked) {
  return plan.steps.some(s => [...(s.give ?? []), ...(s.get ?? [])].some(id => blocked.has(String(id))));
}

/**
 * One last-call offer per reachable partner: his best ranked path whose every step still fits before the
 * last send and which breaks none of Nick's rules. ranked: the planner's ranked paths, best first.
 * partners: [{ team, excluded }]. Returns rows sorted by expected, best first; a partner with no fitting
 * path gets { status: 'none', because }.
 */
export function lastCall({ ranked, clock, partners, blocked = new Set(), daysPerStep = DAYS_PER_STEP }) {
  const rows = [];
  for (const { team, excluded } of partners) {
    if (excluded) continue;
    let pick = null, tooLate = 0, ruled = 0;
    for (const p of ranked) {
      if (String(p.steps[0]?.team) !== String(team)) continue;
      if (breaksRules(p, blocked)) { ruled++; continue; }
      const sb = stepSendBy(p, clock, { daysPerStep });
      if (sb.some(x => x.too_late)) { tooLate++; continue; }
      pick = { p, sb };
      break;
    }
    if (!pick) {
      rows.push({ team: String(team), status: 'none', too_late: tooLate, rule_dropped: ruled,
        because: tooLate ? 'every path through him needs more rounds than are left' : 'no ranked path through him' });
      continue;
    }
    const { p, sb } = pick;
    rows.push({ team: String(team), status: 'ok', deal_key: dealKey(p.steps[0]), steps: p.steps.length, chained: !!p.chained,
      give: [...new Set(p.steps.flatMap(s => s.give.map(String)))], get: [...new Set(p.steps.flatMap(s => s.get.map(String)))],
      expected: p.expected, p_complete: p.p_complete, send_by: sb[0].send_by, send_by_steps: sb.map(x => x.send_by),
      too_late: tooLate, rule_dropped: ruled, plan: p });
  }
  return rows.sort((a, b) => (b.status === 'ok') - (a.status === 'ok') || (b.expected ?? -Infinity) - (a.expected ?? -Infinity));
}

/**
 * Nick's players to keep through the deadline. roster: his ids. blocked: rule-blocked ids. offers: lastCall
 * rows. A player is sold by a last-call offer that beats doing nothing (expected > 0); every other player
 * is held, with the reason.
 */
export function holdList({ roster, blocked = new Set(), offers = [] }) {
  const sold = new Set(offers.filter(o => o.status === 'ok' && o.expected > 0).flatMap(o => o.give));
  return roster.map(String).filter(id => blocked.has(id) || !sold.has(id))
    .map(id => ({ player: id, reason: blocked.has(id) ? 'rule' : 'no_deal_beats_keeping' }));
}

/**
 * Who goes quiet before the deadline. managers: Map team -> { checked_out, p_checked_out, last_action_at }.
 * status 'quiet' (checked out, or no own move in QUIET_DAYS), 'active', or 'unknown' (no activity read).
 */
export function quietRead(managers, { now, excluded = () => false }) {
  const out = [];
  for (const [team, m] of managers) {
    if (excluded(m)) continue;
    const last = Date.parse(m?.last_action_at ?? '');
    const days = Number.isFinite(last) ? round1((now - last) / DAY) : null;
    const status = m?.checked_out ? 'quiet' : days == null ? 'unknown' : days >= QUIET_DAYS ? 'quiet' : 'active';
    const basis = m?.checked_out ? `checked out (${m.checked_out_source ?? 'activity read'})`
      : days == null ? 'no own move on record' : `last own move ${days} days ago (quiet at ${QUIET_DAYS}, hand-set)`;
    out.push({ team: String(team), status, days_since_action: days,
      ...(Number.isFinite(m?.p_checked_out) ? { p_checked_out: m.p_checked_out } : {}), basis });
  }
  return out.sort((a, b) => a.team.localeCompare(b.team, 'en', { numeric: true }));
}

/**
 * The option value of waiting vs the real expiry, on the speed curve's landing model (the same ranked
 * paths): expected landing value with every day to the last send vs with a single round left.
 * Waiting on news has option value 0 (killed idea, labelled), so wait_cost > 0 says send now.
 */
export function waitValue({ ranked, clock, currentWeek, daysPerStep = DAYS_PER_STEP }) {
  if (!ranked.length || !Number.isInteger(currentWeek)) return { status: 'unknown', reason: 'no ranked paths' };
  const daysLeft = Math.max(0, (clock.last_send_ms - clock.now_ms) / DAY);
  if (daysLeft < daysPerStep) return { status: 'unknown', reason: `less than one negotiation round (${daysPerStep} days) to the last send` };
  const at = days => {
    const c = speedCurve({ ranked }, { currentWeek, deadlineWeek: currentWeek, daysPerStep, daysLeftInWeek: days });
    return c.length ? c[c.length - 1] : null;
  };
  const now = at(daysLeft), last = at(Math.min(daysLeft, daysPerStep));
  if (!now || !last) return { status: 'unknown', reason: 'the speed curve has no route' };
  const cost = Math.max(0, now.expected - last.expected);
  return { status: 'ok', expected_send_now: now.expected, expected_last_call: last.expected, wait_cost: cost,
    rounds_now: Math.floor(daysLeft / daysPerStep), rounds_last_call: daysLeft >= daysPerStep ? 1 : 0,
    option_value: 0, option_value_basis: `0: ${WAIT_KILLED_BY}`,
    verdict: cost > 0 ? 'send_now' : 'no_cost_to_wait', unit: 'title_odds' };
}

/**
 * The whole report. inputs: { mode, deadlineAt, reviewHours, now, currentWeek, deadlineWeek, ranked, deck,
 * managers, roster, blocked, excluded }. deck: the served deck's plans (each gets its steps' send_by).
 */
export function deadlineReport({ mode, deadlineAt, reviewHours = null, now, currentWeek, deadlineWeek = null, ranked = [], deck = [],
  managers = new Map(), roster = [], blocked = new Set(), excluded = () => false, daysPerStep = DAYS_PER_STEP }) {
  const clock = deadlineClock({ deadlineAt, now, reviewHours });
  if (clock.status !== 'ok') return { mode, clock, deadline_week: deadlineWeek };
  const partners = [...managers].map(([team, m]) => ({ team, excluded: excluded(m) }));
  const offers = lastCall({ ranked, clock, partners, blocked, daysPerStep });
  const deckSendBy = deck.map(p => ({ deal_key: dealKey(p.steps[0]), steps: stepSendBy(p, clock, { daysPerStep }) }));
  return {
    mode, clock, deadline_week: deadlineWeek,
    deck_send_by: deckSendBy,
    last_call: offers,
    hold: holdList({ roster, blocked, offers }),
    quiet: quietRead(managers, { now, excluded }),
    wait: waitValue({ ranked: ranked.filter(p => !breaksRules(p, blocked)), clock, currentWeek, daysPerStep }),
  };
}

/** The report for `_run.inputs.deadline_mode` (ids and numbers only; the path objects are dropped). */
export function deadlineSummary(r) {
  if (r.clock.status !== 'ok') return { mode: r.mode, status: 'unknown', reason: r.clock.reason };
  const { deadline_ms, last_send_ms, now_ms, ...clock } = r.clock;
  const deckSteps = r.deck_send_by.flatMap(d => d.steps);
  return {
    mode: r.mode, status: 'ok', clock, deadline_week: r.deadline_week,
    deck_send_by: r.deck_send_by,
    deck_steps: deckSteps.length,
    deck_steps_after_last_send: deckSteps.filter(s => Date.parse(s.send_by) > last_send_ms).length,
    deck_steps_too_late: deckSteps.filter(s => s.too_late).length,
    last_call: r.last_call.map(({ plan, ...row }) => row),
    hold: r.hold, quiet: r.quiet, wait: r.wait,
  };
}
