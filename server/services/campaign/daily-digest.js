/**
 * DAILY DIGEST (Batch D item 34): one 9 AM Eastern summary a day: what changed since the last
 * digest check, the next move, and who answered Nick's offers. Quiet when nothing changed.
 *
 * READS served fields only, never `_run`:
 *   plans.json (plans-schema.js)   per league: next_move (move_id, first step), destination.title_now
 *                                  (with its se), feasibility.status / feasibility_points.outlook,
 *                                  names (player labels) and me (Nick's roster id).
 *   decided offers                 eval/decided-offers.js#loadDecidedOffers (THE decided-offers
 *                                  producer): answers to offers Nick's roster proposed.
 * Numbers are copied from their one producer; nothing here recomputes a served number.
 *
 * RULES. The next move is written out only when every step passes the ONE rule gate
 * (never-give.js#ruleGate) from Nick's side, its final gets clear the Blue chip floor, and it beats
 * doing nothing (delta_final > 0, no step failing 2 SE). Anything else, including no gate, a gate
 * that does not apply, or a gate that throws, is withheld: the digest says "open the War Room" and
 * names no players. It never looks looser than the War Room itself.
 *
 * PRIVACY. Partners are "Team N" (roster ids). Team and manager names in plans.json are never read.
 *
 * DELIVERY is the existing push path: one JSONL row { kind: 'daily_digest', ... } appended to
 * pushes.jsonl (GRIDIRON_WARROOM_PUSHES, next to the plans file), the file produce-plans.mjs writes
 * its next-move rows to. State (last digest day, baseline per league) lives in digest-state.json
 * (GRIDIRON_DIGEST_STATE) next to it. Both are local files outside the repo.
 *
 * FLAG: GRIDIRON_DAILY_DIGEST=1 only (never the preview switch). Off -> nothing read or written.
 */
import { etDay } from '../et-day.js';

export const DIGEST_FLAG_ENV = 'GRIDIRON_DAILY_DIGEST';
export const DIGEST_TZ = 'America/New_York';
export const DIGEST_HOUR = 9;
/** A title-odds move smaller than this (or than 2 SE of the difference) is noise, not news. */
export const TITLE_MOVE_FLOOR = 0.01;

export const digestFlag = (env = process.env) => env?.[DIGEST_FLAG_ENV] === '1';

const S = x => String(x);
const FLOOR_REASONS = new Set(['below_blue_chip', 'unscored']);
const FEAS_LABEL = { on_track: 'on track', reachable: 'reachable with a trade', out_of_reach: 'out of reach' };
const ANSWER_LABEL = { accepted: 'accepted', declined: 'declined', countered: 'countered' };
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: DIGEST_TZ, hour: 'numeric', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: DIGEST_TZ, weekday: 'short', month: 'short', day: 'numeric' });

/** The Eastern day and whether `now` is inside the 9 AM hour there (EDT or EST, whichever is in force). */
export function digestWindow(now = new Date()) {
  return { day: etDay(now), open: Number(hourFmt.format(now)) === DIGEST_HOUR };
}

const okVal = f => (f?.status === 'ok' ? f.value : null);
const pct = p => `${Math.round(p * 100)}%`;
const pts = d => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`;

/**
 * One league's watched values from its served entry. -> null for a failed entry (it neither changes
 * nor clears the baseline). next: move_id, 'none' (no move clears the bar), or null (unreadable).
 */
export function snapshotOf(e) {
  if (!e || e.error) return null;
  const nm = e.next_move;
  const next = nm?.status === 'ok' && nm.value?.move_id ? S(nm.value.move_id) : nm?.status === 'unknown' ? 'none' : null;
  const tn = e.destination?.status === 'ok' ? e.destination.value?.title_now : null;
  const title = tn?.status === 'ok' && Number.isFinite(tn.value) ? { value: tn.value, se: Number.isFinite(tn.se) ? tn.se : 0 } : null;
  const fe = okVal(e.feasibility);
  const fp = okVal(e.feasibility_points);
  const goal = FEAS_LABEL[fe?.status] ? fe.status : FEAS_LABEL[fp?.outlook] ? fp.outlook : null;
  return { next, title, goal };
}

/** What moved between two snapshots of one league: [{ kind, text }]. */
export function changesOf(prev, cur) {
  if (!prev || !cur) return [];
  const out = [];
  if (prev.next != null && cur.next != null && prev.next !== cur.next) {
    out.push({ kind: 'next_move', text: cur.next === 'none' ? 'no trade clears the bar now' : 'the next move changed' });
  }
  if (prev.title && cur.title) {
    const d = cur.title.value - prev.title.value;
    const noise = Math.max(TITLE_MOVE_FLOOR, 2 * Math.hypot(prev.title.se, cur.title.se));
    if (Math.abs(d) >= noise) out.push({ kind: 'title', text: `title odds ${pct(prev.title.value)} -> ${pct(cur.title.value)}` });
  }
  if (prev.goal && cur.goal && prev.goal !== cur.goal) {
    out.push({ kind: 'goal', text: `goal now ${FEAS_LABEL[cur.goal]} (was ${FEAS_LABEL[prev.goal]})` });
  }
  return out;
}

/**
 * Whether the served next move may be written out. gate: ruleGate(...) for this league, or null.
 * -> { ok, reasons }. Fails closed on no gate, a gate that does not apply, or a gate that throws.
 * Each step is checked from Nick's side; the Blue chip floor applies to the path's final gets only
 * (a flip leg's get that a later step gives away is not a final get, as the planner's GETS-FLOOR).
 * The +12% depth-only 2-for-1 premium counts only with the step's confirm-dice lineup and title gains.
 */
export function moveVerdict(move, gate) {
  const reasons = new Set();
  const steps = Array.isArray(move?.steps) ? move.steps : [];
  if (!steps.length) reasons.add('no_path');
  const df = move?.delta_final;
  if (!(df?.status === 'ok' && Number(df.value) > 0)) reasons.add('no_edge');
  if (steps.some(st => st?.title_odds_delta?.clears_2se === false)) reasons.add('no_edge');
  if (!gate || gate.applies !== true || typeof gate.check !== 'function') {
    reasons.add('rules_unreadable');
    return { ok: false, reasons: [...reasons] };
  }
  const ids = xs => (Array.isArray(xs) ? xs : []).map(S);
  try {
    steps.forEach((st, i) => {
      const dp = okVal(st.depth_premium);
      const premium = dp && Number.isFinite(dp.confirmed_lineup_points_delta) && Number.isFinite(dp.confirmed_title_odds_delta)
        ? { points_delta: dp.confirmed_lineup_points_delta, title_delta: dp.confirmed_title_odds_delta } : null;
      const v = gate.check({ give: ids(st.give), get: ids(st.get), premium });
      for (const r of v.reasons) if (!FLOOR_REASONS.has(r)) reasons.add(r);
      if (v.requires_nick_confirm && !gate.aj?.confirmed?.has(S(move.move_id))) reasons.add('needs_your_ok');
      const later = new Set(steps.slice(i + 1).flatMap(x => ids(x.give)));
      const final = ids(st.get).filter(id => !later.has(id));
      if (final.length) for (const r of gate.check({ give: [], get: final, premium: null }).reasons) if (FLOOR_REASONS.has(r)) reasons.add(r);
    });
  } catch (err) {
    // The gate threw mid-check: withheld, and the reason is kept for the log line.
    reasons.add('rules_unreadable');
    reasons.add(`gate_threw: ${String(err?.message ?? err).slice(0, 80)}`);
  }
  return { ok: reasons.size === 0, reasons: [...reasons] };
}

/** The next-move line for one league (player labels from the entry's own names map; partner as Team N). */
export function nextMoveLine(e, gate) {
  const nm = e.next_move;
  if (nm?.status === 'unknown') return 'Next move: none clears the bar today.';
  if (nm?.status !== 'ok' || !nm.value) return 'Next move: could not be read; open the War Room.';
  const v = moveVerdict(nm.value, gate);
  if (!v.ok) return 'Next move: open the War Room (held back by the digest\'s rules check).';
  const label = id => e.names?.[S(id)] ?? `player ${id}`;
  const st = nm.value.steps[0];
  const p = okVal(st.p_yes);
  const d = okVal(st.title_odds_delta);
  const more = nm.value.steps.length > 1 ? ` (step 1 of ${nm.value.steps.length})` : '';
  return `Next move${more}: offer Team ${st.partner} ${st.give.map(label).join(' + ')} for ${st.get.map(label).join(' + ')}`
    + (p != null ? `; chance of yes ${pct(p)}${st.p_yes.guess ? ' (a guess)' : ''}` : '')
    + (d != null ? `; title odds ${pts(d)} if it lands` : '') + '.';
}

const ms = x => (x == null ? NaN : typeof x === 'number' ? x : /^\d+$/.test(S(x)) ? Number(x) : Date.parse(x));

/**
 * Answers to offers Nick's roster proposed, decided in (since, until]. offers: decided-offers rows
 * (offers and orphans). me: league id -> Nick's roster id. -> Map league id -> [{ team, status }].
 */
export function repliesOf(offers, { me, since, until }) {
  const out = new Map();
  const lo = ms(since), hi = ms(until);
  for (const o of offers ?? []) {
    const mine = me.get(S(o.league_id));
    if (mine == null || o.proposer_team_id == null || S(o.proposer_team_id) !== S(mine)) continue;
    if (!ANSWER_LABEL[o.status] || o.counterparty_team_id == null) continue;
    const t = ms(o.decided_at);
    if (!(t > lo && t <= hi)) continue;
    const k = S(o.league_id);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ team: S(o.counterparty_team_id), status: o.status, at: t });
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * The digest for one 9 AM check. Pure.
 * plans: the plans file; state: the previous digest state ({ day, at, leagues }) or null;
 * offers: { rows, reason } from the decided-offers producer; gateFor(leagueId) -> ruleGate or null.
 * -> { status: 'closed' | 'done_today' | 'baseline' | 'quiet' | 'send', text, lines, state, errors }
 * `state` is what to write back (null when nothing should be written).
 */
export function buildDigest({ plans, state = null, offers = { rows: [], reason: null }, gateFor = () => null, now = new Date() }) {
  const at = now.toISOString();
  const win = digestWindow(now);
  if (!win.open) return { status: 'closed', text: null, lines: [], state: null, errors: [] };
  if (state?.day === win.day) return { status: 'done_today', text: null, lines: [], state: null, errors: [] };

  const entries = Array.isArray(plans?.leagues) ? plans.leagues : [];
  const snaps = { ...(state?.leagues ?? {}) };
  const me = new Map(entries.filter(e => !e.error && e.me != null).map(e => [S(e.league), S(e.me)]));
  const first = !state?.at;
  const replies = first ? new Map() : repliesOf(offers.rows, { me, since: state.at, until: at });

  const lines = [];
  const errors = [];
  for (const e of entries) {
    const cur = snapshotOf(e);
    if (!cur) continue; // a failed league keeps its baseline
    const k = S(e.league);
    const changes = changesOf(snaps[k], cur);
    const answered = replies.get(k) ?? [];
    snaps[k] = cur;
    if (!changes.length && !answered.length) continue;
    let gate = null;
    try { gate = gateFor(e.league) ?? null; } catch (err) {
      errors.push(`league ${k} rule gate: ${String(err?.message ?? err).slice(0, 120)}`); // no gate -> withheld (fails closed)
    }
    const parts = [...changes.map(c => c.text),
      ...answered.map(r => `Team ${r.team} ${ANSWER_LABEL[r.status]} your offer`)];
    lines.push(`League ${k}: ${parts.join('; ')}.`, nextMoveLine(e, gate));
  }
  const nextState = { day: win.day, at, leagues: snaps };
  if (first) return { status: 'baseline', text: null, lines: [], state: nextState, errors };
  if (!lines.length) return { status: 'quiet', text: null, lines: [], state: nextState, errors };
  if (offers.reason) lines.push(`Replies could not be read today (${offers.reason.slice(0, 120)}).`);
  const text = [`Gridiron, ${dayFmt.format(now)}`, ...lines].join('\n');
  return { status: 'send', text, lines, state: nextState, errors };
}

/** The outbox row for a digest that goes out. */
export const digestRow = (d, now = new Date()) => ({ kind: 'daily_digest', at: now.toISOString(), day: d.state.day, text: d.text });
