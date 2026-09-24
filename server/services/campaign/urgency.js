/**
 * M7-TIMING (PEOPLE-WIRING module 7): urgency windows -> send_when on campaign steps (pure).
 *
 * A league-mate's urgency spikes when something presses him to act this week:
 *   starter_injured  one of HIS starters carries an injury flag
 *   loss_streak      he has lost STREAK_MIN or more straight decided games
 *   need_move        he wrote 'need a move'-type messages in the league chat in the last 7 days
 *                    (counted locally in scripts/campaign/chat-labels.mjs; only the count leaves
 *                    the chat DB)
 *   bye_crunch       BYE_MIN or more of his starters are on bye this week
 * A bye crunch NEXT week is foreseeable, so it is an upcoming window: wait until it is felt.
 *
 * sendWhen() layers this on trade-tactics.js#sendWindow: a recent decline still wins (sending
 * inside it reads as pestering), then a spike says "send now", then an upcoming crunch says
 * "wait N days", else the base read stands. Every threshold is hand-set, not fitted
 * (`fitted: false`); gradeM7() is the grade the thresholds earn weight from: P(trade within 7
 * days | spike) vs the same rate on non-spike manager-days (scripts/rnd/grade-m7-timing.mjs).
 *
 * Off by default: GRIDIRON_M7_TIMING=1, or preview mode (preview-mode.js), which labels it.
 */
import { previewUnconfirmed } from '../preview-mode.js';

export const M7_ENV = 'GRIDIRON_M7_TIMING';
export const M7_PREVIEW_REASON = 'Urgency windows use hand-set thresholds; P(trade within 7 days) vs baseline not graded yet (M7)';
export const THRESHOLDS = Object.freeze({ starters_out: 1, loss_streak: 2, need_move: 1, bye_crunch: 2, need_move_days: 7 });
const DAY = 864e5;

/** { on, preview }: on by its own switch, or by preview mode (then labelled). Read per call. */
export function m7Timing(env = process.env) {
  if (env[M7_ENV] === '1') return { on: true, preview: false };
  return previewUnconfirmed() ? { on: true, preview: true } : { on: false, preview: false };
}

/**
 * Trade-move talk only. Position asks ("need a QB") are excluded on purpose: in league 4 one
 * manager's position asks are about a youth team (Nick's ground truth, PEOPLE-WIRING.md).
 */
export const NEED_MOVE_RE = /\b(?:need|needs|gotta|got to|have to|must|want|wanna|looking)\s+(?:to\s+)?(?:make\s+)?(?:a\s+)?(?:move|trade|deal)\b|\bopen to (?:offers|trades?)\b|\bwho wants to (?:trade|deal)\b/i;
export const isNeedMove = text => typeof text === 'string' && NEED_MOVE_RE.test(text);

/** Consecutive decided losses from his latest decided game back; null when he has no decided game. */
export function lossStreak(schedule, team) {
  const id = String(team);
  const mine = (schedule ?? []).filter(m => m?.winner && m.winner !== 'UNDECIDED' && m.home && m.away
    && (String(m.home.teamId) === id || String(m.away.teamId) === id))
    .sort((a, b) => (b.matchupPeriodId ?? 0) - (a.matchupPeriodId ?? 0));
  if (!mine.length) return null;
  let n = 0;
  for (const m of mine) {
    const home = String(m.home.teamId) === id;
    const lost = home ? m.winner === 'AWAY' : m.winner === 'HOME';
    if (!lost) break;
    n++;
  }
  return { n, through_period: mine[0].matchupPeriodId ?? null };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * inputs: numbers, or null when unknown. Returns { spike, triggers, upcoming, unknown, inputs }.
 * Every trigger carries its value and a sentence.
 */
export function urgencyRead({ starters_out = null, loss_streak = null, need_move = null, bye_crunch = null, bye_crunch_next = null } = {}) {
  const T = THRESHOLDS;
  const known = v => Number.isFinite(v);
  const triggers = [];
  if (known(starters_out) && starters_out >= T.starters_out) {
    triggers.push({ kind: 'starter_injured', value: starters_out,
      why: `${starters_out === 1 ? '1 of his starters is' : `${starters_out} of his starters are`} injured` });
  }
  if (known(loss_streak) && loss_streak >= T.loss_streak) {
    triggers.push({ kind: 'loss_streak', value: loss_streak, why: `he has lost ${loss_streak} straight` });
  }
  if (known(need_move) && need_move >= T.need_move) {
    triggers.push({ kind: 'need_move', value: need_move,
      why: `${plural(need_move, "'need a move' message")} from him in chat in the last ${T.need_move_days} days` });
  }
  if (known(bye_crunch) && bye_crunch >= T.bye_crunch) {
    triggers.push({ kind: 'bye_crunch', value: bye_crunch, why: `${plural(bye_crunch, 'starter')} on bye this week` });
  }
  const upcoming = known(bye_crunch_next) && bye_crunch_next >= T.bye_crunch && !triggers.some(t => t.kind === 'bye_crunch')
    ? [{ kind: 'bye_crunch', value: bye_crunch_next, why: `${plural(bye_crunch_next, 'starter')} on bye next week` }] : [];
  const unknown = [
    ['starter_injured', starters_out], ['loss_streak', loss_streak], ['need_move', need_move], ['bye_crunch', bye_crunch],
  ].filter(([, v]) => !known(v)).map(([k]) => k);
  return {
    spike: triggers.length > 0, triggers, upcoming, unknown, fitted: false,
    inputs: { starters_out: { value: starters_out }, loss_streak: { value: loss_streak }, need_move: { value: need_move },
      bye_crunch: { value: bye_crunch }, bye_crunch_next: { value: bye_crunch_next } },
  };
}

/**
 * One manager's read from the league state. roster: his player ids; starters: Set of his starter
 * ids; players: Map id -> { injury (0/1), bye }; schedule: ESPN payload.schedule; week: current
 * scoring week; needMove: 'need a move' count in the last 7 days, or null when the chat is unread.
 */
export function managerUrgency({ roster = [], starters = new Set(), players = new Map(), schedule = null, team, week = null, needMove = null }) {
  const P = id => players.get(id) ?? players.get(String(id)) ?? players.get(Number(id)) ?? null;
  const mine = roster.filter(id => starters.has(id)).map(P).filter(Boolean);
  const haveStarters = mine.length > 0;
  const byeIn = w => (haveStarters && Number.isInteger(week) ? mine.filter(p => p.bye === w).length : null);
  const streak = schedule ? lossStreak(schedule, team) : null;
  return urgencyRead({
    starters_out: haveStarters ? mine.filter(p => p.injury).length : null,
    loss_streak: streak ? streak.n : null,
    need_move: Number.isFinite(needMove) ? needMove : null,
    bye_crunch: byeIn(week),
    bye_crunch_next: Number.isInteger(week) ? byeIn(week + 1) : null,
  });
}

/**
 * base: trade-tactics.js#sendWindow result. read: urgencyRead result. Returns the step's
 * send_when: { when: 'now'|'wait', until, days, why, n, fitted, source: 'm7', urgency, preview? }.
 */
export function sendWhen(base, read, { now = Date.now(), daysLeftInWeek = 7, preview = false } = {}) {
  const b = base ?? { when: 'now', until: null, n: 0, fitted: false, why: 'nothing captured about when this manager answers' };
  const urgency = { spike: read.spike, triggers: read.triggers, upcoming: read.upcoming, unknown: read.unknown };
  const tag = preview ? { preview: true, preview_reason: M7_PREVIEW_REASON } : {};
  const out = (when, days, why) => ({ when, until: when === 'wait' ? new Date(now + days * DAY).toISOString() : null,
    days, why, n: b.n ?? 0, fitted: false, source: 'm7', urgency, ...tag });
  if (b.when === 'wait') {
    const untilMs = Date.parse(b.until);
    const days = Number.isFinite(untilMs) ? Math.max(1, Math.ceil((untilMs - now) / DAY)) : 1;
    const also = read.spike ? `; his urgency window is open (${read.triggers.map(t => t.why).join('; ')}), send right after` : '';
    return { ...out('wait', days, `${b.why}${also}`), ...(b.until ? { until: b.until } : {}) };
  }
  if (read.spike) return out('now', 0, `urgency window open: ${read.triggers.map(t => t.why).join('; ')}`);
  if (read.upcoming.length) {
    const days = Math.max(1, Math.min(7, Math.round(daysLeftInWeek)));
    return out('wait', days, `${read.upcoming.map(u => u.why).join('; ')}; the crunch is felt once this week's games are played`);
  }
  const gaps = read.unknown.length ? ` (unknown: ${read.unknown.join(', ')})` : '';
  return out('now', 0, `no urgency spike${gaps}; ${b.why}`);
}

/* ------------------------------------------------------------------ grade */

/** Wilson interval, 90% by default. */
export function wilson(k, n, z = 1.645) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export const GRADE_MIN_SPIKES = 20;

/**
 * spikes / baseline: [{ team, at (ms) }]; trades: [{ at (ms), parties: Set of team ids }].
 * Outcome: the team is a party to a trade processed in (at, at + windowDays]. Verdict is 'thin'
 * under GRADE_MIN_SPIKES spikes or with no trade at all, 'lift' when the spike interval clears the
 * baseline rate, 'no_lift' when it sits wholly below, else 'inconclusive'.
 */
export function gradeM7({ spikes = [], baseline = [], trades = [], windowDays = 7 }) {
  const w = windowDays * DAY;
  const hit = e => trades.some(t => t.at > e.at && t.at <= e.at + w && t.parties.has(String(e.team)));
  const arm = rows => {
    const k = rows.filter(hit).length, n = rows.length;
    return { n, k, p: n ? k / n : null, ci: wilson(k, n) };
  };
  const s = arm(spikes), b = arm(baseline);
  const lift = s.p != null && b.p ? s.p / b.p : null;
  const verdict = s.n < GRADE_MIN_SPIKES || !trades.length || b.n === 0 ? 'thin'
    : s.ci[0] > b.p ? 'lift' : s.ci[1] < b.p ? 'no_lift' : 'inconclusive';
  return { window_days: windowDays, spike: s, baseline: b, lift, verdict, min_spikes: GRADE_MIN_SPIKES };
}
